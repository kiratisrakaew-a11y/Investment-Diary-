/**
 * Strategies Phase 1 — screening, scoring and weighting.
 */
import { describe, expect, it } from "vitest";
import { dividendProfile, type DividendEventInput, type FundamentalsYear } from "./dividend-metrics";
import { capWeights, percentileRanks, resolveSettings, screenDividendStrategy, type Candidate } from "./dividend-strategies";

const ev = (exDate: string, dps: number, kind: DividendEventInput["kind"] = "regular"): DividendEventInput => ({
  symbol: "X",
  exDate,
  paymentDate: null,
  announcedAt: null,
  dividendPerShare: dps,
  currency: "THB",
  cashOrStock: "cash",
  kind,
  splitAdjustmentPolicy: "as_reported",
  withholdingTaxRate: null,
  source: "test",
});
const years = (dps: number[], eps: number, extra: Partial<FundamentalsYear> = {}): FundamentalsYear[] =>
  dps.map((d, i) => ({ fiscalYear: 2019 + i, dps: d, eps, cfo: 120, capex: 40, dividendsPaid: 32, netIncome: 100, totalEquity: 800, totalDebt: 200, cash: 50, ebitda: 150, ebit: 120, interestExpense: 10, ...extra }));

function cand(symbol: string, o: { price: number; dps: number[]; eps?: number; issuer?: string; sector?: string; extra?: Partial<FundamentalsYear> }): Candidate {
  const events = o.dps.map((d, i) => ev(`${2019 + i}-05-01`, d));
  return {
    symbol,
    issuer: o.issuer ?? symbol,
    sector: o.sector ?? null,
    profile: dividendProfile({ symbol, asOf: "2024-12-31", price: o.price, priceCurrency: "THB", events, splits: [], statements: years(o.dps, o.eps ?? 8, o.extra), sector: o.sector }),
  };
}

const universe = [
  cand("AAA", { price: 100, dps: [3, 3, 3.2, 3.4, 3.6, 4] }),
  cand("BBB", { price: 50, dps: [1, 1.1, 1.2, 1.4, 1.6, 2] }),
  cand("CCC", { price: 80, dps: [2, 2, 2, 2, 2, 2], eps: 2.1 }),
  cand("DDD", { price: 40, dps: [0, 0, 1, 1, 1, 1] }),
  cand("EEE", { price: 30, dps: [1, 1, 1, 1, 1, 1], eps: -1 }),
];

