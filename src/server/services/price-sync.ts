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
  adjRebaseDecision,
  resolveSyncRange,
  withRetry,
  type Coverage,
  type PricePoint,
  type PriceType,
  type SyncRange,
} from "@/lib/finance/price-coverage";
import { today as todayIso } from "@/lib/validation";
import { getAssetBySymbol } from "./assets";
import { loadAdjCheckInput, loadFxHistory } from "./prices";
import {
  checkAdjAgainstDividends,
  type AdjFlag,
  type AdjReadinessAsset,
} from "@/lib/finance/adj-check";
import { getSettings } from "./settings";

export const MAX_SYNC_SYMBOLS = 50;
/** SEC fund NAVs come one day per request; longer backfills are refused rather than half-done. */
export const MAX_FUND_NAV_DAYS = 400;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export const syncHistoricalPricesInput = z.object({
  symbols: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_SYNC_SYMBOLS)
    .describe(
      "Asset symbols as stored in the app (e.g. BBL, AP); add_asset first for new ones",
    ),
  startDate: z
    .string()
    .optional()
    .describe("YYYY-MM-DD; default = endDate − lookbackDays"),
  endDate: z.string().optional().describe("YYYY-MM-DD; default today"),
  lookbackDays: z
    .number()
    .int()
    .min(1)
    .max(3660)
    .optional()
    .describe("Default 365"),
  priceType: z
    .enum(["close", "adjusted_close"])
    .default("close")
    .describe(
      "close = provider close (split-adjusted). adjusted_close also stores the split+dividend-adjusted series",
    ),
  overwriteExisting: z
    .boolean()
    .default(false)
    .describe("false = keep stored prices, only add missing dates"),
  dryRun: z
    .boolean()
    .default(false)
    .describe("true = fetch and report what would change, write nothing"),
  includeBenchmark: z
    .boolean()
    .default(true)
    .describe("Also sync the benchmark index over the same range"),
  includeFx: z
    .boolean()
    .default(true)
    .describe("Also sync USDTHB over the same range"),
});
export type SyncHistoricalPricesInput = z.input<
  typeof syncHistoricalPricesInput
>;

export interface AssetLike {
  id: number;
  symbol: string;
  assetClass: string;
  currency: string;
  priceSource: string;
  providerSymbol: string | null;
}

type Existing = Map<
  string,
  { close: number; adjClose: number | null; volume?: number | null }
>;

export interface SyncDeps {
  today(): string;
  findAsset(symbol: string): Promise<AssetLike | null>;
  fetchHistory(providerSymbol: string, range: SyncRange): Promise<DailyHistory>;
  fetchFundNav(projId: string, date: string): Promise<number | null>;
  /** Series key: `asset:<id>`, `fx:USDTHB` or `bench:<symbol>`. */
  loadExisting(key: string, range: SyncRange): Promise<Existing>;
  write(
    key: string,
    inserts: PricePoint[],
    updates: PricePoint[],
  ): Promise<void>;
  /** Set volume on stored asset rows whose volume is empty (never touches close / adjusted close). Optional for test doubles. */
  fillVolume?(
    key: string,
    fills: { date: string; volume: number }[],
  ): Promise<number>;
  loadFx(): Promise<[string, number][]>;
  /** Adjusted-close provenance (MPT A2); optional for test doubles that do not exercise it. */
  loadAdjMeta?(
    assetId: number,
  ): Promise<{ adjBaseDate: string; adjLastEventDate: string | null } | null>;
  /** First stored date and number of stored adj_close values of an asset series. */
  adjStats?(
    key: string,
  ): Promise<{ firstDate: string | null; adjRows: number }>;
  /**
   * Replace the adj_close of EVERY stored row of the asset in one transaction: the given value, or null
   * for a date the provider no longer returns (never a value from another fetch); upsert the metadata.
   * close / volume untouched. Returns nothing; all-or-nothing.
   */
  rebaseAdj?(
    key: string,
    adj: Map<string, number | null>,
    meta: { adjBaseDate: string; adjLastEventDate: string | null },
  ): Promise<void>;
  setAdjMeta?(
    assetId: number,
    meta: { adjBaseDate: string; adjLastEventDate: string | null },
  ): Promise<void>;
  /** Stored close / adj_close + recorded dividends and splits of one asset (A4 checks after an adjusted sync). */
  adjCheckInput?(asset: AssetLike): Promise<AdjReadinessAsset | null>;
  sleep(ms: number): Promise<void>;
  eligibility(
    symbols: string[],
    lookbackDays: number,
  ): Promise<{
    lookbackDays: number;
    ok: boolean;
    reason?: string;
    eligible: string[];
    skipped: { symbol: string; reason: string }[];
  }>;
  benchmarkSymbol(): Promise<string>;
  /** Register an imported index's kind (benchmark_meta); optional so test fakes need not implement it. */
  setBenchmarkKind?(
    symbol: string,
    kind: "price_index" | "total_return",
  ): Promise<void>;
  heldAssetIds(): Promise<Set<number>>;
  /** Persist provider dividend events (issuer data, never the ledger). Optional so test doubles can omit it. */
  saveDividendEvents?(
    symbol: string,
    provider: string,
    currency: string,
    dividends: DailyHistory["dividends"],
  ): Promise<{ inserted: number; updated: number }>;
}

