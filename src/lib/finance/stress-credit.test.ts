/**
 * v3 Phase 2 — credit-spread stress: combined with rates once; attribution sums; legacy unchanged.
 */
import { describe, expect, it } from "vitest";
import { runStress, type StressPosition } from "./stress";

const bond: StressPosition = { symbol: "LB29", assetClass: "bond", currency: "THB", value: 100_000, beta: null, modifiedDuration: 4, convexity: 20, issuer: "MOF", rating: "AAA" };
const corp: StressPosition = { symbol: "CPF30", assetClass: "bond", currency: "THB", value: 50_000, beta: null, modifiedDuration: 3, convexity: 12, spreadDuration: 2.9, issuer: "CPF", rating: "A" };
const stock: StressPosition = { symbol: "PTT", assetClass: "thai_stock", currency: "THB", value: 80_000, beta: 1, modifiedDuration: null, convexity: null, issuer: "PTT" };
const fund: StressPosition = { symbol: "KFIX", assetClass: "fund", currency: "THB", value: 20_000, beta: null, modifiedDuration: null, convexity: null };

describe("credit spread shock", () => {
  it("+100bp alone on a bond: −D·Δs + ½C·Δs² (duration proxy, labelled)", () => {
    const r = runStress([bond], 0, { creditSpreadShockBp: 100 });
    expect(r.positions[0].pnl.credit).toBeCloseTo(100_000 * (-4 * 0.01 + 0.5 * 20 * 0.0001), 8);
    expect(r.positions[0].assumptions.spreadBasis).toBe("modified duration (proxy)");
  });
  it("rates +100bp and spread +50bp reprice once on Δy + Δs; rate + credit = combined (no double shock)", () => {
    const r = runStress([bond], 0, { rateShock: 0.01, creditSpreadShockBp: 50 });
    const f = (dy: number) => -4 * dy + 0.5 * 20 * dy * dy;
    expect(r.positions[0].pnl.rate).toBeCloseTo(100_000 * f(0.01), 8);
    expect(r.positions[0].pnl.rate + r.positions[0].pnl.credit).toBeCloseTo(100_000 * f(0.015), 8);
    expect(r.pnl).toBeCloseTo(100_000 * f(0.015), 8);
  });
  it("uses curve-based spread duration when available; per-symbol override of the shock", () => {
    const r = runStress([bond, corp], 0, { creditSpreadShockBp: 0, creditSpreadShockBpBySymbol: { CPF30: 200 } });
    const c = r.positions.find((p) => p.symbol === "CPF30")!;
    expect(c.pnl.credit).toBeCloseTo(50_000 * (-2.9 * 0.02 + 0.5 * 12 * 0.0004), 8);
    expect(c.assumptions.spreadBasis).toBe("Z-spread repricing");
    expect(r.positions.find((p) => p.symbol === "LB29")!.pnl.credit).toBe(0);
  });
  it("equities are unaffected; funds need a spread-duration override (warning, not zero risk silently)", () => {
    const r = runStress([stock, fund], 0, { creditSpreadShockBp: 100 });
    expect(r.positions[0].pnl.credit).toBe(0);
    expect(r.warnings.some((w) => w.includes("KFIX") && w.includes("spread duration"))).toBe(true);
    const o = runStress([fund], 0, { creditSpreadShockBp: 100, spreadDurationOverride: { KFIX: 2 } });
    expect(o.positions[0].pnl.credit).toBeCloseTo(-400, 8);
  });
  it("factor attribution sums to the total; issuer and rating exposures reported", () => {
    const r = runStress([bond, corp, stock], 10_000, { equityShock: -0.1, rateShock: 0.005, creditSpreadShockBp: 75, liquidityHaircut: { bond: 0.01 } });
    const f = r.byFactor;
    expect(f.equity + f.rate + f.credit + f.specific + f.fx + f.liquidity).toBeCloseTo(r.pnl, 8);
    expect(r.exposure.byRating.map((g) => g.key).sort()).toEqual(["A", "AAA"]);
    expect(r.exposure.byIssuer.find((g) => g.key === "PTT")!.value).toBe(80_000);
  });
  it("legacy payload (no credit fields) gives exactly the previous result", () => {
    const r = runStress([bond, stock], 0, { equityShock: -0.2, rateShock: 0.01 });
    expect(r.positions[0].pnl.total).toBeCloseTo(100_000 * (-4 * 0.01 + 0.5 * 20 * 0.0001), 10);
    expect(r.positions[0].pnl.credit).toBe(0);
    expect(r.pnl).toBeCloseTo(100_000 * (-0.039) + 80_000 * -0.2, 8);
  });
});
