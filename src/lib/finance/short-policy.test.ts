import { describe, expect, it } from "vitest";
import { applyShortPolicy, exposureSummary, shortPolicyInput, withPolicyBounds } from "./short-policy";
import { constrainedFrontier, gmvPortfolio, OptimizerError, targetReturnPortfolio, targetRiskPortfolio, tangencyPortfolio, utilityPortfolio, type Bounds } from "./optimizer";
import { recommend } from "./recommend";
import { rebalance, tradingCostsSchema } from "./rebalance";
import { portfolioStats } from "./mpt";

// Three assets where the unconstrained optimum shorts asset C (highly correlated with A, lower return).
const assets = [
  { symbol: "A", assetClass: "thai_stock" },
  { symbol: "B", assetClass: "us_stock" },
  { symbol: "C", assetClass: "thai_stock" },
];
const mu = [0.12, 0.08, 0.04];
const cov = [
  [0.04, 0.006, 0.034],
  [0.006, 0.02, 0.005],
  [0.034, 0.005, 0.035],
];
const rf = 0.02;
const boundsFor = (policy: Parameters<typeof applyShortPolicy>[0], user = {}): Bounds => {
  const r = applyShortPolicy(policy, user, assets);
  if (!r.ok) throw new OptimizerError(r.issue);
  return withPolicyBounds({ min: r.base.min, max: r.base.max, names: assets.map((a) => a.symbol) }, r);
};
const sum = (w: number[]) => w.reduce((a, x) => a + x, 0);
const gross = (w: number[]) => w.reduce((a, x) => a + Math.abs(x), 0);

describe("PR5 short-selling policy — acceptance", () => {
  it("1. default OFF: every weight ≥ −1e-9 for min variance, max Sharpe, target return / risk, utility, frontier and recommend", () => {
    const b = boundsFor(undefined);
    const outs = [
      gmvPortfolio(mu, cov, rf, b).weights,
      tangencyPortfolio(mu, cov, rf, b).weights,
      targetReturnPortfolio(mu, cov, rf, 0.09, b).weights,
      targetRiskPortfolio(mu, cov, rf, 0.17, b).weights,
      utilityPortfolio(mu, cov, rf, 3, b).weights,
      ...constrainedFrontier(mu, cov, rf, b, 20).curve.map((p) => p.weights),
    ];
    for (const obj of ["max_sharpe", "min_variance", "utility", "target_return", "target_risk"] as const) {
      const r = recommend({ symbols: ["A", "B", "C"], mu, cov, rf, bounds: b, objective: obj, riskAversion: 3, targetReturn: 0.09, targetRisk: 0.17, useRiskFree: false });
      if (!r.ok) throw new Error(r.issue.message);
      outs.push(r.allocations.map((a) => a.weight));
    }
    for (const w of outs) {
      expect(Math.min(...w)).toBeGreaterThanOrEqual(-1e-9);
      expect(Math.abs(sum(w) - 1)).toBeLessThan(1e-7);
    }
  });

  it("2. minWeight −20% with shorting OFF is rejected with SHORT_SELLING_DISABLED (never silently clipped)", () => {
    const r = applyShortPolicy({}, { minWeight: -0.2 }, assets);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issue.code).toBe("SHORT_SELLING_DISABLED");
    const per = applyShortPolicy({ allowShortSelling: false }, { assetMins: { C: -0.1 } }, assets);
    expect(!per.ok && per.issue.message).toMatch(/C ขั้นต่ำ −?-?10/);
  });

  it("3–4. ON: shorts appear but respect −maxShort per asset and the gross cap; Σw = 1 within 1e-7; matches a brute-force grid", () => {
    const b = boundsFor({ allowShortSelling: true, maxShortPerAsset: 0.3, maxGrossExposure: 1.4 });
    const p = gmvPortfolio(mu, cov, rf, b);
    const w = p.weights;
    expect(Math.min(...w)).toBeLessThan(-0.01); // a short is actually used
    expect(Math.min(...w)).toBeGreaterThanOrEqual(-0.3 - 1e-9);
    expect(gross(w)).toBeLessThanOrEqual(1.4 + 1e-7);
    expect(Math.abs(sum(w) - 1)).toBeLessThan(1e-7);
    // Independent brute force over (wA, wB), wC = 1 − wA − wB, same constraints.
    const v = (x: number[]) => x.reduce((s, xi, i) => s + xi * x.reduce((t, xj, j) => t + cov[i][j] * xj, 0), 0);
    let best = Infinity;
    for (let a = -0.3; a <= 1.0001; a += 0.0025)
      for (let bb = -0.3; bb <= 1.0001; bb += 0.0025) {
        const x = [a, bb, 1 - a - bb];
        if (x.some((xi) => xi < -0.3 - 1e-12 || xi > 1 + 1e-12) || gross(x) > 1.4 + 1e-12) continue;
        best = Math.min(best, v(x));
      }
    expect(v(w)).toBeLessThanOrEqual(best + 1e-9);
    expect(v(w)).toBeGreaterThan(best - 1e-4);
  });

  it("3. max Sharpe and frontier also honour gross; bonds cannot be shorted unless enabled", () => {
    const b = boundsFor({ allowShortSelling: true, maxShortPerAsset: 0.5, maxGrossExposure: 1.6 });
    const t = tangencyPortfolio(mu, cov, rf, b).weights;
    expect(gross(t)).toBeLessThanOrEqual(1.6 + 1e-7);
    for (const pt of constrainedFrontier(mu, cov, rf, b, 12).curve) expect(gross(pt.weights)).toBeLessThanOrEqual(1.6 + 1e-7);
    const withBond = applyShortPolicy({ allowShortSelling: true, maxShortPerAsset: 0.2, maxGrossExposure: 1.5 }, {}, [...assets, { symbol: "GB", assetClass: "bond" }]);
    expect(withBond.ok && withBond.lower).toEqual([-0.2, -0.2, -0.2, 0]);
    const bondOk = applyShortPolicy({ allowShortSelling: true, maxShortPerAsset: 0.2, maxGrossExposure: 1.5, allowBondShorts: true }, {}, [{ symbol: "GB", assetClass: "bond" }]);
    expect(bondOk.ok && bondOk.lower).toEqual([-0.2]);
  });

  it("5. contradictory caps are typed errors with no allocation", () => {
    expect(() => gmvPortfolio(mu, cov, rf, { ...boundsFor({ allowShortSelling: true, maxShortPerAsset: 0.3, maxGrossExposure: 1.4 }), gross: 0.9 })).toThrow(OptimizerError);
    const net = applyShortPolicy({ allowShortSelling: true, maxShortPerAsset: 0.3, maxGrossExposure: 1.4, maxNetExposure: 0.8 }, {}, assets);
    expect(!net.ok && net.issue.code).toBe("INFEASIBLE_CONSTRAINTS");
    const missing = applyShortPolicy({ allowShortSelling: true }, {}, assets);
    expect(!missing.ok && missing.issue.code).toBe("INVALID_INPUT");
    const rp = applyShortPolicy({ allowShortSelling: true, maxShortPerAsset: 0.3, maxGrossExposure: 1.4 }, {}, assets, "risk_parity");
    expect(!rp.ok && rp.issue.code).toBe("UNSUPPORTED_CONSTRAINT");
  });

  it("6. rebalancing to OFF targets never sells more than is held (no short orders)", () => {
    const b = boundsFor(undefined);
    const w = tangencyPortfolio(mu, cov, rf, b).weights;
    const r = rebalance({
      assets: assets.map((a, i) => ({ symbol: a.symbol, assetClass: a.assetClass as "thai_stock", price: 10, quantity: [1000, 0, 500][i], target: w[i], lot: 1 }) as never),
      cash: 0,
      extraCash: 0,
      cashReserve: 0,
      costs: tradingCostsSchema.parse({}),
      objective: "min_distance" as never,
      noTradeBand: 0,
      allowSell: true,
      fractional: true,
      cov: null,
    });
    for (const t of r.trades) {
      expect(t.finalQuantity).toBeGreaterThanOrEqual(-1e-9);
      if (t.side === "sell") expect(t.quantity).toBeLessThanOrEqual(t.currentQuantity + 1e-9);
    }
  });

  it("7. absent fields parse to OFF (existing callers and saved inputs migrate to long-only)", () => {
    const p = shortPolicyInput.parse({});
    expect(p.allowShortSelling).toBe(false);
    expect(p.allowBorrowingAtRiskFree).toBe(false);
    expect(p.allowBondShorts).toBe(false);
  });

  it("long/short 3-asset example: E[R], σ, gross and net match independent arithmetic", () => {
    const w = [0.9, 0.4, -0.3];
    const s = portfolioStats(w, mu, cov, rf);
    const er = 0.9 * 0.12 + 0.4 * 0.08 - 0.3 * 0.04;
    const v = w.reduce((acc, wi, i) => acc + wi * w.reduce((t, wj, j) => t + cov[i][j] * wj, 0), 0);
    expect(s.expectedReturn).toBeCloseTo(er, 15);
    expect(s.volatility).toBeCloseTo(Math.sqrt(v), 15);
    expect(exposureSummary(w)).toEqual({ long: 1.3, short: 0.3, gross: 1.6, net: 1 });
  });
});

