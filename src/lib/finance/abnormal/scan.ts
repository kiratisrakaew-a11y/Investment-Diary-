/**
 * Daily abnormal-trading scan (pure). For every trading day t in [from, to]:
 *  - market model fitted on the trailing window [t+e0, t+e1] (default −250…−30) with rolling sums (O(1) per day);
 *  - AR_t, t_AR = AR_t / σ(ε); CAR over t−4…t with the day-t fit, t_CAR5 = CAR5 / (σ(ε)·√5);
 *  - abnormal-volume z of the same day (mean-adjusted, volume.ts).
 * Levels (thresholds adjustable, defaults 2 / 3):
 *  ผิดปกติ   (|t_AR| > 3 and z > 3) or |t_CAR5| > 3
 *  น่าสังเกต (|t_AR| > 2 and z > 2) or |t_CAR5| > 2
 * A day without enough market data has no AR: it is never flagged on returns; a high volume z alone is
 * listed separately (volumeOnly), not as a flag. Thresholds are never lowered to compensate.
 * Statistical signals only — not proof of wrongdoing.
 */
import type { ReturnSeries } from "./returns";
import {
  DEFAULT_ESTIMATION,
  DEFAULT_THRESHOLDS,
  MIN_VOLUME_OBS,
  rollingVolumeZ,
  type Level,
  type Thresholds,
  type VolumeSeries,
} from "./volume";

/** True for a real calendar date in YYYY-MM-DD (rejects 2026-13-40, 2026-02-30). */
export const isCalendarDate = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export interface ScanEvent {
  date: string;
  type: string;
  description: string;
}

export interface ScanDay {
  date: string;
  ar: number | null;
  tAR: number | null;
  car5: number | null;
  tCAR5: number | null;
  z: number | null;
  /** Shares traded that day (null = unknown). */
  volume: number | null;
  level: Level;
  /** Why the day got its level (empty when normal). */
  reasons: string[];
  /** Why AR / z are missing on this day. */
  missing: string[];
  fit: { alpha: number; beta: number; sigma: number; n: number } | null;
  /** Caveats on this day's numbers (e.g. XD with close-vs-close). */
  warnings: string[];
  preEvent: { tradingDays: number; event: ScanEvent } | null;
}

const RANK: Record<Level, number> = { ผิดปกติ: 2, น่าสังเกต: 1, ปกติ: 0 };

/** Rolling market-model fit for return index t over [t+e0, t+e1]; centred sums avoid cancellation. */
export function rollingMarketFits(
  x: ReturnSeries,
  estimation: [number, number] = DEFAULT_ESTIMATION,
  minObs = MIN_VOLUME_OBS,
) {
  const n = x.ri.length;
  const cx = n ? x.rm.reduce((a, b) => a + b, 0) / n : 0;
  const cy = n ? x.ri.reduce((a, b) => a + b, 0) / n : 0;
  const S = { x: [0], y: [0], xx: [0], xy: [0], yy: [0] };
  for (let i = 0; i < n; i++) {
    const a = x.rm[i] - cx;
    const b = x.ri[i] - cy;
    S.x.push(S.x[i] + a);
    S.y.push(S.y[i] + b);
    S.xx.push(S.xx[i] + a * a);
    S.xy.push(S.xy[i] + a * b);
    S.yy.push(S.yy[i] + b * b);
  }
  const [e0, e1] = estimation;
  return (
    t: number,
  ):
    | { alpha: number; beta: number; sigma: number; n: number }
    | { reason: string } => {
    const lo = Math.max(0, t + e0);
    const hi = t + e1;
    const m = hi - lo + 1;
    if (hi < 0 || m < minObs)
      return {
        reason: `ข้อมูลตลาดพอสำหรับ estimation window ${Math.max(0, m)} วัน ต้องมีอย่างน้อย ${minObs} วัน`,
      };
    const sx = S.x[hi + 1] - S.x[lo];
    const sy = S.y[hi + 1] - S.y[lo];
    const mx = sx / m;
    const my = sy / m;
    const sxx = S.xx[hi + 1] - S.xx[lo] - m * mx * mx;
    const sxy = S.xy[hi + 1] - S.xy[lo] - m * mx * my;
    const syy = S.yy[hi + 1] - S.yy[lo] - m * my * my;
    if (!(sxx > 1e-18))
      return { reason: "ผลตอบแทนตลาดไม่แปรผันใน estimation window" };
    const beta = sxy / sxx;
    // Back to the original (uncentred) intercept.
    const alpha = my + cy - beta * (mx + cx);
    const sse = Math.max(0, syy - beta * sxy);
    return { alpha, beta, sigma: Math.sqrt(sse / (m - 2)), n: m };
  };
}

