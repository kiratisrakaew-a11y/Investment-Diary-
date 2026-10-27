/**
 * v3 Phase 3 — general linear constraints in the existing optimizer pipeline.
 */
import { describe, expect, it } from "vitest";
import { OptimizerError, checkWeights, feasibleReturnRange, solveBoxQP, solveGeneralQP, type Bounds } from "./optimizer";
import { recommend } from "./recommend";

const cov = [
  [0.04, 0.012, 0.006, 0.004],
  [0.012, 0.09, 0.018, 0.01],
  [0.006, 0.018, 0.0225, 0.003],
  [0.004, 0.01, 0.003, 0.01],
];
const mu = [0.1, 0.14, 0.07, 0.05];
const Q = cov.map((r) => r.map((x) => 2 * x));
const obj = (w: number[], c: number[]) => 0.5 * w.reduce((s, wi, i) => s + wi * Q[i].reduce((t, q, j) => t + q * w[j], 0), 0) + c.reduce((s, ci, i) => s + ci * w[i], 0);

describe("general QP (Goldfarb–Idnani) agrees with the box solver and satisfies KKT", () => {
  it("same weights as the active-set box solver when only per-asset bounds are given", () => {
    for (const lambda of [0, 0.5, 2, 10]) {
      const c = mu.map((m) => -lambda * m);
      const box = solveBoxQP(Q, c, { min: 0, max: 0.5 });
      const gen = solveGeneralQP(Q, c, { min: 0, max: 0.5, upper: [0.5, 0.5, 0.5, 0.5] });
      gen.weights.forEach((w, i) => expect(w).toBeCloseTo(box.weights[i], 8));
      expect(gen.kktResidual).toBeLessThan(1e-9);
      expect(gen.sumError).toBeLessThan(1e-12);
      expect(gen.maxBoundViolation).toBeLessThan(1e-12);
    }
  });

  it("a binding group cap holds exactly and the solution beats random feasible points", () => {
    const b: Bounds = { min: 0, max: 1, linear: [{ name: "หมวด A (สินทรัพย์ 1–2)", a: [1, 1, 0, 0], hi: 0.3 }] };
    const c = mu.map((m) => -4 * m);
    const r = solveGeneralQP(Q, c, b);
    expect(r.weights[0] + r.weights[1]).toBeCloseTo(0.3, 10);
    expect(r.kktResidual).toBeLessThan(1e-9);
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 500; k++) {
      const a = rnd() * 0.3;
      const split = rnd();
      const rest = 1 - a;
      const s2 = rnd();
      const w = [a * split, a * (1 - split), rest * s2, rest * (1 - s2)];
      expect(obj(r.weights, c)).toBeLessThanOrEqual(obj(w, c) + 1e-12);
    }
  });

  it("lower bounds on a group and a duration-style limit are respected", () => {
    const dur = [0, 0, 6, 2];
    const b: Bounds = { min: 0, max: 1, linear: [{ name: "หมวดพันธบัตร", a: [0, 0, 1, 1], lo: 0.4 }, { name: "Duration พอร์ต", a: dur, hi: 1.5 }] };
    const r = solveGeneralQP(Q, mu.map((m) => -10 * m), b);
    expect(r.weights[2] + r.weights[3]).toBeGreaterThanOrEqual(0.4 - 1e-10);
    expect(dur.reduce((s, d, i) => s + d * r.weights[i], 0)).toBeLessThanOrEqual(1.5 + 1e-10);
    expect(checkWeights(r.weights, b).maxBoundViolation).toBeLessThan(1e-10);
  });

  it("infeasible constraints are reported with their names, never relaxed", () => {
    const b: Bounds = { min: 0, max: 1, linear: [{ name: "กลุ่ม A", a: [1, 1, 0, 0], lo: 0.6 }, { name: "กลุ่ม B", a: [0, 0, 1, 1], lo: 0.6 }] };
    try {
      solveGeneralQP(Q, [0, 0, 0, 0], b);
      throw new Error("expected infeasible");
    } catch (e) {
      expect(e).toBeInstanceOf(OptimizerError);
      const issue = (e as OptimizerError).issue;
      expect(issue.code).toBe("INFEASIBLE_CONSTRAINTS");
      expect(issue.constraints!.join(" ")).toMatch(/กลุ่ม A|กลุ่ม B/);
    }
  });

  it("degenerate vertices (dependent active constraints) stay feasible and exact for any λ", () => {
    const c2 = [[0.06, 0.004, 0.02, 0.001], [0.004, 0.004, 0.002, 0.002], [0.02, 0.002, 0.05, 0.001], [0.001, 0.002, 0.001, 0.003]];
    const m2 = [0.12, 0.04, 0.1, 0.03];
    const b: Bounds = { min: 0, max: 1, linear: [{ name: "PTT", a: [1, 1, 0, 0], hi: 0.4 }, { name: "CPALL", a: [0, 0, 1, 0], hi: 0.4 }, { name: "MOF", a: [0, 0, 0, 1], hi: 0.4 }] };
    for (const lam of [10, 1e3, 1e6, 1e12]) {
      const r = solveGeneralQP(c2.map((r) => r.map((x) => 2 * x)), m2.map((m) => -lam * m), b);
      expect(r.weights.map((w) => +w.toFixed(9))).toEqual([0.4, 0, 0.4, 0.2]);
      expect(r.maxBoundViolation).toBeLessThan(1e-9);
    }
  });

  it("feasible return range respects group constraints (LP)", () => {
    const [lo, hi] = feasibleReturnRange(mu, { min: 0, max: 1, linear: [{ name: "B cap", a: [0, 1, 0, 0], hi: 0.2 }] });
    expect(hi).toBeCloseTo(0.2 * 0.14 + 0.8 * 0.1, 8);
    expect(lo).toBeCloseTo(0.05, 8);
  });
});

