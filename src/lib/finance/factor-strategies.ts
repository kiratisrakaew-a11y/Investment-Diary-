/**
 * Fundamental factor strategies (Strategies Phase 3): value, quality, momentum and a transparent
 * multi-factor composite. Pure; signals only — no new pricing or valuation engine:
 *  - value: earnings yield and book-to-price from statements known at the cutoff, and the margin of
 *    safety of valuations saved by then (median of the latest per method; never today's DCF in the past)
 *  - quality: ROE, CFO / net income, net debt / EBITDA, FCF stability (dividend-metrics.qualityMetrics,
 *    with its sector rules)
 *  - momentum: 12–1 month price return (skips the latest month), optionally ÷ 12-month volatility
 *  - dividend: regular TTM yield and consecutive paying years (dividend-metrics)
 * Ranks are cross-sectional percentiles (absolute or within sector); a family score averages the
 * sub-metric ranks that exist and reports coverage. Missing data are never scored as zero.
 */
import { z } from "zod";
import { dividendProfile, minusMonths, splitFactorAfter, type DividendEventInput, type FundamentalsYear, type MetricResult, type MetricStatus, type SplitInput } from "./dividend-metrics";
import { capWeights, percentileRanks, type Exclusion } from "./dividend-strategies";

export const FACTOR_STRATEGY_IDS = ["value", "quality", "momentum", "multi_factor"] as const;
export type FactorStrategyId = (typeof FACTOR_STRATEGY_IDS)[number];
export const FACTOR_FAMILIES = ["value", "quality", "momentum", "dividend"] as const;
export type FactorFamily = (typeof FACTOR_FAMILIES)[number];
export const FACTOR_MODEL_VERSION = "1.0.0";

export const FAMILY_LABEL: Record<FactorFamily, string> = { value: "มูลค่า (Value)", quality: "คุณภาพ (Quality)", momentum: "โมเมนตัม 12–1", dividend: "ปันผล" };

export const factorSettingsSchema = z.object({
  familyWeights: z
    .object({ value: z.number().min(0).max(1), quality: z.number().min(0).max(1), momentum: z.number().min(0).max(1), dividend: z.number().min(0).max(1) })
    .default({ value: 0.3, quality: 0.3, momentum: 0.3, dividend: 0.1 })
    .describe("multi_factor weights (renormalized over families with data)"),
  sectorNeutral: z.boolean().default(false).describe("Rank within each user-classified sector instead of across the universe"),
  volScaledMomentum: z.boolean().default(false).describe("Momentum ÷ 12-month volatility"),
  minCoverage: z.number().min(0).max(1).default(0.5).describe("multi_factor: minimum share of family weight with data"),
  topN: z.number().int().min(1).max(50).default(10),
  holdBuffer: z.number().int().min(0).max(20).default(0).describe("Keep a previous pick while its rank ≤ topN + buffer (turnover control)"),
  weighting: z.enum(["equal", "score"]).default("equal"),
  maxWeight: z.number().gt(0).max(1).default(0.25),
  maxPerIssuer: z.number().gt(0).max(1).nullable().default(null),
  maxPerSector: z.number().gt(0).max(1).nullable().default(null),
  cashReserve: z.number().min(0).max(0.9).default(0),
});
export type FactorSettings = z.infer<typeof factorSettingsSchema>;
export type FactorSettingsInput = z.input<typeof factorSettingsSchema>;

export interface FactorInput {
  symbol: string;
  issuer: string | null;
  sector: string | null;
  currency: string;
  /** Prices on/before the cutoff (latest share basis, asset currency). */
  prices: [string, number][];
  statements: FundamentalsYear[];
  events: DividendEventInput[];
  splits: SplitInput[];
  /** Median intrinsic value per share of valuations saved by the cutoff (latest per method). */
  valuationMedian: number | null;
}

type Sub = { key: string; label: string; lowerIsBetter?: boolean; metric: MetricResult };

