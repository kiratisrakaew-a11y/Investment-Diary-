/**
 * Strategies Phase 1 — dividend cashflows and provider strategies in the existing backtest engine.
 */
import { describe, expect, it } from "vitest";
import { assertSingleDividendTreatment, backtest, type BacktestInput } from "./backtest";
import { backtestReadiness, resolveSettings, statementsKnownBy } from "./dividend-strategies";

const dates = Array.from({ length: 10 }, (_, i) => `2025-01-${String(i + 1).padStart(2, "0")}`);
const flat = (v: number) => dates.map(() => v);
const base: BacktestInput = {
  symbols: ["DIV", "OTH"],
  dates,
  prices: [flat(100), flat(50)],
  benchmark: null,
  strategy: "dividend_sustainable_income",
  returnMethod: "historical",
  covMethod: "sample",
  window: 3,
  rebalanceEvery: 100,
  bounds: { min: 0, max: 1 },
  rf: 0,
  erp: 0.05,
  initialCapital: 10_000,
  costs: { commissionPct: 0, minCommission: 0, vatPct: 0, slippageBps: 0, sellTaxPct: 0, minTradeValue: 0, lotSize: {} },
  lots: { DIV: 100, OTH: 100 },
  useLots: false,
  decisionProvider: ({ cutoff }) => ({ w: [1, 0], selected: ["DIV"], diagnostics: [`cutoff ${cutoff}`] }),
};

describe("dividend cashflows in the backtest", () => {
  it("entitlement from units held before the ex-date; cash only on the payment date; NAV carries the receivable", () => {
    const r = backtest({
      ...base,
      dividendCashflows: {
        // Bought at the close of 01-02 (t = 1). Ex 01-02: bought on the ex-date → not entitled.
        events: [
          { symbol: "DIV", exDate: "2025-01-02", paymentDate: "2025-01-04", grossPerUnitThb: 9, netPerUnitThb: 9 },
          { symbol: "DIV", exDate: "2025-01-04", paymentDate: "2025-01-07", grossPerUnitThb: 2, netPerUnitThb: 1.8 },
        ],
        reinvest: false,
        assumptions: [],
      },
    });
    expect(r.ok).toBe(true);
    const d = r.dividends!;
    expect(d.entitledEvents).toBe(1);
    expect(d.gross).toBeCloseTo(100 * 2, 9); // 100 units × 2
    expect(d.netReceived).toBeCloseTo(180, 9);
    expect(d.withholding).toBeCloseTo(20, 9);
    // Same NAV from the ex-date on (receivable then cash); flat prices.
    const v = Object.fromEntries(r.values.map((x) => [x.date, x.value]));
    expect(v["2025-01-03"]).toBeCloseTo(10_000, 9);
    expect(v["2025-01-04"]).toBeCloseTo(10_180, 9);
    expect(v["2025-01-07"]).toBeCloseTo(10_180, 9);
    expect(d.incomeReturn).toBeCloseTo(0.018, 12);
    expect(r.decisions![0]).toMatchObject({ date: "2025-01-02", cutoff: "2025-01-01", selected: ["DIV"] });
  });
  it("reinvestment buys on the payment date, not the ex-date", () => {
    const r = backtest({ ...base, dividendCashflows: { events: [{ symbol: "DIV", exDate: "2025-01-04", paymentDate: "2025-01-07", grossPerUnitThb: 2, netPerUnitThb: 2 }], reinvest: true, assumptions: [] } });
    const buys = r.trades.filter((t) => t.side === "buy");
    expect(buys.map((t) => t.date)).toEqual(["2025-01-02", "2025-01-07"]);
    expect(buys[1].value).toBeCloseTo(200, 6);
    expect(r.dividends!.reinvested).toBeCloseTo(200, 6);
  });
  it("a payment after the last date stays a receivable", () => {
    const r = backtest({ ...base, dividendCashflows: { events: [{ symbol: "DIV", exDate: "2025-01-09", paymentDate: "2025-02-20", grossPerUnitThb: 1, netPerUnitThb: 1 }], reinvest: false, assumptions: [] } });
    expect(r.dividends!.netReceived).toBe(0);
    expect(r.dividends!.receivableAtEnd).toBeCloseTo(100, 9);
  });
  it("a total-return price series cannot also receive cash dividends", () => {
    expect(() => assertSingleDividendTreatment("total_return", true)).toThrow(/นับซ้ำ/);
    expect(() => assertSingleDividendTreatment("price_return", true)).not.toThrow();
    expect(() => assertSingleDividendTreatment("total_return", false)).not.toThrow();
  });
  it("regression: built-in strategies are unchanged when no cashflows are given (and with an empty event list)", () => {
    const eq = { ...base, strategy: "equal_weight" as const, decisionProvider: undefined, prices: [dates.map((_, i) => 100 + i), dates.map((_, i) => 50 - i)] };
    const a = backtest(eq);
    const b = backtest({ ...eq, dividendCashflows: { events: [], reinvest: false, assumptions: [] } });
    expect(b.values).toEqual(a.values);
    expect(a.dividends).toBeUndefined();
    expect(a.decisions).toBeUndefined();
  });
  it("a dividend strategy without a provider fails clearly", () => {
    expect(backtest({ ...base, decisionProvider: undefined }).error).toMatch(/decisionProvider/);
  });
});

describe("point-in-time readiness", () => {
  const s = resolveSettings("dividend_sustainable_income");
  it("statements without published_at block a strict backtest (NOT_BACKTESTABLE_NO_ASOF_DATA)", () => {
    const r = backtestReadiness({ settings: s, statementsBySymbol: { PTT: [{ fiscalYear: 2023 }, { fiscalYear: 2024 }] }, mode: "strict" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NOT_BACKTESTABLE_NO_ASOF_DATA");
  });
  it("illustrative mode runs but is labelled as look-ahead biased", () => {
    const r = backtestReadiness({ settings: s, statementsBySymbol: { PTT: [{ fiscalYear: 2024 }] }, mode: "illustrative_lookahead" });
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/look-ahead/);
  });
  it("events-only settings need no statement dates", () => {
    const evOnly = resolveSettings("dividend_sustainable_income", { factors: { ttmYieldRegular: { weight: 0.6, required: true }, consistencyYears: { weight: 0.4 } }, filters: { maxEarningsPayout: null, maxFcfPayout: null, excludeNegativeFcf: false } });
    expect(backtestReadiness({ settings: evOnly, statementsBySymbol: { PTT: [{ fiscalYear: 2024 }] }, mode: "strict" }).ok).toBe(true);
  });
  it("statementsKnownBy: fiscal year label alone is not publication", () => {
    const ys = [{ fiscalYear: 2024, publishedAt: "2025-02-25" }, { fiscalYear: 2025, publishedAt: null }];
    expect(statementsKnownBy(ys, "2025-02-24", "strict")).toHaveLength(0);
    expect(statementsKnownBy(ys, "2025-03-01", "strict").map((y) => y.fiscalYear)).toEqual([2024]);
    expect(statementsKnownBy(ys, "2026-01-10", "illustrative_lookahead").map((y) => y.fiscalYear)).toEqual([2024, 2025]);
  });
});

describe("readiness without any statements", () => {
  it("is not an as-of problem: runs with a warning", () => {
    const r = backtestReadiness({ settings: resolveSettings("dividend_growth"), statementsBySymbol: { AAPL: [] }, mode: "strict" });
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/ไม่มีงบการเงิน/);
  });
});
