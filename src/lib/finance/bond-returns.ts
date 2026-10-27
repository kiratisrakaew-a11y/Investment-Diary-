/**
 * Bond total-return inputs (PR3) from stored CLEAN prices per unit and the bond's own schedule,
 * reusing bonds.ts (accrued interest, ex-coupon handling, coupon schedule):
 *
 *   rₜ = (dirtyₜ + cash flows in (t−1, t] − dirtyₜ₋₁) / dirtyₜ₋₁,   dirty = clean + accrued
 *
 * A coupon is credited on its entitlement date: the ex-coupon date when `exCouponDays` is set,
 * otherwise the coupon date. Accrued interest drops on that same date (negative accrued in the ex
 * period), so a coupon is never counted twice or missed. Amortizations / redemption are cash flows
 * on their dates. Feed the result to buildLevelSeries({ basis: "total_return", totalReturnSource:
 * "distributions" }) which compounds the index and applies FX exactly once.
 */
import { schedule, specFromBondAsset, type BondSpec } from "./bonds";

export interface BondReturnAsset {
  couponRate: number | null;
  maturityDate: string | null;
  faceValue: number | null;
  couponFrequency?: number | null;
  dayCount?: string | null;
}

export type BondReturnInputs =
  | {
      ok: true;
      /** Dirty price per unit on each observation date. */
      observations: { date: string; close: number }[];
      /** Coupon / principal per unit on the date it is earned (entitlement date). */
      distributions: { exDate: string; amount: number }[];
      assumed: string[];
      notes: string[];
    }
  | { ok: false; reason: string };

const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10);

export function bondReturnInputs(a: BondReturnAsset, clean: { date: string; close: number }[], opts: { exCouponDays?: number } = {}): BondReturnInputs {
  if (a.couponRate == null || !a.maturityDate) return { ok: false, reason: "ต้องมีอัตราคูปองและวันครบกำหนดจึงคำนวณผลตอบแทนรวมของพันธบัตรได้" };
  const obs = [...clean].sort((x, y) => (x.date < y.date ? -1 : 1)).filter((o) => o.date < a.maturityDate!);
  if (obs.length < 2) return { ok: false, reason: "มีราคาก่อนวันครบกำหนดน้อยกว่า 2 วัน" };
  // Stored price per unit; per-100 maths. No face value → prices are taken to be per 100 face (disclosed).
  const unit = (a.faceValue ?? 100) / 100;
  const notes: string[] = [];
  if (a.faceValue == null) notes.push("ไม่ได้ระบุมูลค่าที่ตราไว้ — ถือว่าราคาที่บันทึกเป็นราคาต่อ 100");
  const base = specFromBondAsset(a, obs[0].date);
  const specAt = (date: string): BondSpec => ({ ...base.spec, settlement: date, exCouponDays: opts.exCouponDays });
  try {
    const observations = obs.map((o) => ({ date: o.date, close: o.close + schedule(specAt(o.date)).accrued * unit }));
    // Every coupon / principal still to come at the first observation, dated by entitlement.
    const first = schedule(specAt(obs[0].date));
    const distributions = first.flows
      .map((f) => ({ exDate: opts.exCouponDays ? addDays(f.date, -opts.exCouponDays) : f.date, amount: f.amount * unit }))
      .filter((d) => d.exDate > obs[0].date && d.exDate <= obs[obs.length - 1].date && d.amount > 0);
    if (observations.some((o) => !(o.close > 0))) return { ok: false, reason: "ราคา dirty ไม่เป็นบวก" };
    notes.push(opts.exCouponDays ? `คูปองนับ ณ วัน ex-coupon (${opts.exCouponDays} วันก่อนวันจ่าย)` : "คูปองนับ ณ วันจ่ายตามตาราง (ไม่มีช่วง ex-coupon ที่ระบุ)");
    return { ok: true, observations, distributions, assumed: base.assumed, notes };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export type SampleFrequency = "daily" | "weekly" | "monthly";

/** Period label = the period's last calendar day (Sunday of the ISO week / month end), sortable ISO. */
function periodEnd(iso: string, f: Exclude<SampleFrequency, "daily">): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (f === "monthly") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(iso, 6 - dow);
}

/**
 * Last ACTUAL observation in each week / month, labelled by the period end. Periods without an
 * observation are absent (never filled), so the common calendar keeps only genuinely observed periods.
 */
export function resampleLevels(levels: [string, number][], f: SampleFrequency): [string, number][] {
  if (f === "daily") return levels;
  const out = new Map<string, number>();
  for (const [d, v] of [...levels].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out.set(periodEnd(d, f), v);
  return [...out.entries()];
}

/** Minimum common observations per sampling frequency (daily keeps the existing 60). */
export const MIN_OBS_BY_FREQUENCY: Record<SampleFrequency, number> = { daily: 60, weekly: 26, monthly: 24 };
