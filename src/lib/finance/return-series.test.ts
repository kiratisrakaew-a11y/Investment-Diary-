/**
 * v3 Phase 1 — shared return conventions: hand-calculated fixtures.
 */
import { describe, expect, it } from "vitest";
import { alignWithBenchmark, buildLevelSeries, commonDates, returnsOn, type LevelSeries } from "./return-series";
import { beta } from "./risk";
import { asOf } from "./portfolio";
import { simpleReturns } from "./stats";

const ok = (r: ReturnType<typeof buildLevelSeries>) => {
  if (!r.ok) throw new Error(r.reason);
  return r as LevelSeries;
};
const last = (r: LevelSeries) => r.levels[r.levels.length - 1][1];

describe("dividends: raw + distribution vs provider adjusted close, never both", () => {
  // Close 100 → 98 on the ex-date with a 3.00 dividend → 101 next day.
  const obs = [
    { date: "2026-01-02", close: 100, adjClose: 97.0297 },
    { date: "2026-01-05", close: 98, adjClose: 98 },
    { date: "2026-01-06", close: 101, adjClose: 101 },
  ];
  it("price return excludes the dividend", () => {
    const r = ok(buildLevelSeries({ label: "X", observations: obs, basis: "price_return", currency: "THB" }));
    expect(last(r)).toBeCloseTo(1.01, 12);
  });
  it("total return from distributions: (98 + 3)/100 then 101/98 — hand calculation", () => {
    const r = ok(buildLevelSeries({ label: "X", observations: obs, basis: "total_return", totalReturnSource: "distributions", distributions: [{ exDate: "2026-01-05", amount: 3 }], currency: "THB" }));
    expect(r.levels[1][1]).toBeCloseTo(1.01, 12);
    expect(last(r)).toBeCloseTo(1.01 * (101 / 98), 12);
  });
  it("adjusted-close mode gives the same economic return within tolerance", () => {
    const r = ok(buildLevelSeries({ label: "X", observations: obs, basis: "total_return", totalReturnSource: "adjusted_close", currency: "THB" }));
    expect(last(r)).toBeCloseTo(1.01 * (101 / 98), 4);
  });
  it("adjusted close + distributions together is rejected (double counting)", () => {
    const r = buildLevelSeries({ label: "X", observations: obs, basis: "total_return", totalReturnSource: "adjusted_close", distributions: [{ exDate: "2026-01-05", amount: 3 }], currency: "THB" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("ซ้ำ");
  });
  it("missing adj_close → typed unavailable with what is required", () => {
    const r = buildLevelSeries({ label: "X", observations: [{ date: "2026-01-02", close: 1 }, { date: "2026-01-05", close: 1 }], basis: "total_return", totalReturnSource: "adjusted_close", currency: "THB" });
    expect(r).toMatchObject({ ok: false, status: "unavailable" });
    expect(!r.ok && r.required).toContain("adjusted_close");
  });
  it("a distribution is counted exactly once even when dates are sparse", () => {
    const r = ok(buildLevelSeries({ label: "X", observations: [obs[0], obs[2]], basis: "total_return", totalReturnSource: "distributions", distributions: [{ exDate: "2026-01-05", amount: 3 }], currency: "THB" }));
    expect(last(r)).toBeCloseTo((101 + 3) / 100, 12);
  });
});

describe("splits: split-consistent closes show no synthetic performance", () => {
  it("provider split-adjusted closes across a 2:1 and a 1:10 give the economic return only", () => {
    const r = ok(buildLevelSeries({ label: "S", observations: [{ date: "2026-02-02", close: 15.5 }, { date: "2026-02-03", close: 15.6 }, { date: "2026-02-04", close: 15.6 }], basis: "price_return", currency: "THB" }));
    expect(last(r)).toBeCloseTo(15.6 / 15.5, 12);
  });
});

describe("FX: 1 + R_THB = (1 + R_local)(1 + R_FX), applied once", () => {
  const obs = [{ date: "2026-03-02", close: 100 }, { date: "2026-03-03", close: 102 }];
  it("USD asset", () => {
    const r = ok(buildLevelSeries({ label: "U", observations: obs, basis: "price_return", currency: "USD", fx: [["2026-03-02", 35], ["2026-03-03", 35.7]] }));
    expect(last(r)).toBeCloseTo(1.02 * 1.02, 12);
  });
  it("THB asset ignores FX entirely", () => {
    const r = ok(buildLevelSeries({ label: "T", observations: obs, basis: "price_return", currency: "THB", fx: [["2026-03-02", 35], ["2026-03-03", 99]] }));
    expect(last(r)).toBeCloseTo(1.02, 12);
  });
  it("missing FX beyond the staleness limit → unavailable; recent FX is flagged", () => {
    expect(buildLevelSeries({ label: "U", observations: obs, basis: "price_return", currency: "USD", fx: [["2026-02-01", 35]] }).ok).toBe(false);
    const r = ok(buildLevelSeries({ label: "U", observations: obs, basis: "price_return", currency: "USD", fx: [["2026-03-01", 35], ["2026-03-03", 35]] }));
    expect(r.coverage.fxStale).toBe(1);
    expect(r.warnings[0]).toContain("วันก่อนหน้า");
  });
});

describe("calendar alignment: no forward-fill (regression for FIX-2)", () => {
  const dates = Array.from({ length: 31 }, (_, t) => `2026-01-${String(t + 1).padStart(2, "0")}`);
  const m = dates.map((_, t) => 0.01 * Math.sin(t * 1.7));
  const assetPx = [100];
  const idxPx = [1000];
  for (let t = 1; t < dates.length; t++) {
    assetPx.push(assetPx[t - 1] * (1 + 1.5 * m[t]));
    idxPx.push(idxPx[t - 1] * (1 + m[t]));
  }
  const missing = new Set([5, 12, 20]);
  const bench: [string, number][] = dates.map((d, t) => [d, idxPx[t]] as [string, number]).filter((_, t) => !missing.has(t));
  const asset: [string, number][] = dates.map((d, t) => [d, assetPx[t]]);

  it("old method (asOf forward-fill) creates zero benchmark returns and biases beta", () => {
    const old = simpleReturns(dates.map((d) => asOf(bench, d) ?? 0));
    expect(old.filter((x) => x === 0).length).toBe(3);
    expect(Math.abs(beta(simpleReturns(assetPx), old)! - 1.5)).toBeGreaterThan(0.05);
  });
  it("aligned on common actual prints: compounds across gaps, recovers the true beta", () => {
    const a = alignWithBenchmark(asset, bench);
    expect(a.droppedDates).toBe(3);
    expect(a.benchmark.every((x) => x !== 0 && Number.isFinite(x))).toBe(true);
    // Relationship is exact per day, so over gaps it is not exactly linear; beta must be close to 1.5.
    expect(beta(a.asset, a.benchmark)!).toBeCloseTo(1.5, 1);
    expect(Math.abs(beta(a.asset, a.benchmark)! - 1.5)).toBeLessThan(Math.abs(beta(simpleReturns(assetPx), simpleReturns(dates.map((d) => asOf(bench, d) ?? 0)))! - 1.5));
  });
  it("commonDates / returnsOn compound across a missing day instead of inserting zero", () => {
    const s1: [string, number][] = [["d1", 100], ["d2", 110], ["d3", 121]];
    const s2: [string, number][] = [["d1", 10], ["d3", 12]];
    const d = commonDates([s1, s2]);
    expect(d).toEqual(["d1", "d3"]);
    expect(returnsOn(s1, d)[0]).toBeCloseTo(0.21, 12);
  });
});

describe("validation", () => {
  it("duplicate dates, non-positive prices, total_return without a source are typed errors", () => {
    expect(buildLevelSeries({ label: "X", observations: [{ date: "d", close: 1 }, { date: "d", close: 1 }], basis: "price_return", currency: "THB" })).toMatchObject({ ok: false, status: "invalid" });
    expect(buildLevelSeries({ label: "X", observations: [{ date: "a", close: 1 }, { date: "b", close: 0 }], basis: "price_return", currency: "THB" })).toMatchObject({ ok: false, status: "invalid" });
    expect(buildLevelSeries({ label: "X", observations: [{ date: "a", close: 1 }, { date: "b", close: 1 }], basis: "total_return", currency: "THB" })).toMatchObject({ ok: false, status: "invalid" });
    const one = buildLevelSeries({ label: "X", observations: [{ date: "a", close: 1 }], basis: "price_return", currency: "THB" });
    expect(one).toMatchObject({ ok: false, status: "unavailable" });
  });
});
