/**
 * Historical price synchronization shared by the daily updater, MCP, REST and the advisor.
 * Writes into the existing `prices`, `benchmark_prices` and `fx_rates` tables (no new price store).
 * Unknown symbols are reported, never created.
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { fetchDailyHistory, type DailyHistory } from "@/lib/prices/yahoo";
import { fetchFundNav } from "@/lib/prices/sec-th";
import { THAI_GOLD_SYMBOL, thaiGoldPrice } from "@/lib/prices/gold";
import { asOf } from "@/lib/finance/portfolio";
import {
  PriceSyncError,
  corporateActionWarnings,
  coverage,
  planWrites,
  resolveSyncRange,
  withRetry,
  type Coverage,
  type PricePoint,
  type PriceType,
  type SyncRange,
} from "@/lib/finance/price-coverage";
import { today as todayIso } from "@/lib/validation";
import { getAssetBySymbol } from "./assets";
import { loadFxHistory } from "./prices";
import { getSettings } from "./settings";

export const MAX_SYNC_SYMBOLS = 50;
/** SEC fund NAVs come one day per request; longer backfills are refused rather than half-done. */
export const MAX_FUND_NAV_DAYS = 400;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export const syncHistoricalPricesInput = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(MAX_SYNC_SYMBOLS).describe("Asset symbols as stored in the app (e.g. BBL, AP); add_asset first for new ones"),
  startDate: z.string().optional().describe("YYYY-MM-DD; default = endDate − lookbackDays"),
  endDate: z.string().optional().describe("YYYY-MM-DD; default today"),
  lookbackDays: z.number().int().min(1).max(3660).optional().describe("Default 365"),
  priceType: z.enum(["close", "adjusted_close"]).default("close").describe("close = provider close (split-adjusted). adjusted_close also stores the split+dividend-adjusted series"),
  overwriteExisting: z.boolean().default(false).describe("false = keep stored prices, only add missing dates"),
  dryRun: z.boolean().default(false).describe("true = fetch and report what would change, write nothing"),
  includeBenchmark: z.boolean().default(true).describe("Also sync the benchmark index over the same range"),
  includeFx: z.boolean().default(true).describe("Also sync USDTHB over the same range"),
});
export type SyncHistoricalPricesInput = z.input<typeof syncHistoricalPricesInput>;

export interface AssetLike {
  id: number;
  symbol: string;
  assetClass: string;
  currency: string;
  priceSource: string;
  providerSymbol: string | null;
}

type Existing = Map<string, { close: number; adjClose: number | null }>;

export interface SyncDeps {
  today(): string;
  findAsset(symbol: string): Promise<AssetLike | null>;
  fetchHistory(providerSymbol: string, range: SyncRange): Promise<DailyHistory>;
  fetchFundNav(projId: string, date: string): Promise<number | null>;
  /** Series key: `asset:<id>`, `fx:USDTHB` or `bench:<symbol>`. */
  loadExisting(key: string, range: SyncRange): Promise<Existing>;
  write(key: string, inserts: PricePoint[], updates: PricePoint[]): Promise<void>;
  loadFx(): Promise<[string, number][]>;
  sleep(ms: number): Promise<void>;
  eligibility(symbols: string[], lookbackDays: number): Promise<{ lookbackDays: number; ok: boolean; reason?: string; eligible: string[]; skipped: { symbol: string; reason: string }[] }>;
  benchmarkSymbol(): Promise<string>;
  heldAssetIds(): Promise<Set<number>>;
}

export type SyncStatus = "ok" | "no_data" | "unknown_asset" | "unsupported" | "error";

export interface SeriesResult {
  symbol: string;
  status: SyncStatus;
  source?: string;
  providerSymbol?: string;
  message?: string;
  fetched: number;
  inserted: number;
  updated: number;
  skippedExisting: number;
  unchanged: number;
  coverage?: Coverage;
  corporateActions?: { splits: DailyHistory["splits"]; dividends: DailyHistory["dividends"] };
  warnings: string[];
}

const empty = (symbol: string, status: SyncStatus, message?: string): SeriesResult => ({
  symbol,
  status,
  message,
  fetched: 0,
  inserted: 0,
  updated: 0,
  skippedExisting: 0,
  unchanged: 0,
  warnings: [],
});

interface Opts {
  range: SyncRange;
  priceType: PriceType;
  overwrite: boolean;
  dryRun: boolean;
}

