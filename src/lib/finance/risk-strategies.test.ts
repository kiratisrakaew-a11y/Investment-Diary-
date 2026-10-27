/**
 * Strategies Phase 2 — LP solver, risk budgeting, maximum diversification, minimum CVaR.
 */
import { describe, expect, it } from "vitest";
import { maxDiversificationWeights, minCvarWeights, riskBudgetWeights, riskReport, solveLP } from "./risk-strategies";
import { expectedShortfall } from "./risk";

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
const normals = (n: number, seed: number) => {
  const u = rng(seed);
  return Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()));
};
/** Covariance of three correlated assets (σ 10%, 20%, 30%). */
const cov3 = (() => {
  const s = [0.1, 0.2, 0.3];
  const rho = [
    [1, 0.3, 0.1],
    [0.3, 1, 0.5],
    [0.1, 0.5, 1],
  ];
  return rho.map((r, i) => r.map((p, j) => p * s[i] * s[j]));
})();

describe("solveLP", () => {
  it("textbook maximum", () => {
    const r = solveLP([-1, -1], [
      { a: [1, 2], op: "<=", b: 4 },
      { a: [3, 1], op: "<=", b: 6 },
    ]);
    expect(r.status).toBe("optimal");
    expect(r.x[0]).toBeCloseTo(1.6, 10);
    expect(r.x[1]).toBeCloseTo(1.2, 10);
    expect(r.objective).toBeCloseTo(-2.8, 10);
  });
  it("equality and ≥ rows (phase I)", () => {
    const r = solveLP([1, 1], [
      { a: [1, 1], op: ">=", b: 2 },
      { a: [1, -1], op: "=", b: 0 },
    ]);
    expect(r.objective).toBeCloseTo(2, 10);
    expect(r.x).toEqual([expect.closeTo(1, 10), expect.closeTo(1, 10)]);
  });
  it("infeasible and unbounded are reported", () => {
    expect(solveLP([1], [{ a: [1], op: ">=", b: 3 }, { a: [1], op: "<=", b: 1 }]).status).toBe("infeasible");
    expect(solveLP([-1], [{ a: [1], op: ">=", b: 1 }]).status).toBe("unbounded");
  });
  it("Beale's cycling example terminates at the optimum (anti-cycling)", () => {
    const r = solveLP([-0.75, 20, -0.5, 6], [
      { a: [0.25, -8, -1, 9], op: "<=", b: 0 },
      { a: [0.5, -12, -0.5, 3], op: "<=", b: 0 },
      { a: [0, 0, 1, 0], op: "<=", b: 1 },
    ]);
    expect(r.status).toBe("optimal");
    expect(r.objective).toBeCloseTo(-1.25, 10);
  });
});

