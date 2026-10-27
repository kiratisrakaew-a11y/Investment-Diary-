/**
 * Risk-free rate resolver (PR2): one place that turns currency + date + horizon + purpose into a rate
 * with its provenance. Pure — the caller passes Settings and the stored curve.
 *
 * Order (source "auto"): a currency-matched sovereign zero curve, interpolated linearly in the zero
 * rate at the requested tenor (annual compounding, as stored), else the Settings rate as a documented
 * fallback. "manual" needs a reason and is reported as such. Rates are decimals.
 *
 * Never used here: the YTM of an owned bond (credit, liquidity and call premiums), and no rate is
 * invented: a currency the curve and Settings do not cover yields an error and no rate.
 */
export type RiskFreePurpose = "portfolio" | "dcf" | "bond_spread";
export type RiskFreeSource = "auto" | "curve" | "settings" | "manual";

export interface RiskFreeRequest {
  currency?: string;
  asOf?: string;
  /** Holding / cash-flow horizon in years (portfolio Sharpe: the return horizon, default 1; DCF: long). */
  horizonYears?: number;
  purpose?: RiskFreePurpose;
  source?: RiskFreeSource;
  manual?: { rate: number; reason: string };
}

export interface RiskFreeContext {
  baseCurrency: string;
  /** Settings rate in percent, as stored. */
  settingsRatePct: number;
  settingsSource: string | null;
  settingsAsOf: string | null;
  curve: { points: { years: number; rate: number }[]; source: string; asOf: string; currency?: string; kind?: "nominal" | "real" } | null;
  /** Max age (days) of market inputs before a warning (Settings → timestamp policy). */
  maxAgeDays: number;
  today: string;
}

export interface ResolvedRiskFree {
  ok: boolean;
  /** Decimal, annually compounded (effective annual), nominal unless `kind` says otherwise. */
  rate: number | null;
  source: "curve" | "settings" | "manual" | null;
  tenorYears: number;
  method: "curve_exact" | "curve_interpolated" | "curve_flat_extrapolated" | "settings_flat" | "manual" | null;
  currency: string;
  asOf: string | null;
  kind: "nominal" | "real";
  compounding: "annual";
  label: string;
  warnings: string[];
  errors: string[];
}

const DEFAULT_HORIZON: Record<RiskFreePurpose, number> = { portfolio: 1, dcf: 10, bond_spread: 5 };
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

/** Linear interpolation in the zero rate; flat beyond the ends (flagged). */
export function zeroRateAt(points: { years: number; rate: number }[], t: number): { rate: number; method: "curve_exact" | "curve_interpolated" | "curve_flat_extrapolated" } {
  const p = [...points].sort((a, b) => a.years - b.years);
  const hit = p.find((x) => Math.abs(x.years - t) < 1e-9);
  if (hit) return { rate: hit.rate, method: "curve_exact" };
  if (t < p[0].years) return { rate: p[0].rate, method: "curve_flat_extrapolated" };
  if (t > p[p.length - 1].years) return { rate: p[p.length - 1].rate, method: "curve_flat_extrapolated" };
  const k = p.findIndex((x) => x.years > t);
  const a = p[k - 1];
  const b = p[k];
  return { rate: a.rate + ((b.rate - a.rate) * (t - a.years)) / (b.years - a.years), method: "curve_interpolated" };
}

