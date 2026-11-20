/** MPT_FIX_SPEC P1-7: μ estimators and Black–Litterman views from valuations (pure). */
import { describe, expect, it } from "vitest";
import { bayesSteinMu, blendHistWeight, blendMu, blendNote, capMu } from "./mu-estimate";
import { viewsFromValuations } from "./valuation-views";

describe("blend / shrinkage / cap", () => {
  it("blend weight: 0.5 at ≥ 3 years, proportional below; note only under 3 years", () => {
    expect(blendHistWeight(3)).toBe(0.5);
    expect(blendHistWeight(6)).toBe(0.5);
    expect(blendHistWeight(1.5)).toBeCloseTo(0.25, 12);
    expect(blendMu([0.3], [0.1], 1.5)[0]).toBeCloseTo(0.25 * 0.3 + 0.75 * 0.1, 12);
    expect(blendNote(3)).toBeNull();
    expect(blendNote(1)).toMatch(/< 3 ปี/);
  });
  it("Bayes–Stein: more years → less shrinkage; μ = target when history equals it", () => {
    const cov = [
      [0.04, 0.01],
      [0.01, 0.09],
    ];
    const short = bayesSteinMu([0.3, -0.1], [0.08, 0.1], cov, 1);
    const long = bayesSteinMu([0.3, -0.1], [0.08, 0.1], cov, 20);
    expect(short.delta).toBeGreaterThan(long.delta);
    expect(Math.abs(short.mu[0] - 0.08)).toBeLessThan(Math.abs(long.mu[0] - 0.08));
    expect(bayesSteinMu([0.08, 0.1], [0.08, 0.1], cov, 2).mu).toEqual([0.08, 0.1]);
  });
  it("cap clamps |μ − CAPM| and reports before / after; fixed entries untouched", () => {
    const r = capMu(["A", "B", "C"], [0.4, 0.05, -0.3], [0.1, 0.08, 0.1], 0.1, [false, false, true]);
    expect(r.mu).toEqual([0.2, 0.05, -0.3]);
    expect(r.adjustments).toEqual([{ symbol: "A", before: 0.4, after: 0.2, capm: 0.1 }]);
  });
});

describe("views from valuations", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-06-30T12:00:00Z");
  const v = (symbol: string, method: string, fv: number, ageDays: number, scen?: number[]) => ({
    symbol,
    method,
    createdTs: now - ageDays * day,
    date: new Date(now - ageDays * day).toISOString().slice(0, 10),
    intrinsicValue: fv,
    scenarioValues: scen,
  });
  it("view = median FV / price − 1; confidence from bear–bull width; stale skipped; none → no view", () => {
    const r = viewsFromValuations(
      ["A", "B", "C", "D"],
      [v("A", "dcf_fcff", 120, 10, [90, 120, 150]), v("B", "ddm", 50, 10), v("B", "multiples", 70, 5), v("C", "dcf_fcff", 10, 200)],
      (s) => ({ A: 100, B: 50, C: 8, D: 10 })[s] ?? null,
      { asOfTs: now, asOfDate: "2026-06-30" },
    );
    const a = r.views.find((x) => x.type === "absolute" && x.symbol === "A")!;
    expect(a.return).toBeCloseTo(0.2, 12);
    expect(a.confidence).toBeCloseTo(1 / (1 + 2 * (60 / 120)), 12);
    const b = r.used.find((x) => x.symbol === "B")!;
    expect(b.fairValue).toBe(60);
    expect(b.confidence).toBeCloseTo(1 / (1 + 2 * (20 / 60)), 12);
    expect(r.skipped.map((x) => x.symbol)).toEqual(["C"]);
    expect(r.used.some((x) => x.symbol === "D")).toBe(false);
  });
  it("point in time: a valuation saved after the cutoff is invisible", () => {
    const r = viewsFromValuations(["A"], [v("A", "dcf_fcff", 120, -5)], () => 100, { asOfTs: now, asOfDate: "2026-06-30", strictlyBefore: true });
    expect(r.views).toEqual([]);
  });
});