export type SyncStatus =
  | "ok"
  | "no_data"
  | "unknown_asset"
  | "unsupported"
  | "error";

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
  /** Per-column counters (see WritePlan): close rewritten / adj_close filled where empty / adj_close replaced. */
  closeUpdated?: number;
  adjCloseFilled?: number;
  adjCloseRebased?: number;
  /** Days in the range with an adjusted close ÷ days with a close (after this sync; dry run = what it would be). */
  adjCloseCoverage?: { withAdjClose: number; withClose: number; ratio: number };
  /** Whole-series adj_close rebase (adjusted_close syncs): done or not, why, and how many stored rows changed. */
  adjRebase?: { rebased: boolean; reason: string; rowsChanged: number };
  /** adj_close vs recorded dividends / splits after an adjusted sync (MPT A4). */
  adjFlags?: AdjFlag[];
  unchanged: number;
  /** Stored rows that received a volume (prices unchanged). */
  volumeFilled?: number;
  coverage?: Coverage;
  corporateActions?: {
    splits: DailyHistory["splits"];
    dividends: DailyHistory["dividends"];
  };
  warnings: string[];
}

const empty = (
  symbol: string,
  status: SyncStatus,
  message?: string,
): SeriesResult => ({
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
async function applySeries(
  deps: SyncDeps,
  key: string,
  label: string,
  history: DailyHistory,
  o: Opts,
  held: boolean,
  base: Partial<SeriesResult>,
): Promise<SeriesResult> {
  const existing = await deps.loadExisting(key, o.range);
  const plan = planWrites(existing, history.rows, {
    overwrite: o.overwrite,
    priceType: o.priceType,
  });
  if (!o.dryRun && (plan.inserts.length || plan.updates.length))
    await deps.write(key, plan.inserts, plan.updates);
  // Volume is stored for assets only (benchmark / FX rows have none).
  const volumeFills = key.startsWith("asset:") ? plan.volumeFills : [];
  const volumeFilled =
    !o.dryRun && volumeFills.length && deps.fillVolume
      ? await deps.fillVolume(key, volumeFills)
      : o.dryRun
        ? volumeFills.length
        : 0;
  const dates = new Set([
    ...existing.keys(),
    ...plan.inserts.map((r) => r.date),
  ]);
  // Adjusted-close coverage of the requested range as it stands after this plan.
  const adjAfter = new Map([...existing].map(([d, r]) => [d, r.adjClose]));
  for (const r of [...plan.inserts, ...plan.updates])
    adjAfter.set(r.date, r.adjClose);
  const inRange = [...adjAfter].filter(
    ([d]) => d >= o.range.from && d <= o.range.to,
  );
  const withAdj = inRange.filter(([, a]) => a != null).length;
  const warnings = corporateActionWarnings(
    label,
    history.splits,
    history.dividends,
    held,
  );
  if (plan.changedButKept)
    warnings.push(
      `${label}: ${plan.changedButKept} วันที่ราคา${base.source === "import" ? "ในไฟล์" : "จากผู้ให้ข้อมูล"}ต่างจากที่เก็บไว้ — เก็บของเดิมไว้ (ใช้ overwriteExisting เพื่ออัปเดต)`,
    );
  if (plan.invalid)
    warnings.push(
      `${label}: ข้ามราคา ${plan.invalid} แถวที่ไม่ถูกต้อง (≤ 0 หรือไม่ใช่ตัวเลข)`,
    );
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
    closeUpdated: plan.closeUpdated,
    adjCloseFilled: plan.adjCloseFilled,
    adjCloseRebased: plan.adjCloseRebased,
    adjCloseCoverage: {
      withAdjClose: withAdj,
      withClose: inRange.length,
      ratio: inRange.length ? withAdj / inRange.length : 0,
    },
    ...(key.startsWith("asset:") ? { volumeFilled } : {}),
    coverage: coverage([...dates], o.range, deps.today()),
    corporateActions: { splits: history.splits, dividends: history.dividends },
    warnings,
  };
}

const retry = <T>(deps: SyncDeps, fn: () => Promise<T>) =>
  withRetry(fn, { attempts: 3, baseMs: 500, sleep: deps.sleep });

function weekdays(range: SyncRange) {
  const out: string[] = [];
  for (
    let t = Date.parse(range.from);
    t <= Date.parse(range.to);
    t += 86_400_000
  ) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) out.push(isoDay(t));
  }
  return out;
}

