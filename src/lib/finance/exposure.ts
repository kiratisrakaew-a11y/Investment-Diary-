/**
 * Exposure definitions and constraint building (v3 Phase 3). Pure; shared by the server optimizer
 * and the web optimizer so both produce the same constraints.
 *
 * Groups come only from user-maintained metadata (issuer, sector with source/date, rating from the
 * credit profile, asset class) or explicit symbol lists — an unclassified asset is never assigned.
 * Weights are shares of the risky sleeve (Σw = 1). Duration limit: Σ wᵢ·Dᵢ ≤ D_max with Dᵢ the
 * modified duration of bonds (0 for other assets unless overridden, disclosed). DV01 limit in THB:
 * Σ wᵢ·W·Dᵢ·0.0001 ≤ DV01_max with W = THB value of the sleeve.
 */
import { z } from "zod";
import type { Bounds, LinearConstraint } from "./optimizer";

export const constraintsInput = z
  .object({
    assetBounds: z.record(z.string(), z.object({ min: z.number().min(0).max(1).optional(), max: z.number().min(0).max(1).optional() })).optional().describe("Per-symbol weight bounds (decimal)"),
    maxPerIssuer: z.number().gt(0).max(1).optional().describe("Cap on the combined weight of each issuer (stocks + bonds of one economic issuer)"),
    maxPerSector: z.number().gt(0).max(1).optional().describe("Cap on each user-classified sector"),
    maxPerRating: z.record(z.string(), z.number().gt(0).max(1)).optional().describe("Cap by bond rating bucket, e.g. { unrated: 0.1, BBB: 0.2 }"),
    groups: z
      .array(z.object({ name: z.string().min(1), symbols: z.array(z.string()).min(1), min: z.number().min(0).max(1).optional(), max: z.number().min(0).max(1).optional() }))
      .max(20)
      .optional()
      .describe("Custom groups (e.g. a sector list you define) with min/max combined weight"),
    maxDuration: z.number().min(0).max(50).optional().describe("Max portfolio modified duration (years) of the risky sleeve"),
    maxDv01Thb: z.number().positive().optional().describe("Max portfolio DV01 in THB per 1bp"),
    durationOverride: z.record(z.string(), z.number().min(0).max(50)).optional().describe("Modified duration for non-bond holdings, e.g. bond funds"),
    maxPerCurrency: z.record(z.string(), z.number().gt(0).max(1)).optional().describe("Cap by asset currency, e.g. { USD: 0.3 }"),
    maturityBuckets: z
      .array(z.object({ name: z.string().min(1), fromYears: z.number().min(0), toYears: z.number().positive(), min: z.number().min(0).max(1).optional(), max: z.number().min(0).max(1).optional() }))
      .max(10)
      .optional()
      .describe("Bond maturity buckets [fromYears, toYears) with min/max combined weight; bonds without a maturity are reported unclassified"),
    maxExpectedShortfall: z.number().optional().describe("Not supported by the mean-variance QP — rejected with UNSUPPORTED_CONSTRAINT"),
    maxTurnover: z.number().optional().describe("Not supported by the mean-variance QP — rejected with UNSUPPORTED_CONSTRAINT"),
  })
  .describe("Risk-aware constraints on top of minWeight/maxWeight");
export type ConstraintsInput = z.infer<typeof constraintsInput>;

export interface AssetRiskMeta {
  symbol: string;
  assetClass: string;
  issuer: string | null;
  sector: string | null;
  rating: string | null;
  modifiedDuration: number | null;
  currency?: string;
  /** Years to maturity (bonds only). */
  yearsToMaturity?: number | null;
}

export interface BuiltConstraints {
  bounds: Bounds;
  unclassified: { issuer: string[]; sector: string[] };
  warnings: string[];
  unsupported: string[];
  durations: number[];
}

const groupBy = (meta: AssetRiskMeta[], key: (m: AssetRiskMeta) => string | null) => {
  const g = new Map<string, number[]>();
  meta.forEach((m, i) => {
    const k = key(m);
    if (k) g.set(k, [...(g.get(k) ?? []), i]);
  });
  return g;
};

