/**
 * Bond credit-risk add-on (v3 Phase 2). Pure; reuses bonds.ts for cash flows and curve pricing —
 * no second pricing engine. All probabilities / rates are decimals.
 *
 * Simplified single-horizon:  EL = PD × LGD × EAD   (an exposure measure — NOT IFRS 9 / TFRS 9 ECL).
 * Term structure over the bond's remaining payment periods (default assumed at the period end,
 * before that payment; recovery paid then):
 *   S(t) survival from the user's PD curve (piecewise-constant hazard between given points),
 *   marginal_k = S(t_{k−1}) − S(t_k),   EAD_k = principal outstanding before t_k + coupon due at t_k,
 *   PV(EL) = Σ marginal_k × LGD × EAD_k × DF(t_k).
 *   Credit-adjusted expected value = Σ S(t_k)·CF_k·DF_k + Σ marginal_k·(1 − LGD)·EAD_k·DF_k
 *   (shown separately; not comparable to YTM as an "annual loss").
 * Nothing is inferred: no PD from spreads, no rating or LGD defaults. Missing inputs → unavailable.
 */
import { z } from "zod";
import { priceFromCurve, schedule, zSpread, type BondSpec, type CurvePoint } from "./bonds";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const creditProfileSchema = z.object({
  rating: z.string().max(20).optional().describe("Issue/issuer rating as published, e.g. A-; omit when unrated"),
  ratingAgency: z.string().max(40).optional().describe("e.g. TRIS, Fitch Thailand"),
  ratingDate: isoDate.optional(),
  seniority: z.enum(["senior_secured", "senior_unsecured", "subordinated", "other"]).optional(),
  pd: z
    .object({
      type: z.enum(["hypothetical", "historical", "market_implied"]).describe("hypothetical = user scenario; historical = agency default study; market_implied = from a stated model"),
      source: z.string().min(1).max(200).describe("Where the PD comes from (study, model, scenario name)"),
      asOf: isoDate,
      annual: z.number().min(0).max(1).optional().describe("Constant annual PD (decimal)"),
      cumulative: z
        .array(z.object({ years: z.number().positive().max(100), pd: z.number().min(0).max(1) }))
        .max(40)
        .optional()
        .describe("Cumulative PD by horizon, e.g. [{years:1,pd:0.002},{years:5,pd:0.015}]"),
    })
    .optional(),
  lgd: z
    .object({ value: z.number().min(0).max(1), source: z.string().min(1).max(200), asOf: isoDate })
    .optional()
    .describe("Loss given default (1 − recovery)"),
});
export type CreditProfile = z.infer<typeof creditProfileSchema>;

export interface CreditIssue {
  code: string;
  message: string;
}

/** Survival function from the PD input; validates monotonicity. */
export function survivalFunction(pd: NonNullable<CreditProfile["pd"]>): { ok: true; S: (t: number) => number; lastYears: number | null } | { ok: false; issue: CreditIssue } {
  if (pd.annual != null && pd.cumulative?.length) return { ok: false, issue: { code: "AMBIGUOUS_PD", message: "ระบุ PD ได้แบบเดียว: annual หรือ cumulative" } };
  if (pd.annual != null) {
    if (pd.annual >= 1) return { ok: false, issue: { code: "INVALID_PD", message: "PD รายปีต้องน้อยกว่า 100%" } };
    return { ok: true, S: (t) => (1 - pd.annual!) ** Math.max(t, 0), lastYears: null };
  }
  const c = [...(pd.cumulative ?? [])].sort((a, b) => a.years - b.years);
  if (!c.length) return { ok: false, issue: { code: "MISSING_PD", message: "ต้องมี PD (annual หรือ cumulative)" } };
  for (let i = 0; i < c.length; i++) {
    if (i && c[i].years === c[i - 1].years) return { ok: false, issue: { code: "INVALID_PD", message: `ช่วงเวลา PD ซ้ำ (${c[i].years} ปี)` } };
    if (i && c[i].pd < c[i - 1].pd) return { ok: false, issue: { code: "INVALID_PD", message: "PD สะสมต้องไม่ลดลงตามเวลา (survival ต้องไม่เพิ่ม)" } };
  }
  if (c[c.length - 1].pd >= 1) return { ok: false, issue: { code: "INVALID_PD", message: "PD สะสมต้องน้อยกว่า 100%" } };
  // Piecewise-constant hazard between points (log-linear survival), flat hazard after the last point.
  const knots = [{ t: 0, logS: 0 }, ...c.map((p) => ({ t: p.years, logS: Math.log(1 - p.pd) }))];
  const S = (t: number) => {
    if (t <= 0) return 1;
    for (let i = 1; i < knots.length; i++) {
      if (t <= knots[i].t) {
        const a = knots[i - 1];
        const b = knots[i];
        return Math.exp(a.logS + ((b.logS - a.logS) * (t - a.t)) / (b.t - a.t));
      }
    }
    const a = knots[knots.length - 2];
    const b = knots[knots.length - 1];
    const h = (b.logS - a.logS) / (b.t - a.t);
    return Math.exp(b.logS + h * (t - b.t));
  };
  return { ok: true, S, lastYears: c[c.length - 1].years };
}

