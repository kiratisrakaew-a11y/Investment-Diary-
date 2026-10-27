/**
 * Roadmap Phase 5 — walk-forward backtest: reference values, costs, no look-ahead, reproducibility.
 */
import { describe, expect, it } from "vitest";
import { backtest, type BacktestInput } from "./backtest";
import { tradingCostsSchema } from "./rebalance";

// Deterministic synthetic test data (not market data).
function makeData(T = 200, seed = 3) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.04;
  const dates = Array.from({ length: T }, (_, t) => new Date(Date.UTC(2024, 0, 1) + t * 86_400_000).toISOString().slice(0, 10));
  const mk = (drift: number, scale: number) => {
    const p = [100];
    for (let t = 1; t < T; t++) p.push(p[t - 1] * (1 + drift + rnd() * scale));
    return p;
  };
  return { dates, prices: [mk(0.0006, 1), mk(0.0003, 0.6), mk(0.0002, 0.3)] };
}

const zero = tradingCostsSchema.parse({ lotSize: {} });
const base = (over: Partial<BacktestInput> = {}): BacktestInput => {
  const d = makeData();
  return {
    symbols: ["A", "B", "C"],
    dates: d.dates,
    prices: d.prices,
    benchmark: { symbol: "IDX", series: d.dates.map((dt, t) => [dt, 1000 * (d.prices[0][t] / 100 + d.prices[1][t] / 100) / 2] as [string, number]), kind: "price_index" },
    strategy: "equal_weight",
    returnMethod: "historical",
    covMethod: "sample",
    window: 60,
    rebalanceEvery: 20,
    bounds: { min: 0, max: 1 },
    rf: 0,
    erp: 0.06,
    initialCapital: 1_000_000,
    costs: zero,
    lots: {},
    useLots: false,
    ...over,
  };
};

describe("backtest — reference calculations", () => {
  it("buy and hold without costs: V_T = Σ wᵢ·V₀·Pᵢ,T / Pᵢ,0", () => {
    const x = base({ strategy: "buy_and_hold", weights: { A: 0.5, B: 0.3, C: 0.2 } });
    const r = backtest(x);
    expect(r.ok).toBe(true);
    const T = x.dates.length - 1;
    const ref = [0.5, 0.3, 0.2].reduce((s, w, i) => s + w * 1_000_000 * (x.prices[i][T] / x.prices[i][0]), 0);
    expect(r.values.at(-1)!.value).toBeCloseTo(ref, 2);
    expect(r.period.rebalances).toBe(1);
  });

  it("daily equal-weight rebalancing without costs compounds the average return", () => {
    const x = base({ rebalanceEvery: 1 });
    const r = backtest(x);
    let v = 1_000_000;
    for (let t = 1; t < x.dates.length; t++) v *= 1 + x.prices.reduce((s, p) => s + p[t] / p[t - 1] - 1, 0) / 3;
    expect(r.values.at(-1)!.value).toBeCloseTo(v, 2);
    // TWR from the existing engine matches the value path (no flows after the start).
    expect(r.metrics.cumulativeReturn).toBeCloseTo(v / 1_000_000 - 1, 8);
  });

  it("idle cash accrues Rf", () => {
    const x = base({ strategy: "custom", weights: {}, rf: 0.05 });
    const r = backtest(x);
    const years = (Date.parse(x.dates.at(-1)!) - Date.parse(x.dates[0])) / (365 * 86_400_000);
    expect(r.values.at(-1)!.value).toBeCloseTo(1_000_000 * 1.05 ** years, 4);
  });
});

