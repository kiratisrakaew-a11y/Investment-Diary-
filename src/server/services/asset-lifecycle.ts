import { and, eq, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { decideLifecycle, type AssetDependencies, type LifecycleAction, type LifecycleDecision } from "@/lib/asset-lifecycle";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
const n = (r: { c: number }[]) => Number(r[0]?.c ?? 0);

/** Every record that references the asset by id (or by symbol where tables key on symbol). */
async function countDependencies(db: Tx | ReturnType<typeof getDb>, id: number, symbol: string): Promise<AssetDependencies> {
  const S = symbol.toUpperCase();
  const c = sql<number>`count(*)::int`;
  const [transactions, prices, valuations, financialStatements, statementUploads, dividendEvents, notes] = await Promise.all([
    db.select({ c }).from(schema.transactions).where(eq(schema.transactions.assetId, id)),
    db.select({ c }).from(schema.prices).where(eq(schema.prices.assetId, id)),
    db.select({ c }).from(schema.valuations).where(or(eq(schema.valuations.assetId, id), sql`upper(${schema.valuations.symbol}) = ${S}`)),
    db.select({ c }).from(schema.financialStatements).where(or(eq(schema.financialStatements.assetId, id), sql`upper(${schema.financialStatements.symbol}) = ${S}`)),
    db.select({ c }).from(schema.statementUploads).where(sql`upper(${schema.statementUploads.symbol}) = ${S}`),
    db.select({ c }).from(schema.dividendEvents).where(or(eq(schema.dividendEvents.assetId, id), sql`upper(${schema.dividendEvents.symbol}) = ${S}`)),
    db.select({ c }).from(schema.notes).where(sql`${id} = any(${schema.notes.assetIds})`),
  ]);
  return { transactions: n(transactions), prices: n(prices), valuations: n(valuations), financialStatements: n(financialStatements), statementUploads: n(statementUploads), dividendEvents: n(dividendEvents), notes: n(notes) };
}

/** Units held from the ledger (signed sum of buy/sell/split effects is in the portfolio service; here: quantity from transactions). */
async function heldQuantity(id: number): Promise<number> {
  const { getPortfolioSummary } = await import("./portfolio");
  const s = await getPortfolioSummary();
  return s.positions.find((p) => p.assetId === id)?.quantity ?? 0;
}

export async function assetDependencies(id: number) {
  const [a] = await getDb().select().from(schema.assets).where(eq(schema.assets.id, id));
  if (!a) return null;
  return countDependencies(getDb(), id, a.symbol);
}

/**
 * Apply a lifecycle action by immutable id inside one transaction (row locked), with typed result and an
 * audit event. Hide / archive are idempotent; delete never cascades and requires the typed symbol.
 */
export async function changeAssetLifecycle(input: { assetId: number; action: LifecycleAction; confirmSymbol?: string; source?: string }): Promise<LifecycleDecision & { assetId: number; symbol: string | null }> {
  const qty = await heldQuantity(input.assetId);
  return getDb().transaction(async (tx) => {
    const [a] = await tx.select().from(schema.assets).where(eq(schema.assets.id, input.assetId)).for("update");
    if (!a) return { ...decideLifecycle(input.action, { exists: false, symbol: "", hiddenAt: null, archivedAt: null, heldQuantity: 0, dependencies: emptyDeps() }), assetId: input.assetId, symbol: null };
    const deps = input.action === "delete" ? await countDependencies(tx, a.id, a.symbol) : emptyDeps();
    const d = decideLifecycle(input.action, { exists: true, symbol: a.symbol, hiddenAt: a.hiddenInHoldingsAt, archivedAt: a.archivedAt, heldQuantity: qty, dependencies: deps }, { confirmSymbol: input.confirmSymbol });
    if (d.change?.delete) await tx.delete(schema.assets).where(and(eq(schema.assets.id, a.id)));
    else if (d.change) await tx.update(schema.assets).set(d.change).where(eq(schema.assets.id, a.id));
    await tx.insert(schema.assetLifecycleEvents).values({
      assetId: a.id,
      symbol: a.symbol,
      action: input.action,
      result: d.unchanged ? `${d.status}_UNCHANGED` : d.status,
      source: input.source ?? "web",
      detail: d.dependencies ? { dependencies: d.dependencies } : null,
    });
    return { ...d, assetId: a.id, symbol: a.symbol };
  });
}

function emptyDeps(): AssetDependencies {
  return { transactions: 0, prices: 0, valuations: 0, financialStatements: 0, statementUploads: 0, dividendEvents: 0, notes: 0 };
}

/** Dependency counts for many assets at once (holdings chips: show why delete is unavailable). */
export async function dependencyCounts(ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  const assets = await getDb().select({ id: schema.assets.id, symbol: schema.assets.symbol }).from(schema.assets);
  await Promise.all(
    assets
      .filter((a) => ids.includes(a.id))
      .map(async (a) => {
        const d = await countDependencies(getDb(), a.id, a.symbol);
        out.set(a.id, Object.values(d).reduce((x, y) => x + y, 0));
      }),
  );
  return out;
}
