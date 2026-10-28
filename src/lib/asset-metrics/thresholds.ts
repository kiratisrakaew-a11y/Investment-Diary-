/**
 * Traffic-light evaluation of asset custom metrics (pure). Thresholds are in the metric's raw unit;
 * never compare them with indexed or %-change values. Missing data is never green.
 *
 *   lower_is_better   G < Y : v ≤ G GREEN · G < v ≤ Y YELLOW · v > Y RED
 *   higher_is_better  Y < G : v < Y RED · Y ≤ v < G YELLOW · v ≥ G GREEN
 *   target_range      yMin < gMin ≤ gMax < yMax : gMin ≤ v ≤ gMax GREEN ·
 *                     yMin ≤ v < gMin or gMax < v ≤ yMax YELLOW · otherwise RED
 *
 * A version applies on [effectiveFrom, effectiveTo) — effectiveTo null = open-ended.
 */
export type RuleType = "lower_is_better" | "higher_is_better" | "target_range";
export type MetricStatus = "GREEN" | "YELLOW" | "RED" | "NO_THRESHOLD" | "NO_DATA";

/** Numbers (decimal strings from `numeric` columns are accepted and parsed once). */
export interface ThresholdRule {
  ruleType: RuleType;
  greenBound?: number | string | null;
  yellowBound?: number | string | null;
  greenMin?: number | string | null;
  greenMax?: number | string | null;
  yellowMin?: number | string | null;
  yellowMax?: number | string | null;
}

