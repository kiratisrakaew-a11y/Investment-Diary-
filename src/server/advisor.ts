/**
 * In-app AI investment advisor built on the Claude API tool runner. Claude
 * reads the user's real portfolio through the same services the UI uses and
 * runs the app's valuation / bond / Markowitz engines as tools, so every number
 * it quotes is computed rather than guessed.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { bondSchema, evaluate, multiStageRiToolInput, valuationInput } from "@/lib/valuation-schemas";
import { noteInput, today } from "@/lib/validation";
import { fetchFundamentals } from "@/lib/prices/yahoo";
import { getAllocation, getPerformance, getPortfolioSummary } from "./services/portfolio";
import { loadUniverse, optimizePortfolio } from "./services/optimizer";
import { dataQualityReport } from "./services/data-quality";
import { importPrices, importPricesInput, syncHistoricalPrices, syncHistoricalPricesInput } from "./services/price-sync";
import { bondHoldings } from "./services/bonds";
import { rebalanceInput, rebalancePortfolio } from "./services/rebalance";
import { stressInput, stressTestPortfolio } from "./services/stress";
import { recordSplit, recordSplitInput } from "./services/splits";
import { backtestInput, backtestPortfolio } from "./services/backtest";
import { summarizeBacktest } from "./services/backtest-summary";
import { listValuations, multiStageResidualIncome, saveValuation } from "./services/valuations";
import { createNote, listNotes } from "./services/notes";
import { getSettings, getTargets } from "./services/settings";
import { getAssetBySymbol } from "./services/assets";
import { optimizeInput } from "./optimize-schema";
import { statementsSummary } from "./services/statements";

const MODEL = process.env.ADVISOR_MODEL ?? "claude-opus-5-5";
const EFFORT = (process.env.ADVISOR_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max";

const SYSTEM = `คุณคือที่ปรึกษาการลงทุนส่วนตัวในแอป Investment Diary ของผู้ใช้ (สกุลเงินหลักบาท) ตอบเป็นภาษาไทย
ใช้ทฤษฎีการเงินอย่างถูกต้อง: CAPM, WACC, DCF (FCFF/FCFE), DDM, residual income, multiples, bond pricing/YTM/duration,
Modern Portfolio Theory (efficient frontier, tangency, two-fund separation, complete portfolio ตาม risk aversion)

หลักการทำงาน
- ดึงข้อมูลจริงด้วยเครื่องมือก่อนให้คำแนะนำ อย่าเดาตัวเลขพอร์ต ราคา หรือผลตอบแทน
- การประเมินมูลค่า: ดูงบการเงินย้อนหลังด้วย get_financial_statements ก่อน (ถ้ามี) แล้วตั้งสมมติฐานจากแนวโน้ม 5 ปี ระบุสมมติฐานทุกตัวที่ใช้ (Rf, β, ERP, growth, margin ฯลฯ) และที่มา ถ้าข้อมูลไม่พอให้ถามผู้ใช้ หรือใช้ get_fundamentals แล้วบอกว่ามาจาก Yahoo
  ให้มูลค่าเป็นช่วงด้วย sensitivity และเทียบหลายวิธี อธิบาย margin of safety
- ปรับพอร์ต: rebalance_portfolio ให้ "ข้อเสนอ" จำนวนหุ้นตาม lot และต้นทุน (ไม่บันทึกรายการ) · stress_test_portfolio ทดสอบสถานการณ์ แจ้งสมมติฐานทุกครั้ง · backtest_portfolio ทดสอบกลยุทธ์ย้อนหลัง (walk-forward) แจ้งข้อจำกัด survivorship / ราคาไม่รวมปันผล
- การจัดพอร์ต: ใช้ optimize_portfolio ระบุ objective, ข้อจำกัดน้ำหนัก และวิธีประมาณผลตอบแทนคาดหวังที่เลือก
  อธิบายข้อจำกัดของ MPT (estimation error, ข้อมูลในอดีต) และเสนอการปรับแบบค่อยเป็นค่อยไป
- ค่าจากเครื่องมือเป็นทศนิยม (0.05 = 5%) ให้แสดงเป็น % ที่อ่านง่าย
- บันทึกลงไดอารี่ (save_note / save_valuation) เฉพาะเมื่อผู้ใช้ขอ
- ตอบกระชับ ใช้หัวข้อและตารางเมื่อช่วยให้อ่านง่าย
- ปิดท้ายคำแนะนำการซื้อขายด้วยหมายเหตุสั้น ๆ ว่าเป็นการวิเคราะห์เพื่อประกอบการตัดสินใจ ไม่ใช่คำแนะนำจากผู้ได้รับใบอนุญาต`;

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isInteger(x) ? Number(x.toPrecision(6)) : x));

function tools() {
  return [
    betaZodTool({
      name: "get_portfolio_summary",
      description: "Current holdings: quantity, average cost, market value, unrealized/realized P&L and weights in THB, plus cash.",
      inputSchema: z.object({}),
      run: async () => json(await getPortfolioSummary()),
    }),
    betaZodTool({
      name: "get_allocation",
      description: "Actual vs. target asset allocation by asset class with drift and rebalance amounts (THB).",
      inputSchema: z.object({}),
      run: async () => json({ ...(await getAllocation()), targets: await getTargets() }),
    }),
    betaZodTool({
      name: "sync_historical_prices",
      description:
        "Backfill daily prices for existing assets over a date range (default 365 days) plus benchmark and USDTHB. Use dryRun first; never creates assets — ask the user to add unknown symbols.",
      inputSchema: syncHistoricalPricesInput,
      run: async (x) => json(await syncHistoricalPrices(x)),
    }),
    betaZodTool({
      name: "record_split",
      description: "Record a stock split or reverse split (แตกพาร์ / รวมพาร์) for an asset the user holds: splitFrom:splitTo (1:2 doubles the shares, 10:1 reverse). Units are multiplied, total cost is unchanged (average cost divided), no cash or P&L. With adjustPrices (default) stored prices before the date are divided by the ratio only if they are still at the old level (checked; idempotent). Use dryRun first and record only when the user confirms the date and ratio.",
      inputSchema: recordSplitInput.omit({ source: true }),
      run: async (x) => json(await recordSplit({ ...x, source: "claude" })),
    }),
    betaZodTool({
      name: "rebalance_portfolio",
      description: "Turn target weights into whole-lot buy/sell proposals for the current holdings, after trading costs from Settings (commission with minimum, VAT, slippage, sell tax), cash, minimum trade, no-trade band and turnover cap. Targets: custom {symbol: weight} or omit to use optimize_portfolio (pass optimizer params). Returns quantities, values, costs, remaining cash, final weights, tracking error before/after and violations. PROPOSAL ONLY — never records transactions; record trades with record_transaction only after the user actually trades and asks.",
      inputSchema: rebalanceInput,
      run: async (x) => json(await rebalancePortfolio(x)),
    }),
    betaZodTool({
      name: "stress_test_portfolio",
      description: "Stress test current holdings: equity shock × beta, rate shock via bond duration/convexity, FX shock on USD assets, company/group shocks, liquidity haircuts, correlation shock (σ and VaR), plus the worst historical day/month of current weights. Omit scenarios to run presets. Assumptions are returned with the results.",
      inputSchema: stressInput,
      run: async (x) => json(await stressTestPortfolio(x)),
    }),
    betaZodTool({
      name: "backtest_portfolio",
      description: "Walk-forward backtest on stored prices: buy_and_hold | equal_weight | min_variance | max_sharpe | black_litterman | custom. Each rebalance (monthly…annual) estimates μ/Σ from the training window ending before that day (no look-ahead), optimizes with the existing optimizer, trades at that close after costs from Settings. Returns CAGR, volatility, Sharpe, Sortino, max drawdown, beta/alpha/TE/IR vs the benchmark, turnover, cost breakdown, month-end equity curve, methodology and limitations (survivorship, prices without dividends).",
      inputSchema: backtestInput,
      run: async (x) => json(summarizeBacktest(await backtestPortfolio(x))),
    }),
    betaZodTool({
      name: "import_prices",
      description: "Store many user-supplied prices at once (rows or CSV text) for existing assets. Use dryRun first and only write when the user asks.",
      inputSchema: importPricesInput,
      run: async (x) => json(await importPrices(x)),
    }),
    betaZodTool({
      name: "get_data_quality",
      description:
        "Data-quality and provenance checks (stale prices/FX, illustrative Rf/ERP, inferred deposits, benchmark type, valuations from older formulas). Call before giving advice and mention material warnings.",
      inputSchema: z.object({}),
      run: async () => json(await dataQualityReport()),
    }),
    betaZodTool({
      name: "get_performance_metrics",
      description: "Portfolio TWR, XIRR, volatility, max drawdown, VaR, Sharpe, Sortino, beta, Jensen's alpha, Treynor vs. benchmark, and the app's risk-free rate / ERP settings.",
      inputSchema: z.object({}),
      run: async () => {
        const { growth: _g, valueSeries: _v, ...m } = await getPerformance();
        return json({ ...m, settings: await getSettings() });
      },
    }),
    betaZodTool({
      name: "get_investment_universe",
      description: "Assets with enough price history for portfolio optimization: historical return, volatility, beta and CAPM expected return (annual, THB).",
      inputSchema: z.object({ lookbackDays: z.number().int().min(90).max(3650).optional() }),
      run: async ({ lookbackDays }) => {
        const { cov: _c, ...u } = await loadUniverse(lookbackDays);
        return json(u);
      },
    }),
    betaZodTool({
      name: "optimize_portfolio",
      description:
        "Markowitz mean-variance optimization over held/registered assets. Returns recommended weights, THB trades vs. current holdings, and the min-variance / max-Sharpe portfolios. " +
        "objective: max_sharpe | min_variance | target_return | target_risk | utility (uses riskAversion A in U = E[R] − ½Aσ²). useRiskFree mixes the tangency portfolio with the risk-free asset and solves the objective on the capital allocation line. Infeasible bounds/targets return { ok: false, issue } — never relax them; explain the suggestion to the user. " +
        "returnMethod black_litterman: give blackLitterman.marketWeights for every asset (benchmark/market-cap weights — do not use the user's holdings unless they say so), views [{type absolute, symbol, return, confidence} | {type relative, long[], short[], return, confidence}], optional marketRiskAversion δ (else implied from ERP), tau (0.05). Returns prior vs posterior returns and market / prior-optimal / posterior-optimal weights. ",
      inputSchema: optimizeInput,
      run: async (p) => {
        try {
          return json(await optimizePortfolio(p));
        } catch (e) {
          // Infeasible constraints come back as a typed issue so the advisor can explain the fix.
          const issue = (e as { issue?: unknown }).issue;
          if (issue) return json({ ok: false, issue });
          throw e;
        }
      },
    }),
    betaZodTool({
      name: "value_security",
      description:
        "Run a valuation model and return intrinsic value, upside and details. method: dcf_fcff | dcf_fcfe | ddm | residual_income | multiples | bond | sotp. " +
        "sotp = sum of the parts: segments [{name, role division|subsidiary|associate|investment, ownership, fx, source: model (an existing model above) | multiple | market | manual (with source), netDebt?, debtAt?}] + parent sharesOutstanding, netDebt (netDebtBasis consolidated|holdco), minorityInterest?, nonOperatingAssets, otherClaims, eliminations, holdingDiscount. Returns the EV-to-equity reconciliation, waterfall, sensitivity and double-counting errors/warnings. " +
        "DCF monetary inputs share one unit (e.g. THB million and million shares).",
      inputSchema: z.object({ valuation: valuationInput }),
      run: async ({ valuation }) => json(evaluate(valuation)),
    }),
    betaZodTool({
      name: "analyze_bond",
      description: "Bond price ↔ YTM, accrued interest, current yield, Macaulay/modified duration, convexity, DV01, yield to call. Prices per 100 face.",
      inputSchema: bondSchema,
      run: async (a) => json(evaluate({ method: "bond", assumptions: a })),
    }),
    betaZodTool({
      name: "get_bond_holdings",
      description: "YTM, duration and convexity of the user's bond assets at their latest prices, plus portfolio-weighted bond duration.",
      inputSchema: z.object({}),
      run: async () => json(await bondHoldings()),
    }),
    betaZodTool({
      name: "get_fundamentals",
      description: "Best-effort fundamentals snapshot from Yahoo Finance (revenue, EBITDA, margins, debt, cash, shares, beta, EPS, BVPS, dividend). Thai stocks use the .BK suffix. Monetary values in millions.",
      inputSchema: z.object({ symbol: z.string().describe("App symbol or Yahoo symbol, e.g. PTT or PTT.BK") }),
      run: async ({ symbol }) => {
        const asset = await getAssetBySymbol(symbol);
        const yahoo = asset?.providerSymbol ?? (asset?.assetClass === "thai_stock" ? `${asset.symbol}.BK` : symbol);
        try {
          return json({ yahooSymbol: yahoo, ...(await fetchFundamentals(yahoo)) });
        } catch (e) {
          return json({ yahooSymbol: yahoo, error: `ดึงข้อมูลไม่สำเร็จ: ${(e as Error).message}` });
        }
      },
    }),
    betaZodTool({
      name: "get_financial_statements",
      description:
        "Up to several years of the company's historical financial statements uploaded by the user (revenue, EBIT, D&A, capex, debt, cash, shares, EPS, DPS …, in millions) plus derived ratios (growth, margins, capex %, NWC %, tax, ROE, payout). Use this before building DCF/DDM assumptions.",
      inputSchema: z.object({ symbol: z.string() }),
      run: async ({ symbol }) => json(await statementsSummary(symbol)),
    }),
    betaZodTool({
      name: "list_valuations",
      description: "Saved valuations (method, intrinsic value, price at valuation, date), optionally for one symbol.",
      inputSchema: z.object({ symbol: z.string().optional() }),
      run: async ({ symbol }) => json(await listValuations({ symbol, limit: 30 })),
    }),
    betaZodTool({
      name: "search_notes",
      description: "Search the user's investment diary notes (theses, ideas, lessons).",
      inputSchema: z.object({ q: z.string().optional(), symbol: z.string().optional(), limit: z.number().int().max(50).optional() }),
      run: async ({ q, symbol, limit }) => {
        const asset = symbol ? await getAssetBySymbol(symbol) : null;
        return json(await listNotes({ q, assetId: asset?.id, limit: limit ?? 15 }));
      },
    }),
    betaZodTool({
      name: "save_note",
      description: "Save a note to the diary timeline. Only call when the user asks to save/record something.",
      inputSchema: noteInput.omit({ source: true }),
      run: async (n) => json(await createNote({ ...n, source: "claude" })),
    }),
    betaZodTool({
      name: "multi_stage_residual_income",
      description:
        "Residual income with yearly ROE (and optional EPS / payout / stated book value) forecasts plus a perpetuity, persistence or no continuing value. " +
        "Returns value per share and the yearly table. save: true (with symbol) saves it — only when the user asks to save.",
      inputSchema: multiStageRiToolInput,
      run: async (x) => json(await multiStageResidualIncome(x, "claude")),
    }),
    betaZodTool({
      name: "save_valuation",
      description: "Save a valuation with its assumptions to the app. Only call when the user asks to save it.",
      inputSchema: z.object({ symbol: z.string(), title: z.string().optional(), note: z.string().optional(), valuation: valuationInput }),
      run: async (v) => json(await saveValuation({ ...v, source: "claude" })),
    }),
  ];
}

export type ChatTurn = { role: "user" | "assistant"; content: string };

export class AdvisorNotConfigured extends Error {}

export async function askAdvisor(history: ChatTurn[]): Promise<{ reply: string; toolsUsed: string[] }> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new AdvisorNotConfigured("ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน environment variables");
  }
  const client = new Anthropic();
  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT },
    // Re-run declined requests on a suitable fallback model instead of stopping.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: tools(),
    messages: [
      ...history.slice(0, -1).map((t) => ({ role: t.role, content: t.content })),
      { role: "user" as const, content: `${history[history.length - 1].content}\n\n(วันนี้: ${today()})` },
    ],
    max_iterations: 15,
    thread: false,
  });

  const toolsUsed: string[] = [];
  let final: Anthropic.Beta.BetaMessage | undefined;
  for await (const message of runner) {
    final = message;
    for (const b of message.content) if (b.type === "tool_use") toolsUsed.push(b.name);
  }
  if (!final) throw new Error("ไม่ได้รับคำตอบจากโมเดล");
  if (final.stop_reason === "refusal") return { reply: "ขออภัย คำขอนี้ไม่สามารถตอบได้ ลองถามใหม่อีกแบบ", toolsUsed };
  const reply = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const truncated = final.stop_reason === "max_tokens" ? "\n\n_(คำตอบถูกตัดเพราะยาวเกิน)_" : "";
  return { reply: (reply || "(ไม่มีข้อความตอบกลับ)") + truncated, toolsUsed: [...new Set(toolsUsed)] };
}