/** Sync one asset's price series from its configured source. */
/**
 * MPT A2: keep one base for an asset's adjusted closes. When the provider rebased (or the stored base is
 * unknown / older than a new dividend or split), fetch the WHOLE stored range again and replace adj_close
 * for every stored row in one transaction. The rows of the requested range then come from that same fetch.
 */
async function rebaseAdjIfNeeded(
  deps: SyncDeps,
  asset: AssetLike,
  provider: string,
  history: DailyHistory,
  o: Opts,
) {
  if (
    !deps.loadAdjMeta ||
    !deps.adjStats ||
    !deps.rebaseAdj ||
    !deps.setAdjMeta
  )
    return null;
  const key = `asset:${asset.id}`;
  const meta = await deps.loadAdjMeta(asset.id);
  const stats = await deps.adjStats(key);
  const existing = await deps.loadExisting(key, o.range);
  const eventDates = [
    ...history.dividends.map((d) => d.date),
    ...history.splits.map((x) => x.date),
  ];
  const decision = adjRebaseDecision(existing, history.rows, {
    meta,
    storedAdjRows: stats.adjRows,
    eventDates,
  });
  const lastEvent = (dates: string[]) =>
    dates.reduce<string | null>(
      (m, d) => (m == null || d > m ? d : m),
      meta?.adjLastEventDate ?? null,
    );
  if (!decision.rebase) {
    // First adjusted sync of this asset: record the base it starts on.
    if (!o.dryRun && !meta && history.rows.some((r) => r.adjClose != null))
      await deps.setAdjMeta(asset.id, {
        adjBaseDate: deps.today(),
        adjLastEventDate: lastEvent(eventDates),
      });
    return {
      history,
      report: { rebased: false, reason: decision.reason, rowsChanged: 0 },
    };
  }
  const from =
    stats.firstDate && stats.firstDate < o.range.from
      ? stats.firstDate
      : o.range.from;
  const full =
    from < o.range.from
      ? await retry(deps, () =>
          deps.fetchHistory(provider, { from, to: o.range.to }),
        )
      : history;
  const adj = new Map(
    full.rows.map(
      (r) => [r.date, r.adjClose ?? null] as [string, number | null],
    ),
  );
  const stored = await deps.loadExisting(key, { from, to: o.range.to });
  let rowsChanged = 0;
  for (const [d, cur] of stored) {
    const next = adj.get(d) ?? null;
    if (
      !(cur.adjClose == null
        ? next == null
        : next != null &&
          Math.abs(cur.adjClose - next) <= 1e-9 * Math.max(1, Math.abs(next)))
    )
      rowsChanged++;
  }
  if (!o.dryRun)
    await deps.rebaseAdj(key, adj, {
      adjBaseDate: deps.today(),
      adjLastEventDate: lastEvent([
        ...full.dividends.map((d) => d.date),
        ...full.splits.map((x) => x.date),
      ]),
    });
  // The requested range from the same fetch, so new rows share the base.
  const inRange = {
    ...full,
    rows: full.rows.filter(
      (r) => r.date >= o.range.from && r.date <= o.range.to,
    ),
  };
  return {
    history: inRange,
    report: { rebased: true, reason: decision.reason, rowsChanged },
  };
}