export interface ThresholdVersion extends ThresholdRule {
  id?: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export const RULE_LABEL: Record<RuleType, string> = {
  lower_is_better: "ยิ่งต่ำยิ่งดี",
  higher_is_better: "ยิ่งสูงยิ่งดี",
  target_range: "อยู่ในช่วงเป้าหมาย",
};

export const STATUS_LABEL: Record<MetricStatus, string> = {
  GREEN: "เขียว · ดี",
  YELLOW: "เหลือง · เฝ้าระวัง",
  RED: "แดง · เกินเกณฑ์",
  NO_THRESHOLD: "ยังไม่ตั้งเกณฑ์",
  NO_DATA: "ไม่มีข้อมูล",
};

const num = (x: number | string | null | undefined): number | null => {
  if (x == null || x === "") return null;
  const v = typeof x === "number" ? x : Number(x);
  return Number.isFinite(v) ? v : null;
};

/** Validation messages for a rule (empty = valid). */
export function validateRule(r: ThresholdRule): string[] {
  const g = num(r.greenBound);
  const y = num(r.yellowBound);
  switch (r.ruleType) {
    case "lower_is_better":
      if (g == null || y == null) return ["ต้องระบุขอบเขตสีเขียวและสีเหลือง"];
      return g < y ? [] : ["ยิ่งต่ำยิ่งดี: ขอบเขตเขียวต้องน้อยกว่าขอบเขตเหลือง (เขียว ≤ G < เหลือง ≤ Y < แดง)"];
    case "higher_is_better":
      if (g == null || y == null) return ["ต้องระบุขอบเขตสีเขียวและสีเหลือง"];
      return y < g ? [] : ["ยิ่งสูงยิ่งดี: ขอบเขตเหลืองต้องน้อยกว่าขอบเขตเขียว (แดง < Y ≤ เหลือง < G ≤ เขียว)"];
    case "target_range": {
      const [a, b, c, d] = [num(r.yellowMin), num(r.greenMin), num(r.greenMax), num(r.yellowMax)];
      if (a == null || b == null || c == null || d == null) return ["ต้องระบุช่วงเหลืองต่ำสุด เขียวต่ำสุด เขียวสูงสุด และเหลืองสูงสุด"];
      return a < b && b <= c && c < d ? [] : ["ช่วงเป้าหมาย: ต้องเป็น เหลืองต่ำสุด < เขียวต่ำสุด ≤ เขียวสูงสุด < เหลืองสูงสุด"];
    }
    default:
      return ["ประเภทเกณฑ์ไม่ถูกต้อง"];
  }
}

const f = (x: number) => String(x);

/** Status of one raw value under one rule (or none). */
export function evaluateThreshold(rawValue: number | string | null | undefined, rule: ThresholdRule | null | undefined): { status: MetricStatus; explanation: string } {
  const v = num(rawValue);
  if (v == null) return { status: "NO_DATA", explanation: "ไม่มีค่าที่ใช้ได้" };
  if (!rule) return { status: "NO_THRESHOLD", explanation: "ไม่มีเกณฑ์ที่มีผลในวันที่ของค่านี้" };
  const errs = validateRule(rule);
  if (errs.length) return { status: "NO_THRESHOLD", explanation: `เกณฑ์ไม่ถูกต้อง: ${errs[0]}` };
  if (rule.ruleType === "lower_is_better") {
    const g = num(rule.greenBound)!;
    const y = num(rule.yellowBound)!;
    if (v <= g) return { status: "GREEN", explanation: `${f(v)} ≤ ${f(g)} (ยิ่งต่ำยิ่งดี)` };
    if (v <= y) return { status: "YELLOW", explanation: `${f(g)} < ${f(v)} ≤ ${f(y)}` };
    return { status: "RED", explanation: `${f(v)} > ${f(y)}` };
  }
  if (rule.ruleType === "higher_is_better") {
    const g = num(rule.greenBound)!;
    const y = num(rule.yellowBound)!;
    if (v >= g) return { status: "GREEN", explanation: `${f(v)} ≥ ${f(g)} (ยิ่งสูงยิ่งดี)` };
    if (v >= y) return { status: "YELLOW", explanation: `${f(y)} ≤ ${f(v)} < ${f(g)}` };
    return { status: "RED", explanation: `${f(v)} < ${f(y)}` };
  }
  const [a, b, c, d] = [num(rule.yellowMin)!, num(rule.greenMin)!, num(rule.greenMax)!, num(rule.yellowMax)!];
  if (v >= b && v <= c) return { status: "GREEN", explanation: `${f(b)} ≤ ${f(v)} ≤ ${f(c)} (อยู่ในช่วงเป้าหมาย)` };
  if ((v >= a && v < b) || (v > c && v <= d)) return { status: "YELLOW", explanation: `อยู่นอกช่วงเขียว ${f(b)}–${f(c)} แต่ในช่วงเหลือง ${f(a)}–${f(d)}` };
  return { status: "RED", explanation: `นอกช่วง ${f(a)}–${f(d)}` };
}

/** The version in effect on `date` (YYYY-MM-DD): effectiveFrom ≤ date < effectiveTo. */
export function ruleForDate<V extends ThresholdVersion>(versions: V[], date: string): V | null {
  return versions.find((v) => v.effectiveFrom <= date && (v.effectiveTo == null || date < v.effectiveTo)) ?? null;
}

/** Status of an observation under the version that was in effect on its own date (never today's rule). */
export function statusOn(versions: ThresholdVersion[], date: string, value: number | string | null | undefined) {
  const rule = ruleForDate(versions, date);
  return { ...evaluateThreshold(value, rule), versionId: rule?.id ?? null };
}

/** Overlap / ordering problems in a version set (empty = consistent). */
export function versionConflicts(versions: ThresholdVersion[]): string[] {
  const s = [...versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const out: string[] = [];
  for (const v of s) if (v.effectiveTo != null && v.effectiveTo <= v.effectiveFrom) out.push(`ช่วง ${v.effectiveFrom} → ${v.effectiveTo} กลับด้าน`);
  for (let i = 1; i < s.length; i++) {
    const prevEnd = s[i - 1].effectiveTo;
    if (prevEnd == null || prevEnd > s[i].effectiveFrom) out.push(`เกณฑ์ที่เริ่ม ${s[i - 1].effectiveFrom} ทับกับเกณฑ์ที่เริ่ม ${s[i].effectiveFrom}`);
  }
  return out;
}

const DAY = 86_400_000;
/** Freshness is separate from status: a reading older than ~1.5 reporting periods is stale (irregular: never). */
export const STALE_AFTER_DAYS: Record<string, number | null> = { daily: 7, monthly: 45, quarterly: 135, annual: 455, irregular: null };

export function freshness(frequency: string, latestDate: string | null, today: string): { stale: boolean; ageDays: number | null; limitDays: number | null } {
  if (!latestDate) return { stale: false, ageDays: null, limitDays: STALE_AFTER_DAYS[frequency] ?? null };
  const age = Math.round((Date.parse(today) - Date.parse(latestDate)) / DAY);
  const limit = STALE_AFTER_DAYS[frequency] ?? null;
  return { stale: limit != null && age > limit, ageDays: age, limitDays: limit };
}
