/** Price vs custom metric: chart rows (no fill) and interval correlation. Synthetic data only. */
import { describe, expect, it } from "vitest";
import { metricPriceCorrelation, priceMetricRows, type PricePoint } from "./price-relation";

// Daily prices for a year; value grows by 1 per day (deterministic, not market data).
const days = (from: string, n: number, f: (i: number) => number): PricePoint[] =>
  Array.from({ length: n }, (_, i) => ({ date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), close: f(i) }));
const prices = days("2024-01-01", 400, (i) => 100 + i);
const at = (i: number) => prices[i].date;

describe("priceMetricRows", () => {
  it("keeps readings on their own dates only, counts readings outside the price range, no NaN", () => {
    const { rows, outside } = priceMetricRows(prices.slice(0, 5), [{ key: "m1", readings: [{ observedOn: at(1), value: 3 }, { observedOn: at(3), value: 0 }, { observedOn: "2023-12-01", value: 9 }, { observedOn: "2030-01-01", value: 9 }] }]);
    expect(rows.map((r) => r.m1)).toEqual([null, 3, null, 0, null]);
    expect(rows.map((r) => r.price)).toEqual([100, 101, 102, 103, 104]);
    expect(outside.m1).toBe(2);
    expect(JSON.stringify(rows)).not.toMatch(/NaN|Infinity/);
  });
  it("a reading on a day without a price gets its own row (price null)", () => {
    const px = [prices[0], prices[2]];
    const { rows } = priceMetricRows(px, [{ key: "m", readings: [{ observedOn: at(1), value: 5 }] }]);
    expect(rows.map((r) => [r.date, r.price, r.m])).toEqual([[at(0), 100, null], [at(1), null, 5], [at(2), 102, null]]);
  });
});

describe("metricPriceCorrelation", () => {
  // Quarterly-ish readings every 30 days.
  const idx = Array.from({ length: 12 }, (_, k) => k * 30);
  it("perfectly aligned changes → r = +1; opposite → r = −1", () => {
    // Metric (non-% unit) moves exactly with the price, so relative changes are identical.
    const up = idx.map((i) => ({ observedOn: at(i), value: prices[i].close * 2 }));
    const r1 = metricPriceCorrelation(prices, up, "THB million");
    expect(r1.r).toBeCloseTo(1, 10);
    expect([r1.n, r1.strength, r1.change]).toEqual([11, "สูง", "percent"]);
    // Alternating price moves with the metric moving the other way.
    const zig = days("2024-01-01", 400, (i) => 100 + (Math.floor(i / 30) % 2 ? 10 : 0) + i * 0.01);
    const opp = idx.map((i) => ({ observedOn: at(i), value: 50 - zig[i].close }));
    expect(metricPriceCorrelation(zig, opp, "count").r!).toBeLessThan(-0.99);
  });
  it("% units use percentage-point differences", () => {
    const r = metricPriceCorrelation(prices, idx.map((i, k) => ({ observedOn: at(i), value: 3 + (k % 2) * 0.5 })), "%");
    expect(r.change).toBe("pp");
    expect(r.n).toBe(11);
  });
  it("earlier value ≤ 0 → plain difference, flagged as mixed", () => {
    const r = metricPriceCorrelation(prices, idx.map((i, k) => ({ observedOn: at(i), value: k === 3 ? -2 : 10 + k })), "THB million");
    expect(r.change).toBe("mixed");
    expect(r.warnings.join()).toMatch(/≤ 0/);
    expect(r.r).not.toBeNull();
  });
  it("too few intervals → no r, with the reason and n", () => {
    const r = metricPriceCorrelation(prices, idx.slice(0, 5).map((i) => ({ observedOn: at(i), value: i })), "count");
    expect(r).toMatchObject({ r: null, n: 4, strength: null });
    expect(r.reason).toMatch(/ข้อมูลน้อยเกินไป/);
  });
  it("readings without a price within maxGapDays are skipped and counted", () => {
    const sparse = prices.filter((_, i) => i < 100 || i > 200); // a 100-day hole
    const r = metricPriceCorrelation(sparse, idx.map((i) => ({ observedOn: at(i), value: i + 1 })), "count");
    expect(r.skipped.noPrice).toBe(3); // days 120, 150, 180
    expect(r.n).toBe(8);
    expect(r.warnings.join()).toMatch(/ไม่มีราคา/);
  });
  it("published basis matches on the announcement date and skips readings without one", () => {
    const rs = idx.map((i, k) => ({ observedOn: at(i), value: 10 + k, publishedOn: k < 2 ? null : at(i + 20) }));
    const r = metricPriceCorrelation(prices, rs, "count", { basis: "published" });
    expect(r.skipped.noPublishedDate).toBe(2);
    expect([r.basis, r.n]).toEqual(["published", 9]);
  });
  it("a constant series cannot be correlated", () => {
    const r = metricPriceCorrelation(prices, idx.map((i) => ({ observedOn: at(i), value: 5 })), "count");
    expect(r.r).toBeNull();
    expect(r.reason).toMatch(/ไม่เปลี่ยน/);
  });
});
