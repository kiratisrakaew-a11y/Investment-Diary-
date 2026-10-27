/**
 * Strategies Phase 1 — dividend metric acceptance tests (spec §4.7), hand-worked values.
 */
import { describe, expect, it } from "vitest";
import {
  annualDpsSeries,
  dividendConsistency,
  dividendCoverage,
  dividendProfile,
  dpsCagr,
  dpsLatestBasis,
  earningsPayout,
  eventsKnownBy,
  fcfPayout,
  forwardIndicatedYield,
  minusMonths,
  qualityMetrics,
  ttmDividendYield,
  yieldVsHistory,
  type DividendEventInput,
} from "./dividend-metrics";

const ev = (p: Partial<DividendEventInput> & { exDate: string | null; dividendPerShare: number }): DividendEventInput => ({
  symbol: "X",
  paymentDate: null,
  announcedAt: null,
  currency: "THB",
  cashOrStock: "cash",
  kind: "regular",
  splitAdjustmentPolicy: "as_reported",
  withholdingTaxRate: null,
  source: "test",
  ...p,
});

describe("TTM yield", () => {
  it("4 THB over 12 months at 100 THB = 4%", () => {
    const r = ttmDividendYield({ events: [ev({ exDate: "2025-04-20", dividendPerShare: 1.5 }), ev({ exDate: "2025-09-01", dividendPerShare: 2.5 }), ev({ exDate: "2024-03-01", dividendPerShare: 9 })], splits: [], asOf: "2025-12-31", price: 100, priceCurrency: "THB" });
    expect(r.total.value).toBeCloseTo(0.04, 12);
    expect(r.total.status).toBe("available");
    expect(r.total.observations).toBe(2);
  });
  it("window is (asOf − 12m, asOf]: an ex-date exactly 12 months earlier is excluded", () => {
    expect(minusMonths("2025-12-31", 12)).toBe("2024-12-31");
    expect(minusMonths("2024-03-31", 1)).toBe("2024-02-29");
    const r = ttmDividendYield({ events: [ev({ exDate: "2024-12-31", dividendPerShare: 4 }), ev({ exDate: "2025-12-31", dividendPerShare: 1 })], splits: [], asOf: "2025-12-31", price: 100, priceCurrency: "THB" });
    expect(r.total.value).toBeCloseTo(0.01, 12);
  });
  it("split: an as-reported 4 THB before a 1→2 split becomes 2 THB; yield continuous (4% → 2/50)", () => {
    const e = ev({ exDate: "2025-03-01", dividendPerShare: 4 });
    const splits = [{ date: "2025-06-01", ratio: 2 }];
    expect(dpsLatestBasis(e, splits)).toBe(2);
    // Before the split: price 100 on old basis = 50 on the latest basis stored in prices.
    const before = ttmDividendYield({ events: [e], splits, asOf: "2025-05-30", price: 50, priceCurrency: "THB" });
    const after = ttmDividendYield({ events: [e], splits, asOf: "2025-06-02", price: 50, priceCurrency: "THB" });
    expect(before.total.value).toBeCloseTo(0.04, 12);
    expect(after.total.value).toBeCloseTo(0.04, 12);
    // Provider amounts already on the latest basis are not adjusted again.
    expect(dpsLatestBasis({ ...e, splitAdjustmentPolicy: "provider_split_adjusted" }, splits)).toBe(4);
  });
  it("special dividend toggle changes total yield; regular yield is stable", () => {
    const events = [ev({ exDate: "2025-05-01", dividendPerShare: 3 }), ev({ exDate: "2025-10-01", dividendPerShare: 2, kind: "special" })];
    const inc = ttmDividendYield({ events, splits: [], asOf: "2025-12-31", price: 100, priceCurrency: "THB", includeSpecial: true });
    const exc = ttmDividendYield({ events, splits: [], asOf: "2025-12-31", price: 100, priceCurrency: "THB", includeSpecial: false });
    expect(inc.total.value).toBeCloseTo(0.05, 12);
    expect(exc.total.value).toBeCloseTo(0.03, 12);
    expect(inc.regular.value).toBe(exc.regular.value);
    expect(inc.regular.value).toBeCloseTo(0.03, 12);
  });
  it("missing price or currency mismatch → unavailable (never 0); stock dividends not counted as cash", () => {
    expect(ttmDividendYield({ events: [ev({ exDate: "2025-05-01", dividendPerShare: 3 })], splits: [], asOf: "2025-12-31", price: null, priceCurrency: "THB" }).total.status).toBe("unavailable");
    expect(ttmDividendYield({ events: [ev({ exDate: "2025-05-01", dividendPerShare: 3, currency: "USD" })], splits: [], asOf: "2025-12-31", price: 10, priceCurrency: "THB" }).total.value).toBeNull();
    const s = ttmDividendYield({ events: [ev({ exDate: "2025-05-01", dividendPerShare: 3, cashOrStock: "stock" })], splits: [], asOf: "2025-12-31", price: 100, priceCurrency: "THB" });
    expect(s.total.value).toBe(0);
    expect(s.total.warnings.join()).toMatch(/หุ้น/);
  });
});

