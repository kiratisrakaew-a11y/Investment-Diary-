/**
 * View model for the asset page's abnormal-trading section (pure, testable without a DOM).
 * Takes the JSON of GET /api/v1/assets/{id}/abnormal (the same service as the MCP tools) and only
 * selects / formats — no statistic is recomputed here.
 */
import type { Level } from "./volume";

export interface OverviewDay {
  date: string;
  ar: number | null;
  tAR: number | null;
  car5: number | null;
  tCAR5: number | null;
  z: number | null;
  volume: number | null;
  level: Level;
  reasons: string[];
  missing: string[];
  warnings: string[];
  sigma: number | null;
  preEvent: {
    tradingDays: number;
    event: { date: string; type: string; description: string };
  } | null;
}
export interface OverviewFlag extends Omit<OverviewDay, "missing"> {
  beta: number | null;
  n: number | null;
  preEventLabel: string | null;
}
export interface OverviewEvent {
  id: number | null;
  eventDate: string;
  eventType: string;
  description: string;
  source: string | null;
  origin: string;
}
export interface AbnormalOverview {
  modelLabel: string;
  estimationWindow: [number, number];
  thresholds: { notable: number; abnormal: number };
  criteria: Record<string, string>;
  stock: {
    symbol: string;
    level: Level;
    benchmark: {
      basis: "total_return" | "price";
      symbol: string;
      label: string;
    };
    volumeBasis: "turnover" | "raw_volume";
    coverage: { days: number; withAR: number; withVolumeZ: number };
    flagged: OverviewFlag[];
    volumeOnly: { date: string; z: number; note: string }[];
    days: OverviewDay[];
    warnings: string[];
  };
  events: OverviewEvent[];
  sharesOutstanding: {
    effectiveDate: string;
    shares: number;
    source: string;
  }[];
  disclaimer: string;
}

export type ViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "insufficient"; reasons: string[] }
  | { kind: "no_flags"; limits: string[] }
  | { kind: "flags"; limits: string[] };

/** Which of the section's states to show. "limits" = what could not be computed even though something could. */
export function viewState(
  data: AbnormalOverview | null,
  error: string | null,
  loading: boolean,
): ViewState {
  if (loading && !data) return { kind: "loading" };
  if (error) return { kind: "error", message: error };
  if (!data) return { kind: "loading" };
  const c = data.stock.coverage;
  if (c.days === 0)
    return { kind: "insufficient", reasons: ["ยังไม่มีประวัติราคา"] };
  if (c.withAR === 0 && c.withVolumeZ === 0)
    return {
      kind: "insufficient",
      reasons: data.stock.warnings.length
        ? data.stock.warnings
        : ["ข้อมูลย้อนหลังไม่พอสำหรับ estimation window"],
    };
  const limits: string[] = [];
  if (c.withAR === 0)
    limits.push(
      "คำนวณ AR / CAR ไม่ได้ — ข้อมูลดัชนีตลาดย้อนหลังไม่พอ (แสดงเฉพาะ volume)",
    );
  if (c.withVolumeZ === 0)
    limits.push(
      "คำนวณ volume z ไม่ได้ — ไม่มี volume หรือประวัติไม่พอ (แสดงเฉพาะ AR)",
    );
  return data.stock.flagged.length
    ? { kind: "flags", limits }
    : { kind: "no_flags", limits };
}

export const ts = (d: string) => Date.parse(`${d}T00:00:00Z`);
export type RangeKey = "1Y" | "3Y" | "5Y" | "ALL";
export const RANGES: { key: RangeKey; label: string; years: number | null }[] =
  [
    { key: "1Y", label: "1 ปี", years: 1 },
    { key: "3Y", label: "3 ปี", years: 3 },
    { key: "5Y", label: "5 ปี", years: 5 },
    { key: "ALL", label: "ทั้งหมด", years: null },
  ];

/** x-axis domain [from, to] in ms shared by every chart; ALL = first to last price date. */
export function rangeDomain(
  priceDates: string[],
  key: RangeKey,
): [number, number] | null {
  if (!priceDates.length) return null;
  const last = priceDates[priceDates.length - 1];
  const years = RANGES.find((r) => r.key === key)?.years ?? null;
  const first = priceDates[0];
  if (years == null) return [ts(first), ts(last)];
  const d = new Date(ts(last));
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return [Math.max(ts(first), d.getTime()), ts(last)];
}
export const inDomain = (date: string, dom: [number, number] | null) =>
  !dom || (ts(date) >= dom[0] && ts(date) <= dom[1]);

