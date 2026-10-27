/**
 * Short-selling and CAL-borrowing policy (PR5). Two independent switches, both OFF by default:
 *
 *   allowShortSelling        — negative risky weights (wᵢ < 0) within per-asset short limits and a gross
 *                              exposure cap Σ|wᵢ| ≤ G (auxiliary variables in the QP, never a post-hoc clip).
 *   allowBorrowingAtRiskFree — risky share y > 1 on the Capital Allocation Line, financed at an explicit
 *                              borrowing rate (never assumed equal to the lending rate), capped by maxLeverage.
 *
 * With shorting OFF every lower bound is ≥ 0 for every asset and objective; negative inputs are rejected
 * with SHORT_SELLING_DISABLED instead of being silently changed. Recommendations are analysis only —
 * no order is ever sent.
 */
import { z } from "zod";
import type { Bounds, OptimizerIssue } from "./optimizer";

export const SHORT_DISCLAIMER =
  "น้ำหนักติดลบคือการขายชอร์ตในเชิงแบบจำลอง — ต้องยืมหุ้นได้จริง มีค่ายืม/ค่าธรรมเนียม หลักประกัน (margin) ดอกเบี้ย และกฎการขายชอร์ตของตลาด · ระบบไม่ส่งคำสั่งซื้อขายให้";

export const shortPolicyInput = z.object({
  allowShortSelling: z.boolean().default(false).describe("Default false: every weight ≥ 0 for every objective; negative minimums are rejected"),
  maxShortPerAsset: z.number().gt(0).max(1).optional().describe("allowShortSelling: largest short per asset (decimal, e.g. 0.2 = −20%) — required when shorting"),
  maxGrossExposure: z.number().min(1).max(5).optional().describe("allowShortSelling: cap on Σ|w| (1 = long-only gross; e.g. 1.6 = 130/30) — required when shorting"),
  maxNetExposure: z.number().optional().describe("Σw; the fully invested budget makes net = 100%, so a value below 1 is infeasible"),
  allowBondShorts: z.boolean().default(false).describe("Direct bond shorts stay forbidden unless enabled"),
  forbidShortClasses: z.array(z.string()).default([]).describe("Extra asset classes that may not be shorted (bonds and cash are always forbidden unless allowBondShorts)"),
  allowBorrowingAtRiskFree: z.boolean().default(false).describe("Separate switch: lever the risky portfolio on the CAL (y > 1). Needs borrowingRate and maxLeverage"),
  borrowingRate: z.number().min(-0.05).max(0.5).optional().describe("Annual borrowing rate (decimal) — never assumed equal to the lending (risk-free) rate"),
  maxLeverage: z.number().min(1).max(3).optional().describe("Max risky share y when borrowing (e.g. 1.5 = 150%)"),
});
export type ShortPolicy = z.infer<typeof shortPolicyInput>;

export interface PolicyAsset {
  symbol: string;
  assetClass: string;
}

