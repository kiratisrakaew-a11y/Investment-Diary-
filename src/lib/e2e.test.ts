/**
 * End-to-end validation across modules on one synthetic portfolio:
 * ledger → value series → performance metrics → optimizer → valuation → bonds → data quality.
 * Each step is checked against an invariant or an independent calculation, not against itself.
 */
import { describe, expect, it } from "vitest";
import { buildSnapshot, buildValueSeries, investorCashFlows, type AssetInput, type TxInput } from "./finance/portfolio";
import { computeMetrics } from "./finance/metrics";
import { estimateInputs } from "./finance/mpt";
import { recommend } from "./finance/recommend";
import { simpleReturns } from "./finance/stats";
import { evaluate } from "./valuation-schemas";
import { explainValuation } from "./valuation-explain";
import { DEFAULT_DCF } from "./finance/valuation";
import { analyticsFromPrice, analyticsFromYield } from "./finance/bonds";
import { MODEL_VERSION, assessDataQuality, marketInputProvenance } from "./governance";

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const start = "2024-01-01";
const N = 500;
const dates = Array.from({ length: N }, (_, i) => addDays(start, i));

const assets: AssetInput[] = [
  { id: 1, symbol: "TH1", name: "Thai stock", assetClass: "thai_stock", currency: "THB" },
  { id: 2, symbol: "US1", name: "US stock", assetClass: "us_stock", currency: "USD" },
  { id: 3, symbol: "BND", name: "Bond fund", assetClass: "fund", currency: "THB" },
];
// Deterministic price paths.
const px = (i: number, k: number) => 100 * Math.exp(0.0003 * k * i + 0.02 * Math.sin(i / (7 + k)));
const prices = new Map<number, [string, number][]>([
  [1, dates.map((d, i) => [d, px(i, 1)])],
  [2, dates.map((d, i) => [d, px(i, 2)])],
  [3, dates.map((d, i) => [d, 10 + i * 0.001])],
]);
const fx: [string, number][] = dates.map((d, i) => [d, 35 + Math.sin(i / 30)]);
const txs: TxInput[] = [
  { id: 1, date: start, assetId: null, type: "deposit", quantity: 0, price: 1_000_000, fee: 0, fxRate: 1 },
  { id: 2, date: start, assetId: 1, type: "buy", quantity: 3000, price: px(0, 1), fee: 100, fxRate: 1 },
  { id: 3, date: start, assetId: 2, type: "buy", quantity: 50, price: px(0, 2), fee: 5, fxRate: fx[0][1] },
  { id: 4, date: start, assetId: 3, type: "buy", quantity: 20000, price: 10, fee: 0, fxRate: 1 },
  { id: 5, date: dates[200], assetId: null, type: "deposit", quantity: 0, price: 200_000, fee: 0, fxRate: 1 },
  { id: 6, date: dates[250], assetId: 1, type: "sell", quantity: 1000, price: px(250, 1), fee: 80, fxRate: 1 },
  { id: 7, date: dates[300], assetId: 1, type: "dividend", quantity: 0, price: 5000, fee: 0, fxRate: 1 },
];
const end = dates[N - 1];

describe("E2E portfolio → performance", () => {
  const snap = buildSnapshot(assets, txs, prices, fx, end);
  const series = buildValueSeries(assets, txs, prices, fx, dates);
  const flows = investorCashFlows(txs, assets);

  it("ledger reconciles: NAV = cash + Σ qty × price × FX and weights sum to 100%", () => {
    const pos = snap.positions.reduce((s, p) => s + p.marketValueThb, 0);
    expect(snap.totalValueThb).toBeCloseTo(snap.cashThb + pos, 6);
    expect(snap.reconciliation.navMatches).toBe(true);
    expect(snap.reconciliation.weightSumPct).toBeCloseTo(100, 8);
    expect(snap.inferredFlows).toHaveLength(0);
  });

  it("value series ends at the snapshot NAV and only deposits are external flows", () => {
    expect(series[series.length - 1].value).toBeCloseTo(snap.totalValueThb, 6);
    expect(series.reduce((s, p) => s + p.flow, 0)).toBeCloseTo(1_200_000, 6);
    expect(flows.reduce((s, f) => s + f.amount, 0)).toBeCloseTo(-1_200_000, 6);
  });

  it("metrics: XIRR solves its own NPV, Sharpe from periodic excess returns, annualized over ≥ 1 year", () => {
    const m = computeMetrics({ values: series, cashFlows: flows, finalValue: snap.totalValueThb, finalDate: end, riskFreeRate: 0.02 });
    expect(m.annualizationApplicable).toBe(true);
    expect(m.xirr.status).toBe("ok");
    const npv = [...flows.map((f) => ({ ...f })), { date: end, amount: snap.totalValueThb }].reduce((s, f) => s + f.amount / (1 + m.xirr.rate!) ** ((Date.parse(f.date) - Date.parse(start)) / (365 * DAY)), 0);
    expect(Math.abs(npv)).toBeLessThan(1e-3);
    expect(m.sharpe).not.toBeNull();
    expect(m.dataQuality.status).toBe("ok");
  });
});

