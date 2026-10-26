import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { today, transactionInput, type TransactionInputT } from "@/lib/validation";
import { getAssetBySymbol, listAssets } from "./assets";
import { getSettings } from "./settings";
import { validateNewTransaction } from "@/lib/finance/portfolio";
import { latestFx } from "./prices";

export async function listTransactions(opts: { assetId?: number; limit?: number } = {}) {
  const t = schema.transactions;
  return getDb()
    .select({
      tx: t,
      symbol: schema.assets.symbol,
      assetName: schema.assets.name,
      currency: schema.assets.currency,
    })
    .from(t)
    .leftJoin(schema.assets, eq(t.assetId, schema.assets.id))
    .where(opts.assetId ? eq(t.assetId, opts.assetId) : undefined)
    .orderBy(desc(t.date), desc(t.id))
    .limit(opts.limit ?? 500);
}

export async function allTransactions() {
  return getDb().select().from(schema.transactions);
}

export async function createTransaction(input: TransactionInputT) {
  const data = transactionInput.parse(input);
  let assetId: number | null = null;
  let fxRate = 1;
  if (data.symbol) {
    const asset = await getAssetBySymbol(data.symbol);
    if (!asset) throw new Error(`Unknown symbol "${data.symbol}". Add it first with add_asset.`);
    assetId = asset.id;
    if (asset.currency === "USD") {
      fxRate = data.fxRate ?? (await latestFx()) ?? NaN;
      if (!Number.isFinite(fxRate)) throw new Error("No USD/THB rate available — please pass fxRate");
    }
  }
  const date = data.date ?? today();
  // Ledger integrity: no oversell, valid numbers, and (strict policy) enough recorded cash.
  const [assets, existing, settings] = await Promise.all([listAssets(), allTransactions(), getSettings()]);
  validateNewTransaction(
    assets.map((a) => ({ id: a.id, symbol: a.symbol, name: a.name, assetClass: a.assetClass, currency: a.currency })),
    existing.map((t) => ({ id: t.id, date: t.date, assetId: t.assetId, type: t.type, quantity: t.quantity, price: t.price, fee: t.fee, fxRate: t.fxRate })),
    { date, assetId, type: data.type, quantity: data.quantity, price: data.price, fee: data.fee, fxRate },
    settings.cashFlowPolicy,
  );
  const [row] = await getDb()
    .insert(schema.transactions)
    .values({
      date,
      assetId,
      type: data.type,
      quantity: data.quantity,
      price: data.price,
      fee: data.fee,
      fxRate,
      noteId: data.noteId ?? null,
      memo: data.memo ?? null,
      source: data.source ?? "web",
    })
    .returning();
  return row;
}

export async function deleteTransaction(id: number) {
  await getDb().delete(schema.transactions).where(eq(schema.transactions.id, id));
}

export async function transactionsForNote(noteId: number) {
  return getDb()
    .select({ tx: schema.transactions, symbol: schema.assets.symbol })
    .from(schema.transactions)
    .leftJoin(schema.assets, eq(schema.transactions.assetId, schema.assets.id))
    .where(eq(schema.transactions.noteId, noteId));
}
