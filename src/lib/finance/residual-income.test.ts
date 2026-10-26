/**
 * Multi-stage residual income: yearly ROE / payout / book-value forecasts plus a continuing value.
 * References are computed by hand inside each test (clean-surplus accounting).
 */
import { describe, expect, it } from "vitest";
import { multiStageResidualIncome, residualIncome } from "./valuation";
import { evaluate } from "../valuation-schemas";
import { explainValuation } from "../valuation-explain";

const base = { bookValuePerShare: 10, ke: 0.1 };

describe("multi-stage residual income", () => {
  it("constant ROE with growth = ROE × retention reproduces the single-stage formula", () => {
    const roe = 0.15;
    const payout = 0.6;
    const g = roe * (1 - payout);
    const r = multiStageResidualIncome({
      ...base,
      forecast: Array.from({ length: 5 }, () => ({ roe, payoutRatio: payout })),
      terminal: { method: "perpetuity", growth: g },
    });
    expect(r.value!).toBeCloseTo(residualIncome(10, roe, 0.1, g), 10);
  });

  it("three explicit years, no residual income afterwards (hand calculation)", () => {
    const r = multiStageResidualIncome({
      ...base,
      forecast: [
        { roe: 0.2, payoutRatio: 0.5 },
        { roe: 0.15, payoutRatio: 0.5 },
        { roe: 0.12, payoutRatio: 0.5 },
      ],
      terminal: { method: "none" },
    });
    // B: 10 → 11 → 11.825 → 12.5345 ; E: 2, 1.65, 1.419 ; RI = E − 0.1·B(t−1): 1, 0.55, 0.2365
    const pv = 1 / 1.1 + 0.55 / 1.1 ** 2 + 0.2365 / 1.1 ** 3;
    expect(r.years.map((y) => y.bookValueEnd)).toEqual([expect.closeTo(11, 10), expect.closeTo(11.825, 10), expect.closeTo(12.5345, 10)]);
    expect(r.value!).toBeCloseTo(10 + pv, 10);
  });

  it("persistence (fade) continuing value: TV = RI(n+1) / (1 + Ke − ω)", () => {
    const r = multiStageResidualIncome({
      ...base,
      forecast: [{ roe: 0.2, payoutRatio: 0.5 }],
      terminal: { method: "persistence", persistence: 0.6, roe: 0.18 },
    });
    // B1 = 11, RI1 = 2 − 1 = 1, RI2 = (0.18 − 0.1)·11 = 0.88
    expect(r.terminalValue!).toBeCloseTo(0.88 / (1 + 0.1 - 0.6), 10);
    expect(r.value!).toBeCloseTo(10 + 1 / 1.1 + r.terminalValue! / 1.1, 10);
  });

  it("explicit book values override clean surplus and the gap is flagged", () => {
    const r = multiStageResidualIncome({
      ...base,
      forecast: [
        { roe: 0.2, payoutRatio: 0.5, bookValueEnd: 12 },
        { roe: 0.15, payoutRatio: 0.5 },
      ],
      terminal: { method: "none" },
    });
    // Year 2 equity charge uses the stated B1 = 12: RI2 = 0.15·12 − 0.1·12 = 0.6
    expect(r.years[1].residualIncome).toBeCloseTo(0.6, 10);
    expect(r.warnings.some((w) => w.includes("clean surplus"))).toBe(true);
  });

  it("explicit EPS is used instead of ROE × opening book value", () => {
    const r = multiStageResidualIncome({ ...base, forecast: [{ eps: 1.5, payoutRatio: 0 }], terminal: { method: "none" } });
    expect(r.years[0].residualIncome).toBeCloseTo(0.5, 10);
    expect(r.years[0].roe).toBeCloseTo(0.15, 10);
  });

  it("Ke ≤ g in perpetuity gives no value", () => {
    const r = multiStageResidualIncome({ ...base, forecast: [{ roe: 0.15, payoutRatio: 0.5 }], terminal: { method: "perpetuity", growth: 0.12 } });
    expect(r.value).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("evaluate / explain use the yearly forecast when it is given", () => {
    const input = {
      method: "residual_income" as const,
      assumptions: {
        bookValuePerShare: 10,
        roe: 0.12,
        payoutRatio: 0.5,
        currentPrice: 12,
        riskFree: 0.02,
        beta: 1,
        equityRiskPremium: 0.08,
        extraPremium: 0,
        terminalGrowth: 0.03,
        forecast: [
          { roe: 0.2, payoutRatio: 0.5 },
          { roe: 0.15, payoutRatio: 0.5 },
          { roe: 0.12, payoutRatio: 0.5 },
        ],
        terminalMethod: "none" as const,
      },
    };
    const v = evaluate(input);
    expect(v.value!).toBeCloseTo(10 + 1 / 1.1 + 0.55 / 1.1 ** 2 + 0.2365 / 1.1 ** 3, 10);
    const e = explainValuation(input)!;
    expect(e.value!).toBeCloseTo(v.value!, 10);
    expect(e.table!.columns).toHaveLength(3);
  });
});

describe("explicit model: multi_stage", () => {
  const common = { bookValuePerShare: 10, roe: 0.12, payoutRatio: 0.5, currentPrice: 12, riskFree: 0.02, beta: 1, equityRiskPremium: 0.08, extraPremium: 0, terminalGrowth: 0.03 };
  const rows = [
    { roe: 0.2, payoutRatio: 0.5 },
    { roe: 0.15, payoutRatio: 0.5, bookValueEnd: 12 },
    { roe: 0.12, payoutRatio: 0.5 },
  ];

  it("parallel yearly arrays (ROE / payout / book value) equal the row form", () => {
    const byRows = evaluate({ method: "residual_income", assumptions: { ...common, model: "multi_stage", forecast: rows, terminalMethod: "none" } });
    const byArrays = evaluate({
      method: "residual_income",
      assumptions: { ...common, model: "multi_stage", roeForecast: [0.2, 0.15, 0.12], payoutForecast: [0.5, 0.5, 0.5], bookValueForecast: [null, 12, null], terminalMethod: "none" },
    });
    expect(byArrays.value!).toBeCloseTo(byRows.value!, 12);
    expect(byArrays.details.model).toBe("multi_stage");
  });

  it("multi_stage without yearly data is an error, not a silent single-stage value", () => {
    const r = evaluate({ method: "residual_income", assumptions: { ...common, model: "multi_stage" } });
    expect(r.value).toBeNull();
    expect((r.details.errors as { message: string }[]).length).toBeGreaterThan(0);
  });

  it("single_stage ignores a forecast that is present", () => {
    const r = evaluate({ method: "residual_income", assumptions: { ...common, model: "single_stage", forecast: rows } });
    expect(r.value!).toBeCloseTo(residualIncome(10, 0.12, 0.1, 0.03), 12);
  });
});