export interface ChartRow {
  t: number;
  date: string;
  arPct: number | null;
  car5Pct: number | null;
  /** ±2σ(ε) in % — the band beyond which |t_AR| > 2. */
  bandPct: number | null;
  negBandPct: number | null;
  z: number | null;
  volume: number | null;
  level: Level;
}

/**
 * One row per price date inside the domain (the same x values as the price chart, so the charts'
 * cursors match exactly); a date without a scan value keeps nulls — nothing is filled in.
 */
export function chartRows(
  priceDates: string[],
  days: OverviewDay[],
  dom: [number, number] | null,
): ChartRow[] {
  const by = new Map(days.map((d) => [d.date, d]));
  return priceDates
    .filter((d) => inDomain(d, dom))
    .map((date) => {
      const d = by.get(date);
      const pct = (v: number | null | undefined) =>
        v == null ? null : v * 100;
      return {
        t: ts(date),
        date,
        arPct: pct(d?.ar),
        car5Pct: pct(d?.car5),
        bandPct: d?.sigma != null && d.ar != null ? d.sigma * 200 : null,
        negBandPct: d?.sigma != null && d.ar != null ? -d.sigma * 200 : null,
        z: d?.z ?? null,
        volume: d?.volume ?? null,
        level: d?.level ?? "ปกติ",
      };
    });
}

/** Badge: the latest day's level, and how many flagged days fall in the visible range. */
export function statusBadge(
  data: AbnormalOverview,
  dom: [number, number] | null,
) {
  const inRange = data.stock.flagged.filter((f) => inDomain(f.date, dom));
  const abnormal = inRange.filter((f) => f.level === "ผิดปกติ").length;
  const notable = inRange.filter((f) => f.level === "น่าสังเกต").length;
  const latest =
    [...data.stock.days].reverse().find((d) => d.tAR != null || d.z != null) ??
    null;
  const worst: Level = abnormal ? "ผิดปกติ" : notable ? "น่าสังเกต" : "ปกติ";
  return {
    worst,
    abnormal,
    notable,
    latestDate: latest?.date ?? null,
    latestLevel: latest?.level ?? null,
    text:
      abnormal || notable
        ? `ในช่วงที่แสดง: ผิดปกติ ${abnormal} วัน · น่าสังเกต ${notable} วัน`
        : "ในช่วงที่แสดงไม่พบวันที่ผิดปกติ",
  };
}

/** Flag table rows within the range (service order: level, strength, newest), and how many are outside it. */
export function flagRows(data: AbnormalOverview, dom: [number, number] | null) {
  const rows = data.stock.flagged.filter((f) => inDomain(f.date, dom));
  return { rows, hidden: data.stock.flagged.length - rows.length };
}

export interface Marker {
  t: number;
  date: string;
  kind: "event" | "flag";
  level?: Level;
  label: string;
}

/** Event lines and flag dots for the price chart, inside the range. */
export function markers(
  data: AbnormalOverview,
  dom: [number, number] | null,
): Marker[] {
  const ev: Marker[] = data.events
    .filter((e) => inDomain(e.eventDate, dom))
    .map((e) => ({
      t: ts(e.eventDate),
      date: e.eventDate,
      kind: "event",
      label: `${EVENT_LABEL[e.eventType] ?? e.eventType}${e.description ? `: ${e.description}` : ""}`,
    }));
  const fl: Marker[] = data.stock.flagged
    .filter((f) => inDomain(f.date, dom))
    .map((f) => ({
      t: ts(f.date),
      date: f.date,
      kind: "flag",
      level: f.level,
      label: f.reasons.join(" · "),
    }));
  return [...ev, ...fl].sort((a, b) => a.t - b.t);
}

export const EVENT_LABEL: Record<string, string> = {
  earnings: "ประกาศงบ",
  ma: "M&A",
  xd: "XD",
  news: "ข่าว",
  other: "อื่น ๆ",
};
export const LEVEL_COLOR: Record<Level, string> = {
  ผิดปกติ: "var(--neg)",
  น่าสังเกต: "var(--warn)",
  ปกติ: "var(--muted)",
};

/** Every caveat of the section (benchmark, volume basis, coverage) for the settings / data-quality panel. */
export function qualityNotes(data: AbnormalOverview) {
  const notes = [...data.stock.warnings];
  if (
    data.stock.volumeBasis === "raw_volume" &&
    !notes.some((w) => /raw volume/.test(w))
  )
    notes.push("ใช้ raw volume แทน turnover");
  return notes;
}

export const fmtPct = (v: number | null, d = 2) =>
  v == null ? "–" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
export const fmtT = (v: number | null) => (v == null ? "–" : v.toFixed(2));
