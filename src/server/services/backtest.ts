import { z } from "zod";
import { benchmarkField } from "@/server/basis-schema";
import { resolveBenchmark } from "./benchmarks";
import { priceBasisReport, resolveReturnBasis } from "@/lib/finance/price-basis";
import { asOf, asOfEntry } from "@/lib/finance/portfolio";
import {
  assertSingleDividendTreatment,
  backtest,
  type DecisionProvider,
  type DividendCashflows,
} from "@/lib/finance/backtest";
import {
  DIVIDEND_STRATEGY_IDS,
  backtestReadiness,
  resolveSettings,
  screenDividendStrategy,
  type DividendStrategyId,
  type StrategySettingsInput,
} from "@/lib/finance/dividend-strategies";
import { dpsLatestBasis } from "@/lib/finance/dividend-metrics";
import {
  candidatesAsOf,
  factorInputsAsOf,
  factorSettingsOverride,
  loadDividendData,
  strategySettingsOverride,
} from "./strategies";
import {
  FACTOR_STRATEGY_IDS,
  factorNeedsStatements,
  factorSettingsSchema,
  screenFactorStrategy,
  type FactorSettingsInput,
  type FactorStrategyId,
} from "@/lib/finance/factor-strategies";
import { lotFor, tradingCostsSchema } from "@/lib/finance/rebalance";
import {
  DEFAULT_RETURN_METHOD,
  blackLittermanInput,
  riskFreeInput,
} from "../optimize-schema";
import { buildConstraints, constraintsInput } from "@/lib/finance/exposure";
import { selectCandidates } from "./universe";
import {
  totalReturnSourceFor,
  type AssetReturnBasis,
} from "@/lib/finance/total-return-policy";
import { getRiskFree } from "./risk-free";
import { listAssets } from "./assets";
import {
  loadAdjPriceHistory,
  loadCorporateActionDates,
  loadFxHistory,
  loadPriceHistory,
} from "./prices";
import { buildLevelSeries, commonDates } from "@/lib/finance/return-series";
import { getSettings, getTradingCosts } from "./settings";

