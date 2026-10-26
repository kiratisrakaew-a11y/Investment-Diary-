import { desc, eq, max } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { today } from "@/lib/validation";
import { listAssets } from "./assets";
import { getSettings } from "./settings";
import { dbDeps, syncAssetSeries, syncMarketSeries, type SeriesResult } from "./price-sync";

const DEFAULT_HISTORY_DAYS = 365 * 3;

function daysAgo(n: number) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function lastPriceDate(assetId: number) {
  const [row] = await getDb()
    .select({ d: max(schema.prices.date) })
    .from(schema.prices)
    .where(eq(schema.prices.assetId, assetId));
  return row?.d ?? null;
}

/** Start a few days before the last stored date so late corrections are picked up. */
function fromDate(last: string | null) {
  if (!last) return daysAgo(DEFAULT_HISTORY_DAYS);
  return new Date(Date.parse(last) - 5 * 86_400_000).toISOString().slice(0, 10);
}

export interface UpdateResult {
  symbol: string;
  ok: boolean;
  rows?: number;
  error?: string;
}

const toResult = (r: SeriesResult): UpdateResult =>
  r.status === "ok" || r.status === "no_data" ? { symbol: r.symbol, ok: true, rows: r.fetched } : { symbol: r.symbol, ok: false, error: r.message };

/**
 * Incremental daily update of USDTHB, the benchmark and every non-manual asset, through the same
 * sync functions as `syncHistoricalPrices` (overwriting the recent window to pick up corrections).
 */
export async function updateAllPrices(): Promise<UpdateResult[]> {
  const results: UpdateResult[] = [];
  const db = getDb();
  const to = today();
  const opts = (from: string) => ({ range: { from: from > to ? to : from, to }, priceType: "close" as const, overwrite: true, dryRun: false });

  // 1. USD/THB
  const [lastFx] = await db.select({ d: schema.fxRates.date }).from(schema.fxRates).orderBy(desc(schema.fxRates.date)).limit(1);
  results.push(toResult(await syncMarketSeries(dbDeps, "fx:USDTHB", "USDTHB", "THB=X", opts(fromDate(lastFx?.d ?? null)))));

  // 2. Benchmark
  const settings = await getSettings();
  const [lastBench] = await db
    .select({ d: max(schema.benchmarkPrices.date) })
    .from(schema.benchmarkPrices)
    .where(eq(schema.benchmarkPrices.symbol, settings.benchmarkSymbol));
  const b = settings.benchmarkSymbol;
  results.push(toResult(await syncMarketSeries(dbDeps, `bench:${b}`, b, b, opts(fromDate(lastBench?.d ?? null)))));

  // 3. Assets
  for (const a of await listAssets()) {
    if (a.priceSource === "manual") continue;
    const last = await lastPriceDate(a.id);
    // Fund NAVs come one day per request: only the last week (or month on first run).
    const from = a.priceSource === "sec_th" ? daysAgo(last ? 7 : 30) : fromDate(last);
    results.push(toResult(await syncAssetSeries(dbDeps, a, opts(from), false)));
  }
  return results;
}
