/**
 * Pure helpers for historical price synchronization: date-range resolution, write planning
 * (dedupe / overwrite / fill missing adjusted values), coverage statistics, corporate-action
 * warnings and retry with exponential backoff.
 */

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export const MAX_SYNC_DAYS = 3660;

export class PriceSyncError extends Error {
  constructor(
    public code: "INVALID_RANGE" | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "PriceSyncError";
  }
}

export type PriceType = "close" | "adjusted_close";

export interface SyncRange {
  from: string;
  to: string;
}

/** Range from explicit dates or a look-back window (default 365 days ending today). */
export function resolveSyncRange(o: { startDate?: string; endDate?: string; lookbackDays?: number }, today: string): SyncRange {
  for (const d of [o.startDate, o.endDate]) {
    if (d != null && !isIsoDate(d)) throw new PriceSyncError("INVALID_RANGE", `วันที่ ${d} ต้องเป็นรูปแบบ YYYY-MM-DD`);
  }
  const to = o.endDate ?? today;
  if (to > today) throw new PriceSyncError("INVALID_RANGE", `วันสิ้นสุด ${to} อยู่ในอนาคต`);
  const look = o.lookbackDays ?? 365;
  if (!(Number.isInteger(look) && look >= 1)) throw new PriceSyncError("INVALID_RANGE", "lookbackDays ต้องเป็นจำนวนเต็ม ≥ 1");
  const from = o.startDate ?? iso(Date.parse(to) - look * DAY);
  if (from > to) throw new PriceSyncError("INVALID_RANGE", `วันเริ่ม ${from} อยู่หลังวันสิ้นสุด ${to}`);
  const span = (Date.parse(to) - Date.parse(from)) / DAY;
  if (span > MAX_SYNC_DAYS) throw new PriceSyncError("INVALID_RANGE", `ช่วงวันที่ยาว ${Math.round(span)} วัน เกินสูงสุด ${MAX_SYNC_DAYS} วัน — แบ่งดึงเป็นหลายช่วง`);
  return { from, to };
}

export interface PricePoint {
  date: string;
  close: number;
  adjClose: number | null;
}

export interface WritePlan {
  inserts: PricePoint[];
  updates: PricePoint[];
  /** Dates already stored and left as they are (overwrite = false). */
  skippedExisting: number;
  /** Of those, how many differ from the provider (kept because overwrite = false). */
  changedButKept: number;
  /** Stored and identical to the provider. */
  unchanged: number;
  /** Provider rows rejected (non-positive / non-finite close). */
  invalid: number;
}

const same = (a: number | null, b: number | null) => (a == null || b == null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));

/**
 * Decide what to write. Rules:
 * - new dates are inserted (adjusted value only when priceType = adjusted_close);
 * - overwrite = false never changes a stored value, but fills a missing adjusted value;
 * - overwrite = true replaces values that differ; identical rows are not rewritten.
 */
export function planWrites(existing: Map<string, { close: number; adjClose: number | null }>, fetched: PricePoint[], o: { overwrite: boolean; priceType: PriceType }): WritePlan {
  const plan: WritePlan = { inserts: [], updates: [], skippedExisting: 0, changedButKept: 0, unchanged: 0, invalid: 0 };
  const wantAdj = o.priceType === "adjusted_close";
  for (const f of fetched) {
    if (!(Number.isFinite(f.close) && f.close > 0)) {
      plan.invalid++;
      continue;
    }
    const adj = wantAdj && f.adjClose != null && Number.isFinite(f.adjClose) && f.adjClose > 0 ? f.adjClose : null;
    const cur = existing.get(f.date);
    if (!cur) {
      plan.inserts.push({ date: f.date, close: f.close, adjClose: adj });
      continue;
    }
    if (o.overwrite) {
      const next = { date: f.date, close: f.close, adjClose: wantAdj ? adj : cur.adjClose };
      if (same(cur.close, next.close) && same(cur.adjClose, next.adjClose)) plan.unchanged++;
      else plan.updates.push(next);
      continue;
    }
    plan.skippedExisting++;
    if (!same(cur.close, f.close)) plan.changedButKept++;
    if (wantAdj && cur.adjClose == null && adj != null) plan.updates.push({ date: f.date, close: cur.close, adjClose: adj });
  }
  return plan;
}

export interface Coverage {
  observations: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Largest calendar-day gap between consecutive observations. */
  largestGapDays: number;
  /** Days between the last observation and the end of the range (or today). */
  staleDays: number | null;
}

export function coverage(dates: string[], range: SyncRange, today: string): Coverage {
  const ds = dates.filter((d) => d >= range.from && d <= range.to).sort();
  let gap = 0;
  for (let i = 1; i < ds.length; i++) gap = Math.max(gap, (Date.parse(ds[i]) - Date.parse(ds[i - 1])) / DAY);
  const end = range.to < today ? range.to : today;
  return {
    observations: ds.length,
    firstDate: ds[0] ?? null,
    lastDate: ds[ds.length - 1] ?? null,
    largestGapDays: gap,
    staleDays: ds.length ? (Date.parse(end) - Date.parse(ds[ds.length - 1])) / DAY : null,
  };
}

