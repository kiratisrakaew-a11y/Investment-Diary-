import { describe, expect, it } from "vitest";
import { multiStageResidualIncome, type RiForecastYear } from "./valuation";
import { rimAtHorizon, rimHorizonComparison, rimPersistenceSensitivity, rimSensitivity, type RimInput } from "./rim-horizon";
import { evaluate } from "../valuation-schemas";

const roes = [0.16, 0.155, 0.15, 0.145, 0.14, 0.135, 0.13, 0.125, 0.12, 0.115];
const forecast: RiForecastYear[] = roes.map((roe) => ({ roe }));
const base: RimInput = { bookValuePerShare: 20, ke: 0.1, price: 25, payoutRatio: 0.4, forecast, terminal: { method: "perpetuity", growth: 0.03 } };

describe("RIM horizon comparison", () => {
  it("each horizon equals the engine run on the first h years (continuing value re-based at h)", () => {
    for (const h of [5, 10]) {
      const r = rimAtHorizon(base, h);
      const m = multiStageResidualIncome({ ...base, forecast: forecast.slice(0, h) });
      expect(r.status).toBe("ok");
      expect(r.value).toBeCloseTo(m.value!, 12);
      expect(r.pvResidualIncome! + r.pvContinuingValue! + base.bookValuePerShare).toBeCloseTo(r.value!, 10);
      expect(r.terminalRoe).toBeCloseTo(roes[h - 1], 12);
      expect(r.impliedPBV).toBeCloseTo(r.value! / 20, 12);
      expect(r.years).toHaveLength(h);
    }
  });

  it("hand-checks a 1-year horizon", () => {
    // B0 = 10, ROE 15%, payout 0 → E1 = 1.5, RI1 = 0.5, B1 = 11.5; CV: RI2 = (0.15 − 0.1)·11.5 = 0.575, g = 0 → 5.75.
    const r = rimAtHorizon({ bookValuePerShare: 10, ke: 0.1, price: 10, payoutRatio: 0, forecast: [{ roe: 0.15 }], terminal: { method: "perpetuity", growth: 0 } }, 1);
    expect(r.value).toBeCloseTo(10 + 0.5 / 1.1 + 5.75 / 1.1, 12);
    expect(r.terminalShareOfPremium).toBeCloseTo(5.75 / 1.1 / (r.value! - 10), 12);
  });

  it("never invents years: a 10Y horizon on 7 years of data is insufficient", () => {
    const short = { ...base, forecast: forecast.slice(0, 7) };
    const c = rimHorizonComparison(short, [5, 10]);
    expect(c.rows[0].status).toBe("ok");
    expect(c.rows[1].status).toBe("insufficient_data");
    expect(c.rows[1].value).toBeNull();
    expect(c.rows[1].errors[0]).toMatch(/7 ปี/);
    expect(c.difference).toBeNull();
  });

  it("explains the 5Y vs 10Y difference and flags differing terminal ROE", () => {
    const c = rimHorizonComparison(base);
    expect(c.difference).toBeCloseTo(c.rows[1].value! - c.rows[0].value!, 12);
    expect(c.notes.join(" ")).toMatch(/ROE หลังจบประมาณการต่างกัน/);
    const fixed = rimHorizonComparison({ ...base, terminal: { method: "perpetuity", growth: 0.03, roe: 0.12 } });
    expect(fixed.notes.join(" ")).not.toMatch(/ROE หลังจบ/);
  });

  it("ω sensitivity is monotonic when ROE > Ke and ω = 0 means RI stops after year h", () => {
    const s = rimPersistenceSensitivity(base);
    for (const row of s.rows) for (let k = 1; k < row.values.length; k++) expect(row.values[k]!).toBeGreaterThan(row.values[k - 1]!);
    const r0 = rimAtHorizon({ ...base, terminal: { method: "persistence", persistence: 0 } }, 5);
    // ω = 0: CV = RI₆/(1+Ke), discounted 5 more years — the next year's RI only.
    expect(r0.pvContinuingValue).toBeCloseTo(((roes[4] - 0.1) * r0.years[4].bookValueEnd) / 1.1 / 1.1 ** 5, 12);
  });

  it("Ke × ROE and Ke × g grids centre on the base value; Ke ≤ g gives null, not a clamp", () => {
    const s = rimSensitivity(base, 10);
    expect(s.keRoe!.grid[2][2]).toBeCloseTo(s.base!, 12);
    expect(s.keGrowth!.grid[2][2]).toBeCloseTo(s.base!, 12);
    expect(s.keRoe!.grid[2][4]!).toBeGreaterThan(s.keRoe!.grid[2][0]!);
    const tight = rimSensitivity({ ...base, ke: 0.04 }, 10);
    expect(tight.keGrowth!.grid[0][4]).toBeNull(); // Ke 2% vs g 4%
  });

  it("EPS overrides and stated book values carry provenance", () => {
    const m = multiStageResidualIncome({ ...base, forecast: [{ eps: 3 }, { roe: 0.15, bookValueEnd: 30 }] });
    expect(m.years[0].earningsSource).toBe("eps");
    expect(m.years[1].bookValueSource).toBe("stated");
    expect(m.years[1].cleanSurplusGap).toBeCloseTo(30 - (m.years[1].bookValueStart + m.years[1].earnings * 0.6), 12);
    expect(m.years[0].cleanSurplusGap).toBe(0);
  });

  it("evaluate exposes the comparison; existing multi-stage values unchanged", () => {
    const ev = evaluate({
      method: "residual_income",
      assumptions: { bookValuePerShare: 20, roe: 0.12, payoutRatio: 0.4, currentPrice: 25, riskFree: 0.03, beta: 1, equityRiskPremium: 0.07, extraPremium: 0, terminalGrowth: 0.03, forecast, model: "multi_stage" },
    });
    const d = ev.details as { horizonComparison: { rows: { horizon: number; value: number }[] }; sensitivity: unknown };
    expect(d.horizonComparison.rows.map((r) => r.horizon)).toEqual([5, 10]);
    expect(d.horizonComparison.rows[1].value).toBeCloseTo(ev.value!, 12);
    expect(d.sensitivity).toBeTruthy();
  });
});

