/**
 * Markowitz portfolio optimizer used for weight recommendations.
 *
 * - Unconstrained (short sales allowed) frontier in closed form (Merton, 1972):
 *   σ²(μp) = (A μp² − 2B μp + C) / D, with A = 1ᵀΣ⁻¹1, B = 1ᵀΣ⁻¹μ, C = μᵀΣ⁻¹μ, D = AC − B².
 *   Plotted over a range of μp this is the classic "bullet" (hyperbola) — the
 *   upper half is the efficient frontier, the lower half is inefficient.
 * - Constrained frontier with per-asset bounds (e.g. long-only, max 40% per
 *   asset), solved exactly with an active-set QP. Infeasible bounds or targets
 *   raise an OptimizerError; bounds are never relaxed silently.
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
  // Ridge only when Σ is singular, so a well-conditioned frontier is exact.
  const inv = invert(cov) ?? invert(regularize(cov));
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

// ------------------------------------------------------------------ feasibility

export type OptimizerIssueCode = "INFEASIBLE_BOUNDS" | "INFEASIBLE_TARGET_RETURN" | "INFEASIBLE_TARGET_RISK" | "NO_EXCESS_RETURN" | "INVALID_INPUT";

export interface OptimizerIssue {
  code: OptimizerIssueCode;
  message: string;
  /** What the user can change to make the problem solvable. */
  suggestion?: string;
}