describe("PR5 borrowing on the CAL (separate switch, own rate)", () => {
  // One risky asset: the tangency is the asset itself, so y follows from the formula by hand.
  const one = { symbols: ["X"], mu: [0.1], cov: [[0.04]], rf: 0.02, bounds: { min: 0, max: 1 }, objective: "utility" as const, useRiskFree: true };
  it("without borrowing y is capped at 100% (y* = 2 at A = 1)", () => {
    const r = recommend({ ...one, riskAversion: 1 });
    expect(r.ok && r.riskyShare).toBe(1);
  });
  it("borrowing at rb = 4%: y = (0.10 − 0.04)/(1 × 0.04) = 1.5, E[R] = 0.04 + 1.5 × 0.06 = 0.13", () => {
    const r = recommend({ ...one, riskAversion: 1, borrowing: { rate: 0.04, maxLeverage: 2 } });
    if (!r.ok) throw new Error(r.issue.message);
    expect(r.riskyShare).toBeCloseTo(1.5, 10);
    expect(r.riskFreeShare).toBeCloseTo(-0.5, 10);
    expect(r.final.expectedReturn).toBeCloseTo(0.13, 10);
  });
  it("kink: y at rf > 1 but y at rb < 1 → 100% risky, no borrowing (A = 1.75)", () => {
    const r = recommend({ ...one, riskAversion: 1.75, borrowing: { rate: 0.04, maxLeverage: 2 } });
    expect(r.ok && r.riskyShare).toBe(1);
  });
  it("leverage cap holds", () => {
    const r = recommend({ ...one, riskAversion: 0.5, borrowing: { rate: 0.04, maxLeverage: 1.2 } });
    expect(r.ok && r.riskyShare).toBeCloseTo(1.2, 12);
  });
});
