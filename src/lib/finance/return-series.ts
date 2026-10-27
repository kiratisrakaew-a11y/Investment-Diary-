/**
 * Shared return-series conventions (v3 Phase 1). Pure and deterministic; data access stays in services.
 *
 * - Works on index LEVELS per actual observation date, never on forward-filled prices; aligning two
 *   series takes the intersection of their actual dates and compounds across gaps (a missing print
 *   gives a multi-day return, never an artificial zero).
 * - price_return: split-consistent closes; distributions are never added.
 * - total_return: EITHER the provider's dividend-adjusted series (adjusted_close) OR closes plus
 *   explicit per-unit distributions on their ex-dates — never both (rejected as double counting).
 * - Foreign currency → THB: 1 + R_THB = (1 + R_local)(1 + R_FX), FX taken on the same date (or the
 *   last fixing within `maxFxStaleDays`, flagged). THB assets are never converted.
 * The portfolio NAV/TWR path (ledger, `buildValueSeries`) is separate: it already includes cash income.
 */

export type ReturnBasis = "price_return" | "total_return";
export type TotalReturnSource = "adjusted_close" | "distributions";

export interface PriceObservation {
  date: string;
  close: number;
  adjClose?: number | null;
}

export interface ReturnSeriesInput {
  label: string;
  observations: PriceObservation[];
  basis: ReturnBasis;
  /** Required for total_return. */
  totalReturnSource?: TotalReturnSource;
  /** Per-unit cash distributions (local currency) on their ex-dates; only with totalReturnSource = distributions. */
  distributions?: { exDate: string; amount: number }[];
  currency: "THB" | "USD";
  /** THB per 1 unit of `currency` (ascending [date, rate]); required for non-THB. */
  fx?: [string, number][];
  maxFxStaleDays?: number;
  source?: string;
}

export interface LevelSeries {
  ok: true;
  label: string;
  /** THB index level per actual observation date (first = 1). */
  levels: [string, number][];
  basis: ReturnBasis;
  totalReturnSource: TotalReturnSource | null;
  currency: "THB";
  sourceCurrency: "THB" | "USD";
  coverage: { observations: number; first: string | null; last: string | null; fxStale: number };
  warnings: string[];
  provenance: { source: string | null; priceField: "close" | "adj_close"; incomeFromDistributions: boolean; fx: "none" | "same_date_or_recent" };
}

export interface Unavailable {
  ok: false;
  status: "unavailable" | "invalid";
  label: string;
  reason: string;
  required?: string;
}

const DAY = 86_400_000;

/** Last value at or before `date` within `maxDays` (ascending series); null otherwise. */
function recentAtOrBefore(series: [string, number][], date: string, maxDays: number): { value: number; stale: boolean } | null {
  let lo = 0;
  let hi = series.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] <= date) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (idx < 0) return null;
  const gap = (Date.parse(date) - Date.parse(series[idx][0])) / DAY;
  return gap <= maxDays ? { value: series[idx][1], stale: gap > 0 } : null;
}