describe("backtest — costs and turnover", () => {
  it("costs are deducted and attributed; turnover reported", () => {
    const costs = tradingCostsSchema.parse({ commissionPct: 0.2, vatPct: 7, slippageBps: 10, sellTaxPct: 0.1, lotSize: {} });
    const free = backtest(base());
    const paid = backtest(base({ costs }));
    expect(paid.costs.total).toBeGreaterThan(0);
    expect(paid.costs.total).toBeCloseTo(paid.costs.commission + paid.costs.vat + paid.costs.slippage + paid.costs.tax, 6);
    expect(paid.trades.reduce((s, t) => s + t.cost, 0)).toBeCloseTo(paid.costs.total, 6);
    expect(paid.values.at(-1)!.value).toBeLessThan(free.values.at(-1)!.value);
    // The first day's costs reduce TWR (capital funded at the previous close).
    expect(paid.metrics.cumulativeReturn).toBeLessThan(free.metrics.cumulativeReturn);
    expect(paid.turnover.total).toBeGreaterThan(0.99); // initial purchase ≈ 100% of capital
  });

  it("whole lots leave uninvested cash and never overspend", () => {
    const r = backtest(base({ useLots: true, lots: { A: 100, B: 100, C: 100 }, initialCapital: 100_000 }));
    for (const w of r.weights) expect(w.cash).toBeGreaterThanOrEqual(-1e-12);
    for (const t of r.trades) expect(t.quantity % 100).toBeCloseTo(0, 6);
  });
});

describe("backtest — walk-forward, no look-ahead, reproducible", () => {
  it("decisions do not change when only future prices change", () => {
    const x = base({ strategy: "max_sharpe", bounds: { min: 0, max: 0.6 } });
    const a = backtest(x);
    expect(a.ok).toBe(true);
    // Perturb prices strictly after the 3rd rebalance date.
    const cut = x.dates.indexOf(a.weights[2].date);
    const prices = x.prices.map((p, i) => p.map((v, t) => (t > cut ? v * (1 + 0.3 * Math.sin(t + i)) : v)));
    const b = backtest({ ...x, prices });
    for (let k = 0; k <= 2; k++) expect(b.weights[k].target).toEqual(a.weights[k].target);
    expect(b.weights[3].target).not.toEqual(a.weights[3].target);
  });

  it("CAPM β uses only benchmark prints before the trade date, and gaps are not forward-filled", () => {
    const x = base({ strategy: "max_sharpe", returnMethod: "capm", bounds: { min: 0, max: 0.7 } });
    const a = backtest(x);
    expect(a.ok).toBe(true);
    const cut = x.dates.indexOf(a.weights[1].date);
    // Change benchmark prints on/after the 2nd rebalance date and drop some earlier ones.
    const series = x.benchmark!.series.filter((_, t) => t % 17 !== 5).map(([d, v], t) => [d, t >= cut ? v * (1 + 0.5 * Math.cos(t)) : v] as [string, number]);
    const b = backtest({ ...x, benchmark: { ...x.benchmark!, series } });
    expect(b.ok).toBe(true);
    expect(b.weights[0].target).toEqual(backtest({ ...x, benchmark: { ...x.benchmark!, series: series.map(([d, v], t) => [d, t >= cut ? x.benchmark!.series.find(([dd]) => dd === d)![1] : v] as [string, number]) } }).weights[0].target);
  });

  it("the first trade comes after the full training window; weights respect bounds", () => {
    const x = base({ strategy: "min_variance", bounds: { min: 0.1, max: 0.5 }, covMethod: "ledoit_wolf" });
    const r = backtest(x);
    expect(r.period.from).toBe(x.dates[61]);
    for (const w of r.weights) for (const v of Object.values(w.target)) {
      expect(v).toBeGreaterThanOrEqual(0.1 - 1e-9);
      expect(v).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("Black–Litterman with no views and loose bounds holds the market weights", () => {
    const r = backtest(base({ strategy: "black_litterman", blackLitterman: { marketWeights: { A: 0.5, B: 0.3, C: 0.2 }, marketRiskAversion: 3 }, rebalanceEvery: 50 }));
    expect(r.ok).toBe(true);
    for (const w of r.weights) {
      expect(w.target.A).toBeCloseTo(0.5, 4);
      expect(w.target.C).toBeCloseTo(0.2, 4);
    }
  });

  it("same input → identical output; benchmark metrics come from the existing engine", () => {
    const x = base({ strategy: "max_sharpe" });
    expect(backtest(x)).toEqual(backtest(x));
    const r = backtest(x);
    expect(r.metrics.benchmark?.symbol).toBe("IDX");
    expect(r.metrics.benchmark?.trackingError).not.toBeNull();
  });

  it("too little data is an error, not a result", () => {
    const r = backtest(base({ strategy: "max_sharpe", window: 250 }));
    expect(r.ok).toBe(false);
  });
});