/** Plan and (unless dry run) write one series; returns counts, coverage and warnings. */
async function applySeries(deps: SyncDeps, key: string, label: string, history: DailyHistory, o: Opts, held: boolean, base: Partial<SeriesResult>): Promise<SeriesResult> {
  const existing = await deps.loadExisting(key, o.range);
  const plan = planWrites(existing, history.rows, { overwrite: o.overwrite, priceType: o.priceType });
  if (!o.dryRun && (plan.inserts.length || plan.updates.length)) await deps.write(key, plan.inserts, plan.updates);
  const dates = new Set([...existing.keys(), ...plan.inserts.map((r) => r.date)]);
  const warnings = corporateActionWarnings(label, history.splits, history.dividends, held);
  if (plan.changedButKept) warnings.push(`${label}: ${plan.changedButKept} วันที่ราคาจากผู้ให้ข้อมูลต่างจากที่เก็บไว้ — เก็บของเดิมไว้ (ใช้ overwriteExisting เพื่ออัปเดต)`);
  if (plan.invalid) warnings.push(`${label}: ข้ามราคา ${plan.invalid} แถวที่ไม่ถูกต้อง (≤ 0 หรือไม่ใช่ตัวเลข)`);
  return {
    symbol: label,
    ...base,
    status: history.rows.length ? "ok" : "no_data",
    message: history.rows.length ? undefined : "ผู้ให้ข้อมูลไม่มีราคาในช่วงนี้",
    fetched: history.rows.length,
    inserted: plan.inserts.length,
    updated: plan.updates.length,
    skippedExisting: plan.skippedExisting,
    unchanged: plan.unchanged,
    coverage: coverage([...dates], o.range, deps.today()),
    corporateActions: { splits: history.splits, dividends: history.dividends },
    warnings,
  };
}

const retry = <T>(deps: SyncDeps, fn: () => Promise<T>) => withRetry(fn, { attempts: 3, baseMs: 500, sleep: deps.sleep });

function weekdays(range: SyncRange) {
  const out: string[] = [];
  for (let t = Date.parse(range.from); t <= Date.parse(range.to); t += 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) out.push(isoDay(t));
  }
  return out;
}

/** Sync one asset's price series from its configured source. */
export async function syncAssetSeries(deps: SyncDeps, asset: AssetLike, o: Opts, held: boolean): Promise<SeriesResult> {
  const key = `asset:${asset.id}`;
  try {
    if (asset.priceSource === "manual") {
      return { ...empty(asset.symbol, "unsupported", "แหล่งราคาเป็น manual — บันทึกราคาเองด้วย update_price หรือเปลี่ยนแหล่งราคาเป็น Yahoo"), source: "manual" };
    }
    if (asset.priceSource === "sec_th") {
      if (!asset.providerSymbol) return { ...empty(asset.symbol, "unsupported", "กองทุนต้องมี providerSymbol (proj_id ของ ก.ล.ต.)"), source: "sec_th" };
      const days = (Date.parse(o.range.to) - Date.parse(o.range.from)) / 86_400_000;
      if (days > MAX_FUND_NAV_DAYS) {
        return { ...empty(asset.symbol, "unsupported", `API ก.ล.ต. ดึง NAV ได้ทีละวัน — จำกัดช่วงไม่เกิน ${MAX_FUND_NAV_DAYS} วันต่อครั้ง`), source: "sec_th" };
      }
      const rows: PricePoint[] = [];
      for (const d of weekdays(o.range)) {
        const nav = await retry(deps, () => deps.fetchFundNav(asset.providerSymbol!, d));
        if (nav != null) rows.push({ date: d, close: nav, adjClose: null });
      }
      const r = await applySeries(deps, key, asset.symbol, { rows, splits: [], dividends: [] }, o, held, { source: "sec_th", providerSymbol: asset.providerSymbol });
      if (o.priceType === "adjusted_close") r.warnings.push(`${asset.symbol}: NAV กองทุนไม่มี adjusted series แยก (NAV สะท้อนการจ่ายปันผลอยู่แล้ว)`);
      return r;
    }
    if (asset.providerSymbol?.toUpperCase() === THAI_GOLD_SYMBOL) {
      const gold = await retry(deps, () => deps.fetchHistory("GC=F", o.range));
      const fx = await deps.loadFx();
      let missingFx = 0;
      const rows = gold.rows.flatMap((g) => {
        const rate = asOf(fx, g.date);
        if (!rate) {
          missingFx++;
          return [];
        }
        return [{ date: g.date, close: thaiGoldPrice(g.close, rate), adjClose: null }];
      });
      const r = await applySeries(deps, key, asset.symbol, { rows, splits: [], dividends: [] }, o, held, { source: "yahoo GC=F × USDTHB", providerSymbol: "GC=F" });
      if (missingFx) r.warnings.push(`${asset.symbol}: ข้าม ${missingFx} วันที่ไม่มีอัตรา USDTHB`);
      return r;
    }
    const provider = asset.providerSymbol || asset.symbol;
    const history = await retry(deps, () => deps.fetchHistory(provider, o.range));
    const r = await applySeries(deps, key, asset.symbol, history, o, held, { source: "yahoo", providerSymbol: provider });
    if (o.priceType === "adjusted_close" && r.status === "ok") {
      r.warnings.push(`${asset.symbol}: adjusted close ของ Yahoo ถูกปรับย้อนหลังทุกครั้งที่มีปันผลใหม่ — ควร sync ทั้งช่วงพร้อม overwriteExisting เพื่อให้ทั้งชุดอยู่บนฐานเดียวกัน`);
    }
    return r;
  } catch (e) {
    return { ...empty(asset.symbol, "error", e instanceof Error ? e.message : String(e)), source: asset.priceSource };
  }
}