const mr = (asOf: string, status: MetricStatus, value: number | null, methodology: string, warnings: string[] = [], provenance: string[] = []): MetricResult => ({
  value: status === "available" || status === "partial" ? value : null,
  status,
  methodology,
  asOf,
  provenance,
  observations: value == null ? 0 : 1,
  warnings,
});

const priceNear = (prices: [string, number][], date: string, maxGapDays = 10): number | null => {
  let best: [string, number] | null = null;
  for (const p of prices) {
    if (p[0] > date) break;
    best = p;
  }
  if (!best) return null;
  return (Date.parse(date) - Date.parse(best[0])) / 86_400_000 <= maxGapDays ? best[1] : null;
};

/** 12–1 momentum: P(t − 1m) / P(t − 12m) − 1, both prints within 10 days of the target dates. */
export function momentum(prices: [string, number][], asOf: string): { mom: MetricResult; vol: MetricResult } {
  const d1 = minusMonths(asOf, 1);
  const d12 = minusMonths(asOf, 12);
  const p1 = priceNear(prices, d1);
  const p12 = priceNear(prices, d12);
  const meth = "ราคา 1 เดือนก่อน ÷ ราคา 12 เดือนก่อน − 1 (ข้ามเดือนล่าสุด)";
  const mom = p1 && p12 ? mr(asOf, "available", p1 / p12 - 1, meth, [], [`${d12} → ${d1}`]) : mr(asOf, "insufficient", null, meth, ["ต้องมีราคาครอบคลุม 12 เดือน (ไม่เกิน 10 วันจากวันอ้างอิง)"]);
  const window = prices.filter(([d]) => d > d12 && d <= d1);
  const rets = window.slice(1).map(([, p], i) => Math.log(p / window[i][1]));
  let vol: MetricResult;
  if (rets.length < 120) vol = mr(asOf, "insufficient", null, "σ ผลตอบแทนรายวัน × √252 (12–1 เดือน)", [`ต้องมี ≥ 120 วัน (มี ${rets.length})`]);
  else {
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252);
    vol = mr(asOf, "available", sd, "σ ผลตอบแทนรายวัน × √252 (12–1 เดือน)");
  }
  return { mom, vol };
}

/** Value metrics from statements known at the cutoff; per-share figures moved to the latest share basis. */
export function valueMetrics(x: FactorInput, asOf: string, price: number | null): { earningsYield: MetricResult; bookToPrice: MetricResult; marginOfSafety: MetricResult } {
  const y = [...x.statements].sort((a, b) => b.fiscalYear - a.fiscalYear)[0];
  const none = (m: string, w: string) => mr(asOf, "unavailable", null, m, [w]);
  const mos = x.valuationMedian != null && price ? mr(asOf, "available", x.valuationMedian / price - 1, "มูลค่าที่เหมาะสม (มัธยฐาน valuation ที่บันทึกก่อนวันอ้างอิง) ÷ ราคา − 1") : none("margin of safety", "ไม่มี valuation ที่บันทึกไว้ก่อนวันนั้น");
  if (!price) return { earningsYield: none("EPS ÷ ราคา", "ไม่มีราคา"), bookToPrice: none("BVPS ÷ ราคา", "ไม่มีราคา"), marginOfSafety: mos };
  if (!y) return { earningsYield: none("EPS ÷ ราคา", "ไม่มีงบที่เผยแพร่แล้ว"), bookToPrice: none("BVPS ÷ ราคา", "ไม่มีงบที่เผยแพร่แล้ว"), marginOfSafety: mos };
  if (y.currency && y.currency !== x.currency) {
    const w = `สกุลเงินงบ (${y.currency}) ≠ ราคา (${x.currency})`;
    return { earningsYield: none("EPS ÷ ราคา", w), bookToPrice: none("BVPS ÷ ราคา", w), marginOfSafety: mos };
  }
  const f = splitFactorAfter(`${y.fiscalYear}-12-31`, x.splits);
  const prov = [`งบปี ${y.fiscalYear}`];
  const ey = y.eps != null ? mr(asOf, "available", y.eps / f / price, "EPS (ฐานหุ้นล่าสุด) ÷ ราคา", y.eps <= 0 ? ["กำไรติดลบ"] : [], prov) : none("EPS ÷ ราคา", `FY${y.fiscalYear}: ไม่มี EPS`);
  const bp =
    y.totalEquity != null && y.sharesOutstanding != null && y.sharesOutstanding > 0
      ? mr(asOf, "available", y.totalEquity / (y.sharesOutstanding * f) / price, "ส่วนผู้ถือหุ้น ÷ จำนวนหุ้น (ฐานล่าสุด) ÷ ราคา", y.totalEquity <= 0 ? ["ส่วนผู้ถือหุ้นติดลบ"] : [], prov)
      : none("BVPS ÷ ราคา", `FY${y.fiscalYear}: ไม่มีส่วนผู้ถือหุ้นหรือจำนวนหุ้น`);
  return { earningsYield: ey, bookToPrice: bp, marginOfSafety: mos };
}

