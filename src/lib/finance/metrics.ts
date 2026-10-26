/**
 * Performance report (remediation spec, Phase B).
 *
 * Conventions:
 *  - Returns are time-weighted sub-period returns between valuation dates
 *    (`FlowTiming` decides how external flows are timed).
 *  - Annualization is ACT/365 and only reported as "annualized" for periods of
 *    at least one year; shorter periods show the cumulative return plus a
 *    clearly labelled extrapolated equivalent.
 *  - Risk ratios use *periodic* excess returns: rf_t = (1 + Rf)^(gap/365) − 1
 *    per observation, and N = observations per year measured from the data
 *    (no fixed √252), so Sharpe = mean(r − rf)/σ(r − rf)·√N.
 *  - Benchmark statistics use only intervals between actual benchmark prints
 *    (no forward-filled zero returns); beta/alpha come from an OLS regression
 *    of periodic excess returns.
 */
import { annualizeReturn, daysBetween, periodReturns, xirrDetailed, type CashFlow, type FlowTiming, type ValuePoint, type XirrResult } from "./returns";
import { expectedShortfall, historicalVaR, maxDrawdown, MIN_VAR_OBS } from "./risk";
import { correlation, mean, stdev } from "./stats";

/** Minimum periodic observations before ratios are reported. */
export const MIN_RATIO_OBS = 20;

export interface BenchmarkStats {
  symbol: string;
  kind: "price_index" | "total_return";
  observations: number;
  cumulative: number;
  annualized: number | null;
  annualizedEquivalent: number | null;
  volatility: number | null;
  correlation: number | null;
  /** OLS on periodic excess returns: (rp − rf) = α + β (rm − rf) + ε */
  regressionBeta: number | null;
  betaStdError: number | null;
  regressionAlphaAnnual: number | null;
  alphaStdError: number | null;
  rSquared: number | null;
  /** Conventional CAPM display on annual rates (approximation; labelled in UI). */
  capmExpectedReturn: number | null;
  jensenAlphaApprox: number | null;
  treynor: number | null;
  trackingError: number | null;
  informationRatio: number | null;
  /** Realized market excess return over the period (not a forward-looking ERP). */
  realizedMarketExcessReturn: number | null;
  warnings: string[];
}

export interface PerformanceMetrics {
  startDate: string | null;
  endDate: string | null;
  periodDays: number;
  periods: number;
  observationsPerYear: number | null;
  flowTiming: FlowTiming;
  /** All rates are decimals (0.05 = 5%). */
  cumulativeReturn: number;
  annualizationApplicable: boolean;
  /** Only when the period is ≥ 1 year. */
  annualizedReturn: number | null;
  /** (1 + cumulative)^(365/days) − 1 — extrapolated when the period is shorter than a year. */
  annualizedEquivalent: number | null;
  /** Mean periodic return × N. */
  arithmeticAnnualReturn: number | null;
  displayReturnConvention: "cumulative" | "annualized";
  xirr: XirrResult;
  volatility: number | null;
  downsideDeviation: number | null;
  maxDrawdown: number | null;
  var95: number | null;
  cvar95: number | null;
  varHorizonDays: number | null;
  riskFreeRate: number;
  /** Realized annualized mean excess return over Rf (arithmetic). */
  realizedExcessReturn: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  benchmark: BenchmarkStats | null;
  dataQuality: { observations: number; minRequired: number; status: "ok" | "insufficient"; warnings: string[] };
  /** Cumulative growth of 1 THB for portfolio (TWR) and benchmark, for charting. */
  growth: { date: string; portfolio: number; benchmark: number | null }[];
}

function ols(y: number[], x: number[]) {
  const n = y.length;
  if (n < 3) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  if (!(sxx > 1e-18)) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    sse += (y[i] - a - b * x[i]) ** 2;
    sst += (y[i] - my) ** 2;
  }
  const s2 = sse / (n - 2);
  return {
    alpha: a,
    beta: b,
    seBeta: Math.sqrt(s2 / sxx),
    seAlpha: Math.sqrt(s2 * (1 / n + (mx * mx) / sxx)),
    r2: sst > 0 ? 1 - sse / sst : null,
  };
}

const perPeriodRf = (rf: number, gapDays: number) => (1 + rf) ** (gapDays / 365) - 1;

