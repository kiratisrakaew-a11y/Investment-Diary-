/**
 * MPT_FIX_SPEC P1-7: expected returns (μ) that do not simply chase the last year's return (pure, shared by
 * optimize / compare / backtest and the optimizer page).
 *  - blend: w·μ_hist + (1 − w)·μ_CAPM with w = 0.5 · min(1, years / 3) — with under 3 years of data CAPM
 *    carries more weight (and the result says so). Three years or more = the previous 50/50.
 *  - shrinkage: Bayes–Stein (Jorion 1986) toward CAPM, intensity
 *      δ = (n + 2) / ((n + 2) + years · (μ − μ₀)ᵀ Σ⁻¹ (μ − μ₀))   (annualized μ, Σ; T/N = years)
 *    so a short or noisy history moves μ toward CAPM.
 *  - cap: |μ − μ_CAPM| ≤ cap (Settings muCapPct) for the methods that use history; before / after reported.
 */
import { invert } from "./optimizer";

export const BLEND_FULL_YEARS = 3;

/** Weight on the historical mean in "blend" (0.5 with ≥ 3 years). */
export function blendHistWeight(years: number): number {
  return 0.5 * Math.min(1, Math.max(0, years) / BLEND_FULL_YEARS);
}

export function blendMu(hist: number[], capm: number[], years: number): number[] {
  const w = blendHistWeight(years);
  return hist.map((h, i) => w * h + (1 - w) * capm[i]);
}

export function blendNote(years: number): string | null {
  if (!(years < BLEND_FULL_YEARS)) return null;
  const w = blendHistWeight(years);
  return `μ แบบ blend: ข้อมูล ${years.toFixed(1)} ปี (< ${BLEND_FULL_YEARS} ปี) — ให้น้ำหนัก CAPM ${((1 - w) * 100).toFixed(0)}% และผลตอบแทนในอดีต ${(w * 100).toFixed(0)}% (ผลตอบแทนช่วงสั้นมักไม่คงอยู่)`;
}

/** Bayes–Stein shrinkage of μ toward `target` (both annualized), with the annualized covariance. */
export function bayesSteinMu(
  hist: number[],
  target: number[],
  cov: number[][],
  years: number,
): { mu: number[]; delta: number } {
  const n = hist.length;
  const d = hist.map((h, i) => h - target[i]);
  const inv = invert(cov);
  let q = 0;
  if (inv) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) q += d[i] * inv[i][j] * d[j];
  const delta = !inv || !(q > 0) || !(years > 0) ? 1 : Math.min(1, (n + 2) / (n + 2 + years * q));
  return { mu: hist.map((h, i) => target[i] + (1 - delta) * (h - target[i])), delta };
}

export function shrinkageNote(delta: number): string {
  return `μ แบบ shrinkage (Bayes–Stein): ดึงเข้าหา CAPM ${(delta * 100).toFixed(0)}% ตามความยาวและความผันผวนของข้อมูล`;
}

/** |μ − CAPM| ≤ cap; returns the adjusted μ and the assets that moved. */
export function capMu(
  symbols: string[],
  mu: number[],
  capm: number[],
  cap: number | null | undefined,
  fixed: boolean[] = [],
): { mu: number[]; adjustments: { symbol: string; before: number; after: number; capm: number }[] } {
  if (cap == null || !(cap >= 0)) return { mu, adjustments: [] };
  const adjustments: { symbol: string; before: number; after: number; capm: number }[] = [];
  const out = mu.map((m, i) => {
    if (fixed[i]) return m;
    const lo = capm[i] - cap;
    const hi = capm[i] + cap;
    const v = Math.min(hi, Math.max(lo, m));
    if (v !== m) adjustments.push({ symbol: symbols[i], before: m, after: v, capm: capm[i] });
    return v;
  });
  return { mu: out, adjustments };
}
