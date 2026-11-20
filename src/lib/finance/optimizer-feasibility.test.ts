/**
 * MPT_FIX_SPEC P0-B1 + basic correctness: feasible constraint sets must solve (no false
 * INFEASIBLE_CONSTRAINTS), real conflicts report a minimal subset, and textbook answers hold.
 * Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { buildConstraints, type AssetRiskMeta } from "./exposure";
import {
  analyticFrontier,
  checkWeights,
  constraintsFeasible,
  gmvPortfolio,
  OptimizerError,
  tangencyPortfolio,
  type Bounds,
} from "./optimizer";
import { recommend, type Objective } from "./recommend";

let seed = 3;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function market(n: number, s = 3) {
  seed = s;
  const vol = Array.from({ length: n }, () => 0.15 + rnd() * 0.25);
  const cov = vol.map((a, i) =>
    vol.map((b, j) => (i === j ? a * a : 0.35 * a * b)),
  );
  const mu = Array.from({ length: n }, () => -0.1 + rnd() * 0.5);
  return { mu, cov };
}
const SECTORS = [
  "Banking",
  "Banking",
  "Banking",
  "Banking",
  "Commerce",
  "Commerce",
  "Commerce",
  "Commerce",
  "Commerce",
  "Commerce",
  "Property",
  "Property",
  "Property",
  "Food",
  "Food",
  "Food",
  "Food",
  "Energy",
  "Energy",
  "Tech",
  "Tech",
  "Health",
  "Health",
];
const meta = (n: number): AssetRiskMeta[] =>
  Array.from({ length: n }, (_, i) => ({
    symbol: `S${i}`,
    assetClass: "thai_stock",
    issuer: null,
    sector: SECTORS[i] ?? "Other",
    rating: null,
    modifiedDuration: null,
  }));
const run = (
  objective: Objective,
  mu: number[],
  cov: number[][],
  bounds: Bounds,
) =>
  recommend({
    symbols: mu.map((_, i) => `S${i}`),
    mu,
    cov,
    rf: 0.02,
    bounds,
    objective,
    riskAversion: 4,
    useRiskFree: false,
  });
const groupLoad = (w: number[], a: number[]) =>
  w.reduce((s, x, i) => s + x * a[i], 0);
const issueCode = (f: () => unknown) => {
  try {
    f();
    return "OK";
  } catch (e) {
    return e instanceof OptimizerError ? e.issue.code : String(e);
  }
};

describe("P0-B1: feasible constraint sets solve", () => {
  const { mu, cov } = market(23);
  const groups4 = [
    { name: "Banking", symbols: ["S0", "S1", "S2", "S3"], max: 0.3 },
    {
      name: "Commerce",
      symbols: ["S4", "S5", "S6", "S7", "S8", "S9"],
      max: 0.3,
    },
    { name: "Property", symbols: ["S10", "S11", "S12"], max: 0.25 },
    { name: "Food", symbols: ["S13", "S14", "S15", "S16"], max: 0.25 },
  ];
  // Overlapping groups on top: an asset can be in two groups.
  const groups8 = [
    ...groups4,
    { name: "Big caps", symbols: ["S0", "S4", "S10", "S13", "S17"], max: 0.35 },
    { name: "Domestic", symbols: ["S5", "S6", "S11", "S14", "S19"], max: 0.4 },
    { name: "Defensive", symbols: ["S15", "S16", "S21", "S22"], max: 0.3 },
    { name: "Cyclical", symbols: ["S1", "S7", "S12", "S18", "S20"], max: 0.35 },
  ];
  for (const [label, groups] of [
    ["2 groups", groups4.slice(0, 2)],
    ["4 groups", groups4],
    ["8 overlapping groups", groups8],
  ] as const) {
    it(`${label}, max 15% each: equal weight passes ⇒ max Sharpe and min variance are optimal, every cap respected`, () => {
      const built = buildConstraints(
        meta(23),
        { min: 0, max: 0.15 },
        { groups: [...groups] },
        1,
      );
      expect(
        checkWeights(
          mu.map(() => 1 / 23),
          built.bounds,
        ).maxBoundViolation,
      ).toBeLessThanOrEqual(1e-12);
      for (const obj of ["max_sharpe", "min_variance"] as const) {
        const r = run(obj, mu, cov, built.bounds);
        if (!r.ok)
          throw new Error(`${obj}: ${r.issue.code} ${r.issue.message}`);
        const w = r.risky.weights;
        expect(Math.abs(w.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-9);
        expect(Math.max(...w)).toBeLessThanOrEqual(0.15 + 1e-9);
        for (const g of built.bounds.linear!)
          expect(groupLoad(w, g.a)).toBeLessThanOrEqual(g.hi! + 1e-9);
      }
    });
  }
  it("maxPerSector 35% on 20 stocks (no per-asset cap) is optimal", () => {
    const { mu: m20, cov: c20 } = market(20, 11);
    const built = buildConstraints(
      meta(20),
      { min: 0, max: 1 },
      { maxPerSector: 0.35 },
      1,
    );
    const r = run("max_sharpe", m20, c20, built.bounds);
    if (!r.ok) throw new Error(`${r.issue.code} ${r.issue.message}`);
    for (const g of built.bounds.linear!)
      expect(groupLoad(r.risky.weights, g.a)).toBeLessThanOrEqual(0.35 + 1e-9);
  });
  it("random constraint sets that equal weight satisfies are always solved", () => {
    for (let t = 0; t < 25; t++) {
      const n = 6 + (t % 10);
      const { mu: m, cov: c } = market(n, 100 + t);
      const ew = 1 / n;
      const linear = Array.from({ length: 1 + (t % 4) }, (_, k) => {
        const a: number[] = m.map((_, i) => ((i + k) % 3 === 0 ? 1 : 0));
        const load = a.reduce((s, x) => s + x, 0) * ew;
        return { name: `G${k}`, a, hi: Math.min(1, load + 0.02 + rnd() * 0.2) };
      });
      const b: Bounds = {
        min: 0,
        max: Math.max(ew + 0.01, 0.2 + rnd() * 0.3),
        linear,
      };
      expect(constraintsFeasible(n, b)).toBe(true);
      expect(issueCode(() => tangencyPortfolio(m, c, 0.02, b))).toBe("OK");
      expect(issueCode(() => gmvPortfolio(m, c, 0.02, b))).toBe("OK");
    }
  });
});

describe("P0-B1: real conflicts", () => {
  it("INFEASIBLE_CONSTRAINTS names a minimal conflicting subset, shorter than every constraint", () => {
    const { mu, cov } = market(23);
    const built = buildConstraints(
      meta(23),
      { min: 0, max: 0.15 },
      {
        groups: [
          { name: "Banking", symbols: ["S0", "S1", "S2", "S3"], min: 0.7 },
          {
            name: "Commerce",
            symbols: ["S4", "S5", "S6", "S7", "S8", "S9"],
            max: 0.3,
          },
          { name: "Property", symbols: ["S10", "S11", "S12"], max: 0.25 },
        ],
      },
      1,
    );
    const r = run("max_sharpe", mu, cov, built.bounds);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issue.code).toBe("INFEASIBLE_CONSTRAINTS");
    // Banking ≥ 70% with four members capped at 15% (max 60%) is the whole conflict (+ the budget).
    const names = r.issue.constraints ?? [];
    expect(names.some((x) => x.includes("Banking"))).toBe(true);
    expect(
      names.some((x) => x.includes("Commerce") || x.includes("Property")),
    ).toBe(false);
    const total = 1 + 23 + built.bounds.linear!.length;
    expect(names.length).toBeLessThan(total);
  });
});

describe("basic correctness (permanent)", () => {
  it("analytical 2-asset minimum variance: w₁ = (σ₂² − σ₁₂) / (σ₁² + σ₂² − 2σ₁₂)", () => {
    const s1 = 0.2;
    const s2 = 0.3;
    const s12 = 0.4 * s1 * s2;
    const cov = [
      [s1 * s1, s12],
      [s12, s2 * s2],
    ];
    const w1 = (s2 * s2 - s12) / (s1 * s1 + s2 * s2 - 2 * s12);
    const g = gmvPortfolio([0.08, 0.12], cov, 0.02, { min: 0, max: 1 });
    expect(g.weights[0]).toBeCloseTo(w1, 8);
    // Same answer through the general-constraint solver (a non-binding group).
    const gg = gmvPortfolio([0.08, 0.12], cov, 0.02, {
      min: 0,
      max: 1,
      linear: [{ name: "all", a: [1, 1], hi: 1.5 }],
    });
    expect(gg.weights[0]).toBeCloseTo(w1, 8);
  });
  it("tangency without bounds equals Σ⁻¹(μ − Rf·1) normalised", () => {
    const { mu, cov } = market(5, 21);
    const rf = 0.02;
    const a = analyticFrontier(mu, cov, rf)!;
    const free = tangencyPortfolio(mu, cov, rf, { min: -10, max: 10 });
    a.tangency!.weights.forEach((w, i) =>
      expect(free.weights[i]).toBeCloseTo(w, 8),
    );
  });
  it("equal weight passing every constraint ⇒ a feasible constraint set", () => {
    const b: Bounds = {
      min: 0,
      max: 0.3,
      linear: [{ name: "x", a: [1, 1, 0, 0, 0], hi: 0.41 }],
    };
    expect(constraintsFeasible(5, b)).toBe(true);
    expect(
      constraintsFeasible(5, {
        ...b,
        linear: [{ name: "x", a: [1, 1, 0, 0, 0], lo: 0.7 }],
      }),
    ).toBe(false);
  });
});
