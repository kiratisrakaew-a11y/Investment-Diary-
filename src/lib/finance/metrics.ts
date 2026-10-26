/** Combines the primitives into the full performance report shown in the app. */
import { annualizeByDates, linkReturns, twrDailyReturns, xirr, type CashFlow, type ValuePoint } from "./returns";
import { annualVolatility, beta as calcBeta, downsideDeviation, expectedShortfall, historicalVaR, maxDrawdown, trackingError } from "./risk";
import { calmar, capmExpectedReturn, informationRatio, jensenAlpha, perPeriodRate, riskPremium, sharpe, sortino, treynor } from "./ratios";
import { TRADING_DAYS, correlation } from "./stats";

export interface PerformanceMetrics {
  startDate: string | null;
  endDate: string | null;
  periods: number;
  /** All rates are decimals (0.05 = 5%). */
  twrCumulative: number;
  twrAnnualized: number;
  mwrXirr: number | null;
  volatility: number;
  downsideDeviation: number;
  maxDrawdown: number;
  var95Daily: number;
  cvar95Daily: number;
  riskFreeRate: number;
  riskPremium: number;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  benchmark: null | {
    symbol: string;
    cumulative: number;
    annualized: number;
    volatility: number;
    beta: number;
    correlation: number;
    capmExpectedReturn: number;
    jensenAlpha: number;
    treynor: number | null;
    trackingError: number;
    informationRatio: number | null;
    marketRiskPremium: number;
  };
  /** Cumulative growth of 1 THB for portfolio (TWR) and benchmark, for charting. */
  growth: { date: string; portfolio: number; benchmark: number | null }[];
}

export function computeMetrics(opts: {
  values: ValuePoint[];
  cashFlows: CashFlow[];
  finalValue: number;
  finalDate: string;
  riskFreeRate: number; // decimal, annual
  benchmark?: { symbol: string; levels: (number | null)[] } | null; // aligned with values
}): PerformanceMetrics {
  const { values, riskFreeRate: rf } = opts;
  // Start measuring from the first day the portfolio has value.
  const startIdx = values.findIndex((v) => v.value > 0);
  const vs = startIdx >= 0 ? values.slice(startIdx) : [];
  const daily = twrDailyReturns(vs);
  const rs = daily.map((d) => d.r);
  const startDate = vs[0]?.date ?? null;
  const endDate = vs[vs.length - 1]?.date ?? null;

  const twrCum = linkReturns(rs);
  const twrAnn = startDate && endDate ? annualizeByDates(twrCum, startDate, endDate) : 0;
  const vol = annualVolatility(rs);
  const dd = downsideDeviation(rs, perPeriodRate(rf, TRADING_DAYS));

  // Growth index from TWR for drawdown + chart.
  // One entry per valuation date (days with no measurable base carry forward).
  const growthIdx: number[] = vs.map(() => 1);
  for (let i = 1; i < vs.length; i++) {
    const base = vs[i - 1].value + vs[i].flow;
    growthIdx[i] = growthIdx[i - 1] * (base > 0 ? vs[i].value / base : 1);
  }
  const mdd = maxDrawdown(growthIdx).maxDrawdown;

  const flows = [...opts.cashFlows];
  if (opts.finalValue > 0) flows.push({ date: opts.finalDate, amount: opts.finalValue });

  let benchmark: PerformanceMetrics["benchmark"] = null;
  let benchGrowth: (number | null)[] = vs.map(() => null);
  if (opts.benchmark && startIdx >= 0) {
    const levels = opts.benchmark.levels.slice(startIdx);
    // Pair portfolio and benchmark returns on days both exist.
    const pr: number[] = [];
    const br: number[] = [];
    for (let i = 1; i < vs.length; i++) {
      const a = levels[i - 1];
      const b = levels[i];
      const base = vs[i - 1].value + vs[i].flow;
      if (a && b && base > 0) {
        pr.push(vs[i].value / base - 1);
        br.push(b / a - 1);
      }
    }
    const first = levels.find((l) => l != null) ?? null;
    benchGrowth = levels.map((l) => (l != null && first ? l / first : null));
    if (br.length >= 2 && first) {
      const last = [...levels].reverse().find((l) => l != null)!;
      const bCum = last / first - 1;
      const bAnn = annualizeByDates(bCum, startDate!, endDate!);
      const b = calcBeta(pr, br);
      const te = trackingError(pr, br);
      benchmark = {
        symbol: opts.benchmark.symbol,
        cumulative: bCum,
        annualized: bAnn,
        volatility: annualVolatility(br),
        beta: b,
        correlation: correlation(pr, br),
        capmExpectedReturn: capmExpectedReturn(rf, b, bAnn),
        jensenAlpha: jensenAlpha(twrAnn, rf, b, bAnn),
        treynor: treynor(twrAnn, rf, b),
        trackingError: te,
        informationRatio: informationRatio(twrAnn, bAnn, te),
        marketRiskPremium: riskPremium(bAnn, rf),
      };
    }
  }

  return {
    startDate,
    endDate,
    periods: rs.length,
    twrCumulative: twrCum,
    twrAnnualized: twrAnn,
    mwrXirr: xirr(flows),
    volatility: vol,
    downsideDeviation: dd,
    maxDrawdown: mdd,
    var95Daily: historicalVaR(rs),
    cvar95Daily: expectedShortfall(rs),
    riskFreeRate: rf,
    riskPremium: riskPremium(twrAnn, rf),
    sharpe: sharpe(twrAnn, rf, vol),
    sortino: sortino(twrAnn, rf, dd),
    calmar: calmar(twrAnn, mdd),
    benchmark,
    growth: vs.map((v, i) => ({ date: v.date, portfolio: growthIdx[i], benchmark: benchGrowth[i] })),
  };
}
