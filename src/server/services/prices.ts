import { and, asc, desc, eq, gte } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { priceInput, today, type PriceInputT } from "@/lib/validation";
import type { FxHistory, PriceHistory } from "@/lib/finance/portfolio";
import { getAssetBySymbol } from "./assets";

export async function upsertPrice(assetId: number, date: string, close: number) {
  await getDb()
    .insert(schema.prices)
    .values({ assetId, date, close })
    .onConflictDoUpdate({ target: [schema.prices.assetId, schema.prices.date], set: { close } });
}

export async function upsertFx(date: string, rate: number, pair = "USDTHB") {
  await getDb()
    .insert(schema.fxRates)
    .values({ pair, date, rate })
    .onConflictDoUpdate({ target: [schema.fxRates.pair, schema.fxRates.date], set: { rate } });
}

export async function upsertBenchmark(symbol: string, date: string, close: number) {
  await getDb()
    .insert(schema.benchmarkPrices)
    .values({ symbol, date, close })
    .onConflictDoUpdate({ target: [schema.benchmarkPrices.symbol, schema.benchmarkPrices.date], set: { close } });
}

/** Manual / AI price update by symbol. */
export async function recordPrice(input: PriceInputT) {
  const data = priceInput.parse(input);
  const asset = await getAssetBySymbol(data.symbol);
  if (!asset) throw new Error(`Unknown symbol "${data.symbol}"`);
  const date = data.date ?? today();
  await upsertPrice(asset.id, date, data.close);
  return { symbol: asset.symbol, date, close: data.close };
}

/** Provider dividend-adjusted closes (adj_close) where stored; assets without them are absent or partial. */
export async function loadAdjPriceHistory(): Promise<PriceHistory> {
  const rows = await getDb()
    .select({ assetId: schema.prices.assetId, date: schema.prices.date, adj: schema.prices.adjClose })
    .from(schema.prices)
    .orderBy(asc(schema.prices.assetId), asc(schema.prices.date));
  const map: PriceHistory = new Map();
  for (const r of rows) {
    if (r.adj == null) continue;
    if (!map.has(r.assetId)) map.set(r.assetId, []);
    map.get(r.assetId)!.push([r.date, r.adj]);
  }
  return map;
}

export async function loadPriceHistory(): Promise<PriceHistory> {
  const rows = await getDb()
    .select({ assetId: schema.prices.assetId, date: schema.prices.date, close: schema.prices.close })
    .from(schema.prices)
    .orderBy(asc(schema.prices.assetId), asc(schema.prices.date));
  const map: PriceHistory = new Map();
  for (const r of rows) {
    if (!map.has(r.assetId)) map.set(r.assetId, []);
    map.get(r.assetId)!.push([r.date, r.close]);
  }
  return map;
}

export async function loadFxHistory(pair = "USDTHB"): Promise<FxHistory> {
  const rows = await getDb()
    .select({ date: schema.fxRates.date, rate: schema.fxRates.rate })
    .from(schema.fxRates)
    .where(eq(schema.fxRates.pair, pair))
    .orderBy(asc(schema.fxRates.date));
  return rows.map((r) => [r.date, r.rate]);
}

export async function latestFx(pair = "USDTHB"): Promise<number | null> {
  const [row] = await getDb()
    .select({ rate: schema.fxRates.rate })
    .from(schema.fxRates)
    .where(eq(schema.fxRates.pair, pair))
    .orderBy(desc(schema.fxRates.date))
    .limit(1);
  return row?.rate ?? null;
}

export async function loadBenchmark(symbol: string, from?: string): Promise<[string, number][]> {
  const b = schema.benchmarkPrices;
  const rows = await getDb()
    .select({ date: b.date, close: b.close })
    .from(b)
    .where(from ? and(eq(b.symbol, symbol), gte(b.date, from)) : eq(b.symbol, symbol))
    .orderBy(asc(b.date));
  return rows.map((r) => [r.date, r.close]);
}

export async function priceHistoryFor(assetId: number) {
  return getDb()
    .select({ date: schema.prices.date, close: schema.prices.close })
    .from(schema.prices)
    .where(eq(schema.prices.assetId, assetId))
    .orderBy(asc(schema.prices.date));
}
