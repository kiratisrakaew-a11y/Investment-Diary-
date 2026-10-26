/**
 * PR 3 / Phase E regression tests — optimizer feasibility and optimality.
 * References are independent: closed-form solutions or a brute-force grid over the simplex.
 */
import { describe, expect, it } from "vitest";
import { covarianceDiagnostics, portfolioStats } from "./mpt";
import {
  OptimizerError,
  analyticFrontier,
  gmvPortfolio,
  projectBoxSimplex,
  solveBoxQP,
  tangencyPortfolio,
  targetReturnPortfolio,
  targetRiskPortfolio,
  type Bounds,
} from "./optimizer";
import { recommend } from "./recommend";

const mu = [0.1, 0.06, 0.08];
const cov = [
  [0.04, 0.006, 0.01],
  [0.006, 0.01, 0.004],
  [0.01, 0.004, 0.0225],
];
const rf = 0.02;
const longOnly: Bounds = { min: 0, max: 1 };

const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof OptimizerError ? e.issue.code : `other: ${(e as Error).message}`;
  }
  return "no error";
};

const expectFeasible = (w: number[], b: Bounds) => {
  expect(Math.abs(w.reduce((a, x) => a + x, 0) - 1)).toBeLessThanOrEqual(1e-8);
  w.forEach((x) => {
    expect(x).toBeGreaterThanOrEqual(b.min - 1e-8);
    expect(x).toBeLessThanOrEqual(b.max + 1e-8);
  });
};

/** All long-only 3-asset portfolios on a grid (step 0.25%). */
function grid3(step = 0.0025) {
  const out: number[][] = [];
  const n = Math.round(1 / step);
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) out.push([i / n, j / n, (n - i - j) / n]);
  return out;
}

describe("E2 never relax weight bounds", () => {
  it("n = 3 with max 20% is infeasible — projection throws instead of allocating ~33%", () => {
    expect(codeOf(() => projectBoxSimplex([0.5, 0.3, 0.2], { min: 0, max: 0.2 }))).toBe("INFEASIBLE_BOUNDS");
  });
  it("recommend returns a typed failure and no weights", () => {
    const r = recommend({ symbols: ["A", "B", "C"], mu, cov, rf, bounds: { min: 0, max: 0.2 }, objective: "max_sharpe", riskAversion: 4, useRiskFree: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issue.code).toBe("INFEASIBLE_BOUNDS");
      expect(r.issue.suggestion).toBeTruthy();
    }
  });
  it("n = 3 with min 40% is infeasible", () => {
    expect(codeOf(() => gmvPortfolio(mu, cov, rf, { min: 0.4, max: 1 }))).toBe("INFEASIBLE_BOUNDS");
  });
});

describe("E3 exact QP", () => {
  it("with loose bounds the QP GMV equals the closed-form GMV", () => {
    const g = gmvPortfolio(mu, cov, rf, { min: -10, max: 10 });
    const a = analyticFrontier(mu, cov, rf)!;
    g.weights.forEach((w, i) => expect(w).toBeCloseTo(a.gmv.weights[i], 8));
    expect(g.solver.status).toBe("optimal");
  });
  it("two-asset long-only GMV matches w₁ = (σ₂² − σ₁₂)/(σ₁² + σ₂² − 2σ₁₂)", () => {
    const c2 = [
      [0.04, 0.002],
      [0.002, 0.01],
    ];
    const w1 = (0.01 - 0.002) / (0.04 + 0.01 - 0.004);
    const g = gmvPortfolio([0.1, 0.05], c2, rf, longOnly);
    expect(g.weights[0]).toBeCloseTo(w1, 10);
  });
  it("active-set solver reports KKT residual and feasibility", () => {
    const r = solveBoxQP(cov.map((row) => row.map((x) => 2 * x)), mu.map((m) => -0.5 * m), { min: 0, max: 0.45 });
    expect(r.status).toBe("optimal");
    expect(r.kktResidual).toBeLessThan(1e-9);
    expectFeasible(r.weights, { min: 0, max: 0.45 });
  });
});

