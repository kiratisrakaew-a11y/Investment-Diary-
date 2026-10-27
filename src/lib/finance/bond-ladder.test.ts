/**
 * Strategies Phase 4 — bond ladder on the existing bond engine.
 */
import { describe, expect, it } from "vitest";
import { bondLadder, type LadderCandidate, type LadderSettings } from "./bond-ladder";

const settlement = "2026-01-15";
const bond = (symbol: string, years: number, coupon: number, o: Partial<LadderCandidate> = {}): LadderCandidate => ({
  symbol,
  issuer: symbol,
  faceValue: 1000,
  cleanPer100: 100,
  spec: { settlement, maturity: `${2026 + years}-01-15`, couponRate: coupon, frequency: 2, dayCount: "ACT/ACT-ICMA" },
  credit: { rating: "A" },
  priceDate: "2026-01-14",
  ...o,
});
const base: LadderSettings = { budget: 1_000_000, rungs: 5, maxPerIssuer: null, maxOneYearPd: null, minRating: null, allowUnrated: false, reinvestRate: null, maxPriceAgeDays: 10 };

describe("bond ladder", () => {
  const five = [1, 2, 3, 4, 5].map((y) => bond(`B${y}`, y, 0.02 + 0.005 * y));
  it("one rung per year, equal budget, whole units at the dirty price; principal returns by year", () => {
    const r = bondLadder(five, base, settlement);
    expect(r.holdings.map((h) => h.rung)).toEqual([1, 2, 3, 4, 5]);
    for (const h of r.holdings) {
      expect(h.units).toBe(200); // 200,000 ÷ (100% × 1,000)
      expect(h.accruedPaid).toBeCloseTo(0, 9); // settlement on a coupon date
      expect(h.ytm).toBeCloseTo(0.02 + 0.005 * h.rung, 8); // par bond: YTM = coupon
    }
    expect(r.totals.invested).toBeCloseTo(1_000_000, 6);
    const principal = Object.fromEntries(r.cashflowsByYear.map((y) => [y.year, y.principal]));
    expect(principal["2027"]).toBeCloseTo(200_000, 6);
    expect(principal["2031"]).toBeCloseTo(200_000, 6);
    // Bought on a coupon date: that coupon belongs to the seller, so 2026 holds only the July coupon.
    const c2026 = r.cashflowsByYear.find((y) => y.year === "2026")!.coupon;
    expect(c2026).toBeCloseTo(five.reduce((s, b) => s + (200_000 * b.spec.couponRate) / 2, 0), 4);
    // Portfolio XIRR lies between the shortest and longest yields.
    expect(r.portfolioYield!.rate!).toBeGreaterThan(0.025);
    expect(r.portfolioYield!.rate!).toBeLessThan(0.045);
  });
  it("an empty rung stays in cash and is reported", () => {
    const r = bondLadder(five.filter((b) => b.symbol !== "B3"), base, settlement);
    expect(r.gaps).toEqual([3]);
    expect(r.totals.cash).toBeCloseTo(200_000, 6);
    expect(r.warnings.join()).toMatch(/ขั้นปีที่ 3/);
  });
  it("issuer cap limits two rungs from one issuer", () => {
    const sameIssuer = five.map((b, i) => (i < 2 ? { ...b, issuer: "ACME" } : b));
    const r = bondLadder(sameIssuer, { ...base, maxPerIssuer: 0.3 }, settlement);
    const acme = r.holdings.filter((h) => h.issuer === "ACME").reduce((s, h) => s + h.cost, 0);
    expect(acme).toBeLessThanOrEqual(300_000 + 1e-6);
  });
  it("credit filters: minimum rating, 1-year PD, unrated", () => {
    const set = [
      bond("LOW", 1, 0.03, { credit: { rating: "BB+" } }),
      bond("RISKY", 2, 0.03, { credit: { rating: "A", pd: { type: "hypothetical", source: "test", asOf: "2026-01-01", annual: 0.05 } } }),
      bond("NR", 3, 0.03, { credit: null }),
      bond("OK", 4, 0.03, { credit: { rating: "A", pd: { type: "historical", source: "test", asOf: "2026-01-01", annual: 0.002 } } }),
      bond("NOPD", 5, 0.03),
    ];
    const r = bondLadder(set, { ...base, minRating: "BBB-", maxOneYearPd: 0.01 }, settlement);
    expect(Object.fromEntries(r.excluded.map((e) => [e.symbol, e.code]))).toEqual({ LOW: "below_min_rating", RISKY: "pd_above_max", NR: "unrated", NOPD: "no_pd" });
    expect(r.holdings.map((h) => h.symbol)).toEqual(["OK"]);
  });
  it("stale prices and maturities outside the ladder are excluded", () => {
    const r = bondLadder([bond("OLD", 2, 0.03, { priceDate: "2025-10-01" }), bond("LONG", 8, 0.03)], base, settlement);
    expect(r.excluded.map((e) => e.code).sort()).toEqual(["outside_ladder", "stale_price"]);
  });
  it("reinvestment scenario is labelled by year and uses the assumed rate", () => {
    const r = bondLadder(five, { ...base, reinvestRate: 0.03 }, settlement);
    const y27 = r.reinvestment!.find((x) => x.year === "2027")!;
    expect(y27.incomeNextYear).toBeCloseTo(y27.toReinvest * 0.03, 9);
  });
});