export async function syncAssetSeries(
  deps: SyncDeps,
  asset: AssetLike,
  o: Opts,
  held: boolean,
): Promise<SeriesResult> {
  const key = `asset:${asset.id}`;
  try {
    if (asset.priceSource === "manual") {
      return {
        ...empty(
          asset.symbol,
          "unsupported",
          "แหล่งราคาเป็น manual — บันทึกราคาเองด้วย update_price หรือเปลี่ยนแหล่งราคาเป็น Yahoo",
        ),
        source: "manual",
      };
    }
    if (asset.priceSource === "sec_th") {
      if (!asset.providerSymbol)
        return {
          ...empty(
            asset.symbol,
            "unsupported",
            "กองทุนต้องมี providerSymbol (proj_id ของ ก.ล.ต.)",
          ),
          source: "sec_th",
        };
      const days =
        (Date.parse(o.range.to) - Date.parse(o.range.from)) / 86_400_000;
      if (days > MAX_FUND_NAV_DAYS) {
        return {
          ...empty(
            asset.symbol,
            "unsupported",
            `API ก.ล.ต. ดึง NAV ได้ทีละวัน — จำกัดช่วงไม่เกิน ${MAX_FUND_NAV_DAYS} วันต่อครั้ง`,
          ),
          source: "sec_th",
        };
      }
      const rows: PricePoint[] = [];
      for (const d of weekdays(o.range)) {
        const nav = await retry(deps, () =>
          deps.fetchFundNav(asset.providerSymbol!, d),
        );
        if (nav != null) rows.push({ date: d, close: nav, adjClose: null });
      }
      const r = await applySeries(
        deps,
        key,
        asset.symbol,
        { rows, splits: [], dividends: [] },
        o,
        held,
        { source: "sec_th", providerSymbol: asset.providerSymbol },
      );
      if (o.priceType === "adjusted_close")
        r.warnings.push(
          `${asset.symbol}: NAV กองทุนไม่มี adjusted series แยก (NAV สะท้อนการจ่ายปันผลอยู่แล้ว)`,
        );
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
        return [
          { date: g.date, close: thaiGoldPrice(g.close, rate), adjClose: null },
        ];
      });
      const r = await applySeries(
        deps,
        key,
        asset.symbol,
        { rows, splits: [], dividends: [] },
        o,
        held,
        { source: "yahoo GC=F × USDTHB", providerSymbol: "GC=F" },
      );
      if (missingFx)
        r.warnings.push(
          `${asset.symbol}: ข้าม ${missingFx} วันที่ไม่มีอัตรา USDTHB`,
        );
      return r;
    }
    const provider = asset.providerSymbol || asset.symbol;
    const history = await retry(deps, () =>
      deps.fetchHistory(provider, o.range),
    );
    const rebase =
      o.priceType === "adjusted_close"
        ? await rebaseAdjIfNeeded(deps, asset, provider, history, o)
        : null;
    const r = await applySeries(
      deps,
      key,
      asset.symbol,
      rebase?.history ?? history,
      o,
      held,
      {
        source: "yahoo",
        providerSymbol: provider,
      },
    );
    if (rebase) {
      r.adjRebase = rebase.report;
      // A rebase replaces the stored values itself (the range plan then finds them equal).
      if (rebase.report.rebased) r.adjCloseRebased = rebase.report.rowsChanged;
    }
    if (!o.dryRun && history.dividends.length && deps.saveDividendEvents) {
      const d = await deps.saveDividendEvents(
        asset.symbol,
        provider,
        asset.currency ?? "THB",
        history.dividends,
      );
      if (d.inserted || d.updated)
        r.warnings.push(
          `${asset.symbol}: บันทึกเหตุการณ์ปันผลจาก Yahoo ${d.inserted} ใหม่ / ${d.updated} แก้ไข (ข้อมูลผู้ออก — ไม่ใช่รายการรับเงินในบัญชี)`,
        );
    }
    if (
      o.priceType === "adjusted_close" &&
      !o.dryRun &&
      r.status === "ok" &&
      deps.adjCheckInput
    ) {
      // Diagnostic only: a failed check is reported, never turns a completed sync into an error.
      try {
        const input = await deps.adjCheckInput(asset);
        if (input) {
          r.adjFlags = checkAdjAgainstDividends(
            input.symbol,
            input.obs,
            input.dividends,
            input.splitDates,
          );
          if (r.adjFlags.length)
            r.warnings.push(
              `${asset.symbol}: adj_close ไม่สอดคล้องกับข้อมูลปันผล/แตกพาร์ ${r.adjFlags.length} จุด — ${r.adjFlags[0].message}`,
            );
        }
      } catch (e) {
        r.warnings.push(
          `${asset.symbol}: ตรวจ adj_close กับข้อมูลปันผลไม่สำเร็จ (${e instanceof Error ? e.message : String(e)}) — ราคาบันทึกแล้วตามปกติ`,
        );
      }
    }
    if (rebase?.report.rebased)
      r.warnings.push(
        `${asset.symbol}: ${o.dryRun ? "จะ" : ""}ปรับ adj_close ทั้งชุดเป็นฐานใหม่ (${rebase.report.reason}) — ${rebase.report.rowsChanged} วันเปลี่ยน`,
      );
    return r;
  } catch (e) {
    return {
      ...empty(
        asset.symbol,
        "error",
        e instanceof Error ? e.message : String(e),
      ),
      source: asset.priceSource,
    };
  }
}

