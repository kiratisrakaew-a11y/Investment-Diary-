/**
 * PR 2 / Phase C regression tests — equity valuation reliability.
 * Expected values are derived analytically inside each test, not from the code under test.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_DCF, dcf, dcfAtRate, dcfSensitivity, impliedGrowthDetailed, scenarioAnalysis, type DcfAssumptions } from "./valuation";

// Revenue 1,000, EBIT margin 20%, tax 25%, capex = D&A, no NWC → NOPAT = FCFF = 150; Ke = WACC = 10% (no debt).
const flat: DcfAssumptions = {
  ...DEFAULT_DCF,
  revenue0: 1000,
  years: 5,
  growthStart: 0,
  growthEnd: 0,
  terminalGrowth: 0,
  ebitMarginStart: 0.2,
  ebitMarginEnd: 0.2,
  taxRate: 0.25,
  daPct: 0.05,
  capexPct: 0.05,
  nwcPct: 0,
  debt: 0,
  cash: 100,
  otherClaims: 0,
  sharesOutstanding: 100,
  currentPrice: 12,
  riskFree: 0.02,
  beta: 1,
  equityRiskPremium: 0.08,
  extraPremium: 0,
  costOfDebt: 0.05,
  targetDebtWeight: 0,
  debtFinancingRatio: 0,
  terminalMethod: "gordon",
  midYear: false,
};
const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

describe("C1 input validation", () => {
  it("discount rate ≤ terminal growth never yields a finite fair value", () => {
    const r = dcf({ ...flat, terminalGrowth: 0.12 }, "fcff");
    expect(r.valuePerShare).toBeNull();
    expect(r.upside).toBeNull();
    expect(codes(r)).toContain("RATE_NOT_ABOVE_GROWTH");
  });
  it("shares ≤ 0 is an error, not a division by zero", () => {
    const r = dcf({ ...flat, sharesOutstanding: 0 }, "fcff");
    expect(r.valuePerShare).toBeNull();
    expect(codes(r)).toContain("INVALID_SHARES");
  });
  it("tax rate outside [0, 1] and negative revenue are rejected", () => {
    expect(codes(dcf({ ...flat, taxRate: 1.5 }, "fcff"))).toContain("INVALID_TAX");
    expect(codes(dcf({ ...flat, revenue0: -1 }, "fcff"))).toContain("NEGATIVE_REVENUE");
  });
});

describe("C3 terminal steady state", () => {
  const grow = { ...flat, growthStart: 0.03, growthEnd: 0.03, terminalGrowth: 0.03 };

  it("stable ROIC: FCFF(n+1) = NOPAT(n)(1+g)(1 − g/ROIC), TV = FCFF(n+1)/(WACC − g)", () => {
    const r = dcf({ ...grow, terminalMethod: "stable_roic", terminalRoic: 0.15 }, "fcff");
    const nopatNext = r.years[r.years.length - 1].nopat * 1.03;
    expect(r.terminal.reinvestmentRate!).toBeCloseTo(0.03 / 0.15, 12);
    expect(r.terminal.cashFlowNext!).toBeCloseTo(nopatNext * (1 - 0.2), 8);
    expect(r.terminalValue!).toBeCloseTo((nopatNext * 0.8) / (0.1 - 0.03), 6);
  });

  it("stable ROE for FCFE: FCFE(n+1) = NI(n)(1+g)(1 − g/ROE), discounted at Ke", () => {
    const r = dcf({ ...grow, terminalMethod: "stable_roic", terminalRoe: 0.12 }, "fcfe");
    const niNext = r.years[r.years.length - 1].netIncome * 1.03;
    expect(r.terminal.reinvestmentRate!).toBeCloseTo(0.03 / 0.12, 12);
    expect(r.terminalValue!).toBeCloseTo((niNext * (1 - 0.25)) / (0.1 - 0.03), 6);
  });

  it("terminal ROIC ≤ 0 is invalid", () => {
    expect(codes(dcf({ ...grow, terminalMethod: "stable_roic", terminalRoic: 0 }, "fcff"))).toContain("INVALID_TERMINAL_RETURN");
  });

  it("Gordon on last FCF discloses implied reinvestment and flags growth without reinvestment", () => {
    // capex = D&A and no NWC → zero reinvestment while growing 3% forever.
    const r = dcf(grow, "fcff");
    expect(r.terminal.reinvestmentRate!).toBeCloseTo(0, 12);
    expect(r.terminal.impliedReturnOnCapital).toBeNull();
    expect(r.warnings.some((w) => w.includes("reinvestment"))).toBe(true);
  });

  it("warns at > 70% and > 80% terminal-value share", () => {
    // Flat perpetuity at 10%: PV(TV) share = 1.1^−n → n = 3: 75.1%, n = 2: 82.6%.
    expect(dcf({ ...flat, years: 3 }, "fcff").warnings.some((w) => w.includes("70%"))).toBe(true);
    expect(dcf({ ...flat, years: 2 }, "fcff").warnings.some((w) => w.includes("80%"))).toBe(true);
  });
});

describe("C5 mid-year convention", () => {
  it("flat perpetuity with mid-year flows = CF/r × (1 + r)^0.5 (terminal flows are mid-year too)", () => {
    const r = dcf({ ...flat, midYear: true }, "fcff");
    expect(r.enterpriseValue!).toBeCloseTo(1500 * Math.sqrt(1.1), 6);
  });
  it("exit-multiple terminal value is a point-in-time price discounted from year n", () => {
    const r = dcf({ ...flat, midYear: true, terminalMethod: "exit_multiple", exitMultiple: 8 }, "fcff");
    expect(r.pvTerminalValue!).toBeCloseTo(r.terminalValue! / 1.1 ** 5, 8);
  });
});

describe("C4 FCFE debt schedule", () => {
  // EBIT 200, Kd 5%, debt 400.
  const lev = { ...flat, cash: 0, debt: 400, targetDebtWeight: 0.25 };

  it("explicit schedule: closing = opening + net borrowing, interest on opening debt, FCFE includes borrowing", () => {
    const r = dcf({ ...lev, debtPolicy: "explicit_schedule", netBorrowingSchedule: [100, -50, 0, 0, 0] }, "fcfe");
    const [y1, y2] = r.years;
    expect(y1.openingDebt).toBe(400);
    expect(y1.closingDebt).toBe(500);
    expect(y2.openingDebt).toBe(500);
    expect(y2.interest).toBeCloseTo(25);
    expect(y2.closingDebt).toBe(450);
    expect(y1.fcfe).toBeCloseTo((200 - 20) * 0.75 + 100, 10);
  });

  it("a schedule shorter than the horizon is flagged", () => {
    const r = dcf({ ...lev, debtPolicy: "explicit_schedule", netBorrowingSchedule: [100] }, "fcfe");
    expect(r.warnings.some((w) => w.includes("ตารางกู้สุทธิ"))).toBe(true);
  });

  it("leveraged firm with constant perpetual debt: FCFF and FCFE values reconcile (MM with taxes)", () => {
    // Ku = 10%, D = 400, T = 25% → V = 1,500 + T·D = 1,600, E = 1,200,
    // Ke = Ku + (Ku − Kd)(1 − T)D/E = 11.25%, WACC = Ku(1 − T·D/V) = 9.375%.
    const a = { ...lev, beta: (0.1125 - 0.02) / 0.08, debtPolicy: "fixed_borrowing_ratio" as const };
    const f = dcf(a, "fcff");
    const e = dcf(a, "fcfe");
    expect(f.wacc).toBeCloseTo(0.09375, 12);
    expect(f.equityValue!).toBeCloseTo(1200, 6);
    expect(e.equityValue!).toBeCloseTo(1200, 6);
  });
});

describe("C5 sensitivity and reverse DCF", () => {
  it("invalid sensitivity cells are null, never NaN", () => {
    const s = dcfSensitivity({ ...flat, terminalGrowth: 0.09 }, "fcff");
    expect(s.grid[0][2]).toBeNull(); // 8% < g
    expect(s.grid[2][2]).not.toBeNull();
    expect(s.grid.flat().every((v) => v === null || Number.isFinite(v))).toBe(true);
  });

  it("supports a terminal-ROIC axis whose centre equals the base value", () => {
    const a = { ...flat, growthStart: 0.03, growthEnd: 0.03, terminalGrowth: 0.03, terminalMethod: "stable_roic" as const, terminalRoic: 0.15 };
    const s = dcfSensitivity(a, "fcff", "terminalRoic");
    expect(s.columns).toHaveLength(5);
    expect(s.grid[2][2]!).toBeCloseTo(dcf(a, "fcff").valuePerShare!, 8);
  });

  it("reverse DCF reports status: ok with the root, no_root when the price cannot be justified", () => {
    const a = { ...DEFAULT_DCF, growthStart: 0.05, growthEnd: 0.05, targetDebtWeight: 0.3 };
    const price = dcfAtRate(a, "fcff", dcf(a, "fcff").discountRate)!;
    const ok = impliedGrowthDetailed({ ...a, currentPrice: price }, "fcff");
    expect(ok.status).toBe("ok");
    expect(ok.rate!).toBeCloseTo(0.05, 4);
    const none = impliedGrowthDetailed({ ...a, currentPrice: price * 1e6 }, "fcff");
    expect(none.status).toBe("no_root");
    expect(none.rate).toBeNull();
  });
});

describe("C5 scenarios", () => {
  const sc = [
    { name: "Bear", probability: 0.25, overrides: { ebitMarginStart: 0.15, ebitMarginEnd: 0.15 } },
    { name: "Base", probability: 0.5, overrides: {} },
    { name: "Bull", probability: 0.25, overrides: { ebitMarginStart: 0.25, ebitMarginEnd: 0.25 } },
  ];
  it("probability-weighted fair value and range", () => {
    // Value/share = (FCFF/10% + cash 100) / 100 shares with FCFF = 1,000 × margin × 0.75.
    const v = (m: number) => ((1000 * m * 0.75) / 0.1 + 100) / 100;
    const r = scenarioAnalysis(flat, "fcff", sc);
    expect(r.expectedValue!).toBeCloseTo(0.25 * v(0.15) + 0.5 * v(0.2) + 0.25 * v(0.25), 8);
    expect(r.low!).toBeCloseTo(v(0.15), 8);
    expect(r.high!).toBeCloseTo(v(0.25), 8);
  });
  it("probabilities that do not sum to 100% give no expected value", () => {
    const r = scenarioAnalysis(flat, "fcff", sc.map((s) => ({ ...s, probability: 0.3 })));
    expect(r.expectedValue).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("C6 other methods", () => {
  it("H-model known answer: D0 = 1, Ke 10%, gS 15% → gL 5% over 10 years (H = 5)", async () => {
    const { hModel } = await import("./valuation");
    expect(hModel(1, 0.1, 0.15, 0.05, 5)).toBeCloseTo((1 * 1.05 + 1 * 5 * 0.1) / 0.05, 10);
  });
  it("DDM and residual income give no value when Ke ≤ g", async () => {
    const { evaluate } = await import("../valuation-schemas");
    const ddm = evaluate({
      method: "ddm",
      assumptions: { d0: 1, currentPrice: 20, riskFree: 0.02, beta: 1, equityRiskPremium: 0.04, extraPremium: 0, model: "two_stage", highGrowth: 0.08, highGrowthYears: 5, terminalGrowth: 0.07 },
    });
    expect(ddm.value).toBeNull();
    const ri = evaluate({
      method: "residual_income",
      assumptions: { bookValuePerShare: 10, roe: 0.12, payoutRatio: 0.5, currentPrice: 12, riskFree: 0.02, beta: 1, equityRiskPremium: 0.04, extraPremium: 0, terminalGrowth: 0.06 },
    });
    expect(ri.value).toBeNull();
  });
  it("evaluate exposes DCF errors and never a finite value for r ≤ g", async () => {
    const { evaluate } = await import("../valuation-schemas");
    const r = evaluate({ method: "dcf_fcff", assumptions: { ...flat, terminalGrowth: 0.2 } });
    expect(r.value).toBeNull();
    expect((r.details.errors as { code: string }[]).map((e) => e.code)).toContain("RATE_NOT_ABOVE_GROWTH");
  });
});
