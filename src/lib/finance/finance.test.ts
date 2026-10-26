import { describe, expect, it } from "vitest";
import { xirr, twrDailyReturns, linkReturns, annualizeReturn } from "./returns";
import { annualVolatility, beta, maxDrawdown, historicalVaR, downsideDeviation } from "./risk";
import { sharpe, sortino, treynor, jensenAlpha, capmExpectedReturn, riskPremium } from "./ratios";
import { minVariancePortfolio, maxSharpePortfolio, projectToSimplex, efficientFrontier, portfolioStats } from "./mpt";
import { computeAllocation } from "./allocation";
import { buildSnapshot, buildValueSeries, investorCashFlows, type AssetInput, type TxInput } from "./portfolio";
import { stdev } from "./stats";

describe("returns", () => {
  it("XIRR matches the Microsoft Excel documentation example (37.34%)", () => {
    const r = xirr([
      { date: "2008-01-01", amount: -10000 },
      { date: "2008-03-01", amount: 2750 },
      { date: "2008-10-30", amount: 4250 },
      { date: "2009-02-15", amount: 3250 },
      { date: "2009-04-01", amount: 2750 },
    ]);
    expect(r).toBeCloseTo(0.373362535, 6);
  });

  it("XIRR of a simple one-year 10% gain is 10%", () => {
    expect(xirr([{ date: "2023-01-01", amount: -100 }, { date: "2024-01-01", amount: 110 }])).toBeCloseTo(0.1, 2);
  });

  it("TWR removes the effect of deposits", () => {
    const rs = twrDailyReturns([
      { date: "d0", value: 100, flow: 100 },
      { date: "d1", value: 110, flow: 0 },
      { date: "d2", value: 1110, flow: 1000 }, // deposit 1000, no market move
      { date: "d3", value: 1221, flow: 0 }, // +10%
    ]).map((x) => x.r);
    expect(rs[0]).toBeCloseTo(0.1);
    expect(rs[1]).toBeCloseTo(0);
    expect(linkReturns(rs)).toBeCloseTo(0.21);
  });

  it("annualizes only periods of at least a year", () => {
    expect(annualizeReturn(0.05, 152).annualized).toBeNull();
    expect(annualizeReturn(0.21, 730).annualized!).toBeCloseTo(0.1, 2);
  });
});

describe("risk", () => {
  it("annualizes volatility with sqrt(252)", () => {
    const rs = [0.01, -0.01, 0.02, -0.02];
    expect(annualVolatility(rs)).toBeCloseTo(stdev(rs) * Math.sqrt(252));
  });
  it("beta of a 2x levered market is 2", () => {
    const m = [0.01, -0.02, 0.015, 0.003, -0.007];
    expect(beta(m.map((x) => 2 * x), m)).toBeCloseTo(2);
  });
  it("max drawdown", () => {
    expect(maxDrawdown([100, 120, 90, 130, 104]).maxDrawdown).toBeCloseTo(0.25);
  });
  it("historical VaR 95%", () => {
    const rs = Array.from({ length: 101 }, (_, i) => (i - 50) / 1000); // -5%..+5%
    expect(historicalVaR(rs, 0.95)).toBeCloseTo(0.045);
  });
  it("downside deviation ignores gains", () => {
    expect(downsideDeviation([0.01, 0.02, 0.03], 0, 1)).toBe(0);
  });
});

describe("ratios (CAPM)", () => {
  it("Sharpe, Sortino, Treynor", () => {
    expect(sharpe(0.12, 0.02, 0.2)).toBeCloseTo(0.5);
    expect(sortino(0.12, 0.02, 0.1)).toBeCloseTo(1);
    expect(treynor(0.12, 0.02, 1.25)).toBeCloseTo(0.08);
    expect(riskPremium(0.12, 0.02)).toBeCloseTo(0.1);
  });
  it("Jensen alpha = Rp − [Rf + β(Rm − Rf)]", () => {
    expect(capmExpectedReturn(0.02, 1.2, 0.08)).toBeCloseTo(0.092);
    expect(jensenAlpha(0.1, 0.02, 1.2, 0.08)).toBeCloseTo(0.008);
  });
});

