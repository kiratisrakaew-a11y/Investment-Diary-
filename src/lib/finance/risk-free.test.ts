import { describe, expect, it } from "vitest";
import { resolveRiskFree, zeroRateAt, type RiskFreeContext } from "./risk-free";

const curve = { points: [{ years: 1, rate: 0.02 }, { years: 5, rate: 0.024 }, { years: 10, rate: 0.03 }], source: "ThaiBMA zero", asOf: "2026-10-20", currency: "THB" };
const ctx: RiskFreeContext = { baseCurrency: "THB", settingsRatePct: 1.9, settingsSource: "ThaiBMA", settingsAsOf: "2026-10-23", curve: null, maxAgeDays: 180, today: "2026-10-27" };

describe("PR2 risk-free resolver", () => {
  it("no curve → Settings fallback, identical to the old behaviour (1.9% → 0.019)", () => {
    const r = resolveRiskFree({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.rate).toBe(0.019);
    expect(r.source).toBe("settings");
    expect(r.label).toMatch(/อัตราสำรอง ไม่ใช่ราคาตลาดสด/);
  });
  it("curve: exact tenor, linear interpolation (hand-checked) and flat extrapolation with a warning", () => {
    const c = { ...ctx, curve };
    expect(resolveRiskFree({ horizonYears: 5 }, c)).toMatchObject({ rate: 0.024, method: "curve_exact", source: "curve" });
    // 3y: 0.02 + (0.024 − 0.02) × (3 − 1)/(5 − 1) = 0.022
    expect(resolveRiskFree({ horizonYears: 3 }, c).rate).toBeCloseTo(0.022, 15);
    // DCF default 10y
    expect(resolveRiskFree({ purpose: "dcf" }, c).rate).toBe(0.03);
    const far = resolveRiskFree({ horizonYears: 20 }, c);
    expect(far.method).toBe("curve_flat_extrapolated");
    expect(far.warnings.join(" ")).toMatch(/นอกช่วง curve/);
    expect(zeroRateAt(curve.points, 0.5)).toEqual({ rate: 0.02, method: "curve_flat_extrapolated" });
  });
  it("rejects a mismatched currency instead of borrowing another currency's rate", () => {
    const usd = resolveRiskFree({ currency: "USD" }, { ...ctx, curve });
    expect(usd.ok).toBe(false);
    expect(usd.rate).toBeNull();
    expect(resolveRiskFree({ currency: "USD", source: "curve" }, { ...ctx, curve }).errors[0]).toMatch(/ไม่ใช้ข้ามสกุล/);
    // A USD curve does not serve THB; auto falls back to Settings and says why.
    const r = resolveRiskFree({}, { ...ctx, curve: { ...curve, currency: "USD" } });
    expect(r.source).toBe("settings");
    expect(r.warnings.join(" ")).toMatch(/สกุล USD/);
  });
  it("warns on a stale curve, negative and real rates, an unlabelled curve; never fabricates", () => {
    const stale = resolveRiskFree({ horizonYears: 1 }, { ...ctx, curve: { ...curve, asOf: "2025-01-01" } });
    expect(stale.warnings.join(" ")).toMatch(/เก่า \d+ วัน/);
    const neg = resolveRiskFree({ horizonYears: 1 }, { ...ctx, curve: { ...curve, points: [{ years: 1, rate: -0.001 }] } });
    expect(neg.warnings.join(" ")).toMatch(/ติดลบ/);
    expect(resolveRiskFree({}, { ...ctx, curve: { ...curve, kind: "real" } }).kind).toBe("real");
    const { currency: _c, ...unlabelled } = curve;
    expect(resolveRiskFree({}, { ...ctx, curve: unlabelled }).warnings.join(" ")).toMatch(/ไม่ได้ระบุสกุล/);
    expect(resolveRiskFree({ source: "curve" }, ctx).ok).toBe(false);
  });
  it("manual override needs a reason (audit) and is labelled as manual", () => {
    expect(resolveRiskFree({ source: "manual", manual: { rate: 0.025, reason: "" } }, ctx).ok).toBe(false);
    const m = resolveRiskFree({ source: "manual", manual: { rate: 0.025, reason: "สมมติฐานคณะกรรมการลงทุน" } }, ctx);
    expect(m).toMatchObject({ ok: true, rate: 0.025, source: "manual" });
    expect(m.label).toMatch(/คณะกรรมการ/);
  });
});