/** Conditional PD per period from survival: q_k = 1 − S(t_k)/S(t_{k−1}). */
export function conditionalPds(S: (t: number) => number, times: number[]) {
  let prev = 1;
  let prevT = 0;
  return times.map((t) => {
    const s = S(t);
    const q = prev > 0 ? 1 - s / prev : 0;
    const row = { from: prevT, to: t, survivalStart: prev, survivalEnd: s, conditionalPd: q, marginalPd: prev - s };
    prev = s;
    prevT = t;
    return row;
  });
}

export function simpleExpectedLoss(pd: number, lgd: number, ead: number) {
  if (!(pd >= 0 && pd <= 1)) throw new Error("PD ต้องอยู่ระหว่าง 0 ถึง 1");
  if (!(lgd >= 0 && lgd <= 1)) throw new Error("LGD ต้องอยู่ระหว่าง 0 ถึง 1");
  if (!(ead >= 0)) throw new Error("EAD ต้องไม่ติดลบ");
  return pd * lgd * ead;
}

const discount = (curve: CurvePoint[] | null, flat: number, t: number) => {
  if (!curve?.length) return (1 + flat) ** -t;
  const c = [...curve].sort((a, b) => a.years - b.years);
  let r = c[c.length - 1].rate;
  if (t <= c[0].years) r = c[0].rate;
  else for (let i = 0; i + 1 < c.length; i++) if (t <= c[i + 1].years) { r = c[i].rate + ((c[i + 1].rate - c[i].rate) * (t - c[i].years)) / (c[i + 1].years - c[i].years); break; }
  return (1 + r) ** -t;
};

export interface BondCreditResult {
  status: "ok" | "unavailable" | "invalid";
  rating: { rating: string; agency: string | null; date: string | null } | "unrated";
  issues: CreditIssue[];
  required: string[];
  oneYear: { pd: number; lgd: number; ead: number; expectedLoss: number; basis: string } | null;
  term: {
    pvExpectedLoss: number;
    contractualPv: number;
    creditAdjustedValue: number;
    lifetimePd: number;
    periods: { date: string; years: number; marginalPd: number; ead: number; df: number; pvEl: number }[];
    discount: string;
    extrapolatedBeyondYears: number | null;
  } | null;
  spread: { zSpread: number; spreadDv01: number; spreadDuration: number; basis: string } | { unavailable: string };
  provenance: { pdType: string | null; pdSource: string | null; pdAsOf: string | null; lgdSource: string | null; lgdAsOf: string | null };
  units: string;
}

/**
 * Credit metrics for one fixed-coupon bond per 100 face. `curve` = a supplied government zero curve
 * (needed for spread metrics; else PV(EL) discounts at `flatRate`, labelled).
 */