/** Sync a non-asset series (benchmark index or USDTHB) from Yahoo. */
export async function syncMarketSeries(deps: SyncDeps, key: string, label: string, provider: string, o: Opts): Promise<SeriesResult> {
  try {
    const history = await retry(deps, () => deps.fetchHistory(provider, o.range));
    return await applySeries(deps, key, label, { ...history, splits: [], dividends: [] }, o, false, { source: "yahoo", providerSymbol: provider });
  } catch (e) {
    return { ...empty(label, "error", e instanceof Error ? e.message : String(e)), source: "yahoo", providerSymbol: provider };
  }
}

/** Backfill / incremental / date-range sync for the given assets, plus benchmark and USDTHB. */
export async function syncHistoricalPrices(input: SyncHistoricalPricesInput, deps: SyncDeps = dbDeps) {
  const x = syncHistoricalPricesInput.parse(input);
  const range = resolveSyncRange(x, deps.today());
  const o: Opts = { range, priceType: x.priceType, overwrite: x.overwriteExisting, dryRun: x.dryRun };
  const symbols = [...new Set(x.symbols.map((s) => s.trim().toUpperCase()))];

  // USDTHB first: Thai gold and USD assets are valued with it.
  const fx = x.includeFx ? await syncMarketSeries(deps, "fx:USDTHB", "USDTHB", "THB=X", o) : null;
  const benchSymbol = await deps.benchmarkSymbol();
  const benchmark = x.includeBenchmark ? await syncMarketSeries(deps, `bench:${benchSymbol}`, benchSymbol, benchSymbol, o) : null;

  const held = await deps.heldAssetIds();
  const results: SeriesResult[] = [];
  for (const [i, s] of symbols.entries()) {
    const asset = await deps.findAsset(s);
    if (!asset) {
      results.push(empty(s, "unknown_asset", `ไม่พบ ${s} ในรายการสินทรัพย์ — เพิ่มด้วย add_asset ก่อน (หุ้นไทยใช้ providerSymbol ${s}.BK) แล้วสั่ง sync ใหม่`));
      continue;
    }
    if (i > 0) await deps.sleep(300); // gentle on the free provider
    results.push(await syncAssetSeries(deps, asset, o, held.has(asset.id)));
  }

  const known = results.filter((r) => r.status === "ok" || r.status === "no_data").map((r) => r.symbol);
  const lookbackDays = Math.max(90, Math.ceil((Date.parse(deps.today()) - Date.parse(range.from)) / 86_400_000));
  let eligibility: Awaited<ReturnType<SyncDeps["eligibility"]>> | null = null;
  if (known.length) {
    try {
      eligibility = await deps.eligibility(known, lookbackDays);
    } catch (e) {
      eligibility = { lookbackDays, ok: false, reason: e instanceof Error ? e.message : String(e), eligible: [], skipped: [] };
    }
  }

  return {
    range,
    priceType: x.priceType,
    overwriteExisting: x.overwriteExisting,
    dryRun: x.dryRun,
    results,
    fx,
    benchmark,
    /** Optimizer eligibility from the existing universe loader, on stored data (before the writes of a dry run). */
    eligibility,
    summary: {
      requested: symbols.length,
      ok: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status === "error").length,
      unknown: results.filter((r) => r.status === "unknown_asset").length,
      unsupported: results.filter((r) => r.status === "unsupported").length,
      inserted: results.reduce((a, r) => a + r.inserted, 0),
      updated: results.reduce((a, r) => a + r.updated, 0),
    },
  };
}

