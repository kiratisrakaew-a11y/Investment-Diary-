/**
 * Stress scenarios (Roadmap Phase 4). Instantaneous shocks applied to current positions with
 * documented sensitivities — no simulated prices.
 *  Equity:      ΔVᵢ = Vᵢ · βᵢ · ΔR_m          (β vs the benchmark, from the optimizer universe)
 *  Rates:       ΔVᵢ = Vᵢ · (−D_mod·Δy + ½·C·Δy²)   (bond analytics; or a duration override)
 *  FX:          ΔVᵢ = Vᵢ · ΔFX (USD assets)    — after the equity / rate effect: (1 + r)(1 + ΔFX) − 1
 *  Specific:    ΔVᵢ = Vᵢ · shockᵢ (per symbol, or a group of symbols)
 *  Liquidity:   haircut % by asset class on the sale value (cost of forced selling)
 *  Correlation: ρ' = ρ + k(1 − ρ) for i ≠ j, volatilities unchanged → σ_p' and 1-day parametric VaR
 */
import type { Matrix } from "./mpt";

export interface StressPosition {
  symbol: string;
  assetClass: string;
  currency: "THB" | "USD";
  value: number;
  beta: number | null;
  modifiedDuration: number | null;
  convexity: number | null;
  durationSource?: string;
}

export interface StressScenario {
  name?: string;
  equityShock?: number;
  rateShock?: number;
  fxShock?: number;
  specific?: Record<string, number>;
  groups?: { name: string; symbols: string[]; shock: number }[];
  liquidityHaircut?: Record<string, number>;
  durationOverride?: Record<string, number>;
  correlationShock?: number;
}

export function runStress(positions: StressPosition[], cash: number, s: StressScenario, cov?: { symbols: string[]; matrix: Matrix; periodsPerYear: number }) {
  const warnings: string[] = [];
  const nav = positions.reduce((a, p) => a + p.value, 0) + cash;
  const rows = positions.map((p) => {
    const sym = p.symbol.toUpperCase();
    let equity = 0;
    if (s.equityShock) {
      if (p.assetClass === "bond" || p.assetClass === "cash") equity = 0;
      else if (p.beta != null) equity = p.beta * s.equityShock;
      else warnings.push(`${p.symbol}: ไม่มี β — ไม่คิดผลจาก equity shock`);
    }
    let rate = 0;
    if (s.rateShock) {
      const d = s.durationOverride?.[sym] ?? p.modifiedDuration;
      if (d != null) rate = -d * s.rateShock + 0.5 * (s.durationOverride?.[sym] != null ? 0 : (p.convexity ?? 0)) * s.rateShock ** 2;
      else if (p.assetClass === "bond" || p.assetClass === "fund") warnings.push(`${p.symbol}: ไม่มี duration — ไม่คิดผลจาก rate shock (ใส่ durationOverride ได้)`);
    }
    let specific = s.specific?.[sym] ?? 0;
    for (const g of s.groups ?? []) if (g.symbols.map((x) => x.toUpperCase()).includes(sym)) specific += g.shock;
    const local = equity + rate + specific;
    const fx = p.currency === "USD" && s.fxShock ? (1 + local) * (1 + s.fxShock) - 1 - local : 0;
    const total = local + fx;
    const haircut = s.liquidityHaircut?.[p.assetClass] ?? 0;
    const afterShock = p.value * (1 + total);
    const liquidity = -afterShock * haircut;
    return {
      symbol: p.symbol,
      assetClass: p.assetClass,
      value: p.value,
      pnl: { equity: p.value * equity, rate: p.value * rate, specific: p.value * specific, fx: p.value * fx, liquidity, total: p.value * total + liquidity },
      returnPct: p.value > 0 ? (p.value * total + liquidity) / p.value : 0,
      assumptions: {
        beta: p.beta,
        modifiedDuration: s.durationOverride?.[sym] ?? p.modifiedDuration,
        durationSource: s.durationOverride?.[sym] != null ? "override" : p.durationSource ?? null,
      },
    };
  });
  const sum = (k: keyof (typeof rows)[number]["pnl"]) => rows.reduce((a, r) => a + r.pnl[k], 0);
  const totalPnl = sum("total");

  let correlation: null | { shock: number; volatilityBefore: number; volatilityAfter: number; var95Before: number; var95After: number } = null;
  if (s.correlationShock && cov) {
    const k = s.correlationShock;
    const idx = cov.symbols.map((sym) => positions.findIndex((p) => p.symbol.toUpperCase() === sym.toUpperCase()));
    const vals = idx.map((i) => (i >= 0 ? positions[i].value : 0));
    const tot = vals.reduce((a, b) => a + b, 0);
    if (tot > 0) {
      const w = vals.map((v) => v / tot);
      const M = cov.matrix;
      const sd = M.map((r, i) => Math.sqrt(Math.max(r[i], 0)));
      const shocked = M.map((r, i) => r.map((v, j) => (i === j || sd[i] === 0 || sd[j] === 0 ? v : (v / (sd[i] * sd[j]) + k * (1 - v / (sd[i] * sd[j]))) * sd[i] * sd[j])));
      const vol = (m: Matrix) => Math.sqrt(Math.max(0, w.reduce((s2, wi, i) => s2 + wi * m[i].reduce((t, x, j) => t + x * w[j], 0), 0)));
      const v0 = vol(M);
      const v1 = vol(shocked);
      const z = 1.6448536269514722; // 95% one-sided
      const day = Math.sqrt(1 / cov.periodsPerYear);
      correlation = { shock: k, volatilityBefore: v0, volatilityAfter: v1, var95Before: z * v0 * day * tot, var95After: z * v1 * day * tot };
      if (idx.some((i) => i < 0)) warnings.push("บางสินทรัพย์ใน covariance ไม่ได้ถืออยู่ — ใช้น้ำหนัก 0");
    } else warnings.push("ไม่มีสินทรัพย์ที่มี covariance — ข้าม correlation shock");
  } else if (s.correlationShock) warnings.push("ไม่มี covariance (ประวัติราคาไม่พอ) — ข้าม correlation shock");

  return {
    name: s.name ?? "custom",
    scenario: s,
    navBefore: nav,
    navAfter: nav + totalPnl,
    pnl: totalPnl,
    pnlPct: nav > 0 ? totalPnl / nav : 0,
    byFactor: { equity: sum("equity"), rate: sum("rate"), specific: sum("specific"), fx: sum("fx"), liquidity: sum("liquidity") },
    positions: rows,
    correlation,
    warnings: [...new Set(warnings)],
  };
}

