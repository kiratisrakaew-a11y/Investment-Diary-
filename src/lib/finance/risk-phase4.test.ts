/**
 * Roadmap Phase 4 — risk contribution, component ES, stress scenarios, robustness diagnostics.
 */
import { describe, expect, it } from "vitest";
import { componentES, riskContribution } from "./risk-contribution";
import { expectedShortfall } from "./risk";
import { historicalWorst, runStress, type StressPosition } from "./stress";
import { robustDiagnostics } from "./robust";
import { recommend } from "./recommend";
import { estimateInputs } from "./mpt";

const cov = [
  [0.04, 0.006, 0],
  [0.006, 0.09, 0.01],
  [0, 0.01, 0.01],
];

describe("risk contribution", () => {
  it("Σ RC = σ_p (Euler) and shares sum to 1", () => {
    const r = riskContribution(["A", "B", "C"], [0.5, 0.3, 0.2], cov);
    const sum = r.assets.reduce((s, a) => s + a.contribution, 0);
    expect(sum).toBeCloseTo(r.volatility, 12);
    expect(r.assets.reduce((s, a) => s + a.share, 0)).toBeCloseTo(1, 12);
  });
  it("two uncorrelated assets with inverse-vol weights have equal risk contributions; concentration measures", () => {
    const c2 = [[0.04, 0], [0, 0.16]];
    const w = [2 / 3, 1 / 3]; // 1/σ weights: σ = 0.2, 0.4
    const r = riskContribution(["A", "B"], w, c2);
    expect(r.assets[0].contribution).toBeCloseTo(r.assets[1].contribution, 12);
    expect(r.concentration.hhi).toBeCloseTo(5 / 9, 12);
    expect(r.concentration.effectiveN).toBeCloseTo(1.8, 12);
    expect(r.concentration.effectiveRiskN).toBeCloseTo(2, 12);
  });
  it("component ES sums to the portfolio ES (existing definition) and needs ≥ 100 observations", () => {
    const T = 250;
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.04;
    const series = [Array.from({ length: T }, rnd), Array.from({ length: T }, rnd)];
    const w = [0.6, 0.4];
    const c = componentES(["A", "B"], w, series)!;
    const port = series[0].map((r, t) => 0.6 * r + 0.4 * series[1][t]);
    expect(c.expectedShortfall).toBeCloseTo(expectedShortfall(port)!, 12);
    expect(c.assets.reduce((a, b) => a + b.contribution, 0)).toBeCloseTo(c.expectedShortfall!, 12);
    expect(componentES(["A"], [1], [series[0].slice(0, 50)])).toBeNull();
  });
});