export class OptimizerError extends Error {
  constructor(public issue: OptimizerIssue) {
    super(issue.message);
    this.name = "OptimizerError";
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Bounds must admit a fully invested portfolio: n·min ≤ 1 ≤ n·max. Never relaxed silently. */
export function validateBounds(n: number, b: Bounds): OptimizerIssue | null {
  if (!(n >= 1) || !Number.isFinite(b.min) || !Number.isFinite(b.max) || b.min > b.max) {
    return { code: "INVALID_INPUT", message: `ขอบเขตน้ำหนักไม่ถูกต้อง (ต่ำสุด ${pct(b.min)} > สูงสุด ${pct(b.max)})` };
  }
  if (n * b.max < 1 - 1e-12) {
    return {
      code: "INFEASIBLE_BOUNDS",
      message: `น้ำหนักสูงสุด ${pct(b.max)} × ${n} สินทรัพย์ = ${pct(n * b.max)} < 100% — ลงทุนให้ครบ 100% ไม่ได้`,
      suggestion: `เพิ่มน้ำหนักสูงสุดเป็นอย่างน้อย ${pct(Math.ceil((1 / n) * 1000) / 1000)} หรือเลือกสินทรัพย์อย่างน้อย ${Math.ceil(1 / b.max - 1e-12)} ตัว`,
    };
  }
  if (n * b.min > 1 + 1e-12) {
    return {
      code: "INFEASIBLE_BOUNDS",
      message: `น้ำหนักต่ำสุด ${pct(b.min)} × ${n} สินทรัพย์ = ${pct(n * b.min)} > 100%`,
      suggestion: `ลดน้ำหนักต่ำสุดเหลือไม่เกิน ${pct(Math.floor((1 / n) * 1000) / 1000)} หรือลดจำนวนสินทรัพย์`,
    };
  }
  return null;
}

function assertBounds(n: number, b: Bounds) {
  const issue = validateBounds(n, b);
  if (issue) throw new OptimizerError(issue);
}

/** Σw − 1 and the largest bound violation of a weight vector. */
export function checkWeights(w: number[], b: Bounds) {
  return {
    sumError: Math.abs(w.reduce((a, x) => a + x, 0) - 1),
    maxBoundViolation: Math.max(0, ...w.map((x) => Math.max(b.min - x, x - b.max))),
  };
}

/** Euclidean projection onto {w : Σw = 1, lo ≤ w ≤ hi} via bisection on the shift θ; throws when the set is empty. */
export function projectBoxSimplex(v: number[], b: Bounds): number[] {
  assertBounds(v.length, b);
  const { min: lo, max: hi } = b;
  const sumAt = (t: number) => v.reduce((s, x) => s + Math.min(hi, Math.max(lo, x - t)), 0);
  let a = Math.min(...v) - hi - 1;
  let c = Math.max(...v) - lo + 1;
  for (let i = 0; i < 200; i++) {
    const m = (a + c) / 2;
    if (sumAt(m) > 1) a = m;
    else c = m;
  }
  const t = (a + c) / 2;
  return v.map((x) => Math.min(hi, Math.max(lo, x - t)));
}

/** Fill the minimum everywhere, then top up assets in `order` to the maximum until fully invested. */
function greedyFill(n: number, b: Bounds, order: number[]) {
  const w = Array<number>(n).fill(b.min);
  let left = 1 - b.min * n;
  for (const i of order) {
    const add = Math.min(b.max - b.min, left);
    w[i] += add;
    left -= add;
  }
  return w;
}

/** Exact feasible expected-return range under the bounds (an LP solved greedily). */
export function feasibleReturnRange(mu: number[], b: Bounds): [number, number] {
  assertBounds(mu.length, b);
  const idx = mu.map((_, i) => i);
  return [dot(greedyFill(mu.length, b, [...idx].sort((a, c) => mu[a] - mu[c])), mu), dot(greedyFill(mu.length, b, [...idx].sort((a, c) => mu[c] - mu[a])), mu)];
}

// ------------------------------------------------------------------ QP solver

/** Solves A x = y by Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(A: Matrix, y: number[]): number[] | null {
  const n = A.length;
  const m = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-15) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      if (f !== 0) for (let j = c; j <= n; j++) m[r][j] -= f * m[c][j];
    }
  }
  const x = Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let j = r + 1; j < n; j++) s -= m[r][j] * x[j];
    x[r] = s / m[r][r];
  }
  return x;
}

export interface QpResult {
  weights: number[];
  status: "optimal" | "max_iterations";
  iterations: number;
  /** Max violation of the KKT stationarity / sign conditions. */
  kktResidual: number;
  sumError: number;
  maxBoundViolation: number;
  /** A tiny ridge was added because the free block of Q was singular. */
  regularized: boolean;
}

/**
 * Primal active-set method for  min ½wᵀQw + cᵀw  s.t. Σw = 1, lo ≤ w ≤ hi  (Q positive semidefinite).
 * Deterministic; exact up to floating point for the small problems of a personal portfolio.
 */
export function solveBoxQP(Q: Matrix, c: number[], b: Bounds, maxIter = 500): QpResult {
  const n = c.length;
  assertBounds(n, b);
  const { min: lo, max: hi } = b;
  const avgDiag = Q.reduce((s, r, i) => s + Math.abs(r[i]), 0) / n || 1;
  let ridge = 0;
  // Feasible start; the asset that absorbed the remainder stays free so the free set is never empty.
  const order = c.map((_, i) => i).sort((a, k) => c[a] - c[k]);
  const w = greedyFill(n, b, order);
  let lastFilled = order[0];
  for (const i of order) if (w[i] > lo) lastFilled = i;
  // fixed[i] = -1 at lower bound, +1 at upper bound, 0 free
  const fixed = w.map((x, i) => (i === lastFilled ? 0 : Math.abs(x - lo) < 1e-15 ? -1 : Math.abs(x - hi) < 1e-15 ? 1 : 0));
  if (lo === hi) fixed.fill(-1);
  const grad = () => Q.map((row, i) => dot(row, w) + c[i] + ridge * w[i]);

  let iterations = 0;
  let nu = 0;
  for (; iterations < maxIter; iterations++) {
    const F = fixed.map((f, i) => (f === 0 ? i : -1)).filter((i) => i >= 0);
    const g = grad();
    const p = Array<number>(n).fill(0);
    if (F.length) {
      // KKT system for the step on the free set: [Q_FF 1; 1ᵀ 0][p_F; ν] = [−g_F; 0]
      const build = () => [
        ...F.map((i) => [...F.map((j) => Q[i][j] + (i === j ? ridge : 0)), 1]),
        [...F.map(() => 1), 0],
      ];
      let sol = solveLinear(build(), [...F.map((i) => -g[i]), 0]);
      if (!sol) {
        ridge = Math.max(ridge * 10, 1e-12 * avgDiag);
        sol = solveLinear(build(), [...F.map((i) => -grad()[i]), 0]);
        if (!sol) break;
      }
      F.forEach((i, k) => (p[i] = sol![k]));
      nu = -sol[F.length];
    }
    const stepNorm = Math.max(0, ...p.map(Math.abs));
    if (stepNorm < 1e-14) {
      if (!F.length) nu = 0;
      // Multipliers of the active bounds: g_i − ν must be ≥ 0 at the lower bound and ≤ 0 at the upper bound.
      let worst = -1;
      let worstVal = 1e-13 * Math.max(1, avgDiag);
      fixed.forEach((f, i) => {
        if (f === 0) return;
        const m = (g[i] - nu) * (f === -1 ? -1 : 1);
        if (m > worstVal) {
          worstVal = m;
          worst = i;
        }
      });
      if (worst < 0) break;
      fixed[worst] = 0;
      continue;
    }
    // Longest feasible step along p (≤ 1); block at the first bound reached.
    let alpha = 1;
    let block = -1;
    for (const i of F) {
      if (p[i] < -1e-18) {
        const a = (lo - w[i]) / p[i];
        if (a < alpha) {
          alpha = a;
          block = i;
        }
      } else if (p[i] > 1e-18) {
        const a = (hi - w[i]) / p[i];
        if (a < alpha) {
          alpha = a;
          block = i;
        }
      }
    }
    for (let i = 0; i < n; i++) w[i] += alpha * p[i];
    if (block >= 0) {
      w[block] = p[block] < 0 ? lo : hi;
      fixed[block] = p[block] < 0 ? -1 : 1;
    }
  }

  // Clean up floating-point drift and report the KKT residual.
  for (let i = 0; i < n; i++) w[i] = Math.min(hi, Math.max(lo, w[i]));
  const g = grad();
  const free = w.map((_, i) => i).filter((i) => fixed[i] === 0);
  const nuHat = free.length ? free.reduce((s, i) => s + g[i], 0) / free.length : 0;
  let kkt = 0;
  for (let i = 0; i < n; i++) {
    const r = g[i] - nuHat;
    if (fixed[i] === 0) kkt = Math.max(kkt, Math.abs(r));
    else if (fixed[i] === -1) kkt = Math.max(kkt, -r);
    else kkt = Math.max(kkt, r);
  }
  const chk = checkWeights(w, b);
  return { weights: w, status: iterations < maxIter ? "optimal" : "max_iterations", iterations, kktResidual: Math.max(0, kkt), ...chk, regularized: ridge > 0 };
}

// ------------------------------------------------------------------ constrained frontier

export type SolverDiagnostics = Omit<QpResult, "weights">;
export type OptimizedPoint = PortfolioPoint & { solver: SolverDiagnostics; lambda: number };

/** min wᵀΣw − λ μᵀw  under the bounds (λ = 0: GMV; λ < 0 traces the inefficient arm). */
function solveLambda(mu: number[], cov: Matrix, rf: number, lambda: number, b: Bounds): OptimizedPoint {
  const r = solveBoxQP(
    cov.map((row) => row.map((x) => 2 * x)),
    mu.map((m) => -lambda * m),
    b,
  );
  const { weights, ...solver } = r;
  return { ...portfolioStats(weights, mu, cov, rf), solver, lambda };
}

function lambdaScale(mu: number[], cov: Matrix) {
  const maxVar = Math.max(...cov.map((r, i) => r[i]), 1e-8);
  const spread = Math.max(Math.max(...mu) - Math.min(...mu), 1e-8);
  return maxVar / spread;
}

/** Smallest λ (in magnitude, with sign) at which the solution reaches the max (sign = 1) or min (sign = −1) return corner. */
function cornerLambda(mu: number[], cov: Matrix, rf: number, b: Bounds, sign: 1 | -1) {
  const [rMin, rMax] = feasibleReturnRange(mu, b);
  const goal = sign === 1 ? rMax : rMin;
  let l = lambdaScale(mu, cov);
  for (let k = 0; k < 200; k++) {
    const p = solveLambda(mu, cov, rf, sign * l, b);
    if (Math.abs(p.expectedReturn - goal) < 1e-12 * Math.max(1, Math.abs(goal))) return sign * l;
    l *= 2;
  }
  return sign * l;
}

export function gmvPortfolio(mu: number[], cov: Matrix, rf: number, b: Bounds): OptimizedPoint {
  assertBounds(mu.length, b);
  return solveLambda(mu, cov, rf, 0, b);
}

/** Minimum-variance portfolio with exactly the target expected return (both arms of the bullet). */
export function targetReturnPortfolio(mu: number[], cov: Matrix, rf: number, target: number, b: Bounds): OptimizedPoint {
  const [rMin, rMax] = feasibleReturnRange(mu, b);
  const tol = 1e-12 * Math.max(1, Math.abs(target));
  if (target > rMax + tol || target < rMin - tol) {
    throw new OptimizerError({
      code: "INFEASIBLE_TARGET_RETURN",
      message: `ผลตอบแทนเป้าหมาย ${pct(target)} อยู่นอกช่วงที่ทำได้ภายใต้ข้อจำกัด (${pct(rMin)} – ${pct(rMax)})`,
      suggestion: `เลือกเป้าหมายระหว่าง ${pct(rMin)} ถึง ${pct(rMax)} หรือผ่อนน้ำหนักสูงสุด/ต่ำสุด`,
    });
  }
  let lo = cornerLambda(mu, cov, rf, b, -1);
  let hi = cornerLambda(mu, cov, rf, b, 1);
  let best = solveLambda(mu, cov, rf, 0, b);
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    const p = solveLambda(mu, cov, rf, mid, b);
    if (Math.abs(p.expectedReturn - target) < Math.abs(best.expectedReturn - target)) best = p;
    if (Math.abs(p.expectedReturn - target) <= 1e-13) break;
    if (p.expectedReturn < target) lo = mid;
    else hi = mid;
  }
  return best;
}

