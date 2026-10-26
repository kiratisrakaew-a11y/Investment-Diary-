/**
 * Sum-of-the-parts bridge (Roadmap Phase 2). Segment values come from the existing valuation
 * models (see `evaluate` in valuation-schemas.ts); this module only turns them into attributable
 * equity per share and checks for double counting.
 *
 * Conventions (all amounts in the parent's value unit, e.g. THB million, after × fx):
 * - A segment value is either an enterprise value (before its debt) or an equity value (100%).
 * - debtAt "segment": equity₁₀₀ = EV − own net debt; attributable = ownership × equity₁₀₀.
 * - debtAt "parent": the EV is counted at 100% (consolidated) and the group's consolidated net debt
 *   and minority interest are deducted at the parent.
 * - When a consolidated segment carries its own net debt (debtAt "segment" or an equity value) and
 *   the parent net debt is consolidated, that net debt is removed from the parent figure so it is
 *   deducted once.
 */

export type SegmentRole = "division" | "subsidiary" | "associate" | "investment";
export type ValueBasis = "enterprise" | "equity";

export interface MeasuredSegment {
  name: string;
  entity?: string;
  role: SegmentRole;
  ownership: number;
  fx: number;
  method: string;
  basis: ValueBasis;
  /** 100% value in the segment's currency (EV or equity, per `basis`); null when the model failed. */
  value: number | null;
  /** The segment's own net debt + other claims in its currency; null when unknown. */
  ownNetDebt: number | null;
  debtAt?: "segment" | "parent";
  inParentNetDebt?: boolean;
  source?: string;
  errors: string[];
  warnings: string[];
}

export interface SotpBridgeInput {
  sharesOutstanding: number;
  currentPrice: number;
  netDebt: number;
  netDebtBasis: "consolidated" | "holdco";
  /** Omit to derive it from partially owned segments counted at the parent. */
  minorityInterest?: number;
  nonOperatingAssets: { name: string; value: number; entity?: string }[];
  otherClaims: { name: string; value: number }[];
  eliminations: { name: string; value: number }[];
  holdingDiscount: number;
  holdingDiscountBase: "all_segments" | "investments_only";
}

export interface SotpIssue {
  code: string;
  message: string;
  segment?: string;
}

export interface SegmentResult {
  name: string;
  role: SegmentRole;
  method: string;
  basis: ValueBasis;
  debtAt: "segment" | "parent";
  ownership: number;
  fx: number;
  /** In parent currency. */
  value: number | null;
  ownNetDebt: number | null;
  equity100: number | null;
  /** What this segment adds to the sum of the parts. */
  attributable: number | null;
  shareOfGross: number | null;
  inParentNetDebt: boolean;
  source?: string;
  errors: string[];
  warnings: string[];
}

export interface WaterfallStep {
  label: string;
  amount: number;
  kind: "segment" | "addition" | "deduction" | "total";
  cumulative: number;
}

export interface SotpResult {
  valuePerShare: number | null;
  upside: number | null;
  equityValue: number | null;
  segments: SegmentResult[];
  reconciliation: {
    sumOfParts: number;
    holdingDiscount: number;
    nonOperatingAssets: number;
    netDebtReported: number;
    netDebtCountedInSegments: number;
    netDebtDeducted: number;
    minorityInterest: number;
    minoritySource: "given" | "derived" | "none";
    otherClaims: number;
    eliminations: number;
    equityValue: number;
    /** Σ waterfall steps − equity value (should be 0). */
    difference: number;
  } | null;
  waterfall: WaterfallStep[];
  sensitivity: {
    segments: { name: string; down: number | null; up: number | null }[];
    holdingDiscount: { discount: number; value: number | null }[];
    step: number;
  } | null;
  errors: SotpIssue[];
  warnings: SotpIssue[];
}

const CONSOLIDATED: SegmentRole[] = ["division", "subsidiary"];
const keyOf = (s: { name: string; entity?: string }) => (s.entity?.trim() || s.name).trim().toUpperCase();