describe("forward yield", () => {
  it("unavailable when only past declared dividends exist", () => {
    const r = forwardIndicatedYield({ events: [ev({ exDate: "2025-05-01", dividendPerShare: 3 })], splits: [], asOf: "2025-12-31", price: 100 });
    expect(r.status).toBe("unavailable");
    expect(r.value).toBeNull();
  });
  it("from an announced annual rate only, labelled as a forecast", () => {
    const r = forwardIndicatedYield({ events: [ev({ exDate: null, dividendPerShare: 5, kind: "indicated_annual", announcedAt: "2025-11-01" })], splits: [], asOf: "2025-12-31", price: 100 });
    expect(r.value).toBeCloseTo(0.05, 12);
    expect(r.methodology).toMatch(/คาดการณ์/);
    // Not known yet before its announcement.
    expect(forwardIndicatedYield({ events: [ev({ exDate: null, dividendPerShare: 5, kind: "indicated_annual", announcedAt: "2026-01-05" })], splits: [], asOf: "2025-12-31", price: 100 }).status).toBe("unavailable");
  });
});

describe("payout and coverage", () => {
  it("payout 4/8 = 50%; EPS 0 or negative → not_meaningful", () => {
    expect(earningsPayout([{ fiscalYear: 2024, eps: 8, dps: 4 }], "2025-06-30").value).toBeCloseTo(0.5, 12);
    expect(earningsPayout([{ fiscalYear: 2024, eps: 0, dps: 4 }], "2025-06-30").status).toBe("not_meaningful");
    const neg = earningsPayout([{ fiscalYear: 2024, eps: -2, dps: 1 }], "2025-06-30");
    expect(neg.status).toBe("not_meaningful");
    expect(neg.value).toBeNull();
  });
  it("FCF = 120 − 40 = 80; dividends 32 → FCF payout 40%; FCF ≤ 0 → not_meaningful with a risk flag", () => {
    expect(fcfPayout([{ fiscalYear: 2024, cfo: 120, capex: 40, dividendsPaid: 32 }], "2025-06-30").value).toBeCloseTo(0.4, 12);
    const bad = fcfPayout([{ fiscalYear: 2024, cfo: 30, capex: 40, dividendsPaid: 32 }], "2025-06-30");
    expect(bad.status).toBe("not_meaningful");
    expect(bad.warnings.join()).toMatch(/ความเสี่ยง/);
    const cov = dividendCoverage([{ fiscalYear: 2024, eps: 8, dps: 4, cfo: 120, capex: 40, dividendsPaid: 32 }], "2025-06-30");
    expect(cov.earnings.value).toBeCloseTo(2, 12);
    expect(cov.fcf.value).toBeCloseTo(2.5, 12);
  });
  it("missing fields are unavailable, not zero", () => {
    const r = fcfPayout([{ fiscalYear: 2024, cfo: 120, capex: null, dividendsPaid: 32 }], "2025-06-30");
    expect(r.status).toBe("unavailable");
    expect(r.value).toBeNull();
    expect(earningsPayout([], "2025-06-30").status).toBe("unavailable");
    expect(qualityMetrics([{ fiscalYear: 2024, netIncome: 10 }], "2025-06-30").roe.status).toBe("unavailable");
  });
});

