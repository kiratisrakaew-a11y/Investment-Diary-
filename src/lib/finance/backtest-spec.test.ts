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

// ------------------------------------------------------------------ BT-4 / BT-8
function businessDays(from: string, to: string) {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
      out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
let sd = 9;
const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647 - 0.5;
function market(dts: string[], n: number) {
  return Array.from({ length: n }, (_, i) => {
    let p = 50 + i * 5;
    return dts.map((_, t) =>
      t === 0 ? p : (p *= 1 + 0.004 * (i % 3) + rnd() * 0.03),
    );
  });
}

describe("BT-8: calendar-anchored rebalances and rebalanceLog", () => {
  const dts = businessDays("2024-01-01", "2024-12-31");
  const cal = {
    ...base,
    symbols: ["A", "B", "C"],
    dates: dts,
    prices: market(dts, 3),
    lots: {},
    rebalanceCalendar: "quarterly" as const,
  };
  it("quarterly: every rebalance after the first purchase is the last trading day of Mar / Jun / Sep (Dec is the data end)", () => {
    const r = backtest(cal);
    expect(r.ok).toBe(true);
    const later = r.rebalanceLog.slice(1).map((x) => x.date);
    expect(later).toEqual(["2024-03-29", "2024-06-28", "2024-09-30"]);
    expect(r.rebalanceLog).toHaveLength(r.period.rebalances);
    expect(r.methodology.join(" ")).toMatch(/วันทำการสุดท้ายของทุกไตรมาส/);
  });
  it("monthly: last trading day of each month; without the anchor the old every-N behaviour is unchanged", () => {
    const m = backtest({ ...cal, rebalanceCalendar: "monthly" });
    expect(
      m.rebalanceLog
        .slice(1)
        .every(
          (x) =>
            dts[dts.indexOf(x.date) + 1]?.slice(0, 7) !== x.date.slice(0, 7),
        ),
    ).toBe(true);
    expect(m.rebalanceLog).toHaveLength(12); // first purchase + Jan … Nov month-ends
    const p = backtest({
      ...cal,
      rebalanceCalendar: undefined,
      rebalanceEvery: 60,
    });
    expect(p.rebalanceLog.map((x) => dts.indexOf(x.date))).toEqual([
      0, 60, 120, 180, 240,
    ]);
  });
  it("rebalanceLog rows carry target, weights after trading, turnover and cost", () => {
    const r = backtest({
      ...cal,
      costs: { ...base.costs, commissionPct: 0.1 },
    });
    const row = r.rebalanceLog[0];
    expect(row.target).toEqual({ A: 1 / 3, B: 1 / 3, C: 1 / 3 });
    expect(
      Object.values(row.actual).reduce((a, b) => a + b, 0),
    ).toBeGreaterThan(0.99);
    expect(row.turnover).toBeGreaterThan(0.99); // the first purchase trades the whole portfolio
    expect(row.cost).toBeGreaterThan(0);
  });
});

describe("BT-4: constraints at every rebalance", () => {
  const dts = businessDays("2023-01-02", "2024-12-31");
  const syms = ["B1", "B2", "B3", "C1", "C2", "C3", "P1", "P2"];
  const run = (
    bounds: BacktestInput["bounds"],
    strategy: BacktestInput["strategy"] = "min_variance",
  ) =>
    backtest({
      ...base,
      symbols: syms,
      dates: dts,
      prices: market(dts, syms.length),
      lots: {},
      strategy,
      window: 120,
      rebalanceCalendar: "quarterly",
      bounds,
    });
  const grp = (name: string, members: string[], hi: number) => ({
    name,
    a: syms.map((s) => (members.includes(s) ? 1 : 0)),
    hi,
  });
  const load = (w: Record<string, number> | null, members: string[]) =>
    members.reduce((a, s) => a + (w?.[s] ?? 0), 0);
  it("maxPerSector-style caps (35%) hold in every rebalance", () => {
    const linear = [
      grp("Bank", ["B1", "B2", "B3"], 0.35),
      grp("Commerce", ["C1", "C2", "C3"], 0.35),
      grp("Property", ["P1", "P2"], 0.35),
    ];
    const r = run({ min: 0, max: 1, linear }, "max_sharpe");
    expect(r.ok).toBe(true);
    expect(r.rebalanceLog.length).toBeGreaterThan(4);
    for (const row of r.rebalanceLog)
      for (const g of [
        ["B1", "B2", "B3"],
        ["C1", "C2", "C3"],
        ["P1", "P2"],
      ])
        expect(load(row.target, g)).toBeLessThanOrEqual(0.35 + 1e-9);
  });
  it("four groups with a 25% per-asset cap pass in every rebalance", () => {
    const linear = [
      grp("G1", ["B1", "B2"], 0.3),
      grp("G2", ["B3", "C1"], 0.3),
      grp("G3", ["C2", "C3"], 0.3),
      grp("G4", ["P1", "P2"], 0.3),
    ];
    const r = run({ min: 0, max: 0.25, linear });
    expect(
      r.rebalanceLog.every(
        (row) =>
          row.skipped == null &&
          Math.max(...Object.values(row.target!)) <= 0.25 + 1e-9,
      ),
    ).toBe(true);
  });
  it("an optimizer failure in one rebalance keeps the holdings and warns with the date; the backtest finishes", () => {
    // B2 does not move during the first training window (zero volatility → max diversification fails there only).
    const prices = market(dts, syms.length);
    for (let t = 0; t <= 121; t++) prices[1][t] = 70;
    const r = backtest({
      ...base,
      symbols: syms,
      dates: dts,
      prices,
      lots: {},
      strategy: "max_diversification",
      window: 120,
      rebalanceCalendar: "quarterly",
      bounds: { min: 0, max: 1 },
    });
    expect(r.ok).toBe(true);
    expect(r.rebalanceLog[0].skipped).toMatch(/ถือพอร์ตเดิม/);
    expect(r.rebalanceLog.slice(1).some((row) => row.skipped == null)).toBe(
      true,
    );
    expect(
      r.warnings.some(
        (w) => w.startsWith(r.rebalanceLog[0].date) && /ถือพอร์ตเดิม/.test(w),
      ),
    ).toBe(true);
  });
});
