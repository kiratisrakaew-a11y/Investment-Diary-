/**
 * MCP server exposing the diary to Claude (claude.ai custom connector,
 * Claude Desktop, Claude Code). Tools reuse the same services and zod schemas
 * as the REST API.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MODEL_VERSION } from "@/lib/governance";
import { assetInput, noteInput, priceInput, transactionInput } from "@/lib/validation";
import { createAsset, getAssetBySymbol, listAssets } from "./services/assets";
import { createNote, listNotes } from "./services/notes";
import { recordPrice } from "./services/prices";
import { createTransaction, listTransactions } from "./services/transactions";
import { getAllocation, getMptAnalysis, getPerformance, getPortfolioSummary } from "./services/portfolio";
import { bondSchema, evaluate, multiStageRiToolInput, valuationInput } from "@/lib/valuation-schemas";
import { optimizeInput } from "./optimize-schema";
import { loadUniverse, optimizePortfolio } from "./services/optimizer";
import { dataQualityReport } from "./services/data-quality";
import { syncHistoricalPrices, syncHistoricalPricesInput } from "./services/price-sync";
import { bondHoldings } from "./services/bonds";
import { listValuations, multiStageResidualIncome, saveValuation } from "./services/valuations";
import { saveYears, statementsSummary } from "./services/statements";
import { emptyYear, financialYearSchema } from "@/lib/financials";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return json(await fn(args));
    } catch (e) {
      const suggestion = (e as { issue?: { code?: string; suggestion?: string } }).issue;
      const extra = suggestion?.code ? ` [${suggestion.code}]${suggestion.suggestion ? ` — ${suggestion.suggestion}` : ""}` : "";
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}${extra}` }], isError: true };
    }
  };
}

/** Formula version + deployed commit, so clients (and people) can tell which build they are talking to. */
export function serverVersion() {
  return `${MODEL_VERSION}+${process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local"}`;
}

/** Names of the tools the current build registers. */
export function mcpToolNames(): string[] {
  const s = createMcpServer() as unknown as { _registeredTools?: Record<string, unknown> };
  return Object.keys(s._registeredTools ?? {}).sort();
}

