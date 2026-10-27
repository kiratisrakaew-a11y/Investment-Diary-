/**
 * PR14 — Monte Carlo over valuation drivers. Each draw sets the chosen inputs and calls the same
 * evaluator as the deterministic scenarios (no free-floating price targets). Reproducible: a seeded
 * PRNG (mulberry32), Box–Muller normals, a Gaussian copula for correlation and inverse CDFs for the
 * marginals. The output describes the user's distributions; it is not a calibrated probability.
 */
import type { ValuationInput } from "./valuation-schemas";
import { applyOverrides, segmentKey, valueOf, virtualBase, type OverrideMode } from "./valuation-scenarios";
import { covarianceDiagnostics } from "./finance/mpt";
import { MC_MAX_DRAWS, type DistributionSpec, type MonteCarloConfig } from "./valuation-scenario-schema";

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf, |error| < 1.5e-7). */
export function normCdf(z: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Inverse standard normal CDF (Acklam, relative error < 1.2e-9). */
export function normInv(p: number) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Value of a marginal at uniform u ∈ (0, 1). */
export function inverseCdf(d: DistributionSpec, u: number): number {
  switch (d.type) {
    case "uniform":
      return d.min + u * (d.max - d.min);
    case "triangular": {
      const f = (d.mode - d.min) / (d.max - d.min);
      return u < f ? d.min + Math.sqrt(u * (d.max - d.min) * (d.mode - d.min)) : d.max - Math.sqrt((1 - u) * (d.max - d.min) * (d.max - d.mode));
    }
    case "normal": {
      const lo = d.min != null ? normCdf((d.min - d.mean) / d.sd) : 0;
      const hi = d.max != null ? normCdf((d.max - d.mean) / d.sd) : 1;
      const x = d.mean + d.sd * normInv(lo + u * (hi - lo));
      return Math.min(d.max ?? Infinity, Math.max(d.min ?? -Infinity, x));
    }
    case "empirical": {
      const s = [...d.samples].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(u * s.length))];
    }
  }
}

export function validateDistribution(d: DistributionSpec): string | null {
  if (d.type === "uniform" && !(d.max > d.min)) return "uniform: ต้องมี max > min";
  if (d.type === "triangular" && !(d.min <= d.mode && d.mode <= d.max && d.max > d.min)) return "triangular: ต้องมี min ≤ mode ≤ max และ max > min";
  if (d.type === "normal" && d.min != null && d.max != null && !(d.max > d.min)) return "normal: ช่วงตัดต้องมี max > min";
  return null;
}

/** Correlation checks: square, symmetric, unit diagonal, entries in [−1, 1]; non-PSD is repaired (eigenvalue clipping) and said so. */
export function prepareCorrelation(c: number[][] | undefined, n: number): { L: number[][]; warnings: string[]; error?: string } {
  const I = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  if (!c) return { L: I, warnings: [] };
  if (c.length !== n || c.some((r) => r.length !== n)) return { L: I, warnings: [], error: `correlation ต้องเป็นเมทริกซ์ ${n}×${n}` };
  for (let i = 0; i < n; i++) {
    if (Math.abs(c[i][i] - 1) > 1e-9) return { L: I, warnings: [], error: "แนวทแยงของ correlation ต้องเป็น 1" };
    for (let j = 0; j < n; j++) {
      if (!(Math.abs(c[i][j]) <= 1)) return { L: I, warnings: [], error: "ค่า correlation ต้องอยู่ระหว่าง −1 ถึง 1" };
      if (Math.abs(c[i][j] - c[j][i]) > 1e-9) return { L: I, warnings: [], error: "correlation ต้องสมมาตร" };
    }
  }
  const diag = covarianceDiagnostics(c);
  const warnings: string[] = [];
  let m = c;
  if (!diag.psd) {
    const r = diag.repaired;
    const s = r.map((_, i) => Math.sqrt(Math.max(r[i][i], 1e-12)));
    m = r.map((row, i) => row.map((x, j) => (i === j ? 1 : x / (s[i] * s[j]))));
    warnings.push(`correlation ไม่เป็น positive semidefinite (eigenvalue ต่ำสุด ${diag.minEigenvalue.toFixed(4)}) — ปรับ eigenvalue ติดลบเป็น 0 แล้วปรับแนวทแยงกลับเป็น 1`);
  }
  // Cholesky with a tiny jitter for semidefinite matrices.
  const L = Array.from({ length: n }, () => Array(n).fill(0) as number[]);
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = m[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
    }
  return { L, warnings };
}

