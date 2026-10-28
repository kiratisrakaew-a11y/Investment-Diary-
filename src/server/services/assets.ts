import { and, asc, eq, ne, or, sql } from "drizzle-orm";
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

export interface AssetBasicsInput {
  symbol: string;
  name: string;
  assetClass: AssetInputT["assetClass"];
  currency: "THB" | "USD";
  priceSource: "yahoo" | "sec_th" | "manual";
  /** Empty / null clears it. */
  providerSymbol?: string | null;
  /** Needed to change class or currency once transactions or prices exist (stored values are not converted). */
  confirmChange?: boolean;
}

/**
 * Correct an asset's identity fields (e.g. a mistyped symbol AP → AP.BK). The id never changes, so
 * transactions, prices, metrics and notes stay attached; tables that also key on the symbol text
 * (valuations, financial statements, dividend events, statement uploads) follow the new symbol.
 * One transaction; the change is audited in asset_lifecycle_events.
 */
export async function editAssetBasics(id: number, input: AssetBasicsInput, source = "web") {
  const x = assetInput
    .pick({ symbol: true, name: true, assetClass: true, currency: true, priceSource: true })
    .parse({ ...input, symbol: input.symbol.trim().toUpperCase(), name: input.name.trim() });
  const providerSymbol = input.providerSymbol?.trim() ? input.providerSymbol.trim() : null;
  return getDb().transaction(async (tx) => {
    const [a] = await tx.select().from(schema.assets).where(eq(schema.assets.id, id)).for("update");
    if (!a) throw new Error("ไม่พบสินทรัพย์นี้");
    const old = a.symbol.toUpperCase();
    const renamed = x.symbol !== a.symbol;
    if (renamed) {
      const [clash] = await tx.select({ id: schema.assets.id }).from(schema.assets).where(and(sql`upper(${schema.assets.symbol}) = ${x.symbol}`, ne(schema.assets.id, id)));
      if (clash) throw new Error(`มีสินทรัพย์ symbol ${x.symbol} อยู่แล้ว — ใช้ symbol อื่น หรือลบ/รวมตัวเดิมก่อน`);
      const FS = schema.financialStatements;
      const [{ c }] = await tx.select({ c: sql<number>`count(*)::int` }).from(FS).where(and(sql`upper(${FS.symbol}) = ${x.symbol}`, or(sql`${FS.assetId} is null`, ne(FS.assetId, id))));
      if (c > 0) throw new Error(`มีงบการเงินของ ${x.symbol} อยู่แล้ว ${c} ปี (ไม่ได้ผูกกับสินทรัพย์นี้) — ระบบไม่รวมงบให้อัตโนมัติ`);
    }
    if ((x.assetClass !== a.assetClass || x.currency !== a.currency) && !input.confirmChange) {
      const [{ t }] = await tx.select({ t: sql<number>`count(*)::int` }).from(schema.transactions).where(eq(schema.transactions.assetId, id));
      const [{ p }] = await tx.select({ p: sql<number>`count(*)::int` }).from(schema.prices).where(eq(schema.prices.assetId, id));
      if (t + p > 0) throw new Error(`มีรายการซื้อขาย ${t} และราคา ${p} รายการแล้ว — เปลี่ยนประเภท/สกุลเงินจะไม่แปลงค่าเดิม ติ๊กยืนยันถ้าต้องการเปลี่ยนจริง`);
    }
    const [row] = await tx
      .update(schema.assets)
      .set({ symbol: x.symbol, name: x.name, assetClass: x.assetClass, currency: x.currency, priceSource: x.priceSource, providerSymbol })
      .where(eq(schema.assets.id, id))
      .returning();
    if (renamed) {
      const follow = <T extends typeof schema.valuations | typeof schema.financialStatements | typeof schema.dividendEvents>(t: T) =>
        tx.update(t).set({ symbol: x.symbol } as never).where(or(eq(t.assetId, id), sql`upper(${t.symbol}) = ${old}`));
      await follow(schema.valuations);
      await follow(schema.financialStatements);
      await follow(schema.dividendEvents);
      await tx.update(schema.statementUploads).set({ symbol: x.symbol }).where(sql`upper(${schema.statementUploads.symbol}) = ${old}`);
    }
    const pick = (r: typeof a) => ({ symbol: r.symbol, name: r.name, assetClass: r.assetClass, currency: r.currency, priceSource: r.priceSource, providerSymbol: r.providerSymbol });
    await tx.insert(schema.assetLifecycleEvents).values({ assetId: id, symbol: row.symbol, action: "edit", result: "UPDATED", source, detail: { before: pick(a), after: pick(row) } });
    return row;
  });
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
