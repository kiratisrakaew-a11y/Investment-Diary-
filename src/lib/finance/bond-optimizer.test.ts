import { describe, expect, it } from "vitest";
import { bondExpectedReturn } from "./bond-expected";
import { buildConstraints, exposureReport, type AssetRiskMeta } from "./exposure";
import { gmvPortfolio, OptimizerError } from "./optimizer";

const par = { couponRate: 5, maturityDate: "2031-06-30", faceValue: 100, couponFrequency: 1, dayCount: "ACT/365F", cleanPerUnit: 100, settlement: "2026-06-30" };

describe("PR4 forward bond expected return", () => {
  it("par bond, 1-year horizon, exit at YTM: expected return = coupon = YTM exactly", () => {
    const r = bondExpectedReturn(par);
    if (!r.ok) throw new Error(r.reason);
    expect(r.ytm).toBeCloseTo(0.05, 10);
    expect(r.expectedReturn).toBeCloseTo(0.05, 10);
    expect(r.components).toMatchObject({ rolldown: 0, rateShock: 0, expectedCreditLoss: 0 });
  });
  it("upward-sloping curve adds positive rolldown; +100bp shock costs about D × 1%", () => {
    const curve = [{ years: 1, rate: 0.02 }, { years: 5, rate: 0.05 }];
    const r = bondExpectedReturn({ ...par, curve });
    if (!r.ok) throw new Error(r.reason);
    expect(r.components.rolldown).toBeGreaterThan(0);
    const s = bondExpectedReturn({ ...par, rateShiftBp: 100 });
    if (!s.ok) throw new Error(s.reason);
    // 4 years left after the horizon: modified duration ≈ 3.55 at 5% → about −3.4% to −3.6% (convexity softens it).
    expect(s.components.rateShock).toBeLessThan(-0.033);
    expect(s.components.rateShock).toBeGreaterThan(-0.037);
    expect(s.expectedReturn).toBeCloseTo(s.components.carryAndPullToPar + s.components.rolldown + s.components.rateShock, 12);
  });
  it("subtracts physical expected credit loss PD × LGD only when both are given", () => {
    const r = bondExpectedReturn({ ...par, credit: { pdAnnual: 0.01, lgd: 0.6 } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.components.expectedCreditLoss).toBeCloseTo(0.006, 12);
    expect(r.expectedReturn).toBeCloseTo(0.05 - 0.006, 10);
    const half = bondExpectedReturn({ ...par, credit: { pdAnnual: 0.01, lgd: null } });
    expect(half.ok && half.components.expectedCreditLoss).toBe(0);
  });
  it("short-dated bond: horizon capped at maturity; missing terms → no number", () => {
    const r = bondExpectedReturn({ ...par, maturityDate: "2026-12-31" });
    expect(r.ok && r.horizonYears).toBeLessThan(1);
    expect(bondExpectedReturn({ ...par, couponRate: null }).ok).toBe(false);
    expect(bondExpectedReturn({ ...par, maturityDate: "2026-01-01" }).ok).toBe(false);
  });
});

describe("PR4 currency and maturity-bucket constraints", () => {
  const meta: AssetRiskMeta[] = [
    { symbol: "TH-EQ", assetClass: "thai_stock", issuer: null, sector: null, rating: null, modifiedDuration: null, currency: "THB", yearsToMaturity: null },
    { symbol: "US-EQ", assetClass: "us_stock", issuer: null, sector: null, rating: null, modifiedDuration: null, currency: "USD", yearsToMaturity: null },
    { symbol: "GB2", assetClass: "bond", issuer: null, sector: null, rating: null, modifiedDuration: 1.9, currency: "THB", yearsToMaturity: 2 },
    { symbol: "GB10", assetClass: "bond", issuer: null, sector: null, rating: null, modifiedDuration: 8.5, currency: "THB", yearsToMaturity: 10 },
  ];
  // US equity has the lowest variance, so min-variance wants it most.
  const cov = [
    [0.04, 0, 0, 0],
    [0, 0.001, 0, 0],
    [0, 0, 0.002, 0],
    [0, 0, 0, 0.01],
  ];
  const mu = [0.08, 0.07, 0.03, 0.04];
  it("USD cap binds and every bucket constraint holds in the solved weights", () => {
    const b = buildConstraints(meta, { min: 0, max: 1 }, { maxPerCurrency: { USD: 0.2 }, maturityBuckets: [{ name: "สั้น", fromYears: 0, toYears: 5, max: 0.3 }, { name: "ยาว", fromYears: 5, toYears: 30, min: 0.1 }] }, 1e6);
    const w = gmvPortfolio(mu, cov, 0.02, b.bounds).weights;
    expect(w[1]).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(w[1]).toBeGreaterThan(0.19); // binding
    expect(w[2]).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(w[3]).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(w.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 9);
    const rep = exposureReport(meta, w, b.durations, 1e6);
    expect(rep.byCurrency.find((x) => x.key === "USD")!.weight).toBeCloseTo(w[1], 12);
  });
  it("an empty bucket with a minimum is infeasible (typed error, no weights)", () => {
    const b = buildConstraints(meta, { min: 0, max: 1 }, { maturityBuckets: [{ name: "กลาง", fromYears: 4, toYears: 8, min: 0.1 }] }, 1e6);
    expect(() => gmvPortfolio(mu, cov, 0.02, b.bounds)).toThrow(OptimizerError);
  });
});