export type PolicyResult =
  | { ok: true; base: { min: number; max: number }; lower: (number | null)[] | null; gross: number | null; notes: string[] }
  | { ok: false; issue: OptimizerIssue };

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Bounds implied by the policy and the user's minimum weights; errors instead of silent changes. */
export function applyShortPolicy(
  policy: Partial<ShortPolicy> | undefined,
  user: { minWeight?: number; maxWeight?: number; assetMins?: Record<string, number | undefined> },
  assets: PolicyAsset[],
  objective?: string,
): PolicyResult {
  const p = shortPolicyInput.parse(policy ?? {});
  const negatives = [
    ...(user.minWeight != null && user.minWeight < 0 ? [`minWeight ${pct(user.minWeight)}`] : []),
    ...Object.entries(user.assetMins ?? {})
      .filter(([, v]) => v != null && v < 0)
      .map(([s, v]) => `${s} ขั้นต่ำ ${pct(v!)}`),
  ];
  if (!p.allowShortSelling) {
    if (negatives.length)
      return {
        ok: false,
        issue: {
          code: "SHORT_SELLING_DISABLED",
          message: `ปิดการขายชอร์ตอยู่ — น้ำหนักต่ำสุดติดลบใช้ไม่ได้: ${negatives.join(" · ")}`,
          suggestion: "ตั้งน้ำหนักต่ำสุด ≥ 0 หรือเปิด allowShortSelling พร้อม maxShortPerAsset และ maxGrossExposure",
        },
      };
    if (p.maxShortPerAsset != null || p.maxGrossExposure != null) {
      // Harmless but say so: the limits only apply when shorting is on.
      return { ok: true, base: { min: Math.max(0, user.minWeight ?? 0), max: user.maxWeight ?? 1 }, lower: null, gross: null, notes: ["ขีดจำกัดการขายชอร์ตไม่มีผลเพราะปิดการขายชอร์ตอยู่"] };
    }
    return { ok: true, base: { min: Math.max(0, user.minWeight ?? 0), max: user.maxWeight ?? 1 }, lower: null, gross: null, notes: [] };
  }
  if (p.maxShortPerAsset == null || p.maxGrossExposure == null)
    return { ok: false, issue: { code: "INVALID_INPUT", message: "เปิดการขายชอร์ตต้องระบุ maxShortPerAsset และ maxGrossExposure", suggestion: "เช่น ชอร์ตได้ไม่เกิน 20% ต่อตัว และ gross ไม่เกิน 160%" } };
  if (p.maxNetExposure != null && p.maxNetExposure < 1 - 1e-12)
    return {
      ok: false,
      issue: { code: "INFEASIBLE_CONSTRAINTS", message: `Net exposure สูงสุด ${pct(p.maxNetExposure)} < 100% ขัดกับการลงทุนครบ 100% (Σw = 1 ⇒ net = 100%)`, constraints: ["Net exposure", "ลงทุนครบ 100%"] },
    };
  if (objective && ["risk_parity", "max_diversification", "min_cvar"].includes(objective))
    return { ok: false, issue: { code: "UNSUPPORTED_CONSTRAINT", message: `Objective ${objective} รองรับเฉพาะพอร์ตไม่มีการขายชอร์ต`, suggestion: "ปิดการขายชอร์ต หรือเลือก max_sharpe / min_variance / target / utility" } };
  const forbidden = new Set([...(p.allowBondShorts ? [] : ["bond"]), "cash", ...p.forbidShortClasses]);
  const floor = -p.maxShortPerAsset;
  const lower = assets.map((a) => {
    const userMin = user.assetMins?.[a.symbol] ?? user.minWeight;
    const lo = forbidden.has(a.assetClass) ? 0 : floor;
    return userMin != null ? Math.max(lo, userMin) : lo;
  });
  const notes = [`ขายชอร์ตได้ไม่เกิน ${pct(p.maxShortPerAsset)} ต่อตัว · gross ≤ ${pct(p.maxGrossExposure)}`];
  const blocked = assets.filter((a) => forbidden.has(a.assetClass)).map((a) => a.symbol);
  if (blocked.length) notes.push(`ห้ามชอร์ต: ${blocked.join(", ")}${p.allowBondShorts ? "" : " (พันธบัตร/เงินสดต้องเปิดแยก)"}`);
  return { ok: true, base: { min: floor, max: user.maxWeight ?? 1 }, lower, gross: p.maxGrossExposure, notes };
}

/** Apply the policy's per-asset floors and gross cap on top of already-built bounds (keeps the tighter floor). */
export function withPolicyBounds(b: Bounds, r: Extract<PolicyResult, { ok: true }>): Bounds {
  if (!r.lower) return b;
  const lower = r.lower.map((lo, i) => Math.max(lo ?? r.base.min, b.lower?.[i] ?? -Infinity));
  return { ...b, min: r.base.min, lower, ...(r.gross != null ? { gross: r.gross } : {}) };
}

/** Gross / net / long / short exposure of a weight vector (risky sleeve × share). */
export function exposureSummary(w: number[]) {
  const long = w.reduce((s, x) => s + Math.max(x, 0), 0);
  const short = w.reduce((s, x) => s + Math.max(-x, 0), 0);
  return { long, short, gross: long + short, net: long - short };
}