export interface MonteCarloResult {
  ok: boolean;
  usable: boolean;
  seed: number;
  drawsRequested: number;
  drawsRun: number;
  valid: number;
  invalid: number;
  invalidShare: number;
  timedOut: boolean;
  elapsedMs: number;
  valueKind: "per_share" | "bond_clean_price";
  price: number | null;
  baseValue: number | null;
  mean: number | null;
  sd: number | null;
  percentiles: Record<"p5" | "p10" | "p25" | "p50" | "p75" | "p90" | "p95", number | null>;
  probAbovePrice: number | null;
  histogram: { from: number; to: number; count: number }[];
  ecdf: { value: number; p: number }[];
  invalidReasons: { reason: string; count: number }[];
  warnings: string[];
  errors: string[];
}

/** Linear-interpolated percentile of a sorted array (type 7). */
export function percentile(sorted: number[], q: number) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  return sorted[lo] + (h - lo) * ((sorted[Math.min(lo + 1, sorted.length - 1)] ?? sorted[lo]) - sorted[lo]);
}

export function monteCarlo(input: ValuationInput, cfg: MonteCarloConfig, opts: { now?: () => number; shouldCancel?: () => boolean } = {}): MonteCarloResult {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const n = cfg.variables.length;
  const base = valueOf(input);
  const res: MonteCarloResult = {
    ok: false,
    usable: false,
    seed: cfg.seed,
    drawsRequested: cfg.draws,
    drawsRun: 0,
    valid: 0,
    invalid: 0,
    invalidShare: 0,
    timedOut: false,
    elapsedMs: 0,
    valueKind: input.method === "bond" ? "bond_clean_price" : "per_share",
    price: base.price,
    baseValue: base.value,
    mean: null,
    sd: null,
    percentiles: { p5: null, p10: null, p25: null, p50: null, p75: null, p90: null, p95: null },
    probAbovePrice: null,
    histogram: [],
    ecdf: [],
    invalidReasons: [],
    warnings: ["ผลจำลองขึ้นกับการแจกแจงที่ผู้ใช้กำหนด — ไม่ใช่ความน่าจะเป็นที่สอบเทียบกับข้อมูลจริง และไม่แทนที่มูลค่ากรณีฐานหรือค่าถ่วงน้ำหนัก scenario", "P10 / P90 = เปอร์เซ็นไทล์ที่ 10 / 90 ของมูลค่าที่จำลองได้ (10% ของผลต่ำกว่า P10)"],
    errors: [],
  };
  if (cfg.draws > MC_MAX_DRAWS) res.errors.push(`จำนวนรอบเกิน ${MC_MAX_DRAWS}`);
  if (new Set(cfg.variables.map((v) => v.path)).size !== n) res.errors.push("ตัวแปรซ้ำกัน");
  cfg.variables.forEach((v) => {
    const e = validateDistribution(v.dist);
    if (e) res.errors.push(`${v.path}: ${e}`);
  });
  const corr = prepareCorrelation(cfg.correlation, n);
  if (corr.error) res.errors.push(corr.error);
  res.warnings.push(...corr.warnings);
  if (base.value == null) res.errors.push("มูลค่ากรณีฐานคำนวณไม่ได้");
  if (res.errors.length) return res;

  const rnd = mulberry32(cfg.seed);
  const gauss = () => {
    const u1 = Math.max(rnd(), 1e-300);
    const u2 = rnd();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const virtual = virtualBase(input);
  const modes = Object.fromEntries(cfg.variables.map((v) => [v.path, v.mode as OverrideMode]));
  const values: number[] = [];
  const reasons = new Map<string, number>();
  for (let k = 0; k < cfg.draws; k++) {
    if ((k & 63) === 0 && (now() - t0 > cfg.timeBudgetMs || opts.shouldCancel?.())) {
      res.timedOut = true;
      break;
    }
    const e = Array.from({ length: n }, gauss);
    const z = corr.L.map((row) => row.reduce((s, l, j) => s + l * e[j], 0));
    const over = Object.fromEntries(cfg.variables.map((v, i) => [v.path, inverseCdf(v.dist, Math.min(1 - 1e-12, Math.max(1e-12, normCdf(z[i]))))]));
    res.drawsRun++;
    const a = applyOverrides(input, over, virtual, modes);
    const pv = a.input ? valueOf(a.input, a.discountRate) : null;
    const v = pv?.value;
    if (v == null || !Number.isFinite(v)) {
      const r = (a.errors[0] ?? pv?.errors[0] ?? "คำนวณไม่ได้").replace(/[-\d.]+%?/g, "#").slice(0, 120);
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
      continue;
    }
    values.push(v);
  }
  res.elapsedMs = now() - t0;
  res.valid = values.length;
  res.invalid = res.drawsRun - values.length;
  res.invalidShare = res.drawsRun ? res.invalid / res.drawsRun : 1;
  res.invalidReasons = [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 5);
  if (res.timedOut) res.warnings.push(`หยุดเมื่อครบเวลา ${cfg.timeBudgetMs} ms — คำนวณได้ ${res.drawsRun} จาก ${cfg.draws} รอบ`);
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length) {
    const mean = sorted.reduce((s, x) => s + x, 0) / sorted.length;
    res.mean = mean;
    res.sd = sorted.length > 1 ? Math.sqrt(sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / (sorted.length - 1)) : 0;
    const q = (p: number) => percentile(sorted, p);
    res.percentiles = { p5: q(0.05), p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95) };
    if (res.price != null && res.price > 0 && res.valueKind === "per_share") res.probAbovePrice = sorted.filter((x) => x > res.price!).length / sorted.length;
    const lo = sorted[0];
    const hi = sorted[sorted.length - 1];
    const bins = 30;
    const w = hi > lo ? (hi - lo) / bins : 1;
    const counts = Array(hi > lo ? bins : 1).fill(0) as number[];
    sorted.forEach((x) => counts[Math.min(counts.length - 1, Math.floor((x - lo) / w))]++);
    res.histogram = counts.map((c, i) => ({ from: lo + i * w, to: lo + (i + 1) * w, count: c }));
    res.ecdf = Array.from({ length: 21 }, (_, i) => ({ p: i / 20, value: q(i / 20)! }));
  }
  const minValid = Math.min(200, cfg.draws / 2);
  res.usable = res.valid >= minValid && res.invalidShare <= cfg.maxInvalidShare;
  if (res.invalidShare > cfg.maxInvalidShare) res.errors.push(`รอบที่คำนวณไม่ได้ ${(res.invalidShare * 100).toFixed(1)}% เกินเกณฑ์ ${(cfg.maxInvalidShare * 100).toFixed(0)}% — ผลใช้ไม่ได้ ปรับช่วงการแจกแจง`);
  else if (res.valid < minValid) res.errors.push(`มีผลที่ใช้ได้ ${res.valid} รอบ น้อยเกินไป`);
  res.ok = res.usable;
  return res;
}

