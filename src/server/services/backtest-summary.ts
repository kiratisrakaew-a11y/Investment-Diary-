import type { backtestPortfolio } from "./backtest";

type Full = Awaited<ReturnType<typeof backtestPortfolio>>;

/** Compact result for AI tools: summary metrics, costs, month-end equity curve and the latest weights. */
export function summarizeBacktest(r: Full) {
  const m = r.metrics;
  const monthEnd = r.values.filter(
    (v, i) =>
      i === r.values.length - 1 ||
      r.values[i + 1].date.slice(0, 7) !== v.date.slice(0, 7),
  );
  return {
    strategy: r.strategy,
    period: r.period,
    universe: r.universe,
    excluded: r.excluded,
    benchmark: r.benchmark,
    returnBasisByAsset: r.returnBasisByAsset,
    priceBasis: r.priceBasis,
    windowInfo: r.windowInfo,
    riskFreeInfo: r.riskFreeInfo && {
      rate: r.riskFreeInfo.rate,
      source: r.riskFreeInfo.source,
      label: r.riskFreeInfo.label,
      asOf: r.riskFreeInfo.asOf,
    },
    ...(r.assumedPaymentDates
      ? { assumedPaymentDates: r.assumedPaymentDates }
      : {}),
    ...(r.dividends
      ? {
          dividends: {
            netReceived: r.dividends.netReceived,
            events: r.dividends.events,
            entitledEvents: r.dividends.entitledEvents,
            incomeReturn: r.dividends.incomeReturn,
            uncredited: r.dividends.uncredited,
          },
        }
      : {}),
    performance: {
      cumulativeReturn: m.cumulativeReturn,
      annualizedReturn: m.annualizedReturn,
      annualizedEquivalent: m.annualizedEquivalent,
      volatility: m.volatility,
      sharpe: m.sharpe,
      sortino: m.sortino,
      maxDrawdown: m.maxDrawdown,
      calmar: m.calmar,
      xirr: m.xirr.rate,
      benchmark: m.benchmark && {
        symbol: m.benchmark.symbol,
        cumulative: m.benchmark.cumulative,
        annualized: m.benchmark.annualized,
        beta: m.benchmark.regressionBeta,
        alphaAnnual: m.benchmark.regressionAlphaAnnual,
        trackingError: m.benchmark.trackingError,
        informationRatio: m.benchmark.informationRatio,
      },
      warnings: m.dataQuality.warnings,
    },
    costs: r.costs,
    turnover: r.turnover,
    trades: r.trades.length,
    latestWeights: r.weights.at(-1) ?? null,
    // Every rebalance (BT-8): target / after-trade weights rounded to 0.01%, turnover, cost, why skipped.
    rebalanceLog: r.rebalanceLog.map((x) => ({
      date: x.date,
      target:
        x.target &&
        Object.fromEntries(
          Object.entries(x.target).map(([k, v]) => [
            k,
            Math.round(v * 10_000) / 10_000,
          ]),
        ),
      actual: Object.fromEntries(
        Object.entries(x.actual).map(([k, v]) => [
          k,
          Math.round(v * 10_000) / 10_000,
        ]),
      ),
      turnover: Math.round(x.turnover * 10_000) / 10_000,
      cost: Math.round(x.cost),
      skipped: x.skipped,
    })),
    equityCurveMonthEnd: monthEnd.map((v) => ({
      date: v.date,
      value: Math.round(v.value),
    })),
    methodology: r.methodology,
    limitations: r.limitations,
    warnings: r.warnings,
  };
}
