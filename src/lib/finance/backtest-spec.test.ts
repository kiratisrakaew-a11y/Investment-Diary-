/** BACKTEST_SPEC BT-1 / BT-2 / BT-7 (pure parts): uncounted dividends are valued, benchmark basis is matched. */
import { describe, expect, it } from "vitest";
import {
  assertSingleDividendTreatment,
  backtest,
  type BacktestInput,
} from "./backtest";
import { chooseBenchmarkBasis } from "./benchmark-basis";

const dates = Array.from(
  { length: 10 },
  (_, i) => `2025-01-${String(i + 1).padStart(2, "0")}`,
);
const flat = (v: number) => dates.map(() => v);
const base: BacktestInput = {
  symbols: ["DIV", "OTH"],
  dates,
  prices: [flat(100), flat(50)],
  benchmark: null,
  strategy: "equal_weight",
  returnMethod: "historical",
  covMethod: "sample",
  window: 3,
  rebalanceEvery: 100,
  bounds: { min: 0, max: 1 },
  rf: 0,
  erp: 0.05,
  initialCapital: 10_000,
  costs: {
    commissionPct: 0,
    minCommission: 0,
    vatPct: 0,
    slippageBps: 0,
    sellTaxPct: 0,
    minTradeValue: 0,
    lotSize: {},
  },
  lots: { DIV: 100, OTH: 100 },
  useLots: false,
};

describe("BT-1: dividends without a payment date", () => {
  it("are valued at the units held on the ex-date (THB and share of capital) without being credited", () => {
    // 5,000 THB in DIV at 100 → 50 units; 2 THB net per unit not credited = 100 THB = 1% of capital.
    const r = backtest({
      ...base,
      dividendCashflows: {
        events: [],
        reinvest: false,
        assumptions: [],
        uncredited: [
          {
            symbol: "DIV",
            exDate: "2025-01-05",
            grossPerUnitThb: 2.2,
            netPerUnitThb: 2,
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.dividends!.uncredited).toMatchObject({ events: 1, heldEvents: 1 });
    expect(r.dividends!.uncredited.netThb).toBeCloseTo(100, 9);
    expect(r.dividends!.uncredited.shareOfInitial).toBeCloseTo(0.01, 12);
    expect(r.dividends!.netReceived).toBe(0);
    expect(r.values.at(-1)!.value).toBeCloseTo(10_000, 9); // not in NAV
  });
  it("the same event with a payment date is credited instead", () => {
    const r = backtest({
      ...base,
      dividendCashflows: {
        events: [
          {
            symbol: "DIV",
            exDate: "2025-01-05",
            paymentDate: "2025-01-08",
            grossPerUnitThb: 2.2,
            netPerUnitThb: 2,
          },
        ],
        reinvest: false,
        assumptions: [],
      },
    });
    expect(r.dividends!.netReceived).toBeCloseTo(100, 9);
    expect(r.dividends!.uncredited.events).toBe(0);
  });
});

describe("BT-2: benchmark on the portfolio's basis", () => {
  const price = {
    symbol: "^SET.BK",
    basis: "price" as const,
    series: [
      ["2024-12-30", 1400],
      ["2025-06-30", 1450],
    ] as [string, number][],
  };
  const tri = {
    symbol: "SETTRI",
    basis: "total_return" as const,
    series: [
      ["2024-12-30", 9000],
      ["2025-06-30", 9400],
    ] as [string, number][],
  };
  it("dividend-inclusive portfolio + TRI available → total return, no warning", () => {
    const c = chooseBenchmarkBasis("total_return", [price, tri], "2025-01-02")!;
    expect(c).toMatchObject({
      symbol: "SETTRI",
      basis: "total_return",
      kind: "total_return",
      warning: null,
    });
  });
  it("dividend-inclusive portfolio without TRI → price index with a basis warning", () => {
    const c = chooseBenchmarkBasis("total_return", [price], "2025-01-02")!;
    expect(c.basis).toBe("price");
    expect(c.warning).toMatch(/basis ไม่ตรง/);
  });
  it("price-only portfolio → price index, no warning", () => {
    expect(
      chooseBenchmarkBasis("price", [tri, price], "2025-01-02"),
    ).toMatchObject({ symbol: "^SET.BK", warning: null });
  });
  it("a series that starts after the test period is not used", () => {
    const late = {
      ...tri,
      series: [["2025-03-01", 9000]] as [string, number][],
    };
    expect(
      chooseBenchmarkBasis("total_return", [price, late], "2025-01-02")!.symbol,
    ).toBe("^SET.BK");
  });
});

describe("BT-7: dividends are never counted twice", () => {
  it("total_return + dividend cash flows is refused with a message", () => {
    expect(() => assertSingleDividendTreatment("total_return", true)).toThrow(
      /นับซ้ำ/,
    );
    expect(() =>
      assertSingleDividendTreatment("price_return", true),
    ).not.toThrow();
  });
});