/** Starting variable per method (an illustrative ±range around the base; edit before relying on it). */
export function defaultMonteCarloVariable(input: ValuationInput): MonteCarloConfig["variables"][number] {
  const tri = (min: number, max: number) => ({ type: "triangular" as const, min, mode: 0, max });
  switch (input.method) {
    case "dcf_fcff":
    case "dcf_fcfe":
      return { path: "growthShift", mode: "absolute", dist: tri(-0.02, 0.02) };
    case "residual_income":
      return { path: "roeShift", mode: "absolute", dist: tri(-0.02, 0.02) };
    case "ddm":
      return { path: "highGrowth", mode: "shift", dist: tri(-0.02, 0.02) };
    case "multiples":
      return { path: "targetPE", mode: "shift", dist: tri(-2, 2) };
    case "bond":
      return { path: "yieldShiftBp", mode: "absolute", dist: tri(-50, 50) };
    case "sotp": {
      const seg = input.assumptions.segments.find((s) => s.source.type === "model" && ["dcf_fcff", "dcf_fcfe"].includes(s.source.valuation.method));
      if (seg) return { path: `segments[${segmentKey(seg)}].model.growthShift`, mode: "absolute", dist: tri(-0.02, 0.02) };
      return { path: "holdingDiscount", mode: "shift", dist: tri(-0.05, 0.05) };
    }
  }
}
