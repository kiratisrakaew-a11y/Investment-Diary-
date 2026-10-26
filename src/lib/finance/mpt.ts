/**
 * Modern Portfolio Theory (Markowitz, 1952) helpers.
 * Portfolios are long-only and fully invested (weights ≥ 0, Σw = 1),
 * which matches what a retail investor can actually hold.
 */
import { TRADING_DAYS, covariance, mean } from "./stats";

export type Matrix = number[][];

export interface PortfolioPoint {
  weights: number[];
  expectedReturn: number;
  volatility: number;
  sharpe: number | null;
}

/** Annualized mean returns and covariance matrix from aligned periodic return series. */
export function estimateInputs(series: number[][], periodsPerYear = TRADING_DAYS): { mu: number[]; cov: Matrix } {
  const mu = series.map((s) => mean(s) * periodsPerYear);
  const cov = series.map((a) => series.map((b) => covariance(a, b) * periodsPerYear));
  return { mu, cov };
}

export function correlationMatrix(cov: Matrix): Matrix {
  return cov.map((row, i) =>
    row.map((c, j) => {
      const d = Math.sqrt(cov[i][i] * cov[j][j]);
      return d > 0 ? c / d : i === j ? 1 : 0;
    }),
  );
}

function matVec(m: Matrix, v: number[]): number[] {
  return m.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}

function dot(a: number[], b: number[]): number {
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

/** σ_p² = wᵀ Σ w */
export function portfolioVariance(w: number[], cov: Matrix): number {
  return dot(w, matVec(cov, w));
}

export function portfolioStats(w: number[], mu: number[], cov: Matrix, rf: number): PortfolioPoint {
  const er = dot(w, mu);
  const vol = Math.sqrt(Math.max(0, portfolioVariance(w, cov)));
  return { weights: w, expectedReturn: er, volatility: vol, sharpe: vol > 0 ? (er - rf) / vol : null };
}

/** Euclidean projection onto the probability simplex (Duchi et al., 2008). */
export function projectToSimplex(v: number[]): number[] {
  const u = [...v].sort((a, b) => b - a);
  let css = 0;
  let theta = 0;
  for (let i = 0; i < u.length; i++) {
    css += u[i];
    const t = (css - 1) / (i + 1);
    if (u[i] - t > 0) theta = t;
  }
  return v.map((x) => Math.max(0, x - theta));
}

function stepSize(cov: Matrix): number {
  // Gershgorin bound on the largest eigenvalue of Σ.
  const l = Math.max(...cov.map((row) => row.reduce((s, x) => s + Math.abs(x), 0)), 1e-12);
  return 1 / (2 * l);
}

/**
 * Solve min_w  wᵀΣw − λ μᵀw  on the simplex by projected gradient descent.
 * λ = 0 gives the global minimum-variance portfolio; λ → ∞ the max-return asset.
 */
export function meanVarianceOptimize(mu: number[], cov: Matrix, lambda: number, iters = 3000): number[] {
  const n = mu.length;
  let w = Array(n).fill(1 / n);
  const eta = stepSize(cov);
  for (let k = 0; k < iters; k++) {
    const g = matVec(cov, w).map((x, i) => 2 * x - lambda * mu[i]);
    const next = projectToSimplex(w.map((x, i) => x - eta * g[i]));
    const diff = next.reduce((s, x, i) => s + Math.abs(x - w[i]), 0);
    w = next;
    if (diff < 1e-12) break;
  }
  return w;
}

export function minVariancePortfolio(mu: number[], cov: Matrix, rf: number): PortfolioPoint {
  return portfolioStats(meanVarianceOptimize(mu, cov, 0), mu, cov, rf);
}

/** λ large enough that the optimizer reaches the max-return corner. */
function lambdaUpper(mu: number[], cov: Matrix): number {
  const maxVar = Math.max(...cov.map((r, i) => r[i]), 1e-6);
  const muSpread = Math.max(Math.max(...mu) - Math.min(...mu), 1e-6);
  return (20 * maxVar) / muSpread;
}

/** Long-only efficient frontier traced by sweeping the risk-aversion trade-off λ. */
export function efficientFrontier(mu: number[], cov: Matrix, rf: number, points = 30): PortfolioPoint[] {
  const out: PortfolioPoint[] = [];
  const lambdaMax = lambdaUpper(mu, cov);
  for (let i = 0; i < points; i++) {
    // Cubic spacing puts more points near the curved minimum-variance end.
    const lambda = lambdaMax * (i / (points - 1)) ** 3;
    out.push(portfolioStats(meanVarianceOptimize(mu, cov, lambda, 1500), mu, cov, rf));
  }
  out.sort((a, b) => a.volatility - b.volatility);
  // Keep only the efficient (upper) part: returns must be non-decreasing in risk.
  const eff: PortfolioPoint[] = [];
  for (const p of out) if (!eff.length || p.expectedReturn >= eff[eff.length - 1].expectedReturn - 1e-9) eff.push(p);
  return eff;
}

/**
 * Tangency (maximum-Sharpe) portfolio — the point where the Capital Market Line
 * from R_f touches the efficient frontier. Sharpe is unimodal along the frontier,
 * so a golden-section search over the risk-aversion parameter λ finds it.
 */
export function maxSharpePortfolio(mu: number[], cov: Matrix, rf: number): PortfolioPoint {
  const at = (lambda: number) => portfolioStats(meanVarianceOptimize(mu, cov, lambda), mu, cov, rf);
  const score = (p: PortfolioPoint) => p.sharpe ?? -Infinity;
  let lo = 0;
  let hi = lambdaUpper(mu, cov);
  const g = (Math.sqrt(5) - 1) / 2;
  let c = hi - g * (hi - lo);
  let d = lo + g * (hi - lo);
  let pc = at(c);
  let pd = at(d);
  for (let i = 0; i < 40; i++) {
    // Ties go left: beyond some λ the optimizer sits at the max-return corner (flat Sharpe).
    if (score(pc) >= score(pd)) {
      hi = d;
      d = c;
      pd = pc;
      c = hi - g * (hi - lo);
      pc = at(c);
    } else {
      lo = c;
      c = d;
      pc = pd;
      d = lo + g * (hi - lo);
      pd = at(d);
    }
  }
  const best = score(pc) > score(pd) ? pc : pd;
  // Guard against a corner solution outside the bracket.
  const corners = [at(0), at(lambdaUpper(mu, cov))];
  return [best, ...corners].reduce((a, b) => (score(b) > score(a) ? b : a));
}

/** Random long-only portfolios (uniform on the simplex) for the risk/return scatter. */
export function randomPortfolios(mu: number[], cov: Matrix, rf: number, count = 500, seed = 42): PortfolioPoint[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const out: PortfolioPoint[] = [];
  for (let k = 0; k < count; k++) {
    const e = mu.map(() => -Math.log(1 - rand()));
    const sum = e.reduce((a, b) => a + b, 0);
    out.push(portfolioStats(e.map((x) => x / sum), mu, cov, rf));
  }
  return out;
}
