/**
 * Risk-based portfolio construction (Strategies Phase 2). Pure and deterministic.
 *
 *  - Risk budgeting / equal risk contribution (ERC): Newton's method on Spinu's convex problem
 *    min ½yᵀΣy − Σ bᵢ ln yᵢ (y > 0), then w = y / Σy, so RCᵢ / σ_p = bᵢ. Long-only, fully invested;
 *    per-asset bounds and linear constraints are not imposed — a solution that violates them is
 *    reported, never silently clipped.
 *  - Maximum diversification: max σᵀw / √(wᵀΣw). With z = D y (D = diag σ) it is
 *    min zᵀCz s.t. Σz = 1 (C = correlation); weight bounds and linear constraints become homogeneous
 *    linear constraints in z, so the existing general QP (`solveGeneralQP`) solves it.
 *  - Minimum CVaR (Rockafellar–Uryasev): min ζ + 1/((1−α)T) Σ uₜ, uₜ ≥ −rₜᵀw − ζ, uₜ ≥ 0, a linear
 *    program solved by a small dense two-phase simplex below (the QP needs a positive-definite G).
 */
import { invert, solveGeneralQP, type Bounds, type LinearConstraint } from "./optimizer";
import type { Matrix } from "./mpt";

// ------------------------------------------------------------------ linear programming

export interface LpRow {
  a: number[];
  op: "<=" | ">=" | "=";
  b: number;
}

export interface LpResult {
  status: "optimal" | "infeasible" | "unbounded" | "iteration_limit";
  x: number[];
  objective: number;
  iterations: number;
}

/**
 * min cᵀx s.t. rows, x ≥ 0. Dense two-phase tableau simplex: Dantzig pricing, switching to Bland's
 * rule after repeated degenerate pivots (no cycling). Unit columns already present are used as the
 * starting basis, so artificials are added only where needed.
 */