export function resolveRiskFree(req: RiskFreeRequest, ctx: RiskFreeContext): ResolvedRiskFree {
  const purpose = req.purpose ?? "portfolio";
  const currency = (req.currency ?? ctx.baseCurrency).toUpperCase();
  const tenor = req.horizonYears ?? DEFAULT_HORIZON[purpose];
  const source = req.source ?? "auto";
  const asOf = req.asOf ?? ctx.today;
  const warnings: string[] = [];
  const base = { tenorYears: tenor, currency, compounding: "annual" as const, kind: "nominal" as const };
  const fail = (msg: string): ResolvedRiskFree => ({ ok: false, rate: null, source: null, method: null, asOf: null, label: "ไม่มีอัตราปลอดความเสี่ยงที่ใช้ได้", warnings, errors: [msg], ...base });

  if (!(tenor > 0) || !Number.isFinite(tenor)) return fail("ระยะเวลา (horizon) ต้องมากกว่า 0 ปี");

  if (source === "manual") {
    if (!req.manual || !Number.isFinite(req.manual.rate)) return fail("ระบุอัตราเองต้องมีค่า rate");
    if (!req.manual.reason?.trim()) return fail("ระบุอัตราเองต้องมีเหตุผล (audit trail)");
    if (req.manual.rate < 0) warnings.push(`อัตราที่ระบุติดลบ (${pct(req.manual.rate)})`);
    return { ok: true, rate: req.manual.rate, source: "manual", method: "manual", asOf, label: `ระบุเอง ${pct(req.manual.rate)} — ${req.manual.reason.trim()}`, warnings, errors: [], ...base };
  }

  // Curve: only when its currency is known to match (an unlabelled curve is assumed to be the base currency and said so).
  const curve = ctx.curve;
  const curveCurrency = curve?.currency?.toUpperCase();
  const curveUsable = !!curve && curve.points.length > 0 && (curveCurrency ? curveCurrency === currency : currency === ctx.baseCurrency);
  if (source === "curve" || (source === "auto" && curveUsable)) {
    if (!curve || !curve.points.length) return fail("ยังไม่มี yield curve ในหน้าตั้งค่า");
    if (curveCurrency && curveCurrency !== currency) return fail(`yield curve เป็นสกุล ${curveCurrency} ไม่ตรงกับ ${currency} — ไม่ใช้ข้ามสกุล`);
    if (!curveCurrency && currency !== ctx.baseCurrency) return fail(`yield curve ไม่ได้ระบุสกุล — ใช้กับ ${currency} ไม่ได้`);
    if (!curveCurrency) warnings.push(`yield curve ไม่ได้ระบุสกุล — ถือว่าเป็น ${ctx.baseCurrency} (ระบุสกุลในหน้าตั้งค่าเพื่อยืนยัน)`);
    const z = zeroRateAt(curve.points, tenor);
    const range = [Math.min(...curve.points.map((p) => p.years)), Math.max(...curve.points.map((p) => p.years))];
    if (z.method === "curve_flat_extrapolated") warnings.push(`horizon ${tenor} ปี อยู่นอกช่วง curve (${range[0]}–${range[1]} ปี) — ใช้อัตราปลายช่วงแบบคงที่`);
    const age = days(asOf, curve.asOf);
    if (age > ctx.maxAgeDays) warnings.push(`yield curve ณ ${curve.asOf} เก่า ${age} วัน (เกณฑ์ ${ctx.maxAgeDays} วัน)`);
    if (age < 0) warnings.push(`yield curve ลงวันที่ ${curve.asOf} หลังวันที่ใช้ ${asOf}`);
    if (curve.points.some((p) => p.rate < 0)) warnings.push("yield curve มีอัตราติดลบ");
    const kind = curve.kind ?? "nominal";
    if (kind === "real") warnings.push("curve เป็นอัตราแท้จริง (real) — ผลตอบแทนที่เทียบต้องเป็นแบบ real ด้วย");
    return {
      ok: true,
      rate: z.rate,
      source: "curve",
      method: z.method,
      asOf: curve.asOf,
      label: `${curve.source} ณ ${curve.asOf} · zero ${tenor} ปี ${pct(z.rate)}${z.method === "curve_interpolated" ? " (interpolate เชิงเส้น)" : ""}`,
      warnings,
      errors: [],
      ...base,
      kind,
    };
  }

  // Settings fallback: a stored rate for the base currency, not a live quote.
  if (currency !== ctx.baseCurrency) return fail(`อัตราในหน้าตั้งค่าเป็นของ ${ctx.baseCurrency} — ไม่มีอัตราของ ${currency} (ไม่สร้างตัวเลขให้)`);
  const rate = ctx.settingsRatePct / 100;
  if (source === "auto" && curve && !curveUsable) warnings.push(`มี yield curve สกุล ${curveCurrency} แต่คำขอเป็น ${currency} — ใช้อัตราในหน้าตั้งค่าแทน`);
  if (!ctx.settingsSource) warnings.push("อัตราในหน้าตั้งค่ายังไม่ระบุแหล่งที่มา — ถือเป็นค่าตัวอย่าง");
  if (ctx.settingsAsOf) {
    const age = days(asOf, ctx.settingsAsOf);
    if (age > ctx.maxAgeDays) warnings.push(`อัตราในหน้าตั้งค่า ณ ${ctx.settingsAsOf} เก่า ${age} วัน (เกณฑ์ ${ctx.maxAgeDays} วัน)`);
  }
  if (rate < 0) warnings.push("อัตราปลอดความเสี่ยงติดลบ");
  if (purpose === "dcf" && tenor > 2) warnings.push(`ใช้อัตราคงที่จากหน้าตั้งค่ากับ horizon ${tenor} ปี — ควรใช้อัตราระยะยาวที่อายุตรงกับกระแสเงินสด`);
  return {
    ok: true,
    rate,
    source: "settings",
    method: "settings_flat",
    asOf: ctx.settingsAsOf,
    label: `หน้าตั้งค่า ${ctx.settingsRatePct}%${ctx.settingsSource ? ` (${ctx.settingsSource}${ctx.settingsAsOf ? ` ณ ${ctx.settingsAsOf}` : ""})` : ""} — อัตราสำรอง ไม่ใช่ราคาตลาดสด`,
    warnings,
    errors: [],
    ...base,
  };
}