// ------------------------------------------------------------------ database dependencies

function tableFor(key: string) {
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  return { kind, id };
}

const CHUNK = 500;

export const dbDeps: SyncDeps = {
  today: () => todayIso(),
  findAsset: (s) => getAssetBySymbol(s),
  fetchHistory: (p, r) => fetchDailyHistory(p, r),
  fetchFundNav: (p, d) => fetchFundNav(p, d),
  loadFx: () => loadFxHistory(),
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  async loadExisting(key, range) {
    const db = getDb();
    const { kind, id } = tableFor(key);
    const out: Existing = new Map();
    if (kind === "asset") {
      const t = schema.prices;
      const rows = await db.select({ d: t.date, c: t.close, a: t.adjClose }).from(t).where(and(eq(t.assetId, Number(id)), gte(t.date, range.from), lte(t.date, range.to)));
      for (const r of rows) out.set(r.d, { close: r.c, adjClose: r.a });
    } else if (kind === "bench") {
      const t = schema.benchmarkPrices;
      const rows = await db.select({ d: t.date, c: t.close, a: t.adjClose }).from(t).where(and(eq(t.symbol, id), gte(t.date, range.from), lte(t.date, range.to)));
      for (const r of rows) out.set(r.d, { close: r.c, adjClose: r.a });
    } else {
      const t = schema.fxRates;
      const rows = await db.select({ d: t.date, c: t.rate }).from(t).where(and(eq(t.pair, id), gte(t.date, range.from), lte(t.date, range.to)));
      for (const r of rows) out.set(r.d, { close: r.c, adjClose: null });
    }
    return out;
  },
  async write(key, inserts, updates) {
    const db = getDb();
    const { kind, id } = tableFor(key);
    for (const [rows, update] of [
      [inserts, false],
      [updates, true],
    ] as const) {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const part = rows.slice(i, i + CHUNK);
        if (kind === "asset") {
          const t = schema.prices;
          const q = db.insert(t).values(part.map((r) => ({ assetId: Number(id), date: r.date, close: r.close, adjClose: r.adjClose })));
          await (update ? q.onConflictDoUpdate({ target: [t.assetId, t.date], set: { close: sql`excluded.close`, adjClose: sql`excluded.adj_close` } }) : q.onConflictDoNothing());
        } else if (kind === "bench") {
          const t = schema.benchmarkPrices;
          const q = db.insert(t).values(part.map((r) => ({ symbol: id, date: r.date, close: r.close, adjClose: r.adjClose })));
          await (update ? q.onConflictDoUpdate({ target: [t.symbol, t.date], set: { close: sql`excluded.close`, adjClose: sql`excluded.adj_close` } }) : q.onConflictDoNothing());
        } else {
          const t = schema.fxRates;
          const q = db.insert(t).values(part.map((r) => ({ pair: id, date: r.date, rate: r.close })));
          await (update ? q.onConflictDoUpdate({ target: [t.pair, t.date], set: { rate: sql`excluded.rate` } }) : q.onConflictDoNothing());
        }
      }
    }
  },
  async eligibility(symbols, lookbackDays) {
    // Imported lazily: the universe loader depends on the price services this module feeds.
    // Whole universe, then the requested symbols: eligibility depends on dates shared with the other assets.
    const { loadUniverse } = await import("./optimizer");
    const u = await loadUniverse(lookbackDays);
    const want = new Set(symbols.map((x) => x.toUpperCase()));
    const eligible = u.assets.map((a) => a.symbol).filter((x) => want.has(x.toUpperCase()));
    const skipped = u.skipped.filter((x) => want.has(x.symbol.toUpperCase()));
    for (const x of want) {
      if (!eligible.some((e) => e.toUpperCase() === x) && !skipped.some((k) => k.symbol.toUpperCase() === x)) skipped.push({ symbol: x, reason: u.reason ?? "ไม่อยู่ใน universe" });
    }
    return { lookbackDays, ok: u.ok, reason: u.reason, eligible, skipped };
  },
  benchmarkSymbol: async () => (await getSettings()).benchmarkSymbol,
  async heldAssetIds() {
    const { getPortfolioSummary } = await import("./portfolio");
    const s = await getPortfolioSummary();
    return new Set(s.positions.filter((p) => p.quantity > 0).map((p) => p.assetId));
  },
};

export { PriceSyncError };