export const backtestInput = z
  .object({
    strategy: z
      .enum([
        "buy_and_hold",
        "equal_weight",
        "min_variance",
        "max_sharpe",
        "black_litterman",
        "custom",
        "risk_parity",
        "max_diversification",
        "min_cvar",
        ...DIVIDEND_STRATEGY_IDS,
        ...FACTOR_STRATEGY_IDS,
      ])
      .describe(
        "Strategy to test; dividend_* select by dividend metrics known at each decision date",
      ),
    symbols: z
      .array(z.string())
      .max(30)
      .optional()
      .describe("Universe (default: every non-cash asset with prices)"),
    startDate: z
      .string()
      .optional()
      .describe(
        "First date of data (YYYY-MM-DD); default = when all chosen assets have prices",
      ),
    endDate: z.string().optional(),
    weights: z
      .record(z.string(), z.number().min(0).max(1))
      .optional()
      .describe(
        "custom / buy_and_hold target weights (decimal; remainder = cash). buy_and_hold defaults to equal weights",
      ),
    blackLitterman: blackLittermanInput.optional(),
    returnMethod: z
      .enum(["historical", "capm", "blend"])
      .default(DEFAULT_RETURN_METHOD)
      .describe("μ estimate in each training window (max_sharpe)"),
    covMethod: z.enum(["sample", "ledoit_wolf"]).default("ledoit_wolf"),
    windowDays: z
      .number()
      .int()
      .min(30)
      .max(2000)
      .default(252)
      .describe("Training window in price observations"),
    rebalance: z
      .enum(["monthly", "quarterly", "semiannual", "annual"])
      .default("quarterly"),
    rebalanceAnchor: z
      .enum(["calendar", "periods"])
      .default("calendar")
      .describe(
        "calendar = last trading day of each month / quarter / half / year (first purchase on the start date); periods = every N observations (previous behaviour)",
      ),
    constraints: constraintsInput
      .optional()
      .describe(
        "Same constraints as optimize_portfolio (groups, maxPerSector, maxPerIssuer, maxPerCurrency, assetBounds …), applied at every rebalance; sectors / issuers are today's values",
      ),
    minWeight: z.number().min(0).max(1).default(0),
    maxWeight: z.number().min(0).max(1).default(1),
    initialCapital: z.number().positive().default(1_000_000),
    useCosts: z
      .boolean()
      .default(true)
      .describe("Deduct the trading cost model from Settings"),
    costs: tradingCostsSchema
      .partial()
      .optional()
      .describe("Override costs for this backtest"),
    useLots: z
      .boolean()
      .default(false)
      .describe("Round trades to whole lots (default: fractional units)"),
    returnBasis: z
      .enum(["price_return", "total_return"])
      .optional()
      .describe(
        "price_return = closes (dividends excluded); total_return per asset (returnBasisByAsset): adj_close when complete; gold, accumulating funds (NAV) and stocks without dividends / splits in the period use their close (already their total return); a stock that paid dividends without full adj_close is skipped with the reason. Omit = Settings default, except dividend_* strategies and dividendCashflows, which always use price_return (dividends as cash, never counted twice); total_return with them or with useLots is an error",
      ),
    benchmark: benchmarkField.describe(
      'Benchmark: "default" = an index matching the portfolio basis from Settings / SETTRI / ^SET.BK (as before), "auto" = any stored index whose kind matches, or an index symbol (a kind mismatch is computed with a warning; no data / short data → BENCHMARK_NOT_FOUND / BENCHMARK_COVERAGE). Omit = Settings default',
    ),
    factorSettings: factorSettingsOverride
      .optional()
      .describe("value / quality / momentum / multi_factor settings"),
    dividendSettings: strategySettingsOverride
      .optional()
      .describe(
        "dividend_* strategies: overrides on the preset (optimizer weighting is not available in backtests)",
      ),
    pointInTime: z
      .enum(["strict", "illustrative_lookahead"])
      .default("strict")
      .describe(
        "strict refuses (NOT_BACKTESTABLE_NO_ASOF_DATA) when needed statements have no publication date; illustrative_lookahead runs but is labelled biased",
      ),
    dividendCashflows: z
      .boolean()
      .optional()
      .describe(
        "Simulate dividend cash events (entitlement on ex-date, cash on payment date). Always on for dividend_* strategies; requires price_return",
      ),
    reinvestDividends: z.boolean().default(true),
    cvarConfidence: z
      .number()
      .min(0.8)
      .max(0.995)
      .default(0.95)
      .describe("min_cvar: CVaR confidence"),
    paymentLagDays: z
      .number()
      .int()
      .min(1)
      .max(120)
      .nullable()
      .optional()
      .describe(
        "Assumption for events without a payment date: pay = ex-date + N calendar days. Omitted = Settings default (21 unless changed); null = such events are not credited (reported in warnings)",
      ),
    riskFree: riskFreeInput,
    historyPolicy: z
      .enum(["common", "drop_short"])
      .default("common")
      .describe(
        "common = one calendar where every asset has prices (fails with the limiting assets named); drop_short = drop the assets whose short history makes the period too short (listed in excluded)",
      ),
    withholding: z
      .record(z.string(), z.number().min(0).max(1))
      .default({ thai_stock: 0.1, fund: 0.1, us_stock: 0.15 })
      .describe(
        "Default dividend withholding by asset class when an event has none (assumption)",
      ),
  })
  .refine((v) => v.strategy !== "black_litterman" || v.blackLitterman, {
    message: "black_litterman requires blackLitterman.marketWeights",
    path: ["blackLitterman"],
  })
  .refine((v) => v.strategy !== "custom" || v.weights, {
    message: "custom requires weights",
    path: ["weights"],
  });

const PER_YEAR = {
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
} as const;

export type BacktestDataRequest = Pick<
  z.output<typeof backtestInput>,
  | "symbols"
  | "startDate"
  | "endDate"
  | "returnBasis"
  | "rebalance"
  | "useCosts"
  | "costs"
  | "useLots"
> & {
  riskFree?: z.output<typeof riskFreeInput>;
  historyPolicy?: "common" | "drop_short";
  /** Observations the strategy needs (training window + test); shorter → named limiting assets or drop_short. */
  minObservations?: number;
  /** Basis of the portfolio being tested, for a benchmark on the same basis. */
  benchmarkBasis?: "price" | "total_return";
  /** "default" | "auto" | symbol (PRICE_BASIS_BENCHMARK_SPEC D2); omitted = Settings' defaultBenchmark. */
  benchmark?: string;
};

/**
 * Tradable universe on one common calendar (THB levels, actual prints only), benchmark, cost model and
 * the rebalance step — shared by the single-strategy backtest and the model comparison.
 */