describe("E2E optimizer on the same assets", () => {
  it("weights respect bounds and sum to one; infeasible bounds give no weights", () => {
    const series = [1, 2, 3].map((id, k) => simpleReturns(dates.map((d, i) => prices.get(id)![i][1] * (k === 1 ? fx[i][1] : 1))));
    const { mu, cov } = estimateInputs(series, 365);
    const b = { min: 0.1, max: 0.6 };
    const r = recommend({ symbols: ["TH1", "US1", "BND"], mu, cov, rf: 0.02, bounds: b, objective: "min_variance", riskAversion: 4, useRiskFree: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = r.allocations.map((a) => a.weight);
      expect(Math.abs(w.reduce((s, x) => s + x, 0) - 1)).toBeLessThan(1e-8);
      w.forEach((x) => expect(x).toBeGreaterThanOrEqual(0.1 - 1e-8));
      w.forEach((x) => expect(x).toBeLessThanOrEqual(0.6 + 1e-8));
    }
    expect(recommend({ symbols: ["TH1", "US1", "BND"], mu, cov, rf: 0.02, bounds: { min: 0, max: 0.3 }, objective: "min_variance", riskAversion: 4, useRiskFree: false }).ok).toBe(false);
  });
});

describe("E2E valuation and bonds", () => {
  it("DCF value, explanation and equity bridge agree", () => {
    const input = { method: "dcf_fcff" as const, assumptions: { ...DEFAULT_DCF, targetDebtWeight: 0.3 } };
    const v = evaluate(input);
    const e = explainValuation(input)!;
    expect(v.value).not.toBeNull();
    expect(e.value!).toBeCloseTo(v.value!, 10);
    const d = v.details as { enterpriseValue: number; equityValue: number };
    expect(d.equityValue).toBeCloseTo(d.enterpriseValue - DEFAULT_DCF.debt + DEFAULT_DCF.cash - DEFAULT_DCF.otherClaims, 6);
  });
  it("bond price ↔ yield round trip and published 10y 5% @ 6% reference", () => {
    const b = { settlement: "2025-01-15", maturity: "2035-01-15", couponRate: 0.05, frequency: 2 as const };
    expect(analyticsFromYield(b, 0.06).cleanPrice).toBeCloseTo(92.5613, 4);
    expect(analyticsFromPrice(b, 92.5613).ytm).toBeCloseTo(0.06, 6);
  });
});

describe("E2E governance", () => {
  it("a fresh install with default Rf/ERP is reported as illustrative, not market data", () => {
    const r = assessDataQuality({
      provenance: marketInputProvenance({ riskFreeRate: 2, equityRiskPremium: 6, rfSource: null, rfAsOf: null, rfSeries: null, erpSource: null, erpAsOf: null }),
      positions: [],
      reconciliation: { navMatches: true, inferredContributionsThb: 0 },
      ledgerIssues: [],
      benchmark: { symbol: "^SET.BK", lastDate: "2026-10-24", kind: "total_return" },
      today: "2026-10-26",
      valuations: [{ id: 1, symbol: "X", modelVersion: MODEL_VERSION }],
      bonds: [],
    });
    expect(r.checks.find((c) => c.area === "สมมติฐานตลาด")!.status).toBe("warn");
  });
});