describe("modern portfolio theory", () => {
  const cov = [
    [0.04, 0],
    [0, 0.01],
  ];
  const mu = [0.1, 0.06];
  it("projects onto the simplex", () => {
    const w = projectToSimplex([0.8, 0.8, -0.5]);
    expect(w.reduce((a, b) => a + b)).toBeCloseTo(1);
    expect(w[2]).toBe(0);
  });
  it("min-variance weights match the two-asset closed form", () => {
    // w1 = σ2² / (σ1² + σ2²) for uncorrelated assets = 0.2
    const p = minVariancePortfolio(mu, cov, 0.02);
    expect(p.weights[0]).toBeCloseTo(0.2, 3);
  });
  it("tangency portfolio matches w ∝ Σ⁻¹(μ − Rf)", () => {
    // excess = [0.08, 0.04]; Σ⁻¹·excess = [2, 4] → [1/3, 2/3]
    const p = maxSharpePortfolio(mu, cov, 0.02);
    expect(p.weights[0]).toBeCloseTo(1 / 3, 2);
    const s = portfolioStats([1 / 3, 2 / 3], mu, cov, 0.02).sharpe!;
    expect(p.sharpe!).toBeCloseTo(s, 4);
  });
  it("frontier is increasing in risk and return", () => {
    const f = efficientFrontier(mu, cov, 0.02, 20);
    for (let i = 1; i < f.length; i++) expect(f[i].expectedReturn).toBeGreaterThanOrEqual(f[i - 1].expectedReturn - 1e-9);
  });
});

describe("allocation", () => {
  it("computes drift and rebalance amounts", () => {
    const { total, rows } = computeAllocation({ thai_stock: 600, bond: 400 }, { thai_stock: 50, bond: 50 });
    expect(total).toBe(1000);
    const eq = rows.find((r) => r.assetClass === "thai_stock")!;
    expect(eq.driftPct).toBeCloseTo(10);
    expect(eq.rebalanceAmount).toBeCloseTo(-100);
  });
});

describe("portfolio accounting", () => {
  const assets: AssetInput[] = [
    { id: 1, symbol: "PTT", name: "PTT", assetClass: "thai_stock", currency: "THB" },
    { id: 2, symbol: "AAPL", name: "Apple", assetClass: "us_stock", currency: "USD" },
  ];
  const txs: TxInput[] = [
    { date: "2024-01-02", assetId: 1, type: "buy", quantity: 100, price: 30, fee: 0, fxRate: 1 },
    { date: "2024-01-03", assetId: 1, type: "buy", quantity: 100, price: 40, fee: 0, fxRate: 1 },
    { date: "2024-01-04", assetId: 1, type: "sell", quantity: 50, price: 50, fee: 0, fxRate: 1 },
    { date: "2024-01-04", assetId: 2, type: "buy", quantity: 1, price: 100, fee: 0, fxRate: 35 },
    { date: "2024-01-05", assetId: 1, type: "dividend", quantity: 0, price: 150, fee: 0, fxRate: 1 },
  ];
  const prices = new Map<number, [string, number][]>([
    [1, [["2024-01-05", 45]]],
    [2, [["2024-01-05", 110]]],
  ]);
  const fx: [string, number][] = [["2024-01-05", 36]];

  it("uses average cost and realizes P&L on sells", () => {
    const s = buildSnapshot(assets, txs, prices, fx, "2024-01-05");
    const ptt = s.positions.find((p) => p.symbol === "PTT")!;
    expect(ptt.quantity).toBe(150);
    expect(ptt.avgCostThb).toBeCloseTo(35);
    expect(ptt.realizedPnlThb).toBeCloseTo(50 * 15);
    expect(ptt.incomeThb).toBe(150);
    const aapl = s.positions.find((p) => p.symbol === "AAPL")!;
    expect(aapl.marketValueThb).toBeCloseTo(110 * 36);
    // Contributions: 3000 + 4000 (implicit); AAPL 3500 covered by 2500 cash from sale + 1000 implicit
    expect(s.netContributedThb).toBeCloseTo(8000);
    expect(s.cashThb).toBeCloseTo(150);
    expect(s.totalValueThb).toBeCloseTo(150 * 45 + 110 * 36 + 150);
  });

  it("value series flows sum to contributions and feed XIRR", () => {
    const series = buildValueSeries(assets, txs, prices, fx, ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]);
    expect(series.reduce((a, p) => a + p.flow, 0)).toBeCloseTo(8000);
    const cfs = investorCashFlows(txs);
    expect(cfs.reduce((a, c) => a + c.amount, 0)).toBeCloseTo(-8000);
  });
});
