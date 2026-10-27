/**
 * Bond metadata beyond the pricing terms already on the asset (coupon, maturity, face, frequency,
 * day count) and the credit profile (rating, agency, rating date, seniority, PD, LGD).
 *
 * `riskFreeProxyEligible` is only the user's flag that this bond MAY serve as a risk-free proxy. It is
 * never used to set the risk-free rate: the rate always comes from the resolver (risk-free.ts), and an
 * owned bond's YTM carries credit, liquidity and call premiums.
 */
import { z } from "zod";

export const ISSUER_TYPES = ["sovereign", "agency", "state_enterprise", "corporate", "financial", "supranational", "other"] as const;

export const bondTermsSchema = z.object({
  issuerType: z.enum(ISSUER_TYPES).optional().describe("sovereign = central government; agency / state_enterprise may carry an explicit or implicit guarantee; never assumed"),
  issuerCountry: z.string().length(2).toUpperCase().optional().describe("ISO 3166-1 alpha-2, e.g. TH"),
  couponType: z.enum(["fixed", "floating", "zero", "step"]).optional(),
  callable: z.boolean().optional().describe("Issuer call option (yield-to-worst / price non-linear)"),
  puttable: z.boolean().optional(),
  identifiers: z
    .object({
      isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/).optional(),
      thaiBma: z.string().max(40).optional().describe("ThaiBMA symbol"),
      other: z.string().max(80).optional(),
    })
    .optional(),
  riskFreeProxyEligible: z.boolean().optional().describe("User flag: may be used as a risk-free PROXY (eligibility only; never sets the risk-free rate)"),
  eligibilityNote: z.string().max(300).optional(),
  source: z.string().max(200).optional().describe("Where these terms were checked (prospectus, ThaiBMA page) and when"),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type BondTerms = z.infer<typeof bondTermsSchema>;

export function readBondTerms(raw: unknown): BondTerms {
  const r = bondTermsSchema.safeParse(raw ?? {});
  return r.success ? r.data : {};
}

export interface BondAssetLike {
  assetClass: string;
  currency: string;
  couponRate: number | null;
  maturityDate: string | null;
  faceValue: number | null;
  couponFrequency: number | null;
  dayCount: string | null;
}

export interface EligibilityResult {
  /** User flag AND every structural check passes. */
  eligible: boolean;
  userFlag: boolean;
  /** Reasons the bond cannot (or should not) serve as a risk-free proxy. */
  reasons: string[];
}

/**
 * Structural checks for a risk-free proxy: domestic-currency sovereign, fixed or zero coupon, no
 * embedded options. Even when eligible, a held bond still has price (rate) risk before maturity.
 */
export function riskFreeEligibility(a: BondAssetLike, t: BondTerms, baseCurrency = "THB"): EligibilityResult {
  const reasons: string[] = [];
  if (a.assetClass !== "bond") reasons.push("ไม่ใช่พันธบัตร");
  if (t.issuerType !== "sovereign") reasons.push(t.issuerType ? `ผู้ออกเป็น ${t.issuerType} ไม่ใช่รัฐบาล` : "ยังไม่ระบุประเภทผู้ออก");
  if (a.currency !== baseCurrency) reasons.push(`สกุล ${a.currency} ไม่ตรงกับสกุลหลัก ${baseCurrency}`);
  if (t.couponType === "floating" || t.couponType === "step") reasons.push(`คูปองแบบ ${t.couponType}`);
  if (t.callable) reasons.push("มีสิทธิไถ่ถอนก่อนกำหนด (callable)");
  if (t.puttable) reasons.push("มีสิทธิขายคืน (puttable)");
  const userFlag = !!t.riskFreeProxyEligible;
  if (!userFlag) reasons.push("ผู้ใช้ยังไม่ได้ทำเครื่องหมายว่าใช้เป็นตัวแทนปลอดความเสี่ยงได้");
  return { eligible: userFlag && reasons.length === 0, userFlag, reasons };
}

export type BondFlagCode = "STALE_PRICE" | "NO_PRICE" | "INCOMPLETE_TERMS" | "CALLABLE" | "FLOATING" | "FX_EXPOSURE" | "NO_PROVENANCE" | "MATURED";

/** Data-quality flags for a bond (shown, never auto-corrected). */
export function bondDataFlags(
  a: BondAssetLike,
  t: BondTerms,
  o: { lastPriceDate: string | null; asOf: string; maxPriceAgeDays: number; baseCurrency?: string; creditRatingDate?: string | null },
): { code: BondFlagCode; message: string }[] {
  const out: { code: BondFlagCode; message: string }[] = [];
  if (!o.lastPriceDate) out.push({ code: "NO_PRICE", message: "ไม่มีราคาในระบบ" });
  else {
    const age = Math.round((Date.parse(o.asOf) - Date.parse(o.lastPriceDate)) / 86_400_000);
    if (age > o.maxPriceAgeDays) out.push({ code: "STALE_PRICE", message: `ราคาล่าสุด ${o.lastPriceDate} เก่า ${age} วัน (เกณฑ์ ${o.maxPriceAgeDays} วัน)` });
  }
  const missing = [a.couponRate == null && "คูปอง", !a.maturityDate && "วันครบกำหนด", a.faceValue == null && "มูลค่าที่ตราไว้", a.couponFrequency == null && "ความถี่คูปอง", !a.dayCount && "day count"].filter(Boolean);
  if (missing.length) out.push({ code: "INCOMPLETE_TERMS", message: `ยังไม่ระบุ: ${missing.join(", ")} (ระบบใช้ค่าสมมติและแจ้งไว้)` });
  if (a.maturityDate && a.maturityDate <= o.asOf) out.push({ code: "MATURED", message: `ครบกำหนดแล้ว (${a.maturityDate})` });
  if (t.callable) out.push({ code: "CALLABLE", message: "Callable: YTM/duration แบบปกติไม่สะท้อนสิทธิไถ่ถอน — ราคาไม่เป็นเชิงเส้นเมื่อดอกเบี้ยลง" });
  if (t.couponType === "floating") out.push({ code: "FLOATING", message: "คูปองลอยตัว: YTM/duration แบบคูปองคงที่ใช้ไม่ได้ตรง ๆ" });
  if (a.currency !== (o.baseCurrency ?? "THB")) out.push({ code: "FX_EXPOSURE", message: `สกุล ${a.currency}: ผลตอบแทนเป็นบาทมีความเสี่ยงค่าเงิน` });
  if (!t.source && !o.creditRatingDate) out.push({ code: "NO_PROVENANCE", message: "ยังไม่ระบุแหล่งที่มาของเงื่อนไข/อันดับเครดิต" });
  return out;
}