/** Preset scenarios (sizes are illustrative and editable; shown with every result). */
export const PRESET_SCENARIOS: Record<string, StressScenario> = {
  equity_crash: { name: "หุ้นตก 20%", equityShock: -0.2 },
  rates_up: { name: "ดอกเบี้ยขึ้น 100bp", rateShock: 0.01 },
  thb_strengthens: { name: "บาทแข็ง 10%", fxShock: -0.1 },
  stagflation: { name: "หุ้นตก 15% + ดอกเบี้ยขึ้น 150bp + บาทแข็ง 5%", equityShock: -0.15, rateShock: 0.015, fxShock: -0.05 },
  correlation_spike: { name: "ความสัมพันธ์พุ่ง (k = 0.5)", correlationShock: 0.5 },
  liquidity: { name: "ขายด่วน: หุ้น 2%, กองทุน 1%, พันธบัตร 3%", liquidityHaircut: { thai_stock: 0.02, us_stock: 0.01, fund: 0.01, bond: 0.03, gold: 0.01 } },
};

/** Worst historical day / 21-day window of the given weights (replay of actual returns). */
export function historicalWorst(series: number[][], w: number[], dates: string[]) {
  const T = Math.min(...series.map((s) => s.length));
  if (!(T > 0)) return null;
  const port = Array.from({ length: T }, (_, t) => w.reduce((s, wi, i) => s + wi * series[i][t], 0));
  let worstDay = 0;
  for (let t = 1; t < T; t++) if (port[t] < port[worstDay]) worstDay = t;
  let worstWin = { ret: Infinity, end: 0 };
  const W = 21;
  for (let t = W - 1; t < T; t++) {
    let g = 1;
    for (let u = t - W + 1; u <= t; u++) g *= 1 + port[u];
    if (g - 1 < worstWin.ret) worstWin = { ret: g - 1, end: t };
  }
  // dates[t + 1] is the end date of return t.
  return {
    worstDay: { date: dates[worstDay + 1] ?? null, return: port[worstDay] },
    worst21d: Number.isFinite(worstWin.ret) ? { from: dates[worstWin.end - W + 1] ?? null, to: dates[worstWin.end + 1] ?? null, return: worstWin.ret } : null,
  };
}
