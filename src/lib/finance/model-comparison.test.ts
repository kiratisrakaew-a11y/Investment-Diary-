/** Portfolio model comparison: identical test periods, no look-ahead, ex-ante vs realised numbers. */
import { describe, expect, it } from "vitest";
import { backtest, estimateWindow } from "./backtest";
import { COMPARISON_MODELS, compareModels, type ModelComparisonInput } from "./model-comparison";
import { tradingCostsSchema } from "./rebalance";

// Deterministic synthetic test data (not market data).
function makeData(T = 400, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.04;
  const dates = Array.from({ length: T }, (_, t) => new Date(Date.UTC(2023, 0, 2) + t * 86_400_000).toISOString().slice(0, 10));
  const mk = (drift: number, scale: number) => {
    const p = [100];
    for (let t = 1; t < T; t++) p.push(p[t - 1] * (1 + drift + rnd() * scale));
    return p;
  };
  return { dates, prices: [mk(0.0007, 1), mk(0.0004, 0.6), mk(0.0002, 0.3), mk(0.0005, 0.8)] };
}

const zero = tradingCostsSchema.parse({ lotSize: {} });
const input = (over: Partial<ModelComparisonInput> = {}): ModelComparisonInput => {
  const d = makeData();
  return {
    symbols: ["A", "B", "C", "D"],
    dates: d.dates,
    prices: d.prices,
    benchmark: { symbol: "IDX", series: d.dates.map((dt, t) => [dt, 1000 * (d.prices[0][t] + d.prices[1][t]) / 200] as [string, number]), kind: "price_index" },
    rf: 0.01,
    erp: 0.06,
    bounds: { min: 0, max: 1 },
    covMethod: "sample",
    returnMethod: "historical",
    costs: zero,
    lots: {},
    useLots: false,
    initialCapital: 1_000_000,
    splitFraction: 0.7,
    window: 120,
    rebalanceEvery: 21,
    ...over,
  };
};
const finite = (v: unknown): boolean => (typeof v === "number" ? Number.isFinite(v) : v == null || typeof v !== "object" ? true : Object.values(v as object).every(finite));

