/** Audit M-1 / M-2: correlation editing helpers and validation (pure functions used by the UI). */
import { describe, expect, it } from "vitest";
import { appendCorrelationIndex, checkCorrelation, identityCorrelation, monteCarlo, prepareCorrelation, removeCorrelationIndex, setCorrelationPair } from "./valuation-montecarlo";
import { monteCarloConfigSchema } from "./valuation-scenario-schema";
import { valuationInput } from "./valuation-schemas";
import { analyzeValuation } from "./valuation-analyze";

describe("correlation helpers", () => {
  it("edits mirror, keep the diagonal at 1, and resize without touching other pairs", () => {
    let c = identityCorrelation(3);
    c = setCorrelationPair(c, 0, 2, 0.4);
    c = setCorrelationPair(c, 1, 2, -0.3);
    expect(c[2][0]).toBe(0.4);
    expect(setCorrelationPair(c, 1, 1, 0.5)[1][1]).toBe(1);
    const grown = appendCorrelationIndex(c)!;
    expect(grown).toHaveLength(4);
    expect(grown[0][2]).toBe(0.4);
    expect(grown[3]).toEqual([0, 0, 0, 1]);
    const shrunk = removeCorrelationIndex(grown, 1)!;
    expect(shrunk).toEqual([[1, 0.4, 0], [0.4, 1, 0], [0, 0, 1]]);
    expect(removeCorrelationIndex([[1, 0.5], [0.5, 1]], 0)).toBeUndefined();
    expect(appendCorrelationIndex(undefined)).toBeUndefined();
  });

  it("validation reports dimension, diagonal, range and symmetry errors without changing the input", () => {
    expect(checkCorrelation([[1, 0], [0, 1]], 3).errors.join()).toMatch(/3×3/);
    expect(checkCorrelation([[0.9, 0], [0, 1]], 2).errors.join()).toMatch(/แนวทแยง/);
    expect(checkCorrelation([[1, 1.2], [1.2, 1]], 2).errors.join()).toMatch(/−1 ถึง 1/);
    expect(checkCorrelation([[1, 0.2], [0.3, 1]], 2).errors.join()).toMatch(/สมมาตร/);
    const ok = checkCorrelation([[1, 0.5], [0.5, 1]], 2);
    expect(ok).toMatchObject({ errors: [], psd: true, repaired: null });
  });

  it("non-PSD: proposes a unit-diagonal PSD repair but never applies it to the input", () => {
    const bad = [[1, 0.9, -0.9], [0.9, 1, 0.9], [-0.9, 0.9, 1]];
    const copy = JSON.stringify(bad);
    const c = checkCorrelation(bad, 3);
    expect(c.psd).toBe(false);
    expect(c.minEigenvalue!).toBeLessThan(0);
    expect(JSON.stringify(bad)).toBe(copy);
    const r = c.repaired!;
    r.forEach((row, i) => expect(row[i]).toBeCloseTo(1, 12));
    r.forEach((row, i) => row.forEach((x, j) => expect(x).toBeCloseTo(r[j][i], 12)));
    // Applying the repaired matrix (the user's confirmation) passes validation.
    expect(checkCorrelation(r, 3).psd).toBe(true);
    expect(prepareCorrelation(r, 3).warnings).toEqual([]);
  });
});

describe("correlated draws: UI config = REST/MCP config", () => {
  const input = valuationInput.parse({
    method: "sotp",
    assumptions: {
      sharesOutstanding: 1, currentPrice: 1, netDebtBasis: "holdco",
      segments: [
        { id: "a", name: "A", role: "division", source: { type: "manual", value: 1, source: "t", basis: "equity" } },
        { id: "b", name: "B", role: "division", source: { type: "manual", value: 1, source: "t", basis: "equity" } },
      ],
    },
  });
  const cfg = (correlation?: number[][]) =>
    monteCarloConfigSchema.parse({ draws: 4000, seed: 3, variables: [
      { path: "segments[a].source.value", dist: { type: "normal", mean: 0, sd: 1 } },
      { path: "segments[b].source.value", dist: { type: "normal", mean: 0, sd: 1 } },
    ], correlation });

  it("normal marginals: sd(X+Y) ≈ √(2 + 2ρ) for ρ = 0.8, 0, −0.6", () => {
    for (const rho of [0.8, 0, -0.6]) {
      const r = monteCarlo(input, cfg(rho ? [[1, rho], [rho, 1]] : undefined));
      expect(r.sd!).toBeGreaterThan(Math.sqrt(2 + 2 * rho) * 0.95);
      expect(r.sd!).toBeLessThan(Math.sqrt(2 + 2 * rho) * 1.05);
    }
  });

  it("the analysis entry point (used by the UI action, REST and MCP) gives the same result as the engine", () => {
    const c = cfg([[1, 0.5], [0.5, 1]]);
    const direct = monteCarlo(input, c);
    const via = analyzeValuation({ valuation: input, monteCarlo: c }).monteCarlo as typeof direct;
    expect(via.mean).toBe(direct.mean);
    expect(via.percentiles).toEqual(direct.percentiles);
  });
});
