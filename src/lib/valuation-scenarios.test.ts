/**
 * PR11–PR12 / PR16 tests 1–5: cross-method scenario engine. Every expected number is computed
 * independently (hand values, or the model function called directly on hand-edited inputs).
 */
import { describe, expect, it } from "vitest";
import { evaluate, valuationInput, type ValuationInput } from "./valuation-schemas";
import { DEFAULT_DCF, dcf, scenarioAnalysis, type DcfAssumptions } from "./finance/valuation";
import { rimScenarioAnalysis } from "./finance/rim-horizon";
import { applyOverrides, parsePath, proposeNormalised, runScenarios, scenariosFromSegments, upsideAndMos, validateProbabilities } from "./valuation-scenarios";

const parse = (x: unknown) => valuationInput.parse(x);

/** SOTP whose per-share value equals one manual segment value (1 share, no debt) — a calculator for hand cases. */
const manual = (value: number, extra: Record<string, unknown> = {}) =>
  parse({
    method: "sotp",
    assumptions: {
      sharesOutstanding: 1,
      currentPrice: 6,
      netDebtBasis: "holdco",
      inputMeta: { asOf: "2026-10-27" },
      segments: [{ id: "core", name: "Core", role: "division", source: { type: "manual", value, source: "hand case", basis: "equity" } }],
      ...extra,
    },
  });

const S = (id: string, probability: number, inputOverrides: Record<string, number | string> = {}) => ({ id, name: id, probability, inputOverrides });

describe("probability-weighted value (PR16 test 1)", () => {
  it("4 / 8 / 12 at 25 / 50 / 25 gives 8 and the base stays 8", () => {
    const input = manual(8);
    const r = runScenarios(input, { scenarios: [S("bear", 0.25, { "segments[core].source.value": 4 }), S("base", 0.5), S("bull", 0.25, { "segments[core].source.value": 12 })] });
    expect(r.scenarios.map((s) => s.valuePerShare)).toEqual([4, 8, 12]);
    expect(r.probabilityWeightedValue).toBeCloseTo(8, 12);
    expect(r.baseCaseValue).toBe(8);
    expect(evaluate(input).value).toBe(8);
    expect(r.qualityStatus).toBe("verified_inputs");
  });

  it("weighted value differs from base and both stay distinct", () => {
    const r = runScenarios(manual(8), { scenarios: [S("bear", 0.5, { "segments[core].source.value": 2 }), S("bull", 0.5, { "segments[core].source.value": 12 })] });
    expect(r.baseCaseValue).toBe(8);
    expect(r.probabilityWeightedValue).toBeCloseTo(7, 12);
  });

  it("upside and margin of safety use their own formulas; non-positive value is N/A", () => {
    expect(upsideAndMos(10, 8)).toMatchObject({ upside: 0.25, mos: 0.2 });
    expect(upsideAndMos(-1, 8).mos).toBeNull();
    expect(upsideAndMos(10, 0)).toMatchObject({ upside: null, mos: null });
  });
});

describe("probability validation (PR16 test 2)", () => {
  it("rejects 25 / 50 / 20 and never normalises silently", () => {
    const r = runScenarios(manual(8), { scenarios: [S("bear", 0.25, { "segments[core].source.value": 4 }), S("base", 0.5), S("bull", 0.2)] });
    expect(r.probabilityWeightedValue).toBeNull();
    expect(r.errors.join(" ")).toMatch(/ต้องเท่ากับ 100%/);
    expect(proposeNormalised([{ id: "a", probability: 0.25 }, { id: "b", probability: 0.5 }, { id: "c", probability: 0.2 }])!.map((x) => x.to.toFixed(6))).toEqual(["0.263158", "0.526316", "0.210526"]);
  });

  it("rejects NaN, Infinity, negative, > 1 and duplicate ids; accepts a 1e-9 rounding gap", () => {
    expect(validateProbabilities([{ id: "a", probability: NaN }, { id: "b", probability: 1 }]).length).toBeGreaterThan(0);
    expect(validateProbabilities([{ id: "a", probability: Infinity }])).not.toEqual([]);
    expect(validateProbabilities([{ id: "a", probability: -0.1 }, { id: "b", probability: 1.1 }]).length).toBeGreaterThanOrEqual(2);
    expect(validateProbabilities([{ id: "a", probability: 0.5 }, { id: "A", probability: 0.5 }]).join()).toMatch(/id ซ้ำ/);
    expect(validateProbabilities([{ id: "a", probability: 1 / 3 }, { id: "b", probability: 1 / 3 }, { id: "c", probability: 1 / 3 + 1e-9 }])).toEqual([]);
    expect(validateProbabilities([{ id: "a", probability: 0.5 }, { id: "b", probability: 0.5 + 1e-7 }])).not.toEqual([]);
  });

  it("a zero-probability invalid scenario is shown but does not contaminate the weighted value", () => {
    const r = runScenarios(manual(8), { scenarios: [S("base", 1), S("broken", 0, { "segments[core].nope": 1 })] });
    expect(r.scenarios[1].valuePerShare).toBeNull();
    expect(r.probabilityWeightedValue).toBe(8);
  });

  it("a positive-probability invalid scenario blocks the weighted value", () => {
    const r = runScenarios(manual(8), { scenarios: [S("base", 0.5), S("broken", 0.5, { "segments[core].ownership": 1.5 })] });
    expect(r.scenarios[1].errors.join()).toMatch(/schema/);
    expect(r.probabilityWeightedValue).toBeNull();
  });
});

