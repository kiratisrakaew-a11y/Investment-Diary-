/**
 * v3 Phase 4 — VaR/ES at two confidence levels and coverage backtests on synthetic fixtures.
 */
import { describe, expect, it } from "vitest";
import { backtestVaR, chi2Sf1, varTable } from "./var-backtesting";
import { expectedShortfall, historicalVaR } from "./risk";

// Deterministic standard normals (Box–Muller on a seeded LCG) — synthetic, not market data.
function normals(n: number, seed = 7) {
  let s = seed;
  const u = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()));
}

describe("VaR / ES table", () => {
  const rs = normals(1000).map((z) => 0.01 * z);
  it("reuses the existing estimators; 99% ≥ 95%; ES ≥ VaR; close to normal theory", () => {
    const [v95, v99] = varTable(rs);
    expect(v95.var).toBe(historicalVaR(rs, 0.95));
    expect(v95.es).toBe(expectedShortfall(rs, 0.95));
    expect(v99.var!).toBeGreaterThan(v95.var!);
    expect(v99.es!).toBeGreaterThanOrEqual(v99.var!);
    expect(v95.var!).toBeCloseTo(0.01 * 1.645, 2);
    expect(v99.var!).toBeCloseTo(0.01 * 2.326, 2);
    expect(v95.horizon.tenPeriodScaled.var!).toBeCloseTo(v95.var! * Math.sqrt(10), 12);
  });
  it("minimum-observation policy: 99% needs 250, flagged unreliable below 500", () => {
    const short = varTable(rs.slice(0, 200));
    expect(short[0].var).not.toBeNull();
    expect(short[1].var).toBeNull();
    const mid = varTable(rs.slice(0, 300));
    expect(mid[1].var).not.toBeNull();
    expect(mid[1].reliable).toBe(false);
    expect(varTable(rs)[1].reliable).toBe(true);
  });
});

describe("Kupiec / Christoffersen", () => {
  it("χ²(1) survival: known quantiles", () => {
    expect(chi2Sf1(3.841459)).toBeCloseTo(0.05, 4);
    expect(chi2Sf1(6.634897)).toBeCloseTo(0.01, 4);
    expect(chi2Sf1(0)).toBe(1);
  });
  it("Kupiec LR matches the hand formula for given counts", () => {
    // Build hits by construction: returns that exceed a fixed VaR exactly x times out of T.
    const window = 250;
    const T = 500;
    const base = normals(window + T, 11).map((z) => 0.01 * z);
    const r = backtestVaR(base, 0.95, window);
    if ("unavailable" in r) throw new Error(r.unavailable);
    const p = 0.05;
    const x = r.exceptions;
    const ph = x / T;
    const lr = -2 * ((T - x) * Math.log(1 - p) + x * Math.log(p) - (T - x) * Math.log(1 - ph) - x * Math.log(ph));
    expect(r.kupiec.lr).toBeCloseTo(lr, 10);
    expect(r.expected).toBeCloseTo(25, 10);
  });
  it("calibrated VaR on i.i.d. normals is not rejected; a regime of higher volatility is", () => {
    const calm = normals(1250, 5).map((z) => 0.01 * z);
    const ok = backtestVaR(calm, 0.99, 250);
    if ("unavailable" in ok) throw new Error(ok.unavailable);
    expect(ok.kupiec.reject5pct).toBe(false);
    // Volatility triples after the estimation regime: VaR from the calm window is far too low.
    const shift = [...calm.slice(0, 500), ...normals(750, 9).map((z) => 0.03 * z)];
    const bad = backtestVaR(shift, 0.99, 250);
    if ("unavailable" in bad) throw new Error(bad.unavailable);
    expect(bad.exceptions).toBeGreaterThan(bad.expected);
    expect(bad.kupiec.pValue).toBeLessThan(0.01);
  });
  it("clustered exceptions are detected by the independence test; short samples are unavailable", () => {
    const calm = normals(800, 21).map((z) => 0.01 * z);
    // Insert 3 clusters of 4 consecutive large losses after the window.
    for (const start of [400, 550, 700]) for (let k = 0; k < 4; k++) calm[start + k] = -0.05;
    const r = backtestVaR(calm, 0.95, 250);
    if ("unavailable" in r || "unavailable" in r.christoffersen) throw new Error("expected available");
    expect(r.christoffersen.pValue).toBeLessThan(0.05);
    expect("unavailable" in backtestVaR(calm.slice(0, 300), 0.95, 250)).toBe(true);
  });
});