export interface FactorSignals {
  symbol: string;
  price: number | null;
  families: Record<FactorFamily, Sub[]>;
}

export function factorSignals(x: FactorInput, asOf: string, s: Pick<FactorSettings, "volScaledMomentum">): FactorSignals {
  const price = x.prices.length ? x.prices[x.prices.length - 1][1] : null;
  const prof = dividendProfile({ symbol: x.symbol, asOf, price, priceCurrency: x.currency, events: x.events, splits: x.splits, statements: x.statements, sector: x.sector });
  const v = valueMetrics(x, asOf, price);
  const m = momentum(x.prices, asOf);
  const momMetric: MetricResult =
    s.volScaledMomentum && m.mom.value != null && m.vol.value != null && m.vol.value > 0
      ? { ...m.mom, value: m.mom.value / m.vol.value, methodology: `${m.mom.methodology} ÷ σ 12 เดือน` }
      : s.volScaledMomentum
        ? { ...m.mom, value: null, status: "insufficient", warnings: [...m.mom.warnings, ...m.vol.warnings] }
        : m.mom;
  return {
    symbol: x.symbol,
    price,
    families: {
      value: [
        { key: "earningsYield", label: "Earnings yield", metric: v.earningsYield },
        { key: "bookToPrice", label: "Book / price", metric: v.bookToPrice },
        { key: "marginOfSafety", label: "Margin of safety", metric: v.marginOfSafety },
      ],
      quality: [
        { key: "roe", label: "ROE", metric: prof.quality.roe },
        { key: "cfoToNetIncome", label: "CFO / กำไรสุทธิ", metric: prof.quality.cfoToNetIncome },
        { key: "netDebtToEbitda", label: "Net debt / EBITDA", lowerIsBetter: true, metric: prof.quality.netDebtToEbitda },
        { key: "fcfStability", label: "ความสม่ำเสมอ FCF", metric: prof.quality.fcfStability },
      ],
      momentum: [{ key: "momentum", label: s.volScaledMomentum ? "Momentum ÷ σ" : "Momentum 12–1", metric: momMetric }],
      dividend: [
        { key: "ttmYieldRegular", label: "Dividend yield ปกติ", metric: prof.ttm.regular },
        { key: "consecutiveYears", label: "ปีที่จ่ายต่อเนื่อง", metric: prof.consistency.consecutiveYears },
      ],
    },
  };
}

export interface FactorScored {
  symbol: string;
  issuer: string | null;
  sector: string | null;
  score: number;
  coverage: number;
  families: Record<FactorFamily, { score: number | null; coverage: number; subs: { key: string; label: string; value: number | null; status: string; rank: number | null; note?: string }[] }>;
}

export interface FactorDecision {
  strategyId: FactorStrategyId;
  modelVersion: string;
  asOf: string;
  ranked: FactorScored[];
  excluded: Exclusion[];
  selected: string[];
  targetWeights: Record<string, number>;
  scores: Record<string, number>;
  factorDataCoverage: Record<FactorFamily, { available: number; total: number }>;
  sourceStatus: "verified" | "partial" | "insufficient";
  diagnostics: string[];
  settings: FactorSettings;
}

