import { z } from "zod";
import { asOf, asOfEntry } from "@/lib/finance/portfolio";
import { assertSingleDividendTreatment, backtest, type DecisionProvider, type DividendCashflows } from "@/lib/finance/backtest";
import { DIVIDEND_STRATEGY_IDS, backtestReadiness, resolveSettings, screenDividendStrategy, type DividendStrategyId, type StrategySettingsInput } from "@/lib/finance/dividend-strategies";
import { dpsLatestBasis } from "@/lib/finance/dividend-metrics";
import { candidatesAsOf, loadDividendData, strategySettingsOverride } from "./strategies";
import { lotFor, tradingCostsSchema } from "@/lib/finance/rebalance";
import { blackLittermanInput } from "../optimize-schema";
import { listAssets } from "./assets";
import { loadAdjPriceHistory, loadBenchmark, loadFxHistory, loadPriceHistory } from "./prices";
import { buildLevelSeries, commonDates } from "@/lib/finance/return-series";
import { getSettings, getTradingCosts } from "./settings";

export const backtestInput = z
  .object({
    strategy: z.enum(["buy_and_hold", "equal_weight", "min_variance", "max_sharpe", "black_litterman", "custom", "risk_parity", "max_diversification", "min_cvar", ...DIVIDEND_STRATEGY_IDS]).describe("Strategy to test; dividend_* select by dividend metrics known at each decision date"),
    symbols: z.array(z.string()).max(30).optional().describe("Universe (default: every non-cash asset with prices)"),
    startDate: z.string().optional().describe("First date of data (YYYY-MM-DD); default = when all chosen assets have prices"),
    endDate: z.string().optional(),
    weights: z.record(z.string(), z.number().min(0).max(1)).optional().describe("custom / buy_and_hold target weights (decimal; remainder = cash). buy_and_hold defaults to equal weights"),
    blackLitterman: blackLittermanInput.optional(),
    returnMethod: z.enum(["historical", "capm", "blend"]).default("historical").describe("μ estimate in each training window (max_sharpe)"),
    covMethod: z.enum(["sample", "ledoit_wolf"]).default("ledoit_wolf"),
    windowDays: z.number().int().min(30).max(2000).default(252).describe("Training window in price observations"),
    rebalance: z.enum(["monthly", "quarterly", "semiannual", "annual"]).default("quarterly"),
    minWeight: z.number().min(0).max(1).default(0),
    maxWeight: z.number().min(0).max(1).default(1),
    initialCapital: z.number().positive().default(1_000_000),
    useCosts: z.boolean().default(true).describe("Deduct the trading cost model from Settings"),
    costs: tradingCostsSchema.partial().optional().describe("Override costs for this backtest"),
    useLots: z.boolean().default(false).describe("Round trades to whole lots (default: fractional units)"),
    returnBasis: z
      .enum(["price_return", "total_return"])
      .default("price_return")
      .describe("price_return = closes (dividends excluded); total_return = provider dividend-adjusted closes (dividends reinvested), requires full adj_close coverage"),
    dividendSettings: strategySettingsOverride.optional().describe("dividend_* strategies: overrides on the preset (optimizer weighting is not available in backtests)"),
    pointInTime: z
      .enum(["strict", "illustrative_lookahead"])
      .default("strict")
      .describe("strict refuses (NOT_BACKTESTABLE_NO_ASOF_DATA) when needed statements have no publication date; illustrative_lookahead runs but is labelled biased"),
    dividendCashflows: z.boolean().optional().describe("Simulate dividend cash events (entitlement on ex-date, cash on payment date). Always on for dividend_* strategies; requires price_return"),
    reinvestDividends: z.boolean().default(true),
    cvarConfidence: z.number().min(0.8).max(0.995).default(0.95).describe("min_cvar: CVaR confidence"),
    paymentLagDays: z.number().int().min(1).max(120).nullable().default(null).describe("Assumption for events without a payment date: pay = ex-date + N days. null = such events are not credited"),
    withholding: z.record(z.string(), z.number().min(0).max(1)).default({ thai_stock: 0.1, fund: 0.1, us_stock: 0.15 }).describe("Default dividend withholding by asset class when an event has none (assumption)"),
  })
  .refine((v) => v.strategy !== "black_litterman" || v.blackLitterman, { message: "black_litterman requires blackLitterman.marketWeights", path: ["blackLitterman"] })
  .refine((v) => v.strategy !== "custom" || v.weights, { message: "custom requires weights", path: ["weights"] });