describe("model comparison", () => {
  const x = input();
  const r = compareModels(x);
  const T = x.dates.length;
  const s = Math.floor((T - 1) * 0.7);

  it("runs all six models on the same assets", () => {
    expect(r.ok).toBe(true);
    expect(r.models).toEqual([...COMPARISON_MODELS]);
    expect(r.split!.results.map((m) => m.model)).toEqual([...COMPARISON_MODELS]);
    expect(r.walkForward!.results.map((m) => m.model)).toEqual([...COMPARISON_MODELS]);
    expect(r.split!.results.every((m) => m.ok)).toBe(true);
    expect(r.walkForward!.results.every((m) => m.ok)).toBe(true);
  });

  it("every model has the identical out-of-sample period in both modes", () => {
    for (const m of r.split!.results) expect([m.outOfSample!.from, m.outOfSample!.to, m.outOfSample!.observations]).toEqual([x.dates[s], x.dates[T - 1], T - s]);
    for (const m of r.walkForward!.results) expect([m.outOfSample!.from, m.outOfSample!.to, m.outOfSample!.observations]).toEqual([x.dates[121], x.dates[T - 1], T - 121]);
    expect(r.split!.train).toEqual({ from: x.dates[0], to: x.dates[s - 1], observations: s });
    // Training and test parts do not overlap.
    expect(r.split!.train.to < r.split!.test.from).toBe(true);
    for (const m of r.split!.results) expect(m.inSample!.to).toBe(x.dates[s - 1]);
  });

  it("weights sum to 1, respect the bounds, and equal weight is 1/n", () => {
    const b = compareModels(input({ bounds: { min: 0.05, max: 0.6 } }));
    for (const m of b.split!.results) {
      const w = Object.values(m.weights);
      expect(w.reduce((a, c) => a + c, 0)).toBeCloseTo(1, 6);
      for (const v of w) {
        expect(v).toBeGreaterThanOrEqual(0.05 - 1e-6);
        expect(v).toBeLessThanOrEqual(0.6 + 1e-6);
      }
    }
    expect(Object.values(r.split!.results.find((m) => m.model === "equal_weight")!.weights)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it("ex-ante numbers are μ·w and √(wᵀΣw) from the training part", () => {
    const est = estimateWindow(x, 0, s - 1);
    for (const m of r.split!.results) {
      const w = x.symbols.map((sym) => m.weights[sym]);
      const mu = w.reduce((a, wi, i) => a + wi * est.mu[i], 0);
      const vol = Math.sqrt(w.reduce((a, wi, i) => a + wi * est.cov[i].reduce((c, v, j) => c + v * w[j], 0), 0));
      expect(m.exAnte!.expectedReturn).toBeCloseTo(mu, 10);
      expect(m.exAnte!.volatility).toBeCloseTo(vol, 10);
      expect(m.exAnte!.sharpe).toBeCloseTo((mu - x.rf) / vol, 10);
      expect(m.gap!.sharpe).toBeCloseTo(m.outOfSample!.sharpe! - m.exAnte!.sharpe!, 10);
    }
  });

  it("min variance has the lowest ex-ante σ and max Sharpe the highest ex-ante Sharpe", () => {
    const by = Object.fromEntries(r.split!.results.map((m) => [m.model, m.exAnte!]));
    for (const m of COMPARISON_MODELS) {
      expect(by.min_variance.volatility).toBeLessThanOrEqual(by[m].volatility + 1e-6);
      expect(by.max_sharpe.sharpe!).toBeGreaterThanOrEqual(by[m].sharpe! - 1e-6);
    }
  });

  it("no look-ahead: changing test-period prices leaves training weights and ex-ante numbers unchanged", () => {
    const shocked = input();
    shocked.prices = shocked.prices.map((p, i) => p.map((v, t) => (t >= s ? v * (1 + 0.3 * (i + 1)) * (1 + 0.001 * (t - s) * (i % 2 ? -1 : 1)) : v)));
    const r2 = compareModels(shocked);
    for (const [k, m] of r.split!.results.entries()) {
      expect(r2.split!.results[k].weights).toEqual(m.weights);
      expect(r2.split!.results[k].exAnte).toEqual(m.exAnte);
      expect(r2.split!.results[k].inSample).toEqual(m.inSample);
      expect(r2.split!.results[k].outOfSample!.cumulativeReturn).not.toBe(m.outOfSample!.cumulativeReturn);
    }
  });

  it("out-of-sample equals a plain fixed-weight backtest started at the split", () => {
    const m = r.split!.results.find((k) => k.model === "min_variance")!;
    const direct = backtest({ ...x, strategy: "custom", weights: m.weights, window: 1, rebalanceEvery: 21, startIndex: s });
    expect(direct.metrics.cumulativeReturn).toBe(m.outOfSample!.cumulativeReturn);
    expect(direct.metrics.maxDrawdown).toBe(m.outOfSample!.maxDrawdown);
  });

  it("curves: 100 at the first test date, one column per model, benchmark on its own prints, no NaN", () => {
    const c = r.split!.curve;
    expect(c).toHaveLength(T - s);
    expect(c[0].date).toBe(x.dates[s]);
    for (const m of COMPARISON_MODELS) expect(c[0][m]).toBeCloseTo(100, 6);
    expect(c[0].benchmark).toBe(100);
    expect(r.split!.drawdown.every((row) => COMPARISON_MODELS.every((m) => (row[m] as number) <= 1e-12))).toBe(true);
    expect(finite(r)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity/);
  });

  it("costs reduce the out-of-sample result but not the ex-ante or in-sample numbers", () => {
    const costly = compareModels(input({ costs: tradingCostsSchema.parse({ commissionPct: 0.5, slippageBps: 20, lotSize: {} }) }));
    for (const [k, m] of r.split!.results.entries()) {
      expect(costly.split!.results[k].weights).toEqual(m.weights);
      expect(costly.split!.results[k].inSample).toEqual(m.inSample);
      expect(costly.split!.results[k].costs!).toBeGreaterThan(0);
      expect(costly.split!.results[k].outOfSample!.cumulativeReturn).toBeLessThan(m.outOfSample!.cumulativeReturn);
    }
  });

  it("ranking lists models by out-of-sample Sharpe", () => {
    const sh = (m: string) => r.split!.results.find((k) => k.model === m)!.outOfSample!.sharpe!;
    const rank = r.split!.ranking;
    expect(rank).toHaveLength(6);
    for (let i = 1; i < rank.length; i++) expect(sh(rank[i - 1])).toBeGreaterThanOrEqual(sh(rank[i]));
  });

  it("a model that cannot be solved fails alone", () => {
    // Infeasible box for the optimisers (4 × 0.2 < 1); equal weight needs no optimiser.
    const bad = compareModels(input({ bounds: { min: 0, max: 0.2 } }));
    const eq = bad.split!.results.find((m) => m.model === "equal_weight")!;
    const mv = bad.split!.results.find((m) => m.model === "min_variance")!;
    expect(eq.ok).toBe(true);
    expect(mv.ok).toBe(false);
    expect(mv.error).toBeTruthy();
    expect(bad.split!.curve[0].equal_weight).toBeCloseTo(100, 6);
    expect(bad.split!.curve[0].min_variance).toBeUndefined();
  });

  it("short data: readable errors and warnings, never a throw", () => {
    const d = makeData(40);
    const short = compareModels(input({ dates: d.dates, prices: d.prices, benchmark: null }));
    expect(short.ok).toBe(false);
    expect(short.error).toMatch(/แบ่งช่วง|Walk-forward/);
    const one = compareModels(input({ symbols: ["A"], prices: [makeData().prices[0]] }));
    expect(one).toMatchObject({ ok: false });
    expect(one.error).toMatch(/2 สินทรัพย์/);
    const mid = makeData(150);
    const w = compareModels(input({ dates: mid.dates, prices: mid.prices, benchmark: null, window: 120 }));
    expect(w.ok).toBe(true);
    expect(w.warnings.some((m) => /น้อยกว่า 60/.test(m))).toBe(true);
  });

  it("subset of models", () => {
    const two = compareModels(input({ models: ["equal_weight", "risk_parity"] }));
    expect(two.split!.results.map((m) => m.model)).toEqual(["equal_weight", "risk_parity"]);
  });
});

describe("backtest startIndex", () => {
  const x = input();
  const common = { ...x, returnMethod: "historical" as const, window: 60, rebalanceEvery: 20 };
  it("delays the first trade; omitted or below the natural start changes nothing", () => {
    const natural = backtest({ ...common, strategy: "equal_weight" });
    expect(backtest({ ...common, strategy: "equal_weight", startIndex: 0 })).toEqual(natural);
    const late = backtest({ ...common, strategy: "equal_weight", startIndex: 100 });
    expect(late.period.from).toBe(x.dates[100]);
    expect(late.values[0].date).toBe(x.dates[100]);
    const mv = backtest({ ...common, strategy: "min_variance" });
    expect(backtest({ ...common, strategy: "min_variance", startIndex: 10 })).toEqual(mv); // natural start 61 wins
    expect(backtest({ ...common, strategy: "min_variance", startIndex: 100 }).period.from).toBe(x.dates[100]);
  });
});
