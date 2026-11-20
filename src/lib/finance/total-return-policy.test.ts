/** MPT_FIX_SPEC P0-A3 / P0-A4: total-return source per asset class, and adj_close checked against dividends. */
import { describe, expect, it } from "vitest";
import { totalReturnSourceFor } from "./total-return-policy";
import { checkAdjAgainstDividends } from "./adj-check";

const days = [
  "2025-01-02",
  "2025-01-03",
  "2025-01-06",
  "2025-01-07",
  "2025-01-08",
  "2025-01-09",
];
const obs = (adj: boolean) =>
  days.map((date, i) => ({
    date,
    close: 100 + i,
    adjClose: adj ? (100 + i) * 0.95 : null,
  }));

describe("A3: total return source", () => {
  it("full adj_close → adj_close", () =>
    expect(
      totalReturnSourceFor(
        { symbol: "S", assetClass: "thai_stock" },
        obs(true),
        { dividendDates: [], splitDates: [] },
      ),
    ).toMatchObject({ ok: true, basis: "adj_close" }));
  it("gold without adj_close → close_no_dividend (never skipped)", () =>
    expect(
      totalReturnSourceFor({ symbol: "GOLD", assetClass: "gold" }, obs(false), {
        dividendDates: [],
        splitDates: [],
      }),
    ).toMatchObject({ ok: true, source: "close", basis: "close_no_dividend" }));
  it("stock with no dividend / split in the period → close with a note", () => {
    const r = totalReturnSourceFor(
      { symbol: "S", assetClass: "thai_stock" },
      obs(false),
      { dividendDates: ["2024-05-01"], splitDates: [] },
    );
    expect(r).toMatchObject({ ok: true, basis: "close_no_dividend" });
    expect(r.ok && r.note).toMatch(/ไม่มีปันผล/);
  });
  it("stock that paid a dividend but lacks adj_close → skipped with the reason (no silent close)", () => {
    const r = totalReturnSourceFor(
      { symbol: "S", assetClass: "thai_stock" },
      obs(false),
      { dividendDates: ["2025-01-06"], splitDates: [] },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/ปันผล 1 ครั้ง/);
    expect(!r.ok && r.required).toMatch(/adjusted_close/);
  });
  it("fund: accumulating NAV → nav; distributing fund → skipped", () => {
    expect(
      totalReturnSourceFor({ symbol: "F", assetClass: "fund" }, obs(false), {
        dividendDates: [],
        splitDates: [],
      }),
    ).toMatchObject({ ok: true, basis: "nav" });
    expect(
      totalReturnSourceFor({ symbol: "F", assetClass: "fund" }, obs(false), {
        dividendDates: ["2025-01-07"],
        splitDates: [],
      }).ok,
    ).toBe(false);
  });
});

describe("A4: adj_close vs recorded dividends", () => {
  // Close drops by the dividend on the ex-date (01-06); adj factor consistent with DPS 2.
  const close = [100, 101, 100, 101, 102, 103];
  const series = (dps: number | null) => {
    const f = close.map(() => 1); // factor after the ex-date = 1
    if (dps != null) for (let i = 0; i < 2; i++) f[i] = 1 - dps / close[1]; // before the ex-date: × (1 − D / P_{t−1})
    return days.map((date, i) => ({
      date,
      close: close[i],
      adjClose: close[i] * f[i],
    }));
  };
  it("consistent adj_close and DPS → no flag", () =>
    expect(
      checkAdjAgainstDividends(
        "S",
        series(2),
        [{ exDate: "2025-01-06", dps: 2 }],
        [],
      ),
    ).toEqual([]));
  it("dividend not in adj_close → ADJ_MISSING_DIVIDEND", () =>
    expect(
      checkAdjAgainstDividends(
        "S",
        series(null),
        [{ exDate: "2025-01-06", dps: 2 }],
        [],
      ).map((f) => f.code),
    ).toEqual(["ADJ_MISSING_DIVIDEND"]));
  it("recorded DPS 20% off → ADJ_DIVIDEND_MISMATCH", () =>
    expect(
      checkAdjAgainstDividends(
        "S",
        series(2),
        [{ exDate: "2025-01-06", dps: 2.4 }],
        [],
      ).map((f) => f.code),
    ).toEqual(["ADJ_DIVIDEND_MISMATCH"]));
  it("factor change without an event → ADJ_UNEXPLAINED_CHANGE", () =>
    expect(
      checkAdjAgainstDividends("S", series(2), [], []).map((f) => f.code),
    ).toEqual(["ADJ_UNEXPLAINED_CHANGE"]));
  it("a 2:1 close jump without a recorded split → POSSIBLE_UNRECORDED_SPLIT", () => {
    const split = days.map((date, i) => ({
      date,
      close: i < 3 ? 200 + i : 100 + i,
      adjClose: i < 3 ? 200 + i : 100 + i,
    }));
    expect(
      checkAdjAgainstDividends("S", split, [], []).some(
        (f) => f.code === "POSSIBLE_UNRECORDED_SPLIT",
      ),
    ).toBe(true);
  });
});
