import { z } from "zod";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { planSplitPriceRepair } from "@/lib/finance/price-coverage";
import { validateNewTransaction } from "@/lib/finance/portfolio";
import { isoDate } from "@/lib/validation";
import { getAssetBySymbol, listAssets } from "./assets";
import { allTransactions, createTransaction } from "./transactions";
import { getSettings } from "./settings";

export const recordSplitInput = z.object({
  symbol: z.string(),
  date: isoDate.describe("Ex-date: the first day the stock trades on the new basis"),
  splitFrom: z.number().positive().describe("Old shares, e.g. 1 in a 1:2 split (10 in a 10:1 reverse split)"),
  splitTo: z.number().positive().describe("New shares, e.g. 2 in a 1:2 split (1 in a 10:1 reverse split)"),
  adjustPrices: z.boolean().default(true).describe("Also divide stored prices before the date by the ratio when they are still at the old level"),
  dryRun: z.boolean().default(false).describe("Preview only: nothing is recorded or changed"),
  memo: z.string().max(1000).optional(),
  source: z.enum(["web", "claude", "chatgpt", "api"]).optional(),
});

async function loadRows(assetId: number) {
  const p = schema.prices;
  return getDb().select({ date: p.date, close: p.close, adjClose: p.adjClose }).from(p).where(eq(p.assetId, assetId)).orderBy(p.date);
}

/** Preview or apply the price-history repair for a split (idempotent). Touches only this asset's price rows. */
export async function adjustPricesForSplit(input: { symbol: string; date: string; ratio: number; dryRun?: boolean }) {
  const asset = await getAssetBySymbol(input.symbol);
  if (!asset) throw new Error(`ไม่พบ ${input.symbol}`);
  const plan = planSplitPriceRepair(await loadRows(asset.id), input.date, input.ratio);
  let updated = 0;
  if (!input.dryRun && plan.status === "unadjusted" && plan.updates.length) {
    const p = schema.prices;
    const r = await getDb()
      .update(p)
      .set({ close: sql`${p.close} / ${input.ratio}`, adjClose: sql`${p.adjClose} / ${input.ratio}` })
      .where(and(eq(p.assetId, asset.id), lt(p.date, input.date)))
      .returning({ id: p.id });
    updated = r.length;
  }
  return {
    symbol: asset.symbol,
    status: plan.status,
    observedRatio: plan.observedRatio,
    before: plan.before,
    after: plan.after,
    rowsToAdjust: plan.updates.length,
    rowsAdjusted: updated,
    sample: plan.updates.slice(-3),
    message: plan.message,
    dryRun: !!input.dryRun,
  };
}

/** Record a split / reverse split as a corporate action and (optionally) repair stored prices. */
export async function recordSplit(input: z.input<typeof recordSplitInput>) {
  const x = recordSplitInput.parse(input);
  const ratio = x.splitTo / x.splitFrom;
  if (Math.abs(ratio - 1) < 1e-12) throw new Error("อัตราแตกพาร์ต้องไม่เท่ากับ 1:1");
  const asset = await getAssetBySymbol(x.symbol);
  if (!asset) throw new Error(`ไม่พบ ${x.symbol} ในรายการสินทรัพย์`);
  const [assets, txs, settings] = await Promise.all([listAssets(), allTransactions(), getSettings()]);
  const existing = txs.filter((t) => t.assetId === asset.id && t.type === "split" && t.date === x.date);
  if (existing.length) throw new Error(`บันทึกแตกพาร์ ${asset.symbol} วันที่ ${x.date} ไว้แล้ว (รายการ #${existing[0].id})`);
  // Same ledger checks as a real save (must hold shares on that date).
  validateNewTransaction(
    assets.map((a) => ({ id: a.id, symbol: a.symbol, name: a.name, assetClass: a.assetClass, currency: a.currency })),
    txs.map((t) => ({ id: t.id, date: t.date, assetId: t.assetId, type: t.type, quantity: t.quantity, price: t.price, fee: t.fee, fxRate: t.fxRate })),
    { date: x.date, assetId: asset.id, type: "split", quantity: ratio, price: 0, fee: 0, fxRate: 1 },
    settings.cashFlowPolicy,
  );
  const prices = x.adjustPrices ? await adjustPricesForSplit({ symbol: asset.symbol, date: x.date, ratio, dryRun: true }) : null;
  if (x.dryRun) return { dryRun: true, symbol: asset.symbol, date: x.date, ratio, label: `${x.splitFrom}:${x.splitTo}`, prices };
  const row = await createTransaction({ type: "split", symbol: asset.symbol, date: x.date, quantity: ratio, price: 0, fee: 0, splitFrom: x.splitFrom, splitTo: x.splitTo, memo: x.memo, source: x.source ?? "web" });
  const applied = x.adjustPrices ? await adjustPricesForSplit({ symbol: asset.symbol, date: x.date, ratio }) : null;
  return { dryRun: false, symbol: asset.symbol, date: x.date, ratio, label: `${x.splitFrom}:${x.splitTo}`, transactionId: row.id, prices: applied };
}
