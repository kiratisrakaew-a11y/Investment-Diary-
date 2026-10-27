/** Audit D-1: risk statistics on synchronised dates; TWR / XIRR unchanged. */
import { describe, expect, it } from "vitest";
import { computeMetrics } from "./metrics";
import { buildValueSeries, type AssetInput, type TxInput } from "./portfolio";

const day = (i: number) => new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10);

// Two assets of 100 THB each, no flows. Asset A has no print on every 5th date (carried price).
const n = 300;
const ra = (i: number) => (i % 2 ? 0.012 : -0.009);
const rb = (i: number) => (i % 3 ? 0.004 : -0.006);
const pa: number[] = [100];
const pb: number[] = [100];
for (let i = 1; i <= n; i++) {
  pa.push(pa[i - 1] * (1 + ra(i)));
  pb.push(pb[i - 1] * (1 + rb(i)));
}
const missingA = (i: number) => i > 0 && i % 5 === 0;
const values = Array.from({ length: n + 1 }, (_, i) => {
  let k = i;
  while (missingA(k)) k--; // carried price of A
  return { date: day(i), value: pa[k] + pb[i], flow: 0, carried: missingA(i) };
});
const base = { cashFlows: [{ date: day(0), amount: -200 }], finalValue: values[n].value, finalDate: day(n), riskFreeRate: 0 };

describe("synchronised risk sample", () => {
  const all = computeMetrics({ ...base, values });
  const sync = computeMetrics({ ...base, values, riskDates: values.filter((v) => !v.carried).map((v) => v.date) });

  it("TWR, CAGR, XIRR and drawdown are identical", () => {
    expect(sync.cumulativeReturn).toBe(all.cumulativeReturn);
    expect(sync.annualizedEquivalent).toBe(all.annualizedEquivalent);
    expect(sync.xirr.rate).toBe(all.xirr.rate);
    expect(sync.maxDrawdown).toBe(all.maxDrawdown);
  });

  it("volatility equals an independent computation on the index sampled at synchronised dates", () => {
    expect(sync.riskSample).toEqual({ basis: "synchronized", observations: 240, carriedDates: 60 });
    const idx = values.filter((v) => !v.carried).map((v) => v.value / 200);
    const r = idx.slice(1).map((v, i) => v / idx[i] - 1);
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
    const N = r.length / (299 / 365); // synchronised dates span day 0 … day 299 (day 300 carries A)
    expect(sync.observationsPerYear).toBeCloseTo(N, 10);
    expect(sync.volatility).toBeCloseTo(sd * Math.sqrt(N), 12);
    expect(sync.dataQuality.warnings.join()).toMatch(/ราคาจริง/);
  });

  it("without carried prices the result is exactly the old one", () => {
    const clean = values.map((v) => ({ ...v, carried: false }));
    const a = computeMetrics({ ...base, values: clean });
    const b = computeMetrics({ ...base, values: clean, riskDates: clean.map((v) => v.date) });
    expect(b.volatility).toBe(a.volatility);
    expect(b.sharpe).toBe(a.sharpe);
    expect(b.var95).toBe(a.var95);
    expect(b.riskSample.basis).toBe("all_dates");
  });

  it("falls back to all dates with a warning when too few synchronised dates exist", () => {
    const r = computeMetrics({ ...base, values, riskDates: [values[0].date, values[n].date] });
    expect(r.riskSample.basis).toBe("all_dates_with_carried_prices");
    expect(r.volatility).toBe(all.volatility);
    expect(r.dataQuality.warnings.join()).toMatch(/0% เทียม/);
  });
});

describe("buildValueSeries flags carried prices", () => {
  it("counts held positions without a print on the valuation date", () => {
    const assets: AssetInput[] = [
      { id: 1, symbol: "A", name: "A", assetClass: "thai_stock", currency: "THB" },
      { id: 2, symbol: "B", name: "B", assetClass: "thai_stock", currency: "THB" },
    ];
    const txs: TxInput[] = [
      { id: 1, date: day(0), type: "deposit", assetId: null, quantity: 0, price: 200, fee: 0, fxRate: 1 },
      { id: 2, date: day(0), type: "buy", assetId: 1, quantity: 1, price: 100, fee: 0, fxRate: 1 },
      { id: 3, date: day(0), type: "buy", assetId: 2, quantity: 1, price: 100, fee: 0, fxRate: 1 },
    ];
    const prices = new Map<number, [string, number][]>([
      [1, [[day(0), 100], [day(2), 101]]],
      [2, [[day(0), 100], [day(1), 102], [day(2), 103]]],
    ]);
    const s = buildValueSeries(assets, txs, prices, [], [day(0), day(1), day(2)]);
    expect(s.map((p) => p.carriedPositions)).toEqual([0, 1, 0]);
  });
});
