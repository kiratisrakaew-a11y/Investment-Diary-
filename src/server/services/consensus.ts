/**
 * Analyst consensus target prices: latest found per symbol, history, Yahoo refresh (button only) and
 * manual / AI entries with a cited source. Shared by the valuation pages, REST and MCP.
 * Errors use the typed MetricError so REST status codes and MCP "[CODE]" texts come for free.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { consensusInput, consensusView, pickLatest, type ConsensusFigures, type ConsensusInput } from "@/lib/consensus";
import { fetchAnalystConsensus } from "@/lib/prices/yahoo";
import { today } from "@/lib/validation";
import { MetricError } from "./asset-metrics";
import { getAssetBySymbol, yahooSymbolFor } from "./assets";

const C = schema.analystConsensus;
export type ConsensusRow = typeof C.$inferSelect;
type Source = "yahoo" | "manual" | "mcp";

const norm = (s: string) => s.trim().toUpperCase();

/** Every stored row for these symbols, newest first. */
async function rowsFor(symbols: string[]) {
  const S = [...new Set(symbols.map(norm))].filter(Boolean);
  if (!S.length) return [];
  return getDb()
    .select()
    .from(C)
    .where(sql`upper(${C.symbol}) in ${S}`)
    .orderBy(desc(C.asOf), desc(C.createdAt));
}

/** Latest consensus found per symbol (any source). Symbols without data are absent from the map. */
export async function latestConsensusFor(symbols: string[]): Promise<Map<string, ConsensusRow>> {
  const by = new Map<string, ConsensusRow[]>();
  for (const r of await rowsFor(symbols)) by.set(norm(r.symbol), [...(by.get(norm(r.symbol)) ?? []), r]);
  return new Map([...by].map(([k, rows]) => [k, pickLatest(rows)!]));
}

export async function consensusHistory(symbol: string, limit = 20) {
  return (await rowsFor([symbol])).slice(0, limit);
}

/** Last stored close and the asset's currency (for upside); null when the symbol is not an asset or has no price. */
async function priceOf(symbol: string) {
  const asset = await getAssetBySymbol(symbol);
  if (!asset) return { price: null, priceDate: null, currency: null };
  const [p] = await getDb().select({ date: schema.prices.date, close: schema.prices.close }).from(schema.prices).where(eq(schema.prices.assetId, asset.id)).orderBy(desc(schema.prices.date)).limit(1);
  return { price: p?.close ?? null, priceDate: p?.date ?? null, currency: asset.currency };
}

/** Latest row with headline numbers (target, upside vs last stored close, age, caveats). */
export async function consensusSummary(symbol: string, opts: { history?: boolean } = {}) {
  const S = norm(symbol);
  const [latest, px, history] = await Promise.all([latestConsensusFor([S]).then((m) => m.get(S) ?? null), priceOf(S), opts.history ? consensusHistory(S) : Promise.resolve(null)]);
  return {
    symbol: S,
    latest,
    view: latest ? consensusView(latest, { price: px.price, priceCurrency: px.currency, today: today() }) : null,
    price: px.price,
    priceDate: px.priceDate,
    ...(history ? { history } : {}),
    note: "ความเห็นของนักวิเคราะห์ ไม่ใช่การประเมินมูลค่าของผู้ใช้ — ไม่ถูกนำไปเฉลี่ยกับ valuation ในแอป",
  };
}

async function upsert(symbol: string, source: Source, asOf: string, f: ConsensusFigures, extra: { sourceNote?: string | null; yahooSymbol?: string | null; note?: string | null }) {
  const values = { symbol: norm(symbol), source, asOf, ...f, sourceNote: extra.sourceNote ?? null, yahooSymbol: extra.yahooSymbol ?? null, note: extra.note ?? null };
  const [row] = await getDb()
    .insert(C)
    .values(values)
    .onConflictDoUpdate({ target: [C.symbol, C.source, C.asOf], set: { ...values, createdAt: new Date() } })
    .returning();
  return row;
}

export interface RefreshDeps {
  yahooSymbol: (symbol: string) => Promise<string>;
  fetch: typeof fetchAnalystConsensus;
  today: () => string;
}
const defaultDeps: RefreshDeps = { yahooSymbol: yahooSymbolFor, fetch: fetchAnalystConsensus, today };

/**
 * Fetch from Yahoo now. Found → stored as today's Yahoo row (same-day re-fetch replaces it).
 * No coverage or a failed request → nothing is written; the latest consensus found earlier is returned.
 */
export async function refreshConsensusFromYahoo(symbol: string, deps: RefreshDeps = defaultDeps) {
  const S = norm(symbol);
  if (!S) throw new MetricError(400, "VALIDATION_ERROR", "ต้องระบุ symbol");
  const yahoo = await deps.yahooSymbol(S);
  let res: Awaited<ReturnType<RefreshDeps["fetch"]>>;
  try {
    res = await deps.fetch(yahoo);
  } catch (e) {
    const previous = (await latestConsensusFor([S])).get(S) ?? null;
    return { status: "FETCH_FAILED" as const, yahooSymbol: yahoo, message: `ดึงจาก Yahoo (${yahoo}) ไม่สำเร็จ: ${(e as Error).message}`, row: null, latest: previous };
  }
  if (!res.ok) {
    const previous = (await latestConsensusFor([S])).get(S) ?? null;
    return { status: res.code, yahooSymbol: yahoo, message: `${res.message} (${yahoo})${previous ? ` — ยังใช้ข้อมูลล่าสุดที่มี ณ ${previous.asOf}` : ""}`, row: null, latest: previous };
  }
  const row = await upsert(S, "yahoo", deps.today(), res.figures, { yahooSymbol: yahoo, sourceNote: "Yahoo Finance (financialData)" });
  return { status: "UPDATED" as const, yahooSymbol: yahoo, message: `อัปเดตจาก Yahoo (${yahoo}) แล้ว`, row, latest: row };
}

/** Manual (web) or AI entry with a cited source. Same (symbol, source, date) replaces the earlier entry. */
export async function recordConsensus(input: ConsensusInput, source: "manual" | "mcp") {
  const x = consensusInput.parse(input);
  if (x.asOf > today()) throw new MetricError(400, "VALIDATION_ERROR", `วันที่ ${x.asOf} อยู่ในอนาคต`);
  return upsert(
    x.symbol,
    source,
    x.asOf,
    {
      currency: x.currency ?? (await getAssetBySymbol(x.symbol))?.currency ?? null,
      targetMean: x.targetMean ?? null,
      targetMedian: x.targetMedian ?? null,
      targetHigh: x.targetHigh ?? null,
      targetLow: x.targetLow ?? null,
      analysts: x.analysts ?? null,
      recommendationKey: x.recommendationKey ?? null,
      recommendationMean: null,
      priceAtFetch: null,
    },
    { sourceNote: x.sourceNote, note: x.note },
  );
}

export async function deleteConsensus(id: number, symbol?: string) {
  const [row] = await getDb()
    .delete(C)
    .where(and(eq(C.id, id), symbol ? sql`upper(${C.symbol}) = ${norm(symbol)}` : undefined))
    .returning();
  if (!row) throw new MetricError(404, "CONSENSUS_NOT_FOUND", `ไม่พบรายการ consensus #${id}${symbol ? ` ของ ${norm(symbol)}` : ""}`);
  return { deleted: true, id: row.id, symbol: row.symbol, asOf: row.asOf, source: row.source };
}
