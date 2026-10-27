/** PR13 / PR14 / PR16 tests 6–8: sensitivity, reverse DCF and Monte Carlo on the shared engine. */
import { describe, expect, it } from "vitest";
import { evaluate, valuationInput } from "./valuation-schemas";
import { DEFAULT_DCF, dcf, dcfAtRate, type DcfAssumptions } from "./finance/valuation";
import { bracketSolve, defaultReverse, defaultSensitivity, reverseSolve, sensitivityGrid } from "./valuation-analytics";
import { inverseCdf, monteCarlo, normCdf, normInv, prepareCorrelation } from "./valuation-montecarlo";
import { applyOverrides } from "./valuation-scenarios";
import { monteCarloConfigSchema, type SensitivityConfig } from "./valuation-scenario-schema";

const base: DcfAssumptions = { ...DEFAULT_DCF, targetDebtWeight: 0.25, inputMeta: { asOf: "2026-10-27" } };
const fcff = valuationInput.parse({ method: "dcf_fcff", assumptions: base });
const manualSotp = (v: number) =>
  valuationInput.parse({
    method: "sotp",
    assumptions: { sharesOutstanding: 1, currentPrice: 6, netDebtBasis: "holdco", segments: [{ id: "core", name: "Core", role: "division", source: { type: "manual", value: v, source: "hand", basis: "equity" } }] },
  });

describe("sensitivity grid (PR16 test 6)", () => {
  it("default FCFF grid: centre equals the base value; lower discount rate gives a higher value", () => {
    const cfg = defaultSensitivity(fcff) as SensitivityConfig;
    expect(cfg.x.path).toBe("discountRate");
    const g = sensitivityGrid(fcff, cfg);
    expect(g.ok).toBe(true);
    expect(g.basePointValue).toBeCloseTo(evaluate(fcff).value!, 9);
    g.monotonic.rows.forEach((r) => expect(r).toBe("decreasing"));
    // Independent check of one off-centre cell with dcfAtRate on hand-edited inputs.
    const rate = dcf(base, "fcff").discountRate;
    const cell = g.cells[0][4]; // y = g − 1%, x = rate + 2%
    expect(cell.value!).toBeCloseTo(dcfAtRate({ ...base, terminalGrowth: base.terminalGrowth - 0.01 }, "fcff", rate + 0.02)!, 9);
  });

  it("discount rate ≤ terminal growth is N/A with a reason, never 0", () => {
    const g = sensitivityGrid(fcff, { x: { path: "discountRate", mode: "absolute", values: [base.terminalGrowth - 0.005, base.terminalGrowth, 0.09] } });
    expect(g.cells[0][0].value).toBeNull();
    expect(g.cells[0][1].value).toBeNull();
    expect(g.cells[0][0].error).toMatch(/≤ g/);
    expect(g.cells[0][2].value).not.toBeNull();
  });

  it("caps the cell count and refuses the same driver on both axes", () => {
    const v = Array.from({ length: 12 }, (_, i) => i / 100);
    expect(sensitivityGrid(fcff, { x: { path: "growthShift", mode: "shift", values: v }, y: { path: "terminalGrowth", mode: "shift", values: v.slice(0, 11) } }).errors.join()).toMatch(/121/);
    expect(sensitivityGrid(fcff, { x: { path: "growthShift", mode: "shift", values: [0] }, y: { path: "growthShift", mode: "shift", values: [0] } }).ok).toBe(false);
  });

  it("bond yield shift lowers the clean price as yield rises", () => {
    const b = valuationInput.parse({ method: "bond", assumptions: { settlement: "2026-10-27", maturity: "2031-10-27", couponRate: 0.03, cleanPrice: 101 } });
    const g = sensitivityGrid(b, defaultSensitivity(b) as SensitivityConfig);
    expect(g.monotonic.rows[0]).toBe("decreasing");
    expect(g.basePointValue).toBeCloseTo(101, 6);
  });
});