export interface ScanOptions {
  from?: string;
  to?: string;
  estimation?: [number, number];
  minObs?: number;
  thresholds?: Thresholds;
  /** Look-ahead for "abnormal before event X days" (trading days). */
  eventHorizon?: number;
  /** "price" = close vs price index: XD days (and CAR5 windows containing one) get a caveat. */
  basis?: "total_return" | "price";
  xdDates?: string[];
}

/** Scan one stock. `tradingDates` = the stock's own price dates (for counting days to an event). */
export function scanStock(
  x: ReturnSeries,
  vol: VolumeSeries,
  tradingDates: string[],
  events: ScanEvent[],
  o: ScanOptions = {},
) {
  const th = o.thresholds ?? DEFAULT_THRESHOLDS;
  const minObs = o.minObs ?? MIN_VOLUME_OBS;
  const horizon = o.eventHorizon ?? 10;
  const fitAt = rollingMarketFits(x, o.estimation, minObs);
  const retIdx = new Map(x.dates.map((d, i) => [d, i]));
  const vz = new Map(
    rollingVolumeZ(vol, {
      from: o.from,
      to: o.to,
      estimation: o.estimation,
      minObs,
      thresholds: th,
    }).map((r) => [r.date, r]),
  );
  const dayIdx = new Map(tradingDates.map((d, i) => [d, i]));
  const xd = new Set(o.xdDates ?? []);
  const sortedEvents = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const days = [...new Set([...x.dates, ...vol.dates])]
    .filter((d) => (!o.from || d >= o.from) && (!o.to || d <= o.to))
    .sort();
  const out: ScanDay[] = [];
  for (const date of days) {
    const missing: string[] = [];
    let ar: number | null = null;
    let tAR: number | null = null;
    let car5: number | null = null;
    let tCAR5: number | null = null;
    let fit: ScanDay["fit"] = null;
    const k = retIdx.get(date);
    if (k == null) missing.push("AR: ไม่มีราคาหุ้นหรือดัชนีของวันนี้");
    else {
      const f = fitAt(k);
      if ("reason" in f) missing.push(`AR: ${f.reason}`);
      else if (f.sigma > 0) {
        fit = f;
        ar = x.ri[k] - f.alpha - f.beta * x.rm[k];
        tAR = ar / f.sigma;
        if (k >= 4) {
          car5 = 0;
          for (let j = k - 4; j <= k; j++)
            car5 += x.ri[j] - f.alpha - f.beta * x.rm[j];
          tCAR5 = car5 / (f.sigma * Math.sqrt(5));
        } else missing.push("CAR5: ยังไม่ครบ 5 วัน");
      }
    }
    const v = vz.get(date);
    const z = v?.z ?? null;
    if (z == null)
      missing.push(`Volume: ${v?.reason ?? "ไม่มีข้อมูล volume ของวันนี้"}`);
    const reasons: string[] = [];
    let level: Level = "ปกติ";
    const bump = (l: Level, why: string) => {
      reasons.push(why);
      if (RANK[l] > RANK[level]) level = l;
    };
    if (tAR != null && z != null) {
      if (Math.abs(tAR) > th.abnormal && z > th.abnormal)
        bump(
          "ผิดปกติ",
          `AR ${(ar! * 100).toFixed(2)}% (t=${tAR.toFixed(2)}) และ Volume z=${z.toFixed(2)}`,
        );
      else if (Math.abs(tAR) > th.notable && z > th.notable)
        bump(
          "น่าสังเกต",
          `AR ${(ar! * 100).toFixed(2)}% (t=${tAR.toFixed(2)}) และ Volume z=${z.toFixed(2)}`,
        );
    }
    if (tCAR5 != null) {
      if (Math.abs(tCAR5) > th.abnormal)
        bump(
          "ผิดปกติ",
          `CAR 5 วัน ${(car5! * 100).toFixed(2)}% (t=${tCAR5.toFixed(2)})`,
        );
      else if (Math.abs(tCAR5) > th.notable)
        bump(
          "น่าสังเกต",
          `CAR 5 วัน ${(car5! * 100).toFixed(2)}% (t=${tCAR5.toFixed(2)})`,
        );
    }
    const warnings: string[] = [];
    if (o.basis === "price" && k != null && xd.size) {
      if (xd.has(date))
        warnings.push(
          "วัน XD: ใช้ราคาปิดเทียบดัชนีราคา ผลตอบแทนวันนี้ต่ำกว่าจริงตามปันผล",
        );
      else if (k >= 4 && x.dates.slice(k - 4, k).some((d) => xd.has(d)))
        warnings.push(
          "CAR 5 วันครอบวัน XD: ใช้ราคาปิด ผลตอบแทนต่ำกว่าจริงตามปันผล",
        );
    }
    // CAR5 carried by one earlier day only (the window still contains a single spike): say so, level unchanged.
    if (
      fit &&
      k != null &&
      k >= 4 &&
      tCAR5 != null &&
      Math.abs(tCAR5) > th.notable
    ) {
      let jMax = k - 4;
      const arAt = (j: number) => x.ri[j] - fit!.alpha - fit!.beta * x.rm[j];
      for (let j = k - 3; j <= k; j++)
        if (Math.abs(arAt(j)) > Math.abs(arAt(jMax))) jMax = j;
      const rest = car5! - arAt(jMax);
      if (jMax !== k && Math.abs(rest / (fit.sigma * 2)) <= th.notable)
        warnings.push(
          `CAR 5 วันสูงเพราะวัน ${x.dates[jMax]} วันเดียว (AR ${(arAt(jMax) * 100).toFixed(2)}%) — ไม่ใช่การสะสมหลายวัน`,
        );
    }
    let preEvent: ScanDay["preEvent"] = null;
    if (level !== "ปกติ") {
      const di = dayIdx.get(date);
      for (const e of sortedEvents) {
        if (e.date <= date) continue;
        // Trading days from the flagged day to the event (event on a non-trading day counts to the next trading day).
        const ei = tradingDates.findIndex((d) => d >= e.date);
        const gap = di != null && ei >= 0 ? ei - di : null;
        if (gap != null && gap > 0 && gap <= horizon)
          preEvent = { tradingDays: gap, event: e };
        break;
      }
    }
    out.push({
      date,
      ar,
      tAR,
      car5,
      tCAR5,
      z,
      volume: v?.volume ?? null,
      level,
      reasons,
      missing,
      fit,
      warnings,
      preEvent,
    });
  }
  const strength = (d: ScanDay) =>
    Math.max(Math.abs(d.tAR ?? 0), Math.abs(d.tCAR5 ?? 0), d.z ?? 0);
  const flagged = out
    .filter((d) => d.level !== "ปกติ")
    .sort(
      (a, b) =>
        RANK[b.level] - RANK[a.level] ||
        strength(b) - strength(a) ||
        b.date.localeCompare(a.date),
    );
  // High volume on a day without a usable AR: shown separately, never counted as a flag.
  const volumeOnly = out
    .filter((d) => d.tAR == null && d.z != null && d.z > th.notable)
    .map((d) => ({
      date: d.date,
      z: d.z!,
      note: "AR: ไม่มีข้อมูลตลาด — แสดงเฉพาะ volume",
    }));
  return {
    days: out,
    flagged,
    volumeOnly,
    coverage: {
      days: out.length,
      withAR: out.filter((d) => d.tAR != null).length,
      withVolumeZ: out.filter((d) => d.z != null).length,
    },
    latest: out.at(-1) ?? null,
  };
}