export function solveLP(c: number[], rows: LpRow[], maxIter = 20000): LpResult {
  const n = c.length;
  const m = rows.length;
  const tol = 1e-9;
  // Normalize to b ≥ 0.
  const R = rows.map((r) => (r.b < 0 ? { a: r.a.map((v) => -v), op: r.op === "<=" ? ">=" : r.op === ">=" ? "<=" : "=", b: -r.b } : { ...r, a: [...r.a] }) as LpRow);
  // Columns: original | slack/surplus | artificial.
  const slackOf: number[] = Array(m).fill(-1);
  let cols = n;
  for (let i = 0; i < m; i++) if (R[i].op !== "=") slackOf[i] = cols++;
  // A unit column among originals (coefficient 1 here, 0 in every other row) can start in the basis.
  const isUnitIn = (j: number): number => {
    let row = -1;
    for (let i = 0; i < m; i++) {
      const v = R[i].a[j];
      if (Math.abs(v) > tol) {
        if (row >= 0 || Math.abs(v - 1) > tol) return -1;
        row = i;
      }
    }
    return row;
  };
  const basis: number[] = Array(m).fill(-1);
  const unitRow = new Map<number, number>();
  for (let j = 0; j < n; j++) {
    const r = isUnitIn(j);
    if (r >= 0 && !unitRow.has(r)) unitRow.set(r, j);
  }
  for (let i = 0; i < m; i++) {
    if (R[i].op === "<=") basis[i] = slackOf[i];
    else if (unitRow.has(i)) basis[i] = unitRow.get(i)!;
  }
  const artOf: number[] = Array(m).fill(-1);
  for (let i = 0; i < m; i++) if (basis[i] < 0) basis[i] = artOf[i] = cols++;
  const W = cols + 1;
  const T: Float64Array[] = Array.from({ length: m }, () => new Float64Array(W));
  for (let i = 0; i < m; i++) {
    const row = T[i];
    for (let j = 0; j < n; j++) row[j] = R[i].a[j];
    if (slackOf[i] >= 0) row[slackOf[i]] = R[i].op === "<=" ? 1 : -1;
    if (artOf[i] >= 0) row[artOf[i]] = 1;
    row[cols] = R[i].b;
  }
  const isArt = new Uint8Array(cols);
  for (const a of artOf) if (a >= 0) isArt[a] = 1;
  let iterations = 0;

  const run = (cost: Float64Array, allowArt: boolean): "optimal" | "unbounded" | "iteration_limit" => {
    // Reduced costs d_j = c_j − Σ c_B(i) T[i][j]; objective value in d[cols] (negated).
    const d = new Float64Array(W);
    for (let j = 0; j < W; j++) d[j] = j < cols ? cost[j] : 0;
    for (let i = 0; i < m; i++) {
      const cb = cost[basis[i]];
      if (cb !== 0) for (let j = 0; j < W; j++) d[j] -= cb * T[i][j];
    }
    let degenerate = 0;
    while (iterations < maxIter) {
      const bland = degenerate > 50;
      let e = -1;
      let best = -tol;
      for (let j = 0; j < cols; j++) {
        if (!allowArt && isArt[j]) continue;
        if (d[j] < best) {
          e = j;
          if (bland) break;
          best = d[j];
        }
      }
      if (e < 0) return "optimal";
      let leave = -1;
      let ratio = Infinity;
      for (let i = 0; i < m; i++) {
        const v = T[i][e];
        if (v > tol) {
          const r = T[i][cols] / v;
          if (r < ratio - 1e-12 || (Math.abs(r - ratio) <= 1e-12 && leave >= 0 && basis[i] < basis[leave])) {
            ratio = r;
            leave = i;
          }
        }
      }
      if (leave < 0) return "unbounded";
      degenerate = ratio <= tol ? degenerate + 1 : 0;
      // Pivot.
      const pr = T[leave];
      const pv = pr[e];
      for (let j = 0; j < W; j++) pr[j] /= pv;
      for (let i = 0; i < m; i++) {
        if (i === leave) continue;
        const f = T[i][e];
        if (f !== 0) {
          const row = T[i];
          for (let j = 0; j < W; j++) row[j] -= f * pr[j];
        }
      }
      const fd = d[e];
      if (fd !== 0) for (let j = 0; j < W; j++) d[j] -= fd * pr[j];
      basis[leave] = e;
      iterations++;
    }
    return "iteration_limit";
  };

  const extract = () => {
    const x = Array(n).fill(0);
    for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i][cols];
    return x;
  };
  if (artOf.some((a) => a >= 0)) {
    const c1 = new Float64Array(cols);
    for (let j = 0; j < cols; j++) c1[j] = isArt[j] ? 1 : 0;
    const s1 = run(c1, true);
    if (s1 === "iteration_limit") return { status: "iteration_limit", x: extract(), objective: NaN, iterations };
    const infeas = basis.reduce((s, b, i) => s + (isArt[b] ? T[i][cols] : 0), 0);
    if (infeas > 1e-7 * Math.max(1, ...R.map((r) => Math.abs(r.b)))) return { status: "infeasible", x: extract(), objective: NaN, iterations };
    // Drive zero-level artificials out of the basis where possible.
    for (let i = 0; i < m; i++) {
      if (!isArt[basis[i]]) continue;
      const j = T[i].findIndex((v, k) => k < cols && !isArt[k] && Math.abs(v) > 1e-9);
      if (j < 0) continue; // redundant row; the artificial stays basic at zero and never re-enters
      const pr = T[i];
      const pv = pr[j];
      for (let k = 0; k < W; k++) pr[k] /= pv;
      for (let r = 0; r < m; r++) {
        if (r === i) continue;
        const f = T[r][j];
        if (f !== 0) for (let k = 0; k < W; k++) T[r][k] -= f * pr[k];
      }
      basis[i] = j;
    }
  }
  const c2 = new Float64Array(cols);
  for (let j = 0; j < n; j++) c2[j] = c[j];
  const s2 = run(c2, false);
  const x = extract();
  return { status: s2, x, objective: c.reduce((s, cj, j) => s + cj * x[j], 0), iterations };
}

