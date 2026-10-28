/**
 * Scale-safe transforms for custom-metric charts (pure). Observations are never interpolated,
 * forward-filled or zero-filled: dates without a reading stay null.
 */
import { STALE_AFTER_DAYS } from "./thresholds";

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
  indexed: "100 × ค่า ÷ ค่าแรกในช่วงที่แสดง (เฉพาะเมื่อค่าแรก > 0) — คำนวณแยกทีละตัวชี้วัด",
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

const DAY_MS = 86_400_000;
const ts = (d: string) => Date.parse(`${d}T00:00:00Z`);

export interface ChartRow {
  date: string;
  t: number;
  /** Plotted value in the chart's mode (null = not computable, or a gap marker). */
  value: number | null;
  /** Raw observed value on this date (null on a gap marker). */
  raw: number | null;
  /** Why `value` is null for a real observation (change mode). */
  reason?: string | null;
  /** Not an observation: a null row between two readings further apart than the metric's frequency. */
  gap?: true;
}

export interface SingleMetricChart {
  id: number;
  mode: ChartMode;
  /** This metric's own observations only (plus null gap markers); never another metric's. */
  rows: ChartRow[];
  /** Shown instead of a chart when nothing can be plotted. */
  empty: string | null;
  notes: string[];
  /** Y domain from this metric only (and, in actual mode, its own threshold bounds). */
  domain: [number, number] | null;
  /** Raw threshold bands are drawn only on the raw (actual) axis. */
  bands: boolean;
  baseDate: string | null;
  baseValue: number | null;
  /** Reference line: 100 for indexed, 0 for % change. */
  reference: number | null;
}

export interface SingleMetricInput {
  id: number;
  /** Observations already limited to the selected window. */
  points: Obs[];
  /** All observations of the metric (to tell "none yet" from "none in this window"). */
  observationCount: number;
  frequency?: string;
  thresholdBounds?: number[];
}

/** [min, max] with padding over finite values; null when there is nothing to scale. */
export function chartDomain(values: number[], extra: number[] = []): [number, number] | null {
  const all = [...values, ...extra].filter(Number.isFinite);
  if (!all.length) return null;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
  return [lo - pad, hi + pad];
}

/** Null markers between readings further apart than the frequency allows (no values are invented). */
function withGaps(rows: ChartRow[], frequency?: string): ChartRow[] {
  // Same per-frequency limits as freshness: a longer gap breaks the line unless "connect" is on.
  const limit = frequency ? STALE_AFTER_DAYS[frequency] : null;
  if (!limit) return rows;
  const out: ChartRow[] = [];
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    if (prev && (r.t - prev.t) / DAY_MS > limit) {
      const t = Math.round((prev.t + r.t) / 2 / DAY_MS) * DAY_MS;
      out.push({ date: new Date(t).toISOString().slice(0, 10), t, value: null, raw: null, gap: true });
    }
    out.push(r);
  });
  return out;
}

/**
 * Chart model for ONE metric in one mode. Every metric gets its own chart: nothing here combines
 * metrics, shares a scale or a second axis, or fills missing dates.
 */
export function singleMetricChart(m: SingleMetricInput, mode: ChartMode): SingleMetricChart {
  const pts = clean(m.points);
  const base = { id: m.id, mode, notes: [] as string[], bands: false, baseDate: null as string | null, baseValue: null as number | null, reference: mode === "indexed" ? 100 : mode === "change" ? 0 : null };
  const none = (empty: string, extra: Partial<SingleMetricChart> = {}): SingleMetricChart => ({ ...base, rows: [], domain: null, empty, ...extra });
  if (!m.observationCount) return none("ยังไม่มีค่าที่บันทึก");
  if (!pts.length) return none("ไม่มีค่าที่บันทึกในช่วงเวลาที่เลือก — ไม่มีการสร้างข้อมูลแทน");

  if (mode === "actual") {
    const rows = withGaps(pts.map((p) => ({ date: p.date, t: ts(p.date), value: p.value, raw: p.value })), m.frequency);
    return { ...base, rows, empty: null, bands: true, domain: chartDomain(pts.map((p) => p.value), m.thresholdBounds ?? []) };
  }
  if (mode === "indexed") {
    const r = indexSeries(pts);
    if (!r.ok) return none(r.reason, { baseDate: r.baseDate });
    const rows = withGaps(r.points.map((p) => ({ date: p.date, t: ts(p.date), value: p.value, raw: p.raw })), m.frequency);
    return { ...base, rows, empty: null, baseDate: r.baseDate, baseValue: r.baseValue, domain: chartDomain(r.points.map((p) => p.value), [100]) };
  }
  const c = pctChangeSeries(pts);
  const ok = c.filter((p) => p.value != null).map((p) => p.value as number);
  if (!ok.length) return none(pts.length === 1 ? "มีค่าเดียว — ต้องมีอย่างน้อย 2 ค่าจึงคำนวณ % เปลี่ยนแปลงได้" : (c.find((p, i) => i > 0 && p.reason)?.reason ?? "คำนวณ % เปลี่ยนแปลงไม่ได้"));
  const skipped = c.filter((p, i) => i > 0 && p.value == null);
  const rows = withGaps(c.map((p) => ({ date: p.date, t: ts(p.date), value: p.value, raw: p.raw, reason: p.reason })), m.frequency);
  return { ...base, rows, empty: null, notes: skipped.length ? [`${skipped.length} จุดคำนวณ % ไม่ได้ (${skipped[0].reason})`] : [], domain: chartDomain(ok, [0]) };
}

/** One chart model per metric, in the given order — the number of charts always equals the number of metrics. */
export function metricCharts(metrics: SingleMetricInput[], mode: ChartMode): SingleMetricChart[] {
  return metrics.map((m) => singleMetricChart(m, mode));
}

/** Threshold segments clipped to the chart's date span (for drawing step bands on the raw chart). */
export function thresholdSegments<V extends { effectiveFrom: string; effectiveTo?: string | null }>(versions: V[], from: string, to: string) {
  return versions
    .filter((v) => v.effectiveFrom <= to && (v.effectiveTo == null || v.effectiveTo > from))
    .map((v) => ({ version: v, x1: v.effectiveFrom > from ? v.effectiveFrom : from, x2: v.effectiveTo != null && v.effectiveTo <= to ? v.effectiveTo : to }));
}
