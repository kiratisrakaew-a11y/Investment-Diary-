/**
 * Valuation regression baseline (Valuation/UI roadmap P0). Values recorded from HEAD ac78d85 before
 * any P2–P4 change, plus independent hand calculations. Legacy assumptions without `forecastMode`
 * must keep producing these numbers.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DCF,
  dcf,
  dcfSensitivity,
  defaultScenarios,
  gordonGrowth,
  hModel,
  impliedGrowthDetailed,
  multiStageResidualIncome,
  residualIncome,
  scenarioAnalysis,
  twoStageDdm,
  type DcfAssumptions,
} from "./valuation";
import { evaluate } from "../valuation-schemas";

const close = (a: number | null | undefined, b: number) => expect(a!).toBeCloseTo(b, 8);

describe("golden: DCF (DEFAULT_DCF, legacy linear fade)", () => {
  it("FCFF", () => {
    const r = dcf(DEFAULT_DCF, "fcff");
    close(r.valuePerShare, 27.527143235286506);
    close(r.enterpriseValue, 157635.71617643253);
    close(r.terminalValue, 180605.9499458823);
    close(r.sumPvCashFlows, 37247.41889962431);
    close(r.discountRate, 0.0845);
    close(dcf({ ...DEFAULT_DCF, midYear: true, terminalMethod: "stable_roic" }, "fcff").valuePerShare, 26.95392994734781);
    close(dcf({ ...DEFAULT_DCF, terminalMethod: "exit_multiple" }, "fcff").valuePerShare, 25.226051856625748);
    dcfSensitivity(DEFAULT_DCF, "fcff", "ebitMargin").grid[2].forEach((v, i) => close(v, [21.370181973961937, 24.448662604624232, 27.527143235286506, 30.605623865948793, 33.68410449661107][i]));
    close(scenarioAnalysis(DEFAULT_DCF, "fcff", defaultScenarios(DEFAULT_DCF)).expectedValue, 27.79022862998779);
    close(impliedGrowthDetailed(DEFAULT_DCF, "fcff").rate, 0.07734421083636345);
  });
  it("FCFE", () => {
    const r = dcf(DEFAULT_DCF, "fcfe");
    close(r.valuePerShare, 27.459205964155675);
    close(r.equityValue, 137296.02982077838);
    close(r.discountRate, 0.095);
    close(dcf({ ...DEFAULT_DCF, midYear: true, terminalMethod: "stable_roic" }, "fcfe").valuePerShare, 26.49643464663542);
    close(dcf({ ...DEFAULT_DCF, terminalMethod: "exit_multiple" }, "fcfe").valuePerShare, 20.286753946052567);
    close(dcf({ ...DEFAULT_DCF, debtPolicy: "explicit_schedule", netBorrowingSchedule: [100, 200, -50, 0, 300] }, "fcfe").valuePerShare, 26.843439930952723);
    close(scenarioAnalysis(DEFAULT_DCF, "fcfe", defaultScenarios(DEFAULT_DCF)).expectedValue, 27.68598494069966);
    close(impliedGrowthDetailed(DEFAULT_DCF, "fcfe").rate, 0.07758939917818164);
  });
  it("hand calculation: 2-year FCFF, Gordon terminal", () => {
    // FCFF₁ = 100·1.1·20% = 22; FCFF₂ = 24.2; TV = 24.2·1.02/(0.10 − 0.02) = 308.55
    // V = 22/1.1 + 24.2/1.1² + 308.55/1.1² = 20 + 20 + 255 = 295
    const a: DcfAssumptions = { ...DEFAULT_DCF, revenue0: 100, years: 2, growthStart: 0.1, growthEnd: 0.1, ebitMarginStart: 0.2, ebitMarginEnd: 0.2, taxRate: 0, daPct: 0, capexPct: 0, nwcPct: 0, debt: 0, cash: 0, otherClaims: 0, sharesOutstanding: 1, riskFree: 0.1, beta: 0, equityRiskPremium: 0, extraPremium: 0, targetDebtWeight: 0, terminalGrowth: 0.02 };
    close(dcf(a, "fcff").valuePerShare, 295);
  });
});

describe("golden: residual income and DDM", () => {
  it("single and multi-stage RIM", () => {
    close(residualIncome(20, 0.14, 0.1, 0.04), 33.333333333333336);
    close(multiStageResidualIncome({ bookValuePerShare: 20, ke: 0.1, payoutRatio: 0.4, forecast: [{ roe: 0.15 }, { roe: 0.14 }, { roe: 0.13 }, { roe: 0.12 }, { roe: 0.12 }], terminal: { method: "perpetuity", growth: 0.03 } }).value, 28.043033457321215);
    close(multiStageResidualIncome({ bookValuePerShare: 20, ke: 0.1, payoutRatio: 0.4, forecast: [{ roe: 0.15 }, { eps: 3 }, { roe: 0.13, bookValueEnd: 24 }], terminal: { method: "persistence", persistence: 0.6 } }).value, 23.200601051840717);
    close(evaluate({ method: "residual_income", assumptions: { bookValuePerShare: 20, roe: 0.14, payoutRatio: 0.4, currentPrice: 25, riskFree: 0.025, beta: 1, equityRiskPremium: 0.07, extraPremium: 0, terminalGrowth: 0.04, roeForecast: [0.15, 0.14, 0.13] } } as never).value, 34.79986179790867);
  });
  it("hand calculation: 2-year RIM, no continuing value", () => {
    // B₀ 10, ROE 15%, payout 0, Ke 10%: RI₁ = 1.5 − 1 = 0.5; B₁ = 11.5; RI₂ = 1.725 − 1.15 = 0.575
    // V = 10 + 0.5/1.1 + 0.575/1.21 = 10.929752066
    close(multiStageResidualIncome({ bookValuePerShare: 10, ke: 0.1, payoutRatio: 0, forecast: [{ roe: 0.15 }, { roe: 0.15 }], terminal: { method: "none" } }).value, 10 + 0.5 / 1.1 + 0.575 / 1.21);
  });
  it("DDM", () => {
    close(twoStageDdm(2, 0.1, 0.08, 5, 0.03).value, 36.31636808570842);
    close(gordonGrowth(2, 0.1, 0.03), 29.428571428571427);
    close(hModel(2, 0.1, 0.08, 0.03, 3), 33.714285714285715);
  });
  it("invalid input fails cleanly", () => {
    expect(dcf({ ...DEFAULT_DCF, terminalGrowth: 0.2 }, "fcff").valuePerShare).toBeNull();
    expect(dcf({ ...DEFAULT_DCF, sharesOutstanding: 0 }, "fcfe").errors.map((e) => e.code)).toContain("INVALID_SHARES");
    expect(multiStageResidualIncome({ bookValuePerShare: 10, ke: 0.05, forecast: [{ roe: 0.1 }], terminal: { method: "perpetuity", growth: 0.06 } }).value).toBeNull();
  });
});
