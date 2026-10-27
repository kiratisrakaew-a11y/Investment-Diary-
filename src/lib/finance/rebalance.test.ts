/**
 * Roadmap Phase 4 — cost-aware rebalancing proposals.
 */
import { describe, expect, it } from "vitest";
import { rebalance, tradeCost, tradingCostsSchema, type RebalanceInput } from "./rebalance";

const costs = tradingCostsSchema.parse({ commissionPct: 0.157, minCommission: 50, vatPct: 7, slippageBps: 10, sellTaxPct: 0.1, lotSize: { thai_stock: 100 } });
const base = (over: Partial<RebalanceInput> = {}): RebalanceInput => ({
  assets: [
    { symbol: "PTT", price: 35, quantity: 3_000, lot: 100, target: 0.3 },
    { symbol: "BBL", price: 150, quantity: 0, lot: 100, target: 0.4 },
    { symbol: "FUND", price: 12.3456, quantity: 4_000, lot: 0.0001, target: 0.2 },
  ],
  cash: 50_000,
  extraCash: 0,
  cashReserve: 0,
  costs,
  objective: "track",
  noTradeBand: 0,
  allowSell: true,
  cov: null,
  ...over,
});

describe("tradeCost", () => {
  it("commission with a minimum, VAT on commission, slippage, sell tax on sells only", () => {
    const b = tradeCost(100_000, "buy", costs);
    expect(b.commission).toBeCloseTo(157);
    expect(b.vat).toBeCloseTo(10.99);
    expect(b.slippage).toBeCloseTo(100);
    expect(b.tax).toBe(0);
    const s = tradeCost(-10_000, "sell", costs);
    expect(s.commission).toBe(50); // 15.7 < minimum 50
    expect(s.tax).toBeCloseTo(10);
    expect(tradeCost(0, "buy", costs).total).toBe(0);
  });
});

describe("rebalance", () => {
  it("whole lots, cash never negative after costs, closer to target, proposal only", () => {
    const r = rebalance(base());
    expect(r.ok).toBe(true);
    expect(r.proposalOnly).toBe(true);
    for (const t of r.trades) {
      const lot = t.symbol === "FUND" ? 0.0001 : 100;
      expect(Math.abs(t.quantity / lot - Math.round(t.quantity / lot))).toBeLessThan(1e-6);
    }
    expect(r.cash.end).toBeGreaterThanOrEqual(0);
    expect(r.distance.after).toBeLessThan(r.distance.before);
    // Accounting: end cash = start − buys + sells − costs.
    expect(r.cash.end).toBeCloseTo(50_000 - r.totals.buy + r.totals.sell - r.totals.cost, 6);
    const bbl = r.trades.find((t) => t.symbol === "BBL")!;
    expect(bbl.side).toBe("buy");
    expect(bbl.finalWeight).toBeGreaterThan(0.3);
  });

  it("never spends more cash than available: no selling allowed and little cash", () => {
    const r = rebalance(base({ allowSell: false, cash: 20_000 }));
    expect(r.cash.end).toBeGreaterThanOrEqual(0);
    expect(r.trades.every((t) => t.side !== "sell")).toBe(true);
    expect(r.totals.buy + r.totals.cost).toBeLessThanOrEqual(20_000 + 1e-6);
  });

  it("respects the cash reserve, minimum trade value and turnover cap", () => {
    const reserve = rebalance(base({ cashReserve: 30_000 }));
    expect(reserve.cash.end).toBeGreaterThanOrEqual(30_000 - 1e-6);
    const minTrade = rebalance(base({ costs: { ...costs, minTradeValue: 100_000 } }));
    for (const t of minTrade.trades) if (t.side !== "hold") expect(t.value).toBeGreaterThanOrEqual(100_000 - 1e-6);
    const capped = rebalance(base({ maxTurnover: 0.1 }));
    expect(capped.totals.turnoverPct).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it("no-trade band freezes assets near target; untargeted holdings are kept", () => {
    const r = rebalance(base({ noTradeBand: 0.5 }));
    expect(r.trades.every((t) => t.side === "hold")).toBe(true);
    const kept = rebalance(base({ assets: [...base().assets.slice(0, 2), { ...base().assets[2], target: null }] }));
    expect(kept.trades.find((t) => t.symbol === "FUND")!.side).toBe("hold");
  });

  it("min_cost trades less than track; costs are lower", () => {
    const track = rebalance(base());
    const cheap = rebalance(base({ objective: "min_cost" }));
    expect(cheap.totals.cost).toBeLessThanOrEqual(track.totals.cost + 1e-9);
  });

  it("zero target sells the whole holding (odd lots included); missing price and targets above 100% are reported", () => {
    const r = rebalance(base({ assets: [{ symbol: "PTT", price: 35, quantity: 3_050, lot: 100, target: 0 }, { symbol: "BBL", price: 150, quantity: 0, lot: 100, target: 0.9 }] }));
    expect(r.trades[0].finalQuantity).toBe(0);
    // Even when keeping a little would lower ex-ante TE (correlated hedge), a 0% target exits fully.
    const hedge = rebalance(base({
      assets: [
        { symbol: "A", price: 10, quantity: 1_000, lot: 1, target: 0 },
        { symbol: "B", price: 10, quantity: 0, lot: 1, target: 0.5 },
      ],
      cash: 0,
      cov: [[0.04, 0.035], [0.035, 0.04]],
    }));
    expect(hedge.trades[0].finalQuantity).toBe(0);
    const noPrice = rebalance(base({ assets: [{ symbol: "X", price: null, quantity: 10, lot: 1, target: 0.2 }, ...base().assets.slice(1)] }));
    expect(noPrice.violations.some((v) => v.includes("X"))).toBe(true);
    const over = rebalance(base({ assets: base().assets.map((a) => ({ ...a, target: 0.5 })) }));
    expect(over.ok).toBe(false);
  });

  it("uses tracking error with a covariance", () => {
    const cov = [
      [0.04, 0.01, 0.002],
      [0.01, 0.05, 0.002],
      [0.002, 0.002, 0.01],
    ];
    const r = rebalance(base({ cov }));
    expect(r.distance.measure).toBe("tracking_error");
    expect(r.distance.after).toBeLessThan(r.distance.before);
  });

  it("fractional mode (FIX-1): exact continuous targets, buys scaled so cash covers costs, no lot search", () => {
    const t0 = Date.now();
    const r = rebalance(base({
      fractional: true,
      assets: [
        { symbol: "A", price: 35, quantity: 3_000, lot: 1e-6, target: 0.5 },
        { symbol: "B", price: 150, quantity: 0, lot: 1e-6, target: 0.5 },
      ],
    }));
    expect(Date.now() - t0).toBeLessThan(200);
    expect(r.cash.end).toBeGreaterThanOrEqual(-1e-6);
    expect(r.cash.end).toBeLessThan(1); // fully invested apart from costs
    // Sold A exactly to 50% of the starting total; B bought with what remains after costs.
    const total = 3_000 * 35 + 50_000;
    expect(r.trades[0].finalQuantity * 35).toBeCloseTo(0.5 * total, 6);
    expect(r.trades[1].value + r.totals.cost).toBeCloseTo(50_000 + r.trades[0].value - 0, 4);
  });
});
