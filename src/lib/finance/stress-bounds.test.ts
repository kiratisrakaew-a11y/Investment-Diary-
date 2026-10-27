/** Audit S-1: a long, fully paid position cannot lose more than its value in a stress scenario. */
import { describe, expect, it } from "vitest";
import { runStress, type StressPosition } from "./stress";

const pos = (o: Partial<StressPosition>): StressPosition => ({ symbol: "X", assetClass: "thai_stock", currency: "THB", value: 100, beta: 1, modifiedDuration: null, convexity: null, ...o });

describe("stress loss bound (long-only)", () => {
  it("β 1.8 × −60% (linear −108%) is floored at −100% with the linear figure and a warning", () => {
    const r = runStress([pos({ beta: 1.8 })], 0, { equityShock: -0.6 });
    const p = r.positions[0];
    expect(p.linearReturn).toBeCloseTo(-1.08, 12);
    expect(p.boundedAtFullLoss).toBe(true);
    expect(p.pnl.total).toBeCloseTo(-100, 12);
    expect(r.navAfter).toBeCloseTo(0, 12);
    expect(r.byFactor.equity).toBeCloseTo(-100, 12);
    expect(r.warnings.join()).toMatch(/−100%/);
  });

  it("factor lines are scaled so they still sum to the floored total", () => {
    const r = runStress([pos({ beta: 1 })], 50, { equityShock: -0.6, specific: { X: -0.6 } });
    const p = r.positions[0];
    expect(p.linearReturn).toBeCloseTo(-1.2, 12);
    expect(p.pnl.equity + p.pnl.specific).toBeCloseTo(-100, 12);
    expect(p.pnl.equity / p.pnl.specific).toBeCloseTo(1, 12);
    expect(r.navAfter).toBeCloseTo(50, 12); // cash untouched
    expect(r.pnlPct).toBeCloseTo(-100 / 150, 12);
  });

  it("within range nothing changes (hand check)", () => {
    const r = runStress([pos({ beta: 1.2 }), pos({ symbol: "B", assetClass: "bond", beta: null, modifiedDuration: 5, convexity: 30 })], 0, { equityShock: -0.2, rateShock: 0.01 });
    expect(r.positions[0].boundedAtFullLoss).toBe(false);
    expect(r.positions[0].pnl.total).toBeCloseTo(100 * 1.2 * -0.2, 12);
    expect(r.positions[1].pnl.total).toBeCloseTo(100 * (-5 * 0.01 + 0.5 * 30 * 0.0001), 12);
    expect(r.positions[1].linearReturn).toBeCloseTo(-0.0485, 12);
    expect(r.warnings.join()).not.toMatch(/−100%/);
  });

  it("liquidity haircut applies to the post-shock value, which is never negative", () => {
    const r = runStress([pos({ beta: 2 })], 0, { equityShock: -0.7, liquidityHaircut: { thai_stock: 0.1 } });
    expect(r.positions[0].pnl.liquidity).toBeCloseTo(0, 12);
    expect(r.positions[0].pnl.total).toBeCloseTo(-100, 12);
  });
});
