/**
 * Markowitz portfolio optimizer used for weight recommendations.
 *
 * - Unconstrained (short sales allowed) frontier in closed form (Merton, 1972):
 *   σ²(μp) = (A μp² − 2B μp + C) / D, with A = 1ᵀΣ⁻¹1, B = 1ᵀΣ⁻¹μ, C = μᵀΣ⁻¹μ, D = AC − B².
 *   Plotted over a range of μp this is the classic "bullet" (hyperbola) — the
 *   upper half is the efficient frontier, the lower half is inefficient.
 * - Constrained frontier with per-asset bounds (e.g. long-only, max 40% per
 *   asset), solved numerically with projected gradient descent.
 * - Tangency (max-Sharpe), global minimum variance, target return / risk,
 *   utility maximization U = E[R] − ½Aσ², and the optimal complete portfolio
 *   y* = (E[R_T] − R_f) / (A σ_T²) along the Capital Allocation Line.
 */
import { portfolioStats, type Matrix, type PortfolioPoint } from "./mpt";

export interface Bounds {
  min: number; // e.g. 0 for long-only
  max: number; // e.g. 1, or 0.4 for a 40% cap
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const matVec = (m: Matrix, v: number[]) => m.map((row) => dot(row, v));

/** Gauss-Jordan inverse with partial pivoting; returns null if singular. */
export function invert(m: Matrix): Matrix | null {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-14) return null;
    [a[c], a[p]] = [a[p], a[c]];
    const div = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= div;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f !== 0) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/** Small ridge on the diagonal keeps Σ invertible when assets are nearly collinear. */
function regularize(cov: Matrix, eps = 1e-8): Matrix {
  return cov.map((row, i) => row.map((x, j) => (i === j ? x + eps : x)));
}

// ------------------------------------------------------------------ closed form

export interface AnalyticFrontier {
  A: number;
  B: number;
  C: number;
  D: number;
  gmv: PortfolioPoint;
  tangency: PortfolioPoint | null;
  /** Weights of the frontier portfolio with expected return μp. */
  weightsFor: (mup: number) => number[];
  /** Bullet curve: both halves of the hyperbola. */
  curve: { volatility: number; expectedReturn: number; efficient: boolean }[];
}

export function analyticFrontier(mu: number[], cov: Matrix, rf: number, points = 60): AnalyticFrontier | null {
  const inv = invert(regularize(cov));
  if (!inv) return null;
  const ones = mu.map(() => 1);
  const invOnes = matVec(inv, ones);
  const invMu = matVec(inv, mu);
  const A = dot(ones, invOnes);
  const B = dot(ones, invMu);
  const C = dot(mu, invMu);
  const D = A * C - B * B;
  if (D <= 0) return null;

  const weightsFor = (mup: number) => {
    const lam = (C - B * mup) / D;
    const gam = (A * mup - B) / D;
    return invOnes.map((x, i) => lam * x + gam * invMu[i]);
  };
  const gmvW = invOnes.map((x) => x / A);
  const gmv = portfolioStats(gmvW, mu, cov, rf);

  // Tangency: w ∝ Σ⁻¹(μ − Rf·1); only meaningful when the GMV return exceeds Rf.
  const excess = mu.map((m) => m - rf);
  const invEx = matVec(inv, excess);
  const s = invEx.reduce((a, b) => a + b, 0);
  const tangency = s > 0 && B / A > rf ? portfolioStats(invEx.map((x) => x / s), mu, cov, rf) : null;

  const muGmv = B / A;
  const span = Math.max(Math.max(...mu) - Math.min(...mu), Math.abs(muGmv) * 0.5, 0.02) * 1.3;
  const curve: AnalyticFrontier["curve"] = [];
  for (let i = 0; i < points; i++) {
    const mup = muGmv - span + (2 * span * i) / (points - 1);
    const v = (A * mup * mup - 2 * B * mup + C) / D;
    curve.push({ volatility: Math.sqrt(Math.max(v, 0)), expectedReturn: mup, efficient: mup >= muGmv });
  }
  return { A, B, C, D, gmv, tangency, weightsFor, curve };
}

// ------------------------------------------------------------------ constrained

/** Euclidean projection onto {w : Σw = 1, lo ≤ w ≤ hi} via bisection on the shift θ. */
export function projectBoxSimplex(v: number[], b: Bounds): number[] {
  const n = v.length;
  const lo = b.min;
  const hi = Math.max(b.max, 1 / n); // ensure feasibility
  const sumAt = (t: number) => v.reduce((s, x) => s + Math.min(hi, Math.max(lo, x - t)), 0);
  let a = Math.min(...v) - hi - 1;
  let c = Math.max(...v) - lo + 1;
  for (let i = 0; i < 100; i++) {
    const m = (a + c) / 2;
    if (sumAt(m) > 1) a = m;
    else c = m;
  }
  const t = (a + c) / 2;
  return v.map((x) => Math.min(hi, Math.max(lo, x - t)));
}

function lipschitz(cov: Matrix) {
  return Math.max(...cov.map((row) => row.reduce((s, x) => s + Math.abs(x), 0)), 1e-12);
}

/** min wᵀΣw − λ μᵀw subject to bounds (λ = 2/A gives the utility-maximizing portfolio). */
export function constrainedMeanVariance(mu: number[], cov: Matrix, lambda: number, b: Bounds, iters = 4000): number[] {
  let w = projectBoxSimplex(mu.map(() => 1 / mu.length), b);
  const eta = 1 / (2 * lipschitz(cov));
  for (let k = 0; k < iters; k++) {
    const g = matVec(cov, w).map((x, i) => 2 * x - lambda * mu[i]);
    const next = projectBoxSimplex(w.map((x, i) => x - eta * g[i]), b);
    const diff = next.reduce((s, x, i) => s + Math.abs(x - w[i]), 0);
    w = next;
    if (diff < 1e-12) break;
  }
  return w;
}

