/**
 * Forward-looking expected return for a bond (PR4), instead of its historical price-only mean:
 * the horizon return from bonds.ts `horizonReturn`, annualized (effective annual), split into
 *   carry + pull-to-par   — exit at today's YTM, coupons reinvested at the YTM,
 *   rolldown              — exit yield moves along the zero curve by z(T − H) − z(T) (spread held),
 *   rate shock            — an explicit parallel shift in bp (scenario, default 0),
 *   expected credit loss  — PD × LGD per year when the credit profile gives both (physical, not risk-neutral).
 * Nothing is inferred when inputs are missing: the function returns ok: false with the reason.
 */
import { horizonReturn, specFromBondAsset, yieldFromPrice } from "./bonds";
import { zeroRateAt } from "./risk-free";

export interface BondExpectedInput {
  couponRate: number | null;
  maturityDate: string | null;
  faceValue: number | null;
  couponFrequency?: number | null;
  dayCount?: string | null;
  /** Clean price per unit as stored. */
  cleanPerUnit: number;
  settlement: string;
  horizonYears?: number;
  rateShiftBp?: number;
  curve?: { years: number; rate: number }[] | null;
  credit?: { pdAnnual?: number | null; lgd?: number | null } | null;
}

export type BondExpected =
  | {
      ok: true;
      expectedReturn: number;
      ytm: number;
      horizonYears: number;
      components: { carryAndPullToPar: number; rolldown: number; rateShock: number; expectedCreditLoss: number };
      notes: string[];
    }
  | { ok: false; reason: string };

const addYears = (iso: string, y: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(d.getTime() + y * 365.25 * 86_400_000).toISOString().slice(0, 10);
};

export function bondExpectedReturn(x: BondExpectedInput): BondExpected {
  if (x.couponRate == null || !x.maturityDate) return { ok: false, reason: "ต้องมีคูปองและวันครบกำหนด" };
  if (!(x.cleanPerUnit > 0)) return { ok: false, reason: "ไม่มีราคา" };
  if (x.maturityDate <= x.settlement) return { ok: false, reason: "ครบกำหนดแล้ว" };
  const notes: string[] = [];
  const spec = specFromBondAsset(x, x.settlement).spec;
  const per100 = x.faceValue ? (x.cleanPerUnit / x.faceValue) * 100 : x.cleanPerUnit;
  const yearsLeft = (Date.parse(x.maturityDate) - Date.parse(x.settlement)) / (365.25 * 86_400_000);
  const H = Math.min(x.horizonYears ?? 1, yearsLeft);
  if (H < (x.horizonYears ?? 1)) notes.push(`ครบกำหนดก่อน horizon — ใช้การถือจนครบกำหนด (${H.toFixed(2)} ปี)`);
  try {
    const ytm = yieldFromPrice(spec, per100);
    const horizonDate = H >= yearsLeft - 1e-9 ? x.maturityDate : addYears(x.settlement, H);
    const annual = (exitYield: number) => {
      const r = horizonReturn(spec, per100, { horizonDate, reinvestRate: ytm, exitYield });
      return (1 + r.totalReturn) ** (1 / H) - 1;
    };
    const base = annual(ytm);
    let roll = 0;
    let rollShift = 0;
    if (x.curve?.length && horizonDate < x.maturityDate) {
      const z = (t: number) => zeroRateAt(x.curve!, t).rate;
      rollShift = z(yearsLeft - H) - z(yearsLeft);
      roll = annual(ytm + rollShift) - base;
      notes.push("rolldown ตาม yield curve (สมมติ spread คงที่)");
    } else if (!x.curve?.length) notes.push("ไม่มี yield curve — rolldown = 0");
    const shift = (x.rateShiftBp ?? 0) / 10_000;
    // Shock measured from the rolled-down exit yield, so the three parts add up exactly.
    const shocked = shift ? annual(ytm + rollShift + shift) - annual(ytm + rollShift) : 0;
    const el = x.credit?.pdAnnual != null && x.credit?.lgd != null ? x.credit.pdAnnual * x.credit.lgd : 0;
    if (el) notes.push(`หัก expected credit loss PD × LGD = ${(el * 100).toFixed(2)}%/ปี (ค่าที่ผู้ใช้ระบุ)`);
    notes.push("คูปองนำไปลงทุนต่อที่ YTM ปัจจุบัน");
    return { ok: true, expectedReturn: base + roll + shocked - el, ytm, horizonYears: H, components: { carryAndPullToPar: base, rolldown: roll, rateShock: shocked, expectedCreditLoss: el }, notes };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
