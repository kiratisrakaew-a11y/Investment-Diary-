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
import { backtestVaR, horizonVarTable, varTable, type HorizonVarRow, type VarBacktest, type VarRow } from "./var-backtesting";
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

export interface RiskSample {
  /** synchronized = only dates where every held position has an actual price. */
  basis: "all_dates" | "synchronized" | "all_dates_with_carried_prices";
  observations: number;
  /** Valuation dates where at least one held position used an earlier price. */
  carriedDates: number;
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
  /** Historical VaR / ES at 95% and 99% with sample size, minimum-observation policy and reliability. */
  varTable: VarRow[];
  /** Historical VaR / ES at 1 period … 5 years from compounded returns (unavailable when history is too short). */
  varHorizons: HorizonVarRow[];
  /** Rolling out-of-sample coverage backtests (Kupiec / Christoffersen); unavailable on short samples. */
  varBacktest: (VarBacktest | { confidence: number; unavailable: string })[];
  riskFreeRate: number;
  /** Realized annualized mean excess return over Rf (arithmetic). */
  realizedExcessReturn: number | null;
  sharpe: number | null;
  sortino: number | null;
  /** Minimum acceptable return used by Sortino and the downside deviation (annual). */
  sortinoMar: number;
  sortinoMarBasis: "risk_free" | "custom";
  calmar: number | null;
  benchmark: BenchmarkStats | null;
  dataQuality: { observations: number; minRequired: number; status: "ok" | "insufficient"; warnings: string[] };
  riskSample: RiskSample;
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
  /** Sortino minimum acceptable return (annual decimal); omitted / null = the risk-free rate. */
  sortinoMar?: number | null;
  flowTiming?: FlowTiming;
  /**
   * Dates on which every held position has an actual price (no carried price). When given, risk
   * statistics (σ, downside, Sharpe, Sortino, VaR / ES, backtests) use returns of the wealth index
   * between these dates; TWR, CAGR, XIRR and drawdown are unaffected.
   */
  riskDates?: string[];
  /** Actual benchmark prints (ascending), not forward-filled. */
  benchmark?: { symbol: string; series: [string, number][]; kind: "price_index" | "total_return" } | null;
}): PerformanceMetrics {
  const { riskFreeRate: rf } = opts;
  const timing = opts.flowTiming ?? "start_of_day";
  const warnings: string[] = [];

  // Measure from the first valuation with positive NAV (or a funding flow under end-of-day timing).
  const startIdx = opts.values.findIndex((v) => v.value > 0);
  const vs = startIdx >= 0 ? opts.values.slice(startIdx) : [];
  const { returns: allPr, issues } = periodReturns(vs, timing);
  warnings.push(...issues);
  const startDate = vs[0]?.date ?? null;
  const endDate = vs[vs.length - 1]?.date ?? null;
  const periodDays = startDate && endDate ? daysBetween(startDate, endDate) : 0;

  // Flow-adjusted wealth index, one entry per valuation date.
  const growthIdx: number[] = vs.map(() => 1);
  const byDate = new Map(allPr.map((p) => [p.date, p.r]));
  for (let i = 1; i < vs.length; i++) growthIdx[i] = growthIdx[i - 1] * (1 + (byDate.get(vs[i].date) ?? 0));

  // Risk sample: synchronised dates when some valuation dates carry an earlier price (e.g. a Thai
  // holiday that is a US trading day), so carried prices do not create artificial 0% periods.
  let pr = allPr;
  let riskBasis: RiskSample["basis"] = "all_dates";
  let carriedDates = 0;
  let riskSpan = periodDays;
  if (opts.riskDates) {
    const keep = new Set(opts.riskDates);
    const idx = vs.map((v, i) => (keep.has(v.date) ? i : -1)).filter((i) => i >= 0);
    carriedDates = vs.length - idx.length;
    if (carriedDates > 0) {
      const sync = idx.slice(1).map((b, k) => ({ date: vs[b].date, r: growthIdx[b] / growthIdx[idx[k]] - 1, gapDays: daysBetween(vs[idx[k]].date, vs[b].date) }));
      if (sync.length >= MIN_RATIO_OBS && sync.length >= 0.5 * allPr.length) {
        pr = sync;
        riskBasis = "synchronized";
        riskSpan = daysBetween(vs[idx[0]].date, vs[idx[idx.length - 1]].date);
        warnings.push(`${carriedDates} วันประเมินมีบางสินทรัพย์ใช้ราคาวันก่อน — ค่าความเสี่ยงคำนวณจาก ${sync.length} ช่วงที่ทุกสินทรัพย์มีราคาจริง (TWR/XIRR ไม่เปลี่ยน)`);
      } else {
        riskBasis = "all_dates_with_carried_prices";
        warnings.push(`${carriedDates} วันประเมินใช้ราคาวันก่อนของบางสินทรัพย์ และช่วงที่ทุกสินทรัพย์มีราคาจริงมีน้อยเกินไป (${sync.length}) — ค่าความเสี่ยงใช้ทุกวันซึ่งมีผลตอบแทน 0% เทียมปนอยู่ ความผันผวนและ VaR อาจคลาดเคลื่อน`);
      }
    }
  }
  const rs = pr.map((p) => p.r);
  const N = riskSpan > 0 && rs.length > 0 ? rs.length / (riskSpan / 365) : null;
  const cumulative = (growthIdx[growthIdx.length - 1] ?? 1) - 1;
  const ann = annualizeReturn(cumulative, periodDays);
  if (!ann.applicable && periodDays > 0) warnings.push(`ช่วงข้อมูล ${periodDays} วัน (< 1 ปี) — แสดงผลตอบแทนสะสม; ค่ารายปีเป็นการ extrapolate`);

  const enough = rs.length >= MIN_RATIO_OBS && N != null;
  if (!enough) warnings.push(`มีข้อมูล ${rs.length} ช่วง (ต้องการอย่างน้อย ${MIN_RATIO_OBS}) — ยังไม่แสดง Sharpe/Sortino/Beta`);
  const ex = pr.map((p) => p.r - perPeriodRf(rf, p.gapDays));
  const sdR = enough ? stdev(rs) : NaN;
  const sdEx = enough ? stdev(ex) : NaN;
  const volatility = enough ? sdR * Math.sqrt(N!) : null;
  // Sortino: shortfall below the minimum acceptable return (per period, compounded from the annual MAR).
  const mar = opts.sortinoMar ?? rf;
  const belowMar = opts.sortinoMar == null ? ex : pr.map((p) => p.r - perPeriodRf(mar, p.gapDays));
  const dsd = enough ? Math.sqrt(belowMar.reduce((a, e) => a + Math.min(0, e) ** 2, 0) / belowMar.length) * Math.sqrt(N!) : null;
  const meanBelowMarAnnual = enough ? mean(belowMar) * N! : null;
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
    varTable: varTable(rs),
    varHorizons: horizonVarTable(rs, N),
    varBacktest: [0.95, 0.99].map((c) => {
      const b = backtestVaR(rs, c, 250, pr.map((p) => p.date));
      return "unavailable" in b ? { confidence: c, unavailable: b.unavailable } : b;
    }),
    riskFreeRate: rf,
    realizedExcessReturn: meanExAnnual,
    sharpe: enough && sdEx > 0 ? (mean(ex) / sdEx) * Math.sqrt(N!) : null,
    sortino: dsd && dsd > 0 && meanBelowMarAnnual != null ? meanBelowMarAnnual / dsd : null,
    sortinoMar: mar,
    sortinoMarBasis: opts.sortinoMar == null ? "risk_free" : "custom",
    calmar: ann.annualized != null && mdd && mdd > 0 ? ann.annualized / mdd : null,
    benchmark,
    dataQuality: { observations: rs.length, minRequired: MIN_RATIO_OBS, status: enough ? "ok" : "insufficient", warnings },
    riskSample: { basis: riskBasis, observations: rs.length, carriedDates },
    growth: vs.map((v, i) => ({ date: v.date, portfolio: growthIdx[i], benchmark: benchGrowth[i] })),
  };
}