/** Minimum variance for a target expected return under bounds (penalty method with continuation). */
export function constrainedTargetReturn(mu: number[], cov: Matrix, target: number, b: Bounds): number[] {
  let w = projectBoxSimplex(mu.map(() => 1 / mu.length), b);
  const muNorm2 = dot(mu, mu);
  const L = lipschitz(cov);
  for (const rho of [1, 10, 100, 1000, 10000].map((k) => (k * L) / Math.max(muNorm2, 1e-12))) {
    const eta = 1 / (2 * (L + rho * muNorm2));
    for (let k = 0; k < 3000; k++) {
      const gap = dot(mu, w) - target;
      const g = matVec(cov, w).map((x, i) => 2 * x + 2 * rho * gap * mu[i]);
      const next = projectBoxSimplex(w.map((x, i) => x - eta * g[i]), b);
      const diff = next.reduce((s, x, i) => s + Math.abs(x - w[i]), 0);
      w = next;
      if (diff < 1e-13) break;
    }
  }
  return w;
}

/** Feasible expected-return range under bounds: greedy fill of the highest / lowest μ assets. */
export function feasibleReturnRange(mu: number[], b: Bounds): [number, number] {
  const fill = (order: number[]) => {
    const n = mu.length;
    const hi = Math.max(b.max, 1 / n);
    const w = mu.map(() => b.min);
    let left = 1 - b.min * n;
    for (const i of order) {
      const add = Math.min(hi - b.min, left);
      w[i] += add;
      left -= add;
    }
    return dot(w, mu);
  };
  const idx = mu.map((_, i) => i);
  return [fill([...idx].sort((a, c) => mu[a] - mu[c])), fill([...idx].sort((a, c) => mu[c] - mu[a]))];
}

export interface ConstrainedFrontier {
  gmv: PortfolioPoint;
  tangency: PortfolioPoint;
  /** Both halves (bullet) under the constraints. */
  curve: { volatility: number; expectedReturn: number; efficient: boolean; weights: number[] }[];
}

export function constrainedFrontier(mu: number[], cov: Matrix, rf: number, b: Bounds, points = 30): ConstrainedFrontier {
  const gmv = portfolioStats(constrainedMeanVariance(mu, cov, 0, b), mu, cov, rf);
  const [rMin, rMax] = feasibleReturnRange(mu, b);
  const curve: ConstrainedFrontier["curve"] = [];
  for (let i = 0; i < points; i++) {
    const target = rMin + ((rMax - rMin) * i) / (points - 1);
    const w = constrainedTargetReturn(mu, cov, target, b);
    const p = portfolioStats(w, mu, cov, rf);
    curve.push({ volatility: p.volatility, expectedReturn: p.expectedReturn, efficient: p.expectedReturn >= gmv.expectedReturn - 1e-9, weights: w });
  }
  curve.sort((a, c) => a.expectedReturn - c.expectedReturn);
  return { gmv, tangency: constrainedMaxSharpe(mu, cov, rf, b), curve };
}

/** Max-Sharpe under bounds: golden-section search over the frontier parameter λ. */
export function constrainedMaxSharpe(mu: number[], cov: Matrix, rf: number, b: Bounds): PortfolioPoint {
  const at = (l: number) => portfolioStats(constrainedMeanVariance(mu, cov, l, b, 2500), mu, cov, rf);
  const score = (p: PortfolioPoint) => p.sharpe ?? -Infinity;
  const maxVar = Math.max(...cov.map((r, i) => r[i]), 1e-6);
  const spread = Math.max(Math.max(...mu) - Math.min(...mu), 1e-6);
  let lo = 0;
  let hi = (20 * maxVar) / spread;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = hi - g * (hi - lo);
  let d = lo + g * (hi - lo);
  let pc = at(c);
  let pd = at(d);
  for (let i = 0; i < 40; i++) {
    // Ties go left: past some λ the solution sits at the max-return corner.
    if (score(pc) >= score(pd) - 1e-9) {
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
  return [pc, pd, at(0)].reduce((a, x) => (score(x) > score(a) ? x : a));
}

/** Highest-return portfolio whose volatility does not exceed `maxVol`. */
export function constrainedTargetRisk(mu: number[], cov: Matrix, rf: number, maxVol: number, b: Bounds): PortfolioPoint {
  const f = constrainedFrontier(mu, cov, rf, b, 40).curve.filter((p) => p.efficient);
  const ok = f.filter((p) => p.volatility <= maxVol + 1e-9);
  const best = ok.length ? ok[ok.length - 1] : f[0];
  return portfolioStats(best.weights, mu, cov, rf);
}

/** Optimal complete portfolio: share y* of wealth in the risky (tangency) portfolio, rest in the risk-free asset. */
export function completePortfolio(tangency: PortfolioPoint, rf: number, riskAversion: number) {
  const y = tangency.volatility > 0 ? (tangency.expectedReturn - rf) / (riskAversion * tangency.volatility ** 2) : 0;
  return {
    riskyShare: y,
    expectedReturn: rf + y * (tangency.expectedReturn - rf),
    volatility: Math.abs(y) * tangency.volatility,
    utility: rf + y * (tangency.expectedReturn - rf) - 0.5 * riskAversion * (y * tangency.volatility) ** 2,
  };
}