/** Rank one sub-metric across the universe, or within each sector (singleton sectors → 0.5, noted). */
function rankSub(items: { symbol: string; sector: string | null; v: number | null }[], sectorNeutral: boolean, lower: boolean) {
  const out = new Map<string, number>();
  const groups = new Map<string, typeof items>();
  for (const it of items.filter((i) => i.v != null)) {
    const g = sectorNeutral ? (it.sector ?? "ไม่ระบุหมวด") : "*";
    groups.set(g, [...(groups.get(g) ?? []), it]);
  }
  for (const g of groups.values()) {
    const r = percentileRanks(g.map((i) => (lower ? -i.v! : i.v!)));
    g.forEach((i, k) => out.set(i.symbol, r[k]));
  }
  return out;
}

export function screenFactorStrategy(x: {
  strategyId: FactorStrategyId;
  asOf: string;
  inputs: FactorInput[];
  settings?: Partial<FactorSettingsInput>;
  /** Previous selection (backtests), for the hold buffer. */
  previous?: string[];
}): FactorDecision {
  const s = factorSettingsSchema.parse(x.settings ?? {});
  const diagnostics: string[] = [];
  const excluded: Exclusion[] = [];
  const signals = x.inputs.map((i) => factorSignals(i, x.asOf, s));
  const meta = new Map(x.inputs.map((i) => [i.symbol, i]));
  const withPrice = signals.filter((g) => {
    if (g.price == null) excluded.push({ symbol: g.symbol, code: "no_price", detail: "ไม่มีราคา ณ วันอ้างอิง" });
    return g.price != null;
  });
  // Ranks per sub-metric.
  const subRanks = new Map<string, Map<string, number>>();
  for (const fam of FACTOR_FAMILIES) {
    const subs = withPrice[0]?.families[fam] ?? [];
    subs.forEach((sub, k) => {
      const items = withPrice.map((g) => ({ symbol: g.symbol, sector: meta.get(g.symbol)!.sector, v: g.families[fam][k].metric.value }));
      subRanks.set(`${fam}.${sub.key}`, rankSub(items, s.sectorNeutral, !!sub.lowerIsBetter));
    });
  }
  if (s.sectorNeutral) diagnostics.push("จัดอันดับภายในหมวดที่ผู้ใช้ระบุ (ไม่ระบุ = กลุ่มเดียวกัน) · หมวดที่มีตัวเดียวได้คะแนนกลาง 0.5");
  const familyWeights: Record<FactorFamily, number> =
    x.strategyId === "multi_factor" ? s.familyWeights : { value: 0, quality: 0, momentum: 0, dividend: 0, [x.strategyId]: 1 } as Record<FactorFamily, number>;
  const totalW = FACTOR_FAMILIES.reduce((a, f) => a + familyWeights[f], 0);
  const coverageCount = Object.fromEntries(FACTOR_FAMILIES.map((f) => [f, { available: 0, total: withPrice.length }])) as FactorDecision["factorDataCoverage"];
  const ranked: FactorScored[] = [];
  for (const g of withPrice) {
    const families = {} as FactorScored["families"];
    for (const fam of FACTOR_FAMILIES) {
      const subs = g.families[fam].map((sub) => ({ key: sub.key, label: sub.label, value: sub.metric.value, status: sub.metric.status, rank: subRanks.get(`${fam}.${sub.key}`)!.get(g.symbol) ?? null, note: sub.metric.warnings[0] }));
      const have = subs.filter((v) => v.rank != null);
      const score = have.length ? have.reduce((a, v) => a + v.rank!, 0) / have.length : null;
      if (score != null) coverageCount[fam].available++;
      families[fam] = { score, coverage: subs.length ? have.length / subs.length : 0, subs };
    }
    const avail = FACTOR_FAMILIES.filter((f) => familyWeights[f] > 0 && families[f].score != null);
    const wAvail = avail.reduce((a, f) => a + familyWeights[f], 0);
    const coverage = totalW > 0 ? wAvail / totalW : 0;
    if (!avail.length || (x.strategyId === "multi_factor" && coverage < s.minCoverage)) {
      const need = FACTOR_FAMILIES.filter((f) => familyWeights[f] > 0 && families[f].score == null).map((f) => FAMILY_LABEL[f]);
      excluded.push({ symbol: g.symbol, code: "insufficient_data", detail: `ไม่มีข้อมูล: ${need.join(", ")}` });
      continue;
    }
    const score = avail.reduce((a, f) => a + familyWeights[f] * families[f].score!, 0) / wAvail;
    const m = meta.get(g.symbol)!;
    ranked.push({ symbol: g.symbol, issuer: m.issuer, sector: m.sector, score, coverage, families });
  }
  ranked.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  // Hold buffer: previous picks stay while ranked within topN + buffer.
  let selected = ranked.slice(0, s.topN).map((r) => r.symbol);
  if (x.previous?.length && s.holdBuffer > 0) {
    const keep = ranked.slice(0, s.topN + s.holdBuffer).map((r) => r.symbol).filter((sym) => x.previous!.includes(sym));
    const fill = ranked.map((r) => r.symbol).filter((sym) => !keep.includes(sym));
    selected = [...keep, ...fill].slice(0, Math.max(s.topN, keep.length));
    if (keep.some((k) => !ranked.slice(0, s.topN).some((r) => r.symbol === k))) diagnostics.push(`hold buffer ${s.holdBuffer}: คงตัวเดิมที่ยังอยู่ในอันดับ ≤ ${s.topN + s.holdBuffer}`);
  }
  let targetWeights: Record<string, number> = {};
  if (selected.length) {
    const sel = ranked.filter((r) => selected.includes(r.symbol));
    const raw =
      s.weighting === "score" && sel.some((r) => r.score > 0)
        ? Object.fromEntries(sel.map((r) => [r.symbol, r.score / sel.reduce((a, q) => a + q.score, 0)]))
        : Object.fromEntries(sel.map((r) => [r.symbol, 1 / sel.length]));
    const groups: { name: string; members: string[]; cap: number }[] = [];
    const byKey = (key: (r: FactorScored) => string | null, cap: number | null, label: string) => {
      if (cap == null) return;
      const m = new Map<string, string[]>();
      for (const r of sel) {
        const k = key(r);
        if (k) m.set(k, [...(m.get(k) ?? []), r.symbol]);
      }
      for (const [k, members] of m) groups.push({ name: `${label} ${k}`, members, cap });
    };
    byKey((r) => r.issuer, s.maxPerIssuer, "ผู้ออก");
    byKey((r) => r.sector, s.maxPerSector, "หมวด");
    const capped = capWeights(raw, { maxWeight: s.maxWeight, groups });
    diagnostics.push(...capped.notes);
    targetWeights = Object.fromEntries(Object.entries(capped.weights).map(([k, v]) => [k, v * (1 - s.cashReserve)]));
  }
  for (const f of FACTOR_FAMILIES) if (familyWeights[f] > 0 && coverageCount[f].available < coverageCount[f].total) diagnostics.push(`${FAMILY_LABEL[f]}: มีข้อมูล ${coverageCount[f].available}/${coverageCount[f].total} ตัว`);
  const sel = ranked.filter((r) => selected.includes(r.symbol));
  return {
    strategyId: x.strategyId,
    modelVersion: FACTOR_MODEL_VERSION,
    asOf: x.asOf,
    ranked,
    excluded,
    selected,
    targetWeights,
    scores: Object.fromEntries(ranked.map((r) => [r.symbol, r.score])),
    factorDataCoverage: coverageCount,
    sourceStatus: !sel.length ? "insufficient" : sel.every((r) => r.coverage >= 1 && FACTOR_FAMILIES.every((f) => familyWeights[f] === 0 || r.families[f].coverage >= 1)) ? "verified" : "partial",
    diagnostics,
    settings: s,
  };
}

/** Which families need financial statements (for the point-in-time readiness check). */
export function factorNeedsStatements(id: FactorStrategyId, s: FactorSettings): boolean {
  if (id === "value" || id === "quality") return true;
  if (id === "multi_factor") return s.familyWeights.value > 0 || s.familyWeights.quality > 0;
  return false;
}
