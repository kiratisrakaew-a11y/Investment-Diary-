/**
 * Abnormal returns for event studies (pure). MacKinlay (1997); Brown & Warner (1985); Dimson (1979).
 *
 *  - Returns are simple daily returns between consecutive dates on which BOTH the stock and the
 *    benchmark have an actual print (no fill, no interpolation); skipped dates are counted.
 *  - Day 0 = the event date if it is in that calendar, otherwise the next date in it.
 *  - Estimation window [e0, e1] and event window [w0, w1] are in those trading days relative to day 0.
 *  - Models: market (OLS R_i = α + βR_m + ε), dimson (R_i on R_m(t−1), R_m(t), R_m(t+1); β = sum),
 *    market_adjusted (AR = R_i − R_m).
 *  - AR_t t-stat = AR_t / σ(ε); CAR(t1,t2) t-stat = CAR / (σ(ε)·√L).
 * Statistical signals only — not proof of wrongdoing.
 */
import { invert } from "../optimizer";
import { mean, stdev } from "../stats";

export type ExpectedModel = "market" | "dimson" | "market_adjusted";
export const MODEL_LABEL: Record<ExpectedModel, string> = { market: "Market model (OLS)", dimson: "Dimson (1979) beta", market_adjusted: "Market-adjusted" };
export const MIN_ESTIMATION_OBS = 120;
export const DISCLAIMER = "เป็นสัญญาณทางสถิติ ไม่ใช่หลักฐานการกระทำผิด";

export interface ReturnSeries {
  /** dates[k] is the END date of return k. */
  dates: string[];
  ri: number[];
  rm: number[];
  /** Dates present in one series but not the other (dropped from the common calendar). */
  skipped: { stockOnly: number; benchmarkOnly: number };
}

/** Simple returns on the common calendar of actual prints (both series > 0). */
export function alignReturns(stock: [string, number][], bench: [string, number][]): ReturnSeries {
  const s = new Map(stock.filter(([, v]) => Number.isFinite(v) && v > 0));
  const b = new Map(bench.filter(([, v]) => Number.isFinite(v) && v > 0));
  const common = [...s.keys()].filter((d) => b.has(d)).sort();
  const out: ReturnSeries = { dates: [], ri: [], rm: [], skipped: { stockOnly: [...s.keys()].filter((d) => !b.has(d)).length, benchmarkOnly: [...b.keys()].filter((d) => !s.has(d)).length } };
  for (let k = 1; k < common.length; k++) {
    const d0 = common[k - 1];
    const d1 = common[k];
    out.dates.push(d1);
    out.ri.push(s.get(d1)! / s.get(d0)! - 1);
    out.rm.push(b.get(d1)! / b.get(d0)! - 1);
  }
  return out;
}

export interface OlsFit {
  coef: number[];
  /** Residual standard error √(SSE / (n − k)). */
  sigma: number;
  r2: number;
  n: number;
}

/** Ordinary least squares with an intercept column already in X. Null when X'X is singular or n ≤ k. */
export function ols(y: number[], X: number[][]): OlsFit | null {
  const n = y.length;
  const k = X[0]?.length ?? 0;
  if (n <= k || !k) return null;
  const XtX = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const Xty = Array.from({ length: k }, (_, i) => X.reduce((s, r, t) => s + r[i] * y[t], 0));
  const inv = invert(XtX);
  if (!inv) return null;
  const coef = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
  const fitted = X.map((r) => r.reduce((s, v, j) => s + v * coef[j], 0));
  const sse = y.reduce((s, v, t) => s + (v - fitted[t]) ** 2, 0);
  const my = mean(y);
  const sst = y.reduce((s, v) => s + (v - my) ** 2, 0);
  return { coef, sigma: Math.sqrt(sse / (n - k)), r2: sst > 0 ? 1 - sse / sst : 0, n };
}

export interface ModelFit {
  model: ExpectedModel;
  alpha: number;
  beta: number;
  /** Dimson: the three slope coefficients (lag −1, 0, +1). */
  betas?: [number, number, number];
  sigma: number;
  r2: number | null;
  n: number;
}

