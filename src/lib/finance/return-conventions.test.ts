/**
 * v3 Phase 1 — one price history, same return through every module (no intentional differences).
 */
import { describe, expect, it } from "vitest";
import { buildLevelSeries, returnsOn } from "./return-series";
import { backtest } from "./backtest";
import { tradingCostsSchema } from "./rebalance";
import { buildValueSeries, type AssetInput, type TxInput } from "./portfolio";
import { computeMetrics } from "./metrics";

const dates = Array.from({ length: 60 }, (_, t) => new Date(Date.UTC(2026, 0, 1) + t * 86_400_000).toISOString().slice(0, 10));
const close = dates.map((_, t) => 100 * (1 + 0.002 * t + 0.01 * Math.sin(t)));

describe("cross-module return consistency", () => {
  it("return-series helper = backtest buy-and-hold = ledger NAV TWR (computeMetrics)", () => {
    const lv = buildLevelSeries({ label: "A", observations: dates.map((d, t) => ({ date: d, close: close[t] })), basis: "price_return", currency: "THB" });
    if (!lv.ok) throw new Error(lv.reason);
    const helper = returnsOn(lv.levels, dates).reduce((g, r) => g * (1 + r), 1) - 1;

    const bt = backtest({
      symbols: ["A"], dates, prices: [close], benchmark: null, strategy: "buy_and_hold", weights: { A: 1 },
      returnMethod: "historical", covMethod: "sample", window: 10, rebalanceEvery: 1, bounds: { min: 0, max: 1 },
      rf: 0, erp: 0, initialCapital: 1_000_000, costs: tradingCostsSchema.parse({ lotSize: {} }), lots: {}, useLots: false,
    });

    const assets: AssetInput[] = [{ id: 1, symbol: "A", name: "A", assetClass: "thai_stock", currency: "THB" }];
    const qty = 10_000;
    const txs: TxInput[] = [
      { id: 1, date: dates[0], type: "deposit", assetId: null, quantity: 0, price: qty * close[0], fee: 0, fxRate: 1 },
      { id: 2, date: dates[0], type: "buy", assetId: 1, quantity: qty, price: close[0], fee: 0, fxRate: 1 },
    ];
    const prices = new Map([[1, dates.map((d, t) => [d, close[t]] as [string, number])]]);
    const pts = buildValueSeries(assets, txs, prices, [], dates);
    const m = computeMetrics({ values: pts, cashFlows: [], finalValue: pts.at(-1)!.value, finalDate: dates.at(-1)!, riskFreeRate: 0, benchmark: null });

    const truth = close.at(-1)! / close[0] - 1;
    expect(helper).toBeCloseTo(truth, 10);
    expect(bt.metrics.cumulativeReturn).toBeCloseTo(truth, 8);
    expect(m.cumulativeReturn).toBeCloseTo(truth, 8);
  });
});
