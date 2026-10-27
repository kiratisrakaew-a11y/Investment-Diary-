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
import { RISK_OBJECTIVES, recommend, type Objective, type RiskObjective } from "./recommend";
import { blackLitterman, type BlView } from "./black-litterman";
import { rebalance, type CostBreakdown, type TradingCosts } from "./rebalance";
import { beta as calcBeta } from "./risk";
import { mean } from "./stats";
import { computeMetrics, type PerformanceMetrics } from "./metrics";
import { alignWithBenchmark } from "./return-series";
import type { DividendStrategyId } from "./dividend-strategies";

export type BacktestStrategy = "buy_and_hold" | "equal_weight" | "min_variance" | "max_sharpe" | "black_litterman" | "custom" | DividendStrategyId | RiskObjective;

/** Target weights chosen by an external strategy using only data known at `cutoff` (the close before the trade date). */
export type DecisionProvider = (ctx: { t: number; cutoff: string; tradeDate: string }) => { w: number[]; note?: string; selected?: string[]; diagnostics?: string[] } | { error: string };

/**
 * Dividend cash events on the tradable (latest-basis, THB) price series. Entitlement on the ex-date
 * from units held at the previous close; cash on the payment date. Never combine with a dividend-adjusted
 * price series (that would credit distributions twice) — the service enforces price_return.
 */
