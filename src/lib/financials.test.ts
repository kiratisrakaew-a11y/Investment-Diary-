import { describe, expect, it } from "vitest";
import { assumptionsFromHistory, completeYear, deriveRatios, emptyYear, mergeYears, revenueCagr, scaleYear, type FinancialYear } from "./financials";

function year(fy: number, revenue: number, extra: Partial<FinancialYear> = {}): FinancialYear {
  return {
    ...emptyYear(fy),
    revenue,
    ebit: revenue * 0.1,
    depreciation: revenue * 0.04,
    capex: revenue * 0.05,
    pretaxIncome: revenue * 0.09,
    incomeTax: revenue * 0.018,
    interestExpense: revenue * 0.01,
    netIncome: revenue * 0.072,
    currentAssets: revenue * 0.3,
    cash: revenue * 0.1,
    currentLiabilities: revenue * 0.1,
    totalDebt: 200,
    totalEquity: 1000,
    sharesOutstanding: 100,
    dps: 0.5,
    eps: (revenue * 0.072) / 100,
    ...extra,
  };
}

const hist = [year(2020, 1000), year(2021, 1100), year(2022, 1210), year(2023, 1331), year(2024, 1464.1)];

describe("financial statements", () => {
  it("scales source units to millions but not per-share items", () => {
    const y = scaleYear({ ...emptyYear(2024), revenue: 5_000_000, eps: 1.25, sharesOutstanding: 2_000_000_000 }, 0.001, 1e-6);
    expect(y.revenue).toBe(5000);
    expect(y.eps).toBe(1.25);
    expect(y.sharesOutstanding).toBe(2000);
  });

  it("merges years: incoming wins, gaps are filled", () => {
    const a = [{ ...emptyYear(2023), revenue: 100, netIncome: 10 }];
    const b = [{ ...emptyYear(2023), revenue: 105 }, { ...emptyYear(2024), revenue: 120 }];
    const m = mergeYears(a, b);
    expect(m.map((y) => y.fiscalYear)).toEqual([2023, 2024]);
    expect(m[0].revenue).toBe(105);
    expect(m[0].netIncome).toBe(10);
    expect(mergeYears(a, b, false)[0].revenue).toBe(100);
  });

  it("completes identities", () => {
    const y = completeYear({ ...emptyYear(2024), revenue: 100, cogs: 60, pretaxIncome: 18, interestExpense: 2, depreciation: 5 });
    expect(y.grossProfit).toBe(40);
    expect(y.ebit).toBe(20);
    expect(y.ebitda).toBe(25);
  });

  it("derives ratios and CAGR", () => {
    const r = deriveRatios(hist);
    expect(r[1].revenueGrowth).toBeCloseTo(0.1);
    expect(r[4].ebitMargin).toBeCloseTo(0.1);
    expect(r[4].capexPct).toBeCloseTo(0.05);
    expect(r[4].nwcPct).toBeCloseTo(0.1);
    expect(r[4].effectiveTax).toBeCloseTo(0.2);
    expect(revenueCagr(hist)).toBeCloseTo(0.1, 6);
  });

  it("builds valuation assumptions from 5 years", () => {
    const a = assumptionsFromHistory(hist, 0.03);
    expect(a.dcf.revenue0).toBeCloseTo(1464.1);
    expect(a.dcf.growthStart).toBeCloseTo(0.1, 6);
    expect(a.dcf.growthEnd).toBeCloseTo(0.065, 6);
    expect(a.dcf.ebitMarginStart).toBeCloseTo(0.1);
    expect(a.dcf.taxRate).toBeCloseTo(0.2);
    expect(a.dcf.daPct).toBeCloseTo(0.04);
    expect(a.dcf.capexPct).toBeCloseTo(0.05);
    expect(a.dcf.debt).toBe(200);
    expect(a.dcf.sharesOutstanding).toBe(100);
    expect(a.ddm.d0).toBe(0.5);
    expect(a.ri.bookValuePerShare).toBe(10);
    expect(a.explanations.length).toBeGreaterThan(5);
  });

  it("clamps extreme growth", () => {
    const wild = [year(2022, 100), year(2024, 1000)];
    expect(assumptionsFromHistory(wild).dcf.growthStart).toBe(0.3);
  });
});
