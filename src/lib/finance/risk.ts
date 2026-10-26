import { TRADING_DAYS, covariance, mean, quantile, stdev, variance } from "./stats";

/** Annualized volatility from periodic returns: σ_annual = σ_period · √N. */
export function annualVolatility(rs: number[], periodsPerYear = TRADING_DAYS): number {
  return stdev(rs) * Math.sqrt(periodsPerYear);
}

/**
 * Annualized downside deviation relative to a minimum acceptable return (per period).
 * Uses √(Σ min(0, r - MAR)² / n) · √N as in Sortino & Price (1994).
 */
export function downsideDeviation(rs: number[], marPerPeriod = 0, periodsPerYear = TRADING_DAYS): number {
  if (rs.length === 0) return 0;
  const s = rs.reduce((a, r) => a + Math.min(0, r - marPerPeriod) ** 2, 0);
  return Math.sqrt(s / rs.length) * Math.sqrt(periodsPerYear);
}

/** Maximum peak-to-trough decline of a value / index series, as a positive fraction. */
export function maxDrawdown(values: number[]): { maxDrawdown: number; peakIndex: number; troughIndex: number } {
  let peak = -Infinity;
  let peakIdx = 0;
  let best = { maxDrawdown: 0, peakIndex: 0, troughIndex: 0 };
  values.forEach((v, i) => {
    if (v > peak) {
      peak = v;
      peakIdx = i;
    }
    const dd = peak > 0 ? 1 - v / peak : 0;
    if (dd > best.maxDrawdown) best = { maxDrawdown: dd, peakIndex: peakIdx, troughIndex: i };
  });
  return best;
}

/** CAPM beta: β = Cov(R_p, R_m) / Var(R_m). */
export function beta(portfolio: number[], market: number[]): number {
  const n = Math.min(portfolio.length, market.length);
  const vm = variance(market.slice(0, n));
  if (vm === 0) return 0;
  return covariance(portfolio.slice(0, n), market.slice(0, n)) / vm;
}

/** Historical Value-at-Risk at confidence `c` (returns a positive loss fraction). */
export function historicalVaR(rs: number[], c = 0.95): number {
  return Math.max(0, -quantile(rs, 1 - c));
}

/** Conditional VaR / Expected Shortfall: mean loss beyond VaR. */
export function expectedShortfall(rs: number[], c = 0.95): number {
  const cutoff = quantile(rs, 1 - c);
  const tail = rs.filter((r) => r <= cutoff);
  return tail.length ? Math.max(0, -mean(tail)) : 0;
}

/** Tracking error: annualized stdev of active returns (R_p - R_b). */
export function trackingError(portfolio: number[], bench: number[], periodsPerYear = TRADING_DAYS): number {
  const n = Math.min(portfolio.length, bench.length);
  const active = Array.from({ length: n }, (_, i) => portfolio[i] - bench[i]);
  return annualVolatility(active, periodsPerYear);
}
