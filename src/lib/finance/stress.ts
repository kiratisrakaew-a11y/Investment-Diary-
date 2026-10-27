/**
 * Stress scenarios (Roadmap Phase 4). Instantaneous shocks applied to current positions with
 * documented sensitivities — no simulated prices.
 *  Equity:      ΔVᵢ = Vᵢ · βᵢ · ΔR_m          (β vs the benchmark, from the optimizer universe)
 *  Rates:       ΔVᵢ = Vᵢ · (−D_mod·Δy + ½·C·Δy²)   (bond analytics; or a duration override)
 *  Credit:      Δs (bp, global or per symbol) on bonds. With a rate shock the bond is repriced once on
 *               Δy + Δs (2nd-order duration/convexity): rate P&L = f(Δy), spread P&L = f(Δy + Δs) − f(Δy)
 *               (the cross term sits in the spread line, so the parts sum to the total). Spread duration =
 *               bump-and-reprice Z-spread duration when a curve is set, else modified duration (proxy, labelled).
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
  /** Spread duration from curve repricing; null → modified duration is used as a labelled proxy for bonds. */
  spreadDuration?: number | null;
  issuer?: string | null;
  rating?: string | null;
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
  /** Parallel credit-spread widening in basis points for all bonds (100 = +1%). */
  creditSpreadShockBp?: number;
  /** Per-symbol spread shock in bp (overrides the global value for that symbol). */
  creditSpreadShockBpBySymbol?: Record<string, number>;
  /** Spread duration for funds / instruments without bond analytics. */
  spreadDurationOverride?: Record<string, number>;
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
    const d = s.durationOverride?.[sym] ?? p.modifiedDuration;
    const conv = s.durationOverride?.[sym] != null ? 0 : (p.convexity ?? 0);
    const priceChange = (dy: number, dur: number) => -dur * dy + 0.5 * conv * dy * dy;
    if (s.rateShock) {
      if (d != null) rate = priceChange(s.rateShock, d);
      else if (p.assetClass === "bond" || p.assetClass === "fund") warnings.push(`${p.symbol}: ไม่มี duration — ไม่คิดผลจาก rate shock (ใส่ durationOverride ได้)`);
    }
    // Credit spread: bonds (and funds with a spread-duration override) only.
    let credit = 0;
    let spreadBasis: string | null = null;
    const ds = (s.creditSpreadShockBpBySymbol?.[sym] ?? s.creditSpreadShockBp ?? 0) / 10_000;
    if (ds) {
      const sd = s.spreadDurationOverride?.[sym] ?? p.spreadDuration ?? (p.assetClass === "bond" ? p.modifiedDuration : null);
      if (sd != null && (p.assetClass === "bond" || s.spreadDurationOverride?.[sym] != null)) {
        spreadBasis = s.spreadDurationOverride?.[sym] != null ? "override" : p.spreadDuration != null ? "Z-spread repricing" : "modified duration (proxy)";
        const dy = s.rateShock && d != null ? s.rateShock : 0;
        // Combined repricing −D·Δy − SD·Δs + ½C(Δy + Δs)²; rate line = f(Δy), spread line = the rest (incl. cross term).
        credit = -sd * ds + 0.5 * conv * ((dy + ds) ** 2 - dy ** 2);
      } else if (p.assetClass === "bond" || p.assetClass === "fund") {
        warnings.push(`${p.symbol}: ไม่มี spread duration — ไม่คิดผลจาก credit spread shock (ใส่ spreadDurationOverride ได้)`);
      }
    }
    let specific = s.specific?.[sym] ?? 0;
    for (const g of s.groups ?? []) if (g.symbols.map((x) => x.toUpperCase()).includes(sym)) specific += g.shock;
    const local = equity + rate + credit + specific;
    const fx = p.currency === "USD" && s.fxShock ? (1 + local) * (1 + s.fxShock) - 1 - local : 0;
    const linear = local + fx;
    // A long, fully paid position cannot lose more than its value. Linear β / duration sensitivities
    // can exceed −100% for large shocks: the total is floored at −100% (the linear figure is kept and
    // flagged) and the factor lines are scaled by the same ratio so they still sum to the total.
    const bounded = p.value > 0 && linear < -1;
    const total = bounded ? -1 : linear;
    const scale = bounded ? total / linear : 1;
    if (bounded)
      warnings.push(
        `${p.symbol}: ผลรวม shock แบบเส้นตรง ${(linear * 100).toFixed(1)}% เกินขาดทุนเต็มมูลค่า — สถานะซื้อที่จ่ายเต็มขาดทุนได้ไม่เกิน 100% จึงจำกัดที่ −100% (ค่าประมาณแบบ β / duration ใช้ไม่ได้ในช่วงนี้)`,
      );
    const haircut = s.liquidityHaircut?.[p.assetClass] ?? 0;
    const afterShock = p.value * (1 + total);
    const liquidity = -afterShock * haircut;
    return {
      symbol: p.symbol,
      assetClass: p.assetClass,
      value: p.value,
      pnl: {
        equity: p.value * equity * scale,
        rate: p.value * rate * scale,
        credit: p.value * credit * scale,
        specific: p.value * specific * scale,
        fx: p.value * fx * scale,
        liquidity,
        total: p.value * total + liquidity,
      },
      returnPct: p.value > 0 ? (p.value * total + liquidity) / p.value : 0,
      /** Sum of the linear sensitivities before the −100% floor (equal to the shock return when not bounded). */
      linearReturn: linear,
      boundedAtFullLoss: bounded,
      assumptions: {
        beta: p.beta,
        modifiedDuration: s.durationOverride?.[sym] ?? p.modifiedDuration,
        durationSource: s.durationOverride?.[sym] != null ? "override" : p.durationSource ?? null,
        spreadShockBp: ds ? ds * 10_000 : null,
        spreadBasis,
        issuer: p.issuer ?? null,
        rating: p.rating ?? null,
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
    byFactor: { equity: sum("equity"), rate: sum("rate"), credit: sum("credit"), specific: sum("specific"), fx: sum("fx"), liquidity: sum("liquidity") },
    exposure: {
      byIssuer: groupBy(positions, rows, (p) => p.issuer ?? null),
      byRating: groupBy(positions.filter((p) => p.assetClass === "bond"), rows, (p) => p.rating ?? "unrated"),
    },
    positions: rows,
    correlation,
    warnings: [...new Set(warnings)],
  };
}

