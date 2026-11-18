/**
 * Abnormal volume, mean-adjusted model (pure). Campbell & Wasley (1996).
 *
 *  turnover_t = volume_t / shares outstanding effective on day t
 *  V_t = ln(turnover_t + c), c = 0.00000255  (keeps zero-volume days finite)
 *  z_t = (V_t − mean(V)) / sd(V) over the estimation window [t+e0, t+e1] (trading days, default −250…−30)
 *
 * Without a share count for every day used, the whole series falls back to raw volume, V = ln(volume + 1):
 * the z-score of one stock is still valid, but levels cannot be compared across stocks.
 * Days with unknown volume (null) are not trading-day observations and are skipped, never filled.
 */
export const CW_CONSTANT = 0.00000255;
export const DEFAULT_ESTIMATION: [number, number] = [-250, -30];
export const MIN_VOLUME_OBS = 120;

export type Level = "ปกติ" | "น่าสังเกต" | "ผิดปกติ";
export interface Thresholds {
  notable: number;
  abnormal: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = { notable: 2, abnormal: 3 };
export const levelOf = (absValue: number | null, th: Thresholds = DEFAULT_THRESHOLDS): Level => (absValue == null ? "ปกติ" : absValue > th.abnormal ? "ผิดปกติ" : absValue > th.notable ? "น่าสังเกต" : "ปกติ");

export interface VolumeDay {
  date: string;
  volume: number | null;
}
export interface SharesRow {
  effectiveDate: string;
  shares: number;
}

export interface VolumeSeries {
  /** Trading days with a known volume, ascending. */
  dates: string[];
  volume: number[];
  turnover: (number | null)[];
  v: number[];
  basis: "turnover" | "raw_volume";
  warnings: string[];
}

function sharesOn(rows: SharesRow[], date: string): number | null {
  let best: SharesRow | null = null;
  for (const r of rows) if (r.effectiveDate <= date && (!best || r.effectiveDate > best.effectiveDate)) best = r;
  return best && best.shares > 0 ? best.shares : null;
}

/** Log-volume series; turnover when a share count covers every day, otherwise raw volume (with the reason). */
export function volumeSeries(days: VolumeDay[], shares: SharesRow[]): VolumeSeries {
  const known = days.filter((d) => d.volume != null && Number.isFinite(d.volume) && d.volume >= 0).sort((a, b) => a.date.localeCompare(b.date));
  const dates = known.map((d) => d.date);
  const volume = known.map((d) => d.volume as number);
  const sh = dates.map((d) => sharesOn(shares, d));
  const warnings: string[] = [];
  const missing = days.length - known.length;
  if (missing) warnings.push(`${missing} วันไม่มีข้อมูล volume — ไม่นับ (ไม่ถือว่าเป็น 0)`);
  if (dates.length && sh.every((s) => s != null)) {
    const turnover = volume.map((v, i) => v / sh[i]!);
    return { dates, volume, turnover, v: turnover.map((t) => Math.log(t + CW_CONSTANT)), basis: "turnover", warnings };
  }
  const covered = sh.filter((s) => s != null).length;
  warnings.push(
    shares.length
      ? `จำนวนหุ้น (shares outstanding) ไม่ครอบคลุมทุกวัน (${covered}/${dates.length}) — ใช้ raw volume แทน turnover: z-score ของหุ้นตัวนี้ใช้ได้ แต่เทียบข้ามหุ้นไม่ได้`
      : "ยังไม่มีจำนวนหุ้น (shares outstanding) — ใช้ raw volume แทน turnover: z-score ของหุ้นตัวนี้ใช้ได้ แต่เทียบข้ามหุ้นไม่ได้",
  );
  return { dates, volume, turnover: dates.map(() => null), v: volume.map((x) => Math.log(x + 1)), basis: "raw_volume", warnings };
}

export interface VolumeZ {
  date: string;
  volume: number;
  turnover: number | null;
  v: number;
  mean: number | null;
  sd: number | null;
  z: number | null;
  n: number;
  level: Level;
  reason?: string;
}

/**
 * Rolling z for every trading day in [from, to]: the estimation window is [t+e0, t+e1] trading days
 * of this stock. Prefix sums keep it O(T). Fewer than minObs observations → z null with the reason.
 */
export function rollingVolumeZ(s: VolumeSeries, o: { from?: string; to?: string; estimation?: [number, number]; minObs?: number; thresholds?: Thresholds } = {}): VolumeZ[] {
  const [e0, e1] = o.estimation ?? DEFAULT_ESTIMATION;
  const minObs = o.minObs ?? MIN_VOLUME_OBS;
  const th = o.thresholds ?? DEFAULT_THRESHOLDS;
  const n = s.v.length;
  // Prefix sums of V centred on the series mean, so the variance does not suffer from cancellation.
  const c = n ? s.v.reduce((x, y) => x + y, 0) / n : 0;
  const p1 = [0];
  const p2 = [0];
  for (let i = 0; i < n; i++) {
    const y = s.v[i] - c;
    p1.push(p1[i] + y);
    p2.push(p2[i] + y * y);
  }
  const out: VolumeZ[] = [];
  for (let t = 0; t < n; t++) {
    const d = s.dates[t];
    if ((o.from && d < o.from) || (o.to && d > o.to)) continue;
    const a = Math.max(0, t + e0);
    const b = t + e1;
    const m = b - a + 1;
    const base = { date: d, volume: s.volume[t], turnover: s.turnover[t], v: s.v[t] };
    if (b < 0 || m < minObs) {
      out.push({ ...base, mean: null, sd: null, z: null, n: Math.max(0, m), level: "ปกติ", reason: `estimation window มี ${Math.max(0, m)} วัน ต้องมีอย่างน้อย ${minObs} วัน` });
      continue;
    }
    const sum = p1[b + 1] - p1[a];
    const sq = p2[b + 1] - p2[a];
    const mc = sum / m;
    const varS = Math.max(0, (sq - m * mc * mc) / (m - 1));
    const sd = Math.sqrt(varS);
    const mean = mc + c;
    if (!(sd > 1e-9 * Math.max(1, Math.abs(mean)))) {
      out.push({ ...base, mean, sd, z: null, n: m, level: "ปกติ", reason: "volume ไม่เปลี่ยนเลยใน estimation window — คำนวณ z ไม่ได้" });
      continue;
    }
    const z = (s.v[t] - c - mc) / sd;
    out.push({ ...base, mean, sd, z, n: m, level: levelOf(Math.abs(z), th) });
  }
  return out;
}

/** Share of zero-volume days (thin trading); > 10% suggests the Dimson beta for returns. */
export function zeroVolumeShare(s: VolumeSeries, from?: string, to?: string) {
  const idx = s.dates.map((d, i) => [d, i] as const).filter(([d]) => (!from || d >= from) && (!to || d <= to));
  const zeros = idx.filter(([, i]) => s.volume[i] === 0).length;
  const share = idx.length ? zeros / idx.length : 0;
  return { days: idx.length, zeroDays: zeros, share, thin: share > 0.1 };
}

/** Event-window volume z-scores with the estimation window fixed relative to the event day (same as returns). */
export function eventVolumeZ(s: VolumeSeries, eventDate: string, o: { estimation?: [number, number]; event?: [number, number]; minObs?: number; thresholds?: Thresholds } = {}) {
  const [e0, e1] = o.estimation ?? DEFAULT_ESTIMATION;
  const [w0, w1] = o.event ?? [-10, 10];
  const minObs = o.minObs ?? MIN_VOLUME_OBS;
  const z0 = s.dates.findIndex((d) => d >= eventDate);
  if (z0 < 0) return { ok: false as const, reason: `ไม่มีข้อมูล volume ในหรือหลังวันที่ ${eventDate}` };
  const a = Math.max(0, z0 + e0);
  const b = z0 + e1;
  const win = b >= a ? s.v.slice(a, b + 1) : [];
  if (win.length < minObs) return { ok: false as const, reason: `estimation window ของ volume มี ${win.length} วัน ต้องมีอย่างน้อย ${minObs} วัน`, n: win.length };
  const mean = win.reduce((x, y) => x + y, 0) / win.length;
  const sd = Math.sqrt(win.reduce((x, y) => x + (y - mean) ** 2, 0) / (win.length - 1));
  if (!(sd > 1e-9 * Math.max(1, Math.abs(mean)))) return { ok: false as const, reason: "volume ไม่เปลี่ยนเลยใน estimation window — คำนวณ z ไม่ได้" };
  const th = o.thresholds ?? DEFAULT_THRESHOLDS;
  const days = [];
  for (let k = Math.max(0, z0 + w0); k <= Math.min(s.v.length - 1, z0 + w1); k++) {
    const z = (s.v[k] - mean) / sd;
    days.push({ rel: k - z0, date: s.dates[k], volume: s.volume[k], turnover: s.turnover[k], v: s.v[k], z, level: levelOf(Math.abs(z), th) });
  }
  return { ok: true as const, day0: s.dates[z0], mean, sd, n: win.length, estimation: { from: s.dates[a], to: s.dates[b] }, days };
}
