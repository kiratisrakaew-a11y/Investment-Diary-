/**
 * Scale-safe transforms for custom-metric charts (pure). Observations are never interpolated,
 * forward-filled or zero-filled: dates without a reading stay null.
 */
export interface Obs {
  date: string; // YYYY-MM-DD (observedOn)
  value: number;
}

export interface MetricSeries {
  id: number;
  name: string;
  unit: string;
  points: Obs[];
}

export type ChartMode = "actual" | "indexed" | "change";

export const MODE_LABEL: Record<ChartMode, string> = {
  actual: "ค่าจริง",
  indexed: "Indexed (ฐาน 100)",
  change: "% เปลี่ยนจากค่าก่อนหน้า",
};

export const MODE_HELP: Record<ChartMode, string> = {
  actual: "ค่าที่บันทึกจริงในหน่วยของตัวชี้วัด",
  indexed: "100 × ค่า ÷ ค่าแรกในช่วงที่แสดง (เฉพาะเมื่อค่าแรก > 0) — เทียบทิศทางระหว่างตัวชี้วัดต่างหน่วย",
  change: "(ค่า − ค่าก่อนหน้าที่บันทึกจริง) ÷ |ค่าก่อนหน้า| × 100 — ไม่คำนวณเมื่อค่าก่อนหน้าเป็น 0 หรือเปลี่ยนเครื่องหมาย",
};

/** Sorted by date, finite values only, last entry wins on a duplicate date (callers prevent duplicates). */
export function clean(points: Obs[]): Obs[] {
  const m = new Map<string, number>();
  for (const p of points) if (/^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.value)) m.set(p.date, p.value);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

/** Observations within [from, to] (inclusive; null = open). */
export function inWindow(points: Obs[], from: string | null, to: string | null = null): Obs[] {
  return clean(points).filter((p) => (from == null || p.date >= from) && (to == null || p.date <= to));
}

/** Start date for 1Y / 3Y / 5Y / All relative to `today`. */
export function windowStart(range: "1Y" | "3Y" | "5Y" | "All", today: string): string | null {
  if (range === "All") return null;
  const y = Number(range[0]);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - y);
  return d.toISOString().slice(0, 10);
}

export type IndexedResult =
  | { ok: true; baseDate: string; baseValue: number; points: { date: string; value: number; raw: number }[] }
  | { ok: false; reason: string; baseDate: string | null };

/** index(t) = 100 × raw(t) / base, base = first observation in the window; refused when base ≤ 0. */
export function indexSeries(points: Obs[]): IndexedResult {
  const p = clean(points);
  if (!p.length) return { ok: false, reason: "ไม่มีข้อมูลในช่วงที่เลือก", baseDate: null };
  const base = p[0];
  if (!(base.value > 0)) return { ok: false, reason: `ค่าฐาน ${base.value} (${base.date}) ไม่เป็นบวก — ทำ index ไม่ได้ (จะให้ผลขึ้น/ลงที่ผิดความหมาย)`, baseDate: base.date };
  return { ok: true, baseDate: base.date, baseValue: base.value, points: p.map((x) => ({ date: x.date, value: (100 * x.value) / base.value, raw: x.value })) };
}

export interface ChangePoint {
  date: string;
  raw: number;
  /** % change vs the previous actual observation; null with a reason when not meaningful. */
  value: number | null;
  prevDate: string | null;
  reason: string | null;
}

/** % change between consecutive actual observations (no calendar gaps filled). */
export function pctChangeSeries(points: Obs[]): ChangePoint[] {
  const p = clean(points);
  return p.map((x, i) => {
    if (i === 0) return { date: x.date, raw: x.value, value: null, prevDate: null, reason: "ค่าแรก ไม่มีค่าก่อนหน้า" };
    const prev = p[i - 1];
    if (prev.value === 0) return { date: x.date, raw: x.value, value: null, prevDate: prev.date, reason: "ค่าก่อนหน้าเป็น 0 — หาร % ไม่ได้" };
    if (prev.value < 0 || x.value < 0) return { date: x.date, raw: x.value, value: null, prevDate: prev.date, reason: "ค่าติดลบหรือเปลี่ยนเครื่องหมาย — % เปลี่ยนแปลงไม่มีความหมาย ดูค่าจริงแทน" };
    return { date: x.date, raw: x.value, value: (100 * (x.value - prev.value)) / Math.abs(prev.value), prevDate: prev.date, reason: null };
  });
}