function groupBy(positions: StressPosition[], rows: { symbol: string; pnl: { total: number } }[], key: (p: StressPosition) => string | null) {
  const m = new Map<string, { key: string; value: number; pnl: number; symbols: string[] }>();
  for (const p of positions) {
    const k = key(p);
    if (k == null) continue;
    const g = m.get(k) ?? { key: k, value: 0, pnl: 0, symbols: [] };
    g.value += p.value;
    g.pnl += rows.find((r) => r.symbol === p.symbol)?.pnl.total ?? 0;
    g.symbols.push(p.symbol);
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.value - a.value);
}

/** Preset scenarios (sizes are illustrative and editable; shown with every result). */
export const PRESET_SCENARIOS: Record<string, StressScenario> = {
  equity_crash: { name: "หุ้นตก 20%", equityShock: -0.2 },
  rates_up: { name: "ดอกเบี้ยขึ้น 100bp", rateShock: 0.01 },
  thb_strengthens: { name: "บาทแข็ง 10%", fxShock: -0.1 },
  stagflation: { name: "หุ้นตก 15% + ดอกเบี้ยขึ้น 150bp + บาทแข็ง 5%", equityShock: -0.15, rateShock: 0.015, fxShock: -0.05 },
  correlation_spike: { name: "ความสัมพันธ์พุ่ง (k = 0.5)", correlationShock: 0.5 },
  credit_widening: { name: "Credit spread กว้างขึ้น 100bp", creditSpreadShockBp: 100 },
  rates_and_credit: { name: "ดอกเบี้ยขึ้น 100bp + credit spread กว้างขึ้น 50bp", rateShock: 0.01, creditSpreadShockBp: 50 },
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