/** Default debt treatment: a consolidated EV with a consolidated parent net debt is bridged at the parent. */
export function defaultDebtAt(s: Pick<MeasuredSegment, "role" | "basis">, netDebtBasis: SotpBridgeInput["netDebtBasis"]): "segment" | "parent" {
  return s.basis === "enterprise" && CONSOLIDATED.includes(s.role) && netDebtBasis === "consolidated" ? "parent" : "segment";
}

export function sotp(segments: MeasuredSegment[], b: SotpBridgeInput): SotpResult {
  const core = bridge(segments, b);
  if (core.errors.length || core.equity == null) return { ...core.result, sensitivity: null };
  const STEP = 0.1;
  const perShare = (segs: MeasuredSegment[], over: Partial<SotpBridgeInput> = {}) => bridge(segs, { ...b, ...over }).result.valuePerShare;
  const scale = (i: number, f: number) => segments.map((s, k) => (k === i && s.value != null ? { ...s, value: s.value * f, ownNetDebt: s.ownNetDebt } : s));
  const discounts = [...new Set([0, 0.1, 0.2, 0.3, 0.4, b.holdingDiscount])].sort((x, y) => x - y);
  return {
    ...core.result,
    sensitivity: {
      step: STEP,
      // Segment value ±10% (enterprise or equity value as entered; its own net debt unchanged).
      segments: segments.map((s, i) => ({ name: s.name, down: perShare(scale(i, 1 - STEP)), up: perShare(scale(i, 1 + STEP)) })),
      holdingDiscount: discounts.map((d) => ({ discount: d, value: perShare(segments, { holdingDiscount: d }) })),
    },
  };
}