export function computeMetrics(opts: {
  values: ValuePoint[];
  cashFlows: CashFlow[];
  finalValue: number;
  finalDate: string;
  riskFreeRate: number; // decimal, annual
  flowTiming?: FlowTiming;
  /** Actual benchmark prints (ascending), not forward-filled. */
  benchmark?: { symbol: string; series: [string, number][]; kind: "price_index" | "total_return" } | null;
}): PerformanceMetrics {
  const { riskFreeRate: rf } = opts;
  const timing = opts.flowTiming ?? "start_of_day";
  const warnings: string[] = [];

  // Measure from the first valuation with positive NAV (or a funding flow under end-of-day timing).
  const startIdx = opts.values.findIndex((v) => v.value > 0);
  const vs = startIdx >= 0 ? opts.values.slice(startIdx) : [];
  const { returns: pr, issues } = periodReturns(vs, timing);
  warnings.push(...issues);
  const rs = pr.map((p) => p.r);
  const startDate = vs[0]?.date ?? null;
  const endDate = vs[vs.length - 1]?.date ?? null;
  const periodDays = startDate && endDate ? daysBetween(startDate, endDate) : 0;
  const N = periodDays > 0 && rs.length > 0 ? rs.length / (periodDays / 365) : null;

  // Flow-adjusted wealth index, one entry per valuation date.
  const growthIdx: number[] = vs.map(() => 1);
  const byDate = new Map(pr.map((p) => [p.date, p.r]));
  for (let i = 1; i < vs.length; i++) growthIdx[i] = growthIdx[i - 1] * (1 + (byDate.get(vs[i].date) ?? 0));
  const cumulative = (growthIdx[growthIdx.length - 1] ?? 1) - 1;
  const ann = annualizeReturn(cumulative, periodDays);
  if (!ann.applicable && periodDays > 0) warnings.push(`ช่วงข้อมูล ${periodDays} วัน (< 1 ปี) — แสดงผลตอบแทนสะสม; ค่ารายปีเป็นการ extrapolate`);

  const enough = rs.length >= MIN_RATIO_OBS && N != null;
  if (!enough) warnings.push(`มีข้อมูล ${rs.length} ช่วง (ต้องการอย่างน้อย ${MIN_RATIO_OBS}) — ยังไม่แสดง Sharpe/Sortino/Beta`);
  const ex = pr.map((p) => p.r - perPeriodRf(rf, p.gapDays));
  const sdR = enough ? stdev(rs) : NaN;
  const sdEx = enough ? stdev(ex) : NaN;
  const volatility = enough ? sdR * Math.sqrt(N!) : null;
  const dsd = enough ? Math.sqrt(ex.reduce((a, e) => a + Math.min(0, e) ** 2, 0) / ex.length) * Math.sqrt(N!) : null;
  const meanExAnnual = enough ? mean(ex) * N! : null;
  const mdd = vs.length > 1 ? maxDrawdown(growthIdx).maxDrawdown : null;
  if (rs.length > 0 && rs.length < MIN_VAR_OBS) warnings.push(`VaR/ES ต้องการอย่างน้อย ${MIN_VAR_OBS} ช่วงข้อมูล`);

  // Money-weighted: investor flows + terminal NAV (cash + MTM) once on the valuation date.
  const flows = [...opts.cashFlows];
  if (opts.finalValue > 0) flows.push({ date: opts.finalDate, amount: opts.finalValue });
  const x = xirrDetailed(flows);
  if (x.status === "multiple_roots") warnings.push("XIRR มีหลายคำตอบ — ไม่แสดงค่าเดียว");

  let benchmark: BenchmarkStats | null = null;
  let benchGrowth: (number | null)[] = vs.map(() => null);
  if (opts.benchmark && opts.benchmark.series.length && vs.length) {
    const bmap = new Map(opts.benchmark.series);
    const bw: string[] = [];
    // Pair only valuation dates that have an actual benchmark print.
    const common = vs.map((v, i) => ({ i, d: v.date, b: bmap.get(v.date) })).filter((c): c is { i: number; d: string; b: number } => c.b != null && c.b > 0);
    const p: number[] = [];
    const m: number[] = [];
    const exP: number[] = [];
    const exM: number[] = [];
    for (let k = 1; k < common.length; k++) {
      const a = common[k - 1];
      const b = common[k];
      const rp = growthIdx[b.i] / growthIdx[a.i] - 1;
      const rm = b.b / a.b - 1;
      const rft = perPeriodRf(rf, daysBetween(a.d, b.d));
      p.push(rp);
      m.push(rm);
      exP.push(rp - rft);
      exM.push(rm - rft);
    }
    const first = common[0]?.b;
    benchGrowth = vs.map((v) => {
      const lvl = bmap.get(v.date);
      return lvl != null && first ? lvl / first : null;
    });
    // Carry the last benchmark level across holidays for the chart only.
    for (let i = 1; i < benchGrowth.length; i++) if (benchGrowth[i] == null) benchGrowth[i] = benchGrowth[i - 1];
    if (common.length >= 2) {
      const bDays = daysBetween(common[0].d, common[common.length - 1].d);
      const Nb = bDays > 0 ? p.length / (bDays / 365) : null;
      const bCum = common[common.length - 1].b / common[0].b - 1;
      const bAnn = annualizeReturn(bCum, bDays);
      const ok = p.length >= MIN_RATIO_OBS && Nb != null;
      if (!ok) bw.push(`ข้อมูลเทียบดัชนี ${p.length} ช่วง — ยังไม่พอคำนวณ beta/alpha`);
      const reg = ok ? ols(exP, exM) : null;
      if (ok && !reg) bw.push("ดัชนีอ้างอิงไม่มีความผันผวน — คำนวณ beta ไม่ได้");
      const active = p.map((v, i) => v - m[i]);
      const te = ok ? stdev(active) * Math.sqrt(Nb!) : null;
      const pAnnEq = annualizeReturn(growthIdx[common[common.length - 1].i] / growthIdx[common[0].i] - 1, bDays).equivalent;
      const beta = reg?.beta ?? null;
      const meanExP = ok ? mean(exP) * Nb! : null;
      if (beta != null && beta < 0) bw.push("Beta ติดลบ — Treynor ratio ตีความได้ยาก");
      if (opts.benchmark.kind === "price_index") bw.push(`${opts.benchmark.symbol} เป็นดัชนีราคา (ไม่รวมปันผล) ขณะที่ผลตอบแทนพอร์ตรวมปันผล — การเปรียบเทียบเอียงไปทางพอร์ต`);
      benchmark = {
        symbol: opts.benchmark.symbol,
        kind: opts.benchmark.kind,
        observations: p.length,
        cumulative: bCum,
        annualized: bAnn.annualized,
        annualizedEquivalent: bAnn.equivalent,
        volatility: ok ? stdev(m) * Math.sqrt(Nb!) : null,
        correlation: ok ? correlation(p, m) : null,
        regressionBeta: beta,
        betaStdError: reg?.seBeta ?? null,
        regressionAlphaAnnual: reg ? reg.alpha * Nb! : null,
        alphaStdError: reg ? reg.seAlpha * Nb! : null,
        rSquared: reg?.r2 ?? null,
        capmExpectedReturn: beta != null && bAnn.equivalent != null ? rf + beta * (bAnn.equivalent - rf) : null,
        jensenAlphaApprox: beta != null && bAnn.equivalent != null && pAnnEq != null ? pAnnEq - (rf + beta * (bAnn.equivalent - rf)) : null,
        treynor: beta != null && beta !== 0 && meanExP != null ? meanExP / beta : null,
        trackingError: te,
        informationRatio: te && te > 0 ? (mean(active) * Nb!) / te : null,
        realizedMarketExcessReturn: ok ? mean(exM) * Nb! : null,
        warnings: bw,
      };
    }
  }

  return {
    startDate,
    endDate,
    periodDays,
    periods: rs.length,
    observationsPerYear: N,
    flowTiming: timing,
    cumulativeReturn: cumulative,
    annualizationApplicable: ann.applicable,
    annualizedReturn: ann.annualized,
    annualizedEquivalent: ann.equivalent,
    arithmeticAnnualReturn: enough ? mean(rs) * N! : null,
    displayReturnConvention: ann.applicable ? "annualized" : "cumulative",
    xirr: x,
    volatility,
    downsideDeviation: dsd,
    maxDrawdown: mdd,
    var95: historicalVaR(rs),
    cvar95: expectedShortfall(rs),
    varHorizonDays: N ? 365 / N : null,
    riskFreeRate: rf,
    realizedExcessReturn: meanExAnnual,
    sharpe: enough && sdEx > 0 ? (mean(ex) / sdEx) * Math.sqrt(N!) : null,
    sortino: dsd && dsd > 0 && meanExAnnual != null ? meanExAnnual / dsd : null,
    calmar: ann.annualized != null && mdd && mdd > 0 ? ann.annualized / mdd : null,
    benchmark,
    dataQuality: { observations: rs.length, minRequired: MIN_RATIO_OBS, status: enough ? "ok" : "insufficient", warnings },
    growth: vs.map((v, i) => ({ date: v.date, portfolio: growthIdx[i], benchmark: benchGrowth[i] })),
  };
}