/** PLANB-like synthetic fixture: core operating DCF with its own Bear/Base/Bull + a market-valued listed stake. */
const core: DcfAssumptions = {
  ...DEFAULT_DCF,
  revenue0: 8_000,
  debt: 0,
  cash: 0,
  otherClaims: 0,
  sharesOutstanding: 4_000,
  targetDebtWeight: 0.2,
  scenarios: [
    { name: "Bear", probability: 0.25, overrides: { growthStart: 0.02, growthEnd: 0.02 } },
    { name: "Base", probability: 0.5, overrides: {} },
    { name: "Bull", probability: 0.25, overrides: { growthStart: 0.1, growthEnd: 0.06 } },
  ],
};
const planbLike = (extra: Record<string, unknown> = {}) =>
  parse({
    method: "sotp",
    assumptions: {
      sharesOutstanding: 4_000,
      currentPrice: 5,
      netDebt: 1_500,
      inputMeta: { asOf: "2026-10-27" },
      segments: [
        { id: "core", name: "OOH + Engagement", role: "division", source: { type: "model", valuation: { method: "dcf_fcff", assumptions: core } } },
        { id: "com7", entity: "COM7", name: "COM7 stake", role: "investment", ownership: 0.2, source: { type: "market", price: 25, shares: 2_400, asOf: "2026-10-24" } },
      ],
      scenarioSet: { mode: "from_segments" },
      ...extra,
    },
  });

