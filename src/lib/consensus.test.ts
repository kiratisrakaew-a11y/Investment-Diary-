/** Analyst consensus (pure): validation, Yahoo mapping, latest-found selection, upside and caveats. */
import { describe, expect, it } from "vitest";
import { CONSENSUS_STALE_DAYS, consensusInput, consensusView, fromYahoo, pickLatest } from "./consensus";

const base = { symbol: "ptt", asOf: "2026-10-01", sourceNote: "บล.ตัวอย่าง (sample)" };
const err = (x: unknown) => {
  const r = consensusInput.safeParse(x);
  return r.success ? null : r.error.issues.map((i) => i.message).join(" | ");
};

describe("consensusInput", () => {
  it("accepts a cited mean or median target", () => {
    expect(err({ ...base, targetMean: 40 })).toBeNull();
    expect(err({ ...base, targetMedian: 39, targetLow: 30, targetHigh: 45, analysts: 12, recommendationKey: "buy" })).toBeNull();
    expect(consensusInput.parse({ ...base, targetMean: 40, currency: "thb" }).currency).toBe("THB");
  });
  it("refuses missing target, missing source, non-positive values and inconsistent ranges", () => {
    expect(err({ ...base })).toMatch(/อย่างน้อยหนึ่งค่า/);
    expect(err({ ...base, sourceNote: " ", targetMean: 40 })).toMatch(/แหล่งที่มา/);
    expect(err({ ...base, targetMean: 0 })).not.toBeNull();
    expect(err({ ...base, targetMean: -5 })).not.toBeNull();
    expect(err({ ...base, targetMean: 40, targetLow: 50, targetHigh: 45 })).toMatch(/ต่ำสุดมากกว่าราคาสูงสุด/);
    expect(err({ ...base, targetMean: 60, targetLow: 30, targetHigh: 45 })).toMatch(/สูงกว่าราคาสูงสุด/);
    expect(err({ ...base, targetMean: 20, targetLow: 30, targetHigh: 45 })).toMatch(/ต่ำกว่าราคาต่ำสุด/);
    expect(err({ ...base, asOf: "1/10/2026", targetMean: 40 })).not.toBeNull();
    expect(err({ ...base, targetMean: 40, analysts: 2.5 })).not.toBeNull();
    expect(err({ ...base, targetMean: 40, recommendationKey: "moon" })).not.toBeNull();
  });
});

describe("fromYahoo", () => {
  it("maps financialData as published", () => {
    const r = fromYahoo({
      financialData: { currentPrice: 34, targetMeanPrice: 40.5, targetMedianPrice: 40, targetHighPrice: 46, targetLowPrice: 33, numberOfAnalystOpinions: 21, recommendationKey: "buy", recommendationMean: 2.1 },
      price: { currency: "THB" },
    });
    expect(r).toEqual({ ok: true, figures: { currency: "THB", targetMean: 40.5, targetMedian: 40, targetHigh: 46, targetLow: 33, analysts: 21, recommendationKey: "buy", recommendationMean: 2.1, priceAtFetch: 34 } });
  });
  it("no target → NO_COVERAGE, nothing guessed", () => {
    expect(fromYahoo({ financialData: { currentPrice: 34, numberOfAnalystOpinions: 0, recommendationKey: "none" } })).toMatchObject({ ok: false, code: "NO_COVERAGE" });
    expect(fromYahoo({})).toMatchObject({ ok: false, code: "NO_COVERAGE" });
    expect(fromYahoo({ financialData: { targetMeanPrice: 0 } })).toMatchObject({ ok: false, code: "NO_COVERAGE" });
  });
  it("median only; unknown fields stay null; inverted range dropped; odd rating ignored", () => {
    const r = fromYahoo({ financialData: { targetMedianPrice: 12, targetHighPrice: 9, targetLowPrice: 15, recommendationKey: "strongBuy", recommendationMean: 7 } });
    expect(r.ok && r.figures).toMatchObject({ targetMean: null, targetMedian: 12, targetHigh: null, targetLow: null, analysts: null, recommendationKey: "strong_buy", recommendationMean: null, currency: null, priceAtFetch: null });
  });
});

describe("pickLatest / consensusView", () => {
  it("latest as-of wins, then the most recently stored", () => {
    const rows = [
      { id: 1, asOf: "2026-09-01", createdAt: "2026-09-01T10:00:00Z" },
      { id: 2, asOf: "2026-10-01", createdAt: "2026-10-01T09:00:00Z" },
      { id: 3, asOf: "2026-10-01", createdAt: "2026-10-01T12:00:00Z" },
      { id: 4, asOf: "2026-08-01", createdAt: "2026-11-01T12:00:00Z" },
    ];
    expect(pickLatest(rows)?.id).toBe(3);
    expect(pickLatest([])).toBeNull();
  });
  it("upside vs price, mean preferred over median, age and stale flag", () => {
    const v = consensusView({ asOf: "2026-11-01", targetMean: 44, targetMedian: 40, currency: "THB" }, { price: 40, priceCurrency: "THB", today: "2026-11-18" });
    expect(v).toMatchObject({ target: 44, targetBasis: "mean", ageDays: 17, stale: false, warnings: [] });
    expect(v.upside).toBeCloseTo(0.1, 12);
    const m = consensusView({ asOf: "2026-01-01", targetMean: null, targetMedian: 30, currency: null }, { price: 40, today: "2026-11-18" });
    expect(m.targetBasis).toBe("median");
    expect(m.upside).toBeCloseTo(-0.25, 12);
    expect(m.ageDays).toBeGreaterThan(CONSENSUS_STALE_DAYS);
    expect(m.stale).toBe(true);
    expect(m.warnings.join()).toMatch(/ข้อมูลเก่า/);
  });
  it("currency mismatch or no price → no upside", () => {
    const x = consensusView({ asOf: "2026-11-01", targetMean: 200, targetMedian: null, currency: "USD" }, { price: 6000, priceCurrency: "THB", today: "2026-11-18" });
    expect(x.upside).toBeNull();
    expect(x.warnings.join()).toMatch(/USD/);
    expect(consensusView({ asOf: "2026-11-01", targetMean: 20, targetMedian: null, currency: "THB" }, { price: null, today: "2026-11-18" }).upside).toBeNull();
  });
});