describe("dividend screening", () => {
  it("is deterministic and explains every exclusion", () => {
    const a = screenDividendStrategy({ strategyId: "dividend_sustainable_income", asOf: "2024-12-31", candidates: universe });
    const b = screenDividendStrategy({ strategyId: "dividend_sustainable_income", asOf: "2024-12-31", candidates: [...universe].reverse() });
    expect(a.selected).toEqual(b.selected);
    expect(a.scores).toEqual(b.scores);
    const code = (s: string) => a.excluded.find((e) => e.symbol === s)?.code;
    expect(code("CCC")).toBe("payout_above_max"); // 2/2.1 = 95% > 80%
    expect(code("EEE")).toBe("payout_not_meaningful"); // EPS < 0 is not an attractive payout
    expect(a.selected).toContain("AAA");
    expect(a.strategyVersion).toBe("1.0.0");
    // Contributions add up to the score.
    for (const r of a.ranked) expect(r.factors.reduce((s, f) => s + (f.contribution ?? 0), 0)).toBeCloseTo(r.score, 12);
  });
  it("growth preset ranks the faster DPS grower first", () => {
    const g = screenDividendStrategy({ strategyId: "dividend_growth", asOf: "2024-12-31", candidates: universe });
    expect(g.ranked[0].symbol).toBe("BBB");
    expect(g.excluded.find((e) => e.symbol === "DDD")?.code).toMatch(/insufficient_data|dps_cagr|below_min/);
  });
  it("missing required factor → insufficient_data, never selected", () => {
    const noDiv = { ...cand("ZZZ", { price: 10, dps: [1] }), profile: dividendProfile({ symbol: "ZZZ", asOf: "2024-12-31", price: 10, priceCurrency: "THB", events: [], splits: [], statements: [] }) };
    const r = screenDividendStrategy({ strategyId: "dividend_sustainable_income", asOf: "2024-12-31", candidates: [noDiv], settings: { filters: {} } });
    expect(r.selected).toEqual([]);
    expect(r.excluded[0].code).toBe("no_dividend_history");
    expect(r.sourceStatus).toBe("insufficient");
  });
  it("editable thresholds and weights; equal vs score weighting; cash reserve", () => {
    const loose = { filters: { maxEarningsPayout: null, minConsecutiveYears: null, excludeNegativeFcf: false, maxFcfPayout: null }, maxPerIssuer: null, maxWeight: 1 };
    const eq = screenDividendStrategy({ strategyId: "dividend_sustainable_income", asOf: "2024-12-31", candidates: universe, settings: { ...loose, topN: 3, cashReserve: 0.1 } });
    expect(Object.values(eq.targetWeights).reduce((a, b) => a + b, 0)).toBeCloseTo(0.9, 12);
    expect(new Set(Object.values(eq.targetWeights).map((v) => v.toFixed(9))).size).toBe(1);
    const sc = screenDividendStrategy({ strategyId: "dividend_sustainable_income", asOf: "2024-12-31", candidates: universe, settings: { ...loose, topN: 3, weighting: "score" } });
    const w = sc.selected.map((s) => sc.targetWeights[s]);
    expect(w[0]).toBeGreaterThanOrEqual(w[2]);
    expect(resolveSettings("dividend_growth", { topN: 7 }).topN).toBe(7);
  });
  it("issuer cap: two lines of one issuer share the cap; the rest goes to others or cash", () => {
    const u = [cand("A1", { price: 100, dps: [3, 3, 3, 3, 3, 3], issuer: "ACME" }), cand("A2", { price: 100, dps: [3, 3, 3, 3, 3, 3], issuer: "ACME" }), cand("B1", { price: 100, dps: [3, 3, 3, 3, 3, 3], issuer: "BETA" })];
    const r = screenDividendStrategy({ strategyId: "dividend_sustainable_income", asOf: "2024-12-31", candidates: u, settings: { maxPerIssuer: 0.4, maxWeight: 1 } });
    expect(r.targetWeights.A1 + r.targetWeights.A2).toBeCloseTo(0.4, 9);
    expect(r.targetWeights.B1).toBeCloseTo(0.4, 9);
    expect(r.diagnostics.join()).toMatch(/เงินสด/);
  });
  it("minimum liquidity is reported as unsupported, not applied", () => {
    const r = screenDividendStrategy({ strategyId: "dividend_growth", asOf: "2024-12-31", candidates: universe, settings: { filters: { minLiquidityThb: 1e6 } } });
    expect(r.diagnostics.join()).toMatch(/ไม่รองรับ/);
  });
});

describe("helpers", () => {
  it("percentile ranks with ties", () => {
    expect(percentileRanks([3, 1, 2])).toEqual([1, 0, 0.5]);
    expect(percentileRanks([1, 1, 2])).toEqual([0.25, 0.25, 1]);
    expect(percentileRanks([5])).toEqual([0.5]);
  });
  it("capWeights redistributes to uncapped names", () => {
    const r = capWeights({ a: 0.5, b: 0.3, c: 0.2 }, { maxWeight: 0.4, groups: [] });
    expect(r.weights.a).toBeCloseTo(0.4, 12);
    expect(r.weights.b + r.weights.c).toBeCloseTo(0.6, 12);
    expect(r.unallocated).toBeCloseTo(0, 9);
  });
});
