import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { z } from "zod";
import { assetInput, assetProfileInput, type AssetInputT } from "@/lib/validation";

export async function listAssets() {
  return getDb().select().from(schema.assets).orderBy(asc(schema.assets.symbol));
}

export async function getAssetBySymbol(symbol: string) {
  const [row] = await getDb()
    .select()
    .from(schema.assets)
    .where(sql`upper(${schema.assets.symbol}) = upper(${symbol.trim()})`);
  return row ?? null;
}

export async function getAsset(id: number) {
  const [row] = await getDb().select().from(schema.assets).where(eq(schema.assets.id, id));
  return row ?? null;
}

export async function createAsset(input: AssetInputT) {
  const data = assetInput.parse(input);
  const existing = await getAssetBySymbol(data.symbol);
  if (existing) return existing;
  const [row] = await getDb()
    .insert(schema.assets)
    .values({ ...data, symbol: data.symbol.trim().toUpperCase() })
    .returning();
  return row;
}

export async function updateAsset(id: number, input: Partial<AssetInputT>) {
  const parsed = assetInput.partial().parse(input);
  // Only write fields the caller supplied — schema defaults (currency, price source) must not overwrite stored values.
  const data = Object.fromEntries(Object.entries(parsed).filter(([k, v]) => v !== undefined && (input as Record<string, unknown>)[k] !== undefined));
  if (!Object.keys(data).length) return getAsset(id);
  const [row] = await getDb().update(schema.assets).set(data).where(eq(schema.assets.id, id)).returning();
  return row;
}

/** Update issuer / sector / credit metadata only (never prices, transactions or valuations). */
export async function updateAssetProfile(input: z.input<typeof assetProfileInput>) {
  const x = assetProfileInput.parse(input);
  const asset = await getAssetBySymbol(x.symbol);
  if (!asset) throw new Error(`ไม่พบ ${x.symbol}`);
  const set = Object.fromEntries(Object.entries({ issuer: x.issuer, sector: x.sector, sectorSource: x.sectorSource, sectorAsOf: x.sectorAsOf, credit: x.credit, bondTerms: x.bondTerms }).filter(([, v]) => v !== undefined));
  if (!Object.keys(set).length) return asset;
  const [row] = await getDb().update(schema.assets).set(set).where(eq(schema.assets.id, asset.id)).returning();
  return row;
}

/** Resolve symbols to ids, throwing a readable error for unknown symbols. */
export async function resolveSymbols(symbols: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const s of symbols) {
    const a = await getAssetBySymbol(s);
    if (!a) throw new Error(`Unknown symbol "${s}". Add it first with add_asset.`);
    ids.push(a.id);
  }
  return ids;
}
