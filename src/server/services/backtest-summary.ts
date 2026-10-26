import type { backtestPortfolio } from "./backtest";

type Full = Awaited<ReturnType<typeof backtestPortfolio>>;

/** Compact result for AI tools: summary metrics, costs, month-end equity curve and the latest weights. */
export function summarizeBacktest(r: Full) {
  const m = r.metrics;
  const monthEnd = r.values.filter((v, i) => i === r.values.length - 1 || r.values[i + 1].date.slice(0, 7) !== v.date.slice(0, 7));
  return {
    strategy: r.strategy,
    period: r.period,
    universe: r.universe,
    excluded: r.excluded,
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
    equityCurveMonthEnd: monthEnd.map((v) => ({ date: v.date, value: Math.round(v.value) })),
    methodology: r.methodology,
    limitations: r.limitations,
    warnings: r.warnings,
  };
}
