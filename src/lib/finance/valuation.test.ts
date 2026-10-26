import { describe, expect, it } from "vitest";
import { DEFAULT_DCF, dcf, dcfAtRate, gordonGrowth, impliedGrowth, justifiedPBV, justifiedPE, residualIncome, twoStageDdm, hModel, costOfEquity, wacc, leverBeta, unleverBeta } from "./valuation";
import { analyticsFromYield, yieldFromPrice, analyticsFromPrice, discountBillPrice, discountBillYield, priceChangeApprox } from "./bonds";
import { analyticFrontier, projectBoxSimplex, constrainedTargetReturn, constrainedMaxSharpe, completePortfolio, invert, constrainedFrontier } from "./optimizer";
import { portfolioStats } from "./mpt";

describe("discount rates", () => {
  it("CAPM, WACC and Hamada", () => {
    expect(costOfEquity(0.025, 1.2, 0.07)).toBeCloseTo(0.109);
    expect(wacc(0.1, 0.05, 0.2, 600, 400)).toBeCloseTo(0.6 * 0.1 + 0.4 * 0.04);
    const bu = unleverBeta(1.3, 0.5, 0.2);
    expect(leverBeta(bu, 0.5, 0.2)).toBeCloseTo(1.3);
  });
});

describe("DCF", () => {
  // No growth, capex = D&A, no NWC → constant FCFF 150; WACC = Ke = 10% → EV = 1,500.
  const flat = {
    ...DEFAULT_DCF,
    revenue0: 1000,
    years: 5,
    growthStart: 0,
    growthEnd: 0,
    terminalGrowth: 0,
    ebitMarginStart: 0.2,
    ebitMarginEnd: 0.2,
    taxRate: 0.25,
    daPct: 0.05,
    capexPct: 0.05,
    nwcPct: 0,
    debt: 0,
    cash: 100,
    otherClaims: 0,
    sharesOutstanding: 100,
    currentPrice: 12,
    riskFree: 0.02,
    beta: 1,
    equityRiskPremium: 0.08,
    extraPremium: 0,
    costOfDebt: 0.05,
    targetDebtWeight: 0,
    debtFinancingRatio: 0,
  };
  it("FCFF perpetuity equals FCFF / WACC", () => {
    const r = dcf(flat, "fcff");
    expect(r.wacc).toBeCloseTo(0.1);
    expect(r.years[0].fcff).toBeCloseTo(150);
    expect(r.enterpriseValue!).toBeCloseTo(1500, 6);
    expect(r.valuePerShare).toBeCloseTo(16, 6);
    expect(r.upside!).toBeCloseTo(16 / 12 - 1);
  });
  it("FCFE equals FCFF for an unlevered firm", () => {
    expect(dcf(flat, "fcfe").valuePerShare).toBeCloseTo(16, 6);
  });
  it("Gordon terminal value uses next-year cash flow", () => {
    const g = { ...flat, growthStart: 0.03, growthEnd: 0.03, terminalGrowth: 0.03, nwcPct: 0 };
    const r = dcf(g, "fcff");
    const last = r.years[r.years.length - 1].fcff;
    expect(r.terminalValue).toBeCloseTo((last * 1.03) / (0.1 - 0.03));
  });
  it("reverse DCF recovers the growth that prices the stock", () => {
    // Fixed target capital structure so the discount rate does not depend on the price.
    const a = { ...DEFAULT_DCF, growthStart: 0.05, growthEnd: 0.05, targetDebtWeight: 0.3 };
    const price = dcfAtRate(a, "fcff", dcf(a, "fcff").discountRate)!;
    const g = impliedGrowth({ ...a, currentPrice: price }, "fcff")!;
    expect(g).toBeCloseTo(0.05, 4);
  });
  it("warns when r <= g", () => {
    const r = dcf({ ...flat, terminalGrowth: 0.12 }, "fcff");
    expect(r.errors.map((e) => e.code)).toContain("RATE_NOT_ABOVE_GROWTH");
    expect(r.valuePerShare).toBeNull();
  });
});

describe("dividend & residual income models", () => {
  it("Gordon growth", () => expect(gordonGrowth(1, 0.1, 0.05)).toBeCloseTo(21));
  it("two-stage reduces to Gordon when g1 = g2", () => expect(twoStageDdm(1, 0.1, 0.05, 5, 0.05).value).toBeCloseTo(21));
  it("H-model reduces to Gordon when gS = gL", () => expect(hModel(1, 0.1, 0.05, 0.05, 3)).toBeCloseTo(21));
  it("justified multiples", () => {
    expect(justifiedPBV(0.1, 0.1, 0.03)).toBeCloseTo(1);
    expect(justifiedPE(0.5, 0.1, 0.05)).toBeCloseTo(10.5);
    expect(residualIncome(10, 0.15, 0.1, 0.05)).toBeCloseTo(20);
  });
});

