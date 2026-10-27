/** Audit P2 items: FCFE net-income basis, single-stage RIM growth consistency, Sortino MAR. */
import { describe, expect, it } from "vitest";
import { DEFAULT_DCF, dcf, type DcfAssumptions } from "./valuation";
import { evaluate, valuationInput } from "../valuation-schemas";
import { computeMetrics } from "./metrics";

const fcfe: DcfAssumptions = { ...DEFAULT_DCF, otherClaims: 500, targetDebtWeight: 0.3 };

describe("FCFE net-income basis", () => {
  it("default (attributable) keeps the old value and warns that the basis is unstated", () => {
    const r = dcf(fcfe, "fcfe");
    const legacy = dcf({ ...fcfe, otherClaims: 0 }, "fcfe");
    expect(r.equityValue).toBe(legacy.equityValue);
    expect(r.warnings.join()).toMatch(/netIncomeBasis/);
    expect(dcf({ ...fcfe, netIncomeBasis: "attributable" }, "fcfe").warnings.join()).not.toMatch(/netIncomeBasis/);
  });

  it("consolidated deducts minorities exactly once", () => {
    const a = dcf({ ...fcfe, netIncomeBasis: "attributable" }, "fcfe");
    const c = dcf({ ...fcfe, netIncomeBasis: "consolidated" }, "fcfe");
    expect(a.equityValue! - c.equityValue!).toBeCloseTo(500, 9);
    expect(dcf({ ...fcfe, netIncomeBasis: "consolidated" }, "fcff").equityValue).toBe(dcf(fcfe, "fcff").equityValue); // FCFF bridge unchanged
  });
});

describe("single-stage RIM growth consistency", () => {
  const ri = (g: number) =>
    evaluate(valuationInput.parse({ method: "residual_income", assumptions: { bookValuePerShare: 10, roe: 0.12, payoutRatio: 0.5, currentPrice: 12, riskFree: 0.03, beta: 1, equityRiskPremium: 0.06, terminalGrowth: g } }));
  it("warns when g departs from ROE × (1 − payout) by more than 1 point, without changing the value", () => {
    expect((ri(0.06).details.warnings as string[]).length).toBe(0); // 0.12 × 0.5 = 6%
    const r = ri(0.03);
    expect((r.details.warnings as string[]).join()).toMatch(/6\.00%/);
    expect(r.value).toBeCloseTo(10 + ((0.12 - 0.09) * 10) / (0.09 - 0.03), 12);
  });
});

describe("Sortino MAR", () => {
  const values = Array.from({ length: 401 }, (_, i) => ({ date: new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10), value: 100 * (i % 2 ? 1.01 : 1) * 1.0005 ** i, flow: 0 }));
  const base = { values, cashFlows: [{ date: values[0].date, amount: -100 }], finalValue: values[400].value, finalDate: values[400].date, riskFreeRate: 0.02 };
  it("default MAR = Rf gives the previous figure; a custom MAR is applied and reported", () => {
    const d = computeMetrics(base);
    const same = computeMetrics({ ...base, sortinoMar: null });
    expect(same.sortino).toBe(d.sortino);
    expect(d.sortinoMarBasis).toBe("risk_free");
    const m = computeMetrics({ ...base, sortinoMar: 0 });
    expect(m.sortinoMarBasis).toBe("custom");
    // Independent: MAR 0 per period → downside of raw returns.
    const r = values.slice(1).map((v, i) => v.value / values[i].value - 1);
    const N = 400 / (400 / 365);
    const dd = Math.sqrt(r.reduce((a, x) => a + Math.min(0, x) ** 2, 0) / r.length) * Math.sqrt(N);
    expect(m.sortino!).toBeCloseTo(((r.reduce((a, x) => a + x, 0) / r.length) * N) / dd, 10);
    expect(m.sharpe).toBe(d.sharpe); // Sharpe unaffected
  });
});