describe("SOTP scenarios (PR16 test 3)", () => {
  it("each scenario reruns the segment DCF and the whole bridge; the stake stays at market", () => {
    const input = planbLike();
    const r = runScenarios(input);
    expect(r.derivedFromSegments).toBe(true);
    expect(r.scenarios.map((s) => s.name)).toEqual(["Bear", "Base", "Bull"]);
    const com7 = 0.2 * 25 * 2_400;
    for (const [i, s] of r.scenarios.entries()) {
      const applied = scenarioAnalysis(core, "fcff", [core.scenarios![i]]).rows[0];
      const ev = dcf({ ...core, ...core.scenarios![i].overrides }, "fcff").enterpriseValue!;
      expect(applied.errors).toEqual([]);
      expect(s.bridge!.segments.find((x) => x.key === "COM7")!.attributable).toBeCloseTo(com7, 6);
      expect(s.bridge!.segments.find((x) => x.key === "CORE")!.attributable).toBeCloseTo(ev, 6);
      expect(s.valuePerShare!).toBeCloseTo((ev + com7 - 1_500) / 4_000, 9);
      expect(Math.abs(s.bridge!.difference!)).toBeLessThan(1e-6);
    }
    const hand = r.scenarios.reduce((t, s) => t + s.probability * s.valuePerShare!, 0);
    expect(r.probabilityWeightedValue).toBeCloseTo(hand, 12);
    // Base scenario equals the stored base value (legacy meaning kept).
    expect(r.scenarios[1].valuePerShare).toBeCloseTo(r.baseCaseValue!, 12);
    expect(r.baseCaseValue).toBe(evaluate(input).value);
    expect(r.qualityStatus).toBe("verified_inputs");
  });

  it("a minority deducted with no partially-owned consolidated segment keeps the result preliminary", () => {
    const r = runScenarios(planbLike({ minorityInterest: 120 }));
    expect(r.qualityStatus).toBe("preliminary");
    expect(r.qualityReasons.join()).toMatch(/MINORITY_DOUBLE_COUNT/);
    expect(r.probabilityWeightedValue).not.toBeNull();
  });

  it("segments are targeted by stable id, never by index; duplicate ids are rejected", () => {
    const input = planbLike();
    expect(applyOverrides(input, { "segments[0].ownership": 0.5 }).errors.join()).toMatch(/ไม่พบส่วนงาน/);
    expect(applyOverrides(input, { "segments[com7].source.price": 30 }).input).not.toBeNull();
    const a = input.assumptions as Extract<ValuationInput, { method: "sotp" }>["assumptions"];
    const dup = parse({ method: "sotp", assumptions: { ...a, segments: [...a.segments, { ...a.segments[1], name: "Again" }], scenarioSet: undefined } });
    const r = runScenarios(dup, { scenarios: [S("base", 1)] });
    expect(r.errors.join()).toMatch(/DUPLICATE_SEGMENT_ID/);
    expect(r.probabilityWeightedValue).toBeNull();
  });

  it("mismatched segment scenario probabilities are an error, not a silent pick", () => {
    const other = { ...core, scenarios: core.scenarios!.map((s, i) => ({ ...s, probability: [0.2, 0.6, 0.2][i] })) };
    const input = planbLike();
    const a = input.assumptions as Extract<ValuationInput, { method: "sotp" }>["assumptions"];
    const two = parse({ method: "sotp", assumptions: { ...a, segments: [...a.segments, { id: "eng", name: "Other", role: "division", source: { type: "model", valuation: { method: "dcf_fcff", assumptions: other } } }] } });
    expect(scenariosFromSegments(two).errors.join()).toMatch(/ไม่ตรงกับ/);
  });
});

