/** Audit B-1 / §14.5: bond scenarios and the horizon return decomposition (independent checks). */
import { describe, expect, it } from "vitest";
import { analyticsFromYield, horizonReturn } from "./finance/bonds";
import { valuationInput } from "./valuation-schemas";
import { bondScenarioResults, presetBondScenarios } from "./bond-scenarios";

const spec = { settlement: "2026-06-15", maturity: "2031-06-15", couponRate: 0.03, frequency: 2 as const, dayCount: "ACT/ACT-ICMA" as const };
const today = analyticsFromYield(spec, 0.04);
const base = (horizon?: { date: string; reinvestRate: number; exitYield?: number }) =>
  valuationInput.parse({ method: "bond", assumptions: { ...spec, cleanPrice: today.cleanPrice, ...(horizon ? { horizon } : {}) } });

describe("horizon return decomposition", () => {
  it("coupon + reinvestment + price change = future value − purchase (hand case)", () => {
    const h = horizonReturn(spec, today.cleanPrice, { horizonDate: "2028-06-15", reinvestRate: 0.03, exitYield: 0.05 });
    // 4 semi-annual coupons of 1.5 received before the horizon.
    expect(h.couponIncome).toBeCloseTo(6, 12);
    // Reinvested at 1.5% per half-year: 1.5·(1.015³ + 1.015² + 1.015 + 1) − 6
    expect(h.reinvestmentIncome).toBeCloseTo(1.5 * (1.015 ** 3 + 1.015 ** 2 + 1.015 + 1) - 6, 10);
    const sale = analyticsFromYield({ ...spec, settlement: "2028-06-15" }, 0.05).dirtyPrice;
    expect(h.priceReturn).toBeCloseTo(sale - today.dirtyPrice, 10);
    expect(h.couponIncome + h.reinvestmentIncome + h.priceReturn).toBeCloseTo(h.futureValue - h.initialDirty, 10);
    expect(h.couponsAndReinvestment).toBeCloseTo(h.couponIncome + h.reinvestmentIncome, 10); // unchanged legacy field
  });
});

describe("bond scenarios", () => {
  const rows = presetBondScenarios(0.04, 0.03);

  it("each price now is a full repricing at today's yield + shift; weighted = Σ p × price", () => {
    const r = bondScenarioResults(base(), rows, false);
    const expected = rows.map((s) => analyticsFromYield(spec, 0.04 + s.shiftBp / 10_000).cleanPrice);
    r.summary.scenarios.forEach((s, i) => expect(s.valuePerShare!).toBeCloseTo(expected[i], 8));
    expect(r.summary.probabilityWeightedValue!).toBeCloseTo(0.25 * expected[0] + 0.5 * expected[1] + 0.25 * expected[2], 8);
    expect(r.summary.valueKind).toBe("bond_clean_price");
    expect(r.horizons.every((h) => h == null)).toBe(true);
  });

  it("horizon return per scenario buys at today's price with the scenario exit yield and reinvestment", () => {
    const r = bondScenarioResults(base({ date: "2028-06-15", reinvestRate: 0.03 }), rows, true);
    rows.forEach((s, i) => {
      const exp = horizonReturn(spec, today.cleanPrice, { horizonDate: "2028-06-15", reinvestRate: s.reinvestRate ?? 0.03, exitYield: s.exitYield ?? undefined });
      expect((r.horizons[i] as { totalReturn: number }).totalReturn).toBeCloseTo(exp.totalReturn, 10);
    });
    const w = rows.reduce((t, s, i) => t + s.probability * (r.horizons[i] as { totalReturn: number }).totalReturn, 0);
    expect(r.weightedHorizon!).toBeCloseTo(w, 12);
    // Bear (exit yield +1%) earns less than Bull (exit yield −0.5%).
    expect((r.horizons[0] as { totalReturn: number }).totalReturn).toBeLessThan((r.horizons[2] as { totalReturn: number }).totalReturn);
  });

  it("invalid probabilities give no weighted values; an invalid horizon date does not block price now", () => {
    const bad = rows.map((s, i) => (i === 2 ? { ...s, probability: 0.2 } : s));
    const r = bondScenarioResults(base({ date: "2028-06-15", reinvestRate: 0.03 }), bad, true);
    expect(r.summary.probabilityWeightedValue).toBeNull();
    expect(r.weightedHorizon).toBeNull();
    expect(r.probErrors.join()).toMatch(/100%/);
    const late = bondScenarioResults(base({ date: "2035-01-01", reinvestRate: 0.03 }), rows, true);
    expect(late.summary.probabilityWeightedValue).not.toBeNull();
    expect(late.horizons.every((h) => h != null && "error" in h)).toBe(true);
    expect(late.weightedHorizon).toBeNull();
  });
});
