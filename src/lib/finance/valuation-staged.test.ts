import { describe, expect, it } from "vitest";
import { DEFAULT_DCF, dcf, dcfSensitivity, defaultScenarios, forecastYears, impliedGrowthDetailed, scenarioAnalysis, yearDrivers, type DcfAssumptions, type DcfStage } from "./valuation";
import { dcfSchema, evaluate } from "../valuation-schemas";

const base: DcfAssumptions = { ...DEFAULT_DCF };

/** Three stages that together reproduce nothing in particular — a typical 10-year path. */
const threeStage: DcfStage[] = [
  { name: "High growth", years: 3, revenueGrowthStart: 0.12, revenueGrowthEnd: 0.1, ebitMarginStart: 0.14, ebitMarginEnd: 0.15 },
  { name: "Transition", years: 4, revenueGrowthStart: 0.08, revenueGrowthEnd: 0.05, ebitMarginStart: 0.15, ebitMarginEnd: 0.16 },
  { name: "Mature", years: 3, revenueGrowthStart: 0.04, revenueGrowthEnd: 0.03, ebitMarginStart: 0.16, ebitMarginEnd: 0.16, capexPct: 0.04 },
];
const staged: DcfAssumptions = { ...base, forecastMode: "staged", years: 10, stages: threeStage };

