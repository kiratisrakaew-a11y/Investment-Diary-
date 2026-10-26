/**
 * PR 4 / Phase D regression tests — fixed-income conventions.
 * Expected values are computed independently inside each test from day counts and plain discounting.
 */
import { describe, expect, it } from "vitest";
import {
  BondError,
  analyticsFromPrice,
  analyticsFromYield,
  horizonReturn,
  keyRateDurations,
  priceFromCurve,
  schedule,
  yieldFromPrice,
  yieldToCall,
  yieldToWorst,
  zSpread,
  type BondSpec,
} from "./bonds";

const DAY = 86_400_000;
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;
const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof BondError ? e.code : `other: ${(e as Error).message}`;
  }
  return "no error";
};
/** Independent dirty price: Σ CF / (1 + y/f)^t. */
const pv = (flows: [number, number][], y: number, f: number) => flows.reduce((s, [t, cf]) => s + cf / (1 + y / f) ** t, 0);
const solve = (g: (y: number) => number) => {
  let lo = -0.5;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    if (g(lo) * g(m) <= 0) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
};

describe("D2 coupon schedule conventions", () => {
  it("end-of-month maturity keeps month-end coupon dates", () => {
    const s = schedule({ settlement: "2029-12-01", maturity: "2030-04-30", couponRate: 0.04, frequency: 2 });
    expect(s.prevCoupon).toBe("2029-10-31");
  });

  it("short first coupon: amount and accrued use the quasi-coupon period (ACT/ACT ICMA)", () => {
    const b: BondSpec = { settlement: "2024-04-01", maturity: "2026-12-15", couponRate: 0.06, frequency: 2, issueDate: "2024-03-01", firstCouponDate: "2024-06-15" };
    const s = schedule(b);
    const quasi = days("2023-12-15", "2024-06-15");
    expect(s.flows[0].date).toBe("2024-06-15");
    expect(s.flows[0].amount).toBeCloseTo(3 * (days("2024-03-01", "2024-06-15") / quasi), 10);
    expect(s.accrued).toBeCloseTo(3 * (days("2024-03-01", "2024-04-01") / quasi), 10);
    expect(s.flows[0].periods).toBeCloseTo(days("2024-04-01", "2024-06-15") / quasi, 10);
  });

  it("long first coupon spans two quasi periods", () => {
    const b: BondSpec = { settlement: "2023-11-01", maturity: "2026-12-15", couponRate: 0.06, frequency: 2, issueDate: "2023-10-01", firstCouponDate: "2024-06-15" };
    const s = schedule(b);
    const q1 = days("2023-06-15", "2023-12-15");
    expect(s.flows[0].amount).toBeCloseTo(3 * (days("2023-10-01", "2023-12-15") / q1 + 1), 10);
    expect(s.flows[0].periods).toBeCloseTo(days("2023-11-01", "2023-12-15") / q1 + 1, 10);
  });

  it("short last coupon after the penultimate date", () => {
    const b: BondSpec = { settlement: "2025-01-10", maturity: "2026-03-01", couponRate: 0.06, frequency: 2, penultimateCouponDate: "2025-12-15" };
    const s = schedule(b);
    const last = s.flows[s.flows.length - 1];
    expect(last.date).toBe("2026-03-01");
    expect(last.amount).toBeCloseTo(100 + 3 * (days("2025-12-15", "2026-03-01") / days("2025-12-15", "2026-06-15")), 10);
  });

  it("day counts for accrued interest: ACT/365F, ACT/360, 30/360", () => {
    const base = { settlement: "2024-03-15", maturity: "2027-01-31", couponRate: 0.05, frequency: 2 as const };
    const d = days("2024-01-31", "2024-03-15");
    expect(schedule({ ...base, dayCount: "ACT/365F" }).accrued).toBeCloseTo((5 * d) / 365, 10);
    expect(schedule({ ...base, dayCount: "ACT/360" }).accrued).toBeCloseTo((5 * d) / 360, 10);
    // 30/360: 31 Jan → 30, so days = 30·(3 − 1) + (15 − 30) = 45
    expect(schedule({ ...base, dayCount: "30/360" }).accrued).toBeCloseTo((5 * 45) / 360, 10);
  });

  it("ex-coupon period: the next coupon goes to the seller and accrued is negative", () => {
    const s = schedule({ settlement: "2025-06-10", maturity: "2030-06-15", couponRate: 0.04, frequency: 2, exCouponDays: 7 });
    expect(s.exCoupon).toBe(true);
    expect(s.flows[0].amount).toBe(0);
    expect(s.accrued).toBeCloseTo(-2 * (days("2025-06-10", "2025-06-15") / days("2024-12-15", "2025-06-15")), 10);
  });

  it("amortizing principal: coupons on the outstanding amount", () => {
    const s = schedule({
      settlement: "2024-06-15",
      maturity: "2026-06-15",
      couponRate: 0.06,
      frequency: 1,
      amortization: [{ date: "2025-06-15", amount: 50 }],
    });
    expect(s.flows.map((f) => f.amount)).toEqual([6 + 50, 3 + 50]);
  });

  it("weekend payment dates are adjusted for payment, not for accrual", () => {
    // 2025-06-15 is a Sunday.
    const s = schedule({ settlement: "2025-01-10", maturity: "2027-06-15", couponRate: 0.04, frequency: 2, businessDay: "following" });
    expect(s.flows[0].date).toBe("2025-06-15");
    expect(s.flows[0].payDate).toBe("2025-06-16");
  });

  it("rejects impossible bonds and malformed schedules with typed errors", () => {
    expect(codeOf(() => schedule({ settlement: "2030-01-01", maturity: "2029-01-01", couponRate: 0.04, frequency: 2 }))).toBe("INVALID_DATES");
    expect(codeOf(() => schedule({ settlement: "2024-04-01", maturity: "2026-12-15", couponRate: 0.04, frequency: 2, issueDate: "2024-03-01", firstCouponDate: "2024-07-01" }))).toBe("MALFORMED_SCHEDULE");
    expect(codeOf(() => schedule({ settlement: "2024-04-01", maturity: "2026-12-15", couponRate: 0.04, frequency: 2, amortization: [{ date: "2025-06-15", amount: 120 }] }))).toBe("MALFORMED_SCHEDULE");
    expect(codeOf(() => yieldFromPrice({ settlement: "2024-04-01", maturity: "2026-12-15", couponRate: 0.04, frequency: 2 }, -5))).toBe("INVALID_PRICE");
  });
});