// ------------------------------------------------------------------ helpers

const matVec = (A: Matrix, x: number[]) => A.map((r) => r.reduce((s, v, j) => s + v * x[j], 0));
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

export interface RiskReport {
  /** RCᵢ / σ_p (shares of portfolio volatility). */
  riskShares: number[];
  volatility: number;
  diversificationRatio: number;
}

export function riskReport(w: number[], cov: Matrix): RiskReport {
  const sw = matVec(cov, w);
  const v = dot(w, sw);
  const vol = Math.sqrt(Math.max(v, 0));
  const sig = cov.map((r, i) => Math.sqrt(Math.max(r[i], 0)));
  return { riskShares: w.map((wi, i) => (v > 0 ? (wi * sw[i]) / v : 0)), volatility: vol, diversificationRatio: vol > 0 ? dot(sig, w) / vol : NaN };
}

export interface RiskStrategyResult {
  ok: boolean;
  status: "optimal" | "nonconverged" | "infeasible" | "unsupported" | "invalid";
  weights: number[];
  iterations: number;
  /** ERC: max |∇f|; MDP: QP KKT residual; CVaR: 0 at an LP optimum. */
  residual: number;
  message?: string;
  warnings: string[];
}

const fail = (status: RiskStrategyResult["status"], message: string, n: number): RiskStrategyResult => ({ ok: false, status, weights: Array(n).fill(NaN), iterations: 0, residual: NaN, message, warnings: [] });

function zeroVol(cov: Matrix) {
  return cov.map((r, i) => i).filter((i) => !(cov[i][i] > 1e-14));
}

// ------------------------------------------------------------------ risk budgeting / ERC

/** Weights whose risk contributions match `budgets` (default equal). */
export function riskBudgetWeights(cov: Matrix, budgets?: number[], opts: { tol?: number; maxIter?: number } = {}): RiskStrategyResult & { budgets: number[]; maxDeviation: number } {
  const n = cov.length;
  const b0 = budgets ?? Array(n).fill(1 / n);
  const extra = { budgets: b0, maxDeviation: NaN };
  if (b0.length !== n || b0.some((v) => !(v > 0))) return { ...fail("invalid", "risk budget ทุกตัวต้อง > 0", n), ...extra };
  const sb = b0.reduce((a, v) => a + v, 0);
  const b = b0.map((v) => v / sb);
  const zv = zeroVol(cov);
  if (zv.length) return { ...fail("invalid", `สินทรัพย์ลำดับ ${zv.map((i) => i + 1).join(", ")} ความผันผวนเป็นศูนย์ — risk contribution ไม่นิยาม`, n), budgets: b, maxDeviation: NaN };
  const tol = opts.tol ?? 1e-10;
  const maxIter = opts.maxIter ?? 200;
  const sig = cov.map((r, i) => Math.sqrt(r[i]));
  let y = b.map((bi, i) => bi / sig[i]);
  const f = (v: number[]) => 0.5 * dot(v, matVec(cov, v)) - b.reduce((s, bi, i) => s + bi * Math.log(v[i]), 0);
  let it = 0;
  let g = matVec(cov, y).map((v, i) => v - b[i] / y[i]);
  while (it < maxIter && Math.max(...g.map(Math.abs)) > tol) {
    const H = cov.map((r, i) => r.map((v, j) => v + (i === j ? b[i] / (y[i] * y[i]) : 0)));
    const Hi = invert(H);
    if (!Hi) return { ...fail("nonconverged", "Hessian singular", n), budgets: b, maxDeviation: NaN };
    const d = matVec(Hi, g).map((v) => -v);
    let t = 1;
    while (y.some((v, i) => v + t * d[i] <= 0)) t /= 2;
    const f0 = f(y);
    const slope = dot(g, d);
    while (f(y.map((v, i) => v + t * d[i])) > f0 + 1e-4 * t * slope && t > 1e-12) t /= 2;
    y = y.map((v, i) => v + t * d[i]);
    g = matVec(cov, y).map((v, i) => v - b[i] / y[i]);
    it++;
  }
  const sy = y.reduce((a, v) => a + v, 0);
  const w = y.map((v) => v / sy);
  const rep = riskReport(w, cov);
  const maxDeviation = Math.max(...rep.riskShares.map((s, i) => Math.abs(s - b[i])));
  const residual = Math.max(...g.map(Math.abs));
  const converged = residual <= tol * 10 && maxDeviation < 1e-6;
  return { ok: converged, status: converged ? "optimal" : "nonconverged", weights: w, iterations: it, residual, warnings: converged ? [] : [`ยังไม่ลู่เข้า: ส่วนต่างความเสี่ยงสูงสุด ${maxDeviation.toExponential(2)}`], budgets: b, maxDeviation };
}

