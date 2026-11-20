/**
 * Portfolio model comparison: the same assets, calendar, bounds, costs and estimator for every model,
 * so differences come from the model alone. No new optimizer or metric — weights come from the
 * walk-forward engine (`backtest` → `recommend`), numbers from `computeMetrics`.
 *
 *  split        — weights estimated once on the training part (prices before index s), then held
 *                 (rebalanced back to those weights) over the test part. Reports the ex-ante estimate,
 *                 the realised in-sample fit and the realised out-of-sample result side by side.
 *  walk-forward — weights re-estimated at every rebalance from the trailing window; every model starts
 *                 on the same date, so the out-of-sample periods are identical.
 * No look-ahead in either mode: a decision at index t uses prices up to t − 1 only.
 */
import {
  backtest,
  estimateWindow,
  type BacktestInput,
  type BacktestResult,
} from "./backtest";
import type { TradingCosts } from "./rebalance";

export const COMPARISON_MODELS = [
  "equal_weight",
  "min_variance",
  "max_sharpe",
  "risk_parity",
  "max_diversification",
  "min_cvar",
] as const;
export type ComparisonModel = (typeof COMPARISON_MODELS)[number];

export const MODEL_LABEL: Record<ComparisonModel, string> = {
  equal_weight: "Equal Weight",
  min_variance: "Min Variance",
  max_sharpe: "Max Sharpe",
  risk_parity: "Risk Parity",
  max_diversification: "Max Diversification",
  min_cvar: "Min CVaR",
};

/** Fewer observations than this in a test period: metrics are shown but flagged as unreliable. */
export const MIN_OOS_OBS = 60;
const MIN_TRAIN_RETURNS = 30;

export interface ModelComparisonInput {
  symbols: string[];
  /** Common calendar: every asset has an actual price on every date. */
  dates: string[];
  prices: number[][];
  benchmark: BacktestInput["benchmark"];
  rf: number;
  erp: number;
  bounds: BacktestInput["bounds"];
  covMethod: "sample" | "ledoit_wolf";
  returnMethod: "historical" | "capm" | "blend";
  costs: TradingCosts;
  lots: Record<string, number>;
  useLots: boolean;
  initialCapital: number;
  /** Share of the calendar used for training in split mode (0.5 – 0.9). */
  splitFraction: number;
  /** Walk-forward training window in return observations. */
  window: number;
  /** Rebalance every k observations (both modes). */
  rebalanceEvery: number;
  /** Calendar anchor for the rebalances (overrides rebalanceEvery); see BacktestInput.rebalanceCalendar. */
  rebalanceCalendar?: BacktestInput["rebalanceCalendar"];
  cvarConfidence?: number;
  models?: readonly ComparisonModel[];
}

export interface RealisedStats {
  from: string;
  to: string;
  observations: number;
  cumulativeReturn: number;
  /** CAGR when the period is ≥ 1 year, otherwise the annualised equivalent (flagged by `annualised`). */
  annualReturn: number | null;
  annualised: "cagr" | "extrapolated";
  volatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number | null;
}

export interface ExAnteStats {
  expectedReturn: number;
  volatility: number;
  sharpe: number | null;
}

export interface SplitModelResult {
  model: ComparisonModel;
  ok: boolean;
  error?: string;
  /** Weights estimated on the training part (decimal by symbol; remainder = cash). */
  weights: Record<string, number>;
  exAnte: ExAnteStats | null;
  inSample: RealisedStats | null;
  outOfSample: RealisedStats | null;
  /** Realised out-of-sample minus ex-ante (what the estimate overstated when negative). */
  gap: {
    annualReturn: number | null;
    volatility: number | null;
    sharpe: number | null;
  } | null;
  turnover: number | null;
  costs: number | null;
  notes: string[];
}

export interface WalkForwardModelResult {
  model: ComparisonModel;
  ok: boolean;
  error?: string;
  /** Target weights at the latest rebalance. */
  latestWeights: Record<string, number>;
  outOfSample: RealisedStats | null;
  rebalances: number;
  turnoverAnnual: number | null;
  costs: number | null;
  notes: string[];
}

type CurveRow = { date: string } & Record<string, number | string | null>;