describe("reverse DCF (PR16 test 7)", () => {
  it("recovers a known growth shift from a synthetic market price", () => {
    const known = 0.031;
    const priced = applyOverrides(fcff, { growthShift: known }).input!;
    const target = evaluate(priced).value!;
    const r = reverseSolve(fcff, { ...(defaultReverse(fcff) as { path: string; lo: number; hi: number }), targetPrice: target });
    expect(r.status).toBe("solved");
    expect(r.solution!).toBeCloseTo(known, 7);
    expect(Math.abs(r.residual!)).toBeLessThan(1e-8);
    expect(r.iterations).toBeGreaterThan(0);
  });

  it("no solution inside the bounds is reported, not invented", () => {
    const r = reverseSolve(fcff, { path: "growthShift", lo: -0.05, hi: 0.05, targetPrice: 1e9 });
    expect(r.status).toBe("no_solution");
    expect(r.solution).toBeNull();
  });

  it("multiple roots are reported as ambiguous", () => {
    const r = bracketSolve((x) => (x - 0.3) * (x - 0.7), 0, 1, 0);
    expect(r.status).toBe("ambiguous");
    expect(r.roots.length).toBe(2);
    const one = bracketSolve((x) => x * x, 0, 2, 2);
    expect(one.solution!).toBeCloseTo(Math.SQRT2, 9);
  });

  it("non-DCF methods are unsupported with a reason; SOTP solves a DCF segment driver with the rest fixed", () => {
    const ddm = valuationInput.parse({ method: "ddm", assumptions: { d0: 1, currentPrice: 20, riskFree: 0.025, beta: 1, equityRiskPremium: 0.07, terminalGrowth: 0.02 } });
    expect(reverseSolve(ddm, { path: "terminalGrowth", lo: 0, hi: 0.05 }).status).toBe("unsupported");
    const sotp = valuationInput.parse({
      method: "sotp",
      assumptions: {
        sharesOutstanding: base.sharesOutstanding, currentPrice: 1, netDebt: base.debt - base.cash + base.otherClaims,
        segments: [
          { id: "core", name: "Core", role: "division", source: { type: "model", valuation: { method: "dcf_fcff", assumptions: base } } },
          { id: "stake", name: "Stake", role: "investment", ownership: 0.2, source: { type: "market", price: 10, shares: 100 } },
        ],
      },
    });
    const cfg = defaultReverse(sotp) as { path: string; lo: number; hi: number };
    expect(cfg.path).toBe("segments[CORE].model.growthShift");
    const target = evaluate(applyOverrides(sotp, { [cfg.path]: -0.02 }).input!).value!;
    const r = reverseSolve(sotp, { ...cfg, targetPrice: target });
    expect(r.status).toBe("solved");
    expect(r.solution!).toBeCloseTo(-0.02, 7);
  });
});

