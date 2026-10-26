/**
 * Risk decomposition (Roadmap Phase 4). Uses the existing covariance and ES definitions.
 *  MCTRᵢ = (Σw)ᵢ / σ_p ;  RCᵢ = wᵢ · MCTRᵢ ;  Σ RCᵢ = σ_p (Euler).
 *  Component ES (historical): on the portfolio's worst n(1 − c) observations (fractional boundary,
 *  as in `expectedShortfall`), ESᵢ = −wᵢ · E[rᵢ | tail]; Σ ESᵢ = ES_p.
 */
import { MIN_VAR_OBS, expectedShortfall } from "./risk";
import type { Matrix } from "./mpt";

export interface RiskContribution {
  volatility: number;
  assets: { symbol: string; weight: number; mctr: number; contribution: number; share: number }[];
  concentration: { hhi: number; effectiveN: number; maxWeight: number; top3: number; riskHhi: number; effectiveRiskN: number };
}

export function riskContribution(symbols: string[], w: number[], cov: Matrix): RiskContribution {
  const sw = cov.map((row) => row.reduce((s, x, j) => s + x * w[j], 0));
  const variance = w.reduce((s, wi, i) => s + wi * sw[i], 0);
  const vol = Math.sqrt(Math.max(variance, 0));
  const assets = symbols.map((symbol, i) => {
    const mctr = vol > 0 ? sw[i] / vol : 0;
    const contribution = w[i] * mctr;
    return { symbol, weight: w[i], mctr, contribution, share: vol > 0 ? contribution / vol : 0 };
  });
  const sumW = w.reduce((a, b) => a + Math.abs(b), 0) || 1;
  const nw = w.map((x) => Math.abs(x) / sumW);
  const hhi = nw.reduce((s, x) => s + x * x, 0);
  const sorted = [...nw].sort((a, b) => b - a);
  // Risk-share concentration (shares can be negative for hedges; use their absolute values).
  const rs = assets.map((a) => Math.abs(a.share));
  const rsSum = rs.reduce((a, b) => a + b, 0) || 1;
  const riskHhi = rs.reduce((s, x) => s + (x / rsSum) ** 2, 0);
  return {
    volatility: vol,
    assets,
    concentration: { hhi, effectiveN: hhi > 0 ? 1 / hhi : 0, maxWeight: sorted[0] ?? 0, top3: sorted.slice(0, 3).reduce((a, b) => a + b, 0), riskHhi, effectiveRiskN: riskHhi > 0 ? 1 / riskHhi : 0 },
  };
}

/** Historical component ES at confidence c; null below the minimum sample (same rule as ES). */
export function componentES(symbols: string[], w: number[], series: number[][], c = 0.95) {
  const T = Math.min(...series.map((s) => s.length));
  if (!(T >= MIN_VAR_OBS)) return null;
  const port = Array.from({ length: T }, (_, t) => w.reduce((s, wi, i) => s + wi * series[i][t], 0));
  const order = port.map((r, t) => [r, t] as const).sort((a, b) => a[0] - b[0]);
  const k = T * (1 - c);
  const whole = Math.floor(k);
  const weightOf = (rank: number) => (rank < whole ? 1 : rank === whole && k > whole ? k - whole : 0);
  const contrib = symbols.map((_, i) => {
    let s = 0;
    for (let r = 0; r <= whole && r < T; r++) s += weightOf(r) * w[i] * series[i][order[r][1]];
    return -s / k;
  });
  const es = expectedShortfall(port, c);
  return {
    confidence: c,
    observations: T,
    expectedShortfall: es,
    assets: symbols.map((symbol, i) => ({ symbol, contribution: contrib[i], share: es ? contrib[i] / es : null })),
  };
}
