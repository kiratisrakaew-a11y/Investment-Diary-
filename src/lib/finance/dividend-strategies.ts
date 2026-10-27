/**
 * Dividend screening strategies (Strategies Phase 1). Pure and deterministic.
 *
 * Pipeline: dividend profiles (dividend-metrics.ts) → filters (editable thresholds) → factor scores
 * (cross-sectional percentile ranks, direction-adjusted, outlier-robust) → composite score over the
 * factors that are available (coverage reported; required factors never imputed) → top N → weights
 * (equal / score; caps by asset, issuer and sector; cash reserve). Optimizer-constrained weights and
 * order sizing are done by the existing services (optimizePortfolio / rebalancePortfolio).
 *
 * Default thresholds and weights are illustrative and editable — not investment advice.
 */
import { z } from "zod";
import type { DividendProfile, MetricResult } from "./dividend-metrics";

export const DIVIDEND_STRATEGY_IDS = ["dividend_sustainable_income", "dividend_growth", "dividend_quality_total_return"] as const;
export type DividendStrategyId = (typeof DIVIDEND_STRATEGY_IDS)[number];

export const FACTOR_KEYS = [
  "ttmYieldRegular",
  "consistencyYears",
  "earningsPayout",
  "fcfPayout",
  "dpsCagr3",
  "dpsCagr5",
  "roe",
  "netDebtToEbitda",
  "interestCoverage",
  "cfoToNetIncome",
  "fcfStability",
  "marginOfSafety",
  "yieldVsHistory",
] as const;
export type FactorKey = (typeof FACTOR_KEYS)[number];

/** Higher is better unless listed here. */
const LOWER_IS_BETTER: Partial<Record<FactorKey, true>> = { earningsPayout: true, fcfPayout: true, netDebtToEbitda: true };

export const FACTOR_LABEL: Record<FactorKey, string> = {
  ttmYieldRegular: "Dividend yield 12 เดือน (ปกติ)",
  consistencyYears: "ปีที่จ่ายต่อเนื่อง",
  earningsPayout: "อัตราจ่ายจากกำไร (ต่ำดี)",
  fcfPayout: "อัตราจ่ายจาก FCF (ต่ำดี)",
  dpsCagr3: "DPS โต 3 ปี",
  dpsCagr5: "DPS โต 5 ปี",
  roe: "ROE",
  netDebtToEbitda: "Net debt/EBITDA (ต่ำดี)",
  interestCoverage: "ความสามารถจ่ายดอกเบี้ย",
  cfoToNetIncome: "CFO/กำไรสุทธิ",
  fcfStability: "ความสม่ำเสมอของ FCF",
  marginOfSafety: "ส่วนเผื่อความปลอดภัย (valuation)",
  yieldVsHistory: "Yield เทียบอดีตตัวเอง",
};

const factor = z.object({ weight: z.number().min(0).max(1), required: z.boolean().default(false) });