/** Highest expected return with volatility ≤ target (lies on the efficient arm). */
export function targetRiskPortfolio(mu: number[], cov: Matrix, rf: number, targetVol: number, b: Bounds): OptimizedPoint & { binding: boolean } {
  const gmv = gmvPortfolio(mu, cov, rf, b);
  if (targetVol < gmv.volatility - 1e-12) {
    throw new OptimizerError({
      code: "INFEASIBLE_TARGET_RISK",
      message: `ความเสี่ยงเป้าหมาย ${pct(targetVol)} ต่ำกว่าพอร์ตความเสี่ยงต่ำสุดที่ทำได้ (${pct(gmv.volatility)})`,
      suggestion: `ตั้งความเสี่ยงอย่างน้อย ${pct(gmv.volatility)} หรือรวมสินทรัพย์ปลอดความเสี่ยง`,
    });
  }
  let hi = cornerLambda(mu, cov, rf, b, 1);
  const top = solveLambda(mu, cov, rf, hi, b);
  if (top.volatility <= targetVol) return { ...top, binding: false };
  let lo = 0;
  let best: OptimizedPoint = gmv;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    const p = solveLambda(mu, cov, rf, mid, b);
    if (p.volatility <= targetVol) {
      best = p;
      lo = mid;
    } else hi = mid;
    if (hi - lo < 1e-15 * Math.max(1, hi)) break;
  }
  return { ...best, binding: true };
}