export async function loadBacktestData(x: BacktestDataRequest) {
  const [assets, prices, fx, settings, savedCosts] = await Promise.all([
    listAssets(),
    loadPriceHistory(),
    loadFxHistory(),
    getSettings(),
    getTradingCosts(),
  ]);
  const { candidates, skipped, wanted } = selectCandidates(assets, x.symbols);
  if (wanted) {
    const missing = [...wanted].filter(
      (s) => !assets.some((a) => a.symbol.toUpperCase() === s),
    );
    if (missing.length)
      throw new Error(`ไม่พบ ${missing.join(", ")} ในรายการสินทรัพย์`);
  }
  const excluded: { symbol: string; reason: string }[] = [...skipped];
  const dataWarnings: string[] = [];
  let pool = candidates;
  pool = pool.filter((a) => {
    const n = prices.get(a.id)?.length ?? 0;
    if (n < 2) excluded.push({ symbol: a.symbol, reason: "ไม่มีประวัติราคา" });
    return n >= 2;
  });
  const firstOf = (id: number) => prices.get(id)![0][0];
  // Without a start date every series keeps its full history; the common calendar below starts where the
  // latest asset starts — so the limiting assets can be named (and dropped with drop_short).
  let start = x.startDate ?? "0000-00-00";
  if (x.startDate) {
    pool = pool.filter((a) => {
      if (firstOf(a.id) > x.startDate!)
        excluded.push({
          symbol: a.symbol,
          reason: `ราคาเริ่ม ${firstOf(a.id)} หลังวันเริ่ม backtest`,
        });
      return firstOf(a.id) <= x.startDate!;
    });
  }
  pool = pool.filter((a) => {
    if (a.currency !== "USD") return true;
    const ok = fx.length && fx[0][0] <= (x.startDate ?? firstOf(a.id));
    if (!ok)
      excluded.push({ symbol: a.symbol, reason: "ไม่มี USDTHB ครอบคลุมช่วง" });
    return ok;
  });
  if (!pool.length) throw new Error("ไม่มีสินทรัพย์ที่มีข้อมูลครบช่วง");
  const end = x.endDate ?? "9999-12-31";
  // Shared conventions (return-series.ts): THB levels per actual print, FX applied once, total return
  // only from the provider's adjusted closes; then the common calendar of actual prints.
  const adj =
    x.returnBasis === "total_return" ? await loadAdjPriceHistory() : null;
  const actions =
    x.returnBasis === "total_return" ? await loadCorporateActionDates() : null;
  const returnBasisByAsset: Record<string, AssetReturnBasis> = {};
  const basisNotes: string[] = [];
  const basisFallback: { symbol: string; reason: string }[] = [];
  const basisExcluded: { symbol: string; reason: string }[] = [];
  const levels = new Map<
    number,
    { levels: [string, number][]; scale: number }
  >();
  pool = pool.filter((a) => {
    const window = prices.get(a.id)!.filter(([d]) => d >= start && d <= end);
    const adjMap = adj ? new Map(adj.get(a.id) ?? []) : null;
    const observations = window.map(([date, close]) => ({
      date,
      close,
      adjClose: adjMap?.get(date) ?? null,
    }));
    // Total return per asset class (MPT A3): adj_close, or the close where it already is the total return.
    const src =
      x.returnBasis === "total_return"
        ? totalReturnSourceFor(a, observations, actions!.for(a))
        : null;
    if (src && !src.ok) {
      excluded.push({
        symbol: a.symbol,
        reason: `${src.reason}${src.required ? ` — ต้องการ: ${src.required}` : ""}`,
      });
      basisExcluded.push(excluded[excluded.length - 1]);
      return false;
    }
    const useAdj = !!src?.ok && src.source === "adjusted_close";
    const lv = buildLevelSeries({
      label: a.symbol,
      observations,
      basis: src?.ok && !useAdj ? "price_return" : (x.returnBasis ?? "price_return"),
      totalReturnSource: useAdj ? "adjusted_close" : undefined,
      currency: a.currency,
      fx,
    });
    if (!lv.ok) {
      excluded.push({
        symbol: a.symbol,
        reason: `${lv.reason}${lv.required ? ` — ต้องการ: ${lv.required}` : ""}`,
      });
      return false;
    }
    // Trade at THB prices on the chosen basis: first price (× FX) × index level.
    const first = window[0];
    const p0 =
      (useAdj ? adjMap!.get(first[0])! : first[1]) *
      (a.currency === "USD" ? (asOf(fx, first[0]) ?? NaN) : 1);
    levels.set(a.id, { levels: lv.levels, scale: p0 });
    returnBasisByAsset[a.symbol] = src?.ok ? src.basis : "close";
    if (src?.ok && src.note) {
      basisNotes.push(src.note);
      basisFallback.push({ symbol: a.symbol, reason: src.note });
    }
    return true;
  });
  if (!pool.length)
    throw new Error(
      `ไม่มีสินทรัพย์ที่ใช้ได้: ${excluded.map((e) => `${e.symbol} (${e.reason})`).join(", ")}`,
    );
  const firstLevel = (a: (typeof pool)[number]) =>
    levels.get(a.id)!.levels[0]?.[0] ?? "9999-12-31";
  let dates = commonDates(pool.map((a) => levels.get(a.id)!.levels));
  const need = x.minObservations ?? 3;
  if (dates.length < need && x.historyPolicy === "drop_short") {
    // Drop the latest starter (then the sparsest series) until the common calendar is long enough.
    while (dates.length < need && pool.length > 2) {
      const worst = [...pool].sort(
        (a, b) =>
          firstLevel(b).localeCompare(firstLevel(a)) ||
          levels.get(a.id)!.levels.length - levels.get(b.id)!.levels.length,
      )[0];
      excluded.push({
        symbol: worst.symbol,
        reason: `historyPolicy drop_short: ราคาเริ่ม ${firstLevel(worst)} (${levels.get(worst.id)!.levels.length} วัน) ทำให้ช่วงข้อมูลร่วมสั้นกว่าที่ต้องใช้ ${need} วัน`,
      });
      pool = pool.filter((a) => a !== worst);
      dates = commonDates(pool.map((a) => levels.get(a.id)!.levels));
    }
  }
  if (dates.length < need) {
    // Name the assets that limit the period: the latest starters and any series shorter than needed.
    const limiting = [...pool]
      .sort((a, b) => firstLevel(b).localeCompare(firstLevel(a)))
      .filter((a, i) => i < 3 || levels.get(a.id)!.levels.length < need)
      .map(
        (a) =>
          `${a.symbol} (ราคาเริ่ม ${firstLevel(a)}, ${levels.get(a.id)!.levels.length} วัน)`,
      );
    throw new Error(
      `ข้อมูลร่วม ${dates.length} วัน${dates.length ? ` (${dates[0]} → ${dates[dates.length - 1]})` : ""} ไม่พอ — ต้องการ ≥ ${need} วัน (ช่วงฝึก + ช่วงทดสอบ) · ตัวที่จำกัดช่วง: ${limiting.join(", ")}` +
        (x.minObservations
          ? ` · windowDays สูงสุดที่รันได้กับชุดนี้: ${Math.max(0, dates.length - 3)}`
          : "") +
        ` · หรือใช้ historyPolicy "drop_short" เพื่อตัดตัวที่ประวัติสั้นออก`,
    );
  }
  if (x.startDate && dates[0] > x.startDate) {
    const late = pool
      .filter((a) => firstLevel(a) === dates[0] || firstLevel(a) > x.startDate!)
      .map((a) => `${a.symbol} (เริ่ม ${firstLevel(a)})`);
    dataWarnings.push(
      `ช่วงข้อมูลเริ่ม ${dates[0]} หลังวันที่ขอ ${x.startDate}${late.length ? ` — จำกัดโดย ${late.join(", ")}` : ""}`,
    );
  }
  if (excluded.length)
    dataWarnings.push(
      `ไม่รวม ${excluded.length} สินทรัพย์: ${excluded.map((e) => `${e.symbol} (${e.reason})`).join(" · ")}`,
    );
  start = dates[0];
  const px = pool.map((a) => {
    const { levels: lv, scale } = levels.get(a.id)!;
    const m = new Map(lv);
    return dates.map((d) => m.get(d)! * scale);
  });
  if (x.returnBasis === "total_return" && x.useLots)
    throw new Error(
      "total_return ใช้ราคาปรับปันผลซึ่งไม่ใช่ราคาซื้อขายจริง — ปิด useLots",
    );
  const years =
    (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) /
    (365 * 86_400_000);
  const obsPerYear = years > 0 ? (dates.length - 1) / years : 252;
  const every = Math.max(1, Math.round(obsPerYear / PER_YEAR[x.rebalance]));
  // "default" = benchmarkForBasis' rule (unchanged); auto / symbol per the resolver (spec D2).
  const benchmark = await resolveBenchmark({
    request: x.benchmark,
    wanted:
      x.benchmarkBasis ??
      (x.returnBasis === "total_return" ? "total_return" : "price"),
    from: start,
    featureDefault: "basis",
  });
  if (benchmark?.warning) dataWarnings.push(benchmark.warning);
  if (!benchmark)
    dataWarnings.push(
      "ไม่มีข้อมูลดัชนีอ้างอิงครอบคลุมช่วงนี้ — ไม่คำนวณ beta / alpha / IR",
    );
  const bench = benchmark?.series ?? [];
  // Risk-free rate: the same resolver (and options) as optimize_portfolio; used for idle cash and Sharpe.
  const riskFreeInfo = await getRiskFree({
    purpose: "portfolio",
    ...(x.riskFree ?? {}),
  });
  if (!riskFreeInfo.ok || riskFreeInfo.rate == null)
    throw new Error(`อัตราปลอดความเสี่ยง: ${riskFreeInfo.errors.join(" · ")}`);
  if (riskFreeInfo.source === "settings" && !settings.rfSource)
    dataWarnings.push(
      `Rf ${(riskFreeInfo.rate * 100).toFixed(2)}% เป็นค่าตัวอย่างจากหน้าตั้งค่า (ไม่มีแหล่งอ้างอิง) — ดอกเบี้ยเงินสดและ Sharpe ใช้ค่านี้ · ระบุ riskFree.manual หรือบันทึกแหล่งที่มาในหน้าตั้งค่า`,
    );
  dataWarnings.push(...riskFreeInfo.warnings);
  const costs = x.useCosts
    ? tradingCostsSchema.parse({ ...savedCosts, ...(x.costs ?? {}) })
    : tradingCostsSchema.parse({ lotSize: {}, ...(x.costs ?? {}) });
  return {
    pool,
    symbols: pool.map((a) => a.symbol),
    dates,
    px,
    fx,
    settings,
    bench,
    benchmark,
    rf: riskFreeInfo.rate,
    riskFreeInfo,
    costs,
    excluded,
    every,
    obsPerYear,
    dataWarnings: [...dataWarnings, ...basisNotes],
    returnBasisByAsset: Object.fromEntries(
      pool.map((a) => [a.symbol, returnBasisByAsset[a.symbol] ?? "close"]),
    ),
    basisFallback: basisFallback.filter((f) => pool.some((a) => a.symbol === f.symbol)),
    basisExcluded,
  };
}