// ------------------------------------------------------------------ maximum diversification

const boundArrays = (n: number, bd: Bounds) => ({
  lo: Array.from({ length: n }, (_, i) => bd.lower?.[i] ?? bd.min),
  hi: Array.from({ length: n }, (_, i) => bd.upper?.[i] ?? bd.max),
});

/** Maximum diversification ratio under the same bounds / linear constraints as the optimizer. */
export function maxDiversificationWeights(cov: Matrix, bd: Bounds): RiskStrategyResult & { diversificationRatio: number } {
  const n = cov.length;
  const zv = zeroVol(cov);
  if (zv.length) return { ...fail("invalid", `สินทรัพย์ลำดับ ${zv.map((i) => i + 1).join(", ")} ความผันผวนเป็นศูนย์`, n), diversificationRatio: NaN };
  if (bd.min < 0) return { ...fail("unsupported", "Maximum diversification รองรับเฉพาะ long-only", n), diversificationRatio: NaN };
  const sig = cov.map((r, i) => Math.sqrt(r[i]));
  const C = cov.map((r, i) => r.map((v, j) => v / (sig[i] * sig[j])));
  const { lo, hi } = boundArrays(n, bd);
  // w = (z/σ) / Σ(z/σ): a bound on w is a homogeneous linear constraint on z.
  const inv = sig.map((s) => 1 / s);
  const linear: LinearConstraint[] = [];
  for (let i = 0; i < n; i++) {
    if (hi[i] < 1 - 1e-12) linear.push({ name: `${bd.names?.[i] ?? i + 1} ≤ ${hi[i]}`, a: inv.map((v, j) => (j === i ? v : 0) - hi[i] * v), hi: 0 });
    if (lo[i] > 1e-12) linear.push({ name: `${bd.names?.[i] ?? i + 1} ≥ ${lo[i]}`, a: inv.map((v, j) => lo[i] * v - (j === i ? v : 0)), hi: 0 });
  }
  for (const L of bd.linear ?? []) {
    if (L.hi != null) linear.push({ name: L.name, a: L.a.map((aj, j) => (aj - L.hi!) * inv[j]), hi: 0 });
    if (L.lo != null) linear.push({ name: L.name, a: L.a.map((aj, j) => (L.lo! - aj) * inv[j]), hi: 0 });
  }
  const qp = solveGeneralQP(C, Array(n).fill(0), { min: 0, max: 1, names: bd.names, ...(linear.length ? { linear } : {}) });
  const y = qp.weights.map((z, i) => Math.max(z, 0) / sig[i]);
  const sy = y.reduce((a, v) => a + v, 0);
  const w = y.map((v) => v / sy);
  const dr = riskReport(w, cov).diversificationRatio;
  return { ok: qp.status === "optimal", status: qp.status === "optimal" ? "optimal" : "nonconverged", weights: w, iterations: qp.iterations, residual: qp.kktResidual, warnings: qp.regularized ? ["covariance singular — เติม ridge เล็กน้อย"] : [], diversificationRatio: dr };
}

// ------------------------------------------------------------------ minimum CVaR

/**
 * Minimum historical CVaR at confidence α over scenarios (returns per asset × period, same periods).
 * Respects box / per-asset bounds, linear constraints and an optional minimum expected return.
 */