/** Max-Sharpe portfolio under the bounds; Sharpe is quasi-concave along the efficient arm, so golden-section on λ is exact. */
export function tangencyPortfolio(mu: number[], cov: Matrix, rf: number, b: Bounds): OptimizedPoint {
  const [, rMax] = feasibleReturnRange(mu, b);
  if (rMax <= rf) {
    throw new OptimizerError({
      code: "NO_EXCESS_RETURN",
      message: `ไม่มีพอร์ตที่ผลตอบแทนคาดหวังสูงกว่า Rf (${pct(rf)}) — ไม่มี tangency portfolio`,
      suggestion: "ตรวจสมมติฐานผลตอบแทนคาดหวัง หรือเลือก objective อื่น (เช่น minimum variance)",
    });
  }
  const score = (p: PortfolioPoint) => (p.sharpe != null && p.expectedReturn > rf ? p.sharpe : -Infinity);
  let lo = 0;
  let hi = cornerLambda(mu, cov, rf, b, 1);
  const g = (Math.sqrt(5) - 1) / 2;
  let c = hi - g * (hi - lo);
  let d = lo + g * (hi - lo);
  let pc = solveLambda(mu, cov, rf, c, b);
  let pd = solveLambda(mu, cov, rf, d, b);
  for (let i = 0; i < 200 && hi - lo > 1e-14 * Math.max(1, hi); i++) {
    if (score(pc) >= score(pd)) {
      hi = d;
      d = c;
      pd = pc;
      c = hi - g * (hi - lo);
      pc = solveLambda(mu, cov, rf, c, b);
    } else {
      lo = c;
      c = d;
      pc = pd;
      d = lo + g * (hi - lo);
      pd = solveLambda(mu, cov, rf, d, b);
    }
  }
  return [pc, pd, solveLambda(mu, cov, rf, 0, b), solveLambda(mu, cov, rf, cornerLambda(mu, cov, rf, b, 1), b)].reduce((a, x) => (score(x) > score(a) ? x : a));
}