export const strategySettingsSchema = z.object({
  factors: z.partialRecord(z.enum(FACTOR_KEYS), factor).describe("Factor weights (renormalized over available factors) and whether a factor is required"),
  filters: z
    .object({
      minYield: z.number().min(0).max(1).nullable().default(null).describe("Minimum regular TTM yield (decimal)"),
      minConsecutiveYears: z.number().int().min(0).max(50).nullable().default(null),
      minHistoryYears: z.number().int().min(0).max(50).nullable().default(null).describe("Minimum years of dividend history"),
      maxEarningsPayout: z.number().min(0).max(5).nullable().default(null),
      maxFcfPayout: z.number().min(0).max(5).nullable().default(null),
      excludeNegativeFcf: z.boolean().default(false),
      minDpsCagr5: z.number().min(-1).max(1).nullable().default(null),
      maxNetDebtToEbitda: z.number().min(0).max(50).nullable().default(null),
      excludeYieldFromPriceDrop: z.boolean().default(true).describe("Exclude when the yield is high mainly because the price fell ≥ 25% in 12 months"),
      minLiquidityThb: z.number().positive().nullable().default(null).describe("Not supported: the app stores no volume data"),
    })
    .default({
      minYield: null,
      minConsecutiveYears: null,
      minHistoryYears: null,
      maxEarningsPayout: null,
      maxFcfPayout: null,
      excludeNegativeFcf: false,
      minDpsCagr5: null,
      maxNetDebtToEbitda: null,
      excludeYieldFromPriceDrop: true,
      minLiquidityThb: null,
    }),
  minCoverage: z.number().min(0).max(1).default(0.6).describe("Minimum share of factor weight with data"),
  includeSpecial: z.boolean().default(false).describe("Count special dividends in the total yield"),
  topN: z.number().int().min(1).max(50).default(10),
  weighting: z.enum(["equal", "score", "optimizer"]).default("equal"),
  maxWeight: z.number().gt(0).max(1).default(0.25),
  maxPerIssuer: z.number().gt(0).max(1).nullable().default(0.1),
  maxPerSector: z.number().gt(0).max(1).nullable().default(null),
  cashReserve: z.number().min(0).max(0.9).default(0).describe("Share of the portfolio kept in cash"),
});
export type StrategySettings = z.infer<typeof strategySettingsSchema>;
export type StrategySettingsInput = z.input<typeof strategySettingsSchema>;

export interface Preset {
  id: DividendStrategyId;
  version: string;
  label: string;
  description: string;
  settings: StrategySettingsInput;
}

/** Illustrative defaults (v1.0.0). Every number is editable. */
export const DIVIDEND_PRESETS: Record<DividendStrategyId, Preset> = {
  dividend_sustainable_income: {
    id: "dividend_sustainable_income",
    version: "1.0.0",
    label: "รายได้ปันผลที่ยั่งยืน",
    description: "เน้น yield ปกติ จ่ายต่อเนื่อง อัตราจ่ายไม่ตึงเกินกำไร/FCF และงบดุลแข็งแรง",
    settings: {
      factors: {
        ttmYieldRegular: { weight: 0.3, required: true },
        consistencyYears: { weight: 0.2, required: true },
        earningsPayout: { weight: 0.15 },
        fcfPayout: { weight: 0.15 },
        netDebtToEbitda: { weight: 0.1 },
        interestCoverage: { weight: 0.1 },
      },
      filters: { minConsecutiveYears: 3, maxEarningsPayout: 0.8, maxFcfPayout: 1, excludeNegativeFcf: true },
    },
  },
  dividend_growth: {
    id: "dividend_growth",
    version: "1.0.0",
    label: "ปันผลเติบโต",
    description: "เน้น DPS โตต่อเนื่องหลายปี จ่ายสม่ำเสมอ และอัตราจ่ายที่ยังเพิ่มได้",
    settings: {
      factors: {
        dpsCagr5: { weight: 0.35, required: true },
        dpsCagr3: { weight: 0.15 },
        consistencyYears: { weight: 0.2 },
        earningsPayout: { weight: 0.15 },
        roe: { weight: 0.15 },
      },
      filters: { minDpsCagr5: 0, minConsecutiveYears: 5, maxEarningsPayout: 0.8 },
    },
  },
  dividend_quality_total_return: {
    id: "dividend_quality_total_return",
    version: "1.0.0",
    label: "คุณภาพ + ผลตอบแทนรวม",
    description: "ผสมรายได้ การเติบโตของปันผล คุณภาพกิจการ และวินัยด้านราคา (margin of safety ถ้ามี valuation ณ วันนั้น)",
    settings: {
      factors: {
        ttmYieldRegular: { weight: 0.2 },
        dpsCagr5: { weight: 0.2 },
        roe: { weight: 0.15 },
        cfoToNetIncome: { weight: 0.1 },
        netDebtToEbitda: { weight: 0.1 },
        fcfStability: { weight: 0.1 },
        marginOfSafety: { weight: 0.15 },
      },
      filters: { maxEarningsPayout: 0.9, excludeNegativeFcf: true },
      minCoverage: 0.5,
    },
  },
};