export function createMcpServer() {
  const server = new McpServer(
    { name: "investment-diary", version: serverVersion() },
    {
      instructions:
        "Personal investment diary (base currency THB). Use add_note to record ideas, theses, reviews and lessons " +
        "on the timeline; record_transaction for trades (add_asset first for new symbols); update_price for manual " +
        "prices/NAVs; and get_* tools to read holdings, asset allocation and risk-adjusted performance " +
        "(TWR, XIRR, Sharpe, Sortino, Beta, Jensen's alpha, Treynor, efficient frontier). value_security runs DCF (FCFF/FCFE), DDM, " +
        "residual income (single-stage, or multi-stage with yearly ROE/EPS/payout/book value forecasts and a perpetuity, persistence or no continuing value) and multiples; analyze_bond gives YTM/duration; optimize_portfolio recommends weights. Dates are YYYY-MM-DD.",
    },
  );

  const { source: _ns, ...noteShape } = noteInput.shape;
  server.registerTool(
    "add_note",
    {
      title: "Add journal note",
      description:
        "Write an entry on the investment diary timeline: an idea, thesis, review, lesson or market note. " +
        "Summarize the user's reasoning, catalysts, risks, valuation and exit plan in the markdown body.",
      inputSchema: noteShape,
    },
    safe(async (args) => createNote({ ...args, source: "claude" })),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search journal notes",
      description: "Search the diary timeline by text, type, tag, symbol or date range.",
      inputSchema: {
        q: z.string().optional(),
        type: z.enum(["idea", "thesis", "review", "lesson", "market"]).optional(),
        tag: z.string().optional(),
        symbol: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ symbol, ...f }) => {
      const asset = symbol ? await getAssetBySymbol(symbol) : null;
      return listNotes({ ...f, assetId: asset?.id, limit: f.limit ?? 30 });
    }),
  );

  const { source: _ts, ...txShape } = transactionInput.shape;
  server.registerTool(
    "record_transaction",
    {
      title: "Record transaction",
      description:
        "Record a buy, sell, dividend, coupon, deposit, withdraw or fee. For buy/sell give quantity and price per unit " +
        "in the asset's currency; for other types put the total amount in `price`. The asset must exist (add_asset). " +
        "Selling more than held is rejected (OVERSELL); under the default strict cash policy a buy/fee without enough cash is " +
        "rejected (INSUFFICIENT_CASH) — record a deposit first.",
      inputSchema: txShape,
    },
    safe(async (args) => createTransaction({ ...args, source: "claude" })),
  );

  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description: "Recent transactions, optionally for one symbol.",
      inputSchema: { symbol: z.string().optional(), limit: z.number().int().max(500).optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ symbol, limit }) => {
      const asset = symbol ? await getAssetBySymbol(symbol) : null;
      const rows = await listTransactions({ assetId: asset?.id, limit: limit ?? 50 });
      return rows.map((r) => ({ ...r.tx, symbol: r.symbol }));
    }),
  );

  server.registerTool(
    "add_asset",
    {
      title: "Add asset",
      description:
        "Register a stock, bond, fund, gold or cash asset. Thai stocks: assetClass thai_stock, priceSource yahoo, " +
        "providerSymbol like 'PTT.BK'. US stocks: providerSymbol 'AAPL', currency USD. Thai gold bar: assetClass gold, " +
        "priceSource yahoo, providerSymbol 'GOLD_TH'. Thai funds: priceSource sec_th with the SEC proj_id, or manual. " +
        "Bonds: usually manual with couponRate / maturityDate.",
      inputSchema: assetInput.shape,
    },
    safe(async (args) => createAsset(args)),
  );

  server.registerTool(
    "list_assets",
    { title: "List assets", description: "All registered assets.", annotations: { readOnlyHint: true } },
    safe(async () => listAssets()),
  );

  server.registerTool(
    "update_price",
    {
      title: "Update price",
      description: "Set the closing price / NAV of an asset for a date (defaults to today).",
      inputSchema: priceInput.shape,
    },
    safe(async (args) => recordPrice(args)),
  );

  server.registerTool(
    "sync_historical_prices",
    {
      title: "Sync historical prices",
      description:
        "Backfill or refresh daily prices for assets already in the app (Yahoo for stocks/indices/gold, SEC NAV for Thai funds ≤ 400 days) over a date range " +
        "(default last 365 days), plus the benchmark and USDTHB. overwriteExisting=false keeps stored prices; dryRun=true only reports. " +
        "Unknown symbols are reported, not created — call add_asset first (Thai stocks: providerSymbol SYMBOL.BK). " +
        "Returns per-asset inserted/updated counts, coverage, split/dividend warnings and optimizer eligibility.",
      inputSchema: syncHistoricalPricesInput.shape,
    },
    safe(async (x) => syncHistoricalPrices(x)),
  );

  server.registerTool(
    "get_portfolio_summary",
    {
      title: "Portfolio summary",
      description: "Holdings with quantity, average cost, market value, unrealized/realized P&L and weights (THB).",
      annotations: { readOnlyHint: true },
    },
    safe(async () => getPortfolioSummary()),
  );

  server.registerTool(
    "get_allocation",
    {
      title: "Asset allocation",
      description: "Actual vs. target asset allocation by asset class with drift and rebalance amounts (THB).",
      annotations: { readOnlyHint: true },
    },
    safe(async () => getAllocation()),
  );

  server.registerTool(
    "get_data_quality",
    {
      title: "Data quality & assumption provenance",
      description:
        "Checks that affect reliability: stale/missing prices and FX, illustrative (unsourced) Rf/ERP, inferred deposits, ledger issues, benchmark type/staleness, valuations saved under older formulas, bonds without conventions. Mention relevant warnings when reporting numbers.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => dataQualityReport()),
  );

  server.registerTool(
    "get_performance_metrics",
    {
      title: "Performance metrics",
      description:
        "Time-weighted and money-weighted (XIRR) returns, volatility, max drawdown, VaR, risk premium, Sharpe, " +
        "Sortino, and vs. benchmark: beta, CAPM expected return, Jensen's alpha, Treynor, information ratio.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const { growth: _g, valueSeries: _v, ...m } = await getPerformance();
      return m;
    }),
  );

  server.registerTool(
    "get_portfolio_optimization",
    {
      title: "Modern Portfolio Theory analysis",
      description:
        "Markowitz analysis of current holdings: expected returns, correlation, current portfolio risk/return, " +
        "minimum-variance and maximum-Sharpe (tangency) weights, and the Capital Market Line.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const r = await getMptAnalysis();
      if (!r.ok) return r;
      const { cloud: _c, frontier: _f, ...rest } = r;
      return rest;
    }),
  );

  server.registerTool(
    "value_security",
    {
      title: "Value a stock / bond",
      description:
        "Run a valuation model with explicit assumptions: dcf_fcff | dcf_fcfe | ddm | residual_income | multiples | bond. " +
        "residual_income supports model: multi_stage with yearly roeForecast / bookValueForecast — the simpler multi_stage_residual_income tool does the same. " +
        "Returns intrinsic value per share, upside vs. price, WACC/Ke, terminal value share, reverse-DCF growth and a WACC×g sensitivity grid. Rates are decimals.",
      inputSchema: { valuation: valuationInput },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ valuation }) => evaluate(valuation)),
  );

  server.registerTool(
    "save_valuation",
    {
      title: "Save valuation",
      description:
        "Save a valuation (method + assumptions) to the app so it appears on the Valuation page. For multi-stage residual income use multi_stage_residual_income with save: true (or residual_income with model: multi_stage).",
      inputSchema: { symbol: z.string(), title: z.string().optional(), note: z.string().optional(), valuation: valuationInput },
    },
    safe(async (v) => saveValuation({ ...v, source: "claude" })),
  );

  server.registerTool(
    "multi_stage_residual_income",
    {
      title: "Multi-stage residual income valuation",
      description:
        "Residual income with yearly forecasts: give book value per share B₀, CAPM inputs, roeForecast per year (and optionally epsForecast, payoutForecast, " +
        "bookValueForecast — null = clean surplus), then a continuing value: perpetuity RI(n+1)/(Ke−g), persistence RI(n+1)/(1+Ke−ω) or none. " +
        "Returns value per share, upside, yearly RI table and warnings. Set save: true with symbol to save it to the Valuation page. Rates are decimals.",
      inputSchema: multiStageRiToolInput.shape,
    },
    safe(async (x) => multiStageResidualIncome(x, "claude")),
  );

  server.registerTool(
    "list_valuations",
    { title: "List valuations", description: "Saved valuations, optionally for one symbol.", inputSchema: { symbol: z.string().optional() }, annotations: { readOnlyHint: true } },
    safe(async ({ symbol }) => listValuations({ symbol, limit: 50 })),
  );

  server.registerTool(
    "analyze_bond",
    {
      title: "Bond analytics",
      description: "Price ↔ yield to maturity, accrued interest, current yield, Macaulay/modified duration, convexity, DV01, yield to call. Prices per 100 face.",
      inputSchema: bondSchema.shape,
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => evaluate({ method: "bond", assumptions: a })),
  );

  server.registerTool(
    "get_bond_holdings",
    { title: "Bond holdings", description: "YTM and duration of the user's bonds and the portfolio-weighted bond duration.", annotations: { readOnlyHint: true } },
    safe(async () => bondHoldings()),
  );

  server.registerTool(
    "get_investment_universe",
    {
      title: "Investment universe",
      description: "Assets with enough history: historical return, volatility, beta and CAPM expected return (THB, annual).",
      inputSchema: { lookbackDays: z.number().int().min(90).max(3650).optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ lookbackDays }) => {
      const { cov: _c, ...u } = await loadUniverse(lookbackDays);
      return u;
    }),
  );

  server.registerTool(
    "optimize_portfolio",
    {
      title: "Recommend portfolio weights (MPT)",
      description:
        "Markowitz optimization with editable expected returns and weight limits. Objectives: max_sharpe, min_variance, target_return, target_risk, utility (risk aversion A). " +
        "Returns recommended weights, THB buy/sell amounts vs. current holdings, and the min-variance / max-Sharpe portfolios.",
      inputSchema: optimizeInput.shape,
      annotations: { readOnlyHint: true },
    },
    safe(async (p) => optimizePortfolio(p)),
  );

  server.registerTool(
    "get_financial_statements",
    {
      title: "Historical financial statements",
      description: "The company's stored historical statements (millions; EPS/DPS in currency units) with derived ratios: growth, margins, capex %, NWC %, tax, ROE, payout.",
      inputSchema: { symbol: z.string() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ symbol }) => statementsSummary(symbol)),
  );

  server.registerTool(
    "save_financial_statements",
    {
      title: "Save financial statements",
      description:
        "Store historical statement figures for a company, one object per fiscal year (Gregorian). Monetary values in MILLIONS of currency, sharesOutstanding in millions, EPS/DPS per share. " +
        "Use when the user gives you statements (PDF / Excel / pasted) so they appear in the app's valuation page. Existing years are merged (given fields overwrite).",
      inputSchema: {
        symbol: z.string(),
        currency: z.string().optional(),
        years: z.array(financialYearSchema.partial().extend({ fiscalYear: z.number().int() })),
      },
    },
    safe(async ({ symbol, currency, years }) =>
      saveYears(symbol, years.map((y) => ({ ...emptyYear(y.fiscalYear), ...y })), { source: "claude", currency }),
    ),
  );

  server.registerTool(
    "get_server_info",
    {
      title: "Server version and tools",
      description: "Which build of Investment Diary is live (formula version, commit) and the tools it offers. Use it to check whether a newly added tool exists before saying it is unavailable.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => ({ version: serverVersion(), commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null, tools: Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort() })),
  );

  return server;
}