export interface ModelComparisonResult {
  ok: boolean;
  error?: string;
  symbols: string[];
  models: ComparisonModel[];
  split: {
    train: { from: string; to: string; observations: number };
    test: { from: string; to: string; observations: number };
    results: SplitModelResult[];
    /** Wealth index (100 at the first test date) per model and the benchmark. */
    curve: CurveRow[];
    drawdown: CurveRow[];
    ranking: ComparisonModel[];
  } | null;
  walkForward: {
    window: number;
    test: { from: string; to: string; observations: number };
    results: WalkForwardModelResult[];
    curve: CurveRow[];
    drawdown: CurveRow[];
    ranking: ComparisonModel[];
  } | null;
  warnings: string[];
  methodology: string[];
}

const dot = (a: number[], b: number[]) =>
  a.reduce((s, v, i) => s + v * b[i], 0);

function realised(r: BacktestResult): RealisedStats {
  const m = r.metrics;
  return {
    from: r.period.from,
    to: r.period.to,
    observations: r.period.observations,
    cumulativeReturn: m.cumulativeReturn,
    annualReturn: m.annualizedReturn ?? m.annualizedEquivalent,
    annualised: m.annualizedReturn != null ? "cagr" : "extrapolated",
    volatility: m.volatility,
    sharpe: m.sharpe,
    sortino: m.sortino,
    maxDrawdown: m.maxDrawdown,
  };
}

/** Rows on the union of dates (all runs share one calendar and start, so this is their common axis). */
function curves(
  runs: { key: string; r: BacktestResult }[],
  benchmark: ModelComparisonInput["benchmark"],
  field: "values" | "drawdown",
  initial: number,
): CurveRow[] {
  if (!runs.length) return [];
  const dates = runs[0].r.values.map((v) => v.date);
  const bench = new Map(benchmark?.series ?? []);
  const b0 = bench.get(dates[0]);
  let peak = -Infinity;
  return dates.map((date, i) => {
    const row: CurveRow = { date };
    for (const { key, r } of runs)
      row[key] =
        field === "values"
          ? r.values[i]
            ? (100 * r.values[i].value) / initial
            : null
          : (r.drawdown[i]?.drawdown ?? null);
    // Benchmark only on its own actual prints (no carried level).
    const b = bench.get(date);
    if (b0 != null && b != null) {
      const level = (100 * b) / b0;
      peak = Math.max(peak, level);
      row.benchmark = field === "values" ? level : level / peak - 1;
    } else row.benchmark = null;
    return row;
  });
}

const bySharpe = <
  T extends { model: ComparisonModel; outOfSample: RealisedStats | null },
>(
  rows: T[],
) =>
  rows
    .filter((r) => r.outOfSample?.sharpe != null)
    .sort((a, b) => b.outOfSample!.sharpe! - a.outOfSample!.sharpe!)
    .map((r) => r.model);