describe("staged DCF — drivers", () => {
  it("legacy mode is untouched when forecastMode is absent or linear_fade", () => {
    const v = dcf(base, "fcff").valuePerShare;
    expect(v).toBeCloseTo(27.527143235286506, 10);
    expect(dcf({ ...base, forecastMode: "linear_fade", stages: threeStage }, "fcff").valuePerShare).toBeCloseTo(v!, 10);
  });

  it("interpolates linearly within each stage and inherits base reinvestment", () => {
    const d = yearDrivers(staged);
    expect(d).toHaveLength(10);
    expect(forecastYears(staged)).toBe(10);
    expect(d.map((x) => x.stage)).toEqual([0, 0, 0, 1, 1, 1, 1, 2, 2, 2]);
    expect(d[0].growth).toBeCloseTo(0.12);
    expect(d[1].growth).toBeCloseTo(0.11);
    expect(d[2].growth).toBeCloseTo(0.1);
    expect(d[3].growth).toBeCloseTo(0.08);
    expect(d[4].growth).toBeCloseTo(0.07);
    expect(d[6].growth).toBeCloseTo(0.05);
    expect(d[0].capexPct).toBe(base.capexPct);
    expect(d[9].capexPct).toBe(0.04);
    expect(d[9].taxRate).toBe(base.taxRate);
  });

  it("a single-year stage takes its end value (same rule as legacy lerp)", () => {
    const d = yearDrivers({ ...staged, stages: [{ years: 1, revenueGrowthStart: 0.5, revenueGrowthEnd: 0.2, ebitMarginStart: 0.1, ebitMarginEnd: 0.12 }, threeStage[2]] });
    expect(d[0].growth).toBeCloseTo(0.2);
    expect(d[0].ebitMargin).toBeCloseTo(0.12);
  });

  it("two stages that trace the legacy fade give the same value (FCFF and FCFE, mid-year, all terminals)", () => {
    // Legacy 5y fade 0.08 → 0.04 is 0.08, 0.07, 0.06, 0.05, 0.04; margins 0.15 → 0.17 step 0.005.
    const leg: DcfAssumptions = { ...base, years: 5, growthStart: 0.08, growthEnd: 0.04, ebitMarginStart: 0.15, ebitMarginEnd: 0.17 };
    const st: DcfAssumptions = {
      ...leg,
      forecastMode: "staged",
      stages: [
        { years: 3, revenueGrowthStart: 0.08, revenueGrowthEnd: 0.06, ebitMarginStart: 0.15, ebitMarginEnd: 0.16 },
        { years: 2, revenueGrowthStart: 0.05, revenueGrowthEnd: 0.04, ebitMarginStart: 0.165, ebitMarginEnd: 0.17 },
      ],
    };
    for (const model of ["fcff", "fcfe"] as const)
      for (const terminalMethod of ["gordon", "stable_roic", "exit_multiple"] as const)
        for (const midYear of [false, true]) {
          const a = dcf({ ...leg, terminalMethod, midYear }, model);
          const b = dcf({ ...st, terminalMethod, midYear }, model);
          expect(b.errors).toEqual([]);
          expect(b.valuePerShare).toBeCloseTo(a.valuePerShare!, 9);
          expect(b.terminalValue).toBeCloseTo(a.terminalValue!, 6);
        }
  });

  it("per-stage capex / tax / δ change the cash flows of that stage only", () => {
    const r0 = dcf(staged, "fcfe");
    const r1 = dcf({ ...staged, stages: staged.stages!.map((s, k) => (k === 1 ? { ...s, taxRate: 0.3, debtFinancingRatio: 0.5 } : s)) }, "fcfe");
    expect(r1.years[0].fcfe).toBeCloseTo(r0.years[0].fcfe, 9);
    expect(r1.years[3].fcfe).not.toBeCloseTo(r0.years[3].fcfe, 3);
    expect(r1.years[3].stage).toBe(1);
  });

  it("hand-checks a 2-stage, 2-year FCFF", () => {
    // Stage A (1y): g 10%, margin 20%; stage B (1y): g 0%, margin 10%. No reinvestment, no tax.
    const a: DcfAssumptions = {
      ...base,
      revenue0: 1000,
      forecastMode: "staged",
      years: 2,
      stages: [
        { years: 1, revenueGrowthStart: 0.1, revenueGrowthEnd: 0.1, ebitMarginStart: 0.2, ebitMarginEnd: 0.2 },
        { years: 1, revenueGrowthStart: 0, revenueGrowthEnd: 0, ebitMarginStart: 0.1, ebitMarginEnd: 0.1 },
      ],
      taxRate: 0,
      daPct: 0,
      capexPct: 0,
      nwcPct: 0,
      debt: 0,
      cash: 0,
      otherClaims: 0,
      sharesOutstanding: 1,
      targetDebtWeight: 0,
      terminalGrowth: 0,
      riskFree: 0.1,
      beta: 0,
      equityRiskPremium: 0,
      extraPremium: 0,
      midYear: false,
      terminalMethod: "gordon",
    };
    const r = dcf(a, "fcff");
    // FCF1 = 220, FCF2 = 110; TV = 110/0.1 = 1100. EV = 220/1.1 + (110 + 1100)/1.21 = 200 + 1000.
    expect(r.years.map((y) => y.fcff)).toEqual([expect.closeTo(220, 9), expect.closeTo(110, 9)]);
    expect(r.enterpriseValue).toBeCloseTo(1200, 9);
  });
});

describe("staged DCF — validation (never clamped)", () => {
  const issues = (a: DcfAssumptions) => dcf(a, "fcff").errors.map((e) => e.code);
  it("rejects 1 or 5 stages, fractional years, total > 20, bad tax", () => {
    expect(issues({ ...staged, stages: [threeStage[0]] })).toContain("INVALID_STAGES");
    expect(issues({ ...staged, stages: [...threeStage, threeStage[0], threeStage[0]] })).toContain("INVALID_STAGES");
    expect(issues({ ...staged, stages: [{ ...threeStage[0], years: 2.5 }, threeStage[1]] })).toContain("INVALID_STAGES");
    expect(issues({ ...staged, stages: [{ ...threeStage[0], years: 15 }, { ...threeStage[1], years: 6 }] })).toContain("INVALID_STAGES");
    expect(issues({ ...staged, stages: [{ ...threeStage[0], taxRate: 1.2 }, threeStage[1]] })).toContain("INVALID_TAX");
    expect(issues({ ...staged, stages: [{ ...threeStage[0], revenueGrowthStart: Number.NaN }, threeStage[1]] })).toContain("INVALID_STAGES");
    expect(dcf({ ...staged, stages: [threeStage[0]] }, "fcff").valuePerShare).toBeNull();
  });
  it("warns on years mismatch and stage discontinuities but still values", () => {
    const r = dcf({ ...staged, years: 5 }, "fcff");
    expect(r.errors).toEqual([]);
    expect(r.years).toHaveLength(10);
    expect(r.warnings.join(" ")).toMatch(/10 ปี/);
    expect(r.warnings.join(" ")).not.toMatch(/รอยต่อ/); // 0.10 → 0.08 is only 2 points
    const big = dcf({ ...staged, stages: [threeStage[0], { ...threeStage[1], revenueGrowthStart: 0.2 }, threeStage[2]] }, "fcff");
    expect(big.warnings.some((w) => w.includes("growth กระโดด"))).toBe(true);
  });
});

