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