describe("base value unchanged and method adapters (PR16 test 5)", () => {
  const dcfIn = parse({ method: "dcf_fcff", assumptions: { ...core, inputMeta: { asOf: "2026-10-27" } } });
  const rimIn = parse({
    method: "residual_income",
    assumptions: {
      bookValuePerShare: 10, roe: 0.12, payoutRatio: 0.4, currentPrice: 12, riskFree: 0.025, beta: 1, equityRiskPremium: 0.07, terminalGrowth: 0.02,
      roeForecast: [0.14, 0.13, 0.13, 0.12, 0.12], epsForecast: [null, null, 1.5, null, null], terminalMethod: "perpetuity", terminalRoe: 0.11,
      scenarios: [{ name: "Bear", probability: 0.3, overrides: { roeShift: -0.02, payoutRatio: 0.6 } }, { name: "Base", probability: 0.4, overrides: {} }, { name: "Bull", probability: 0.3, overrides: { roeShift: 0.02 } }],
    },
  });
  const inputs: ValuationInput[] = [
    dcfIn,
    parse({ method: "dcf_fcfe", assumptions: core }),
    parse({ method: "ddm", assumptions: { d0: 1, currentPrice: 20, riskFree: 0.025, beta: 0.9, equityRiskPremium: 0.07, terminalGrowth: 0.02 } }),
    rimIn,
    parse({ method: "multiples", assumptions: { eps: 2, bookValuePerShare: 15, ebitda: 900, netDebt: 1200, sharesOutstanding: 300, currentPrice: 25, targetPE: 12, targetPBV: 1.5, targetEvEbitda: 7 } }),
    parse({ method: "bond", assumptions: { settlement: "2026-10-27", maturity: "2031-10-27", couponRate: 0.03, ytm: 0.028 } }),
    planbLike(),
  ];

  it.each(inputs.map((x) => [x.method, x] as const))("%s: baseCaseValue equals evaluate().value", (_m, x) => {
    expect(runScenarios(x, { scenarios: [S("base", 1)] }).baseCaseValue).toBe(evaluate(x).value);
  });

  it("DCF named-scenario adapter reproduces the legacy scenarioAnalysis values", () => {
    const legacy = scenarioAnalysis(core, "fcff", core.scenarios!);
    const r = runScenarios(dcfIn, { scenarios: core.scenarios!.map((s) => S(s.name.toLowerCase(), s.probability, { scenario: s.name })) });
    r.scenarios.forEach((s, i) => expect(s.valuePerShare).toBeCloseTo(legacy.rows[i].value!, 10));
    expect(r.probabilityWeightedValue).toBeCloseTo(legacy.expectedValue!, 10);
  });

  it("RIM roeShift / payout adapter reproduces the legacy RIM scenario values (EPS year untouched)", () => {
    const d = evaluate(rimIn).details as { scenarios: ReturnType<typeof rimScenarioAnalysis> };
    const r = runScenarios(rimIn, { scenarios: [S("bear", 0.3, { scenario: "Bear" }), S("base", 0.4), S("bull", 0.3, { roeShift: 0.02 })] });
    r.scenarios.forEach((s, i) => expect(s.valuePerShare).toBeCloseTo(d.scenarios.rows[i].value!, 10));
    expect(r.scenarios[0].warnings.join()).toMatch(/EPS/);
  });

  it("staged DCF refuses fade fields and accepts stage overrides by id or number", () => {
    const st = parse({ method: "dcf_fcff", assumptions: { ...core, scenarios: undefined, forecastMode: "staged", years: 6, stages: [
      { id: "high", years: 3, revenueGrowthStart: 0.1, revenueGrowthEnd: 0.08, ebitMarginStart: 0.15, ebitMarginEnd: 0.16 },
      { id: "mature", years: 3, revenueGrowthStart: 0.05, revenueGrowthEnd: 0.03, ebitMarginStart: 0.16, ebitMarginEnd: 0.16 },
    ] } });
    expect(applyOverrides(st, { growthStart: 0.2 }).errors.join()).toMatch(/โหมดหลายช่วง/);
    const a = applyOverrides(st, { "stages[high].capexPct": 0.09, "stages[2].revenueGrowthEnd": 0.02 });
    expect(a.errors).toEqual([]);
    const s = (a.input!.assumptions as DcfAssumptions).stages!;
    expect([s[0].capexPct, s[1].revenueGrowthEnd]).toEqual([0.09, 0.02]);
  });

  it("bond scenarios weight clean prices; +100 bp lowers the price", () => {
    const b = inputs[5];
    const r = runScenarios(b, { scenarios: [S("up", 0.5, { yieldShiftBp: 100 }), S("down", 0.5, { yieldShiftBp: -100 })] });
    expect(r.valueKind).toBe("bond_clean_price");
    expect(r.scenarios[0].valuePerShare!).toBeLessThan(r.baseCaseValue!);
    expect(r.scenarios[1].valuePerShare!).toBeGreaterThan(r.baseCaseValue!);
    const up = evaluate(parse({ method: "bond", assumptions: { ...b.assumptions, ytm: 0.038 } })).value!;
    expect(r.scenarios[0].valuePerShare).toBeCloseTo(up, 10);
  });

  it("rejects malformed paths, unknown fields and non-finite values", () => {
    expect(parsePath("segments[a.b].model.x")).toEqual([{ key: "segments", sel: "a.b" }, { key: "model" }, { key: "x" }]);
    expect(parsePath("a]b")).toBeNull();
    expect(applyOverrides(dcfIn, { sharesOutstanding: 0 }).errors.join()).toMatch(/นอกรายการ/);
    expect(applyOverrides(dcfIn, { growthStart: Infinity }).errors.join()).toMatch(/จำกัด/);
    expect(applyOverrides(dcfIn, { terminalGrowth: 0.5 }).input).not.toBeNull(); // schema allows; the model reports Ke ≤ g
    const r = runScenarios(dcfIn, { scenarios: [S("bad", 1, { terminalGrowth: 0.5 })] });
    expect(r.scenarios[0].valuePerShare).toBeNull();
    expect(r.probabilityWeightedValue).toBeNull();
  });

  it("old inputs without scenarioSet evaluate exactly as before", () => {
    const { scenarioSet: _x, ...plain } = planbLike().assumptions as Record<string, unknown>;
    expect(evaluate(parse({ method: "sotp", assumptions: plain })).value).toBe(evaluate(planbLike()).value);
  });
});