const PER_YEAR = { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 } as const;

/** Walk-forward backtest on stored prices. Read-only. */
export async function backtestPortfolio(input: z.input<typeof backtestInput>) {
  const x = backtestInput.parse(input);
  // Dividend strategies / cashflows: one economic treatment (tradable prices + cash events) — checked first.
  const isDividend = (DIVIDEND_STRATEGY_IDS as readonly string[]).includes(x.strategy);
  const withCash = isDividend || !!x.dividendCashflows;
  assertSingleDividendTreatment(x.returnBasis, withCash);
  const [assets, prices, fx, settings, savedCosts] = await Promise.all([listAssets(), loadPriceHistory(), loadFxHistory(), getSettings(), getTradingCosts()]);
  const wanted = x.symbols?.length ? new Set(x.symbols.map((s) => s.toUpperCase())) : null;
  if (wanted) {
    const missing = [...wanted].filter((s) => !assets.some((a) => a.symbol.toUpperCase() === s));
    if (missing.length) throw new Error(`ไม่พบ ${missing.join(", ")} ในรายการสินทรัพย์`);
  }
  const excluded: { symbol: string; reason: string }[] = [];
  let pool = assets.filter((a) => a.assetClass !== "cash" && (!wanted || wanted.has(a.symbol.toUpperCase())));
  pool = pool.filter((a) => {
    const n = prices.get(a.id)?.length ?? 0;
    if (n < 2) excluded.push({ symbol: a.symbol, reason: "ไม่มีประวัติราคา" });
    return n >= 2;
  });
  const firstOf = (id: number) => prices.get(id)![0][0];
  let start = x.startDate ?? pool.reduce((m, a) => (firstOf(a.id) > m ? firstOf(a.id) : m), "0000-00-00");
  if (x.startDate) {
    pool = pool.filter((a) => {
      if (firstOf(a.id) > x.startDate!) excluded.push({ symbol: a.symbol, reason: `ราคาเริ่ม ${firstOf(a.id)} หลังวันเริ่ม backtest` });
      return firstOf(a.id) <= x.startDate!;
    });
  }
  pool = pool.filter((a) => {
    if (a.currency !== "USD") return true;
    const ok = fx.length && fx[0][0] <= start;
    if (!ok) excluded.push({ symbol: a.symbol, reason: "ไม่มี USDTHB ครอบคลุมช่วง" });
    return ok;
  });
  if (!pool.length) throw new Error("ไม่มีสินทรัพย์ที่มีข้อมูลครบช่วง");
  const end = x.endDate ?? "9999-12-31";
  // Shared conventions (return-series.ts): THB levels per actual print, FX applied once, total return
  // only from the provider's adjusted closes; then the common calendar of actual prints.
  const adj = x.returnBasis === "total_return" ? await loadAdjPriceHistory() : null;
  const levels = new Map<number, { levels: [string, number][]; scale: number }>();
  pool = pool.filter((a) => {
    const window = prices.get(a.id)!.filter(([d]) => d >= start && d <= end);
    const adjMap = adj ? new Map(adj.get(a.id) ?? []) : null;
    const lv = buildLevelSeries({
      label: a.symbol,
      observations: window.map(([date, close]) => ({ date, close, adjClose: adjMap?.get(date) ?? null })),
      basis: x.returnBasis,
      totalReturnSource: x.returnBasis === "total_return" ? "adjusted_close" : undefined,
      currency: a.currency,
      fx,
    });
    if (!lv.ok) {
      excluded.push({ symbol: a.symbol, reason: `${lv.reason}${lv.required ? ` — ต้องการ: ${lv.required}` : ""}` });
      return false;
    }
    // Trade at THB prices on the chosen basis: first price (× FX) × index level.
    const first = window[0];
    const p0 = (x.returnBasis === "total_return" ? adjMap!.get(first[0])! : first[1]) * (a.currency === "USD" ? (asOf(fx, first[0]) ?? NaN) : 1);
    levels.set(a.id, { levels: lv.levels, scale: p0 });
    return true;
  });
  if (!pool.length) throw new Error(`ไม่มีสินทรัพย์ที่ใช้ได้: ${excluded.map((e) => `${e.symbol} (${e.reason})`).join(", ")}`);
  const dates = commonDates(pool.map((a) => levels.get(a.id)!.levels));
  if (dates.length < 3) throw new Error(`วันที่ทุกสินทรัพย์มีราคาพร้อมกันมีเพียง ${dates.length} วัน`);
  start = dates[0];
  const px = pool.map((a) => {
    const { levels: lv, scale } = levels.get(a.id)!;
    const m = new Map(lv);
    return dates.map((d) => m.get(d)! * scale);
  });
  if (x.returnBasis === "total_return" && x.useLots) throw new Error("total_return ใช้ราคาปรับปันผลซึ่งไม่ใช่ราคาซื้อขายจริง — ปิด useLots");
  const years = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / (365 * 86_400_000);
  const obsPerYear = years > 0 ? (dates.length - 1) / years : 252;
  const every = Math.max(1, Math.round(obsPerYear / PER_YEAR[x.rebalance]));
  const bench = await loadBenchmark(settings.benchmarkSymbol, start);
  const costs = x.useCosts ? tradingCostsSchema.parse({ ...savedCosts, ...(x.costs ?? {}) }) : tradingCostsSchema.parse({ lotSize: {}, ...(x.costs ?? {}) });
  const weights = x.weights ? Object.fromEntries(Object.entries(x.weights).map(([k, v]) => [k.toUpperCase(), v])) : undefined;
  const symbols = pool.map((a) => a.symbol);
  if (weights) {
    const unknown = Object.keys(weights).filter((k) => !symbols.map((s) => s.toUpperCase()).includes(k));
    if (unknown.length) throw new Error(`น้ำหนักของ ${unknown.join(", ")} ไม่อยู่ในชุดที่ทดสอบได้`);
  }

  let decisionProvider: DecisionProvider | undefined;
  let dividendCashflows: DividendCashflows | undefined;
  const pitWarnings: string[] = [];
  if (withCash) {
    const data = await loadDividendData();
    const assetOf = new Map(pool.map((a) => [a.symbol, a]));
    if (isDividend) {
      const overrides = (x.dividendSettings ?? {}) as Partial<StrategySettingsInput>;
      const st = resolveSettings(x.strategy as DividendStrategyId, overrides);
      if (st.weighting === "optimizer") throw new Error("น้ำหนักแบบ optimizer ใช้ใน backtest กลยุทธ์ปันผลไม่ได้ — เลือก equal หรือ score");
      const ready = backtestReadiness({ settings: st, statementsBySymbol: Object.fromEntries(symbols.map((s) => [s, data.statements.get(s) ?? []])), mode: x.pointInTime });
      if (!ready.ok) throw new Error(`${ready.code}: ${ready.detail}`);
      pitWarnings.push(...ready.warnings);
      decisionProvider = ({ cutoff }) => {
        const cands = candidatesAsOf(data, symbols, cutoff, x.pointInTime, st.includeSpecial);
        const d = screenDividendStrategy({ strategyId: x.strategy as DividendStrategyId, asOf: cutoff, candidates: cands, settings: overrides });
        const w = symbols.map((s) => d.targetWeights[s] ?? 0);
        return {
          w,
          selected: d.selected,
          diagnostics: [...d.diagnostics, ...d.excluded.map((e) => `${e.symbol}: ${e.code}`)],
          note: d.selected.length ? undefined : "ไม่มีหุ้นผ่านเกณฑ์ ณ วันตัดสินใจ — ถือเงินสด",
        };
      };
    }
    let noPay = 0;
    let stock = 0;
    const events: DividendCashflows["events"] = [];
    for (const sym of symbols) {
      const a = assetOf.get(sym)!;
      for (const e of data.events.get(sym) ?? []) {
        if (e.kind === "indicated_annual" || !e.exDate || e.exDate < dates[0] || e.exDate > dates[dates.length - 1]) continue;
        if (e.cashOrStock === "stock") {
          stock++;
          continue;
        }
        const pay = e.paymentDate ?? (x.paymentLagDays != null ? new Date(Date.parse(e.exDate) + x.paymentLagDays * 86_400_000).toISOString().slice(0, 10) : null);
        if (!pay) {
          noPay++;
          continue;
        }
        const fxRate = e.currency === "THB" ? 1 : e.currency === "USD" ? (asOfEntry(fx, pay)?.[1] ?? asOf(fx, e.exDate)) : null;
        if (fxRate == null || e.currency !== a.currency) continue;
        const gross = dpsLatestBasis(e, data.splits[sym] ?? []) * fxRate;
        const wht = e.withholdingTaxRate ?? x.withholding[a.assetClass] ?? 0;
        events.push({ symbol: sym, exDate: e.exDate, paymentDate: pay, grossPerUnitThb: gross, netPerUnitThb: gross * (1 - wht) });
      }
    }
    const assumptions = [
      `ภาษีหัก ณ ที่จ่าย (สมมติฐานเมื่อข้อมูลไม่ระบุ): ${Object.entries(x.withholding).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(", ")}`,
      "ปันผลสกุล USD แปลงเป็นบาทด้วย USDTHB ณ วันจ่าย",
    ];
    if (x.paymentLagDays != null) assumptions.push(`สมมติฐาน: เหตุการณ์ที่ไม่มีวันจ่าย ถือว่าจ่ายหลัง ex-date ${x.paymentLagDays} วัน (ไม่ใช่ข้อมูลจริง)`);
    if (noPay) pitWarnings.push(`${noPay} เหตุการณ์ไม่มีวันจ่าย จึงไม่ถูกนับเป็นเงินสด — ตั้ง paymentLagDays เพื่อใช้สมมติฐานแทน`);
    if (stock) pitWarnings.push(`ไม่จำลองปันผลเป็นหุ้น ${stock} ครั้ง`);
    if (!events.length && !noPay) pitWarnings.push("ไม่มีเหตุการณ์ปันผลในช่วงนี้ — นำเข้าจาก Yahoo หรือบันทึกจากประกาศ SET ก่อน");
    dividendCashflows = { events, reinvest: x.reinvestDividends, assumptions };
  }

  const r = backtest({
    symbols,
    dates,
    prices: px,
    benchmark: bench.length ? { symbol: settings.benchmarkSymbol, series: bench, kind: settings.benchmarkKind } : null,
    strategy: x.strategy,
    weights: weights && Object.fromEntries(symbols.map((s) => [s, weights[s.toUpperCase()] ?? 0])),
    blackLitterman: x.blackLitterman,
    returnMethod: x.returnMethod,
    covMethod: x.covMethod,
    window: x.windowDays,
    rebalanceEvery: every,
    bounds: { min: x.minWeight, max: x.maxWeight },
    rf: settings.riskFreeRate / 100,
    erp: settings.equityRiskPremium / 100,
    initialCapital: x.initialCapital,
    costs,
    lots: Object.fromEntries(pool.map((a) => [a.symbol, lotFor(costs, a.assetClass, a.lotSize)])),
    useLots: x.useLots,
    decisionProvider,
    dividendCashflows,
    cvarConfidence: x.cvarConfidence,
  });
  if (!r.ok) throw new Error(r.error);
  return {
    ...r,
    input: { ...x, rebalanceEveryObservations: every, observationsPerYear: obsPerYear },
    universe: symbols,
    excluded,
    costModel: costs,
    limitations: [
      "Survivorship bias: ใช้เฉพาะสินทรัพย์ที่อยู่ในแอปวันนี้ — หุ้นที่ถูกถอดหรือเลิกกิจการในอดีตไม่ถูกรวม ผลจึงอาจดีกว่าความเป็นจริง",
      withCash
        ? "ราคาเป็นราคาปิดซื้อขายได้ (ปรับ split แล้ว ไม่ปรับปันผล) + ปันผลเป็นเงินสดตามเหตุการณ์ — ปันผลนับครั้งเดียว; ดอกเบี้ยพันธบัตรไม่รวม"
        : x.returnBasis === "total_return"
        ? "ผลตอบแทนรวม: ใช้ราคาปรับปันผลของผู้ให้ข้อมูล (ปันผลถูกนำไปลงทุนต่อ ณ วัน XD) — ระดับราคาถูกปรับย้อนหลังโดยผู้ให้ข้อมูล แต่อัตราผลตอบแทนแต่ละช่วงไม่ใช้ข้อมูลอนาคต; ไม่หักภาษีปันผล; พันธบัตร/กองทุนที่ไม่มี adj_close ถูกตัดออก"
        : "ราคาเป็นราคาปิดที่ไม่รวมเงินปันผล (Yahoo close ปรับ split แล้ว) — หุ้นปันผลสูงจะดูแย่กว่าผลตอบแทนรวมจริง; ดอกเบี้ยพันธบัตรไม่รวม (ราคาสะอาด)",
      `ดัชนีอ้างอิงเป็น${settings.benchmarkKind === "total_return" ? "ผลตอบแทนรวม" : "ดัชนีราคา (ไม่รวมปันผล)"}${x.returnBasis === "total_return" && settings.benchmarkKind !== "total_return" ? " — เทียบกับพอร์ตผลตอบแทนรวมจะได้เปรียบเกินจริง" : ""}`,
      ...(x.strategy === "black_litterman" ? ["Black–Litterman: น้ำหนักตลาดที่ใส่เป็นค่าปัจจุบันและใช้ทุกช่วงย้อนหลัง (ไม่ใช่ข้อมูล ณ วันนั้น) — เป็น look-ahead ในอินพุต"] : []),
      withCash
        ? "ซื้อขายที่ราคาปิดวันปรับพอร์ต · ปันผลเป็นกระแสเงินสดจากเหตุการณ์ (หักภาษีตามสมมติฐาน) ไม่ใช่ราคาปรับปันผล"
        : "ซื้อขายที่ราคาปิดวันปรับพอร์ต ไม่มี market impact นอกจาก slippage ที่ตั้งไว้ · ไม่คิดภาษีเงินปันผล",
      ...(isDividend
        ? [
            `การตัดสินใจใช้เฉพาะข้อมูลที่รู้ ณ วันก่อนซื้อขาย (${x.pointInTime === "strict" ? "point-in-time เข้ม" : "โหมดภาพประกอบ มี look-ahead bias"}) · ผลเป็นการจำลอง ไม่ใช่ผลการลงทุนจริง`,
            `ดัชนีอ้างอิง: ${settings.benchmarkKind === "total_return" ? "ผลตอบแทนรวม" : "ดัชนีราคา (ไม่รวมปันผล) — พอร์ตที่รวมปันผลจะดูดีกว่าดัชนีเกินจริง อย่าสรุปว่าชนะตลาดจากส่วนนี้"}`,
          ]
        : []),
      ...pitWarnings,
      `ปฏิทินร่วม: ใช้เฉพาะวันที่ทุกสินทรัพย์มีราคา (${dates.length} วัน)${excluded.length ? ` · ไม่รวม ${excluded.map((e) => e.symbol).join(", ")}` : ""}`,
      "ผลในอดีตไม่รับประกันผลในอนาคต",
    ],
  };
}