/** Sync a non-asset series (benchmark index or USDTHB) from Yahoo. */
export async function syncMarketSeries(
  deps: SyncDeps,
  key: string,
  label: string,
  provider: string,
  o: Opts,
): Promise<SeriesResult> {
  try {
    const history = await retry(deps, () =>
      deps.fetchHistory(provider, o.range),
    );
    return await applySeries(
      deps,
      key,
      label,
      { ...history, splits: [], dividends: [] },
      o,
      false,
      { source: "yahoo", providerSymbol: provider },
    );
  } catch (e) {
    return {
      ...empty(label, "error", e instanceof Error ? e.message : String(e)),
      source: "yahoo",
      providerSymbol: provider,
    };
  }
}

/** Backfill / incremental / date-range sync for the given assets, plus benchmark and USDTHB. */
export async function syncHistoricalPrices(
  input: SyncHistoricalPricesInput,
  deps: SyncDeps = dbDeps,
) {
  const x = syncHistoricalPricesInput.parse(input);
  const range = resolveSyncRange(x, deps.today());
  const o: Opts = {
    range,
    priceType: x.priceType,
    overwrite: x.overwriteExisting,
    dryRun: x.dryRun,
  };
  const symbols = [...new Set(x.symbols.map((s) => s.trim().toUpperCase()))];

  // USDTHB first: Thai gold and USD assets are valued with it.
  const fx = x.includeFx
    ? await syncMarketSeries(deps, "fx:USDTHB", "USDTHB", "THB=X", o)
    : null;
  const benchSymbol = await deps.benchmarkSymbol();
  const benchmark = x.includeBenchmark
    ? await syncMarketSeries(
        deps,
        `bench:${benchSymbol}`,
        benchSymbol,
        benchSymbol,
        o,
      )
    : null;

  const held = await deps.heldAssetIds();
  const results: SeriesResult[] = [];
  for (const [i, s] of symbols.entries()) {
    const asset = await deps.findAsset(s);
    if (!asset) {
      results.push(
        empty(
          s,
          "unknown_asset",
          `ไม่พบ ${s} ในรายการสินทรัพย์ — เพิ่มด้วย add_asset ก่อน (หุ้นไทยใช้ providerSymbol ${s}.BK) แล้วสั่ง sync ใหม่`,
        ),
      );
      continue;
    }
    if (i > 0) await deps.sleep(300); // gentle on the free provider
    results.push(await syncAssetSeries(deps, asset, o, held.has(asset.id)));
  }

  const known = results
    .filter((r) => r.status === "ok" || r.status === "no_data")
    .map((r) => r.symbol);
  const lookbackDays = Math.max(
    90,
    Math.ceil((Date.parse(deps.today()) - Date.parse(range.from)) / 86_400_000),
  );
  let eligibility: Awaited<ReturnType<SyncDeps["eligibility"]>> | null = null;
  if (known.length) {
    try {
      eligibility = await deps.eligibility(known, lookbackDays);
    } catch (e) {
      eligibility = {
        lookbackDays,
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
        eligible: [],
        skipped: [],
      };
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

// ------------------------------------------------------------------ bulk import (user-supplied prices)

export const MAX_IMPORT_ROWS = 50_000;

export const importPricesInput = z.object({
  rows: z
    .array(
      z.object({
        symbol: z.string().min(1),
        date: z.string(),
        close: z.number(),
        adjClose: z.number().nullable().optional(),
        volume: z.number().min(0).nullable().optional(),
      }),
    )
    .max(MAX_IMPORT_ROWS)
    .optional()
    .describe(
      "Prices to store: [{ symbol, date YYYY-MM-DD, close, adjClose?, volume? (shares traded) }]",
    ),
  csv: z
    .string()
    .max(5_000_000)
    .optional()
    .describe(
      "Alternative to rows: CSV text (symbol,date,close | date,SYM1,SYM2,… | one-symbol export with `symbol`)",
    ),
  symbol: z
    .string()
    .optional()
    .describe(
      "Symbol for a one-symbol CSV export (Date, Open, High, Low, Close, …)",
    ),
  overwriteExisting: z
    .boolean()
    .default(false)
    .describe("false = keep stored prices, only add missing dates"),
  dryRun: z
    .boolean()
    .default(false)
    .describe("true = validate and report what would change, write nothing"),
  target: z
    .enum(["asset", "benchmark"])
    .default("asset")
    .describe(
      "asset = prices of assets in the app (default). benchmark = an index series such as SETTRI (SET Total Return Index) stored by symbol in the benchmark table; volume is ignored",
    ),
  kind: z
    .enum(["price_index", "total_return"])
    .optional()
    .describe(
      'target "benchmark" only: whether the index includes dividends (total_return, e.g. SETTRI) or not (price_index, e.g. ^SET.BK). Stored in the benchmark registry; omitted = keep the registered kind',
    ),
});
export type ImportPricesInput = z.input<typeof importPricesInput>;

/**
 * Store many prices supplied by the user (file, pasted table or AI tool) with the same rules as the
 * provider sync: existing prices are kept unless overwriteExisting, dry run writes nothing, unknown
 * symbols are reported. Any price source is accepted (manual assets included).
 */
export async function importPrices(
  input: ImportPricesInput,
  deps: SyncDeps = dbDeps,
) {
  const x = importPricesInput.parse(input);
  const parseErrors: { line: number; reason: string }[] = [];
  let rows: {
    symbol: string;
    date: string;
    close: number;
    adjClose: number | null;
    volume?: number | null;
  }[] = (x.rows ?? []).map((r) => ({
    ...r,
    symbol: r.symbol.trim().toUpperCase(),
    adjClose: r.adjClose ?? null,
  }));
  let format: string | null = x.rows ? "rows" : null;
  if (x.csv) {
    const { parsePriceTable } = await import("@/lib/prices/price-import");
    const p = parsePriceTable(x.csv, { symbol: x.symbol });
    rows = rows.concat(p.rows);
    parseErrors.push(...p.errors);
    format = p.format;
  }
  if (rows.length > MAX_IMPORT_ROWS)
    throw new PriceSyncError(
      "INVALID_INPUT",
      `มี ${rows.length} แถว เกินสูงสุด ${MAX_IMPORT_ROWS} — แบ่งไฟล์`,
    );
  const today = deps.today();
  const bySymbol = new Map<string, PricePoint[]>();
  for (const r of rows)
    bySymbol.set(r.symbol, [
      ...(bySymbol.get(r.symbol) ?? []),
      {
        date: r.date,
        close: r.close,
        adjClose: r.adjClose,
        ...(r.volume != null ? { volume: r.volume } : {}),
      },
    ]);
  const isBench = x.target === "benchmark";

  const held = await deps.heldAssetIds();
  const results: SeriesResult[] = [];
  for (const [symbol, list] of bySymbol) {
    const asset = isBench ? null : await deps.findAsset(symbol);
    if (!isBench && !asset) {
      results.push({
        ...empty(
          symbol,
          "unknown_asset",
          `ไม่พบ ${symbol} ในรายการสินทรัพย์ — เพิ่มสินทรัพย์ก่อนแล้วนำเข้าใหม่ (ถ้าเป็นดัชนี เช่น SETTRI ให้ใช้ target: "benchmark")`,
        ),
        fetched: list.length,
      });
      continue;
    }
    const warnings: string[] = [];
    // Last value wins for a date that appears more than once in the input.
    const byDate = new Map<string, PricePoint>();
    let dups = 0;
    let future = 0;
    let badDate = 0;
    for (const r of list) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
        Number.isNaN(Date.parse(r.date))
      ) {
        badDate++;
        continue;
      }
      if (r.date > today) {
        future++;
        continue;
      }
      if (byDate.has(r.date)) dups++;
      byDate.set(r.date, r);
    }
    if (dups)
      warnings.push(`${symbol}: วันที่ซ้ำในข้อมูล ${dups} แถว — ใช้แถวหลังสุด`);
    if (future) warnings.push(`${symbol}: ข้าม ${future} แถวที่เป็นวันในอนาคต`);
    if (badDate)
      warnings.push(
        `${symbol}: ข้าม ${badDate} แถวที่วันที่ไม่ใช่รูปแบบ YYYY-MM-DD`,
      );
    const points = [...byDate.values()].sort((a, b) =>
      a.date < b.date ? -1 : 1,
    );
    if (!points.length) {
      results.push({
        ...empty(symbol, "no_data", "ไม่มีแถวที่ใช้ได้"),
        warnings,
        fetched: list.length,
      });
      continue;
    }
    const range = { from: points[0].date, to: points[points.length - 1].date };
    const priceType: PriceType = points.some((p) => p.adjClose != null)
      ? "adjusted_close"
      : "close";
    const r = await applySeries(
      deps,
      asset ? `asset:${asset.id}` : `bench:${symbol}`,
      asset?.symbol ?? symbol,
      { rows: points, splits: [], dividends: [] },
      { range, priceType, overwrite: x.overwriteExisting, dryRun: x.dryRun },
      asset ? held.has(asset.id) : false,
      {
        source: "import",
      },
    );
    if (isBench && points.some((p) => p.volume != null))
      r.warnings.push(`${symbol}: ไม่เก็บ volume ของ benchmark`);
    r.fetched = list.length;
    r.warnings.unshift(...warnings);
    results.push(r);
  }

  const known = results.filter((r) => r.status === "ok").map((r) => r.symbol);
  if (isBench && x.kind && !x.dryRun && known.length && deps.setBenchmarkKind)
    for (const symbol of known) await deps.setBenchmarkKind(symbol, x.kind);
  let eligibility: Awaited<ReturnType<SyncDeps["eligibility"]>> | null = null;
  if (known.length && !x.dryRun && !isBench) {
    try {
      eligibility = await deps.eligibility(known, 365);
    } catch {
      eligibility = null;
    }
  }
  return {
    format,
    dryRun: x.dryRun,
    overwriteExisting: x.overwriteExisting,
    target: x.target,
    parseErrors: parseErrors.slice(0, 200),
    parseErrorCount: parseErrors.length,
    results,
    eligibility,
    summary: {
      rows: rows.length,
      symbols: bySymbol.size,
      ok: results.filter((r) => r.status === "ok").length,
      unknown: results.filter((r) => r.status === "unknown_asset").length,
      inserted: results.reduce((a, r) => a + r.inserted, 0),
      updated: results.reduce((a, r) => a + r.updated, 0),
      skippedExisting: results.reduce((a, r) => a + r.skippedExisting, 0),
    },
  };
}

// ------------------------------------------------------------------ database dependencies

function tableFor(key: string) {
  const [kind, id] = [
    key.slice(0, key.indexOf(":")),
    key.slice(key.indexOf(":") + 1),
  ];
  return { kind, id };
}

const CHUNK = 500;

export const dbDeps: SyncDeps = {
  saveDividendEvents: async (symbol, provider, currency, dividends) => {
    const { upsertDividendEvents, yahooEvents } = await import("./dividends");
    return upsertDividendEvents(
      yahooEvents(symbol, provider, currency, dividends),
    );
  },
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
      const rows = await db
        .select({ d: t.date, c: t.close, a: t.adjClose, v: t.volume })
        .from(t)
        .where(
          and(
            eq(t.assetId, Number(id)),
            gte(t.date, range.from),
            lte(t.date, range.to),
          ),
        );
      for (const r of rows)
        out.set(r.d, { close: r.c, adjClose: r.a, volume: r.v });
    } else if (kind === "bench") {
      const t = schema.benchmarkPrices;
      const rows = await db
        .select({ d: t.date, c: t.close, a: t.adjClose })
        .from(t)
        .where(
          and(eq(t.symbol, id), gte(t.date, range.from), lte(t.date, range.to)),
        );
      for (const r of rows) out.set(r.d, { close: r.c, adjClose: r.a });
    } else {
      const t = schema.fxRates;
      const rows = await db
        .select({ d: t.date, c: t.rate })
        .from(t)
        .where(
          and(eq(t.pair, id), gte(t.date, range.from), lte(t.date, range.to)),
        );
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
          const q = db.insert(t).values(
            part.map((r) => ({
              assetId: Number(id),
              date: r.date,
              close: r.close,
              adjClose: r.adjClose,
              volume: r.volume ?? null,
            })),
          );
          await (update
            ? q.onConflictDoUpdate({
                target: [t.assetId, t.date],
                set: {
                  close: sql`excluded.close`,
                  adjClose: sql`excluded.adj_close`,
                },
              })
            : q.onConflictDoNothing());
        } else if (kind === "bench") {
          const t = schema.benchmarkPrices;
          const q = db.insert(t).values(
            part.map((r) => ({
              symbol: id,
              date: r.date,
              close: r.close,
              adjClose: r.adjClose,
            })),
          );
          await (update
            ? q.onConflictDoUpdate({
                target: [t.symbol, t.date],
                set: {
                  close: sql`excluded.close`,
                  adjClose: sql`excluded.adj_close`,
                },
              })
            : q.onConflictDoNothing());
        } else {
          const t = schema.fxRates;
          const q = db
            .insert(t)
            .values(
              part.map((r) => ({ pair: id, date: r.date, rate: r.close })),
            );
          await (update
            ? q.onConflictDoUpdate({
                target: [t.pair, t.date],
                set: { rate: sql`excluded.rate` },
              })
            : q.onConflictDoNothing());
        }
      }
    }
  },
  async loadAdjMeta(assetId) {
    const [m] = await getDb()
      .select()
      .from(schema.priceAdjustmentMeta)
      .where(eq(schema.priceAdjustmentMeta.assetId, assetId));
    return m
      ? { adjBaseDate: m.adjBaseDate, adjLastEventDate: m.adjLastEventDate }
      : null;
  },
  async adjStats(key) {
    const { kind, id } = tableFor(key);
    if (kind !== "asset") return { firstDate: null, adjRows: 0 };
    const t = schema.prices;
    const [r] = await getDb()
      .select({
        first: sql<string | null>`min(${t.date})`,
        adj: sql<number>`count(${t.adjClose})::int`,
      })
      .from(t)
      .where(eq(t.assetId, Number(id)));
    return { firstDate: r?.first ?? null, adjRows: r?.adj ?? 0 };
  },
  async rebaseAdj(key, adj, meta) {
    const { kind, id } = tableFor(key);
    if (kind !== "asset") return;
    const t = schema.prices;
    const assetId = Number(id);
    const payload = JSON.stringify(
      [...adj].filter(([, a]) => a != null).map(([d, a]) => ({ d, a })),
    );
    // One transaction: every stored adj_close of the asset comes from this fetch or is null — never mixed.
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`
        update ${t} set adj_close = (x->>'a')::double precision
        from jsonb_array_elements(${payload}::jsonb) x
        where ${t.assetId} = ${assetId} and ${t.date} = (x->>'d')::date`);
      await tx.execute(sql`
        update ${t} set adj_close = null
        where ${t.assetId} = ${assetId} and adj_close is not null
          and ${t.date} not in (select (x->>'d')::date from jsonb_array_elements(${payload}::jsonb) x)`);
      await tx
        .insert(schema.priceAdjustmentMeta)
        .values({
          assetId,
          adjBaseDate: meta.adjBaseDate,
          adjLastEventDate: meta.adjLastEventDate,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.priceAdjustmentMeta.assetId,
          set: {
            adjBaseDate: meta.adjBaseDate,
            adjLastEventDate: meta.adjLastEventDate,
            updatedAt: new Date(),
          },
        });
    });
  },
  async setAdjMeta(assetId, meta) {
    await getDb()
      .insert(schema.priceAdjustmentMeta)
      .values({
        assetId,
        adjBaseDate: meta.adjBaseDate,
        adjLastEventDate: meta.adjLastEventDate,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.priceAdjustmentMeta.assetId,
        set: {
          adjBaseDate: meta.adjBaseDate,
          adjLastEventDate: meta.adjLastEventDate,
          updatedAt: new Date(),
        },
      });
  },
  async adjCheckInput(asset) {
    const [x] = await loadAdjCheckInput(
      [{ id: asset.id, symbol: asset.symbol, assetClass: asset.assetClass }],
      "1900-01-01",
    );
    return x ?? null;
  },
  async fillVolume(key, fills) {
    const { kind, id } = tableFor(key);
    if (kind !== "asset" || !fills.length) return 0;
    const t = schema.prices;
    let n = 0;
    // One statement per chunk; `volume is null` guarantees a stored volume is never replaced and prices are not touched.
    for (let i = 0; i < fills.length; i += CHUNK) {
      const part = fills.slice(i, i + CHUNK);
      const rows = await getDb().execute(sql`
        update ${t} set volume = v.volume
        from (values ${sql.join(
          part.map(
            (f) => sql`(${f.date}::date, ${f.volume}::double precision)`,
          ),
          sql`, `,
        )}) as v(d, volume)
        where ${t.assetId} = ${Number(id)} and ${t.date} = v.d and ${t.volume} is null
        returning ${t.id}`);
      n += (rows as unknown as unknown[]).length;
    }
    return n;
  },
  async eligibility(symbols, lookbackDays) {
    // Imported lazily: the universe loader depends on the price services this module feeds.
    // Whole universe, then the requested symbols: eligibility depends on dates shared with the other assets.
    const { loadUniverse } = await import("./optimizer");
    const u = await loadUniverse(lookbackDays);
    const want = new Set(symbols.map((x) => x.toUpperCase()));
    const eligible = u.assets
      .map((a) => a.symbol)
      .filter((x) => want.has(x.toUpperCase()));
    const skipped = u.skipped.filter((x) => want.has(x.symbol.toUpperCase()));
    for (const x of want) {
      if (
        !eligible.some((e) => e.toUpperCase() === x) &&
        !skipped.some((k) => k.symbol.toUpperCase() === x)
      )
        skipped.push({ symbol: x, reason: u.reason ?? "ไม่อยู่ใน universe" });
    }
    return { lookbackDays, ok: u.ok, reason: u.reason, eligible, skipped };
  },
  benchmarkSymbol: async () => (await getSettings()).benchmarkSymbol,
  async setBenchmarkKind(symbol, kind) {
    const { setBenchmarkKind } = await import("./benchmarks");
    await setBenchmarkKind(symbol, kind, "import");
  },
  async heldAssetIds() {
    const { getPortfolioSummary } = await import("./portfolio");
    const s = await getPortfolioSummary();
    return new Set(
      s.positions.filter((p) => p.quantity > 0).map((p) => p.assetId),
    );
  },
};

export { PriceSyncError };
