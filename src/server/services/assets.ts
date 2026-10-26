import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { assetInput, type AssetInputT } from "@/lib/validation";

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
  const data = assetInput.partial().parse(input);
  const [row] = await getDb().update(schema.assets).set(data).where(eq(schema.assets.id, id)).returning();
  return row;
}

export async function deleteAsset(id: number) {
  await getDb().delete(schema.assets).where(eq(schema.assets.id, id));
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