/** Utility maximization: max μᵀw − (A/2) wᵀΣw  ⇔  λ = 2/A. */
export function utilityPortfolio(mu: number[], cov: Matrix, rf: number, riskAversion: number, b: Bounds): OptimizedPoint {
  assertBounds(mu.length, b);
  return solveLambda(mu, cov, rf, 2 / riskAversion, b);
}

/** Backwards-compatible helpers. */
export function constrainedMeanVariance(mu: number[], cov: Matrix, lambda: number, b: Bounds): number[] {
  return solveLambda(mu, cov, 0, lambda, b).weights;
}
export function constrainedTargetReturn(mu: number[], cov: Matrix, target: number, b: Bounds): number[] {
  return targetReturnPortfolio(mu, cov, 0, target, b).weights;
}
export function constrainedMaxSharpe(mu: number[], cov: Matrix, rf: number, b: Bounds): PortfolioPoint {
  return tangencyPortfolio(mu, cov, rf, b);
}

export interface ConstrainedFrontier {
  gmv: OptimizedPoint;
  tangency: OptimizedPoint | null;
  /** Both halves (bullet) under the constraints. */
  curve: { volatility: number; expectedReturn: number; efficient: boolean; weights: number[] }[];
}

/** Bullet under the bounds, traced by λ from the min-return corner (inefficient arm) to the max-return corner. */
export function constrainedFrontier(mu: number[], cov: Matrix, rf: number, b: Bounds, points = 30): ConstrainedFrontier {
  const gmv = gmvPortfolio(mu, cov, rf, b);
  const lTop = cornerLambda(mu, cov, rf, b, 1);
  const lBot = cornerLambda(mu, cov, rf, b, -1);
  const half = Math.max(2, Math.ceil(points / 2));
  const lambdas = [
    ...Array.from({ length: half }, (_, i) => lBot * (1 - i / (half - 1)) ** 2),
    ...Array.from({ length: half }, (_, i) => lTop * (i / (half - 1)) ** 2),
  ];
  const curve = lambdas.map((l) => {
    const p = solveLambda(mu, cov, rf, l, b);
    return { volatility: p.volatility, expectedReturn: p.expectedReturn, efficient: l >= 0, weights: p.weights };
  });
  curve.sort((a, c) => a.expectedReturn - c.expectedReturn);
  let tangency: OptimizedPoint | null = null;
  try {
    tangency = tangencyPortfolio(mu, cov, rf, b);
  } catch (e) {
    if (!(e instanceof OptimizerError)) throw e;
  }
  return { gmv, tangency, curve };
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
