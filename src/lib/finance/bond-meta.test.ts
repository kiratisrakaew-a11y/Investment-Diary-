import { describe, expect, it } from "vitest";
import { bondDataFlags, bondTermsSchema, readBondTerms, riskFreeEligibility } from "./bond-meta";

const govBond = { assetClass: "bond", currency: "THB", couponRate: 2.4, maturityDate: "2029-12-17", faceValue: 1000, couponFrequency: 2, dayCount: "ACT/ACT-ICMA" };
const sov = { issuerType: "sovereign" as const, couponType: "fixed" as const, riskFreeProxyEligible: true };

describe("PR1 bond metadata and risk-free eligibility", () => {
  it("a domestic fixed-coupon sovereign the user flagged is eligible", () => {
    expect(riskFreeEligibility(govBond, sov)).toEqual({ eligible: true, userFlag: true, reasons: [] });
  });
  it("eligibility needs the user's flag even for a sovereign (never inferred)", () => {
    const r = riskFreeEligibility(govBond, { ...sov, riskFreeProxyEligible: undefined });
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/ยังไม่ได้ทำเครื่องหมาย/);
  });
  it("corporate, foreign-currency, callable and floating bonds are not eligible even if flagged", () => {
    expect(riskFreeEligibility(govBond, { ...sov, issuerType: "corporate" }).eligible).toBe(false);
    expect(riskFreeEligibility({ ...govBond, currency: "USD" }, sov).reasons.join(" ")).toMatch(/USD/);
    expect(riskFreeEligibility(govBond, { ...sov, callable: true }).eligible).toBe(false);
    expect(riskFreeEligibility(govBond, { ...sov, couponType: "floating" }).eligible).toBe(false);
    expect(riskFreeEligibility(govBond, {}).reasons.join(" ")).toMatch(/ยังไม่ระบุประเภทผู้ออก/);
  });
  it("data flags: stale / missing price, incomplete terms, callable, floating, FX, provenance, matured", () => {
    const codes = (x: ReturnType<typeof bondDataFlags>) => x.map((f) => f.code);
    expect(codes(bondDataFlags(govBond, { ...sov, source: "ThaiBMA" }, { lastPriceDate: "2026-10-26", asOf: "2026-10-27", maxPriceAgeDays: 7 }))).toEqual([]);
    expect(codes(bondDataFlags(govBond, sov, { lastPriceDate: "2026-09-01", asOf: "2026-10-27", maxPriceAgeDays: 7 }))).toContain("STALE_PRICE");
    expect(codes(bondDataFlags(govBond, sov, { lastPriceDate: null, asOf: "2026-10-27", maxPriceAgeDays: 7 }))).toContain("NO_PRICE");
    const all = codes(bondDataFlags({ ...govBond, currency: "USD", couponFrequency: null, maturityDate: "2026-01-01" }, { callable: true, couponType: "floating" }, { lastPriceDate: "2026-10-26", asOf: "2026-10-27", maxPriceAgeDays: 7 }));
    for (const c of ["INCOMPLETE_TERMS", "CALLABLE", "FLOATING", "FX_EXPOSURE", "NO_PROVENANCE", "MATURED"]) expect(all).toContain(c);
  });
  it("stored terms parse leniently (invalid → empty) and validate ISIN / country", () => {
    expect(readBondTerms(null)).toEqual({});
    expect(readBondTerms({ issuerType: "nonsense" })).toEqual({});
    expect(bondTermsSchema.safeParse({ identifiers: { isin: "TH0623033C05" } }).success).toBe(true);
    expect(bondTermsSchema.safeParse({ identifiers: { isin: "bad" } }).success).toBe(false);
    expect(bondTermsSchema.parse({ issuerCountry: "th" }).issuerCountry).toBe("TH");
  });
});