export function bondCredit(spec: BondSpec, cleanPrice: number, profile: CreditProfile | null | undefined, opts: { curve?: CurvePoint[] | null; curveLabel?: string; flatRate: number; flatLabel: string }): BondCreditResult {
  const p = profile ?? {};
  const issues: CreditIssue[] = [];
  const required: string[] = [];
  const rating = p.rating ? { rating: p.rating, agency: p.ratingAgency ?? null, date: p.ratingDate ?? null } : ("unrated" as const);
  if (p.rating && (!p.ratingAgency || !p.ratingDate)) issues.push({ code: "RATING_PROVENANCE", message: "อันดับเครดิตควรระบุสถาบันและวันที่" });
  const provenance = { pdType: p.pd?.type ?? null, pdSource: p.pd?.source ?? null, pdAsOf: p.pd?.asOf ?? null, lgdSource: p.lgd?.source ?? null, lgdAsOf: p.lgd?.asOf ?? null };

  // Spread metrics: only with a supplied curve (bump-and-reprice the existing curve pricer).
  let spread: BondCreditResult["spread"];
  if (opts.curve?.length) {
    try {
      const z = zSpread(spec, cleanPrice, opts.curve);
      const h = 0.0001;
      const up = priceFromCurve(spec, opts.curve, z + h);
      const dn = priceFromCurve(spec, opts.curve, z - h);
      const base = priceFromCurve(spec, opts.curve, z);
      const dv01 = (dn.dirtyPrice - up.dirtyPrice) / 2;
      spread = { zSpread: z, spreadDv01: dv01, spreadDuration: dv01 / (base.dirtyPrice * h), basis: `Z-spread เหนือ ${opts.curveLabel ?? "zero curve"}; ±1bp ขนานกัน คิดจากราคารวมดอกเบี้ยค้างรับ (dirty) ต่อ 100; option-free` };
    } catch (e) {
      spread = { unavailable: `หา Z-spread ไม่ได้: ${(e as Error).message}` };
    }
  } else spread = { unavailable: "ต้องมี zero curve พันธบัตรรัฐบาล (ตั้งค่า → Yield curve) จึงคำนวณ spread / spread duration ได้" };

  if (!p.pd) required.push("PD (ประเภท แหล่งที่มา วันที่ และ annual หรือ cumulative)");
  if (!p.lgd) required.push("LGD (ค่า แหล่งที่มา วันที่)");
  if (required.length) return { status: "unavailable", rating, issues, required, oneYear: null, term: null, spread, provenance, units: "ต่อ 100 หน้าตั๋ว" };

  const sf = survivalFunction(p.pd!);
  if (!sf.ok) return { status: "invalid", rating, issues: [...issues, sf.issue], required, oneYear: null, term: null, spread, provenance, units: "ต่อ 100 หน้าตั๋ว" };
  const lgd = p.lgd!.value;

  const sch = schedule(spec);
  const flows = sch.flows;
  // Outstanding principal before each payment = sum of remaining principal payments.
  let outstanding = flows.reduce((s, f) => s + f.principal, 0);
  const rows = conditionalPds(sf.S, flows.map((f) => f.years));
  const flatLabel = opts.curve?.length ? (opts.curveLabel ?? "zero curve") : opts.flatLabel;
  let pvEl = 0;
  let contractual = 0;
  let survivalPart = 0;
  let recoveryPart = 0;
  const periods = flows.map((f, k) => {
    const ead = outstanding + f.coupon;
    const df = discount(opts.curve ?? null, opts.flatRate, f.years);
    const m = rows[k].marginalPd;
    const el = m * lgd * ead * df;
    pvEl += el;
    contractual += f.amount * df;
    survivalPart += rows[k].survivalEnd * f.amount * df;
    recoveryPart += m * (1 - lgd) * ead * df;
    outstanding -= f.principal;
    return { date: f.date, years: f.years, marginalPd: m, ead, df, pvEl: el };
  });
  const lastT = flows[flows.length - 1]?.years ?? 0;
  const pd1 = 1 - sf.S(1);
  const ead1 = flows.reduce((s, f) => s + f.principal, 0) + flows.filter((f) => f.years <= 1).reduce((s, f) => s + f.coupon, 0);
  if (sf.lastYears != null && lastT > sf.lastYears) issues.push({ code: "PD_EXTRAPOLATED", message: `PD ที่ให้ถึง ${sf.lastYears} ปี แต่ตราสารเหลือ ${lastT.toFixed(2)} ปี — ใช้ hazard คงที่ของช่วงสุดท้าย` });
  if (p.pd!.type === "hypothetical") issues.push({ code: "HYPOTHETICAL_PD", message: "PD เป็นสมมติฐานของผู้ใช้ ไม่ใช่ค่าที่สอบเทียบจากข้อมูล" });
  return {
    status: "ok",
    rating,
    issues,
    required,
    oneYear: { pd: pd1, lgd, ead: ead1, expectedLoss: simpleExpectedLoss(pd1, lgd, ead1), basis: "EL = PD₁ปี × LGD × EAD (เงินต้นคงค้าง + คูปองที่ถึงกำหนดใน 1 ปี) — ไม่ใช่ ECL ตาม TFRS 9" },
    term: {
      pvExpectedLoss: pvEl,
      contractualPv: contractual,
      creditAdjustedValue: survivalPart + recoveryPart,
      lifetimePd: 1 - sf.S(lastT),
      periods,
      discount: flatLabel,
      extrapolatedBeyondYears: sf.lastYears != null && lastT > sf.lastYears ? sf.lastYears : null,
    },
    spread,
    provenance,
    units: "ต่อ 100 หน้าตั๋ว",
  };
}
