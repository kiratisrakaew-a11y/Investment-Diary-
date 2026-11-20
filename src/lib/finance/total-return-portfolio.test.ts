/** PRICE_BASIS_BENCHMARK_SPEC 6.2 — D5 identities for the real portfolio (synthetic data). */
import { describe, expect, it } from "vitest";
import { buildValueSeries, investorCashFlows, type AssetInput, type PriceHistory, type TxInput } from "./portfolio";
import { computeMetrics } from "./metrics";
import { unrecordedDividends } from "./total-return-portfolio";

const N = 60;
const days = Array.from({ length: N }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
const S: AssetInput = { id: 1, symbol: "S", name: "S", assetClass: "thai_stock", currency: "THB" };
const deposit: TxInput = { date: days[0], assetId: null, type: "deposit", quantity: 0, price: 10_000, fee: 0, fxRate: 1 };
const buy: TxInput = { date: days[0], assetId: 1, type: "buy", quantity: 100, price: 100, fee: 0, fxRate: 1 };

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
const bench: [string, number][] = days.map((d, i) => [d, 1000 * (1 + 0.001 * i + 0.01 * Math.sin(i / 3))]);

function run(close: number[], adj: number[], txs: TxInput[], total: boolean) {
  const prices: PriceHistory = new Map([[1, days.map((d, i) => [d, close[i]] as [string, number])]]);
  const adjH: PriceHistory = new Map([[1, days.map((d, i) => [d, adj[i]] as [string, number])]]);
  const series = buildValueSeries([S], txs, prices, [], days, total ? { adj: adjH, assetIds: new Set([1]) } : undefined);
  const m = computeMetrics({
    values: series,
    cashFlows: investorCashFlows(txs, [S]),
    finalValue: series[series.length - 1].value,
    finalDate: days[N - 1],
    riskFreeRate: 0,
    benchmark: { symbol: "B", series: bench, kind: "total_return" },
  });
  return { series, m };
}

describe("6.2 D5 identities", () => {
  it("(ก) no dividends and adj = close × constant → TWR, σ, VaR, β identical (1e-12)", () => {
    const close = days.map((_, i) => (i === 0 ? 100 : 0)).reduce<number[]>((a, _, i) => [...a, i === 0 ? 100 : a[i - 1] * (1 + rnd() * 0.04)], []);
    const adj = close.map((c) => c * 0.87);
    const p = run(close, adj, [deposit, buy], false).m;
    const t = run(close, adj, [deposit, buy], true).m;
    expect(Math.abs(t.cumulativeReturn - p.cumulativeReturn)).toBeLessThan(1e-12);
    expect(Math.abs(t.volatility! - p.volatility!)).toBeLessThan(1e-12);
    expect(Math.abs(t.varTable[0].var! - p.varTable[0].var!)).toBeLessThan(1e-12);
    expect(Math.abs(t.benchmark!.regressionBeta! - p.benchmark!.regressionBeta!)).toBeLessThan(1e-12);
  });

  // Price 100, ex-date day 20 (dividend 2 → close 98), paid on day 35; moves after the ex-date.
  const xd = 20;
  const pay = 35;
  // Spec case: close 100 → 98 on the ex-date and unchanged until the payment; it moves after the payment.
  // (A move between ex-date and payment is a genuine timing difference: closes reinvest the dividend at the
  // payment-date price, the adj chain at the ex-date price — see the last test.)
  const close = days.map((_, i) => (i < xd ? 100 : i <= pay ? 98 : 98 * (1 + 0.01 * Math.sin(i))));
  const adj = close.map((c, i) => (i < xd ? c * (1 - 2 / 100) : c));
  const dividend: TxInput = { date: days[pay], assetId: 1, type: "dividend", quantity: 0, price: 200, fee: 0, fxRate: 1 };

  it("(ข) recorded dividend: same cumulative TWR; only the path between ex-date and payment differs", () => {
    const p = run(close, adj, [deposit, buy, dividend], false);
    const t = run(close, adj, [deposit, buy, dividend], true);
    expect(Math.abs(t.m.cumulativeReturn - p.m.cumulativeReturn)).toBeLessThan(1e-12);
    const g = (x: typeof p, i: number) => x.m.growth[i].portfolio;
    expect(Math.abs(g(t, xd) - g(p, xd))).toBeGreaterThan(0.01); // on the ex-date close shows −2%, adj ~0
    expect(Math.abs(g(t, pay) - g(p, pay))).toBeLessThan(1e-12); // re-joined on the payment date
    expect(unrecordedDividends(t.series, [deposit, buy, dividend], () => "S", days[N - 1])).toEqual([]);
  });

  it("(ค) unrecorded dividend: total_return higher by ≈ D/P with a warning", () => {
    const p = run(close, adj, [deposit, buy], false);
    const t = run(close, adj, [deposit, buy], true);
    const diff = (1 + t.m.cumulativeReturn) / (1 + p.m.cumulativeReturn) - 1;
    expect(diff).toBeGreaterThan(0.0195);
    expect(diff).toBeLessThan(0.0215);
    const u = unrecordedDividends(t.series, [deposit, buy], () => "S", days[N - 1]);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ symbol: "S", exDate: days[xd] });
    expect(u[0].amount).toBeCloseTo(200, 6);
  });

  it("a price move between ex-date and payment only shifts the result by the reinvestment timing", () => {
    const moved = days.map((_, i) => (i < xd ? 100 : i === xd ? 98 : 98 * (1 + 0.01 * Math.sin(i))));
    const adjM = moved.map((c, i) => (i < xd ? c * 0.98 : c));
    const p = run(moved, adjM, [deposit, buy, dividend], false).m;
    const t = run(moved, adjM, [deposit, buy, dividend], true).m;
    // close: ×(P_pay + D)/P_pay on the payment date; adj: dividend reinvested at 98 on the ex-date.
    const pPay = moved[pay];
    const expected = (1 + p.cumulativeReturn) / ((0.98 * (pPay + 2)) / pPay) - 1;
    expect(Math.abs(t.cumulativeReturn - expected)).toBeLessThan(1e-12);
  });

  it("values, flows and XIRR inputs never change in total-return mode", () => {
    const p = run(close, adj, [deposit, buy, dividend], false);
    const t = run(close, adj, [deposit, buy, dividend], true);
    expect(t.series.map((x) => [x.value, x.flow])).toEqual(p.series.map((x) => [x.value, x.flow]));
    expect(t.m.xirr).toEqual(p.m.xirr);
  });
});