/** Preset settings merged with user overrides (factors replaced wholesale when given). */
export function resolveSettings(id: DividendStrategyId, overrides?: Partial<StrategySettingsInput>): StrategySettings {
  const base = DIVIDEND_PRESETS[id].settings;
  return strategySettingsSchema.parse({
    ...base,
    ...overrides,
    factors: overrides?.factors ?? base.factors,
    filters: { ...strategySettingsSchema.shape.filters.parse(base.filters), ...(overrides?.filters ?? {}) },
  });
}

export interface Candidate {
  symbol: string;
  issuer: string | null;
  sector: string | null;
  profile: DividendProfile;
  /** Upside of a valuation known at the as-of date (intrinsic ÷ price − 1), when available. */
  marginOfSafety?: number | null;
}

export interface Exclusion {
  symbol: string;
  code: string;
  detail: string;
}

export interface FactorContribution {
  key: FactorKey;
  value: number | null;
  status: string;
  rank: number | null;
  weight: number;
  contribution: number | null;
  note?: string;
}

export interface ScoredCandidate {
  symbol: string;
  issuer: string | null;
  sector: string | null;
  score: number;
  coverage: number;
  factors: FactorContribution[];
  warnings: string[];
}

export interface StrategyDecision {
  strategyId: DividendStrategyId;
  strategyVersion: string;
  asOf: string;
  eligibleSymbols: string[];
  excluded: Exclusion[];
  ranked: ScoredCandidate[];
  selected: string[];
  targetWeights: Record<string, number>;
  scores: Record<string, number>;
  sourceStatus: "verified" | "partial" | "insufficient";
  diagnostics: string[];
  settings: StrategySettings;
}

const metricOf = (c: Candidate, k: FactorKey): { value: number | null; status: string; note?: string } => {
  const p = c.profile;
  const m = (r: MetricResult) => ({ value: r.value, status: r.status, note: r.warnings[0] });
  switch (k) {
    case "ttmYieldRegular":
      return m(p.ttm.regular);
    case "consistencyYears":
      return m(p.consistency.consecutiveYears);
    case "earningsPayout":
      return m(p.earningsPayout);
    case "fcfPayout":
      return m(p.fcfPayout);
    case "dpsCagr3":
      return m(p.cagr3);
    case "dpsCagr5":
      return m(p.cagr5);
    case "roe":
      return m(p.quality.roe);
    case "netDebtToEbitda":
      return m(p.quality.netDebtToEbitda);
    case "interestCoverage":
      return m(p.quality.interestCoverage);
    case "cfoToNetIncome":
      return m(p.quality.cfoToNetIncome);
    case "fcfStability":
      return m(p.quality.fcfStability);
    case "yieldVsHistory":
      return p.yieldHistory.priceDropFlag ? { value: null, status: "not_meaningful", note: "yield สูงเพราะราคาร่วง" } : m(p.yieldHistory);
    case "marginOfSafety":
      return c.marginOfSafety == null ? { value: null, status: "unavailable", note: "ไม่มี valuation ณ วันนั้น" } : { value: c.marginOfSafety, status: "available" };
  }
};

/** Percentile ranks in [0, 1] (average rank for ties); a single value ranks 0.5. */
export function percentileRanks(values: number[]): number[] {
  if (values.length === 1) return [0.5];
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = Array(values.length).fill(0);
  for (let k = 0; k < idx.length; ) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
    const r = (k + j) / 2 / (values.length - 1);
    for (let m = k; m <= j; m++) out[idx[m].i] = r;
    k = j + 1;
  }
  return out;
}