export function buildConstraints(meta: AssetRiskMeta[], base: { min: number; max: number }, c: ConstraintsInput | undefined, sleeveValueThb: number): BuiltConstraints {
  const bounds: Bounds = { min: base.min, max: base.max, names: meta.map((m) => m.symbol) };
  const warnings: string[] = [];
  const unsupported: string[] = [];
  const unclassified = { issuer: [] as string[], sector: [] as string[] };
  const durations = meta.map((m) => c?.durationOverride?.[m.symbol.toUpperCase()] ?? (m.assetClass === "bond" ? m.modifiedDuration : null) ?? 0);
  if (!c) return { bounds, unclassified, warnings, unsupported, durations };
  if (c.maxExpectedShortfall != null) unsupported.push("maxExpectedShortfall (ES เป็นข้อจำกัดไม่เชิงเส้น — QP แบบ mean-variance รองรับไม่ได้)");
  if (c.maxTurnover != null) unsupported.push("maxTurnover (|w − w₀| ไม่เชิงเส้นในรูป QP นี้ — ใช้ rebalance_portfolio ที่มี turnover cap แทน)");

  const idx = new Map(meta.map((m, i) => [m.symbol.toUpperCase(), i]));
  const linear: LinearConstraint[] = [];
  const row = (members: number[]) => meta.map((_, i) => (members.includes(i) ? 1 : 0));

  if (c.assetBounds) {
    bounds.lower = meta.map(() => null);
    bounds.upper = meta.map(() => null);
    for (const [sym, v] of Object.entries(c.assetBounds)) {
      const i = idx.get(sym.toUpperCase());
      if (i == null) {
        warnings.push(`${sym}: ไม่อยู่ในชุดสินทรัพย์ — ข้ามขอบเขตรายตัว`);
        continue;
      }
      if (v.min != null) bounds.lower[i] = Math.max(base.min, v.min);
      if (v.max != null) bounds.upper[i] = Math.min(base.max, v.max);
    }
  }
  if (c.maxPerIssuer != null) {
    for (const [k, members] of groupBy(meta, (m) => m.issuer)) linear.push({ name: `ผู้ออก ${k}`, a: row(members), hi: c.maxPerIssuer });
    unclassified.issuer = meta.filter((m) => !m.issuer).map((m) => m.symbol);
  }
  if (c.maxPerSector != null) {
    for (const [k, members] of groupBy(meta, (m) => m.sector)) linear.push({ name: `หมวด ${k}`, a: row(members), hi: c.maxPerSector });
    unclassified.sector = meta.filter((m) => !m.sector).map((m) => m.symbol);
  }
  if (c.maxPerRating) {
    const bonds = groupBy(meta, (m) => (m.assetClass === "bond" ? (m.rating ?? "unrated") : null));
    for (const [k, cap] of Object.entries(c.maxPerRating)) {
      const members = bonds.get(k);
      if (members) linear.push({ name: `อันดับเครดิต ${k}`, a: row(members), hi: cap });
      else warnings.push(`ไม่มีพันธบัตรอันดับ ${k} ในชุดสินทรัพย์`);
    }
  }
  for (const g of c.groups ?? []) {
    const members = g.symbols.map((s) => idx.get(s.toUpperCase())).filter((i): i is number => i != null);
    const missing = g.symbols.filter((s) => !idx.has(s.toUpperCase()));
    if (missing.length) warnings.push(`กลุ่ม ${g.name}: ไม่มี ${missing.join(", ")} ในชุดสินทรัพย์`);
    if (!members.length) continue;
    linear.push({ name: `กลุ่ม ${g.name}`, a: row(members), lo: g.min, hi: g.max });
  }
  if (c.maxDuration != null) {
    linear.push({ name: "Duration พอร์ต", a: durations, hi: c.maxDuration });
    const noD = meta.filter((m, i) => durations[i] === 0 && (m.assetClass === "fund" || (m.assetClass === "bond" && m.modifiedDuration == null))).map((m) => m.symbol);
    if (noD.length) warnings.push(`ไม่มี duration (นับเป็น 0): ${noD.join(", ")} — ใส่ durationOverride สำหรับกองทุนตราสารหนี้`);
  }
  if (c.maxDv01Thb != null) {
    if (!(sleeveValueThb > 0)) warnings.push("ไม่ทราบมูลค่าพอร์ต — ข้ามข้อจำกัด DV01");
    else linear.push({ name: "DV01 พอร์ต (บาท)", a: durations.map((d) => d * sleeveValueThb * 0.0001), hi: c.maxDv01Thb });
  }
  currencyAndMaturityRows(meta, c, linear, warnings);
  if (unclassified.issuer.length) warnings.push(`ยังไม่ระบุผู้ออก (ไม่อยู่ใต้ cap ผู้ออก): ${unclassified.issuer.join(", ")}`);
  if (unclassified.sector.length) warnings.push(`ยังไม่ระบุหมวด (ไม่อยู่ใต้ cap หมวด): ${unclassified.sector.join(", ")}`);
  if (linear.length) bounds.linear = linear;
  return { bounds, unclassified, warnings, unsupported, durations };
}

