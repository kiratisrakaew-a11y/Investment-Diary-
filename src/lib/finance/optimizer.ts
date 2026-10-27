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
import { covarianceDiagnostics, portfolioStats, type Matrix, type PortfolioPoint } from "./mpt";

export interface Bounds {
  min: number; // e.g. 0 for long-only
  max: number; // e.g. 1, or 0.4 for a 40% cap
  /** Optional per-asset bounds (override min/max for that asset). */
  lower?: (number | null)[];
  upper?: (number | null)[];
  /** Optional linear constraints lo ≤ aᵀw ≤ hi (issuer / sector / bucket caps, duration limits). */
  linear?: LinearConstraint[];
  /** Max gross exposure Σ|wᵢ| (long/short only; ≥ 1 under the Σw = 1 budget). Enforced with auxiliary variables. */
  gross?: number;
  /** Asset labels for constraint names in messages. */
  names?: string[];
}

export interface LinearConstraint {
  name: string;
  a: number[];
  lo?: number;
  hi?: number;
}

/** True when the problem needs the general-constraint solver (anything beyond one shared box). */
export const isGeneral = (b: Bounds) => !!(b.gross != null || b.linear?.length || b.lower?.some((x) => x != null) || b.upper?.some((x) => x != null));
const loOf = (b: Bounds, i: number) => b.lower?.[i] ?? b.min;
const hiOf = (b: Bounds, i: number) => b.upper?.[i] ?? b.max;

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

export type OptimizerIssueCode =
  | "INFEASIBLE_BOUNDS"
  | "INFEASIBLE_CONSTRAINTS"
  | "UNSUPPORTED_CONSTRAINT"
  | "INFEASIBLE_TARGET_RETURN"
  | "INFEASIBLE_TARGET_RISK"
  | "NO_EXCESS_RETURN"
  | "SHORT_SELLING_DISABLED"
  | "INVALID_INPUT";