describe("staged DCF — scenarios, sensitivity, reverse DCF", () => {
  it("default staged scenarios use stageOverrides; probabilities sum to 1; base equals the point value", () => {
    const sc = defaultScenarios(staged);
    expect(sc.reduce((s, x) => s + x.probability, 0)).toBeCloseTo(1);
    expect(sc[0].stageOverrides).toHaveLength(3);
    const r = scenarioAnalysis(staged, "fcff", sc);
    const point = dcf(staged, "fcff").valuePerShare!;
    expect(r.rows.find((x) => x.name === "Base")!.value).toBeCloseTo(point, 9);
    expect(r.rows[0].value!).toBeLessThan(point);
    expect(r.rows[2].value!).toBeGreaterThan(point);
  });
  it("rejects legacy fade overrides in staged mode instead of ignoring them", () => {
    const r = scenarioAnalysis(staged, "fcff", [
      { name: "Bad", probability: 0.5, overrides: { growthStart: 0.2 } },
      { name: "Base", probability: 0.5, overrides: {} },
    ]);
    expect(r.rows[0].value).toBeNull();
    expect(r.rows[0].errors[0]).toMatch(/stageOverrides/);
  });
  it("margin sensitivity shifts every stage; middle cell equals the point value", () => {
    const s = dcfSensitivity(staged, "fcff", "ebitMargin");
    const mid = s.grid[Math.floor(s.grid.length / 2)];
    expect(mid[Math.floor(mid.length / 2)]).toBeCloseTo(dcf(staged, "fcff").valuePerShare!, 9);
    expect(mid[mid.length - 1]!).toBeGreaterThan(mid[0]!);
  });
  it("reverse DCF solves a uniform stage shift that reproduces the price", () => {
    const r = impliedGrowthDetailed(staged, "fcff");
    expect(r.basis).toBe("stage_shift");
    expect(r.status).toBe("ok");
    const shifted = { ...staged, stages: staged.stages!.map((s) => ({ ...s, revenueGrowthStart: s.revenueGrowthStart + r.rate!, revenueGrowthEnd: s.revenueGrowthEnd + r.rate! })) };
    expect(dcf(shifted, "fcff").valuePerShare).toBeCloseTo(staged.currentPrice, 4);
    expect(impliedGrowthDetailed(base, "fcff").basis).toBe("constant_growth");
  });
});

describe("staged DCF — schema / evaluate round-trip", () => {
  it("parses, survives JSON, and evaluates; legacy JSON parses without the new fields", () => {
    const json = JSON.parse(JSON.stringify(staged));
    const parsed = dcfSchema.parse(json);
    expect(parsed.forecastMode).toBe("staged");
    expect(parsed.stages).toHaveLength(3);
    const ev = evaluate({ method: "dcf_fcff", assumptions: parsed });
    expect(ev.value).toBeCloseTo(dcf(staged, "fcff").valuePerShare!, 9);
    const legacy = dcfSchema.parse(JSON.parse(JSON.stringify(base)));
    expect(legacy.forecastMode).toBeUndefined();
    expect(evaluate({ method: "dcf_fcff", assumptions: legacy }).value).toBeCloseTo(27.527143235286506, 10);
  });
});
