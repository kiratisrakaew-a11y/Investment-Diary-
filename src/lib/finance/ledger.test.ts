/**
 * PR 1 / Phase A regression tests — portfolio ledger integrity.
 * Written before the fix: each case encodes behaviour the remediation spec requires.
 */
import { describe, expect, it } from "vitest";
import {
  LedgerError,
  buildSnapshot,
  buildValueSeries,
  investorCashFlows,
  validateNewTransaction,
  type AssetInput,
  type TxInput,
} from "./portfolio";

const assets: AssetInput[] = [
  { id: 1, symbol: "AAA", name: "AAA", assetClass: "thai_stock", currency: "THB" },
  { id: 2, symbol: "USX", name: "USX", assetClass: "us_stock", currency: "USD" },
];
const tx = (id: number, date: string, type: TxInput["type"], assetId: number | null, quantity: number, price: number, fee = 0, fxRate = 1): TxInput => ({
  id,
  date,
  type,
  assetId,
  quantity,
  price,
  fee,
  fxRate,
});
const noPrices = new Map<number, [string, number][]>();

describe("A1 oversell and validation", () => {
  const ledger = [tx(1, "2024-01-01", "deposit", null, 0, 10_000), tx(2, "2024-01-02", "buy", 1, 10, 100)];

  it("rejects selling more than held with a typed error naming symbol/date/quantity", () => {
    expect(() => validateNewTransaction(assets, ledger, tx(3, "2024-01-03", "sell", 1, 11, 120), "strict")).toThrow(LedgerError);
    try {
      validateNewTransaction(assets, ledger, tx(3, "2024-01-03", "sell", 1, 11, 120), "strict");
    } catch (e) {
      const err = e as LedgerError;
      expect(err.issue.code).toBe("OVERSELL");
      expect(err.issue.symbol).toBe("AAA");
      expect(err.issue.date).toBe("2024-01-03");
      expect(err.message).toContain("11");
    }
  });

  it("legacy oversell in stored history does not inflate realized P&L", () => {
    // Old code booked proceeds for 11 shares while removing cost for 10 → realized 320.
    const s = buildSnapshot(assets, [...ledger, tx(3, "2024-01-03", "sell", 1, 11, 120)], noPrices, [], "2024-01-03");
    const p = s.positions.find((x) => x.symbol === "AAA")!;
    expect(p.quantity).toBe(0);
    expect(p.realizedPnlThb).toBeCloseTo(10 * 120 - 10 * 100);
    expect(s.issues.some((i) => i.code === "OVERSELL")).toBe(true);
  });

  it("Buy 10@100 / Sell 4@120 fee 5 → qty 6, realized 75, proceeds 475", () => {
    const s = buildSnapshot(assets, [...ledger, tx(3, "2024-01-03", "sell", 1, 4, 120, 5)], noPrices, [], "2024-01-03");
    const p = s.positions.find((x) => x.symbol === "AAA")!;
    expect(p.quantity).toBe(6);
    expect(p.realizedPnlThb).toBeCloseTo(75);
    expect(s.cashThb).toBeCloseTo(10_000 - 1000 + 475);
  });

  it("rejects invalid numbers", () => {
    expect(() => validateNewTransaction(assets, ledger, tx(4, "2024-01-03", "buy", 1, 0, 100), "strict")).toThrow(LedgerError);
    expect(() => validateNewTransaction(assets, ledger, tx(4, "2024-01-03", "buy", 1, 1, -5), "strict")).toThrow(LedgerError);
    expect(() => validateNewTransaction(assets, ledger, tx(4, "2024-01-03", "buy", 2, 1, 5, 0, 0), "strict")).toThrow(LedgerError);
  });

  it("duplicate transaction ids are counted once", () => {
    const dup = [...ledger, tx(2, "2024-01-02", "buy", 1, 10, 100)];
    const s = buildSnapshot(assets, dup, noPrices, [], "2024-01-02");
    expect(s.positions[0].quantity).toBe(10);
    expect(s.issues.some((i) => i.code === "DUPLICATE_TX")).toBe(true);
  });

  it("orders same-day transactions by entry sequence (id), not by type", () => {
    // Entered: buy first, then deposit. Strict replay must see the shortfall at the buy.
    const s = buildSnapshot(assets, [tx(1, "2024-01-01", "buy", 1, 10, 100), tx(2, "2024-01-01", "deposit", null, 0, 1000)], noPrices, [], "2024-01-01");
    expect(s.issues.some((i) => i.code === "INSUFFICIENT_CASH")).toBe(true);
  });
});