describe("D3 yields", () => {
  const b: BondSpec = { settlement: "2025-01-10", maturity: "2030-06-15", couponRate: 0.05, frequency: 2 };

  it("yield to call uses the bond's own coupon dates up to an off-cycle call date", () => {
    const call = "2027-09-01";
    const clean = 101.5;
    const ytc = yieldToCall(b, clean, call, 101);
    // Independent flows: coupons 15 Jun / 15 Dec until Jun 2027, then 101 + accrued coupon at the call date.
    const q = (a: string, c: string) => days(a, c) / days(a, addSix(a));
    const s = schedule(b);
    const coupons: [number, number][] = s.flows.filter((f) => f.date < call).map((f) => [f.periods, f.amount]);
    const tCall = s.flows.find((f) => f.date === "2027-06-15")!.periods + q("2027-06-15", call);
    const flows: [number, number][] = [...coupons, [tCall, 101 + 2.5 * q("2027-06-15", call)]];
    const expected = solve((y) => pv(flows, y, 2) - (clean + s.accrued));
    expect(ytc).toBeCloseTo(expected, 8);
  });

  it("yield to worst is the lowest of YTM and every call", () => {
    const w = yieldToWorst(b, 103, [
      { date: "2027-06-15", price: 101 },
      { date: "2028-06-15", price: 100 },
    ]);
    const all = [yieldFromPrice(b, 103), yieldToCall(b, 103, "2027-06-15", 101), yieldToCall(b, 103, "2028-06-15", 100)];
    expect(w.yield).toBeCloseTo(Math.min(...all), 12);
    expect(w.candidates).toHaveLength(3);
  });

  it("zero-coupon bond on a coupon date: price = 100 / (1 + y/f)^n", () => {
    const a = analyticsFromYield({ settlement: "2025-06-15", maturity: "2030-06-15", couponRate: 0, frequency: 2 }, 0.03);
    expect(a.cleanPrice).toBeCloseTo(100 / 1.015 ** 10, 10);
  });

  it("negative yields are allowed", () => {
    const a = analyticsFromYield({ settlement: "2025-06-15", maturity: "2027-06-15", couponRate: 0, frequency: 1 }, -0.005);
    expect(a.cleanPrice).toBeCloseTo(100 / 0.995 ** 2, 10);
    expect(analyticsFromPrice({ settlement: "2025-06-15", maturity: "2027-06-15", couponRate: 0, frequency: 1 }, a.cleanPrice).ytm).toBeCloseTo(-0.005, 10);
  });

  it("price ↔ yield round trip between coupon dates with ACT/365F accrual", () => {
    const s = { ...b, dayCount: "ACT/365F" as const };
    const a = analyticsFromYield(s, 0.0437);
    expect(Math.abs(yieldFromPrice(s, a.cleanPrice) - 0.0437)).toBeLessThan(1e-10);
  });

  it("hold to maturity with coupons reinvested at the YTM earns the YTM", () => {
    const s: BondSpec = { settlement: "2025-06-15", maturity: "2030-06-15", couponRate: 0.05, frequency: 2 };
    const a = analyticsFromYield(s, 0.06);
    const r = horizonReturn(s, a.cleanPrice, { horizonDate: "2030-06-15", reinvestRate: 0.06 });
    expect(r.annualizedReturn).toBeCloseTo(0.06, 10);
  });
});

