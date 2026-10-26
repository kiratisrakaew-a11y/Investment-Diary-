import { desc, eq, max } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { fetchDailyCloses } from "@/lib/prices/yahoo";
import { fetchRecentFundNavs } from "@/lib/prices/sec-th";
import { THAI_GOLD_SYMBOL, thaiGoldPrice } from "@/lib/prices/gold";
import { asOf } from "@/lib/finance/portfolio";
import { listAssets } from "./assets";
import { getSettings } from "./settings";
import { loadFxHistory, upsertBenchmark, upsertFx, upsertPrice } from "./prices";

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

export async function updateAllPrices(): Promise<UpdateResult[]> {
  const results: UpdateResult[] = [];
  const db = getDb();

  // 1. USD/THB
  try {
    const [last] = await db
      .select({ d: schema.fxRates.date })
      .from(schema.fxRates)
      .orderBy(desc(schema.fxRates.date))
      .limit(1);
    const rows = await fetchDailyCloses("THB=X", fromDate(last?.d ?? null));
    for (const r of rows) await upsertFx(r.date, r.close);
    results.push({ symbol: "USDTHB", ok: true, rows: rows.length });
  } catch (e) {
    results.push({ symbol: "USDTHB", ok: false, error: (e as Error).message });
  }

  // 2. Benchmark
  const settings = await getSettings();
  try {
    const [last] = await db
      .select({ d: max(schema.benchmarkPrices.date) })
      .from(schema.benchmarkPrices)
      .where(eq(schema.benchmarkPrices.symbol, settings.benchmarkSymbol));
    const rows = await fetchDailyCloses(settings.benchmarkSymbol, fromDate(last?.d ?? null));
    for (const r of rows) await upsertBenchmark(settings.benchmarkSymbol, r.date, r.close);
    results.push({ symbol: settings.benchmarkSymbol, ok: true, rows: rows.length });
  } catch (e) {
    results.push({ symbol: settings.benchmarkSymbol, ok: false, error: (e as Error).message });
  }

  // 3. Assets
  const fx = await loadFxHistory();
  for (const a of await listAssets()) {
    if (a.priceSource === "manual") continue;
    try {
      const from = fromDate(await lastPriceDate(a.id));
      let rows: { date: string; close: number }[] = [];
      if (a.priceSource === "sec_th") {
        if (!a.providerSymbol) throw new Error("providerSymbol (SEC proj_id) is required");
        rows = await fetchRecentFundNavs(a.providerSymbol, (await lastPriceDate(a.id)) ? 7 : 30);
      } else if (a.providerSymbol?.toUpperCase() === THAI_GOLD_SYMBOL) {
        const gold = await fetchDailyCloses("GC=F", from);
        rows = gold.flatMap((g) => {
          const rate = asOf(fx, g.date);
          return rate ? [{ date: g.date, close: thaiGoldPrice(g.close, rate) }] : [];
        });
      } else {
        rows = await fetchDailyCloses(a.providerSymbol || a.symbol, from);
      }
      for (const r of rows) await upsertPrice(a.id, r.date, r.close);
      results.push({ symbol: a.symbol, ok: true, rows: rows.length });
    } catch (e) {
      results.push({ symbol: a.symbol, ok: false, error: (e as Error).message });
    }
  }
  return results;
}
