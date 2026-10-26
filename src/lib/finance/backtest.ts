/**
 * Walk-forward portfolio backtest (Roadmap Phase 5). No new optimizer, cost model or metric:
 *  - weights: `recommend` (QP), `blackLitterman`, equal / custom weights
 *  - estimation: `estimateInputs` / `ledoitWolf`, CAPM β via `beta`
 *  - trades and costs: `rebalance` (whole lots optional, commission/VAT/slippage/sell tax)
 *  - performance: `computeMetrics` (TWR, CAGR, vol, Sharpe, Sortino, MDD, β, α, TE, IR)
 *
 * No look-ahead: at rebalance index t the estimation window uses returns that end at price
 * index t − 1 (prices known before day t); trades execute at the close of day t.
 * Between rebalances quantities are fixed (weights drift); idle cash accrues Rf.
 */
import { estimateInputs, ledoitWolf, type Matrix } from "./mpt";
import { recommend, type Objective } from "./recommend";
import { blackLitterman, type BlView } from "./black-litterman";
import { rebalance, type CostBreakdown, type TradingCosts } from "./rebalance";
import { beta as calcBeta } from "./risk";
import { mean } from "./stats";
import { computeMetrics, type PerformanceMetrics } from "./metrics";

export type BacktestStrategy = "buy_and_hold" | "equal_weight" | "min_variance" | "max_sharpe" | "black_litterman" | "custom";

export interface BacktestInput {
  symbols: string[];
  /** Common calendar: every asset has an actual price on every date. */
  dates: string[];
  /** THB price per unit, prices[i][t] aligned with dates. */
  prices: number[][];
  /** Benchmark prints (ascending), used for β estimation and comparison. */
  benchmark: { symbol: string; series: [string, number][]; kind: "price_index" | "total_return" } | null;
  strategy: BacktestStrategy;
  /** Custom / buy-and-hold initial weights by symbol (decimal; remainder = cash). */
  weights?: Record<string, number>;
  blackLitterman?: { marketWeights: Record<string, number>; views?: BlView[]; tau?: number; marketRiskAversion?: number };
  returnMethod: "historical" | "capm" | "blend";
  covMethod: "sample" | "ledoit_wolf";
  /** Training window in return observations. */
  window: number;
  /** Rebalance every k observations (≥ 1). */
  rebalanceEvery: number;
  bounds: { min: number; max: number };
  rf: number;
  erp: number;
  initialCapital: number;
  costs: TradingCosts;
  lots: Record<string, number>;
  useLots: boolean;
}

export interface BacktestResult {
  ok: boolean;
  error?: string;
  strategy: BacktestStrategy;
  period: { from: string; to: string; observations: number; rebalances: number };
  values: { date: string; value: number }[];
  drawdown: { date: string; drawdown: number }[];
  weights: { date: string; target: Record<string, number>; actual: Record<string, number>; cash: number }[];
  trades: { date: string; symbol: string; side: "buy" | "sell"; quantity: number; price: number; value: number; cost: number }[];
  costs: { commission: number; vat: number; slippage: number; tax: number; total: number; shareOfInitial: number };
  turnover: { total: number; annualized: number | null; perRebalance: number };
  metrics: PerformanceMetrics;
  methodology: string[];
  warnings: string[];
}

const addCost = (a: CostBreakdown, b: CostBreakdown): CostBreakdown => ({
  commission: a.commission + b.commission,
  vat: a.vat + b.vat,
  slippage: a.slippage + b.slippage,
  tax: a.tax + b.tax,
  total: a.total + b.total,
});