export interface DividendCashflows {
  events: { symbol: string; exDate: string; paymentDate: string; grossPerUnitThb: number; netPerUnitThb: number }[];
  reinvest: boolean;
  assumptions: string[];
}

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
  /** min_cvar: confidence (default 0.95); scenarios are the training-window returns. */
  cvarConfidence?: number;
  /** Required for dividend strategies; ignored by the built-in ones. */
  decisionProvider?: DecisionProvider;
  dividendCashflows?: DividendCashflows;
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
  /** Present when dividend cashflows were simulated. */
  dividends?: {
    gross: number;
    withholding: number;
    netReceived: number;
    receivableAtEnd: number;
    reinvested: number;
    events: number;
    entitledEvents: number;
    incomeReturn: number;
    priceAndOtherReturn: number;
    byYear: { year: string; net: number }[];
  };
  /** Present for provider strategies: what was selected at each decision. */
  decisions?: { date: string; cutoff: string; selected: string[]; diagnostics: string[] }[];
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
  const provider = x.decisionProvider;
  const isProviderStrategy = x.strategy.startsWith("dividend_");
  if (isProviderStrategy && !provider) return fail("กลยุทธ์ปันผลต้องมี decisionProvider");
  const needsWindow = !isProviderStrategy && !["buy_and_hold", "equal_weight", "custom"].includes(x.strategy);
  // First trading index: the window needs `window` returns ending at price index start − 1.
  // Provider strategies decide at t with data up to t − 1, so they start at index 1.
  const start = needsWindow ? x.window + 1 : isProviderStrategy ? 1 : 0;
  if (needsWindow && n < 2) return fail("กลยุทธ์ที่ใช้ optimizer ต้องมีอย่างน้อย 2 สินทรัพย์");
  if (start >= T - 1) return fail(`ข้อมูล ${T} วัน ไม่พอสำหรับช่วงฝึก ${x.window} วัน + ช่วงทดสอบ`);

  // Returns r[i][k] from price k to k+1.
  const R = x.prices.map((p) => p.slice(1).map((v, k) => v / p[k] - 1));
  // Benchmark actual prints only (no forward fill); β uses common actual dates (return-series.ts).
  const benchSeries = x.benchmark?.series.length ? x.benchmark.series : null;
  const yearsPer = (a: number, b: number) => (Date.parse(x.dates[b]) - Date.parse(x.dates[a])) / (365 * 86_400_000);

  /** Target weights decided at index t with data up to price t − 1 only. */
  const decide = (t: number): { w: number[]; note?: string; selected?: string[]; diagnostics?: string[] } | { error: string } => {
    if (isProviderStrategy) return provider!({ t, cutoff: x.dates[t - 1], tradeDate: x.dates[t] });
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
    if (x.returnMethod !== "historical" && benchSeries) {
      // Window prices k0 … k1 (= t − 1): data strictly before the trade date.
      const wDates = x.dates.slice(k0, k1 + 1);
      const capm = win.map((_, i) => {
        const al = alignWithBenchmark(wDates.map((d, k) => [d, x.prices[i][k0 + k]] as [string, number]), benchSeries.filter(([d]) => d <= x.dates[k1]), wDates);
        const be = al.dates.length > 2 ? calcBeta(al.asset, al.benchmark) : null;
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
    const isRisk = (RISK_OBJECTIVES as string[]).includes(x.strategy);
    const objective: Objective = isRisk ? (x.strategy as RiskObjective) : x.strategy === "min_variance" ? "min_variance" : "max_sharpe";
    const r = recommend({
      symbols: x.symbols,
      mu,
      cov,
      rf: x.rf,
      bounds: x.bounds,
      objective,
      riskAversion: 4,
      useRiskFree: false,
      // Risk-based: the same training window (returns ending before t) as the scenario set.
      ...(objective === "min_cvar" ? { scenarios: win, cvarConfidence: x.cvarConfidence ?? 0.95 } : {}),
    });
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
  const decisions: NonNullable<BacktestResult["decisions"]> = [];

  // Dividend cashflows: index of the first trading date on/after the ex-date and the payment date.
  const firstIdx = (d: string) => {
    let lo = 0;
    let hi = T;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (x.dates[m] < d) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const symIdx = new Map(x.symbols.map((s, i) => [s, i]));
  const divEvents = (x.dividendCashflows?.events ?? [])
    .map((e) => ({ ...e, i: symIdx.get(e.symbol) ?? -1, exIdx: firstIdx(e.exDate), payIdx: firstIdx(e.paymentDate) }))
    .filter((e) => e.i >= 0 && e.exIdx > start && e.exIdx < T);
  const exAt = new Map<number, typeof divEvents>();
  for (const e of divEvents) exAt.set(e.exIdx, [...(exAt.get(e.exIdx) ?? []), e]);
  let receivables: { payIdx: number; net: number; gross: number; year: string }[] = [];
  const div = { gross: 0, withholding: 0, netReceived: 0, reinvested: 0, entitled: 0 };
  const divByYear = new Map<string, number>();
  let lastTarget: number[] | null = null;

  for (let t = start; t < T; t++) {
    if (t > start) cash *= (1 + x.rf) ** (Math.max(0, Date.parse(x.dates[t]) - Date.parse(x.dates[t - 1])) / (365 * 86_400_000));
    // Entitlement: units held at the previous close (before any trade on the ex-date).
    for (const e of exAt.get(t) ?? []) {
      if (!(q[e.i] > 0)) continue;
      div.entitled++;
      receivables.push({ payIdx: e.payIdx, net: q[e.i] * e.netPerUnitThb, gross: q[e.i] * e.grossPerUnitThb, year: e.paymentDate.slice(0, 4) });
    }
    // Payment: receivable → cash; optional reinvestment toward the last target (buys only).
    const due = receivables.filter((r) => r.payIdx <= t);
    if (due.length) {
      receivables = receivables.filter((r) => r.payIdx > t);
      const paid = due.reduce((a, r) => a + r.net, 0);
      cash += paid;
      div.netReceived += paid;
      div.gross += due.reduce((a, r) => a + r.gross, 0);
      div.withholding += due.reduce((a, r) => a + r.gross - r.net, 0);
      for (const r of due) divByYear.set(r.year, (divByYear.get(r.year) ?? 0) + r.net);
      if (x.dividendCashflows?.reinvest && lastTarget && !isRebal.has(t)) {
        const rr = rebalance({
          assets: x.symbols.map((s, i) => ({ symbol: s, price: x.prices[i][t], quantity: q[i], lot: x.useLots ? (x.lots[s] ?? 1) : 1e-6, target: lastTarget![i] })),
          cash,
          extraCash: 0,
          cashReserve: 0,
          costs: x.costs,
          objective: "track",
          noTradeBand: 0,
          allowSell: false,
          cov: null,
          fractional: !x.useLots,
        });
        if (rr.ok) {
          for (const tr of rr.trades) {
            if (tr.side !== "buy") continue;
            trades.push({ date: x.dates[t], symbol: tr.symbol, side: tr.side, quantity: tr.quantity, price: tr.price ?? 0, value: tr.value, cost: tr.cost.total });
            costSum = addCost(costSum, tr.cost);
            traded += tr.value;
            div.reinvested += tr.value;
          }
          q = rr.trades.map((tr) => tr.finalQuantity);
          cash = rr.cash.end;
        }
      }
    }
    if (isRebal.has(t)) {
      const d = decide(t);
      if ("error" in d) return fail(`${x.dates[t]}: ${d.error}`);
      if (d.note) notes.set(d.note, (notes.get(d.note) ?? 0) + 1);
      if (isProviderStrategy) decisions.push({ date: x.dates[t], cutoff: x.dates[t - 1], selected: d.selected ?? x.symbols.filter((_, i) => d.w[i] > 0), diagnostics: d.diagnostics ?? [] });
      lastTarget = d.w;
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
        fractional: !x.useLots,
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
    // NAV includes dividends receivable (entitled on the ex-date, not yet paid).
    values.push({ date: x.dates[t], value: q.reduce((s, qi, i) => s + qi * x.prices[i][t], 0) + cash + receivables.reduce((a, r) => a + r.net, 0) });
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
  const totalReturn = finalValue / x.initialCapital - 1;
  const receivableAtEnd = receivables.reduce((a, r) => a + r.net, 0);
  const dividends = x.dividendCashflows
    ? {
        gross: div.gross,
        withholding: div.withholding,
        netReceived: div.netReceived,
        receivableAtEnd,
        reinvested: div.reinvested,
        events: divEvents.length,
        entitledEvents: div.entitled,
        incomeReturn: (div.netReceived + receivableAtEnd) / x.initialCapital,
        priceAndOtherReturn: totalReturn - (div.netReceived + receivableAtEnd) / x.initialCapital,
        byYear: [...divByYear.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, net]) => ({ year, net })),
      }
    : undefined;
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
      isProviderStrategy
        ? `ปันผล (${x.strategy}): ณ วันปรับพอร์ต t คัดเลือกด้วยข้อมูลที่รู้ ณ สิ้นวัน t − 1 เท่านั้น (เหตุการณ์ปันผลที่ ex-date ผ่านแล้วหรือประกาศแล้ว, งบที่เผยแพร่แล้ว, ราคาถึง t − 1) → ซื้อขายที่ราคาปิดวัน t`
        : needsWindow
        ? `Walk-forward: ณ วันปรับพอร์ต t ใช้ผลตอบแทน ${x.window} งวดล่าสุดที่จบก่อนวัน t (ไม่มีข้อมูลอนาคต) → ประมาณ μ (${x.returnMethod}${x.strategy === "black_litterman" ? " → Black–Litterman" : ""}) และ Σ (${x.covMethod}) → optimizer เดิม (QP) → ซื้อขายที่ราคาปิดวัน t`
        : x.strategy === "buy_and_hold"
          ? "Buy and hold: ซื้อตามน้ำหนักเริ่มต้นครั้งเดียว ไม่ปรับพอร์ต"
          : "ปรับกลับสู่น้ำหนักเป้าหมายทุกรอบ ที่ราคาปิดวันปรับพอร์ต",
      `ปรับพอร์ตทุก ${x.rebalanceEvery} งวด · ระหว่างรอบถือจำนวนหน่วยเท่าเดิม (น้ำหนักลอยตามราคา) · เงินสดได้ Rf ${(x.rf * 100).toFixed(2)}%`,
      `ต้นทุนตาม cost model (ค่าคอม/VAT/slippage/ภาษีขาย) ${x.useLots ? "และ lot จริง" : "ซื้อเศษหน่วยได้ (ไม่ปัด lot)"}`,
      "ตัวชี้วัดจาก computeMetrics ตัวเดียวกับหน้าผลการดำเนินงาน",
      ...(x.dividendCashflows
        ? [
            "ปันผลเป็นกระแสเงินสด: สิทธิ์ ณ ex-date จากจำนวนหน่วยที่ถือ ณ ปิดวันก่อนหน้า (ซื้อวัน XD ไม่ได้สิทธิ์) → เงินเข้าวันจ่าย; ระหว่างนั้นนับเป็นลูกหนี้ใน NAV",
            x.dividendCashflows.reinvest ? "นำปันผลไปซื้อเพิ่มตามน้ำหนักเป้าหมายล่าสุด (ซื้ออย่างเดียว มีต้นทุนซื้อขาย)" : "ปันผลพักเป็นเงินสด (ได้ Rf) จนถึงรอบปรับพอร์ตถัดไป",
            "ราคาที่ใช้เป็นราคาปิดซื้อขายได้ (ไม่ปรับปันผล) จึงไม่นับปันผลซ้ำ",
            ...x.dividendCashflows.assumptions,
          ]
        : []),
    ],
    warnings,
    ...(dividends ? { dividends } : {}),
    ...(isProviderStrategy ? { decisions } : {}),
  };
}

/** One economic treatment of dividends: a dividend-adjusted (total-return) price series must not also receive cash events. */
export function assertSingleDividendTreatment(returnBasis: "price_return" | "total_return", cashflows: boolean) {
  if (returnBasis === "total_return" && cashflows) {
    throw new Error("ราคาปรับปันผล (total_return) รวมปันผลไว้แล้ว — ใช้ร่วมกับกระแสเงินสดปันผลไม่ได้ (จะนับซ้ำ) ใช้ price_return + เหตุการณ์ปันผลแทน");
  }
}
