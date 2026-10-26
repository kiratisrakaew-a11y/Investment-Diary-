/**
 * Robustness diagnostics for the optimizer (Roadmap Phase 4). No new solver: every draw is solved
 * by the existing `recommend` (QP) with the same constraints.
 *  - Bootstrap: resample return dates with replacement → μ (via the caller's estimator), Σ (sample
 *    or Ledoit–Wolf, as selected) → weights. Reports the distribution of each weight.
 *  - Return sensitivity: μᵢ ± shock one asset at a time → change in recommended weights.
 * Not a formal robust optimization (no uncertainty-set objective); a diagnostic of estimation error.
 */
import { estimateInputs, ledoitWolf, type Matrix } from "./mpt";
import { recommend, type RecommendInput } from "./recommend";

export interface RobustInput {
  /** Periodic returns per asset (aligned). */
  series: number[][];
  periodsPerYear: number;
  covMethod: "sample" | "ledoit_wolf";
  /** μ estimator applied to a resampled set of rows (row indices into the series). */
  muFromRows: (rows: number[]) => number[];
  base: Omit<RecommendInput, "mu" | "cov">;
  baseWeights: number[];
  baseMu: number[];
  baseCov: Matrix;
  draws: number;
  returnShock: number;
  seed: number;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};

export function robustDiagnostics(x: RobustInput) {
  const n = x.series.length;
  const T = Math.min(...x.series.map((s) => s.length));
  const rand = rng(x.seed);
  const weights: number[][] = [];
  let failed = 0;
  const reasons = new Map<string, number>();
  for (let d = 0; d < x.draws; d++) {
    const rows = Array.from({ length: T }, () => Math.floor(rand() * T));
    const sample = x.series.map((s) => rows.map((r) => s[r]));
    const cov = x.covMethod === "ledoit_wolf" ? ledoitWolf(sample).cov.map((r) => r.map((v) => v * x.periodsPerYear)) : estimateInputs(sample, x.periodsPerYear).cov;
    const r = recommend({ ...x.base, mu: x.muFromRows(rows), cov });
    if (!r.ok) {
      failed++;
      reasons.set(r.issue.code, (reasons.get(r.issue.code) ?? 0) + 1);
      continue;
    }
    weights.push(r.allocations.map((a) => a.weight));
  }
  const symbols = x.base.symbols;
  const bootstrap = weights.length
    ? symbols.map((symbol, i) => {
        const ws = weights.map((w) => w[i]);
        const mean = ws.reduce((a, b) => a + b, 0) / ws.length;
        const sd = Math.sqrt(ws.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(ws.length - 1, 1));
        return { symbol, base: x.baseWeights[i], mean, sd, p05: quantile(ws, 0.05), p95: quantile(ws, 0.95), heldShare: ws.filter((v) => v > 1e-4).length / ws.length };
      })
    : [];
  const turnover = weights.length ? weights.reduce((s, w) => s + w.reduce((t, wi, i) => t + Math.abs(wi - x.baseWeights[i]), 0) / 2, 0) / weights.length : null;

  const sensitivity =
    x.returnShock > 0
      ? symbols.map((symbol, i) => {
          const run = (sign: 1 | -1) => {
            const mu = x.baseMu.map((m, k) => (k === i ? m + sign * x.returnShock : m));
            const r = recommend({ ...x.base, mu, cov: x.baseCov });
            return r.ok ? r.allocations.map((a) => a.weight) : null;
          };
          const up = run(1);
          const down = run(-1);
          const own = (w: number[] | null) => (w ? w[i] - x.baseWeights[i] : null);
          const shift = (w: number[] | null) => (w ? w.reduce((t, wi, k) => t + Math.abs(wi - x.baseWeights[k]), 0) / 2 : null);
          return { symbol, ownWeightChangeUp: own(up), ownWeightChangeDown: own(down), turnoverUp: shift(up), turnoverDown: shift(down) };
        })
      : [];

  return {
    method: "bootstrap (resample dates with replacement) + one-at-a-time μ shocks, same QP and constraints",
    draws: x.draws,
    succeeded: weights.length,
    failed,
    failureReasons: Object.fromEntries(reasons),
    observations: T,
    assets: n,
    bootstrap,
    /** Average of the bootstrapped weights (resampled efficiency, Michaud-style) — an alternative, not the recommendation. */
    resampledWeights: bootstrap.map((b) => ({ symbol: b.symbol, weight: b.mean })),
    averageTurnoverVsBase: turnover,
    returnShock: x.returnShock,
    sensitivity,
  };
}
