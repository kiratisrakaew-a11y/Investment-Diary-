/**
 * Strategies Phase 1 — dividend income plan: entitlement, statuses, withholding, FX, no double counting.
 */
import { describe, expect, it } from "vitest";
import { dividendIncomePlan, type IncomePosition } from "./dividend-income";
import type { DividendEventInput } from "./dividend-metrics";

const ev = (p: Partial<DividendEventInput> & { exDate: string; dividendPerShare: number; symbol?: string }): DividendEventInput => ({
  symbol: "PTT",
  paymentDate: null,
  announcedAt: null,
  currency: "THB",
  cashOrStock: "cash",
  kind: "regular",
  splitAdjustmentPolicy: "as_reported",
  withholdingTaxRate: null,
  source: "set",
  ...p,
});

// Bought 1,000 on 2025-03-10, 500 more on 2025-08-20 (the ex-date of the second dividend).
const ptt: IncomePosition = {
  symbol: "PTT",
  assetClass: "thai_stock",
  currency: "THB",
  quantityNow: 1500,
  quantityAt: (d) => (d >= "2025-08-20" ? 1500 : d >= "2025-03-10" ? 1000 : 0),
};
const base = { today: "2025-10-15", horizonMonths: 12, lookbackMonths: 12, splits: {}, withholding: { thai_stock: 0.1, us_stock: 0.15 }, fxAt: (_c: string, d: string) => ({ rate: 35, date: d }) };

describe("dividend income plan", () => {
  it("entitlement uses units held before the ex-date; buying on the ex-date earns nothing that time", () => {
    const plan = dividendIncomePlan({ ...base, positions: [ptt], events: [ev({ exDate: "2025-08-20", paymentDate: "2025-09-10", dividendPerShare: 1 })], receipts: [] });
    const r = plan.rows.find((x) => x.exDate === "2025-08-20")!;
    expect(r.units).toBe(1000);
    expect(r.gross).toBe(1000);
    expect(r.net).toBeCloseTo(900, 9); // 10% withholding (assumption)
    expect(r.status).toBe("missing_confirmation"); // paid 2025-09-10, no ledger receipt
    expect(r.month).toBe("2025-09"); // cash in the payment month, not the ex-date month
  });
  it("a matching ledger receipt marks it received and is counted once (ledger amount wins)", () => {
    const plan = dividendIncomePlan({ ...base, positions: [ptt], events: [ev({ exDate: "2025-04-15", paymentDate: "2025-05-05", dividendPerShare: 3 })], receipts: [{ id: 7, symbol: "PTT", date: "2025-05-05", amountThb: 2700 }] });
    const r = plan.rows.find((x) => x.exDate === "2025-04-15")!;
    expect(r.status).toBe("received");
    expect(r.receivedThb).toBe(2700);
    const may = plan.byMonth.find((m) => m.period === "2025-05")!;
    expect(may.received).toBe(2700);
    expect(may.missing_confirmation + may.announced + may.estimated).toBe(0);
    expect(plan.unmatchedReceipts).toHaveLength(0);
  });
  it("announced (future) events use the current holding; estimates never duplicate a declared event", () => {
    const events = [ev({ exDate: "2025-04-15", paymentDate: "2025-05-05", dividendPerShare: 3 }), ev({ exDate: "2026-04-16", paymentDate: "2026-05-06", dividendPerShare: 3.2, announcedAt: "2026-02-20" }), ev({ exDate: "2025-08-20", paymentDate: "2025-09-10", dividendPerShare: 1 })];
    const plan = dividendIncomePlan({ ...base, positions: [ptt], events, receipts: [] });
    const announced = plan.rows.filter((r) => r.status === "announced");
    expect(announced).toHaveLength(1);
    expect(announced[0].units).toBe(1500);
    const est = plan.rows.filter((r) => r.status === "estimated");
    // April 2026 is declared → only the August event is projected.
    expect(est.map((r) => r.exDate)).toEqual(["2026-08-20"]);
    expect(est[0].notes.join()).toMatch(/ประมาณการ/);
  });
  it("USD gross → net withholding → THB with the FX rate and date kept", () => {
    const aapl: IncomePosition = { symbol: "AAPL", assetClass: "us_stock", currency: "USD", quantityNow: 10, quantityAt: () => 10 };
    const plan = dividendIncomePlan({ ...base, positions: [aapl], events: [ev({ symbol: "AAPL", currency: "USD", exDate: "2025-08-11", paymentDate: "2025-08-14", dividendPerShare: 0.26 })], receipts: [] });
    const r = plan.rows[0];
    expect(r.gross).toBeCloseTo(2.6, 12);
    expect(r.net).toBeCloseTo(2.21, 12);
    expect(r.netThb).toBeCloseTo(2.21 * 35, 9);
    expect(r.fxDate).toBe("2025-08-14");
  });
  it("split between ex-date and today keeps units and DPS on one basis", () => {
    const pos: IncomePosition = { symbol: "PTT", assetClass: "thai_stock", currency: "THB", quantityNow: 2000, quantityAt: (d) => (d >= "2025-06-01" ? 2000 : 1000) };
    const plan = dividendIncomePlan({ ...base, positions: [pos], splits: { PTT: [{ date: "2025-06-01", ratio: 2 }] }, events: [ev({ exDate: "2025-04-15", paymentDate: "2025-05-05", dividendPerShare: 4 })], receipts: [] });
    const r = plan.rows[0];
    expect(r.units).toBe(2000); // 1,000 old shares = 2,000 latest-basis shares
    expect(r.dpsLatestBasis).toBe(2);
    expect(r.gross).toBe(4000); // economic value unchanged: 1,000 × 4
  });
  it("positions without any event are reported as coverage gaps", () => {
    const plan = dividendIncomePlan({ ...base, positions: [ptt], events: [], receipts: [] });
    expect(plan.coverageGaps).toEqual(["PTT"]);
    expect(plan.rows).toHaveLength(0);
  });
});