describe("Monte Carlo (PR16 test 8)", () => {
  const cfg = (o: Record<string, unknown>) => monteCarloConfigSchema.parse({ draws: 2000, variables: [{ path: "segments[core].source.value", dist: { type: "uniform", min: 4, max: 12 } }], ...o });

  it("is reproducible for a seed, differs across seeds, and percentiles are ordered", () => {
    const a = monteCarlo(manualSotp(8), cfg({ seed: 7 }));
    const b = monteCarlo(manualSotp(8), cfg({ seed: 7 }));
    const c = monteCarlo(manualSotp(8), cfg({ seed: 8 }));
    expect(a.usable).toBe(true);
    expect(a.mean).toBe(b.mean);
    expect(a.percentiles).toEqual(b.percentiles);
    expect(a.mean).not.toBe(c.mean);
    const p = a.percentiles;
    expect([p.p5!, p.p10!, p.p25!, p.p50!, p.p75!, p.p90!, p.p95!]).toEqual([p.p5!, p.p10!, p.p25!, p.p50!, p.p75!, p.p90!, p.p95!].sort((x, y) => x - y));
    // Uniform(4, 12): mean 8, P10 ≈ 4.8, P90 ≈ 11.2 (sampling error at n = 2000 ≈ 0.05).
    expect(a.mean!).toBeCloseTo(8, 0);
    expect(p.p10!).toBeGreaterThan(4.6);
    expect(p.p90!).toBeLessThan(11.4);
    expect(a.probAbovePrice!).toBeGreaterThan(0.7);
    expect(a.histogram.reduce((s, h) => s + h.count, 0)).toBe(a.valid);
  });

  it("calls the same DCF engine on every draw (draw value = deterministic value at the drawn input)", () => {
    const r = monteCarlo(fcff, monteCarloConfigSchema.parse({ draws: 200, variables: [{ path: "terminalGrowth", dist: { type: "triangular", min: 0.01, mode: 0.02, max: 0.03 } }] }));
    const lo = evaluate(valuationInput.parse({ method: "dcf_fcff", assumptions: { ...base, terminalGrowth: 0.01 } })).value!;
    const hi = evaluate(valuationInput.parse({ method: "dcf_fcff", assumptions: { ...base, terminalGrowth: 0.03 } })).value!;
    expect(r.percentiles.p5!).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(r.percentiles.p95!).toBeLessThanOrEqual(hi + 1e-9);
  });

  it("too many invalid draws make the result unusable with counts and reasons", () => {
    const r = monteCarlo(fcff, monteCarloConfigSchema.parse({ draws: 400, variables: [{ path: "terminalGrowth", dist: { type: "uniform", min: 0.05, max: 0.3 } }] }));
    expect(r.usable).toBe(false);
    expect(r.invalid).toBeGreaterThan(0);
    expect(r.invalidShare).toBeGreaterThan(0.2);
    expect(r.invalidReasons.length).toBeGreaterThan(0);
  });

  it("validates correlation: asymmetric is an error, non-PSD is repaired with a warning", () => {
    expect(prepareCorrelation([[1, 0.5], [0.4, 1]], 2).error).toMatch(/สมมาตร/);
    const bad = [[1, 0.9, -0.9], [0.9, 1, 0.9], [-0.9, 0.9, 1]];
    const p = prepareCorrelation(bad, 3);
    expect(p.error).toBeUndefined();
    expect(p.warnings.join()).toMatch(/semidefinite/);
    const r = monteCarlo(manualSotp(8), cfg({ variables: [
      { path: "segments[core].source.value", dist: { type: "uniform", min: 4, max: 12 } },
      { path: "netDebt", dist: { type: "uniform", min: 0, max: 1 } },
      { path: "holdingDiscount", dist: { type: "uniform", min: 0, max: 0.1 } },
    ], correlation: bad }));
    expect(r.warnings.join()).toMatch(/semidefinite/);
    expect(r.usable).toBe(true);
  });

  it("stops at the time budget / cancellation and reports a partial run", () => {
    let t = 0;
    const r = monteCarlo(manualSotp(8), cfg({ draws: 5000, timeBudgetMs: 100 }), { now: () => (t += 10) });
    expect(r.timedOut).toBe(true);
    expect(r.drawsRun).toBeLessThan(5000);
    const c = monteCarlo(manualSotp(8), cfg({ draws: 5000 }), { shouldCancel: () => true });
    expect(c.drawsRun).toBe(0);
    expect(c.usable).toBe(false);
  });

  it("caps draws in the schema and inverse CDFs are consistent", () => {
    expect(() => monteCarloConfigSchema.parse({ draws: 50_000, variables: [{ path: "x", dist: { type: "uniform", min: 0, max: 1 } }] })).toThrow();
    expect(normInv(normCdf(1.2))).toBeCloseTo(1.2, 5);
    expect(inverseCdf({ type: "triangular", min: 0, mode: 0.5, max: 1 }, 0.5)).toBeCloseTo(0.5, 12);
    expect(inverseCdf({ type: "normal", mean: 0, sd: 1, min: 0, max: 1 }, 0.000001)).toBeGreaterThanOrEqual(0);
  });
});