describe("RIM scenarios (phase 1)", () => {
  it("Base equals the point value; Bear < Base < Bull; expected value is the probability-weighted mean", async () => {
    const { rimScenarioAnalysis, defaultRimScenarios } = await import("./rim-horizon");
    const r = rimScenarioAnalysis(base, defaultRimScenarios());
    const point = rimAtHorizon(base, 10).value!;
    const [bear, mid, bull] = r.rows.map((x) => x.value!);
    expect(mid).toBeCloseTo(point, 12);
    expect(bear).toBeLessThan(mid);
    expect(bull).toBeGreaterThan(mid);
    expect(r.expectedValue).toBeCloseTo(0.25 * bear + 0.5 * mid + 0.25 * bull, 12);
    expect(r.errors).toEqual([]);
  });

  it("probabilities that do not sum to 100% give no expected value", async () => {
    const { rimScenarioAnalysis } = await import("./rim-horizon");
    const r = rimScenarioAnalysis(base, [
      { name: "A", probability: 0.5, overrides: {} },
      { name: "B", probability: 0.3, overrides: { roeShift: 0.01 } },
    ]);
    expect(r.expectedValue).toBeNull();
    expect(r.errors.join(" ")).toMatch(/80\.0%/);
  });

  it("hand-checks a 1-year roeShift scenario", async () => {
    const { rimScenarioAnalysis } = await import("./rim-horizon");
    // B0 10, ROE 15% + 1pt = 16%, payout 0, Ke 10%, g 0: RI1 = 0.6, B1 = 11.6, RI2 = 0.06·11.6 = 0.696, CV = 6.96.
    const one: RimInput = { bookValuePerShare: 10, ke: 0.1, price: 10, payoutRatio: 0, forecast: [{ roe: 0.15 }], terminal: { method: "perpetuity", growth: 0 } };
    const r = rimScenarioAnalysis(one, [{ name: "Up", probability: 1, overrides: { roeShift: 0.01 } }]);
    expect(r.rows[0].value).toBeCloseTo(10 + 0.6 / 1.1 + 6.96 / 1.1, 12);
  });

  it("EPS years are not shifted (and say so); payout override replaces every year", async () => {
    const { applyRimScenario } = await import("./rim-horizon");
    const a = applyRimScenario({ ...base, forecast: [{ eps: 3, payoutRatio: 0.2 }, { roe: 0.12 }] }, { name: "x", probability: 1, overrides: { roeShift: 0.02, payoutRatio: 0.6 } });
    expect(a.input.forecast[0]).toEqual({ eps: 3, payoutRatio: 0.6 });
    expect(a.input.forecast[1].roe).toBeCloseTo(0.14, 12);
    expect(a.notes.join(" ")).toMatch(/EPS/);
  });

  it("an override the terminal method cannot use is an error, not silently ignored", async () => {
    const { rimScenarioAnalysis } = await import("./rim-horizon");
    const r = rimScenarioAnalysis(base, [{ name: "ω", probability: 1, overrides: { persistence: 0.5 } }]);
    expect(r.rows[0].value).toBeNull();
    expect(r.rows[0].errors[0]).toMatch(/persistence/);
  });

  it("payout × ω grid: higher payout lowers value when ROE > Ke; one cell matches a direct run", async () => {
    const { rimPayoutSensitivity } = await import("./rim-horizon");
    const s = rimPayoutSensitivity(base, 10);
    expect(s.grid[0][2]!).toBeGreaterThan(s.grid[4][2]!);
    const direct = rimAtHorizon({ ...base, payoutRatio: s.payouts[1], terminal: { method: "persistence", persistence: s.omegas[3] } }, 10).value;
    expect(s.grid[1][3]).toBeCloseTo(direct!, 12);
  });
});