/** Index levels (THB) under the requested basis, or a typed unavailable / invalid result. */
export function buildLevelSeries(x: ReturnSeriesInput): LevelSeries | Unavailable {
  const warnings: string[] = [];
  const obs = [...x.observations].sort((a, b) => (a.date < b.date ? -1 : 1));
  const no = (status: Unavailable["status"], reason: string, required?: string): Unavailable => ({ ok: false, status, label: x.label, reason, required });
  if (obs.length < 2) return no("unavailable", "มีราคาน้อยกว่า 2 วัน", "ราคาย้อนหลังอย่างน้อย 2 วัน");
  for (let i = 1; i < obs.length; i++) if (obs[i].date === obs[i - 1].date) return no("invalid", `วันที่ซ้ำ ${obs[i].date}`);
  if (obs.some((o) => !(o.close > 0))) return no("invalid", "มีราคาปิดที่ไม่เป็นบวก");

  let field: "close" | "adj_close" = "close";
  let useDist = false;
  if (x.basis === "price_return") {
    if (x.distributions?.length) warnings.push("price_return ไม่รวมเงินปันผล — ข้อมูลปันผลที่ส่งมาไม่ถูกใช้");
  } else {
    if (!x.totalReturnSource) return no("invalid", "total_return ต้องระบุแหล่ง: adjusted_close หรือ distributions");
    if (x.totalReturnSource === "adjusted_close") {
      if (x.distributions?.length) return no("invalid", "ใช้ราคาปรับปันผลร่วมกับเงินปันผลจะนับปันผลซ้ำ — เลือกอย่างใดอย่างหนึ่ง");
      const missing = obs.filter((o) => !(o.adjClose != null && o.adjClose > 0)).length;
      if (missing) return no("unavailable", `ไม่มีราคาปรับปันผล (adj_close) ${missing} จาก ${obs.length} วัน`, "sync_historical_prices ด้วย priceType: adjusted_close ให้ครบช่วง");
      field = "adj_close";
    } else {
      if (!x.distributions) return no("unavailable", "total_return แบบ distributions ต้องมีข้อมูลเงินปันผลต่อหน่วยตามวัน XD", "รายการปันผลต่อหน่วย (exDate, amount)");
      if (x.distributions.some((d) => !(d.amount >= 0))) return no("invalid", "เงินปันผลต่อหน่วยต้องไม่ติดลบ");
      useDist = true;
    }
  }

  // FX per observation date.
  const maxStale = x.maxFxStaleDays ?? 5;
  let fxStale = 0;
  const fxAt = (date: string): number | null => {
    if (x.currency === "THB") return 1;
    const r = x.fx?.length ? recentAtOrBefore(x.fx, date, maxStale) : null;
    if (r?.stale) fxStale++;
    return r?.value ?? null;
  };

  const levels: [string, number][] = [];
  let level = 1;
  let prevPrice = field === "adj_close" ? obs[0].adjClose! : obs[0].close;
  let prevFx = fxAt(obs[0].date);
  if (prevFx == null) return no("unavailable", `ไม่มีอัตรา ${x.currency}THB ใกล้วันที่ ${obs[0].date} (≤ ${maxStale} วัน)`, `อัตราแลกเปลี่ยน ${x.currency}THB`);
  levels.push([obs[0].date, level]);
  const dist = useDist ? [...x.distributions!].sort((a, b) => (a.exDate < b.exDate ? -1 : 1)) : [];
  let di = 0;
  while (di < dist.length && dist[di].exDate <= obs[0].date) di++;
  for (let i = 1; i < obs.length; i++) {
    const price = field === "adj_close" ? obs[i].adjClose! : obs[i].close;
    let income = 0;
    // Distributions with ex-date in (previous date, this date] belong to this period, exactly once.
    while (di < dist.length && dist[di].exDate <= obs[i].date) income += dist[di++].amount;
    const fx = fxAt(obs[i].date);
    if (fx == null) return no("unavailable", `ไม่มีอัตรา ${x.currency}THB ใกล้วันที่ ${obs[i].date} (≤ ${maxStale} วัน)`, `อัตราแลกเปลี่ยน ${x.currency}THB`);
    const rLocal = (price + income) / prevPrice - 1;
    const rFx = fx / prevFx - 1;
    level *= (1 + rLocal) * (1 + rFx);
    levels.push([obs[i].date, level]);
    prevPrice = price;
    prevFx = fx;
  }
  if (fxStale) warnings.push(`${x.label}: ใช้อัตราแลกเปลี่ยนวันก่อนหน้า ${fxStale} วัน (ไม่มีอัตราวันเดียวกัน)`);
  if (useDist && di < dist.length) warnings.push(`${x.label}: เงินปันผล ${dist.length - di} รายการหลังวันสุดท้ายของราคา — ไม่นับ`);
  return {
    ok: true,
    label: x.label,
    levels,
    basis: x.basis,
    totalReturnSource: x.basis === "total_return" ? x.totalReturnSource! : null,
    currency: "THB",
    sourceCurrency: x.currency,
    coverage: { observations: obs.length, first: obs[0].date, last: obs[obs.length - 1].date, fxStale },
    warnings,
    provenance: { source: x.source ?? null, priceField: field, incomeFromDistributions: useDist, fx: x.currency === "THB" ? "none" : "same_date_or_recent" },
  };
}

/** Dates present in every series (actual prints only), ascending. */
export function commonDates(series: [string, number][][]): string[] {
  if (!series.length) return [];
  const sets = series.slice(1).map((s) => new Set(s.map(([d]) => d)));
  return series[0].map(([d]) => d).filter((d) => sets.every((x) => x.has(d))).sort();
}

/** Simple returns between consecutive given dates from level series (compounds across gaps). */
export function returnsOn(levels: [string, number][], dates: string[]): number[] {
  const m = new Map(levels);
  const out: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const a = m.get(dates[i - 1]);
    const b = m.get(dates[i]);
    out.push(a != null && b != null && a > 0 ? b / a - 1 : NaN);
  }
  return out;
}

/**
 * Asset and benchmark returns on their common actual dates (no forward-fill), for β / regression.
 * `assetDates` restricts the asset side (e.g. the optimizer's common calendar).
 */
export function alignWithBenchmark(asset: [string, number][], benchmark: [string, number][], assetDates?: string[]) {
  const bset = new Set(benchmark.map(([d]) => d));
  const base = assetDates ?? asset.map(([d]) => d);
  const dates = base.filter((d) => bset.has(d));
  return { dates, asset: returnsOn(asset, dates), benchmark: returnsOn(benchmark, dates), droppedDates: base.length - dates.length };
}