export function compareModels(x: ModelComparisonInput): ModelComparisonResult {
  const models = [...(x.models?.length ? x.models : COMPARISON_MODELS)];
  const T = x.dates.length;
  const n = x.symbols.length;
  const warnings: string[] = [];
  const empty = {
    symbols: x.symbols,
    models,
    split: null,
    walkForward: null,
    warnings,
    methodology: [],
  };
  if (n < 2)
    return {
      ok: false,
      error: "ต้องมีอย่างน้อย 2 สินทรัพย์เพื่อเปรียบเทียบโมเดล",
      ...empty,
    };
  if (
    x.prices.length !== n ||
    x.prices.some((p) => p.length !== T || p.some((v) => !(v > 0)))
  )
    return { ok: false, error: "ราคาไม่ครบหรือไม่ถูกต้องในบางวัน", ...empty };

  const base: Omit<BacktestInput, "strategy" | "window" | "rebalanceEvery"> = {
    symbols: x.symbols,
    dates: x.dates,
    prices: x.prices,
    benchmark: x.benchmark,
    returnMethod: x.returnMethod,
    covMethod: x.covMethod,
    bounds: x.bounds,
    rf: x.rf,
    erp: x.erp,
    initialCapital: x.initialCapital,
    costs: x.costs,
    lots: x.lots,
    useLots: x.useLots,
    cvarConfidence: x.cvarConfidence,
  };
  const noCosts: TradingCosts = {
    ...x.costs,
    commissionPct: 0,
    minCommission: 0,
    vatPct: 0,
    slippageBps: 0,
    sellTaxPct: 0,
  };
  const every = Math.max(1, Math.floor(x.rebalanceEvery));
  const asRecord = (w: number[]) =>
    Object.fromEntries(x.symbols.map((s, i) => [s, w[i]]));

  // ---------------------------------------------------------------- split (train / test)
  let split: ModelComparisonResult["split"] = null;
  const s = Math.floor((T - 1) * Math.min(0.9, Math.max(0.5, x.splitFraction)));
  if (s - 1 < MIN_TRAIN_RETURNS || T - 1 - s < 2) {
    warnings.push(
      `แบ่งช่วงฝึก/ทดสอบไม่ได้: มี ${T} วัน ต้องมีช่วงฝึกอย่างน้อย ${MIN_TRAIN_RETURNS + 1} งวดและช่วงทดสอบอย่างน้อย 2 งวด`,
    );
  } else {
    // Training data: prices 0 … s − 1 (returns ending before the first test trade at s).
    const est = estimateWindow({ ...base }, 0, s - 1);
    const runs: { key: string; r: BacktestResult }[] = [];
    const results: SplitModelResult[] = models.map((model) => {
      const blank = {
        model,
        ok: false,
        weights: {},
        exAnte: null,
        inSample: null,
        outOfSample: null,
        gap: null,
        turnover: null,
        costs: null,
        notes: [] as string[],
      };
      // One decision at s with the whole training part as the window.
      const fit = backtest({
        ...base,
        strategy: model,
        window: s - 1,
        rebalanceEvery: T,
        startIndex: s,
      });
      if (!fit.ok || !fit.weights.length)
        return { ...blank, error: fit.error ?? "ไม่ได้น้ำหนักจากช่วงฝึก" };
      const w = x.symbols.map((sym) => fit.weights[0].target[sym] ?? 0);
      const weights = asRecord(w);
      const invested = w.reduce((a, b) => a + b, 0);
      const expectedReturn = dot(w, est.mu) + (1 - invested) * x.rf;
      const variance = w.reduce(
        (acc, wi, i) => acc + wi * dot(est.cov[i], w),
        0,
      );
      const volatility = Math.sqrt(Math.max(variance, 0));
      const exAnte: ExAnteStats = {
        expectedReturn,
        volatility,
        sharpe:
          volatility > 1e-12 ? (expectedReturn - x.rf) / volatility : null,
      };
      // In-sample fit: the same weights over the training part, before costs (a description of the fit, not a tradable result).
      const fitRun = backtest({
        ...base,
        dates: x.dates.slice(0, s),
        prices: x.prices.map((p) => p.slice(0, s)),
        costs: noCosts,
        useLots: false,
        strategy: "custom",
        weights,
        window: 1,
        rebalanceEvery: every,
        rebalanceCalendar: x.rebalanceCalendar,
      });
      // Out-of-sample: the same weights traded from s, rebalanced back on schedule, after costs.
      const test = backtest({
        ...base,
        strategy: "custom",
        weights,
        window: 1,
        rebalanceEvery: every,
        rebalanceCalendar: x.rebalanceCalendar,
        startIndex: s,
      });
      if (!test.ok)
        return {
          ...blank,
          weights,
          exAnte,
          inSample: fitRun.ok ? realised(fitRun) : null,
          error: test.error,
        };
      runs.push({ key: model, r: test });
      const oos = realised(test);
      return {
        model,
        ok: true,
        weights,
        exAnte,
        inSample: fitRun.ok ? realised(fitRun) : null,
        outOfSample: oos,
        gap: {
          annualReturn:
            oos.annualReturn != null ? oos.annualReturn - expectedReturn : null,
          volatility:
            oos.volatility != null ? oos.volatility - volatility : null,
          sharpe:
            oos.sharpe != null && exAnte.sharpe != null
              ? oos.sharpe - exAnte.sharpe
              : null,
        },
        turnover: test.turnover.total,
        costs: test.costs.total,
        notes: fit.warnings,
      };
    });
    const testObs = T - s;
    if (testObs < MIN_OOS_OBS)
      warnings.push(
        `ช่วงทดสอบ (split) มี ${testObs} งวด น้อยกว่า ${MIN_OOS_OBS} — ตัวเลข Out-of-Sample ผันผวนตามช่วงเวลาสูง ใช้ดูทิศทางเท่านั้น`,
      );
    split = {
      train: { from: x.dates[0], to: x.dates[s - 1], observations: s },
      test: { from: x.dates[s], to: x.dates[T - 1], observations: testObs },
      results,
      curve: curves(runs, x.benchmark, "values", x.initialCapital),
      drawdown: curves(runs, x.benchmark, "drawdown", x.initialCapital),
      ranking: bySharpe(results),
    };
  }

  // ---------------------------------------------------------------- walk-forward
  let walkForward: ModelComparisonResult["walkForward"] = null;
  const W = Math.floor(x.window);
  const start = W + 1;
  if (W < MIN_TRAIN_RETURNS || start >= T - 1) {
    warnings.push(
      `Walk-forward ไม่ได้: ช่วงฝึก ${W} งวด กับข้อมูล ${T} วัน — ต้องมีช่วงฝึกอย่างน้อย ${MIN_TRAIN_RETURNS} งวดและเหลือช่วงทดสอบ`,
    );
  } else {
    const runs: { key: string; r: BacktestResult }[] = [];
    const results: WalkForwardModelResult[] = models.map((model) => {
      // Same first trade date for every model, including the ones that need no window.
      const r = backtest({
        ...base,
        strategy: model,
        window: W,
        rebalanceEvery: every,
        rebalanceCalendar: x.rebalanceCalendar,
        startIndex: start,
      });
      if (!r.ok)
        return {
          model,
          ok: false,
          error: r.error,
          latestWeights: {},
          outOfSample: null,
          rebalances: 0,
          turnoverAnnual: null,
          costs: null,
          notes: [],
        };
      runs.push({ key: model, r });
      return {
        model,
        ok: true,
        latestWeights: r.weights.at(-1)?.target ?? {},
        outOfSample: realised(r),
        rebalances: r.period.rebalances,
        turnoverAnnual: r.turnover.annualized,
        costs: r.costs.total,
        notes: r.warnings,
      };
    });
    const obs = T - start;
    if (obs < MIN_OOS_OBS)
      warnings.push(
        `ช่วงทดสอบ (walk-forward) มี ${obs} งวด น้อยกว่า ${MIN_OOS_OBS} — ใช้ดูทิศทางเท่านั้น`,
      );
    walkForward = {
      window: W,
      test: { from: x.dates[start], to: x.dates[T - 1], observations: obs },
      results,
      curve: curves(runs, x.benchmark, "values", x.initialCapital),
      drawdown: curves(runs, x.benchmark, "drawdown", x.initialCapital),
      ranking: bySharpe(results),
    };
  }

  if (!split && !walkForward)
    return { ok: false, error: warnings.join(" · "), ...empty };
  return {
    ok: true,
    symbols: x.symbols,
    models,
    split,
    walkForward,
    warnings,
    methodology: [
      "ทุกโมเดลใช้หุ้นชุดเดียวกัน ปฏิทินราคาเดียวกัน ขอบเขตน้ำหนัก ต้นทุน และตัวประมาณ μ / Σ เดียวกัน — ต่างกันที่วิธีเลือกน้ำหนักเท่านั้น",
      `แบ่งช่วง: ประมาณ μ (${x.returnMethod}) และ Σ (${x.covMethod}) จากช่วงฝึกครั้งเดียว → น้ำหนักคงที่ → ทดสอบกับช่วงถัดไปที่โมเดลไม่เคยเห็น ปรับกลับสู่น้ำหนักเดิม${x.rebalanceCalendar ? `วันทำการสุดท้ายของทุก${({ monthly: "เดือน", quarterly: "ไตรมาส", semiannual: "ครึ่งปี", annual: "ปี" } as const)[x.rebalanceCalendar]}` : `ทุก ${every} งวด`} หลังหักต้นทุน`,
      "ค่าคาดการณ์ (ex-ante): E[R] = Σ wᵢμᵢ, σ = √(wᵀΣw), Sharpe = (E[R] − Rf) / σ จากช่วงฝึก · In-sample = ผลจริงของน้ำหนักนั้นในช่วงฝึก (ก่อนต้นทุน) · Out-of-Sample = ผลจริงในช่วงทดสอบ",
      `Walk-forward: ทุกรอบปรับพอร์ตประมาณใหม่จาก ${W} งวดล่าสุดที่จบก่อนวันซื้อขาย ทุกโมเดลเริ่มวันเดียวกัน`,
      "ไม่มีข้อมูลอนาคต: การตัดสินใจ ณ วัน t ใช้ราคาถึงวัน t − 1 เท่านั้น · ตัวชี้วัดจาก computeMetrics ตัวเดียวกับหน้าผลการดำเนินงาน",
      "Maximum Drawdown ไม่มีค่าคาดการณ์ล่วงหน้า — แสดงเฉพาะค่าที่เกิดจริงในแต่ละช่วง",
    ],
  };
}
