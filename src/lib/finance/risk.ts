import { TRADING_DAYS, covariance, quantile, stdev, variance } from "./stats";

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

/** CAPM beta: β = Cov(R_p, R_m) / Var(R_m); null when the benchmark has no variance or too few points. */
export function beta(portfolio: number[], market: number[], minObs = 3): number | null {
  const n = Math.min(portfolio.length, market.length);
  if (n < minObs) return null;
  const vm = variance(market.slice(0, n));
  if (!(vm > 1e-18)) return null;
  return covariance(portfolio.slice(0, n), market.slice(0, n)) / vm;
}

/** Minimum observations before historical VaR / ES are shown. */
export const MIN_VAR_OBS = 100;

/** Historical Value-at-Risk (one observation horizon) at confidence `c`, as a positive loss; null if the sample is too small. */
export function historicalVaR(rs: number[], c = 0.95, minObs = MIN_VAR_OBS): number | null {
  if (rs.length < minObs) return null;
  return Math.max(0, -quantile(rs, 1 - c));
}

/**
 * Expected Shortfall: average loss over the worst n·(1 − c) observations,
 * including a fractional share of the boundary observation; null if the sample is too small.
 */
export function expectedShortfall(rs: number[], c = 0.95, minObs = MIN_VAR_OBS): number | null {
  if (rs.length < minObs) return null;
  const s = [...rs].sort((a, b) => a - b);
  const k = s.length * (1 - c);
  const whole = Math.floor(k);
  let sum = 0;
  for (let i = 0; i < whole; i++) sum += s[i];
  if (k > whole && whole < s.length) sum += (k - whole) * s[whole];
  return k > 0 ? Math.max(0, -sum / k) : null;
}

/** Tracking error: annualized stdev of active returns (R_p - R_b). */
export function trackingError(portfolio: number[], bench: number[], periodsPerYear = TRADING_DAYS): number {
  const n = Math.min(portfolio.length, bench.length);
  const active = Array.from({ length: n }, (_, i) => portfolio[i] - bench[i]);
  return annualVolatility(active, periodsPerYear);
}