/** Warnings for corporate actions found in the synced range; no data is synthesized. */
export function corporateActionWarnings(
  symbol: string,
  splits: { date: string; numerator: number; denominator: number }[],
  dividends: { date: string; amount: number }[],
  held: boolean,
): string[] {
  const out: string[] = [];
  for (const s of splits) {
    out.push(
      `${symbol}: split ${s.numerator}:${s.denominator} วันที่ ${s.date} — ราคา close จาก Yahoo ปรับตาม split แล้ว` +
        (held
          ? ` แต่จำนวนหุ้นยังไม่ถูกปรับ — บันทึก "แตกพาร์" ${s.denominator}:${s.numerator} (หน้ารายการ หรือ record_split) ระบบจะปรับจำนวนหุ้นและราคาย้อนหลังให้`
          : ""),
    );
  }
  if (dividends.length) {
    out.push(`${symbol}: มีปันผล ${dividends.length} ครั้งในช่วงนี้ (${dividends.map((d) => `${d.date} ${d.amount}`).join(", ")}) — ราคา close ไม่รวมปันผล ใช้ adjusted_close ถ้าต้องการผลตอบแทนรวม`);
  }
  return out;
}

/** Retry an async call with exponential backoff (baseMs, 2·baseMs, …). */
export async function withRetry<T>(fn: () => Promise<T>, o: { attempts: number; baseMs: number; sleep: (ms: number) => Promise<void> }): Promise<T> {
  let last: unknown;
  for (let i = 0; i < o.attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < o.attempts - 1) await o.sleep(o.baseMs * 2 ** i);
    }
  }
  throw last;
}

// ------------------------------------------------------------------ splits (corporate actions)

export interface SplitRepairPlan {
  /** unadjusted: stored prices before the date are at the old level and will be divided by the ratio. */
  status: "unadjusted" | "already_adjusted" | "ambiguous" | "no_data";
  observedRatio: number | null;
  before: { date: string; close: number } | null;
  after: { date: string; close: number } | null;
  updates: { date: string; close: number; adjClose: number | null }[];
  message: string;
}

/**
 * Decide whether stored prices before a split date still sit at the pre-split level.
 * Compares the last close before `date` with the first close on/after it: a gap near the ratio
 * means unadjusted (divide earlier rows by the ratio); no gap means already adjusted (e.g. Yahoo
 * re-sync). Idempotent: after a repair the gap disappears and the plan is empty.
 */
export function planSplitPriceRepair(rows: { date: string; close: number; adjClose: number | null }[], date: string, ratio: number): SplitRepairPlan {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const before = [...sorted].reverse().find((r) => r.date < date) ?? null;
  const after = sorted.find((r) => r.date >= date) ?? null;
  const base = { before: before && { date: before.date, close: before.close }, after: after && { date: after.date, close: after.close } };
  if (!before) return { status: "no_data", observedRatio: null, ...base, updates: [], message: "ไม่มีราคาก่อนวันแตกพาร์ — ไม่ต้องปรับ" };
  if (!after) return { status: "no_data", observedRatio: null, ...base, updates: [], message: "ยังไม่มีราคาหลังวันแตกพาร์ — ดึงราคาหลังวันนั้นก่อนแล้วตรวจอีกครั้ง" };
  const observed = before.close / after.close;
  const dU = Math.abs(Math.log(observed / ratio));
  const dA = Math.abs(Math.log(observed));
  // Within ~±19% of the ratio (for 2×) counts as a match; anything in between is left to the user.
  const margin = Math.abs(Math.log(ratio)) / 4;
  if (dU < dA && dU < margin) {
    const updates = sorted.filter((r) => r.date < date).map((r) => ({ date: r.date, close: r.close / ratio, adjClose: r.adjClose != null ? r.adjClose / ratio : null }));
    return { status: "unadjusted", observedRatio: observed, ...base, updates, message: `ราคาก่อน ${date} ยังไม่ปรับ (ต่างกัน ${observed.toFixed(3)}×) — หารด้วย ${ratio} จำนวน ${updates.length} วัน` };
  }
  if (dA <= dU && dA < margin) return { status: "already_adjusted", observedRatio: observed, ...base, updates: [], message: "ราคาย้อนหลังปรับตามการแตกพาร์แล้ว — ไม่ต้องแก้" };
  return { status: "ambiguous", observedRatio: observed, ...base, updates: [], message: `ราคาก่อน/หลังต่างกัน ${observed.toFixed(3)}× ไม่ตรงกับอัตรา ${ratio} หรือ 1 — ไม่แก้ให้อัตโนมัติ ตรวจราคาก่อน` };
}

const SPLIT_FACTORS = [2, 3, 4, 5, 10, 20, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10, 1 / 20];

/**
 * Day-to-day price gaps that look like an unrecorded split (≈ 2×, 5×, 10×, 1/10× … within 8%).
 * Exchanges' daily limits (SET ±30%) make such moves implausible as real returns.
 */
export function detectUnrecordedSplits(series: [string, number][], recordedSplitDates: string[], toleranceDays = 7) {
  const out: { date: string; previousDate: string; factor: number; observed: number }[] = [];
  const near = (d: string) => recordedSplitDates.some((s) => Math.abs(Date.parse(s) - Date.parse(d)) <= toleranceDays * 86_400_000);
  for (let i = 1; i < series.length; i++) {
    const [d0, p0] = series[i - 1];
    const [d1, p1] = series[i];
    if (!(p0 > 0 && p1 > 0)) continue;
    const obs = p0 / p1;
    const f = SPLIT_FACTORS.find((x) => Math.abs(Math.log(obs / x)) < 0.08);
    if (f && !near(d1)) out.push({ date: d1, previousDate: d0, factor: f, observed: obs });
  }
  return out;
}