describe("risk budgeting (ERC)", () => {
  it("diagonal covariance → weights ∝ 1/σ", () => {
    const r = riskBudgetWeights([
      [0.01, 0, 0],
      [0, 0.04, 0],
      [0, 0, 0.09],
    ]);
    const inv = [10, 5, 10 / 3];
    const s = inv.reduce((a, b) => a + b, 0);
    r.weights.forEach((w, i) => expect(w).toBeCloseTo(inv[i] / s, 10));
    expect(r.status).toBe("optimal");
  });
  it("equal risk shares on a correlated covariance; custom budgets are met", () => {
    const eq = riskBudgetWeights(cov3);
    riskReport(eq.weights, cov3).riskShares.forEach((s) => expect(s).toBeCloseTo(1 / 3, 9));
    expect(eq.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    const bud = riskBudgetWeights(cov3, [0.5, 0.3, 0.2]);
    riskReport(bud.weights, cov3).riskShares.forEach((s, i) => expect(s).toBeCloseTo([0.5, 0.3, 0.2][i], 9));
    expect(bud.maxDeviation).toBeLessThan(1e-9);
  });
  it("zero-volatility asset → invalid, not a fake answer", () => {
    const r = riskBudgetWeights([
      [0.04, 0],
      [0, 0],
    ]);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("invalid");
  });
});

describe("maximum diversification", () => {
  it("uncorrelated assets → w ∝ 1/σ", () => {
    const r = maxDiversificationWeights(
      [
        [0.01, 0],
        [0, 0.04],
      ],
      { min: 0, max: 1 },
    );
    expect(r.weights[0]).toBeCloseTo(2 / 3, 8);
    expect(r.diversificationRatio).toBeCloseTo(Math.SQRT2, 8);
  });
  it("beats a brute-force grid and respects a 50% cap", () => {
    const grid = (cap: number) => {
      let best = 0;
      for (let a = 0; a <= 100; a++)
        for (let b = 0; a + b <= 100; b++) {
          const w = [a / 100, b / 100, (100 - a - b) / 100];
          if (w.some((v) => v > cap + 1e-12)) continue;
          best = Math.max(best, riskReport(w, cov3).diversificationRatio);
        }
      return best;
    };
    const free = maxDiversificationWeights(cov3, { min: 0, max: 1 });
    expect(free.diversificationRatio).toBeGreaterThanOrEqual(grid(1) - 1e-9);
    const capped = maxDiversificationWeights(cov3, { min: 0, max: 0.5 });
    expect(Math.max(...capped.weights)).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(capped.diversificationRatio).toBeGreaterThanOrEqual(grid(0.5) - 1e-9);
  });
});

describe("minimum CVaR", () => {
  const T = 300;
  const z = [normals(T, 3), normals(T, 5), normals(T, 7)];
  // Fat left tail for the third asset.
  const scen = [z[0].map((v) => 0.0005 + 0.01 * v), z[1].map((v, t) => 0.0007 + 0.015 * v + 0.005 * z[0][t]), z[2].map((v) => 0.001 + 0.012 * v - (v < -1.5 ? 0.03 : 0))];
  const port = (w: number[]) => scen[0].map((_, t) => w.reduce((s, wi, i) => s + wi * scen[i][t], 0));
  it("LP objective equals the existing historical ES of the optimal weights", () => {
    const r = minCvarWeights({ scenarios: scen, alpha: 0.95, bounds: { min: 0, max: 1 } });
    expect(r.status).toBe("optimal");
    expect(r.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(r.cvar).toBeCloseTo(expectedShortfall(port(r.weights), 0.95, 0)!, 10);
  });
  it("is no worse than a brute-force grid and respects caps", () => {
    const r = minCvarWeights({ scenarios: scen, alpha: 0.95, bounds: { min: 0, max: 0.6 } });
    let best = Infinity;
    for (let a = 0; a <= 20; a++)
      for (let b = 0; a + b <= 20; b++) {
        const w = [a / 20, b / 20, (20 - a - b) / 20];
        if (w.some((v) => v > 0.6 + 1e-12)) continue;
        best = Math.min(best, expectedShortfall(port(w), 0.95, 0)!);
      }
    expect(r.cvar).toBeLessThanOrEqual(best + 1e-12);
    expect(Math.max(...r.weights)).toBeLessThanOrEqual(0.6 + 1e-9);
  });
  it("minimum expected return and infeasible targets", () => {
    const mu = scen.map((s) => s.reduce((a, b) => a + b, 0) / T);
    const r = minCvarWeights({ scenarios: scen, alpha: 0.95, bounds: { min: 0, max: 1 }, mu, minReturn: mu[2] - 1e-9 });
    expect(r.ok).toBe(true);
    expect(r.weights.reduce((s, w, i) => s + w * mu[i], 0)).toBeGreaterThanOrEqual(mu[2] - 1e-8);
    expect(minCvarWeights({ scenarios: scen, alpha: 0.95, bounds: { min: 0, max: 1 }, mu, minReturn: 1 }).status).toBe("infeasible");
    expect(minCvarWeights({ scenarios: scen.map((s) => s.slice(0, 10)), alpha: 0.99, bounds: { min: 0, max: 1 } }).status).toBe("invalid");
  });
});
