/**
 * Modern Portfolio Theory (Markowitz, 1952) helpers.
 * Portfolios are long-only and fully invested (weights ≥ 0, Σw = 1),
 * which matches what a retail investor can actually hold.
 */
import { TRADING_DAYS, covariance, mean } from "./stats";
// Circular with optimizer.ts (which imports portfolioStats from here); only used inside functions, so safe.
import { OptimizerError, constrainedFrontier, constrainedMeanVariance, gmvPortfolio, tangencyPortfolio } from "./optimizer";

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

// ------------------------------------------------------------------ long-only wrappers (Roadmap Phase 3)
// The projected-gradient solver that used to live here was a second optimization engine.
// These exports keep their signatures but delegate to the exact active-set QP in optimizer.ts
// with long-only, fully-invested bounds, so every page gets the same weights.

const LONG_ONLY = { min: 0, max: 1 };

/** min wᵀΣw − λ μᵀw on the simplex (λ = 0: global minimum variance). */
export function meanVarianceOptimize(mu: number[], cov: Matrix, lambda: number): number[] {
  return constrainedMeanVariance(mu, cov, lambda, LONG_ONLY);
}

export function minVariancePortfolio(mu: number[], cov: Matrix, rf: number): PortfolioPoint {
  return gmvPortfolio(mu, cov, rf, LONG_ONLY);
}

/** Long-only efficient frontier (the efficient arm of the constrained bullet). */
export function efficientFrontier(mu: number[], cov: Matrix, rf: number, points = 30): PortfolioPoint[] {
  return constrainedFrontier(mu, cov, rf, LONG_ONLY, points * 2)
    .curve.filter((p) => p.efficient)
    .map((p) => portfolioStats(p.weights, mu, cov, rf));
}

/**
 * Long-only tangency (maximum-Sharpe) portfolio. When no portfolio earns more than Rf there is no
 * tangency portfolio; null is returned instead of a meaningless "best negative Sharpe" point.
 */
export function maxSharpePortfolio(mu: number[], cov: Matrix, rf: number): PortfolioPoint | null {
  try {
    return tangencyPortfolio(mu, cov, rf, LONG_ONLY);
  } catch (e) {
    if (e instanceof OptimizerError) return null;
    throw e;
  }
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

// ------------------------------------------------------------------ covariance diagnostics

/** Eigen-decomposition of a symmetric matrix by cyclic Jacobi rotations. */
export function symmetricEigen(m: Matrix): { values: number[]; vectors: Matrix } {
  const n = m.length;
  const a = m.map((r) => [...r]);
  const v: Matrix = m.map((_, i) => m.map((__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: v };
}

export interface CovarianceDiagnostics {
  minEigenvalue: number;
  maxEigenvalue: number;
  /** λmax / λmin (Infinity when singular). */
  conditionNumber: number;
  psd: boolean;
  /** Input with negative eigenvalues clipped to zero (equal to the input when already PSD). */
  repaired: Matrix;
  warnings: string[];
}

/** PSD and conditioning check; a non-PSD matrix is repaired by eigenvalue clipping, with a warning. */
export function covarianceDiagnostics(cov: Matrix): CovarianceDiagnostics {
  const n = cov.length;
  const sym = cov.map((r, i) => r.map((x, j) => (x + cov[j][i]) / 2));
  const { values, vectors } = symmetricEigen(sym);
  const maxE = Math.max(...values);
  const minE = Math.min(...values);
  const tol = 1e-12 * Math.max(1e-12, Math.abs(maxE));
  const psd = minE >= -tol;
  const warnings: string[] = [];
  let repaired = cov;
  if (!psd) {
    const clipped = values.map((x) => Math.max(0, x));
    repaired = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => clipped.reduce((s, l, k) => s + l * vectors[i][k] * vectors[j][k], 0)));
    warnings.push("Covariance matrix ไม่เป็น positive semidefinite (เช่น ข้อมูลไม่ครบช่วงเดียวกัน) — ปรับ eigenvalue ที่ติดลบเป็น 0 ก่อนคำนวณ");
  }
  const cond = minE > tol ? maxE / minE : Infinity;
  if (cond > 1e8) warnings.push("Covariance เกือบ singular (มีสินทรัพย์ที่เคลื่อนไหวเหมือนกันมาก) — น้ำหนักที่ได้อาจไม่เสถียร พิจารณาตัดสินทรัพย์ที่ซ้ำกันหรือใช้ shrinkage");
  return { minEigenvalue: minE, maxEigenvalue: maxE, conditionNumber: cond, psd, repaired, warnings };
}

/**
 * Ledoit–Wolf (2004) shrinkage of the sample covariance toward a scaled identity:
 * Σ* = δ·m·I + (1 − δ)·S with the optimal intensity δ. Returns the per-period matrix.
 */
export function ledoitWolf(series: number[][]): { cov: Matrix; intensity: number } {
  const n = series.length;
  const T = Math.min(...series.map((s) => s.length));
  const means = series.map((s) => mean(s.slice(0, T)));
  const x = Array.from({ length: T }, (_, t) => series.map((s, i) => s[t] - means[i]));
  const S = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => x.reduce((a, r) => a + r[i] * r[j], 0) / T));
  const m = S.reduce((a, r, i) => a + r[i], 0) / n;
  let d2 = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) d2 += (S[i][j] - (i === j ? m : 0)) ** 2;
  let b2 = 0;
  for (const r of x) {
    let f = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) f += (r[i] * r[j] - S[i][j]) ** 2;
    b2 += f;
  }
  b2 = Math.min(b2 / (T * T), d2);
  const delta = d2 > 0 ? b2 / d2 : 1;
  return { cov: S.map((r, i) => r.map((v, j) => delta * (i === j ? m : 0) + (1 - delta) * v)), intensity: delta };
}
