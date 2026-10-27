/**
 * v3 Phase 2 — credit risk: hand-calculated reference cases.
 */
import { describe, expect, it } from "vitest";
import { bondCredit, conditionalPds, creditProfileSchema, simpleExpectedLoss, survivalFunction } from "./credit-risk";
import { priceFromCurve, schedule, type BondSpec } from "./bonds";

const spec: BondSpec = { settlement: "2026-01-01", maturity: "2028-01-01", couponRate: 0.05, frequency: 1, dayCount: "ACT/ACT-ICMA" };
const profile = (pd: number, lgd: number) =>
  creditProfileSchema.parse({ pd: { type: "hypothetical", source: "test scenario", asOf: "2026-01-01", annual: pd }, lgd: { value: lgd, source: "test", asOf: "2026-01-01" } });
const flat = { flatRate: 0.03, flatLabel: "flat 3% (test)" };

describe("survival and PD term structure", () => {
  it("constant annual PD: S(t) = (1 − p)^t; marginal sums to 1 − S(T)", () => {
    const s = survivalFunction({ type: "hypothetical", source: "x", asOf: "2026-01-01", annual: 0.02 });
    if (!s.ok) throw new Error();
    expect(s.S(3)).toBeCloseTo(0.98 ** 3, 14);
    const rows = conditionalPds(s.S, [1, 2, 3]);
    expect(rows.map((r) => r.conditionalPd)).toEqual(rows.map(() => expect.closeTo(0.02, 12)));
    expect(rows.reduce((a, r) => a + r.marginalPd, 0)).toBeCloseTo(1 - 0.98 ** 3, 14);
    expect(rows[1].marginalPd).toBeCloseTo(0.98 * 0.02, 14);
  });
  it("cumulative curve: log-linear survival between points, non-increasing survival enforced", () => {
    const s = survivalFunction({ type: "historical", source: "study", asOf: "2026-01-01", cumulative: [{ years: 1, pd: 0.01 }, { years: 3, pd: 0.05 }] });
    if (!s.ok) throw new Error();
    expect(s.S(1)).toBeCloseTo(0.99, 14);
    expect(s.S(3)).toBeCloseTo(0.95, 14);
    expect(s.S(2)).toBeCloseTo(Math.sqrt(0.99 * 0.95), 14);
    expect(survivalFunction({ type: "historical", source: "s", asOf: "2026-01-01", cumulative: [{ years: 1, pd: 0.05 }, { years: 2, pd: 0.04 }] }).ok).toBe(false);
    expect(survivalFunction({ type: "historical", source: "s", asOf: "2026-01-01", annual: 0.01, cumulative: [{ years: 1, pd: 0.01 }] }).ok).toBe(false);
  });
  it("simple EL = PD × LGD × EAD with validation", () => {
    expect(simpleExpectedLoss(0.02, 0.6, 100)).toBeCloseTo(1.2, 14);
    expect(simpleExpectedLoss(0, 0.6, 100)).toBe(0);
    expect(() => simpleExpectedLoss(1.1, 0.5, 1)).toThrow();
    expect(() => simpleExpectedLoss(0.1, -0.1, 1)).toThrow();
    expect(() => simpleExpectedLoss(0.1, 0.1, -1)).toThrow();
    expect(creditProfileSchema.safeParse({ lgd: { value: 1.2, source: "x", asOf: "2026-01-01" } }).success).toBe(false);
  });
});

describe("bond credit (2-year 5% annual, flat 3%)", () => {
  const f = schedule(spec).flows;
  const [t1, t2] = [f[0].years, f[1].years];
  const df = (t: number) => 1.03 ** -t;
  it("PV(EL), contractual PV and credit-adjusted value match the hand calculation", () => {
    const r = bondCredit(spec, 100, profile(0.02, 0.6), flat);
    expect(r.status).toBe("ok");
    const m1 = 1 - 0.98 ** t1;
    const m2 = 0.98 ** t1 - 0.98 ** t2;
    expect(r.term!.periods.map((p) => p.ead)).toEqual([105, 105]);
    expect(r.term!.pvExpectedLoss).toBeCloseTo(0.6 * 105 * (m1 * df(t1) + m2 * df(t2)), 10);
    expect(r.term!.contractualPv).toBeCloseTo(5 * df(t1) + 105 * df(t2), 10);
    const adj = 0.98 ** t1 * 5 * df(t1) + 0.98 ** t2 * 105 * df(t2) + 0.4 * 105 * (m1 * df(t1) + m2 * df(t2));
    expect(r.term!.creditAdjustedValue).toBeCloseTo(adj, 10);
    expect(r.oneYear!.expectedLoss).toBeCloseTo((1 - 0.98) * 0.6 * 105, 10);
    expect(r.issues.some((i) => i.code === "HYPOTHETICAL_PD")).toBe(true);
  });
  it("zero PD → no loss, credit-adjusted = contractual; 100% LGD → no recovery", () => {
    const z = bondCredit(spec, 100, profile(0, 0.6), flat);
    expect(z.term!.pvExpectedLoss).toBe(0);
    expect(z.term!.creditAdjustedValue).toBeCloseTo(z.term!.contractualPv, 12);
    const full = bondCredit(spec, 100, profile(0.02, 1), flat);
    expect(full.term!.creditAdjustedValue).toBeCloseTo(0.98 ** t1 * 5 * df(t1) + 0.98 ** t2 * 105 * df(t2), 10);
  });
  it("at maturity the final EAD is the redemption plus the last coupon", () => {
    const r = bondCredit({ ...spec, settlement: "2027-06-01" }, 100, profile(0.02, 0.6), flat);
    expect(r.term!.periods).toHaveLength(1);
    expect(r.term!.periods[0].ead).toBe(105);
  });
  it("missing credit data → unavailable (not zero risk); rating stays unrated", () => {
    const r = bondCredit(spec, 100, null, flat);
    expect(r.status).toBe("unavailable");
    expect(r.rating).toBe("unrated");
    expect(r.term).toBeNull();
    expect(r.required.length).toBe(2);
  });
});

describe("spread sensitivity (bump and reprice on the existing curve pricer)", () => {
  const curve = [{ years: 1, rate: 0.02 }, { years: 3, rate: 0.025 }];
  it("needs a supplied curve; ±1bp is symmetric; 100bp repricing lowers the price; sparse curve flat-extrapolates", () => {
    expect("unavailable" in bondCredit(spec, 100, null, flat).spread).toBe(true);
    const r = bondCredit(spec, 101, null, { ...flat, curve, curveLabel: "test curve" });
    if ("unavailable" in r.spread) throw new Error(r.spread.unavailable);
    const z = r.spread.zSpread;
    const base = priceFromCurve(spec, curve, z).dirtyPrice;
    const up = priceFromCurve(spec, curve, z + 0.0001).dirtyPrice;
    const dn = priceFromCurve(spec, curve, z - 0.0001).dirtyPrice;
    expect(Math.abs(base - up - (dn - base))).toBeLessThan(1e-5);
    expect(r.spread.spreadDv01).toBeCloseTo((dn - up) / 2, 12);
    expect(priceFromCurve(spec, curve, z + 0.01).dirtyPrice).toBeLessThan(base - 100 * r.spread.spreadDv01 * 0.9);
    expect(r.spread.spreadDuration).toBeGreaterThan(1.8);
    expect(r.spread.spreadDuration).toBeLessThan(2);
    const sparse = bondCredit(spec, 100, null, { ...flat, curve: [{ years: 5, rate: 0.03 }] });
    expect("zSpread" in sparse.spread).toBe(true);
  });
});
