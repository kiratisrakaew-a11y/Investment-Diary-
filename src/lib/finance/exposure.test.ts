/**
 * v3 Phase 3 — exposure definitions → constraints, with the existing optimizer.
 */
import { describe, expect, it } from "vitest";
import { buildConstraints, constraintsInput, exposureReport, type AssetRiskMeta } from "./exposure";
import { recommend } from "./recommend";

const meta: AssetRiskMeta[] = [
  { symbol: "PTT", assetClass: "thai_stock", issuer: "PTT", sector: "Energy", rating: null, modifiedDuration: null },
  { symbol: "PTT30", assetClass: "bond", issuer: "PTT", sector: "Energy", rating: "AA+", modifiedDuration: 3.5 },
  { symbol: "CPALL", assetClass: "thai_stock", issuer: "CPALL", sector: null, rating: null, modifiedDuration: null },
  { symbol: "LB29", assetClass: "bond", issuer: "MOF", sector: "Government", rating: null, modifiedDuration: 2.9 },
];
const mu = [0.12, 0.04, 0.1, 0.03];
const cov = [
  [0.06, 0.004, 0.02, 0.001],
  [0.004, 0.004, 0.002, 0.002],
  [0.02, 0.002, 0.05, 0.001],
  [0.001, 0.002, 0.001, 0.003],
];
const run = (c: Parameters<typeof buildConstraints>[2], value = 1_000_000) => {
  const built = buildConstraints(meta, { min: 0, max: 1 }, c, value);
  const r = recommend({ symbols: meta.map((m) => m.symbol), mu, cov, rf: 0.02, bounds: built.bounds, objective: "max_sharpe", riskAversion: 4, useRiskFree: false });
  return { built, r };
};

describe("issuer / sector / rating / duration constraints", () => {
  it("issuer exposure aggregates the stock and the bond of the same issuer", () => {
    // 3 issuers × 30% = 90% < 100% → genuinely infeasible, reported with the issuer caps.
    const tight = run({ maxPerIssuer: 0.3 });
    expect(tight.r.ok).toBe(false);
    if (!tight.r.ok) expect(tight.r.issue.constraints!.some((x) => x.includes("ผู้ออก"))).toBe(true);
    const { r } = run({ maxPerIssuer: 0.4 });
    if (!r.ok) throw new Error(r.issue.message);
    expect(r.risky.weights[0] + r.risky.weights[1]).toBeLessThanOrEqual(0.4 + 1e-9);
    const rep = exposureReport(meta, r.risky.weights, meta.map((m) => m.modifiedDuration ?? 0), 1_000_000);
    expect(rep.byIssuer.find((g) => g.key === "PTT")!.weight).toBeLessThanOrEqual(0.4 + 1e-9);
  });
  it("unclassified assets are reported, never auto-assigned to a sector", () => {
    const { built, r } = run({ maxPerSector: 0.4 });
    expect(built.unclassified.sector).toEqual(["CPALL"]);
    expect(built.warnings.join(" ")).toContain("CPALL");
    if (r.ok) expect(r.risky.weights[0] + r.risky.weights[1]).toBeLessThanOrEqual(0.4 + 1e-9);
  });
  it("unrated bonds form their own rating bucket", () => {
    const { r } = run({ maxPerRating: { unrated: 0.05 } });
    if (r.ok) expect(r.risky.weights[3]).toBeLessThanOrEqual(0.05 + 1e-9);
  });
  it("duration and DV01 limits use the correct monetary scaling", () => {
    const { r, built } = run({ maxDuration: 0.8 });
    if (!r.ok) throw new Error(r.issue.message);
    const d = r.risky.weights.reduce((s, w, i) => s + w * built.durations[i], 0);
    expect(d).toBeLessThanOrEqual(0.8 + 1e-9);
    const dv = run({ maxDv01Thb: 50 }, 1_000_000);
    if (!dv.r.ok) throw new Error(dv.r.issue.message);
    const dv01 = dv.r.risky.weights.reduce((s, w, i) => s + w * dv.built.durations[i], 0) * 1_000_000 * 0.0001;
    expect(dv01).toBeLessThanOrEqual(50 + 1e-6);
  });
  it("a cap that binds exactly; infeasible caps are explained; ES / turnover are unsupported", () => {
    const free = run(undefined);
    if (free.r.ok) expect(free.r.risky.weights[0] + free.r.risky.weights[2]).toBeGreaterThan(0.3);
    const { r } = run({ groups: [{ name: "หุ้น", symbols: ["PTT", "CPALL"], max: 0.3 }] });
    if (!r.ok) throw new Error(r.issue.message);
    expect(r.risky.weights[0] + r.risky.weights[2]).toBeCloseTo(0.3, 8);
    const inf = run({ groups: [{ name: "หุ้น", symbols: ["PTT", "CPALL"], min: 0.7 }, { name: "พันธบัตร", symbols: ["PTT30", "LB29"], min: 0.5 }] });
    expect(inf.r.ok).toBe(false);
    if (!inf.r.ok) expect(inf.r.issue.code).toBe("INFEASIBLE_CONSTRAINTS");
    expect(buildConstraints(meta, { min: 0, max: 1 }, constraintsInput.parse({ maxExpectedShortfall: 0.1, maxTurnover: 0.2 }), 1).unsupported).toHaveLength(2);
  });
  it("per-asset bounds", () => {
    const { r } = run({ assetBounds: { LB29: { min: 0.2 }, PTT: { max: 0.1 } } });
    if (!r.ok) throw new Error(r.issue.message);
    expect(r.risky.weights[3]).toBeGreaterThanOrEqual(0.2 - 1e-9);
    expect(r.risky.weights[0]).toBeLessThanOrEqual(0.1 + 1e-9);
  });
});