export function minCvarWeights(x: { scenarios: number[][]; alpha: number; bounds: Bounds; mu?: number[]; minReturn?: number }): RiskStrategyResult & { cvar: number; valueAtRisk: number; observations: number } {
  const n = x.scenarios.length;
  const T = x.scenarios[0]?.length ?? 0;
  const out = (r: RiskStrategyResult) => ({ ...r, cvar: NaN, valueAtRisk: NaN, observations: T });
  if (!(x.alpha > 0 && x.alpha < 1)) return out(fail("invalid", "ระดับความเชื่อมั่นต้องอยู่ระหว่าง 0 และ 1", n));
  if (T < Math.ceil(2 / (1 - x.alpha))) return out(fail("invalid", `ต้องมีข้อมูลอย่างน้อย ${Math.ceil(2 / (1 - x.alpha))} งวด (มี ${T})`, n));
  if (x.scenarios.some((s) => s.length !== T || s.some((v) => !Number.isFinite(v)))) return out(fail("invalid", "ผลตอบแทนแต่ละสินทรัพย์ต้องมีจำนวนงวดเท่ากันและเป็นตัวเลข", n));
  const { lo, hi } = boundArrays(n, x.bounds);
  const sumLo = lo.reduce((a, v) => a + v, 0);
  // Variables: w' (n) = w − lo ≥ 0, ζ⁺, ζ⁻, u (T).
  const N = n + 2 + T;
  const zeros = () => Array(N).fill(0);
  const rows: LpRow[] = [];
  for (let t = 0; t < T; t++) {
    const a = zeros();
    let rl = 0;
    for (let i = 0; i < n; i++) {
      a[i] = x.scenarios[i][t];
      rl += x.scenarios[i][t] * lo[i];
    }
    a[n] = 1;
    a[n + 1] = -1;
    a[n + 2 + t] = 1;
    rows.push({ a, op: ">=", b: -rl });
  }
  const budget = zeros();
  for (let i = 0; i < n; i++) budget[i] = 1;
  rows.push({ a: budget, op: "=", b: 1 - sumLo });
  for (let i = 0; i < n; i++) {
    if (hi[i] - lo[i] < 1 - sumLo - 1e-12) {
      const a = zeros();
      a[i] = 1;
      rows.push({ a, op: "<=", b: hi[i] - lo[i] });
    }
  }
  for (const L of x.bounds.linear ?? []) {
    const a = zeros();
    for (let i = 0; i < n; i++) a[i] = L.a[i];
    const shift = L.a.reduce((s, ai, i) => s + ai * lo[i], 0);
    if (L.hi != null) rows.push({ a, op: "<=", b: L.hi - shift });
    if (L.lo != null) rows.push({ a: [...a], op: ">=", b: L.lo - shift });
  }
  if (x.minReturn != null && x.mu) {
    const a = zeros();
    for (let i = 0; i < n; i++) a[i] = x.mu[i];
    rows.push({ a, op: ">=", b: x.minReturn - x.mu.reduce((s, m, i) => s + m * lo[i], 0) });
  }
  const c = zeros();
  c[n] = 1;
  c[n + 1] = -1;
  for (let t = 0; t < T; t++) c[n + 2 + t] = 1 / ((1 - x.alpha) * T);
  const lp = solveLP(c, rows);
  if (lp.status !== "optimal") {
    return out({ ...fail(lp.status === "infeasible" ? "infeasible" : "nonconverged", lp.status === "infeasible" ? "ข้อจำกัดขัดกัน (เช่น ผลตอบแทนขั้นต่ำสูงเกินไป หรือเพดานรวมกันไม่ถึง 100%)" : `LP ไม่สำเร็จ (${lp.status})`, n), iterations: lp.iterations });
  }
  const w = lo.map((l, i) => l + lp.x[i]);
  return { ok: true, status: "optimal", weights: w, iterations: lp.iterations, residual: 0, warnings: [], cvar: lp.objective, valueAtRisk: lp.x[n] - lp.x[n + 1], observations: T };
}