describe("stress", () => {
  const pos: StressPosition[] = [
    { symbol: "PTT", assetClass: "thai_stock", currency: "THB", value: 100_000, beta: 1.2, modifiedDuration: null, convexity: null },
    { symbol: "AAPL", assetClass: "us_stock", currency: "USD", value: 50_000, beta: 0.8, modifiedDuration: null, convexity: null },
    { symbol: "LB29", assetClass: "bond", currency: "THB", value: 80_000, beta: null, modifiedDuration: 4, convexity: 20 },
    { symbol: "KFUND", assetClass: "fund", currency: "THB", value: 20_000, beta: null, modifiedDuration: null, convexity: null },
  ];
  it("equity × β, rates via duration and convexity, FX on USD only (compounded)", () => {
    const r = runStress(pos, 10_000, { equityShock: -0.2, rateShock: 0.01, fxShock: -0.1 });
    const by = Object.fromEntries(r.positions.map((p) => [p.symbol, p]));
    expect(by.PTT.pnl.equity).toBeCloseTo(-24_000);
    expect(by.PTT.pnl.fx).toBe(0);
    expect(by.LB29.pnl.rate).toBeCloseTo(80_000 * (-4 * 0.01 + 0.5 * 20 * 0.0001));
    expect(by.LB29.pnl.equity).toBe(0);
    // AAPL: (1 − 0.16)(1 − 0.10) − 1 = −0.244
    expect(by.AAPL.pnl.total).toBeCloseTo(50_000 * -0.244);
    expect(r.navBefore).toBe(260_000);
    expect(r.navAfter).toBeCloseTo(260_000 + r.pnl);
    expect(r.warnings.some((w) => w.includes("KFUND") && w.includes("duration"))).toBe(true);
  });
  it("specific and group shocks, duration override, liquidity haircut", () => {
    const r = runStress(pos, 0, { specific: { PTT: -0.3 }, groups: [{ name: "energy", symbols: ["ptt"], shock: -0.1 }], rateShock: 0.01, durationOverride: { KFUND: 2 }, liquidityHaircut: { thai_stock: 0.02 } });
    const by = Object.fromEntries(r.positions.map((p) => [p.symbol, p]));
    expect(by.PTT.pnl.specific).toBeCloseTo(-40_000);
    expect(by.PTT.pnl.liquidity).toBeCloseTo(-60_000 * 0.02);
    expect(by.KFUND.pnl.rate).toBeCloseTo(-400);
  });
  it("correlation shock raises volatility when correlations are below 1", () => {
    const r = runStress(pos, 0, { correlationShock: 0.5 }, { symbols: ["PTT", "AAPL"], matrix: [[0.04, 0.006], [0.006, 0.09]], periodsPerYear: 252 });
    expect(r.correlation!.volatilityAfter).toBeGreaterThan(r.correlation!.volatilityBefore);
    // ρ = 0.006 / (0.2·0.3) = 0.1 → 0.55
    const w = [2 / 3, 1 / 3];
    const v = Math.sqrt(w[0] ** 2 * 0.04 + w[1] ** 2 * 0.09 + 2 * w[0] * w[1] * 0.55 * 0.06);
    expect(r.correlation!.volatilityAfter).toBeCloseTo(v, 12);
  });
  it("historical worst day and 21-day window", () => {
    const s = [Array.from({ length: 40 }, (_, t) => (t === 10 ? -0.1 : 0.001))];
    const d = Array.from({ length: 41 }, (_, t) => `2026-01-${String(t + 1).padStart(2, "0")}`);
    const h = historicalWorst(s, [1], d)!;
    expect(h.worstDay.return).toBe(-0.1);
    expect(h.worstDay.date).toBe(d[11]);
    expect(h.worst21d!.return).toBeLessThan(-0.08);
  });
});

describe("robust diagnostics", () => {
  const T = 300;
  let s = 11;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.03;
  const series = [Array.from({ length: T }, () => rnd() + 0.0006), Array.from({ length: T }, () => rnd() + 0.0003), Array.from({ length: T }, () => rnd() * 0.3 + 0.0002)];
  const N = 252;
  const { mu, cov: c } = estimateInputs(series, N);
  const base = { symbols: ["A", "B", "C"], rf: 0.01, bounds: { min: 0, max: 0.7 }, objective: "max_sharpe" as const, riskAversion: 4, useRiskFree: false };
  const r0 = recommend({ ...base, mu, cov: c });
  const baseWeights = r0.ok ? r0.allocations.map((a) => a.weight) : [];
  const mk = (seed: number, draws = 30) =>
    robustDiagnostics({
      series,
      periodsPerYear: N,
      covMethod: "sample",
      muFromRows: (rows) => series.map((x) => (rows.reduce((a, r) => a + x[r], 0) / rows.length) * N),
      base,
      baseWeights,
      baseMu: mu,
      baseCov: c,
      draws,
      returnShock: 0.02,
      seed,
    });
  it("deterministic with a seed; weights within bounds; diagnostics reported", () => {
    const a = mk(42);
    const b = mk(42);
    expect(a.bootstrap).toEqual(b.bootstrap);
    expect(a.succeeded + a.failed).toBe(30);
    for (const x of a.bootstrap) {
      expect(x.p05).toBeGreaterThanOrEqual(-1e-9);
      expect(x.p95).toBeLessThanOrEqual(0.7 + 1e-9);
    }
    expect(a.resampledWeights.reduce((s2, w) => s2 + w.weight, 0)).toBeCloseTo(1, 6);
  });
  it("raising an asset's expected return does not lower its weight", () => {
    const a = mk(1, 0);
    for (const x of a.sensitivity) expect(x.ownWeightChangeUp!).toBeGreaterThanOrEqual(-1e-9);
    expect(a.bootstrap).toEqual([]);
  });
});