/** Currency and maturity-bucket rows (PR4), appended to the same linear constraint list. */
function currencyAndMaturityRows(meta: AssetRiskMeta[], c: ConstraintsInput, linear: LinearConstraint[], warnings: string[]) {
  const row = (idx: number[]) => meta.map((_, i) => (idx.includes(i) ? 1 : 0));
  if (c.maxPerCurrency) {
    for (const [cur, max] of Object.entries(c.maxPerCurrency)) {
      const idx = meta.map((m, i) => (m.currency?.toUpperCase() === cur.toUpperCase() ? i : -1)).filter((i) => i >= 0);
      if (idx.length) linear.push({ name: `สกุล ${cur.toUpperCase()}`, a: row(idx), hi: max });
      else warnings.push(`ไม่มีสินทรัพย์สกุล ${cur.toUpperCase()} — ข้อจำกัดนี้ไม่มีผล`);
    }
  }
  if (c.maturityBuckets?.length) {
    const noMat = meta.filter((m) => m.assetClass === "bond" && m.yearsToMaturity == null).map((m) => m.symbol);
    if (noMat.length) warnings.push(`พันธบัตรไม่มีวันครบกำหนด ไม่ถูกจัดกลุ่มอายุ: ${noMat.join(", ")}`);
    for (const b of c.maturityBuckets) {
      if (!(b.toYears > b.fromYears)) {
        warnings.push(`ช่วงอายุ ${b.name}: toYears ต้องมากกว่า fromYears`);
        continue;
      }
      const idx = meta.map((m, i) => (m.assetClass === "bond" && m.yearsToMaturity != null && m.yearsToMaturity >= b.fromYears && m.yearsToMaturity < b.toYears ? i : -1)).filter((i) => i >= 0);
      if (!idx.length && (b.min ?? 0) > 0) linear.push({ name: `อายุ ${b.name}`, a: row(idx), lo: b.min });
      else if (idx.length) linear.push({ name: `อายุ ${b.name} (${b.fromYears}–${b.toYears} ปี)`, a: row(idx), lo: b.min, hi: b.max });
    }
  }
}

/** Weight by issuer / sector / rating / asset class / currency plus duration and DV01 for a weight vector. */
export function exposureReport(meta: AssetRiskMeta[], w: number[], durations: number[], sleeveValueThb: number) {
  const agg = (key: (m: AssetRiskMeta) => string | null, fallback: string) => {
    const m = new Map<string, number>();
    meta.forEach((x, i) => {
      const k = key(x) ?? fallback;
      m.set(k, (m.get(k) ?? 0) + w[i]);
    });
    return [...m.entries()].map(([key, weight]) => ({ key, weight })).sort((a, b) => b.weight - a.weight);
  };
  const duration = w.reduce((s, wi, i) => s + wi * durations[i], 0);
  return {
    byIssuer: agg((m) => m.issuer, "ไม่ระบุ"),
    bySector: agg((m) => m.sector, "ไม่ระบุ"),
    byRating: agg((m) => (m.assetClass === "bond" ? (m.rating ?? "unrated") : null), "ไม่ใช่พันธบัตร"),
    byAssetClass: agg((m) => m.assetClass, "-"),
    byCurrency: agg((m) => m.currency ?? null, "-"),
    duration,
    dv01Thb: sleeveValueThb > 0 ? duration * sleeveValueThb * 0.0001 : null,
  };
}
