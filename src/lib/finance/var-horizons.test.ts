/** Audit H-1: multi-horizon historical VaR / ES from compounded returns. */
import { describe, expect, it } from "vitest";
import { horizonReturns, horizonVarTable, MIN_INDEPENDENT_WINDOWS } from "./var-backtesting";

describe("compounded horizon returns", () => {
  it("compounds windows (hand case) and drops the oldest remainder for non-overlapping", () => {
    const rs = [0.1, -0.5, 0.2, 0.1, -0.1];
    // Non-overlapping h = 2 keeps the last 4: (1−0.5)(1.2) − 1 = −0.4 ; (1.1)(0.9) − 1 = −0.01
    const non = horizonReturns(rs, 2, false);
    expect(non[0]).toBeCloseTo(-0.4, 12);
    expect(non[1]).toBeCloseTo(-0.01, 12);
    const ov = horizonReturns(rs, 2, true);
    expect(ov).toHaveLength(4);
    expect(ov[0]).toBeCloseTo(1.1 * 0.5 - 1, 12);
  });

  it("long-only compounded loss never exceeds 100% even after repeated −60% periods", () => {
    const rs = Array.from({ length: 30 }, () => -0.6);
    for (const r of horizonReturns(rs, 5, true)) expect(r).toBeGreaterThanOrEqual(-1);
    // √h scaling of a one-period 60% loss would claim 134% over 5 periods — compounding gives 98.98%.
    expect(horizonReturns(rs, 5, false)[0]).toBeCloseTo(0.4 ** 5 - 1, 12);
  });
});

describe("horizon VaR table", () => {
  // 1,000 deterministic daily returns cycling −2%, −1%, 0, +1%, +2% … (no randomness).
  const rs = Array.from({ length: 1000 }, (_, i) => [-0.02, -0.01, 0, 0.01, 0.02, 0.003, -0.004, 0.006][i % 8]);
  const t = horizonVarTable(rs, 252);

  it("1 period equals the existing one-period VaR", () => {
    const one = t.find((r) => r.key === "1p")!;
    expect(one.nonOverlapping.windows).toBe(1000);
    expect(one.nonOverlapping.var95).toBeCloseTo(0.02, 12);
    expect(one.sqrtScaledVar95).toBeCloseTo(0.02, 12);
  });

  it("10 periods: VaR from actual 10-period compounded returns, not √10", () => {
    const ten = t.find((r) => r.key === "10p")!;
    expect(ten.periods).toBe(10);
    const sorted = horizonReturns(rs, 10, false).sort((a, b) => a - b);
    const pos = (sorted.length - 1) * 0.05;
    const q = sorted[Math.floor(pos)] + (sorted[Math.ceil(pos)] - sorted[Math.floor(pos)]) * (pos - Math.floor(pos));
    expect(ten.nonOverlapping.var95).toBeCloseTo(Math.max(0, -q), 12);
    expect(ten.sqrtScaledVar95).toBeCloseTo(0.02 * Math.sqrt(10), 12);
  });

  it("1 month uses overlapping windows only with enough independent windows, and labels them", () => {
    const m = t.find((r) => r.key === "1m")!;
    expect(m.periods).toBe(21);
    expect(Math.floor(1000 / 21)).toBeGreaterThanOrEqual(MIN_INDEPENDENT_WINDOWS);
    expect(m.nonOverlapping.var95).toBeNull(); // 47 independent windows < 100
    expect(m.overlapping.var95).not.toBeNull();
    expect(m.notes.join()).toMatch(/ทับกัน/);
  });

  it("1 / 3 / 5 years are unavailable on 4 years of data — nothing is extrapolated", () => {
    for (const k of ["1y", "3y", "5y"]) {
      const r = t.find((x) => x.key === k)!;
      expect(r.nonOverlapping.var95).toBeNull();
      expect(r.overlapping.var95).toBeNull();
      expect(r.unavailable).toMatch(/ข้อมูลไม่พอ/);
    }
  });

  it("without observations per year only period-based horizons are computed", () => {
    const u = horizonVarTable(rs, null);
    expect(u.find((r) => r.key === "1p")!.nonOverlapping.var95).not.toBeNull();
    expect(u.find((r) => r.key === "1y")!.unavailable).toMatch(/งวดต่อปี/);
  });
});