function bridge(segments: MeasuredSegment[], b: SotpBridgeInput) {
  const errors: SotpIssue[] = [];
  const warnings: SotpIssue[] = [];
  const err = (code: string, message: string, segment?: string) => errors.push({ code, message, segment });
  const warn = (code: string, message: string, segment?: string) => warnings.push({ code, message, segment });

  if (!segments.length) err("NO_SEGMENTS", "ต้องมีอย่างน้อย 1 ส่วนงาน");
  if (!(b.sharesOutstanding > 0)) err("INVALID_SHARES", "จำนวนหุ้นของบริษัทแม่ต้องมากกว่า 0");
  if (!(b.holdingDiscount >= 0 && b.holdingDiscount < 1)) err("INVALID_DISCOUNT", "Holding discount ต้องอยู่ระหว่าง 0% ถึง 100%");

  // The same entity counted twice (two segments, or a segment and a non-operating investment).
  const seen = new Map<string, string>();
  for (const s of segments) {
    const k = keyOf(s);
    if (seen.has(k)) err("DUPLICATE_ENTITY", `${s.name}: นับกิจการเดียวกันซ้ำกับ "${seen.get(k)}"`, s.name);
    else seen.set(k, s.name);
  }
  for (const a of b.nonOperatingAssets) {
    const k = keyOf(a);
    if (seen.has(k)) err("INVESTMENT_DOUBLE_COUNT", `สินทรัพย์นอกการดำเนินงาน "${a.name}" เป็นกิจการเดียวกับส่วนงาน "${seen.get(k)}" — นับซ้ำ`);
    if (/cash|เงินสด/i.test(a.name)) warn("CASH_DOUBLE_COUNT", `"${a.name}": เงินสดนับอยู่ในหนี้สุทธิแล้ว — ใส่ในสินทรัพย์นอกการดำเนินงานเฉพาะเงินสดส่วนเกินที่ไม่ได้หักในหนี้สุทธิ`);
  }

  const rows: SegmentResult[] = [];
  let netDebtCounted = 0;
  let derivedMinority = 0;
  let minorityDerivable = true;
  const partialAtParent: string[] = [];
  const partialAtSegment: string[] = [];

  for (const s of segments) {
    const consolidated = CONSOLIDATED.includes(s.role);
    const debtAt = s.debtAt ?? defaultDebtAt(s, b.netDebtBasis);
    const inParent = s.inParentNetDebt ?? (consolidated && b.netDebtBasis === "consolidated");
    const fx = s.fx;
    const row: SegmentResult = {
      name: s.name,
      role: s.role,
      method: s.method,
      basis: s.basis,
      debtAt,
      ownership: s.ownership,
      fx,
      value: s.value != null ? s.value * fx : null,
      ownNetDebt: s.ownNetDebt != null ? s.ownNetDebt * fx : null,
      equity100: null,
      attributable: null,
      shareOfGross: null,
      inParentNetDebt: inParent,
      source: s.source,
      errors: [...s.errors],
      warnings: [...s.warnings],
    };
    rows.push(row);
    const fail = (code: string, m: string) => {
      row.errors.push(m);
      err(code, `${s.name}: ${m}`, s.name);
    };
    const note = (code: string, m: string) => {
      row.warnings.push(m);
      warn(code, `${s.name}: ${m}`, s.name);
    };

    if (!(s.ownership > 0 && s.ownership <= 1)) fail("INVALID_OWNERSHIP", "สัดส่วนถือหุ้นต้องมากกว่า 0% และไม่เกิน 100%");
    if (!(fx > 0)) fail("INVALID_FX", "อัตราแลกเปลี่ยนต้องมากกว่า 0");
    if (s.role === "division" && s.ownership !== 1) fail("DIVISION_OWNERSHIP", "ส่วนงานภายใน (division) ถือ 100% เสมอ — ถ้าถือไม่ครบให้ตั้งเป็นบริษัทย่อย");
    if (s.role === "associate" && s.ownership > 0.5) note("CONTROL_CHECK", "ถือเกิน 50% แต่ตั้งเป็นบริษัทร่วม — ตรวจว่าควรเป็นบริษัทย่อยที่รวมงบหรือไม่");
    if (s.role === "subsidiary" && s.ownership < 0.2) note("CONTROL_CHECK", "ถือน้อยกว่า 20% แต่ตั้งเป็นบริษัทย่อย — ตรวจการควบคุม");
    if (!consolidated && inParent) note("NOT_CONSOLIDATED", "บริษัทร่วม/เงินลงทุนไม่ได้รวมงบ — หนี้สุทธิของกิจการนี้ไม่ควรอยู่ในหนี้สุทธิรวมของบริษัทแม่");
    if (row.value == null) {
      if (!row.errors.length) fail("NO_VALUE", "คำนวณมูลค่าไม่ได้");
      else errors.push(...row.errors.map((m) => ({ code: "SEGMENT_MODEL", message: `${s.name}: ${m}`, segment: s.name })));
      continue;
    }

    if (s.basis === "enterprise" && debtAt === "parent") {
      if (!consolidated) {
        fail("EV_NEEDS_OWN_DEBT", "มูลค่าเป็น EV ของกิจการที่ไม่ได้รวมงบ — หนี้ของกิจการนี้ไม่อยู่ในหนี้สุทธิของบริษัทแม่ ต้องหักหนี้สุทธิของตัวเอง (debtAt: segment)");
        continue;
      }
      if (b.netDebtBasis === "holdco" || !inParent) {
        fail("DEBT_OMITTED", "มูลค่าเป็น EV แต่หนี้สุทธิที่บริษัทแม่ไม่รวมหนี้ของส่วนงานนี้ — หนี้จะไม่ถูกหักเลย ให้ใช้หนี้สุทธิแบบรวมงบ หรือหักหนี้ที่ส่วนงาน");
        continue;
      }
      if (s.ownNetDebt != null && Math.abs(s.ownNetDebt) > 1e-9) note("SEGMENT_DEBT_IGNORED", "หนี้/เงินสดในโมเดลของส่วนงานไม่ถูกใช้ เพราะหักหนี้สุทธิรวมที่บริษัทแม่ (ไม่นับซ้ำ)");
      row.attributable = row.value;
      if (s.ownership < 1) {
        partialAtParent.push(s.name);
        if (row.ownNetDebt != null) derivedMinority += (1 - s.ownership) * (row.value - row.ownNetDebt);
        else minorityDerivable = false;
      }
      continue;
    }

    // Equity at the segment: EV − own net debt, or an equity value.
    if (s.basis === "enterprise") {
      if (row.ownNetDebt == null) {
        fail("MISSING_SEGMENT_DEBT", "มูลค่าเป็น EV — ต้องระบุหนี้สุทธิของส่วนงาน (netDebt) เพื่อแปลงเป็นมูลค่าส่วนผู้ถือหุ้น");
        continue;
      }
      row.equity100 = row.value - row.ownNetDebt;
    } else row.equity100 = row.value;
    row.attributable = s.ownership * row.equity100;
    if (consolidated && s.ownership < 1) partialAtSegment.push(s.name);

    if (consolidated && inParent && b.netDebtBasis === "consolidated") {
      if (row.ownNetDebt == null) {
        fail("DEBT_DOUBLE_COUNT", "มูลค่าหักหนี้ของส่วนงานแล้ว แต่หนี้สุทธิรวมของบริษัทแม่ก็รวมหนี้ของส่วนงานนี้ — ระบุหนี้สุทธิของส่วนงาน (netDebt) เพื่อตัดออกจากหนี้รวม หรือใช้หนี้สุทธิเฉพาะบริษัทแม่ (holdco)");
        continue;
      }
      netDebtCounted += row.ownNetDebt;
    }
  }

  // Minority interest.
  let minority = 0;
  let minoritySource: "given" | "derived" | "none" = "none";
  if (b.minorityInterest != null) {
    minority = b.minorityInterest;
    minoritySource = "given";
    if (partialAtParent.length && minority <= 0) {
      err("MISSING_MINORITY", `ส่วนงานที่ถือไม่ครบ 100% และนับ EV เต็ม (${partialAtParent.join(", ")}) ต้องหักส่วนของผู้ถือหุ้นส่วนน้อย`);
    }
    if (!partialAtParent.length && minority > 0) {
      warn(
        "MINORITY_DOUBLE_COUNT",
        partialAtSegment.length
          ? `หักส่วนของผู้ถือหุ้นส่วนน้อย ${minority} แต่บริษัทย่อยที่ถือไม่ครบ (${partialAtSegment.join(", ")}) คิดตามสัดส่วนถือหุ้นแล้ว — อาจหักซ้ำ ให้หักเฉพาะส่วนน้อยของส่วนงานที่นับ EV เต็ม`
          : `หักส่วนของผู้ถือหุ้นส่วนน้อย ${minority} แต่ไม่มีส่วนงานที่ถือไม่ครบและนับ EV เต็ม — ตรวจว่าเป็นส่วนน้อยของกิจการที่รวมอยู่ในมูลค่าจริง`,
      );
    }
  } else if (partialAtParent.length) {
    if (minorityDerivable) {
      minority = derivedMinority;
      minoritySource = "derived";
      warn("MINORITY_DERIVED", `ส่วนของผู้ถือหุ้นส่วนน้อยคำนวณจาก (1 − สัดส่วนถือหุ้น) × (EV − หนี้สุทธิของส่วนงาน) = ${round(derivedMinority)}`);
    } else {
      err("MISSING_MINORITY", `ส่วนงานที่ถือไม่ครบ 100% และนับ EV เต็ม (${partialAtParent.join(", ")}) ต้องระบุส่วนของผู้ถือหุ้นส่วนน้อย (minorityInterest) หรือหนี้สุทธิของส่วนงานเพื่อคำนวณ`);
    }
  }
  if (b.eliminations.some((e) => e.value < 0)) warn("ELIMINATION_SIGN", "รายการตัดรายการระหว่างกันใส่เป็นจำนวนบวก (ระบบหักออกให้)");

  const ok = rows.filter((r) => r.attributable != null);
  const gross = ok.reduce((a, r) => a + r.attributable!, 0);
  for (const r of ok) r.shareOfGross = gross !== 0 ? r.attributable! / gross : null;
  const discountBase =
    b.holdingDiscountBase === "investments_only" ? ok.filter((r) => r.role !== "division").reduce((a, r) => a + r.attributable!, 0) : gross;
  const discount = b.holdingDiscount * Math.max(discountBase, 0);
  const nonOp = b.nonOperatingAssets.reduce((a, x) => a + x.value, 0);
  const otherClaims = b.otherClaims.reduce((a, x) => a + x.value, 0);
  const elim = b.eliminations.reduce((a, x) => a + Math.abs(x.value), 0);
  const netDebtDeducted = b.netDebt - netDebtCounted;
  const equity = gross - discount + nonOp - netDebtDeducted - minority - otherClaims - elim;

  // Waterfall: segments, then the bridge.
  const waterfall: WaterfallStep[] = [];
  let cum = 0;
  const step = (label: string, amount: number, kind: WaterfallStep["kind"]) => {
    if (kind !== "total") cum += amount;
    waterfall.push({ label, amount, kind, cumulative: kind === "total" ? amount : cum });
  };
  for (const r of ok) step(r.ownership < 1 ? `${r.name} (${round(r.ownership * 100)}%)` : r.name, r.attributable!, "segment");
  step("รวมมูลค่าส่วนงาน (Sum of the parts)", gross, "total");
  if (discount) step(`Holding discount ${round(b.holdingDiscount * 100)}%`, -discount, "deduction");
  for (const a of b.nonOperatingAssets) step(a.name, a.value, "addition");
  if (b.netDebt) step(b.netDebtBasis === "consolidated" ? "หนี้สุทธิรวม (consolidated)" : "หนี้สุทธิบริษัทแม่ (holdco)", -b.netDebt, "deduction");
  if (netDebtCounted) step("บวกกลับ: หนี้สุทธิที่หักในส่วนงานแล้ว", netDebtCounted, "addition");
  if (minority) step(minoritySource === "derived" ? "ส่วนของผู้ถือหุ้นส่วนน้อย (คำนวณ)" : "ส่วนของผู้ถือหุ้นส่วนน้อย", -minority, "deduction");
  for (const c of b.otherClaims) step(c.name, -c.value, "deduction");
  for (const e of b.eliminations) step(`ตัดรายการระหว่างกัน: ${e.name}`, -Math.abs(e.value), "deduction");
  step("มูลค่าส่วนของผู้ถือหุ้นบริษัทแม่", equity, "total");

  if (equity <= 0 && !errors.length) warn("NEGATIVE_EQUITY", "มูลค่าส่วนของผู้ถือหุ้นติดลบหรือเป็นศูนย์");
  const valid = !errors.length && Number.isFinite(equity);
  const valuePerShare = valid ? equity / b.sharesOutstanding : null;
  return {
    errors,
    equity: valid ? equity : null,
    result: {
      valuePerShare,
      upside: valuePerShare != null && b.currentPrice > 0 ? valuePerShare / b.currentPrice - 1 : null,
      equityValue: valid ? equity : null,
      segments: rows,
      reconciliation: valid
        ? {
            sumOfParts: gross,
            holdingDiscount: discount,
            nonOperatingAssets: nonOp,
            netDebtReported: b.netDebt,
            netDebtCountedInSegments: netDebtCounted,
            netDebtDeducted,
            minorityInterest: minority,
            minoritySource,
            otherClaims,
            eliminations: elim,
            equityValue: equity,
            difference: cum - equity,
          }
        : null,
      waterfall: valid ? waterfall : [],
      errors,
      warnings,
    } satisfies Omit<SotpResult, "sensitivity">,
  };
}

const round = (v: number) => Math.round(v * 100) / 100;