/** Filters; a filter whose metric is missing excludes (no selection from missing fields). */
function applyFilters(c: Candidate, s: StrategySettings): Exclusion | null {
  const f = s.filters;
  const p = c.profile;
  const ex = (code: string, detail: string) => ({ symbol: c.symbol, code, detail });
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  if (p.price == null) return ex("no_price", "ไม่มีราคา ณ วันอ้างอิง");
  if (!p.eventCount && !p.annual.series.length) return ex("no_dividend_history", "ไม่มีข้อมูลปันผล");
  if (f.minYield != null) {
    const v = p.ttm.regular.value;
    if (v == null) return ex("insufficient_data", `yield: ${p.ttm.regular.warnings[0] ?? p.ttm.regular.status}`);
    if (v < f.minYield) return ex("below_min_yield", `yield ${pct(v)} < ${pct(f.minYield)}`);
  }
  if (f.minHistoryYears != null && p.consistency.historyYears < f.minHistoryYears) return ex("short_history", `ประวัติปันผล ${p.consistency.historyYears} ปี < ${f.minHistoryYears}`);
  if (f.minConsecutiveYears != null) {
    const v = p.consistency.consecutiveYears.value;
    if (v == null) return ex("insufficient_data", "ไม่มีประวัติปันผลรายปี");
    if (v < f.minConsecutiveYears) return ex("below_min_consecutive_years", `จ่ายต่อเนื่อง ${v} ปี < ${f.minConsecutiveYears}`);
  }
  if (f.maxEarningsPayout != null) {
    const r = p.earningsPayout;
    if (r.status === "not_meaningful") return ex("payout_not_meaningful", r.warnings[0] ?? "EPS ≤ 0");
    if (r.value == null) return ex("insufficient_data", `อัตราจ่าย: ${r.warnings[0] ?? r.status}`);
    if (r.value > f.maxEarningsPayout) return ex("payout_above_max", `อัตราจ่าย ${pct(r.value)} > ${pct(f.maxEarningsPayout)}`);
  }
  if (f.excludeNegativeFcf && !p.financialSector) {
    const fp = p.fcfPayout;
    if (fp.status === "not_meaningful") return ex("negative_fcf", fp.warnings[0] ?? "FCF ≤ 0");
    if (fp.status === "unavailable") return ex("insufficient_data", `FCF: ${fp.warnings[0] ?? "ไม่มีข้อมูล"}`);
  }
  if (f.maxFcfPayout != null && !p.financialSector) {
    const r = p.fcfPayout;
    if (r.value == null) return ex(r.status === "not_meaningful" ? "negative_fcf" : "insufficient_data", `FCF payout: ${r.warnings[0] ?? r.status}`);
    if (r.value > f.maxFcfPayout) return ex("fcf_payout_above_max", `FCF payout ${pct(r.value)} > ${pct(f.maxFcfPayout)}`);
  }
  if (f.minDpsCagr5 != null) {
    const r = p.cagr5;
    if (r.value == null) return ex("insufficient_data", `DPS CAGR 5 ปี: ${r.warnings[0] ?? r.status}`);
    if (r.value < f.minDpsCagr5) return ex("dps_cagr_below_min", `DPS CAGR 5 ปี ${pct(r.value)} < ${pct(f.minDpsCagr5)}`);
  }
  if (f.maxNetDebtToEbitda != null && !p.financialSector) {
    const r = p.quality.netDebtToEbitda;
    if (r.value == null) return ex("insufficient_data", `Net debt/EBITDA: ${r.warnings[0] ?? r.status}`);
    if (r.value > f.maxNetDebtToEbitda) return ex("leverage_above_max", `Net debt/EBITDA ${r.value.toFixed(2)} > ${f.maxNetDebtToEbitda}`);
  }
  if (f.excludeYieldFromPriceDrop && p.yieldHistory.priceDropFlag) return ex("yield_inflated_by_price_drop", p.yieldHistory.warnings[0] ?? "yield สูงเพราะราคาร่วง");
  return null;
}