/** Fit the expected-return model on returns k0 … k1 (inclusive). */
export function fitModel(x: ReturnSeries, model: ExpectedModel, k0: number, k1: number): ModelFit | { error: string } {
  if (model === "market_adjusted") {
    const d: number[] = [];
    for (let k = k0; k <= k1; k++) d.push(x.ri[k] - x.rm[k]);
    if (d.length < 2) return { error: "ข้อมูลไม่พอ" };
    return { model, alpha: 0, beta: 1, sigma: stdev(d), r2: null, n: d.length };
  }
  const y: number[] = [];
  const X: number[][] = [];
  for (let k = k0; k <= k1; k++) {
    if (model === "market") {
      y.push(x.ri[k]);
      X.push([1, x.rm[k]]);
    } else {
      // Lead / lag of the market must exist inside the series.
      if (k - 1 < 0 || k + 1 >= x.rm.length) continue;
      y.push(x.ri[k]);
      X.push([1, x.rm[k - 1], x.rm[k], x.rm[k + 1]]);
    }
  }
  const f = ols(y, X);
  if (!f) return { error: "คำนวณ regression ไม่ได้ (ข้อมูลตลาดไม่แปรผัน หรือข้อมูลไม่พอ)" };
  if (model === "market") return { model, alpha: f.coef[0], beta: f.coef[1], sigma: f.sigma, r2: f.r2, n: f.n };
  const b: [number, number, number] = [f.coef[1], f.coef[2], f.coef[3]];
  return { model, alpha: f.coef[0], beta: b[0] + b[1] + b[2], betas: b, sigma: f.sigma, r2: f.r2, n: f.n };
}

/** Expected return of return k under the fitted model (null when a Dimson lead / lag is missing). */
export function expectedAt(x: ReturnSeries, fit: ModelFit, k: number): number | null {
  if (fit.model === "market_adjusted") return x.rm[k];
  if (fit.model === "market") return fit.alpha + fit.beta * x.rm[k];
  if (k - 1 < 0 || k + 1 >= x.rm.length) return null;
  const [b1, b0, b2] = fit.betas!;
  return fit.alpha + b1 * x.rm[k - 1] + b0 * x.rm[k] + b2 * x.rm[k + 1];
}

export interface EventStudyOptions {
  eventDate: string;
  model?: ExpectedModel;
  estimation?: [number, number];
  event?: [number, number];
  minObs?: number;
  /** "total_return" = stock adjusted close vs TRI; "price" = close vs price index. */
  basis?: "total_return" | "price";
  /** Ex-dividend dates (XD): flagged on event days when the basis is "price". */
  xdDates?: string[];
}

export interface ArDay {
  rel: number;
  date: string;
  ri: number;
  rm: number;
  expected: number | null;
  ar: number | null;
  t: number | null;
  car: number | null;
  carT: number | null;
  warnings: string[];
}

export type EventStudyResult =
  | {
      ok: true;
      model: ExpectedModel;
      day0: string;
      eventDate: string;
      estimation: { window: [number, number]; from: string; to: string; n: number };
      event: { window: [number, number]; from: string; to: string; days: number };
      fit: ModelFit;
      days: ArDay[];
      car: { t1: number; t2: number; value: number; t: number | null; days: number };
      warnings: string[];
    }
  | { ok: false; code: "INSUFFICIENT_DATA" | "EVENT_OUTSIDE_DATA" | "INVALID_WINDOW" | "MODEL_ERROR"; reason: string; n?: number };

/** CAR over relative days t1…t2 of an event result, with t = CAR / (σ√L). */
export function carOf(days: ArDay[], sigma: number, t1: number, t2: number) {
  const span = days.filter((d) => d.rel >= t1 && d.rel <= t2 && d.ar != null);
  const value = span.reduce((s, d) => s + d.ar!, 0);
  return { t1, t2, value, days: span.length, t: span.length && sigma > 0 ? value / (sigma * Math.sqrt(span.length)) : null };
}

