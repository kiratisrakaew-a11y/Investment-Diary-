import { describe, expect, it } from "vitest";
import { bondReturnInputs, resampleLevels } from "./bond-returns";
import { buildLevelSeries } from "./return-series";

// 6% annual coupon, ACT/365F, coupon dates 30 Jun, per-100 prices (face 100).
const bond = { couponRate: 6, maturityDate: "2030-06-30", faceValue: 100, couponFrequency: 1, dayCount: "ACT/365F" };
const lvl = (b: typeof bond, obs: { date: string; close: number }[], ex?: number, currency = "THB", fx?: [string, number][]) => {
  const r = bondReturnInputs(b, obs, { exCouponDays: ex });
  if (!r.ok) throw new Error(r.reason);
  const s = buildLevelSeries({ label: "B", observations: r.observations, distributions: r.distributions, basis: "total_return", totalReturnSource: "distributions", currency, fx });
  if (!s.ok) throw new Error(s.reason);
  return { r, levels: s.levels };
};

describe("PR3 bond total-return series", () => {
  it("hand case: constant clean 100 over one coupon year compounds to exactly 1.06 (coupon counted once)", () => {
    const { r, levels } = lvl(bond, [
      { date: "2026-06-30", close: 100 },
      { date: "2026-12-31", close: 100 },
      { date: "2027-06-30", close: 100 },
    ]);
    // Dirty on 31 Dec = 100 + 6 × 184/365; on the coupon date accrued is 0 and the 6 coupon is income.
    expect(r.observations[1].close).toBeCloseTo(100 + (6 * 184) / 365, 12);
    expect(r.distributions).toEqual([{ exDate: "2027-06-30", amount: 6 }]);
    expect(levels[1][1]).toBeCloseTo((100 + (6 * 184) / 365) / 100, 12);
    expect(levels[2][1]).toBeCloseTo(1.06, 12);
  });

  it("ex-coupon convention: coupon credited on the ex date and reinvested (hand-computed)", () => {
    const { r, levels } = lvl(
      bond,
      [
        { date: "2026-06-30", close: 100 },
        { date: "2027-06-20", close: 100 }, // inside the 14-day ex period: negative accrued
        { date: "2027-06-30", close: 100 },
      ],
      14,
    );
    expect(r.distributions[0].exDate).toBe("2027-06-16");
    expect(r.observations[1].close).toBeCloseTo(100 - (6 * 10) / 365, 12); // −10 days to the coupon date
    // Period 1 earns dirty(20 Jun) + the coupon entitled on 16 Jun; period 2 the reinvested index to 30 Jun:
    // (100 − 60/365 + 6)/100 × 100/(100 − 60/365) — slightly above 1.06 because the coupon is reinvested 10 days.
    const d1 = 100 - (6 * 10) / 365;
    expect(levels[1][1]).toBeCloseTo((d1 + 6) / 100, 12);
    expect(levels[2][1]).toBeCloseTo(((d1 + 6) / 100) * (100 / d1), 12);
  });

  it("price changes give a non-flat series (a held 3-year bond is not zero-volatility cash)", () => {
    const b3 = { ...bond, maturityDate: "2029-06-30" };
    const { levels } = lvl(b3, [
      { date: "2026-07-01", close: 100 },
      { date: "2026-08-01", close: 98.5 },
      { date: "2026-09-01", close: 101.2 },
    ]);
    const rets = levels.slice(1).map((x, i) => x[1] / levels[i][1] - 1);
    expect(Math.max(...rets) - Math.min(...rets)).toBeGreaterThan(0.02);
  });

  it("FX is applied exactly once: THB index = local index × FX ratio", () => {
    const fx: [string, number][] = [["2026-06-30", 35], ["2027-06-30", 33.6]];
    const { levels } = lvl(bond, [{ date: "2026-06-30", close: 100 }, { date: "2027-06-30", close: 100 }], undefined, "USD", fx);
    expect(levels[1][1]).toBeCloseTo(1.06 * (33.6 / 35), 12);
  });

  it("refuses bonds without terms and observations after maturity are dropped", () => {
    expect(bondReturnInputs({ ...bond, couponRate: null }, [{ date: "2026-01-01", close: 100 }, { date: "2026-02-01", close: 100 }]).ok).toBe(false);
    const r = bondReturnInputs({ ...bond, maturityDate: "2026-12-31" }, [{ date: "2026-06-30", close: 100 }, { date: "2026-09-30", close: 100 }, { date: "2027-01-10", close: 100 }]);
    expect(r.ok && r.observations.map((o) => o.date)).toEqual(["2026-06-30", "2026-09-30"]);
  });

  it("resampling keeps the last ACTUAL observation per period and never fills missing periods", () => {
    const daily: [string, number][] = [["2026-10-05", 1], ["2026-10-07", 1.1], ["2026-10-21", 1.2]]; // no print in the week of 12 Oct
    expect(resampleLevels(daily, "weekly")).toEqual([["2026-10-11", 1.1], ["2026-10-25", 1.2]]);
    expect(resampleLevels(daily, "monthly")).toEqual([["2026-10-31", 1.2]]);
    expect(resampleLevels(daily, "daily")).toBe(daily);
  });
});
