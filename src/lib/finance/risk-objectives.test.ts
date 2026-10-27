/**
 * Strategies Phase 2 — risk-based objectives through the shared recommend() and backtest().
 */
import { describe, expect, it } from "vitest";
import { recommend } from "./recommend";
import { backtest } from "./backtest";
import { riskReport } from "./risk-strategies";

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
const gauss = (u: () => number) => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
const T = 400;
const u = rng(17);
const scen = [0.006, 0.012, 0.02].map((s, i) => Array.from({ length: T }, () => 0.0003 * (i + 1) + s * gauss(u)));
const covOf = (r: number[][]) => {
  const m = r.map((x) => x.reduce((a, b) => a + b, 0) / x.length);
  return r.map((a, i) => r.map((b, j) => a.reduce((s, v, t) => s + (v - m[i]) * (b[t] - m[j]), 0) / (a.length - 1)));
};
const cov = covOf(scen).map((r) => r.map((v) => v * 252));
const base = { symbols: ["A", "B", "C"], mu: [0.05, 0.08, 0.12], cov, rf: 0.02, bounds: { min: 0, max: 1 }, riskAversion: 4, useRiskFree: false };

describe("risk objectives in recommend()", () => {
  it("risk_parity gives equal risk shares and a report", () => {
    const r = recommend({ ...base, objective: "risk_parity" });
    if (!r.ok) throw new Error(r.issue.message);
    riskReport(r.risky.weights, cov).riskShares.forEach((s) => expect(s).toBeCloseTo(1 / 3, 8));
    expect(r.riskBased?.objective).toBe("risk_parity");
    expect(r.allocations.map((a) => a.weight).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
  it("risk_parity outside the weight range or with group constraints is refused, not clipped", () => {
    const r = recommend({ ...base, objective: "risk_parity", bounds: { min: 0, max: 0.4 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.code).toBe("INFEASIBLE_CONSTRAINTS");
    const g = recommend({ ...base, objective: "risk_parity", bounds: { min: 0, max: 1, linear: [{ name: "g", a: [1, 1, 0], hi: 0.5 }] } });
    expect(!g.ok && g.issue.code).toBe("UNSUPPORTED_CONSTRAINT");
  });
  it("max_diversification and min_cvar respect caps; CVaR matches historical ES", () => {
    const md = recommend({ ...base, objective: "max_diversification", bounds: { min: 0, max: 0.5 } });
    if (!md.ok) throw new Error(md.issue.message);
    expect(Math.max(...md.risky.weights)).toBeLessThanOrEqual(0.5 + 1e-9);
    const cv = recommend({ ...base, objective: "min_cvar", scenarios: scen, cvarConfidence: 0.95, bounds: { min: 0, max: 0.7 } });
    if (!cv.ok) throw new Error(cv.issue.message);
    expect(cv.riskBased!.cvar!.objective).toBeCloseTo(cv.riskBased!.cvar!.historicalES!, 10);
    expect(Math.max(...cv.risky.weights)).toBeLessThanOrEqual(0.7 + 1e-9);
  });
  it("refuses risk-free mixing and min_cvar without scenarios", () => {
    const a = recommend({ ...base, objective: "max_diversification", useRiskFree: true });
    expect(!a.ok && a.issue.code).toBe("UNSUPPORTED_CONSTRAINT");
    const b = recommend({ ...base, objective: "min_cvar" });
    expect(!b.ok && b.issue.code).toBe("INVALID_INPUT");
  });
  it("existing objectives are unchanged (no riskBased field)", () => {
    const r = recommend({ ...base, objective: "min_variance" });
    expect(r.ok && r.riskBased).toBeFalsy();
  });
});

describe("risk strategies in the walk-forward backtest", () => {
  const dates = Array.from({ length: T + 1 }, (_, i) => new Date(Date.UTC(2023, 0, 2) + i * 86_400_000).toISOString().slice(0, 10));
  const prices = scen.map((r) => {
    const p = [100];
    for (const v of r) p.push(p[p.length - 1] * (1 + v));
    return p;
  });
  const input = {
    symbols: ["A", "B", "C"],
    dates,
    prices,
    benchmark: null,
    returnMethod: "historical" as const,
    covMethod: "sample" as const,
    window: 120,
    rebalanceEvery: 60,
    bounds: { min: 0, max: 1 },
    rf: 0.02,
    erp: 0.05,
    initialCapital: 1_000_000,
    costs: { commissionPct: 0, minCommission: 0, vatPct: 0, slippageBps: 0, sellTaxPct: 0, minTradeValue: 0, lotSize: {} },
    lots: {},
    useLots: false,
  };
  it("each risk strategy runs with decisions from the training window only", () => {
    for (const strategy of ["risk_parity", "max_diversification", "min_cvar"] as const) {
      const r = backtest({ ...input, strategy });
      expect(r.ok, `${strategy}: ${r.error}`).toBe(true);
      expect(r.period.from).toBe(dates[121]);
      expect(r.weights.length).toBe(r.period.rebalances);
    }
  });
  it("risk parity weights at a rebalance equal risk parity on that window's covariance (no look-ahead)", () => {
    const r = backtest({ ...input, strategy: "risk_parity" });
    const t = 121;
    const win = scen.map((x) => x.slice(t - 1 - 120, t - 1));
    const years = (Date.parse(dates[t - 1]) - Date.parse(dates[t - 1 - 120])) / (365 * 86_400_000);
    const N = 120 / years;
    const c = covOf(win).map((row) => row.map((v) => v * N));
    const ref = recommend({ ...base, cov: c, objective: "risk_parity" });
    if (!ref.ok) throw new Error(ref.issue.message);
    ref.risky.weights.forEach((w, i) => expect(r.weights[0].target[["A", "B", "C"][i]]).toBeCloseTo(w, 9));
  });
});