/** Iterative capping: scale each over-cap group down to its cap and redistribute to uncapped names. */
export function capWeights(raw: Record<string, number>, caps: { maxWeight: number; groups: { name: string; members: string[]; cap: number }[] }): { weights: Record<string, number>; unallocated: number; notes: string[] } {
  const w = { ...raw };
  const syms = Object.keys(w);
  const notes: string[] = [];
  const frozen = new Set<string>();
  for (let it = 0; it < 50; it++) {
    let changed = false;
    for (const s of syms) {
      if (w[s] > caps.maxWeight + 1e-12) {
        w[s] = caps.maxWeight;
        frozen.add(s);
        changed = true;
      }
    }
    for (const g of caps.groups) {
      const tot = g.members.reduce((a, s) => a + (w[s] ?? 0), 0);
      if (tot > g.cap + 1e-12) {
        for (const s of g.members) {
          w[s] = (w[s] * g.cap) / tot;
          frozen.add(s);
        }
        changed = true;
      }
    }
    const total = syms.reduce((a, s) => a + w[s], 0);
    const free = syms.filter((s) => !frozen.has(s));
    const freeTot = free.reduce((a, s) => a + w[s], 0);
    const gap = 1 - total;
    if (gap > 1e-9 && freeTot > 0) {
      for (const s of free) w[s] += (gap * w[s]) / freeTot;
      changed = true;
    }
    if (!changed) break;
  }
  const total = syms.reduce((a, s) => a + w[s], 0);
  const unallocated = Math.max(0, 1 - total);
  if (unallocated > 1e-6) notes.push(`เพดานน้ำหนักทำให้ลงทุนได้ ${(total * 100).toFixed(1)}% — ส่วนที่เหลือ ${(unallocated * 100).toFixed(1)}% เป็นเงินสด`);
  return { weights: w, unallocated, notes };
}