export interface OptimizerIssue {
  code: OptimizerIssueCode;
  message: string;
  /** What the user can change to make the problem solvable. */
  suggestion?: string;
  /** Constraints that cannot hold together (INFEASIBLE_CONSTRAINTS). */
  constraints?: string[];
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
  if (isGeneral(b)) {
    if (!(n >= 1)) return { code: "INVALID_INPUT", message: "ต้องมีสินทรัพย์อย่างน้อย 1 ตัว" };
    let sumLo = 0;
    let sumHi = 0;
    for (let i = 0; i < n; i++) {
      const lo = loOf(b, i);
      const hi = hiOf(b, i);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return { code: "INVALID_INPUT", message: `ขอบเขตน้ำหนักของสินทรัพย์ลำดับ ${i + 1} ไม่ถูกต้อง (${pct(lo)} > ${pct(hi)})` };
      sumLo += lo;
      sumHi += hi;
    }
    for (const c of b.linear ?? []) {
      if (c.a.length !== n || !c.a.every(Number.isFinite)) return { code: "INVALID_INPUT", message: `ข้อจำกัด ${c.name}: ค่าสัมประสิทธิ์ไม่ครบ` };
      if (c.lo != null && c.hi != null && c.lo > c.hi + 1e-12) return { code: "INFEASIBLE_CONSTRAINTS", message: `ข้อจำกัด ${c.name}: ต่ำสุด > สูงสุด`, constraints: [c.name] };
    }
    if (sumHi < 1 - 1e-12) return { code: "INFEASIBLE_BOUNDS", message: `น้ำหนักสูงสุดรวมทุกตัว ${pct(sumHi)} < 100%`, suggestion: "เพิ่มน้ำหนักสูงสุดของบางสินทรัพย์" };
    if (b.gross != null && !(b.gross >= 1 - 1e-12))
      return { code: "INFEASIBLE_CONSTRAINTS", message: `Gross exposure สูงสุด ${pct(b.gross)} < 100% — ลงทุนครบ 100% ต้องมี Σ|w| ≥ 100%`, constraints: ["Gross exposure"] };
    if (sumLo > 1 + 1e-12) return { code: "INFEASIBLE_BOUNDS", message: `น้ำหนักต่ำสุดรวมทุกตัว ${pct(sumLo)} > 100%`, suggestion: "ลดน้ำหนักต่ำสุดของบางสินทรัพย์" };
    return null;
  }
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
  const linear = (b.linear ?? []).map((c) => {
    const v = dot(c.a, w);
    return Math.max(c.lo != null ? c.lo - v : 0, c.hi != null ? v - c.hi : 0);
  });
  const grossExcess = b.gross != null ? w.reduce((a, x) => a + Math.abs(x), 0) - b.gross : 0;
  return {
    sumError: Math.abs(w.reduce((a, x) => a + x, 0) - 1),
    maxBoundViolation: Math.max(0, ...w.map((x, i) => Math.max(loOf(b, i) - x, x - hiOf(b, i))), ...linear, grossExcess),
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
  if (isGeneral(b)) {
    // LP max/min μᵀw over the polytope: min ½‖w‖² ∓ K·μᵀw is piecewise linear in K and reaches the
    // LP vertex exactly for large K (well conditioned, unlike a vanishing quadratic term).
    const I = mu.map((_, i) => mu.map((__, j) => (i === j ? 1 : 0)));
    const spread = Math.max(Math.max(...mu) - Math.min(...mu), 1e-12);
    const extreme = (sign: 1 | -1) => {
      let K = 1 / spread;
      let prev = NaN;
      for (let k = 0; k < 200; k++) {
        const v = dot(solveGeneralQP(I, mu.map((m) => -sign * K * m), b).weights, mu);
        if (Math.abs(v - prev) <= 1e-15 * Math.max(1, Math.abs(v))) return v;
        prev = v;
        K *= 2;
      }
      return prev;
    };
    return [extreme(-1), extreme(1)];
  }
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

// ------------------------------------------------------------------ general linear constraints

/**
 * Dual active-set method (Goldfarb & Idnani, 1983) for
 *   min ½wᵀGw + cᵀw  s.t.  Σw = 1,  lo_i ≤ w_i ≤ hi_i,  lo_k ≤ a_kᵀw ≤ hi_k.
 * Starts from the unconstrained minimum and adds the most violated constraint each step, so no
 * feasible start is needed; an empty feasible set is detected and the conflicting constraints are
 * named (INFEASIBLE_CONSTRAINTS). G is made positive definite with a tiny ridge when needed.
 * Used only when per-asset bounds or linear constraints are given; the box-only path is unchanged.
 */
export function solveGeneralQP(Gw: Matrix, cw: number[], b: Bounds, maxIter = 2000): QpResult {
  const n = cw.length;
  assertBounds(n, b);
  // Gross exposure Σ|wᵢ| ≤ G: auxiliary tᵢ with tᵢ ≥ wᵢ, tᵢ ≥ −wᵢ, Σtᵢ ≤ G. The objective is lifted as
  // ½wᵀ(G − εI)w + ½ε‖t‖²: for fixed w the best t is tᵢ = |wᵢ|, so it equals ½wᵀGw exactly, while
  // ε = ½·λmin(G) keeps the extended matrix as well conditioned as G. The budget row stays on w only.
  const m = b.gross != null ? 2 * n : n;
  const pad = (v: number[]) => (m > n ? [...v, ...Array<number>(n).fill(0)] : v);
  const avgW = Gw.reduce((s, r, i) => s + Math.abs(r[i]), 0) / n || 1;
  const lamMin = m > n ? covarianceDiagnostics(Gw).minEigenvalue : 0;
  const eps = lamMin > 1e-10 * avgW ? 0.5 * lamMin : 1e-9 * avgW;
  const Gin =
    m > n
      ? Array.from({ length: m }, (_, i) => Array.from({ length: m }, (__, j) => (i < n && j < n ? Gw[i][j] - (i === j && lamMin > 1e-10 * avgW ? eps : 0) : i === j ? eps : 0)))
      : Gw;
  const c = pad(cw);
  // Constraints as nᵀw ≥ β (equalities flagged).
  const rows: { v: number[]; beta: number; eq: boolean; name: string }[] = [{ v: pad(cw.map(() => 1)), beta: 1, eq: true, name: "ลงทุนครบ 100%" }];
  for (let i = 0; i < n; i++) {
    const e = c.map((_, j) => (j === i ? 1 : 0));
    const lo = loOf(b, i);
    const hi = hiOf(b, i);
    const label = b.names?.[i] ?? `สินทรัพย์ ${i + 1}`;
    if (Number.isFinite(lo)) rows.push({ v: e, beta: lo, eq: false, name: `${label} ≥ ${pct(lo)}` });
    if (Number.isFinite(hi)) rows.push({ v: e.map((x) => -x), beta: -hi, eq: false, name: `${label} ≤ ${pct(hi)}` });
  }
  for (const k of b.linear ?? []) {
    if (k.lo != null) rows.push({ v: pad([...k.a]), beta: k.lo, eq: false, name: `${k.name} ≥ ${pct(k.lo)}` });
    if (k.hi != null) rows.push({ v: pad(k.a.map((x) => -x)), beta: -k.hi, eq: false, name: `${k.name} ≤ ${k.hi < 1.5 ? pct(k.hi) : k.hi.toFixed(4)}` });
  }
  if (m > n) {
    for (let i = 0; i < n; i++) {
      const label = b.names?.[i] ?? `สินทรัพย์ ${i + 1}`;
      rows.push({ v: c.map((_, j) => (j === n + i ? 1 : j === i ? -1 : 0)), beta: 0, eq: false, name: `|${label}| (aux ≥ w)` });
      rows.push({ v: c.map((_, j) => (j === n + i ? 1 : j === i ? 1 : 0)), beta: 0, eq: false, name: `|${label}| (aux ≥ −w)` });
    }
    rows.push({ v: c.map((_, j) => (j >= n ? -1 : 0)), beta: -b.gross!, eq: false, name: `Gross exposure ≤ ${pct(b.gross!)}` });
  }
  const avgDiag = Gin.reduce((s, r, i) => s + Math.abs(r[i]), 0) / n || 1;
  let ridge = 0;
  let Ginv = invert(Gin);
  // Positive definiteness check through the inverse; add the smallest ridge that makes G invertible.
  while (!Ginv || Ginv.some((r, i) => !(r[i] > 0))) {
    ridge = ridge ? ridge * 10 : 1e-12 * avgDiag;
    Ginv = invert(Gin.map((r, i) => r.map((x, j) => (i === j ? x + ridge : x))));
    if (ridge > 1e-3 * avgDiag) break;
  }
  if (!Ginv) throw new OptimizerError({ code: "INVALID_INPUT", message: "covariance ใช้คำนวณไม่ได้ (singular)" });
  const G = Gin.map((r, i) => r.map((x, j) => (i === j ? x + ridge : x)));
  const tol = 1e-12 * Math.max(1, avgDiag);

  let x = matVec(Ginv, c).map((v) => -v);
  const active: number[] = [];
  let u: number[] = [];
  const directions = (np: number[]) => {
    // N* = (NᵀG⁻¹N)⁻¹NᵀG⁻¹ ; z = (G⁻¹ − G⁻¹N N*) n⁺ ; r = N* n⁺
    if (!active.length) return { z: matVec(Ginv!, np), r: [] as number[] };
    const N = active.map((k) => rows[k].v);
    const GiN = N.map((v) => matVec(Ginv!, v));
    const M = N.map((vi) => GiN.map((gj) => dot(vi, gj)));
    const Minv = invert(M);
    if (!Minv) return null;
    const Ginp = matVec(Ginv!, np);
    const NtGinp = N.map((v) => dot(v, Ginp));
    const r = matVec(Minv, NtGinp);
    const z = Ginp.map((g, i) => g - GiN.reduce((s, col, k) => s + col[i] * r[k], 0));
    return { z, r };
  };

  let iterations = 0;
  const addOrder = [...rows.keys()].filter((k) => rows[k].eq);
  let infeasible: string[] | null = null;
  outer: for (; iterations < maxIter; iterations++) {
    // Pick the constraint to add: pending equalities first, then the most violated inequality.
    let p = -1;
    let sign = 1;
    if (addOrder.length) {
      p = addOrder.shift()!;
      sign = dot(rows[p].v, x) - rows[p].beta > 0 ? -1 : 1;
    } else {
      let worst = -tol * 10;
      rows.forEach((row, k) => {
        if (row.eq || active.includes(k)) return;
        const sk = dot(row.v, x) - row.beta;
        if (sk < worst) {
          worst = sk;
          p = k;
        }
      });
      if (p < 0) break;
    }
    const np = rows[p].v.map((v) => v * sign);
    const betaP = rows[p].beta * sign;
    let uPlus = [...u, 0];
    for (let inner = 0; inner < 10 * rows.length + 10; inner++) {
      const d = directions(np);
      if (!d) {
        infeasible = [rows[p].name, ...active.map((k) => rows[k].name)];
        break outer;
      }
      const { z, r } = d;
      // Partial step: largest dual step keeping inequality multipliers ≥ 0.
      let t2 = Infinity;
      let drop = -1;
      active.forEach((k, j) => {
        if (rows[k].eq || !(r[j] > 1e-12 * Math.max(1, Math.abs(r[j])))) return;
        const tj = uPlus[j] / r[j];
        if (tj < t2) {
          t2 = tj;
          drop = j;
        }
      });
      const zn = dot(z, np);
      const sp = dot(np, x) - betaP;
      // z = 0 means n⁺ depends linearly on the active set; judge it relative to ‖G⁻¹n⁺‖ (rounding-safe).
      const scaleZ = Math.max(...matVec(Ginv!, np).map(Math.abs), 1e-300);
      if (Math.max(...z.map(Math.abs)) <= 1e-9 * scaleZ || Math.abs(zn) <= 1e-12 * scaleZ * Math.max(...np.map(Math.abs))) {
        if (!Number.isFinite(t2)) {
          // No primal step and no constraint to drop: the constraint set is empty.
          infeasible = [rows[p].name, ...active.filter((k) => !rows[k].eq).map((k) => rows[k].name)];
          break outer;
        }
        uPlus = uPlus.map((v, j) => (j < active.length ? v - t2 * r[j] : v + t2));
        active.splice(drop, 1);
        uPlus.splice(drop, 1);
        continue;
      }
      const t1 = -sp / zn;
      const t = Math.min(t1, t2);
      x = x.map((xi, i) => xi + t * z[i]);
      uPlus = uPlus.map((v, j) => (j < active.length ? v - t * r[j] : v + t));
      if (t1 <= t2) {
        // Full step: the new constraint becomes active (stored with its sign).
        if (sign < 0) rows[p] = { ...rows[p], v: np, beta: betaP };
        active.push(p);
        u = uPlus;
        continue outer;
      }
      active.splice(drop, 1);
      uPlus.splice(drop, 1);
    }
  }
  if (infeasible) {
    throw new OptimizerError({
      code: "INFEASIBLE_CONSTRAINTS",
      message: `ข้อจำกัดขัดกัน — ไม่มีน้ำหนักที่ผ่านทุกข้อพร้อมกัน: ${[...new Set(infeasible)].join(" · ")}`,
      suggestion: "ผ่อนข้อจำกัดใดข้อหนึ่งในรายการนี้ (ระบบไม่ผ่อนให้เอง)",
      constraints: [...new Set(infeasible)],
    });
  }
  // Polish: solve the KKT system on the final active set directly ([G −N; Nᵀ 0][x; u] = [−c; β]),
  // removing drift accumulated over many steps; kept only if feasible with valid multipliers.
  if (active.length) {
    const m = active.length;
    const K = [
      ...G.map((row, i) => [...row, ...active.map((k) => -rows[k].v[i])]),
      ...active.map((k) => [...rows[k].v, ...Array<number>(m).fill(0)]),
    ];
    const sol = solveLinear(K, [...c.map((v) => -v), ...active.map((k) => rows[k].beta)]);
    if (sol) {
      const xp = sol.slice(0, n);
      const up = sol.slice(n);
      const feasible = rows.every((row) => dot(row.v, xp) - row.beta >= -1e-10 * Math.max(1, Math.abs(row.beta)) || (row.eq && Math.abs(dot(row.v, xp) - row.beta) <= 1e-10));
      const dualOk = active.every((k, j) => rows[k].eq || up[j] >= -1e-9 * Math.max(1, ...up.map(Math.abs)));
      if (feasible && dualOk) {
        x = xp;
        u = up;
      }
    }
  }
  // KKT residual: stationarity Gx + c − Σ u_k n_k, dual feasibility (u ≥ 0 for inequalities), primal feasibility.
  const g = matVec(G, x).map((v, i) => v + c[i]);
  active.forEach((k, j) => rows[k].v.forEach((v, i) => (g[i] -= u[j] * v)));
  const dualViol = Math.max(0, ...active.map((k, j) => (rows[k].eq ? 0 : -u[j])));
  const weights = x.slice(0, n);
  const chk = checkWeights(weights, b);
  return {
    weights,
    status: iterations < maxIter ? "optimal" : "max_iterations",
    iterations,
    kktResidual: Math.max(...g.map(Math.abs), dualViol),
    ...chk,
    regularized: ridge > 0,
  };
}

// ------------------------------------------------------------------ constrained frontier

export type SolverDiagnostics = Omit<QpResult, "weights">;
export type OptimizedPoint = PortfolioPoint & { solver: SolverDiagnostics; lambda: number };

/** min wᵀΣw − λ μᵀw  under the bounds (λ = 0: GMV; λ < 0 traces the inefficient arm). */
function solveLambda(mu: number[], cov: Matrix, rf: number, lambda: number, b: Bounds): OptimizedPoint {
  const r = (isGeneral(b) ? solveGeneralQP : solveBoxQP)(
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