export function backtest(x: BacktestInput): BacktestResult {
  const n = x.symbols.length;
  const T = x.dates.length;
  const warnings: string[] = [];
  const fail = (error: string) => ({ ok: false, error }) as BacktestResult;
  if (n < 1) return fail("ต้องมีอย่างน้อย 1 สินทรัพย์");
  if (x.prices.some((p) => p.length !== T || p.some((v) => !(v > 0)))) return fail("ราคาไม่ครบหรือไม่ถูกต้องในบางวัน");
  const needsWindow = !["buy_and_hold", "equal_weight", "custom"].includes(x.strategy);
  // First trading index: the window needs `window` returns ending at price index start − 1.
  const start = needsWindow ? x.window + 1 : 0;
  if (needsWindow && n < 2) return fail("กลยุทธ์ที่ใช้ optimizer ต้องมีอย่างน้อย 2 สินทรัพย์");
  if (start >= T - 1) return fail(`ข้อมูล ${T} วัน ไม่พอสำหรับช่วงฝึก ${x.window} วัน + ช่วงทดสอบ`);

  // Returns r[i][k] from price k to k+1.
  const R = x.prices.map((p) => p.slice(1).map((v, k) => v / p[k] - 1));
  const benchAt = (() => {
    if (!x.benchmark?.series.length) return null;
    const s = x.benchmark.series;
    let j = 0;
    return x.dates.map((d) => {
      while (j + 1 < s.length && s[j + 1][0] <= d) j++;
      return s[j][0] <= d ? s[j][1] : null;
    });
  })();
  const yearsPer = (a: number, b: number) => (Date.parse(x.dates[b]) - Date.parse(x.dates[a])) / (365 * 86_400_000);

  /** Target weights decided at index t with data up to price t − 1 only. */
  const decide = (t: number): { w: number[]; note?: string } | { error: string } => {
    if (x.strategy === "equal_weight") return { w: Array(n).fill(1 / n) };
    if (x.strategy === "custom" || x.strategy === "buy_and_hold") {
      const given = x.weights ? x.symbols.map((s) => x.weights![s] ?? x.weights![s.toUpperCase()] ?? 0) : Array(n).fill(1 / n);
      return { w: given };
    }
    // Window: returns k = t−1−window … t−2 (ending at price index t − 1).
    const k1 = t - 1;
    const k0 = k1 - x.window;
    if (k0 < 0) return { error: "window" };
    const win = R.map((r) => r.slice(k0, k1));
    const years = yearsPer(k0, k1);
    const N = years > 0 ? x.window / years : 252;
    const cov: Matrix = x.covMethod === "ledoit_wolf" ? ledoitWolf(win).cov.map((r) => r.map((v) => v * N)) : estimateInputs(win, N).cov;
    const hist = win.map((r) => mean(r) * N);
    let mu = hist;
    if (x.returnMethod !== "historical" && benchAt) {
      const b = Array.from({ length: x.window }, (_, k) => {
        const a0 = benchAt[k0 + k];
        const a1 = benchAt[k0 + k + 1];
        return a0 && a1 ? a1 / a0 - 1 : NaN;
      });
      const capm = win.map((r, i) => {
        const be = b.every(Number.isFinite) ? calcBeta(r, b) : null;
        return be != null ? x.rf + be * x.erp : hist[i];
      });
      mu = x.returnMethod === "capm" ? capm : hist.map((h, i) => 0.5 * h + 0.5 * capm[i]);
    }
    if (x.strategy === "black_litterman") {
      if (!x.blackLitterman) return { error: "Black–Litterman ต้องมี marketWeights" };
      const bl = blackLitterman({
        symbols: x.symbols,
        cov,
        rf: x.rf,
        marketWeights: x.blackLitterman.marketWeights,
        riskAversion: x.blackLitterman.marketRiskAversion,
        marketPremium: x.erp,
        tau: x.blackLitterman.tau ?? 0.05,
        views: x.blackLitterman.views ?? [],
      });
      if (!bl.ok) return { error: bl.errors.join(" · ") };
      mu = bl.posterior;
    }
    const objective: Objective = x.strategy === "min_variance" ? "min_variance" : "max_sharpe";
    const r = recommend({ symbols: x.symbols, mu, cov, rf: x.rf, bounds: x.bounds, objective, riskAversion: 4, useRiskFree: false });
    if (!r.ok) {
      // No tangency portfolio in this window: fall back to minimum variance (disclosed).
      if (objective === "max_sharpe") {
        const g = recommend({ symbols: x.symbols, mu, cov, rf: x.rf, bounds: x.bounds, objective: "min_variance", riskAversion: 4, useRiskFree: false });
        if (g.ok) return { w: g.risky.weights, note: `ไม่มีพอร์ตที่ผลตอบแทนคาดหวังเกิน Rf — ใช้ minimum variance แทน` };
      }
      return { error: r.issue.message };
    }
    return { w: r.risky.weights };
  };

  const rebalanceIdx: number[] = [];
  if (x.strategy === "buy_and_hold") rebalanceIdx.push(start);
  else for (let t = start; t < T; t += Math.max(1, x.rebalanceEvery)) rebalanceIdx.push(t);
  const isRebal = new Set(rebalanceIdx);

  let q = Array(n).fill(0);
  let cash = x.initialCapital;
  let costSum: CostBreakdown = { commission: 0, vat: 0, slippage: 0, tax: 0, total: 0 };
  let traded = 0;
  const values: { date: string; value: number }[] = [];
  const weights: BacktestResult["weights"] = [];
  const trades: BacktestResult["trades"] = [];
  const notes = new Map<string, number>();

  for (let t = start; t < T; t++) {
    if (t > start) cash *= (1 + x.rf) ** (Math.max(0, Date.parse(x.dates[t]) - Date.parse(x.dates[t - 1])) / (365 * 86_400_000));
    if (isRebal.has(t)) {
      const d = decide(t);
      if ("error" in d) return fail(`${x.dates[t]}: ${d.error}`);
      if (d.note) notes.set(d.note, (notes.get(d.note) ?? 0) + 1);
      const r = rebalance({
        assets: x.symbols.map((s, i) => ({ symbol: s, price: x.prices[i][t], quantity: q[i], lot: x.useLots ? (x.lots[s] ?? 1) : 1e-6, target: d.w[i] })),
        cash,
        extraCash: 0,
        cashReserve: 0,
        costs: x.costs,
        objective: "track",
        noTradeBand: 0,
        allowSell: true,
        cov: null,
      });
      if (!r.ok) return fail(`${x.dates[t]}: ${r.violations.join(" · ")}`);
      for (const tr of r.trades) {
        if (tr.side === "hold") continue;
        trades.push({ date: x.dates[t], symbol: tr.symbol, side: tr.side, quantity: tr.quantity, price: tr.price ?? 0, value: tr.value, cost: tr.cost.total });
        costSum = addCost(costSum, tr.cost);
        traded += tr.value;
      }
      q = r.trades.map((tr) => tr.finalQuantity);
      cash = r.cash.end;
      const nav = q.reduce((s, qi, i) => s + qi * x.prices[i][t], 0) + cash;
      weights.push({
        date: x.dates[t],
        target: Object.fromEntries(x.symbols.map((s, i) => [s, d.w[i]])),
        actual: Object.fromEntries(x.symbols.map((s, i) => [s, (q[i] * x.prices[i][t]) / nav])),
        cash: cash / nav,
      });
    }
    values.push({ date: x.dates[t], value: q.reduce((s, qi, i) => s + qi * x.prices[i][t], 0) + cash });
  }

  const from = x.dates[start];
  const to = x.dates[T - 1];
  const finalValue = values[values.length - 1].value;
  // Capital is funded at the previous close, so first-day trading costs count against performance.
  const series =
    start > 0
      ? [{ date: x.dates[start - 1], value: x.initialCapital, flow: x.initialCapital }, ...values.map((v) => ({ ...v, flow: 0 }))]
      : values.map((v, i) => ({ ...v, flow: i === 0 ? x.initialCapital : 0 }));
  const metrics = computeMetrics({
    values: series,
    cashFlows: [{ date: series[0].date, amount: -x.initialCapital }],
    finalValue,
    finalDate: to,
    riskFreeRate: x.rf,
    flowTiming: "start_of_day",
    benchmark: x.benchmark ? { ...x.benchmark, series: x.benchmark.series.filter(([d]) => d >= from && d <= to) } : null,
  });
  let peak = -Infinity;
  const drawdown = values.map((v) => {
    peak = Math.max(peak, v.value);
    return { date: v.date, drawdown: v.value / peak - 1 };
  });
  const years = yearsPer(start, T - 1);
  for (const [k, c] of notes) warnings.push(`${k} (${c} ครั้ง)`);
  return {
    ok: true,
    strategy: x.strategy,
    period: { from, to, observations: T - start, rebalances: rebalanceIdx.length },
    values,
    drawdown,
    weights,
    trades,
    costs: { ...costSum, shareOfInitial: costSum.total / x.initialCapital },
    turnover: { total: traded / x.initialCapital, annualized: years > 0 ? traded / x.initialCapital / years : null, perRebalance: rebalanceIdx.length ? traded / x.initialCapital / rebalanceIdx.length : 0 },
    metrics,
    methodology: [
      needsWindow
        ? `Walk-forward: ณ วันปรับพอร์ต t ใช้ผลตอบแทน ${x.window} งวดล่าสุดที่จบก่อนวัน t (ไม่มีข้อมูลอนาคต) → ประมาณ μ (${x.returnMethod}${x.strategy === "black_litterman" ? " → Black–Litterman" : ""}) และ Σ (${x.covMethod}) → optimizer เดิม (QP) → ซื้อขายที่ราคาปิดวัน t`
        : x.strategy === "buy_and_hold"
          ? "Buy and hold: ซื้อตามน้ำหนักเริ่มต้นครั้งเดียว ไม่ปรับพอร์ต"
          : "ปรับกลับสู่น้ำหนักเป้าหมายทุกรอบ ที่ราคาปิดวันปรับพอร์ต",
      `ปรับพอร์ตทุก ${x.rebalanceEvery} งวด · ระหว่างรอบถือจำนวนหน่วยเท่าเดิม (น้ำหนักลอยตามราคา) · เงินสดได้ Rf ${(x.rf * 100).toFixed(2)}%`,
      `ต้นทุนตาม cost model (ค่าคอม/VAT/slippage/ภาษีขาย) ${x.useLots ? "และ lot จริง" : "ซื้อเศษหน่วยได้ (ไม่ปัด lot)"}`,
      "ตัวชี้วัดจาก computeMetrics ตัวเดียวกับหน้าผลการดำเนินงาน",
    ],
    warnings,
  };
}