/** Units read as percentages: changes are shown in percentage points, not %. */
export const isPercentUnit = (unit: string) => /^\s*%\s*$|percent|เปอร์เซ็นต์/i.test(unit);

/** Latest vs previous actual observation, labelled correctly for the unit. */
export function latestChange(points: Obs[], unit: string): { latest: Obs | null; previous: Obs | null; delta: number | null; deltaLabel: "pp" | "unit"; relative: number | null } {
  const p = clean(points);
  const latest = p[p.length - 1] ?? null;
  const previous = p[p.length - 2] ?? null;
  if (!latest || !previous) return { latest, previous, delta: null, deltaLabel: isPercentUnit(unit) ? "pp" : "unit", relative: null };
  const delta = latest.value - previous.value;
  const pct = isPercentUnit(unit);
  const relative = !pct && previous.value > 0 && latest.value >= 0 ? delta / previous.value : null;
  return { latest, previous, delta, deltaLabel: pct ? "pp" : "unit", relative };
}

/** Rows on the sorted union of observed dates; a series without a reading on a date is null (no fill). */
export function unionRows(series: { key: string; points: { date: string; value: number | null }[] }[]): Record<string, string | number | null>[] {
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  const maps = series.map((s) => new Map(s.points.map((p) => [p.date, p.value])));
  return dates.map((date) => {
    const row: Record<string, string | number | null> = { date, t: Date.parse(`${date}T00:00:00Z`) };
    series.forEach((s, i) => (row[s.key] = maps[i].has(date) ? (maps[i].get(date) ?? null) : null));
    return row;
  });
}

export type ActualLayout = { kind: "single" } | { kind: "dual"; left: number[]; right: number[] } | { kind: "small_multiples"; reason: string } | { kind: "empty" };

/**
 * Actual-mode layout without misleading shared axes: one axis when every series has the same unit
 * and a comparable magnitude (≤ 10×), two axes for two scale groups, otherwise one mini-chart per metric.
 */
export function actualLayout(series: MetricSeries[]): ActualLayout {
  const s = series.filter((x) => x.points.length);
  if (!s.length) return { kind: "empty" };
  if (s.length === 1) return { kind: "single" };
  const mag = (x: MetricSeries) => Math.max(...x.points.map((p) => Math.abs(p.value)), 1e-12);
  const sameScale = (a: MetricSeries, b: MetricSeries) => a.unit.trim() === b.unit.trim() && Math.max(mag(a), mag(b)) / Math.min(mag(a), mag(b)) <= 10;
  const groups: MetricSeries[][] = [];
  for (const x of s) {
    const g = groups.find((gr) => gr.every((y) => sameScale(x, y)));
    if (g) g.push(x);
    else groups.push([x]);
  }
  if (groups.length === 1) return { kind: "single" };
  if (groups.length === 2) return { kind: "dual", left: groups[0].map((x) => x.id), right: groups[1].map((x) => x.id) };
  return { kind: "small_multiples", reason: `ตัวชี้วัดที่เลือกมี ${groups.length} หน่วย/สเกลต่างกัน — แสดงแยกทีละกราฟเพื่อไม่ให้แกนหลายแกนซ้อนกัน` };
}

/** Starting-date mismatch warning for indexed comparisons. */
export function baseDateWarning(bases: { name: string; baseDate: string | null }[]): string | null {
  const d = [...new Set(bases.map((b) => b.baseDate).filter(Boolean))];
  return d.length > 1 ? `ฐาน 100 เริ่มคนละวัน: ${bases.map((b) => `${b.name} ${b.baseDate ?? "–"}`).join(" · ")}` : null;
}

/** Threshold segments clipped to the chart's date span (for drawing step bands on the raw chart). */
export function thresholdSegments<V extends { effectiveFrom: string; effectiveTo?: string | null }>(versions: V[], from: string, to: string) {
  return versions
    .filter((v) => v.effectiveFrom <= to && (v.effectiveTo == null || v.effectiveTo > from))
    .map((v) => ({ version: v, x1: v.effectiveFrom > from ? v.effectiveFrom : from, x2: v.effectiveTo != null && v.effectiveTo <= to ? v.effectiveTo : to }));
}
