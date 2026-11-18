/**
 * Price vs custom metric (pure): chart rows on one time axis and the correlation between the price
 * return and the metric change over each interval between consecutive metric readings.
 * Readings are never filled or interpolated; a price is matched only within `maxGapDays`.
 */
import { correlation } from "../finance/stats";
import { isPercentUnit } from "./series";

export interface PricePoint {
  date: string;
  close: number;
}
export interface MetricReading {
  observedOn: string;
  value: number;
  publishedOn?: string | null;
}

export const MIN_CORRELATION_PAIRS = 8;
const DAY = 86_400_000;
const ts = (d: string) => Date.parse(`${d}T00:00:00Z`);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Rows on the union of price dates and metric reading dates (numeric time axis).
 * Each metric key is set only on its own reading dates (null elsewhere — no fill); readings outside
 * the price range are left out and counted.
 */
export function priceMetricRows(prices: PricePoint[], metrics: { key: string; readings: MetricReading[] }[]) {
  const px = prices.filter((p) => finite(p.close)).sort((a, b) => a.date.localeCompare(b.date));
  const first = px[0]?.date;
  const last = px[px.length - 1]?.date;
  const outside: Record<string, number> = {};
  const rows = new Map<string, Record<string, number | string | null>>();
  const row = (date: string) => {
    let r = rows.get(date);
    if (!r) rows.set(date, (r = { date, t: ts(date), price: null }));
    return r;
  };
  for (const p of px) row(p.date).price = p.close;
  for (const m of metrics) {
    outside[m.key] = 0;
    for (const o of m.readings) {
      if (!finite(o.value)) continue;
      if (!first || o.observedOn < first || o.observedOn > last!) {
        outside[m.key]++;
        continue;
      }
      row(o.observedOn)[m.key] = o.value;
    }
  }
  const out = [...rows.values()].sort((a, b) => (a.t as number) - (b.t as number));
  for (const r of out) for (const m of metrics) if (!(m.key in r)) r[m.key] = null;
  return { rows: out, outside };
}

/** Last close on or before `date`, and how many days earlier it was. */
function priceAt(px: PricePoint[], date: string): { close: number; gap: number } | null {
  let lo = 0;
  let hi = px.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (px[mid].date <= date) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return null;
  return { close: px[best].close, gap: Math.round((ts(date) - ts(px[best].date)) / DAY) };
}

export type CorrelationBasis = "observed" | "published";

export interface MetricPriceCorrelation {
  r: number | null;
  n: number;
  strength: "อ่อน" | "ปานกลาง" | "สูง" | null;
  basis: CorrelationBasis;
  /** How the metric change was measured. */
  change: "pp" | "percent" | "mixed";
  skipped: { noPrice: number; noPublishedDate: number };
  reason: string | null;
  warnings: string[];
}

/**
 * Pearson r between Δmetric and the price return over each interval between consecutive readings.
 * % units use the difference in percentage points; other units the relative change, or the plain
 * difference when the earlier value is ≤ 0 (a relative change is not meaningful there).
 */
export function metricPriceCorrelation(
  prices: PricePoint[],
  readings: MetricReading[],
  unit: string,
  opts: { basis?: CorrelationBasis; maxGapDays?: number; minPairs?: number } = {},
): MetricPriceCorrelation {
  const basis = opts.basis ?? "observed";
  const maxGap = opts.maxGapDays ?? 10;
  const minPairs = opts.minPairs ?? MIN_CORRELATION_PAIRS;
  const pct = isPercentUnit(unit);
  const px = prices.filter((p) => finite(p.close) && p.close > 0).sort((a, b) => a.date.localeCompare(b.date));
  const skipped = { noPrice: 0, noPublishedDate: 0 };
  // Each reading with the date its price is matched on.
  const points: { value: number; price: number }[] = [];
  for (const o of [...readings].filter((o) => finite(o.value)).sort((a, b) => a.observedOn.localeCompare(b.observedOn))) {
    const d = basis === "published" ? o.publishedOn : o.observedOn;
    if (!d) {
      skipped.noPublishedDate++;
      continue;
    }
    const p = priceAt(px, d);
    if (!p || p.gap > maxGap) {
      skipped.noPrice++;
      continue;
    }
    points.push({ value: o.value, price: p.close });
  }
  const dm: number[] = [];
  const dp: number[] = [];
  let usedDiff = false;
  let usedRel = false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    dp.push(b.price / a.price - 1);
    if (pct || !(a.value > 0)) {
      dm.push(b.value - a.value);
      usedDiff = true;
    } else {
      dm.push(b.value / a.value - 1);
      usedRel = true;
    }
  }
  const n = dm.length;
  const warnings: string[] = [];
  if (skipped.noPrice) warnings.push(`${skipped.noPrice} ค่าไม่มีราคาภายใน ${maxGap} วันก่อนวันนั้น — ไม่นับ`);
  if (skipped.noPublishedDate) warnings.push(`${skipped.noPublishedDate} ค่าไม่มีวันประกาศ — ไม่นับ`);
  const change: MetricPriceCorrelation["change"] = pct ? "pp" : usedDiff && usedRel ? "mixed" : usedDiff ? "pp" : "percent";
  if (!pct && usedDiff && usedRel) warnings.push("บางช่วงค่าก่อนหน้า ≤ 0 จึงใช้ส่วนต่างแทน % เปลี่ยนแปลง");
  if (n < minPairs) return { r: null, n, strength: null, basis, change, skipped, reason: `ข้อมูลน้อยเกินไป: มี ${n} ช่วง ต้องมีอย่างน้อย ${minPairs} ช่วงจึงแสดงค่า correlation`, warnings };
  const r = correlation(dm, dp);
  if (!finite(r) || dm.every((v) => v === dm[0]) || dp.every((v) => v === dp[0]))
    return { r: null, n, strength: null, basis, change, skipped, reason: "ค่าใดค่าหนึ่งไม่เปลี่ยนเลยในช่วงนี้ — คำนวณ correlation ไม่ได้", warnings };
  const a = Math.abs(r);
  return { r, n, strength: a < 0.3 ? "อ่อน" : a < 0.6 ? "ปานกลาง" : "สูง", basis, change, skipped, reason: null, warnings };
}
