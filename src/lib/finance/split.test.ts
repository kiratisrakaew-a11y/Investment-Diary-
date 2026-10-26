/**
 * Stock splits: ledger, value series, price-history repair, detection.
 */
import { describe, expect, it } from "vitest";
import { LedgerError, buildSnapshot, buildValueSeries, investorCashFlows, validateNewTransaction, type AssetInput, type TxInput } from "./portfolio";
import { detectUnrecordedSplits, planSplitPriceRepair } from "./price-coverage";
import { transactionInput } from "../validation";

const assets: AssetInput[] = [{ id: 1, symbol: "AAA", name: "AAA", assetClass: "thai_stock", currency: "THB" }];
const tx = (id: number, date: string, type: TxInput["type"], quantity: number, price: number, fee = 0): TxInput => ({ id, date, type, assetId: type === "deposit" ? null : 1, quantity, price, fee, fxRate: 1 });
const base = [tx(1, "2026-01-02", "deposit", 0, 100_000), tx(2, "2026-01-05", "buy", 1_000, 30, 50)];
// Split-adjusted prices (as Yahoo returns them): 15 before and after the split date.
const prices = new Map([[1, [["2026-01-05", 15], ["2026-02-02", 15.5], ["2026-02-03", 16]] as [string, number][]]]);

describe("split in the ledger", () => {
  it("1:2 split doubles units, halves average cost, keeps cost basis, cash and P&L", () => {
    const s = buildSnapshot(assets, [...base, tx(3, "2026-02-03", "split", 2, 0)], prices, [], "2026-02-03");
    const p = s.positions[0];
    expect(p.quantity).toBe(2_000);
    expect(p.costBasisThb).toBeCloseTo(30_050);
    expect(p.avgCostThb).toBeCloseTo(15.025);
    expect(p.marketValueThb).toBeCloseTo(32_000);
    expect(s.cashThb).toBeCloseTo(100_000 - 30_050);
    expect(p.realizedPnlThb).toBe(0);
  });

  it("without the split the position is understated by half (the bug this fixes)", () => {
    const s = buildSnapshot(assets, base, prices, [], "2026-02-03");
    expect(s.positions[0].marketValueThb).toBeCloseTo(16_000);
  });

  it("sells after the split use the new quantity; reverse split 10:1", () => {
    const after = [...base, tx(3, "2026-02-03", "split", 2, 0)];
    expect(() => validateNewTransaction(assets, after, tx(4, "2026-02-04", "sell", 2_000, 16), "strict")).not.toThrow();
    expect(() => validateNewTransaction(assets, after, tx(4, "2026-02-04", "sell", 2_001, 16), "strict")).toThrow(LedgerError);
    const rev = buildSnapshot(assets, [...base, tx(3, "2026-02-03", "split", 0.1, 0)], new Map([[1, [["2026-02-03", 300]] as [string, number][]]]), [], "2026-02-03");
    expect(rev.positions[0].quantity).toBeCloseTo(100);
    expect(rev.positions[0].avgCostThb).toBeCloseTo(300.5);
  });

  it("no external flow; value is continuous across the split (old-level prices before, new-level after)", () => {
    const ledger = [...base, tx(3, "2026-02-03", "split", 2, 0)];
    expect(investorCashFlows(ledger, assets)).toEqual([{ date: "2026-01-02", amount: -100_000 }]);
    const raw = new Map([[1, [["2026-02-02", 31], ["2026-02-03", 15.6]] as [string, number][]]]);
    const pts = buildValueSeries(assets, ledger, raw, [], ["2026-02-02", "2026-02-03"]);
    expect(pts[1].flow).toBe(0);
    const positions = (v: number) => v - (100_000 - 30_050);
    expect(positions(pts[0].value)).toBeCloseTo(31_000); // 1,000 × 31
    expect(positions(pts[1].value)).toBeCloseTo(31_200); // 2,000 × 15.6 — no −50% drop
  });

  it("rejects a split with no holding, ratio ≤ 0 or = 1", () => {
    expect(() => validateNewTransaction(assets, [base[0]], tx(3, "2026-02-03", "split", 2, 0), "strict")).toThrow(/ไม่มีหุ้น/);
    expect(() => validateNewTransaction(assets, base, tx(3, "2026-02-03", "split", 1, 0), "strict")).toThrow(LedgerError);
    expect(transactionInput.safeParse({ type: "split", symbol: "AAA", price: 0, splitFrom: 1, splitTo: 2 }).success).toBe(true);
    expect(transactionInput.safeParse({ type: "split", price: 0, splitFrom: 1, splitTo: 2 }).success).toBe(false);
  });
});

describe("split price-history repair", () => {
  const unadjusted = [
    { date: "2026-01-30", close: 31, adjClose: null },
    { date: "2026-02-02", close: 31, adjClose: 30 },
    { date: "2026-02-03", close: 15.6, adjClose: null },
  ];
  it("divides stored pre-split prices by the ratio when they are still at the old level", () => {
    const p = planSplitPriceRepair(unadjusted, "2026-02-03", 2);
    expect(p.status).toBe("unadjusted");
    expect(p.updates).toEqual([
      { date: "2026-01-30", close: 15.5, adjClose: null },
      { date: "2026-02-02", close: 15.5, adjClose: 15 },
    ]);
    // Idempotent: after applying, nothing more to do.
    const fixed = unadjusted.map((r) => p.updates.find((u) => u.date === r.date) ?? r);
    expect(planSplitPriceRepair(fixed, "2026-02-03", 2).status).toBe("already_adjusted");
  });
  it("reverse split, no data and ambiguous gaps", () => {
    const rev = planSplitPriceRepair([{ date: "2026-01-01", close: 3, adjClose: null }, { date: "2026-01-02", close: 29, adjClose: null }], "2026-01-02", 0.1);
    expect(rev.status).toBe("unadjusted");
    expect(rev.updates[0].close).toBeCloseTo(30);
    expect(planSplitPriceRepair([{ date: "2026-02-04", close: 15, adjClose: null }], "2026-02-03", 2).status).toBe("no_data");
    expect(planSplitPriceRepair([{ date: "2026-02-02", close: 22, adjClose: null }, { date: "2026-02-03", close: 15, adjClose: null }], "2026-02-03", 2).status).toBe("ambiguous");
  });
});

describe("unrecorded split detection", () => {
  const s: [string, number][] = [["2026-02-01", 30], ["2026-02-02", 31], ["2026-02-03", 15.4], ["2026-02-04", 15.6]];
  it("flags a ≈2× gap unless a split is recorded near that date; ignores normal moves", () => {
    expect(detectUnrecordedSplits(s, [])).toEqual([{ date: "2026-02-03", previousDate: "2026-02-02", factor: 2, observed: 31 / 15.4 }]);
    expect(detectUnrecordedSplits(s, ["2026-02-03"])).toEqual([]);
    expect(detectUnrecordedSplits([["2026-01-01", 10], ["2026-01-02", 13]], [])).toEqual([]);
  });
});