/** Walk-forward backtest on stored prices. Read-only. */
export async function backtestPortfolio(input: z.input<typeof backtestInput>) {
  const x = backtestInput.parse(input);
  // Dividend strategies / cashflows: one economic treatment (tradable prices + cash events) — checked first.
  const isDividend = (DIVIDEND_STRATEGY_IDS as readonly string[]).includes(
    x.strategy,
  );
  const withCash = isDividend || !!x.dividendCashflows;
  // Request → Settings → price_return; dividend cash flows never read the Settings default (they need closes).
  const basisInfo = resolveReturnBasis(
    x.returnBasis,
    withCash ? null : (await getSettings()).defaultReturnBasis,
    "price_return",
  );
  const basis = basisInfo.used;
  x.returnBasis = basis;
  assertSingleDividendTreatment(x.returnBasis, withCash);
  // Optimizer strategies need a training window + at least one test day (see lib/backtest: start = window + 1).
  const usesWindow =
    !["buy_and_hold", "equal_weight", "custom"].includes(x.strategy) &&
    !isDividend &&
    !(FACTOR_STRATEGY_IDS as readonly string[]).includes(x.strategy);
  const {
    pool,
    symbols,
    dates,
    px,
    fx,
    settings,
    bench,
    benchmark,
    rf,
    riskFreeInfo,
    costs,
    excluded,
    every,
    obsPerYear,
    dataWarnings,
    returnBasisByAsset,
    basisFallback,
    basisExcluded,
  } = await loadBacktestData({
    ...x,
    minObservations: usesWindow ? x.windowDays + 3 : 3,
    benchmarkBasis:
      withCash || x.returnBasis === "total_return" ? "total_return" : "price",
  });
  const weights = x.weights
    ? Object.fromEntries(
        Object.entries(x.weights).map(([k, v]) => [k.toUpperCase(), v]),
      )
    : undefined;
  if (weights) {
    const unknown = Object.keys(weights).filter(
      (k) => !symbols.map((s) => s.toUpperCase()).includes(k),
    );
    if (unknown.length)
      throw new Error(
        `น้ำหนักของ ${unknown.join(", ")} ไม่อยู่ในชุดที่ทดสอบได้`,
      );
  }

  let decisionProvider: DecisionProvider | undefined;
  const isFactor = (FACTOR_STRATEGY_IDS as readonly string[]).includes(
    x.strategy,
  );
  const factorWarnings: string[] = [];
  if (isFactor) {
    // F7: momentum on the backtest's own basis (adjusted closes for total_return), same rule as the screen.
    const data = await loadDividendData({ adj: x.returnBasis === "total_return" });
    const fo = (x.factorSettings ?? {}) as Partial<FactorSettingsInput>;
    const fs = factorSettingsSchema.parse(fo);
    if (factorNeedsStatements(x.strategy as FactorStrategyId, fs)) {
      const st = symbols.map((s) => data.statements.get(s) ?? []);
      const anyPit = st.some((ys) => ys.some((y) => y.publishedAt != null));
      const anyRows = st.some((ys) => ys.length > 0);
      if (x.pointInTime === "strict" && anyRows && !anyPit) {
        throw new Error(
          "NOT_BACKTESTABLE_NO_ASOF_DATA: กลยุทธ์นี้ใช้งบการเงิน แต่งบไม่มีวันเผยแพร่ (published_at) — ใช้ได้แค่คัดกรองปัจจุบัน, momentum, หรือโหมดภาพประกอบที่มี look-ahead bias",
        );
      }
      if (x.pointInTime !== "strict")
        factorWarnings.push(
          "โหมดภาพประกอบ (look-ahead bias): ใช้งบที่ไม่มีวันเผยแพร่โดยถือว่างบปีก่อนรู้แล้ว",
        );
      if (!anyRows)
        factorWarnings.push(
          "ไม่มีงบการเงิน — ส่วน value/quality ใช้ไม่ได้ (คัดออกเพราะข้อมูลไม่พอ)",
        );
    }
    let previous: string[] = [];
    decisionProvider = ({ cutoff }) => {
      const d = screenFactorStrategy({
        strategyId: x.strategy as FactorStrategyId,
        asOf: cutoff,
        inputs: factorInputsAsOf(data, symbols, cutoff, x.pointInTime, x.returnBasis),
        settings: fo,
        previous,
      });
      previous = d.selected;
      return {
        w: symbols.map((s) => d.targetWeights[s] ?? 0),
        selected: d.selected,
        diagnostics: [
          ...d.diagnostics,
          ...d.excluded.map((e) => `${e.symbol}: ${e.code}`),
        ],
        note: d.selected.length
          ? undefined
          : "ไม่มีหุ้นที่มีข้อมูลพอ ณ วันตัดสินใจ — ถือเงินสด",
      };
    };
  }
  let dividendCashflows: DividendCashflows | undefined;
  const pitWarnings: string[] = [];
  /** Things that make the numbers wrong or biased (with their size); limitations stay methodological. */
  const cashWarnings: string[] = [];
  let assumedPaymentDates:
    | {
        count: number;
        lagDays: number | null;
        bySymbol: Record<string, number>;
      }
    | undefined;
  if (withCash) {
    const data = await loadDividendData();
    const assetOf = new Map(pool.map((a) => [a.symbol, a]));
    if (isDividend) {
      const overrides = (x.dividendSettings ??
        {}) as Partial<StrategySettingsInput>;
      const st = resolveSettings(x.strategy as DividendStrategyId, overrides);
      if (st.weighting === "optimizer")
        throw new Error(
          "น้ำหนักแบบ optimizer ใช้ใน backtest กลยุทธ์ปันผลไม่ได้ — เลือก equal หรือ score",
        );
      const ready = backtestReadiness({
        settings: st,
        statementsBySymbol: Object.fromEntries(
          symbols.map((s) => [s, data.statements.get(s) ?? []]),
        ),
        mode: x.pointInTime,
      });
      if (!ready.ok) throw new Error(`${ready.code}: ${ready.detail}`);
      pitWarnings.push(...ready.warnings);
      decisionProvider = ({ cutoff }) => {
        const cands = candidatesAsOf(
          data,
          symbols,
          cutoff,
          x.pointInTime,
          st.includeSpecial,
        );
        const d = screenDividendStrategy({
          strategyId: x.strategy as DividendStrategyId,
          asOf: cutoff,
          candidates: cands,
          settings: overrides,
        });
        const w = symbols.map((s) => d.targetWeights[s] ?? 0);
        return {
          w,
          selected: d.selected,
          diagnostics: [
            ...d.diagnostics,
            ...d.excluded.map((e) => `${e.symbol}: ${e.code}`),
          ],
          note: d.selected.length
            ? undefined
            : "ไม่มีหุ้นผ่านเกณฑ์ ณ วันตัดสินใจ — ถือเงินสด",
        };
      };
    }
    let stock = 0;
    // Omitted → the Settings assumption; an explicit null keeps "events without a payment date are not credited".
    const lag =
      x.paymentLagDays === undefined
        ? (settings.dividendPaymentLagDays ?? null)
        : x.paymentLagDays;
    const events: DividendCashflows["events"] = [];
    const uncredited: NonNullable<DividendCashflows["uncredited"]> = [];
    const assumed = new Map<string, number>();
    for (const sym of symbols) {
      const a = assetOf.get(sym)!;
      for (const e of data.events.get(sym) ?? []) {
        if (
          e.kind === "indicated_annual" ||
          !e.exDate ||
          e.exDate < dates[0] ||
          e.exDate > dates[dates.length - 1]
        )
          continue;
        if (e.cashOrStock === "stock") {
          stock++;
          continue;
        }
        // A recorded payment date always wins over the assumption.
        const pay =
          e.paymentDate ??
          (lag != null
            ? new Date(Date.parse(e.exDate) + lag * 86_400_000)
                .toISOString()
                .slice(0, 10)
            : null);
        const fxRate =
          e.currency === "THB"
            ? 1
            : e.currency === "USD"
              ? (asOfEntry(fx, pay ?? e.exDate)?.[1] ?? asOf(fx, e.exDate))
              : null;
        if (fxRate == null || e.currency !== a.currency) continue;
        const gross = dpsLatestBasis(e, data.splits[sym] ?? []) * fxRate;
        const wht = e.withholdingTaxRate ?? x.withholding[a.assetClass] ?? 0;
        if (!pay) {
          uncredited.push({
            symbol: sym,
            exDate: e.exDate,
            grossPerUnitThb: gross,
            netPerUnitThb: gross * (1 - wht),
          });
          continue;
        }
        if (!e.paymentDate) assumed.set(sym, (assumed.get(sym) ?? 0) + 1);
        events.push({
          symbol: sym,
          exDate: e.exDate,
          paymentDate: pay,
          grossPerUnitThb: gross,
          netPerUnitThb: gross * (1 - wht),
        });
      }
    }
    const assumptions = [
      `ภาษีหัก ณ ที่จ่าย (สมมติฐานเมื่อข้อมูลไม่ระบุ): ${Object.entries(
        x.withholding,
      )
        .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
        .join(", ")}`,
      "ปันผลสกุล USD แปลงเป็นบาทด้วย USDTHB ณ วันจ่าย",
    ];
    const assumedCount = [...assumed.values()].reduce((a, b) => a + b, 0);
    if (assumedCount)
      assumptions.push(
        `สมมติฐาน: ${assumedCount} เหตุการณ์ที่ไม่มีวันจ่าย ถือว่าจ่ายหลัง ex-date ${lag} วัน${x.paymentLagDays === undefined ? " (ค่าจากหน้าตั้งค่า)" : ""} — ไม่ใช่ข้อมูลจริง (${[...assumed].map(([k, v]) => `${k} ${v}`).join(", ")})`,
      );
    assumedPaymentDates = {
      count: assumedCount,
      lagDays: lag,
      bySymbol: Object.fromEntries(assumed),
    };
    if (stock)
      cashWarnings.push(
        `ไม่จำลองปันผลเป็นหุ้น ${stock} ครั้ง — ผลตอบแทนต่ำกว่าจริงตามมูลค่าหุ้นปันผล`,
      );
    if (!events.length && !uncredited.length)
      cashWarnings.push(
        "ไม่มีเหตุการณ์ปันผลในช่วงนี้ — นำเข้าจาก Yahoo หรือบันทึกจากประกาศ SET ก่อน",
      );
    dividendCashflows = {
      events,
      reinvest: x.reinvestDividends,
      assumptions,
      uncredited,
    };
  }

  // Constraints: the optimizer's builder on today's asset metadata (no sector / issuer history).
  const built = buildConstraints(
    pool.map((a) => ({
      symbol: a.symbol,
      assetClass: a.assetClass,
      issuer: a.issuer ?? null,
      sector: a.sector ?? null,
      rating: a.assetClass === "bond" ? "unrated" : null,
      modifiedDuration: null,
      currency: a.currency,
    })),
    { min: x.minWeight, max: x.maxWeight },
    x.constraints,
    x.initialCapital,
  );
  if (built.unsupported.length)
    throw new Error(
      `ข้อจำกัดที่ backtest ไม่รองรับ: ${built.unsupported.join(" · ")}`,
    );
  if (x.constraints) dataWarnings.push(...built.warnings);
  const constraintLimits: string[] = [];
  if (x.constraints && (built.bounds.linear?.length ?? 0) > 0)
    constraintLimits.push(
      "ข้อจำกัดหมวด / ผู้ออก / สกุลเงินใช้ข้อมูล ณ ปัจจุบันกับทุกรอบในอดีต (ไม่มีประวัติการจัดหมวด)",
    );
  if (
    x.constraints &&
    (built.unclassified.sector.length || built.unclassified.issuer.length)
  )
    dataWarnings.push(
      `สินทรัพย์ที่ไม่มีหมวด / ผู้ออก ไม่ถูกนับในเพดานนั้น: ${[...built.unclassified.sector, ...built.unclassified.issuer].filter((v, i, a) => a.indexOf(v) === i).join(", ")}`,
    );
  const r = backtest({
    symbols,
    dates,
    prices: px,
    benchmark:
      benchmark && bench.length
        ? { symbol: benchmark.symbol, series: bench, kind: benchmark.kind }
        : null,
    strategy: x.strategy,
    weights:
      weights &&
      Object.fromEntries(
        symbols.map((s) => [s, weights[s.toUpperCase()] ?? 0]),
      ),
    blackLitterman: x.blackLitterman,
    returnMethod: x.returnMethod,
    covMethod: x.covMethod,
    window: x.windowDays,
    rebalanceEvery: every,
    rebalanceCalendar:
      x.rebalanceAnchor === "calendar" ? x.rebalance : undefined,
    bounds: built.bounds,
    rf,
    erp: settings.equityRiskPremium / 100,
    initialCapital: x.initialCapital,
    costs,
    lots: Object.fromEntries(
      pool.map((a) => [a.symbol, lotFor(costs, a.assetClass, a.lotSize)]),
    ),
    useLots: x.useLots,
    decisionProvider,
    dividendCashflows,
    cvarConfidence: x.cvarConfidence,
  });
  if (!r.ok) throw new Error(r.error);
  const missed = r.dividends?.uncredited;
  if (missed && missed.events)
    cashWarnings.push(
      `ปันผล ${missed.events} เหตุการณ์ไม่มีวันจ่ายและไม่ได้ใช้สมมติฐาน (paymentLagDays: null) จึงไม่ถูกนับ — ${missed.heldEvents} ครั้งเกิดขณะถือหุ้น มูลค่าสุทธิ ${Math.round(missed.netThb).toLocaleString("en-US")} บาท ≈ ${(missed.shareOfInitial * 100).toFixed(2)} จุดเปอร์เซ็นต์ของผลตอบแทนรวม`,
    );
  return {
    ...r,
    warnings: [...dataWarnings, ...cashWarnings, ...r.warnings],
    input: {
      ...x,
      rebalanceEveryObservations: every,
      observationsPerYear: obsPerYear,
    },
    universe: symbols,
    excluded,
    returnBasisByAsset,
    benchmark: benchmark
      ? {
          symbol: benchmark.symbol,
          basis: benchmark.basis,
          wanted: benchmark.wanted,
          kind: benchmark.kind,
          source: benchmark.source,
          warning: benchmark.warning,
        }
      : null,
    priceBasis: priceBasisReport(basisInfo, basisFallback, basisExcluded),
    riskFreeInfo,
    ...(assumedPaymentDates ? { assumedPaymentDates } : {}),
    costModel: costs,
    limitations: [
      "Survivorship bias: ใช้เฉพาะสินทรัพย์ที่อยู่ในแอปวันนี้ — หุ้นที่ถูกถอดหรือเลิกกิจการในอดีตไม่ถูกรวม ผลจึงอาจดีกว่าความเป็นจริง",
      withCash
        ? "ราคาเป็นราคาปิดซื้อขายได้ (ปรับ split แล้ว ไม่ปรับปันผล) + ปันผลเป็นเงินสดตามเหตุการณ์ — ปันผลนับครั้งเดียว; ดอกเบี้ยพันธบัตรไม่รวม"
        : x.returnBasis === "total_return"
          ? "ผลตอบแทนรวม: ใช้ราคาปรับปันผลของผู้ให้ข้อมูล (ปันผลถูกนำไปลงทุนต่อ ณ วัน XD) — ระดับราคาถูกปรับย้อนหลังโดยผู้ให้ข้อมูล แต่อัตราผลตอบแทนแต่ละช่วงไม่ใช้ข้อมูลอนาคต; ไม่หักภาษีปันผล; พันธบัตร/กองทุนที่ไม่มี adj_close ถูกตัดออก"
          : "ราคาเป็นราคาปิดที่ไม่รวมเงินปันผล (Yahoo close ปรับ split แล้ว) — หุ้นปันผลสูงจะดูแย่กว่าผลตอบแทนรวมจริง; ดอกเบี้ยพันธบัตรไม่รวม (ราคาสะอาด)",
      benchmark
        ? `ดัชนีอ้างอิง ${benchmark.symbol} เป็น${benchmark.basis === "total_return" ? "ผลตอบแทนรวม" : "ดัชนีราคา (ไม่รวมปันผล)"}`
        : "ไม่มีดัชนีอ้างอิง",
      ...(x.strategy === "black_litterman"
        ? [
            "Black–Litterman: น้ำหนักตลาดที่ใส่เป็นค่าปัจจุบันและใช้ทุกช่วงย้อนหลัง (ไม่ใช่ข้อมูล ณ วันนั้น) — เป็น look-ahead ในอินพุต",
          ]
        : []),
      withCash
        ? "ซื้อขายที่ราคาปิดวันปรับพอร์ต · ปันผลเป็นกระแสเงินสดจากเหตุการณ์ (หักภาษีตามสมมติฐาน) ไม่ใช่ราคาปรับปันผล"
        : "ซื้อขายที่ราคาปิดวันปรับพอร์ต ไม่มี market impact นอกจาก slippage ที่ตั้งไว้ · ไม่คิดภาษีเงินปันผล",
      ...(isDividend
        ? [
            `การตัดสินใจใช้เฉพาะข้อมูลที่รู้ ณ วันก่อนซื้อขาย (${x.pointInTime === "strict" ? "point-in-time เข้ม" : "โหมดภาพประกอบ มี look-ahead bias"}) · ผลเป็นการจำลอง ไม่ใช่ผลการลงทุนจริง`,
          ]
        : []),
      ...pitWarnings,
      ...factorWarnings,
      ...(isFactor
        ? [
            "สัญญาณปัจจัยใช้ข้อมูลที่รู้ ณ วันก่อนซื้อขายเท่านั้น · valuation ที่บันทึกภายหลังไม่ถูกใช้ย้อนหลัง · ผลเป็นการจำลอง",
          ]
        : []),
      `ปฏิทินร่วม: ใช้เฉพาะวันที่ทุกสินทรัพย์มีราคา (${dates.length} วัน)${excluded.length ? ` · ไม่รวม ${excluded.map((e) => e.symbol).join(", ")}` : ""}`,
      ...constraintLimits,
      "ผลในอดีตไม่รับประกันผลในอนาคต",
    ],
  };
}