describe("RIM warnings (phase 1)", () => {
  it("payout outside 0–100% and EPS overriding a given ROE are flagged; values unchanged", () => {
    const m = multiStageResidualIncome({ ...base, forecast: [{ roe: 0.15, payoutRatio: 1.2 }, { roe: 0.1, eps: 3 }] });
    expect(m.warnings.some((w) => w.includes("ปีที่ 1: payout 120.0%"))).toBe(true);
    expect(m.warnings.some((w) => w.includes("ปีที่ 2: ใช้ EPS 3.00"))).toBe(true);
    expect(m.years[1].earnings).toBe(3);
  });
  it("ROE far from the statements' ROE is flagged through evaluate; within 5 points is not", async () => {
    const assumptions = { bookValuePerShare: 20, roe: 0.12, payoutRatio: 0.4, currentPrice: 25, riskFree: 0.03, beta: 1, equityRiskPremium: 0.07, extraPremium: 0, terminalGrowth: 0.03, forecast, model: "multi_stage" as const };
    const far = evaluate({ method: "residual_income", assumptions: { ...assumptions, historicalRoe: 0.08 } });
    expect((far.details.warnings as string[]).join(" ")).toMatch(/ต่างจาก ROE จริงในงบ 8.0%/);
    const near = evaluate({ method: "residual_income", assumptions: { ...assumptions, historicalRoe: 0.14 } });
    expect((near.details.warnings as string[]).join(" ")).not.toMatch(/ROE จริงในงบ/);
    expect(far.value).toBeCloseTo(near.value!, 12);
  });
  it("scenarios survive the schema and come back from evaluate", async () => {
    const { residualIncomeSchema } = await import("../valuation-schemas");
    const a = residualIncomeSchema.parse({ bookValuePerShare: 20, roe: 0.12, currentPrice: 25, riskFree: 0.03, beta: 1, equityRiskPremium: 0.07, terminalGrowth: 0.03, forecast, scenarios: [{ name: "Base", probability: 1, overrides: {} }] });
    const ev = evaluate({ method: "residual_income", assumptions: a });
    const sc = ev.details.scenarios as { expectedValue: number };
    expect(sc.expectedValue).toBeCloseTo(ev.value!, 12);
  });
});