describe("bonds", () => {
  const b = { settlement: "2026-01-15", maturity: "2036-01-15", couponRate: 0.05, frequency: 2 as const };
  it("prices at par when yield = coupon", () => {
    expect(analyticsFromYield(b, 0.05).cleanPrice).toBeCloseTo(100, 8);
  });
  it("10y 5% semi-annual at 6% = 92.5613", () => {
    expect(analyticsFromYield(b, 0.06).cleanPrice).toBeCloseTo(92.5613, 3);
  });
  it("duration and convexity of a par bond", () => {
    const a = analyticsFromYield(b, 0.05);
    expect(a.macaulayDuration).toBeCloseTo(7.9894, 3);
    expect(a.modifiedDuration).toBeCloseTo(7.7946, 3);
    // Duration + convexity approximation is close to the exact repricing for +100bp.
    const exact = analyticsFromYield(b, 0.06).cleanPrice / 100 - 1;
    expect(priceChangeApprox(a.modifiedDuration, a.convexity, 0.01)).toBeCloseTo(exact, 3);
  });
  it("yield round-trips between coupon dates", () => {
    const mid = { ...b, settlement: "2026-04-01" };
    const a = analyticsFromYield(mid, 0.0437);
    expect(a.accruedInterest).toBeGreaterThan(0);
    expect(yieldFromPrice(mid, a.cleanPrice)).toBeCloseTo(0.0437, 8);
    expect(analyticsFromPrice(mid, a.cleanPrice).dirtyPrice).toBeCloseTo(a.dirtyPrice, 6);
  });
  it("T-bill simple yield", () => {
    const p = discountBillPrice(100, 0.02, 91);
    expect(discountBillYield(100, p, 91)).toBeCloseTo(0.02);
  });
});

describe("optimizer", () => {
  const mu = [0.1, 0.06, 0.08];
  const cov = [
    [0.04, 0.006, 0.01],
    [0.006, 0.01, 0.004],
    [0.01, 0.004, 0.0225],
  ];
  it("inverts a matrix", () => {
    const inv = invert(cov)!;
    const id = cov.map((r) => inv[0].map((_, j) => r.reduce((s, x, k) => s + x * inv[k][j], 0)));
    id.forEach((row, i) => row.forEach((x, j) => expect(x).toBeCloseTo(i === j ? 1 : 0, 9)));
  });
  it("closed-form frontier weights hit the target return", () => {
    const f = analyticFrontier(mu, cov, 0.02)!;
    const w = f.weightsFor(0.12);
    expect(w.reduce((a, b) => a + b)).toBeCloseTo(1);
    expect(w.reduce((s, x, i) => s + x * mu[i], 0)).toBeCloseTo(0.12);
    // σ² from the hyperbola equals wᵀΣw
    const v = (f.A * 0.12 ** 2 - 2 * f.B * 0.12 + f.C) / f.D;
    expect(portfolioStats(w, mu, cov, 0.02).volatility ** 2).toBeCloseTo(v, 6);
    // bullet has both efficient and inefficient halves
    expect(f.curve.some((p) => !p.efficient)).toBe(true);
  });
  it("unconstrained tangency beats every frontier point on Sharpe", () => {
    const f = analyticFrontier(mu, cov, 0.02)!;
    for (const m of [0.07, 0.09, 0.11, 0.13]) {
      expect(f.tangency!.sharpe!).toBeGreaterThanOrEqual(portfolioStats(f.weightsFor(m), mu, cov, 0.02).sharpe! - 1e-9);
    }
  });
  it("box projection respects bounds", () => {
    const w = projectBoxSimplex([0.9, 0.5, -0.3, 0.2], { min: 0, max: 0.4 });
    expect(w.reduce((a, b) => a + b)).toBeCloseTo(1);
    w.forEach((x) => {
      expect(x).toBeGreaterThanOrEqual(-1e-12);
      expect(x).toBeLessThanOrEqual(0.4 + 1e-12);
    });
  });
  it("constrained target return is met and long-only", () => {
    const w = constrainedTargetReturn(mu, cov, 0.085, { min: 0, max: 1 });
    expect(w.reduce((s, x, i) => s + x * mu[i], 0)).toBeCloseTo(0.085, 4);
    w.forEach((x) => expect(x).toBeGreaterThanOrEqual(0));
  });
  it("long-only max Sharpe matches unconstrained when tangency is long-only", () => {
    const f = analyticFrontier(mu, cov, 0.02)!;
    expect(f.tangency!.weights.every((x) => x >= 0)).toBe(true);
    const c = constrainedMaxSharpe(mu, cov, 0.02, { min: 0, max: 1 });
    expect(c.sharpe!).toBeCloseTo(f.tangency!.sharpe!, 3);
  });
  it("constrained bullet curve has both halves", () => {
    const f = constrainedFrontier(mu, cov, 0.02, { min: 0, max: 1 }, 15);
    expect(f.curve.some((p) => p.efficient) && f.curve.some((p) => !p.efficient)).toBe(true);
  });
  it("complete portfolio y* = (E − Rf)/(Aσ²)", () => {
    const t = { weights: [], expectedReturn: 0.1, volatility: 0.2, sharpe: 0.4 };
    expect(completePortfolio(t, 0.02, 4).riskyShare).toBeCloseTo(0.5);
  });
});

describe("DCF sensitivity", () => {
  it("centre cell equals the base valuation", () => {
    const s = dcfSensitivityCheck();
    expect(s.center!).toBeCloseTo(s.base!, 8);
    expect(s.higherRateLower).toBe(true);
  });
});

import { dcfSensitivity } from "./valuation";
function dcfSensitivityCheck() {
  const a = { ...DEFAULT_DCF, targetDebtWeight: 0.3 };
  const s = dcfSensitivity(a, "fcff");
  return { center: s.grid[2][2], base: dcf(a, "fcff").valuePerShare, higherRateLower: s.grid[4][2]! < s.grid[0][2]! };
}

describe("bond current yield", () => {
  it("is annual coupon / clean price as a decimal", () => {
    const a = analyticsFromYield({ settlement: "2026-01-15", maturity: "2031-01-15", couponRate: 0.03, frequency: 2 }, 0.03);
    expect(a.currentYield).toBeCloseTo(0.03, 6);
  });
});