describe("E3 target return / target risk", () => {
  it("target return is met exactly on both arms of the bullet", () => {
    for (const t of [0.065, 0.07, 0.09]) {
      const p = targetReturnPortfolio(mu, cov, rf, t, longOnly);
      expect(Math.abs(p.expectedReturn - t)).toBeLessThan(1e-9);
      expectFeasible(p.weights, longOnly);
    }
  });
  it("target return outside the feasible range is an error, not the nearest point", () => {
    expect(codeOf(() => targetReturnPortfolio(mu, cov, rf, 0.12, longOnly))).toBe("INFEASIBLE_TARGET_RETURN");
    // With a 50% cap the best return is 0.5·10% + 0.5·8% = 9%.
    expect(codeOf(() => targetReturnPortfolio(mu, cov, rf, 0.095, { min: 0, max: 0.5 }))).toBe("INFEASIBLE_TARGET_RETURN");
  });
  it("target risk = max return with σ ≤ target (checked against a brute-force grid)", () => {
    const target = 0.13;
    const p = targetRiskPortfolio(mu, cov, rf, target, longOnly);
    expect(p.volatility).toBeLessThanOrEqual(target + 1e-8);
    let best = -Infinity;
    for (const w of grid3()) {
      const s = portfolioStats(w, mu, cov, rf);
      if (s.volatility <= target) best = Math.max(best, s.expectedReturn);
    }
    expect(p.expectedReturn).toBeGreaterThanOrEqual(best - 1e-9);
    expect(p.volatility).toBeCloseTo(target, 8); // binding
  });
  it("target risk below the minimum-variance portfolio is infeasible", () => {
    expect(codeOf(() => targetRiskPortfolio(mu, cov, rf, 0.05, longOnly))).toBe("INFEASIBLE_TARGET_RISK");
  });
});

describe("E3 max Sharpe", () => {
  it("beats every portfolio on a brute-force grid", () => {
    const t = tangencyPortfolio(mu, cov, rf, { min: 0, max: 0.6 });
    let best = -Infinity;
    for (const w of grid3()) if (w.every((x) => x <= 0.6)) best = Math.max(best, portfolioStats(w, mu, cov, rf).sharpe!);
    expect(t.sharpe!).toBeGreaterThanOrEqual(best - 1e-9);
    expectFeasible(t.weights, { min: 0, max: 0.6 });
  });
  it("equals the analytic tangency when that is long-only", () => {
    const a = analyticFrontier(mu, cov, rf)!;
    const t = tangencyPortfolio(mu, cov, rf, longOnly);
    t.weights.forEach((w, i) => expect(w).toBeCloseTo(a.tangency!.weights[i], 6));
  });
  it("no asset beats Rf → no tangency portfolio", () => {
    expect(codeOf(() => tangencyPortfolio([0.01, 0.015, 0.012], cov, 0.02, longOnly))).toBe("NO_EXCESS_RETURN");
  });
});

describe("E1 covariance diagnostics", () => {
  it("singular covariance (duplicate asset) gives finite weights and a warning", () => {
    const c = [
      [0.04, 0.04, 0.01],
      [0.04, 0.04, 0.01],
      [0.01, 0.01, 0.0225],
    ];
    const d = covarianceDiagnostics(c);
    expect(d.warnings.length).toBeGreaterThan(0);
    const r = recommend({ symbols: ["A", "A2", "C"], mu: [0.1, 0.1, 0.08], cov: c, rf, bounds: longOnly, objective: "min_variance", riskAversion: 4, useRiskFree: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      r.allocations.forEach((a) => expect(Number.isFinite(a.weight)).toBe(true));
      expect(r.warnings.length).toBeGreaterThan(0);
    }
  });
  it("a non-PSD matrix is detected and repaired", () => {
    const bad = [
      [0.04, 0.05],
      [0.05, 0.04],
    ];
    const d = covarianceDiagnostics(bad);
    expect(d.psd).toBe(false);
    expect(covarianceDiagnostics(d.repaired).minEigenvalue).toBeGreaterThanOrEqual(-1e-12);
  });
});

describe("E3 risk-free asset", () => {
  it("target return with Rf is solved on the capital allocation line, not switched to tangency", () => {
    const r = recommend({ symbols: ["A", "B", "C"], mu, cov, rf, bounds: longOnly, objective: "target_return", targetReturn: 0.06, riskAversion: 4, useRiskFree: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.final.expectedReturn).toBeCloseTo(0.06, 10);
      expect(r.riskyShare).toBeCloseTo((0.06 - rf) / (r.tangency!.expectedReturn - rf), 10);
    }
  });
  it("every recommendation satisfies the bounds", () => {
    for (const objective of ["max_sharpe", "min_variance", "utility", "target_return", "target_risk"] as const) {
      const b = { min: 0.05, max: 0.5 };
      const r = recommend({ symbols: ["A", "B", "C"], mu, cov, rf, bounds: b, objective, targetReturn: 0.08, targetRisk: 0.13, riskAversion: 4, useRiskFree: false });
      expect(r.ok).toBe(true);
      if (r.ok) expectFeasible(r.risky.weights, b);
    }
  });
});