export function eventStudy(x: ReturnSeries, o: EventStudyOptions): EventStudyResult {
  const model = o.model ?? "market";
  const [e0, e1] = o.estimation ?? [-250, -30];
  const [w0, w1] = o.event ?? [-10, 10];
  const minObs = o.minObs ?? MIN_ESTIMATION_OBS;
  if (!(e0 < e1) || !(w0 <= w1) || e1 >= w0) return { ok: false, code: "INVALID_WINDOW", reason: `ช่วงเวลาไม่ถูกต้อง: estimation [${e0}, ${e1}] ต้องอยู่ก่อน event window [${w0}, ${w1}]` };
  const z = x.dates.findIndex((d) => d >= o.eventDate);
  if (z < 0) return { ok: false, code: "EVENT_OUTSIDE_DATA", reason: `ไม่มีข้อมูลราคาในหรือหลังวันที่ ${o.eventDate}` };
  const k0 = Math.max(0, z + e0);
  const k1 = z + e1;
  if (k1 < 0 || k1 - k0 + 1 < minObs) {
    return { ok: false, code: "INSUFFICIENT_DATA", reason: `estimation window มีข้อมูล ${Math.max(0, k1 - k0 + 1)} วัน ต้องมีอย่างน้อย ${minObs} วัน (ต้องมีราคาย้อนหลังก่อนวัน event ประมาณ ${-e0} วันซื้อขาย)`, n: Math.max(0, k1 - k0 + 1) };
  }
  const fit = fitModel(x, model, k0, k1);
  if ("error" in fit) return { ok: false, code: "MODEL_ERROR", reason: fit.error };
  if (fit.n < minObs) return { ok: false, code: "INSUFFICIENT_DATA", reason: `ใช้ได้ ${fit.n} วัน ต้องมีอย่างน้อย ${minObs} วัน`, n: fit.n };
  const warnings: string[] = [];
  if (z + e0 < 0) warnings.push(`estimation window สั้นกว่าที่ตั้ง (${fit.n} วันแทน ${e1 - e0 + 1} วัน) เพราะข้อมูลย้อนหลังไม่ถึง`);
  const last = Math.min(x.dates.length - 1, z + w1);
  if (z + w1 > x.dates.length - 1) warnings.push(`event window ถึงวันที่มีข้อมูลล่าสุดเท่านั้น (${x.dates[last]}) — ยังไม่มีข้อมูลหลังจากนั้น`);
  const xd = new Set(o.xdDates ?? []);
  const days: ArDay[] = [];
  let car = 0;
  let carN = 0;
  for (let k = Math.max(0, z + w0); k <= last; k++) {
    const e = expectedAt(x, fit, k);
    const ar = e == null ? null : x.ri[k] - e;
    const w: string[] = [];
    if (e == null) w.push("Dimson ต้องใช้ผลตอบแทนตลาดของวันถัดไป ซึ่งยังไม่มี");
    if (o.basis !== "total_return" && xd.has(x.dates[k])) w.push("วัน XD: ใช้ราคาปิดที่ไม่ปรับปันผล AR อาจติดลบจากการจ่ายปันผล ไม่ใช่ความผิดปกติ");
    if (ar != null) {
      car += ar;
      carN++;
    }
    days.push({
      rel: k - z,
      date: x.dates[k],
      ri: x.ri[k],
      rm: x.rm[k],
      expected: e,
      ar,
      t: ar != null && fit.sigma > 0 ? ar / fit.sigma : null,
      car: carN ? car : null,
      carT: carN && fit.sigma > 0 ? car / (fit.sigma * Math.sqrt(carN)) : null,
      warnings: w,
    });
  }
  if (days.some((d) => d.warnings.some((w) => w.startsWith("วัน XD")))) warnings.push("มีวัน XD ใน event window และใช้ราคาปิดเทียบดัชนีราคา — AR วันนั้นอาจต่ำเกินจริงตามปันผลที่จ่าย");
  return {
    ok: true,
    model,
    day0: x.dates[z],
    eventDate: o.eventDate,
    estimation: { window: [e0, e1], from: x.dates[k0], to: x.dates[k1], n: fit.n },
    event: { window: [w0, w1], from: days[0]?.date ?? x.dates[z], to: days.at(-1)?.date ?? x.dates[z], days: days.length },
    fit,
    days,
    car: carOf(days, fit.sigma, w0, w1),
    warnings,
  };
}
