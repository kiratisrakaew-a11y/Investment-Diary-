import { chooseBenchmarkBasis } from "@/lib/finance/benchmark-basis";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { priceInput, today, type PriceInputT } from "@/lib/validation";
import type { FxHistory, PriceHistory } from "@/lib/finance/portfolio";
import { getAssetBySymbol } from "./assets";

export async function upsertPrice(
  assetId: number,
  date: string,
  close: number,
) {
  await getDb()
    .insert(schema.prices)
    .values({ assetId, date, close })
    .onConflictDoUpdate({
      target: [schema.prices.assetId, schema.prices.date],
      set: { close },
    });
}

export async function upsertFx(date: string, rate: number, pair = "USDTHB") {
  await getDb()
    .insert(schema.fxRates)
    .values({ pair, date, rate })
    .onConflictDoUpdate({
      target: [schema.fxRates.pair, schema.fxRates.date],
      set: { rate },
    });
}

export async function upsertBenchmark(
  symbol: string,
  date: string,
  close: number,
) {
  await getDb()
    .insert(schema.benchmarkPrices)
    .values({ symbol, date, close })
    .onConflictDoUpdate({
      target: [schema.benchmarkPrices.symbol, schema.benchmarkPrices.date],
      set: { close },
    });
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
    .select({
      assetId: schema.prices.assetId,
      date: schema.prices.date,
      adj: schema.prices.adjClose,
    })
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
    .select({
      assetId: schema.prices.assetId,
      date: schema.prices.date,
      close: schema.prices.close,
    })
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

export async function loadBenchmark(
  symbol: string,
  from?: string,
): Promise<[string, number][]> {
  const b = schema.benchmarkPrices;
  const rows = await getDb()
    .select({ date: b.date, close: b.close })
    .from(b)
    .where(
      from
        ? and(eq(b.symbol, symbol), gte(b.date, from))
        : eq(b.symbol, symbol),
    )
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

/**
 * Benchmark whose return basis matches the portfolio (see lib/finance/benchmark-basis.ts): Settings'
 * benchmark (its own kind), the SET TRI series when imported, and ^SET.BK as the price index fallback.
 */
export async function benchmarkForBasis(
  wanted: "price" | "total_return",
  from: string,
  settings: {
    benchmarkSymbol: string;
    benchmarkKind: "price_index" | "total_return";
  },
) {
  const own =
    settings.benchmarkKind === "total_return" ? "total_return" : "price";
  const seen = new Set<string>();
  const cands: { symbol: string; basis: "price" | "total_return" }[] = [
    { symbol: settings.benchmarkSymbol, basis: own },
    { symbol: "SETTRI", basis: "total_return" },
    { symbol: "^SET.BK", basis: "price" },
  ].filter((c) => !seen.has(c.symbol) && seen.add(c.symbol)) as {
    symbol: string;
    basis: "price" | "total_return";
  }[];
  const loaded = await Promise.all(
    cands.map(async (c) => ({
      ...c,
      series: await loadBenchmark(c.symbol, from),
    })),
  );
  // Settings' own benchmark first among equals (the user's choice wins when its basis matches).
  return chooseBenchmarkBasis(wanted, loaded, from);
}

/**
 * Dividend ex-dates by symbol (cash events, not the indicated annual figure) and recorded split dates by
 * asset id — what decides whether a close can stand for a total return (lib/finance/total-return-policy.ts).
 */
export async function loadCorporateActionDates() {
  const db = getDb();
  const D = schema.dividendEvents;
  const T = schema.transactions;
  const [divs, splits] = await Promise.all([
    db.select({ symbol: D.symbol, exDate: D.exDate, kind: D.kind }).from(D),
    db
      .select({ assetId: T.assetId, date: T.date })
      .from(T)
      .where(eq(T.type, "split")),
  ]);
  const dividendDates = new Map<string, string[]>();
  for (const d of divs) {
    if (!d.exDate || d.kind === "indicated_annual") continue;
    const k = d.symbol.toUpperCase();
    dividendDates.set(k, [...(dividendDates.get(k) ?? []), d.exDate]);
  }
  const splitDates = new Map<number, string[]>();
  for (const s of splits)
    if (s.assetId != null)
      splitDates.set(s.assetId, [...(splitDates.get(s.assetId) ?? []), s.date]);
  return {
    for: (a: { id: number; symbol: string }) => ({
      dividendDates: dividendDates.get(a.symbol.toUpperCase()) ?? [],
      splitDates: splitDates.get(a.id) ?? [],
    }),
  };
}

/**
 * Close + adj_close (window from `from`), recorded cash dividends (ex-date, DPS) and split dates for the
 * given assets — the input of the adj_close checks (lib/finance/adj-check.ts). Read-only.
 */
export async function loadAdjCheckInput(
  assets: { id: number; symbol: string; assetClass: string }[],
  from: string,
) {
  if (!assets.length) return [];
  const db = getDb();
  const P = schema.prices;
  const D = schema.dividendEvents;
  const T = schema.transactions;
  const ids = assets.map((a) => a.id);
  const [px, divs, splits] = await Promise.all([
    db
      .select({
        assetId: P.assetId,
        date: P.date,
        close: P.close,
        adj: P.adjClose,
      })
      .from(P)
      .where(and(inArray(P.assetId, ids), gte(P.date, from)))
      .orderBy(asc(P.assetId), asc(P.date)),
    db
      .select({
        symbol: D.symbol,
        exDate: D.exDate,
        dps: D.dividendPerShare,
        kind: D.kind,
        cashOrStock: D.cashOrStock,
      })
      .from(D),
    db
      .select({ assetId: T.assetId, date: T.date })
      .from(T)
      .where(eq(T.type, "split")),
  ]);
  return assets.map((a) => ({
    symbol: a.symbol,
    assetClass: a.assetClass,
    obs: px
      .filter((r) => r.assetId === a.id)
      .map((r) => ({ date: r.date, close: r.close, adjClose: r.adj })),
    dividends: divs
      .filter(
        (d) =>
          d.symbol.toUpperCase() === a.symbol.toUpperCase() &&
          d.exDate &&
          d.kind !== "indicated_annual" &&
          d.cashOrStock !== "stock",
      )
      .map((d) => ({ exDate: d.exDate!, dps: d.dps })),
    splitDates: splits.filter((s) => s.assetId === a.id).map((s) => s.date),
  }));
}