/** Screen, score and weight candidates as of a date. Weighting "optimizer" leaves weights to the service. */
export function screenDividendStrategy(x: { strategyId: DividendStrategyId; asOf: string; candidates: Candidate[]; settings?: Partial<StrategySettingsInput> }): StrategyDecision {
  const preset = DIVIDEND_PRESETS[x.strategyId];
  const s = resolveSettings(x.strategyId, x.settings);
  const diagnostics: string[] = [];
  if (s.filters.minLiquidityThb != null) diagnostics.push("minLiquidityThb: ไม่รองรับ — แอปไม่มีข้อมูลปริมาณการซื้อขาย (ไม่ได้กรอง)");
  const excluded: Exclusion[] = [];
  const passed: Candidate[] = [];
  for (const c of x.candidates) {
    const e = applyFilters(c, s);
    if (e) excluded.push(e);
    else passed.push(c);
  }
  const keys = (Object.keys(s.factors) as FactorKey[]).filter((k) => s.factors[k]!.weight > 0);
  const totalWeight = keys.reduce((a, k) => a + s.factors[k]!.weight, 0);
  // Required factors must be present (no imputation).
  const eligible: Candidate[] = [];
  for (const c of passed) {
    const missing = keys.filter((k) => s.factors[k]!.required && metricOf(c, k).value == null);
    if (missing.length) excluded.push({ symbol: c.symbol, code: "insufficient_data", detail: `ไม่มีปัจจัยที่จำเป็น: ${missing.map((k) => FACTOR_LABEL[k]).join(", ")}` });
    else eligible.push(c);
  }
  // Cross-sectional ranks per factor over candidates that have the value.
  const ranks = new Map<FactorKey, Map<string, number>>();
  for (const k of keys) {
    const have = eligible.map((c) => ({ c, v: metricOf(c, k).value })).filter((r): r is { c: Candidate; v: number } => r.v != null);
    const pr = percentileRanks(have.map((h) => (LOWER_IS_BETTER[k] ? -h.v : h.v)));
    ranks.set(k, new Map(have.map((h, i) => [h.c.symbol, pr[i]])));
  }
  const ranked: ScoredCandidate[] = [];
  for (const c of eligible) {
    const factors: FactorContribution[] = keys.map((k) => {
      const m = metricOf(c, k);
      return { key: k, value: m.value, status: m.status, rank: ranks.get(k)!.get(c.symbol) ?? null, weight: s.factors[k]!.weight, contribution: null, note: m.note };
    });
    const avail = factors.filter((f) => f.rank != null);
    const wAvail = avail.reduce((a, f) => a + f.weight, 0);
    const coverage = totalWeight > 0 ? wAvail / totalWeight : 0;
    if (!avail.length || coverage < s.minCoverage) {
      excluded.push({ symbol: c.symbol, code: "low_factor_coverage", detail: `มีข้อมูลปัจจัย ${(coverage * 100).toFixed(0)}% ของน้ำหนัก < ${(s.minCoverage * 100).toFixed(0)}%` });
      continue;
    }
    for (const f of avail) f.contribution = (f.weight * f.rank!) / wAvail;
    const score = avail.reduce((a, f) => a + f.contribution!, 0);
    ranked.push({
      symbol: c.symbol,
      issuer: c.issuer,
      sector: c.sector,
      score,
      coverage,
      factors,
      warnings: coverage < 1 ? [`คะแนนจากปัจจัยที่มีข้อมูล ${(coverage * 100).toFixed(0)}% ของน้ำหนัก (ปรับสัดส่วนใหม่ ไม่เติมค่าแทน)`] : [],
    });
  }
  // Tie-break: score ↓, regular TTM yield ↓, symbol ↑.
  const yieldOf = (sym: string) => x.candidates.find((c) => c.symbol === sym)!.profile.ttm.regular.value ?? -Infinity;
  ranked.sort((a, b) => b.score - a.score || yieldOf(b.symbol) - yieldOf(a.symbol) || a.symbol.localeCompare(b.symbol));
  const selected = ranked.slice(0, s.topN);
  if (eligible.length === 1) diagnostics.push("มีผู้ผ่านเกณฑ์ 1 ตัว — อันดับเทียบกันไม่ได้ (คะแนนกลาง 0.5)");

  let targetWeights: Record<string, number> = {};
  if (selected.length && s.weighting !== "optimizer") {
    const raw =
      s.weighting === "score" && selected.some((r) => r.score > 0)
        ? Object.fromEntries(selected.map((r) => [r.symbol, r.score / selected.reduce((a, q) => a + q.score, 0)]))
        : Object.fromEntries(selected.map((r) => [r.symbol, 1 / selected.length]));
    const groups: { name: string; members: string[]; cap: number }[] = [];
    const byKey = (key: (r: ScoredCandidate) => string | null, cap: number | null, label: string) => {
      if (cap == null) return;
      const m = new Map<string, string[]>();
      for (const r of selected) {
        const k = key(r);
        if (k) m.set(k, [...(m.get(k) ?? []), r.symbol]);
      }
      for (const [k, members] of m) groups.push({ name: `${label} ${k}`, members, cap });
      const un = selected.filter((r) => !key(r)).map((r) => r.symbol);
      if (un.length) diagnostics.push(`ยังไม่ระบุ${label} (ไม่อยู่ใต้เพดาน${label}): ${un.join(", ")}`);
    };
    byKey((r) => r.issuer, s.maxPerIssuer, "ผู้ออก");
    byKey((r) => r.sector, s.maxPerSector, "หมวด");
    const capped = capWeights(raw, { maxWeight: s.maxWeight, groups });
    diagnostics.push(...capped.notes);
    targetWeights = Object.fromEntries(Object.entries(capped.weights).map(([k, v]) => [k, v * (1 - s.cashReserve)]));
  }
  const statuses = selected.map((r) => r.coverage);
  const sourceStatus: StrategyDecision["sourceStatus"] = !selected.length ? "insufficient" : statuses.every((c) => c >= 1) ? "verified" : "partial";
  return {
    strategyId: x.strategyId,
    strategyVersion: preset.version,
    asOf: x.asOf,
    eligibleSymbols: ranked.map((r) => r.symbol),
    excluded,
    ranked,
    selected: selected.map((r) => r.symbol),
    targetWeights,
    scores: Object.fromEntries(ranked.map((r) => [r.symbol, r.score])),
    sourceStatus,
    diagnostics,
    settings: s,
  };
}

// ------------------------------------------------------------------ point-in-time helpers (backtest)

/** Factors and filters that need financial statements. */
const STATEMENT_FACTORS: FactorKey[] = ["earningsPayout", "fcfPayout", "roe", "netDebtToEbitda", "interestCoverage", "cfoToNetIncome", "fcfStability"];

