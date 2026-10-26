/**
 * Risk-adjusted performance ratios. All inputs are annualized decimals
 * (e.g. 0.08 = 8%).
 */

/** Risk premium (excess return) over the risk-free rate: R_p − R_f. */
export function riskPremium(rp: number, rf: number): number {
  return rp - rf;
}

/** Sharpe ratio: (R_p − R_f) / σ_p. */
export function sharpe(rp: number, rf: number, sigma: number): number | null {
  return sigma > 0 ? (rp - rf) / sigma : null;
}

/** Sortino ratio: (R_p − R_f) / downside deviation. */
export function sortino(rp: number, rf: number, downside: number): number | null {
  return downside > 0 ? (rp - rf) / downside : null;
}

/** Treynor ratio: (R_p − R_f) / β. */
export function treynor(rp: number, rf: number, beta: number): number | null {
  return beta !== 0 ? (rp - rf) / beta : null;
}

/** CAPM expected return: E[R] = R_f + β (R_m − R_f). */
export function capmExpectedReturn(rf: number, beta: number, rm: number): number {
  return rf + beta * (rm - rf);
}

/** Jensen's alpha: α = R_p − [R_f + β (R_m − R_f)]. */
export function jensenAlpha(rp: number, rf: number, beta: number, rm: number): number {
  return rp - capmExpectedReturn(rf, beta, rm);
}

/** Information ratio: (R_p − R_b) / tracking error. */
export function informationRatio(rp: number, rb: number, te: number): number | null {
  return te > 0 ? (rp - rb) / te : null;
}

/** Calmar ratio: annual return / max drawdown. */
export function calmar(rp: number, maxDd: number): number | null {
  return maxDd > 0 ? rp / maxDd : null;
}

/** Convert an annual rate to an equivalent per-period rate (geometric). */
export function perPeriodRate(annual: number, periodsPerYear: number): number {
  return (1 + annual) ** (1 / periodsPerYear) - 1;
}