describe("DPS growth and consistency", () => {
  it("CAGR 2 → 3.2 over 5 years = (3.2/2)^(1/5) − 1, not a simple average", () => {
    const series = [2, 2.2, 2.5, 2.7, 3, 3.2].map((dps, i) => ({ year: 2019 + i, dps }));
    const r = dpsCagr(series, 5, "2025-06-30");
    expect(r.value).toBeCloseTo((3.2 / 2) ** (1 / 5) - 1, 12);
    expect(r.value).not.toBeCloseTo((3.2 / 2 - 1) / 5, 4);
    expect(dpsCagr(series, 10, "2025-06-30").status).toBe("insufficient");
    expect(dpsCagr([{ year: 2020, dps: 0 }, { year: 2023, dps: 1 }], 3, "2025-06-30").status).toBe("not_meaningful");
  });
  it("consistency: consecutive positive years, cuts and missed years", () => {
    const c = dividendConsistency([1, 1.2, 0, 1, 0.9, 1.1].map((dps, i) => ({ year: 2019 + i, dps })), "2025-06-30");
    expect(c.consecutiveYears.value).toBe(3);
    expect(c.missedYears).toBe(1);
    expect(c.cuts).toBe(2);
  });
  it("annual series from events: complete calendar years, gaps inside history are zero, special excluded", () => {
    const events = [ev({ exDate: "2021-05-01", dividendPerShare: 1 }), ev({ exDate: "2023-05-01", dividendPerShare: 1.2 }), ev({ exDate: "2023-09-01", dividendPerShare: 5, kind: "special" }), ev({ exDate: "2025-03-01", dividendPerShare: 2 })];
    const a = annualDpsSeries({ statements: [], events, splits: [], asOf: "2025-06-30" });
    expect(a.source).toBe("events");
    expect(a.series).toEqual([{ year: 2021, dps: 1 }, { year: 2022, dps: 0 }, { year: 2023, dps: 1.2 }, { year: 2024, dps: 0 }]);
  });
});

describe("point-in-time and yield history", () => {
  it("events known by a cutoff: past ex-dates, or announced in advance", () => {
    const es = [ev({ exDate: "2025-05-01", dividendPerShare: 1 }), ev({ exDate: "2025-08-01", dividendPerShare: 1, announcedAt: "2025-06-15" }), ev({ exDate: "2025-08-01", dividendPerShare: 1 })];
    expect(eventsKnownBy(es, "2025-07-01")).toHaveLength(2);
  });
  it("a yield that is high only because the price collapsed is flagged, not rewarded", () => {
    const prices: [string, number][] = [];
    const events: DividendEventInput[] = [];
    for (let y = 2018; y <= 2025; y++) {
      for (let m = 1; m <= 12; m++) prices.push([`${y}-${String(m).padStart(2, "0")}-15`, y === 2025 && m >= 6 ? 50 : 100]);
      events.push(ev({ exDate: `${y}-04-01`, dividendPerShare: 4 }));
    }
    const r = yieldVsHistory({ events, splits: [], asOf: "2025-12-31", prices, priceCurrency: "THB" });
    expect(r.status).toBe("available");
    expect(r.value!).toBeGreaterThan(0.9);
    expect(r.priceDropFlag).toBe(true);
  });
  it("banks: industrial leverage and FCF ratios are not_meaningful", () => {
    const p = dividendProfile({ symbol: "BANK", asOf: "2025-06-30", price: 100, priceCurrency: "THB", events: [], splits: [], statements: [{ fiscalYear: 2024, totalDebt: 500, cash: 10, ebitda: 50, cfo: 10, capex: 1, dividendsPaid: 5 }], sector: "Banking" });
    expect(p.quality.netDebtToEbitda.status).toBe("not_meaningful");
    expect(p.fcfPayout.status).toBe("not_meaningful");
    expect(p.totalShareholderYield.status).toBe("unsupported");
  });
});