export function usesStatements(s: StrategySettings): string[] {
  const out = (Object.keys(s.factors) as FactorKey[]).filter((k) => s.factors[k]!.weight > 0 && STATEMENT_FACTORS.includes(k)).map((k) => FACTOR_LABEL[k]);
  const f = s.filters;
  if (f.maxEarningsPayout != null) out.push("filter maxEarningsPayout");
  if (f.maxFcfPayout != null) out.push("filter maxFcfPayout");
  if (f.excludeNegativeFcf) out.push("filter excludeNegativeFcf");
  if (f.maxNetDebtToEbitda != null) out.push("filter maxNetDebtToEbitda");
  return out;
}

export type PitMode = "strict" | "illustrative_lookahead";

/**
 * Statements usable at a cutoff. strict: published on/before the cutoff. illustrative_lookahead: also
 * statements without a publication date for fiscal years ending before the cutoff year (biased, labelled).
 */
export function statementsKnownBy<T extends { fiscalYear: number; publishedAt?: string | null }>(ys: T[], cutoff: string, mode: PitMode): T[] {
  const year = Number(cutoff.slice(0, 4));
  return ys.filter((y) => (y.publishedAt != null ? y.publishedAt <= cutoff : mode === "illustrative_lookahead" && y.fiscalYear < year));
}

export interface BacktestReadiness {
  ok: boolean;
  code?: "NOT_BACKTESTABLE_NO_ASOF_DATA";
  detail?: string;
  warnings: string[];
}

/** Refuse a fundamentals backtest when statements have no known-at dates (unless illustrative mode). */
export function backtestReadiness(x: { settings: StrategySettings; statementsBySymbol: Record<string, { fiscalYear: number; publishedAt?: string | null }[]>; mode: PitMode }): BacktestReadiness {
  const needs = usesStatements(x.settings);
  const warnings: string[] = [];
  if (!needs.length) return { ok: true, warnings };
  const syms = Object.keys(x.statementsBySymbol);
  const withPit = syms.filter((s) => x.statementsBySymbol[s].some((y) => y.publishedAt != null));
  const without = syms.filter((s) => x.statementsBySymbol[s].length && !x.statementsBySymbol[s].some((y) => y.publishedAt != null));
  if (x.mode === "illustrative_lookahead") {
    warnings.push(`โหมดภาพประกอบ (look-ahead bias): ใช้งบที่ไม่มีวันเผยแพร่ โดยถือว่างบปีบัญชีก่อนหน้ารู้แล้ว — ผลอาจดีเกินจริง ไม่ใช่ backtest แบบ point-in-time`);
    return { ok: true, warnings };
  }
  if (!withPit.length && !without.length) {
    warnings.push(`ไม่มีงบการเงินในชุดนี้ — ปัจจัย/ตัวกรองที่ใช้งบ (${needs.join(", ")}) จะทำให้หุ้นถูกตัดออกเพราะข้อมูลไม่พอ`);
    return { ok: true, warnings };
  }
  if (!withPit.length) {
    return {
      ok: false,
      code: "NOT_BACKTESTABLE_NO_ASOF_DATA",
      detail: `กลยุทธ์นี้ใช้ข้อมูลงบการเงิน (${needs.join(", ")}) แต่งบ${syms.length ? `ของ ${without.join(", ") || syms.join(", ")}` : ""} ไม่มีวันเผยแพร่ (published_at) — ทดสอบย้อนหลังแบบไม่ใช้ข้อมูลอนาคตไม่ได้ ใช้ได้แค่คัดกรองปัจจุบัน หรือปิดปัจจัย/ตัวกรองที่ใช้งบ หรือเลือกโหมดภาพประกอบที่ระบุว่ามี look-ahead bias`,
      warnings,
    };
  }
  if (without.length) warnings.push(`งบของ ${without.join(", ")} ไม่มีวันเผยแพร่ — ไม่ถูกใช้ในการตัดสินใจย้อนหลัง (ตัวนั้นจะขาดปัจจัยจากงบ)`);
  return { ok: true, warnings };
}