describe("A2 cash-flow policy", () => {
  it("strict rejects a buy without enough cash", () => {
    expect(() => validateNewTransaction(assets, [], tx(1, "2024-01-01", "buy", 1, 10, 100), "strict")).toThrow(/เงินสด/);
  });

  it("infer_with_warning accepts it but records an inferred external flow", () => {
    expect(() => validateNewTransaction(assets, [], tx(1, "2024-01-01", "buy", 1, 10, 100), "infer_with_warning")).not.toThrow();
  });

  it("stored history with a shortfall is flagged and the inferred flow is explicit, not silent", () => {
    const s = buildSnapshot(assets, [tx(1, "2024-01-01", "buy", 1, 10, 100)], noPrices, [], "2024-01-01");
    expect(s.inferredFlows).toEqual([{ date: "2024-01-01", amount: 1000, reason: expect.any(String) }]);
    expect(s.netContributedThb).toBe(1000);
    expect(s.issues.find((i) => i.code === "INSUFFICIENT_CASH")?.severity).toBe("warning");
    const cfs = investorCashFlows([tx(1, "2024-01-01", "buy", 1, 10, 100)]);
    expect(cfs).toEqual([{ date: "2024-01-01", amount: -1000, inferred: true }]);
  });

  it("dividends are income, not contributions; buys/sells are internal", () => {
    const s = buildSnapshot(
      assets,
      [tx(1, "2024-01-01", "deposit", null, 0, 2000), tx(2, "2024-01-02", "buy", 1, 10, 100), tx(3, "2024-02-01", "dividend", 1, 0, 50)],
      noPrices,
      [],
      "2024-02-01",
    );
    expect(s.netContributedThb).toBe(2000);
    expect(s.positions[0].incomeThb).toBe(50);
    expect(s.cashThb).toBe(1050);
  });
});

describe("A3 prices and FX", () => {
  const ledger = [tx(1, "2024-01-01", "deposit", null, 0, 100_000), tx(2, "2024-01-02", "buy", 2, 10, 100, 0, 35)];

  it("missing USDTHB is flagged and never valued at FX = 1", () => {
    const prices = new Map<number, [string, number][]>([[2, [["2024-01-10", 110]]]]);
    const s = buildSnapshot(assets, ledger, prices, [], "2024-01-10");
    const p = s.positions[0];
    expect(p.fxStatus).toBe("tx_fallback");
    expect(p.marketValueThb).toBeCloseTo(10 * 110 * 35); // trade-date FX, not ×1
    expect(s.issues.some((i) => i.code === "FX_FALLBACK")).toBe(true);
  });

  it("no market price → valued at last trade price but visibly flagged", () => {
    const s = buildSnapshot(assets, ledger, noPrices, [["2024-01-10", 36]], "2024-01-10");
    expect(s.positions[0].priceStatus).toBe("tx_price_fallback");
    expect(s.issues.some((i) => i.code === "TX_PRICE_FALLBACK")).toBe(true);
  });

  it("price older than the asset-class limit is stale", () => {
    const prices = new Map<number, [string, number][]>([[2, [["2024-01-02", 100]]]]);
    const s = buildSnapshot(assets, ledger, prices, [["2024-03-01", 36]], "2024-03-01");
    expect(s.positions[0].priceStatus).toBe("stale");
    expect(s.positions[0].priceAgeDays).toBe(59);
  });

  it("fresh price and FX are marked market", () => {
    const prices = new Map<number, [string, number][]>([[2, [["2024-01-09", 100]]]]);
    const s = buildSnapshot(assets, ledger, prices, [["2024-01-09", 36]], "2024-01-10");
    expect(s.positions[0].priceStatus).toBe("market");
    expect(s.positions[0].fxStatus).toBe("market");
  });
});

describe("A4 reconciliation", () => {
  it("NAV = cash + Σ market value and weights sum to 100%", () => {
    const prices = new Map<number, [string, number][]>([[1, [["2024-01-05", 120]]]]);
    const s = buildSnapshot(assets, [tx(1, "2024-01-01", "deposit", null, 0, 5000), tx(2, "2024-01-02", "buy", 1, 10, 100)], prices, [], "2024-01-05");
    expect(s.reconciliation.navMatches).toBe(true);
    expect(s.reconciliation.weightSumPct).toBeCloseTo(100);
    expect(s.reconciliation.status).toBe("ok");
    expect(s.totalValueThb).toBeCloseTo(4000 + 1200);
  });

  it("value series flows mark inferred contributions", () => {
    const series = buildValueSeries(assets, [tx(1, "2024-01-01", "buy", 1, 10, 100)], noPrices, [], ["2024-01-01"]);
    expect(series[0].flow).toBe(1000);
    expect(series[0].inferredFlow).toBe(1000);
  });
});
