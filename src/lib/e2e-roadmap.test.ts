/**
 * Roadmap final phase — end-to-end workflow on deterministic synthetic data (not market data):
 * price table import → data → expected returns (Black–Litterman) → optimizer → cost-aware
 * rebalance → risk / stress → walk-forward backtest; SOTP valuation independently.
 */
import { describe, expect, it } from "vitest";
import { parsePriceTable } from "./prices/price-import";
import { coverage, planWrites } from "./finance/price-coverage";
import { estimateInputs } from "./finance/mpt";
import { blackLitterman } from "./finance/black-litterman";
import { recommend } from "./finance/recommend";
import { rebalance, tradingCostsSchema } from "./finance/rebalance";
import { riskContribution } from "./finance/risk-contribution";
import { runStress } from "./finance/stress";
import { backtest } from "./finance/backtest";
import { evaluate, valuationInput } from "./valuation-schemas";

describe("roadmap workflow (end to end)", () => {
  // 260 business-like days for three assets, wide CSV with Buddhist-era dates.
  const T = 260;
  let s = 5;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.03;
  const dates = Array.from({ length: T }, (_, t) => new Date(Date.UTC(2025, 0, 1) + t * 86_400_000).toISOString().slice(0, 10));
  const px = [0.0005, 0.0003, 0.0002].map((drift, i) => {
    const p = [100 + 10 * i];
    for (let t = 1; t < T; t++) p.push(p[t - 1] * (1 + drift + rnd() * (1 - 0.3 * i)));
    return p;
  });
  const csv = ["Date,AAA,BBB,CCC", ...dates.map((d, t) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${+d.slice(0, 4) + 543},${px.map((p) => p[t].toFixed(4)).join(",")}`)].join("\n");

  it("runs every stage with consistent results", () => {
    // 1. Import + idempotent write plan + coverage
    const parsed = parsePriceTable(csv);
    expect(parsed.format).toBe("wide");
    expect(parsed.rows).toHaveLength(3 * T);
    const aaa = parsed.rows.filter((r) => r.symbol === "AAA").map((r) => ({ date: r.date, close: r.close, adjClose: null }));
    const plan = planWrites(new Map(), aaa, { overwrite: false, priceType: "close" });
    expect(plan.inserts).toHaveLength(T);
    expect(planWrites(new Map(aaa.map((r) => [r.date, { close: r.close, adjClose: null }])), aaa, { overwrite: false, priceType: "close" }).inserts).toHaveLength(0);
    expect(coverage(aaa.map((r) => r.date), { from: dates[0], to: dates[T - 1] }, dates[T - 1]).observations).toBe(T);

    // 2. Estimation on rounded imported prices
    const prices = ["AAA", "BBB", "CCC"].map((sym) => parsed.rows.filter((r) => r.symbol === sym).map((r) => r.close));
    const rets = prices.map((p) => p.slice(1).map((v, k) => v / p[k] - 1));
    const { cov } = estimateInputs(rets, 365);

    // 3. Black–Litterman → existing optimizer
    const bl = blackLitterman({ symbols: ["AAA", "BBB", "CCC"], cov, rf: 0.02, marketWeights: { AAA: 0.5, BBB: 0.3, CCC: 0.2 }, riskAversion: 3, tau: 0.05, views: [{ type: "absolute", symbol: "CCC", return: 0.15, confidence: 0.6 }] });
    expect(bl.ok).toBe(true);
    const rec = recommend({ symbols: ["AAA", "BBB", "CCC"], mu: bl.posterior, cov, rf: 0.02, bounds: { min: 0, max: 0.6 }, objective: "max_sharpe", riskAversion: 4, useRiskFree: false });
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    const w = rec.risky.weights;
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);

    // 4. Cost-aware rebalance from an all-cash start
    const last = prices.map((p) => p[T - 1]);
    const costs = tradingCostsSchema.parse({ commissionPct: 0.157, minCommission: 50, vatPct: 7, slippageBps: 10, lotSize: {} });
    const reb = rebalance({
      assets: ["AAA", "BBB", "CCC"].map((sym, i) => ({ symbol: sym, price: last[i], quantity: 0, lot: 100, target: w[i] })),
      cash: 1_000_000,
      extraCash: 0,
      cashReserve: 0,
      costs,
      objective: "track",
      noTradeBand: 0,
      allowSell: true,
      cov,
    });
    expect(reb.ok).toBe(true);
    expect(reb.cash.end).toBeGreaterThanOrEqual(0);
    for (const t of reb.trades) expect(Math.abs(t.finalWeight - (t.targetWeight ?? 0))).toBeLessThan(0.02);

    // 5. Risk decomposition and stress on the proposed holdings
    const values = reb.trades.map((t) => t.finalQuantity * (t.price ?? 0));
    const tot = values.reduce((a, b) => a + b, 0);
    const rc = riskContribution(["AAA", "BBB", "CCC"], values.map((v) => v / tot), cov);
    expect(rc.assets.reduce((a, x) => a + x.contribution, 0)).toBeCloseTo(rc.volatility, 10);
    const st = runStress(
      reb.trades.map((t, i) => ({ symbol: t.symbol, assetClass: "thai_stock", currency: "THB" as const, value: values[i], beta: 1, modifiedDuration: null, convexity: null })),
      reb.cash.end,
      { equityShock: -0.1 },
    );
    expect(st.pnl).toBeCloseTo(-0.1 * tot, 6);

    // 6. Walk-forward backtest with the same cost model
    const bt = backtest({
      symbols: ["AAA", "BBB", "CCC"],
      dates,
      prices,
      benchmark: null,
      strategy: "black_litterman",
      blackLitterman: { marketWeights: { AAA: 0.5, BBB: 0.3, CCC: 0.2 }, marketRiskAversion: 3, views: [{ type: "absolute", symbol: "CCC", return: 0.15, confidence: 0.6 }] },
      returnMethod: "historical",
      covMethod: "ledoit_wolf",
      window: 90,
      rebalanceEvery: 30,
      bounds: { min: 0, max: 0.6 },
      rf: 0.02,
      erp: 0.06,
      initialCapital: 1_000_000,
      costs,
      lots: {},
      useLots: false,
    });
    expect(bt.ok).toBe(true);
    expect(bt.period.from).toBe(dates[91]);
    expect(bt.costs.total).toBeGreaterThan(0);
    expect(bt.metrics.cumulativeReturn).toBeCloseTo(bt.values.at(-1)!.value / 1_000_000 - 1, 8);
  });

  it("SOTP valuation runs through the same valuation entry point", () => {
    const v = valuationInput.parse({
      method: "sotp",
      assumptions: { sharesOutstanding: 100, currentPrice: 10, netDebt: 100, segments: [{ name: "Core", role: "division", source: { type: "multiple", metric: 100, multiple: 10 } }] },
    });
    expect(evaluate(v).value).toBeCloseTo(9);
  });
});