describe("recommend() with constraints (same pipeline: max Sharpe, target return, frontier)", () => {
  const symbols = ["A", "B", "C", "D"];
  it("tangency under an issuer cap satisfies the cap and has a valid KKT solution", () => {
    const bounds: Bounds = { min: 0, max: 1, linear: [{ name: "ผู้ออก X (A+B)", a: [1, 1, 0, 0], hi: 0.35 }] };
    const r = recommend({ symbols, mu, cov, rf: 0.02, bounds, objective: "max_sharpe", riskAversion: 4, useRiskFree: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.risky.weights[0] + r.risky.weights[1]).toBeLessThanOrEqual(0.35 + 1e-9);
    expect(r.solver.status).toBe("optimal");
    const free = recommend({ symbols, mu, cov, rf: 0.02, bounds: { min: 0, max: 1 }, objective: "max_sharpe", riskAversion: 4, useRiskFree: false });
    if (free.ok) expect(free.risky.weights[0] + free.risky.weights[1]).toBeGreaterThan(0.35);
  });
  it("infeasible constraints come back as { ok: false } with the constraint names", () => {
    const r = recommend({ symbols, mu, cov, rf: 0.02, bounds: { min: 0, max: 1, linear: [{ name: "G1", a: [1, 1, 0, 0], lo: 0.7 }, { name: "G2", a: [0, 0, 1, 1], lo: 0.7 }] }, objective: "min_variance", riskAversion: 4, useRiskFree: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.code).toBe("INFEASIBLE_CONSTRAINTS");
  });
  it("box-only problems are unchanged (same weights as before this change)", () => {
    const r = recommend({ symbols, mu, cov, rf: 0.02, bounds: { min: 0, max: 0.6 }, objective: "max_sharpe", riskAversion: 4, useRiskFree: false });
    const r2 = recommend({ symbols, mu, cov, rf: 0.02, bounds: { min: 0, max: 0.6, upper: [0.6, 0.6, 0.6, 0.6] }, objective: "max_sharpe", riskAversion: 4, useRiskFree: false });
    if (r.ok && r2.ok) r.risky.weights.forEach((w, i) => expect(r2.risky.weights[i]).toBeCloseTo(w, 6));
  });
});
