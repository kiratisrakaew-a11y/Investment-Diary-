/**
 * Strategy orchestration (Strategies Phase 1 — dividend investing). One service behind the web page,
 * REST, MCP and the advisor. Data access only; the math lives in lib/finance (dividend-metrics,
 * dividend-strategies, dividend-income) and the existing optimizer / rebalance / backtest.
 */
import { asc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { asOfEntry } from "@/lib/finance/portfolio";
import { isoDate, today } from "@/lib/validation";
import { dividendProfile, eventsKnownBy, type DividendEventInput, type FundamentalsYear, type SplitInput } from "@/lib/finance/dividend-metrics";
import {
  DIVIDEND_PRESETS,
  DIVIDEND_STRATEGY_IDS,
  FACTOR_KEYS,
  screenDividendStrategy,
  statementsKnownBy,
  type Candidate,
  type PitMode,
  type StrategySettingsInput,
} from "@/lib/finance/dividend-strategies";
import { dividendIncomePlan } from "@/lib/finance/dividend-income";
import { FACTOR_STRATEGY_IDS, screenFactorStrategy, type FactorInput, type FactorSettingsInput } from "@/lib/finance/factor-strategies";
import { listAssets } from "./assets";
import { loadFxHistory, loadPriceHistory } from "./prices";
import { getPortfolioSummary, holdingsAt } from "./portfolio";
import { allTransactions } from "./transactions";
import { listDividendEvents, splitsBySymbol, toEventInput } from "./dividends";
import { optimizePortfolio } from "./optimizer";
import { rebalancePortfolio } from "./rebalance";

const factorOverride = z.object({ weight: z.number().min(0).max(1), required: z.boolean().optional() });
export const strategySettingsOverride = z
  .object({
    factors: z.partialRecord(z.enum(FACTOR_KEYS), factorOverride).optional().describe("Replace the preset's factor weights"),
    filters: z
      .object({
        minYield: z.number().min(0).max(1).nullable(),
        minConsecutiveYears: z.number().int().min(0).max(50).nullable(),
        minHistoryYears: z.number().int().min(0).max(50).nullable(),
        maxEarningsPayout: z.number().min(0).max(5).nullable(),
        maxFcfPayout: z.number().min(0).max(5).nullable(),
        excludeNegativeFcf: z.boolean(),
        minDpsCagr5: z.number().min(-1).max(1).nullable(),
        maxNetDebtToEbitda: z.number().min(0).max(50).nullable(),
        excludeYieldFromPriceDrop: z.boolean(),
        minLiquidityThb: z.number().positive().nullable(),
      })
      .partial()
      .optional()
      .describe("Thresholds (decimal rates); null disables a filter"),
    minCoverage: z.number().min(0).max(1).optional(),
    includeSpecial: z.boolean().optional(),
    topN: z.number().int().min(1).max(50).optional(),
    weighting: z.enum(["equal", "score", "optimizer"]).optional().describe("optimizer = existing min-variance optimizer with the same caps"),
    maxWeight: z.number().gt(0).max(1).optional(),
    maxPerIssuer: z.number().gt(0).max(1).nullable().optional(),
    maxPerSector: z.number().gt(0).max(1).nullable().optional(),
    cashReserve: z.number().min(0).max(0.9).optional(),
  })
  .describe("Overrides on top of the preset (all optional)");

export const screenDividendInput = z.object({
  strategy: z.enum(DIVIDEND_STRATEGY_IDS).default("dividend_sustainable_income"),
  asOf: isoDate.optional().describe("Decision date (default today); only data known by then is used"),
  symbols: z.array(z.string()).max(60).optional().describe("Universe (default: every stock / fund in the app)"),
  settings: strategySettingsOverride.optional(),
  pointInTime: z.enum(["strict", "illustrative_lookahead"]).default("strict").describe("strict: statements only if published by asOf"),
  includeProposal: z.boolean().default(false).describe("Also turn target weights into a trade proposal with rebalance_portfolio (never recorded)"),
});
export type ScreenDividendParams = z.input<typeof screenDividendInput>;

export interface DividendData {
  assets: Awaited<ReturnType<typeof listAssets>>;
  prices: Map<number, [string, number][]>;
  events: Map<string, DividendEventInput[]>;
  splits: Record<string, SplitInput[]>;
  statements: Map<string, FundamentalsYear[]>;
  valuations: { symbol: string; method: string; createdAt: string; createdTs: number; intrinsicValue: number }[];
}

/** Everything a dividend decision may need, loaded once. */
export async function loadDividendData(): Promise<DividendData> {
  const db = getDb();
  const [assets, prices, rows, splits, st, vals] = await Promise.all([
    listAssets(),
    loadPriceHistory(),
    listDividendEvents(),
    splitsBySymbol(),
    db.select().from(schema.financialStatements).orderBy(asc(schema.financialStatements.fiscalYear)),
    db.select({ symbol: schema.valuations.symbol, method: schema.valuations.method, createdAt: schema.valuations.createdAt, intrinsicValue: schema.valuations.intrinsicValue }).from(schema.valuations),
  ]);
  const events = new Map<string, DividendEventInput[]>();
  for (const r of rows) {
    const list = events.get(r.symbol) ?? [];
    list.push(toEventInput(r));
    events.set(r.symbol, list);
  }
  const statements = new Map<string, FundamentalsYear[]>();
  for (const r of st) {
    const list = statements.get(r.symbol) ?? [];
    list.push({ ...(r.data as Record<string, number | null>), fiscalYear: r.fiscalYear, publishedAt: r.publishedAt, currency: r.currency });
    statements.set(r.symbol, list);
  }
  return {
    assets,
    prices,
    events,
    splits,
    statements,
    valuations: vals
      .filter((v) => v.intrinsicValue != null && v.intrinsicValue > 0)
      .map((v) => ({ symbol: v.symbol, method: v.method, createdAt: v.createdAt.toISOString().slice(0, 10), createdTs: v.createdAt.getTime(), intrinsicValue: v.intrinsicValue! })),
  };
}

const priceOn = (series: [string, number][] | undefined, d: string) => {
  if (!series?.length) return null;
  let v: number | null = null;
  for (const [pd, p] of series) {
    if (pd > d) break;
    v = p;
  }
  return v;
};

/**
 * Valuations usable only if saved (created) by the cutoff: latest per method, median across methods
 * (same convention as the stock valuation page; robust to one outlier method).
 */
export function valuationMedianAsOf(data: DividendData, sym: string, cutoff: string): number | null {
  const latest = new Map<string, { createdTs: number; intrinsicValue: number }>();
  for (const v of data.valuations) {
    if (v.symbol !== sym || v.createdAt > cutoff) continue;
    const cur = latest.get(v.method);
    if (!cur || v.createdTs > cur.createdTs) latest.set(v.method, v);
  }
  const iv = [...latest.values()].map((v) => v.intrinsicValue).sort((p, q) => p - q);
  return iv.length ? (iv.length % 2 ? iv[(iv.length - 1) / 2] : (iv[iv.length / 2 - 1] + iv[iv.length / 2]) / 2) : null;
}

/** Candidates as of a cutoff using only data known then (events by ex/announcement date, statements by publication). */
export function candidatesAsOf(data: DividendData, symbols: string[], cutoff: string, mode: PitMode, includeSpecial: boolean): Candidate[] {
  return symbols.map((sym) => {
    const a = data.assets.find((x) => x.symbol === sym)!;
    const series = data.prices.get(a.id)?.filter(([d]) => d <= cutoff);
    const price = priceOn(series, cutoff);
    const statements = statementsKnownBy(data.statements.get(sym) ?? [], cutoff, mode);
    const events = eventsKnownBy(data.events.get(sym) ?? [], cutoff);
    const median = valuationMedianAsOf(data, sym, cutoff);
    return {
      symbol: sym,
      issuer: a.issuer,
      sector: a.sector,
      marginOfSafety: median != null && price ? median / price - 1 : null,
      profile: dividendProfile({ symbol: sym, asOf: cutoff, price, priceCurrency: a.currency, prices: series, events, splits: data.splits[sym] ?? [], statements, sector: a.sector, includeSpecial }),
    };
  });
}

export function dividendUniverse(data: DividendData, symbols?: string[]) {
  const want = symbols?.map((s) => s.toUpperCase());
  const pool = data.assets.filter((a) => ["thai_stock", "us_stock", "fund"].includes(a.assetClass) && (!want || want.includes(a.symbol.toUpperCase())));
  if (want) {
    const missing = want.filter((s) => !data.assets.some((a) => a.symbol.toUpperCase() === s));
    if (missing.length) throw new Error(`ไม่พบ ${missing.join(", ")} ในรายการสินทรัพย์`);
  }
  return pool.map((a) => a.symbol);
}

/** Screen the universe with a dividend preset. Read-only; proposals are never recorded. */
export async function screenDividendStocks(input: ScreenDividendParams = {}) {
  const x = screenDividendInput.parse(input);
  const asOf = x.asOf ?? today();
  const data = await loadDividendData();
  const symbols = dividendUniverse(data, x.symbols);
  const settings = (x.settings ?? {}) as Partial<StrategySettingsInput>;
  const candidates = candidatesAsOf(data, symbols, asOf, x.pointInTime, settings.includeSpecial ?? false);
  const decision = screenDividendStrategy({ strategyId: x.strategy, asOf, candidates, settings });
  const diagnostics = [...decision.diagnostics];
  let targetWeights = decision.targetWeights;
  if (decision.settings.weighting === "optimizer" && decision.selected.length) {
    if (decision.selected.length < 2) {
      targetWeights = { [decision.selected[0]]: Math.min(1, decision.settings.maxWeight) * (1 - decision.settings.cashReserve) };
      diagnostics.push("optimizer ต้องมีอย่างน้อย 2 ตัว — ใช้น้ำหนักเดียวตามเพดาน");
    } else {
      const o = await optimizePortfolio({
        symbols: decision.selected,
        objective: "min_variance",
        maxWeight: decision.settings.maxWeight,
        constraints: { maxPerIssuer: decision.settings.maxPerIssuer ?? undefined, maxPerSector: decision.settings.maxPerSector ?? undefined },
      });
      if (o.ok) {
        targetWeights = Object.fromEntries(o.allocations.map((a) => [a.symbol, a.weight * (1 - decision.settings.cashReserve)]));
        diagnostics.push("น้ำหนักจาก optimizer เดิม (minimum variance) ภายใต้เพดานเดียวกัน");
      } else diagnostics.push(`optimizer ใช้ไม่ได้: ${o.reason ?? "ไม่มีผลลัพธ์"} — ไม่มีน้ำหนักเป้าหมาย`);
    }
  }
  const proposal = x.includeProposal && Object.keys(targetWeights).length ? await rebalancePortfolio({ targets: targetWeights }) : null;
  const preset = DIVIDEND_PRESETS[x.strategy];
  return {
    strategy: { id: x.strategy, version: preset.version, label: preset.label, description: preset.description },
    pointInTime: x.pointInTime,
    ...decision,
    targetWeights,
    diagnostics,
    profiles: Object.fromEntries(
      candidates.map((c) => [
        c.symbol,
        {
          price: c.profile.price,
          ttmYieldTotal: c.profile.ttm.total,
          ttmYieldRegular: c.profile.ttm.regular,
          forwardYield: c.profile.forward,
          earningsPayout: c.profile.earningsPayout,
          fcfPayout: c.profile.fcfPayout,
          coverage: c.profile.coverage,
          dpsCagr3: c.profile.cagr3,
          dpsCagr5: c.profile.cagr5,
          dpsCagr10: c.profile.cagr10,
          consistency: { ...c.profile.consistency },
          annualDps: c.profile.annual,
          yieldVsHistory: c.profile.yieldHistory,
          quality: c.profile.quality,
          totalShareholderYield: c.profile.totalShareholderYield,
          marginOfSafety: c.marginOfSafety ?? null,
          eventCount: c.profile.eventCount,
          financialSector: c.profile.financialSector,
        },
      ]),
    ),
    proposal,
    disclaimer: "คะแนนและเกณฑ์เป็นตัวอย่างที่แก้ได้ ไม่ใช่คำแนะนำการลงทุน · ข้อเสนอซื้อขายไม่ถูกบันทึกจนกว่าผู้ใช้จะบันทึกเอง",
    limitations: [
      "จักรวาลหุ้นคือสินทรัพย์ที่เพิ่มไว้ในแอปเท่านั้น (survivorship bias)",
      "ไม่มีข้อมูลปริมาณการซื้อขาย จึงกรองสภาพคล่องไม่ได้",
      "ข้อมูล Yahoo ไม่แยกปันผลปกติ/พิเศษ และไม่มีวันจ่าย",
    ],
  };
}

export const dividendIncomeInput = z.object({
  horizonMonths: z.number().int().min(1).max(36).default(12),
  lookbackMonths: z.number().int().min(0).max(36).default(12),
  withholding: z.record(z.string(), z.number().min(0).max(1)).default({ thai_stock: 0.1, fund: 0.1, us_stock: 0.15 }).describe("Default withholding by asset class when an event has none (assumption, decimal)"),
});

/** Known vs estimated dividend income for current holdings; ledger receipts are the money actually received. Read-only. */
export async function getDividendIncome(input: z.input<typeof dividendIncomeInput> = {}) {
  const x = dividendIncomeInput.parse(input);
  const now = today();
  const [snap, data, txs, fx] = await Promise.all([getPortfolioSummary(), loadDividendData(), allTransactions(), loadFxHistory()]);
  const bySymbol = new Map(data.assets.map((a) => [a.id, a]));
  const relevant = new Set(data.assets.filter((a) => ["thai_stock", "us_stock", "fund"].includes(a.assetClass)).map((a) => a.symbol));
  // Every symbol held at some point in the window (so past events are matched too).
  const exDates = [...data.events.values()].flat().filter((e) => e.exDate && relevant.has(e.symbol)).map((e) => new Date(Date.parse(e.exDate!) - 86_400_000).toISOString().slice(0, 10));
  const held = await holdingsAt([now, ...exDates]);
  const positionsSymbols = new Set([...snap.positions.filter((p) => p.quantity > 0).map((p) => p.symbol), ...[...held.values()].flatMap((m) => [...m.entries()].filter(([, q]) => q > 0).map(([s]) => s))]);
  const positions = data.assets
    .filter((a) => relevant.has(a.symbol) && positionsSymbols.has(a.symbol))
    .map((a) => ({
      symbol: a.symbol,
      assetClass: a.assetClass,
      currency: a.currency,
      quantityNow: held.get(now)?.get(a.symbol) ?? 0,
      quantityAt: (d: string) => held.get(d)?.get(a.symbol) ?? 0,
    }));
  const receipts = txs
    .filter((t) => t.type === "dividend" && t.assetId != null)
    .map((t) => ({ id: t.id, symbol: bySymbol.get(t.assetId!)?.symbol ?? "", date: t.date, amountThb: t.price * t.fxRate }));
  const plan = dividendIncomePlan({
    today: now,
    horizonMonths: x.horizonMonths,
    lookbackMonths: x.lookbackMonths,
    positions,
    events: [...data.events.values()].flat(),
    splits: data.splits,
    receipts,
    withholding: x.withholding,
    fxAt: (cur, d) => {
      if (cur !== "USD") return null;
      const e = asOfEntry(fx, d);
      return e ? { rate: e[1], date: e[0] } : null;
    },
  });
  return { ...plan, assumptions: { withholding: x.withholding }, note: "ระบบไม่สร้างรายการรับปันผลให้อัตโนมัติ — บันทึกเงินที่ได้รับจริงด้วย record_transaction (type dividend)" };
}

const brief = (m: { value: number | null; status: string; warnings: string[] } | undefined) => (m ? { value: m.value, status: m.status, ...(m.warnings[0] ? { note: m.warnings[0] } : {}) } : null);

/** Compact view for MCP / the advisor: identical scores, weights and exclusions; metric details trimmed. */
export function summarizeDividendScreen(r: Awaited<ReturnType<typeof screenDividendStocks>>) {
  return {
    strategy: r.strategy,
    asOf: r.asOf,
    pointInTime: r.pointInTime,
    sourceStatus: r.sourceStatus,
    selected: r.selected,
    targetWeights: r.targetWeights,
    ranked: r.ranked.map((c) => ({
      symbol: c.symbol,
      score: c.score,
      coverage: c.coverage,
      factors: c.factors.map((f) => ({ key: f.key, value: f.value, rank: f.rank, contribution: f.contribution, status: f.status })),
    })),
    excluded: r.excluded,
    metrics: Object.fromEntries(
      Object.entries(r.profiles).map(([s, p]) => [
        s,
        {
          price: p.price,
          ttmYieldRegular: brief(p.ttmYieldRegular),
          ttmYieldTotal: brief(p.ttmYieldTotal),
          forwardYield: brief(p.forwardYield),
          earningsPayout: brief(p.earningsPayout),
          fcfPayout: brief(p.fcfPayout),
          dpsCagr5: brief(p.dpsCagr5),
          consecutiveYears: brief(p.consistency.consecutiveYears),
          cuts: p.consistency.cuts,
          roe: brief(p.quality.roe),
          netDebtToEbitda: brief(p.quality.netDebtToEbitda),
          yieldVsHistory: brief(p.yieldVsHistory),
          annualDpsSource: p.annualDps.source,
          events: p.eventCount,
        },
      ]),
    ),
    settings: r.settings,
    diagnostics: r.diagnostics,
    proposal: r.proposal,
    limitations: r.limitations,
    disclaimer: r.disclaimer,
  };
}


// ------------------------------------------------------------------ factor strategies (Phase 3)

export function factorInputsAsOf(data: DividendData, symbols: string[], cutoff: string, mode: PitMode): FactorInput[] {
  return symbols.map((sym) => {
    const a = data.assets.find((x) => x.symbol === sym)!;
    return {
      symbol: sym,
      issuer: a.issuer,
      sector: a.sector,
      currency: a.currency,
      prices: data.prices.get(a.id)?.filter(([d]) => d <= cutoff) ?? [],
      statements: statementsKnownBy(data.statements.get(sym) ?? [], cutoff, mode),
      events: eventsKnownBy(data.events.get(sym) ?? [], cutoff),
      splits: data.splits[sym] ?? [],
      valuationMedian: valuationMedianAsOf(data, sym, cutoff),
    };
  });
}

const familyWeightsInput = z.object({ value: z.number().min(0).max(1), quality: z.number().min(0).max(1), momentum: z.number().min(0).max(1), dividend: z.number().min(0).max(1) });
export const factorSettingsOverride = z
  .object({
    familyWeights: familyWeightsInput.optional().describe("multi_factor weights (value / quality / momentum / dividend)"),
    sectorNeutral: z.boolean().optional(),
    volScaledMomentum: z.boolean().optional(),
    minCoverage: z.number().min(0).max(1).optional(),
    topN: z.number().int().min(1).max(50).optional(),
    holdBuffer: z.number().int().min(0).max(20).optional(),
    weighting: z.enum(["equal", "score"]).optional(),
    maxWeight: z.number().gt(0).max(1).optional(),
    maxPerIssuer: z.number().gt(0).max(1).nullable().optional(),
    maxPerSector: z.number().gt(0).max(1).nullable().optional(),
    cashReserve: z.number().min(0).max(0.9).optional(),
  })
  .describe("Factor strategy settings (all optional)");

export const screenFactorInput = z.object({
  strategy: z.enum(FACTOR_STRATEGY_IDS).default("multi_factor"),
  asOf: isoDate.optional().describe("Decision date (default today); only data known by then is used"),
  symbols: z.array(z.string()).max(60).optional().describe("Universe (default: every stock / fund in the app)"),
  settings: factorSettingsOverride.optional(),
  pointInTime: z.enum(["strict", "illustrative_lookahead"]).default("strict"),
  compareStandalone: z.boolean().default(true).describe("multi_factor: also return each standalone factor's top picks"),
});

/** Value / quality / momentum / multi-factor screen. Read-only. */
export async function screenFactorStocks(input: z.input<typeof screenFactorInput> = {}) {
  const x = screenFactorInput.parse(input);
  const asOf = x.asOf ?? today();
  const data = await loadDividendData();
  const symbols = dividendUniverse(data, x.symbols);
  const inputs = factorInputsAsOf(data, symbols, asOf, x.pointInTime);
  const settings = (x.settings ?? {}) as Partial<FactorSettingsInput>;
  const decision = screenFactorStrategy({ strategyId: x.strategy, asOf, inputs, settings });
  const standalone =
    x.strategy === "multi_factor" && x.compareStandalone
      ? Object.fromEntries((["value", "quality", "momentum"] as const).map((id) => {
          const d = screenFactorStrategy({ strategyId: id, asOf, inputs, settings });
          return [id, { selected: d.selected, scores: d.scores, excluded: d.excluded.length }];
        }))
      : null;
  return {
    ...decision,
    pointInTime: x.pointInTime,
    standalone,
    limitations: [
      "จักรวาลคือสินทรัพย์ในแอป (survivorship bias) · ไม่มีข้อมูลปริมาณการซื้อขาย",
      "Value ใช้ valuation ที่บันทึกไว้ก่อนวันอ้างอิงเท่านั้น — วันที่ในอดีตจึงมักไม่มี margin of safety",
      "งบที่ไม่มีวันเผยแพร่ใช้ไม่ได้ในโหมดเข้ม",
    ],
    disclaimer: "คะแนนเป็นสัญญาณเชิงปริมาณที่ปรับได้ ไม่ใช่คำแนะนำการลงทุน",
  };
}