describe("D3 risk measures", () => {
  const b: BondSpec = { settlement: "2025-01-10", maturity: "2035-06-15", couponRate: 0.045, frequency: 2 };
  it("analytic duration/convexity reconcile with bump-and-reprice", () => {
    const a = analyticsFromYield(b, 0.05);
    expect(a.effectiveDuration).toBeCloseTo(a.modifiedDuration, 5);
    expect(a.effectiveConvexity).toBeCloseTo(a.convexity, 2);
  });
  it("yield shock scenarios are exact reprices", () => {
    const a = analyticsFromYield(b, 0.05);
    const s = a.scenarios.find((x) => x.shiftBp === 100)!;
    expect(s.cleanPrice).toBeCloseTo(analyticsFromYield(b, 0.06).cleanPrice, 10);
    expect(a.scenarios.map((x) => x.shiftBp)).toEqual([-100, -50, -25, 25, 50, 100]);
  });
});

describe("D3 spot-curve valuation", () => {
  const b: BondSpec = { settlement: "2025-06-15", maturity: "2030-06-15", couponRate: 0.04, frequency: 1 };
  const flat = (r: number) => [1, 2, 5, 10].map((t) => ({ years: t, rate: r }));
  it("a flat annual curve at the YTM prices the bond at its YTM price; Z-spread is the curve gap", () => {
    const y = 0.045;
    const p = analyticsFromYield(b, y).cleanPrice;
    expect(priceFromCurve(b, flat(y)).cleanPrice).toBeCloseTo(p, 8);
    expect(zSpread(b, p, flat(y))).toBeCloseTo(0, 8);
    expect(zSpread(b, p, flat(0.035))).toBeCloseTo(0.01, 8);
  });
  it("key-rate durations sum to the curve duration", () => {
    const curve = flat(0.04);
    const krd = keyRateDurations(b, curve, 0);
    const up = priceFromCurve(b, curve.map((c) => ({ ...c, rate: c.rate + 0.0001 }))).dirtyPrice;
    const dn = priceFromCurve(b, curve.map((c) => ({ ...c, rate: c.rate - 0.0001 }))).dirtyPrice;
    const p0 = priceFromCurve(b, curve).dirtyPrice;
    const total = krd.reduce((s, k) => s + k.duration, 0);
    expect(total).toBeCloseTo((dn - up) / (2 * p0 * 0.0001), 6);
  });
});

function addSix(d: string) {
  const x = new Date(`${d}T00:00:00Z`);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 6, x.getUTCDate())).toISOString().slice(0, 10);
}
