/**
 * Issuer dividend events (Strategies Phase 1): authoritative store, separate from the investor's
 * dividend receipts in `transactions`. Nothing here writes the ledger.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { isoDate } from "@/lib/validation";
import { fetchDailyHistory } from "@/lib/prices/yahoo";
import type { DividendEventInput, SplitInput } from "@/lib/finance/dividend-metrics";
import { getAssetBySymbol, listAssets } from "./assets";

export const dividendEventInput = z
  .object({
    symbol: z.string().min(1),
    exDate: isoDate.nullable().optional().describe("Ex-dividend date (XD). Leave empty when unknown — never inferred from the payment date"),
    paymentDate: isoDate.nullable().optional(),
    declarationDate: isoDate.nullable().optional().describe("Board approval / announcement date"),
    recordDate: isoDate.nullable().optional(),
    announcedAt: isoDate.nullable().optional().describe("First date the event was public (for point-in-time use); defaults to declarationDate"),
    dividendPerShare: z.number().positive().describe("Per share, in currency, on the share basis of the ex-date (as reported)"),
    currency: z.string().length(3).default("THB"),
    cashOrStock: z.enum(["cash", "stock"]).default("cash"),
    kind: z.enum(["regular", "special", "indicated_annual", "unknown"]).default("regular").describe("indicated_annual = declared annual rate (forward yield), not a payment"),
    fiscalPeriod: z.string().max(40).nullable().optional().describe("e.g. 'FY2025 final', 'H1/2025'"),
    source: z.string().min(1).max(200).describe("Where the data came from, e.g. 'SET announcement 2025-02-20' or a URL"),
    sourceEventId: z.string().max(200).optional().describe("Stable id within the source; default symbol:exDate:kind"),
    dataQualityStatus: z.enum(["verified", "provider", "unverified"]).default("unverified"),
    splitAdjustmentPolicy: z.enum(["as_reported", "provider_split_adjusted"]).default("as_reported"),
    withholdingTaxRate: z.number().min(0).max(1).nullable().optional().describe("Decimal, e.g. 0.10"),
    withholdingSource: z.string().max(200).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
  })
  .refine((v) => v.kind === "indicated_annual" || v.exDate || v.paymentDate || v.declarationDate, { message: "ต้องมีอย่างน้อยหนึ่งวันที่ (ex-date / วันจ่าย / วันประกาศ)", path: ["exDate"] });
export type DividendEventParams = z.input<typeof dividendEventInput>;

type Row = typeof schema.dividendEvents.$inferSelect;
const TRACKED = ["exDate", "paymentDate", "declarationDate", "recordDate", "announcedAt", "dividendPerShare", "currency", "cashOrStock", "kind", "fiscalPeriod", "dataQualityStatus", "splitAdjustmentPolicy", "withholdingTaxRate", "withholdingSource", "note"] as const;

/** Idempotent upsert by (source, sourceEventId); a changed event keeps its previous values in `revisions`. */
export async function upsertDividendEvents(input: DividendEventParams[]) {
  const db = getDb();
  const out = { inserted: 0, updated: 0, unchanged: 0, events: [] as Row[] };
  for (const raw of input) {
    const x = dividendEventInput.parse(raw);
    const sym = x.symbol.trim().toUpperCase();
    const asset = await getAssetBySymbol(sym);
    const sourceEventId = x.sourceEventId ?? `${sym}:${x.exDate ?? x.declarationDate ?? x.paymentDate ?? "na"}:${x.kind}`;
    const values = {
      symbol: sym,
      assetId: asset?.id ?? null,
      issuer: asset?.issuer ?? null,
      exDate: x.exDate ?? null,
      paymentDate: x.paymentDate ?? null,
      declarationDate: x.declarationDate ?? null,
      recordDate: x.recordDate ?? null,
      announcedAt: x.announcedAt ?? x.declarationDate ?? null,
      dividendPerShare: x.dividendPerShare,
      currency: x.currency.toUpperCase(),
      cashOrStock: x.cashOrStock,
      kind: x.kind,
      fiscalPeriod: x.fiscalPeriod ?? null,
      source: x.source,
      sourceEventId,
      dataQualityStatus: x.dataQualityStatus,
      splitAdjustmentPolicy: x.splitAdjustmentPolicy,
      withholdingTaxRate: x.withholdingTaxRate ?? null,
      withholdingSource: x.withholdingSource ?? null,
      note: x.note ?? null,
    };
    const [existing] = await db.select().from(schema.dividendEvents).where(and(eq(schema.dividendEvents.source, x.source), eq(schema.dividendEvents.sourceEventId, sourceEventId)));
    if (!existing) {
      const [row] = await db.insert(schema.dividendEvents).values(values).returning();
      out.inserted++;
      out.events.push(row);
      continue;
    }
    const changed = TRACKED.filter((k) => (existing[k] ?? null) !== (values[k] ?? null));
    if (!changed.length) {
      out.unchanged++;
      out.events.push(existing);
      continue;
    }
    const previous = Object.fromEntries(changed.map((k) => [k, existing[k]]));
    const [row] = await db
      .update(schema.dividendEvents)
      .set({ ...values, retrievedAt: new Date(), updatedAt: new Date(), revisions: [...existing.revisions, { at: new Date().toISOString(), values: previous }] })
      .where(eq(schema.dividendEvents.id, existing.id))
      .returning();
    out.updated++;
    out.events.push(row);
  }
  return out;
}

export async function listDividendEvents(symbols?: string[]): Promise<Row[]> {
  const db = getDb();
  const q = db.select().from(schema.dividendEvents);
  const rows = symbols?.length ? await q.where(inArray(schema.dividendEvents.symbol, symbols.map((s) => s.toUpperCase()))).orderBy(asc(schema.dividendEvents.exDate)) : await q.orderBy(asc(schema.dividendEvents.exDate));
  return rows;
}

export async function deleteDividendEvent(id: number) {
  const [row] = await getDb().delete(schema.dividendEvents).where(eq(schema.dividendEvents.id, id)).returning();
  if (!row) throw new Error(`ไม่พบเหตุการณ์ปันผล id ${id}`);
  return row;
}

/** Row → pure-metric input. */
export function toEventInput(r: Row): DividendEventInput {
  return {
    id: r.id,
    symbol: r.symbol,
    exDate: r.exDate,
    paymentDate: r.paymentDate,
    declarationDate: r.declarationDate,
    recordDate: r.recordDate,
    announcedAt: r.announcedAt,
    dividendPerShare: r.dividendPerShare,
    currency: r.currency,
    cashOrStock: r.cashOrStock === "stock" ? "stock" : "cash",
    kind: (["regular", "special", "indicated_annual"].includes(r.kind) ? r.kind : "unknown") as DividendEventInput["kind"],
    splitAdjustmentPolicy: r.splitAdjustmentPolicy === "provider_split_adjusted" ? "provider_split_adjusted" : "as_reported",
    withholdingTaxRate: r.withholdingTaxRate,
    source: r.source,
  };
}

/** Recorded splits (ledger `split` transactions) by symbol. */
export async function splitsBySymbol(): Promise<Record<string, SplitInput[]>> {
  const db = getDb();
  const rows = await db
    .select({ symbol: schema.assets.symbol, date: schema.transactions.date, ratio: schema.transactions.quantity })
    .from(schema.transactions)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.transactions.assetId))
    .where(eq(schema.transactions.type, "split"))
    .orderBy(asc(schema.transactions.date));
  const out: Record<string, SplitInput[]> = {};
  for (const r of rows) (out[r.symbol] ??= []).push({ date: r.date, ratio: r.ratio });
  return out;
}

/** Yahoo dividend events (ex-date + amount only, already on the latest share basis). */
export function yahooEvents(symbol: string, provider: string, currency: string, dividends: { date: string; amount: number }[]): DividendEventParams[] {
  return dividends
    .filter((d) => d.amount > 0)
    .map((d) => ({
      symbol,
      exDate: d.date,
      dividendPerShare: d.amount,
      currency,
      kind: "unknown" as const,
      source: "yahoo",
      sourceEventId: `${provider}:${d.date}`,
      dataQualityStatus: "provider" as const,
      splitAdjustmentPolicy: "provider_split_adjusted" as const,
      note: "Yahoo: มีแค่ ex-date และจำนวนต่อหุ้น (ไม่มีวันประกาศ/วันจ่าย/ประเภทปกติ-พิเศษ)",
    }));
}

export const importDividendsInput = z.object({
  symbols: z.array(z.string()).min(1).max(30).optional().describe("Default: every Yahoo-priced stock"),
  from: isoDate.default("2010-01-01"),
});

/** Store Yahoo dividend history for Yahoo-priced assets. Writes dividend events only (not prices, not the ledger). */
export async function importDividendsFromYahoo(input: z.input<typeof importDividendsInput> = {}) {
  const x = importDividendsInput.parse(input);
  const assets = (await listAssets()).filter((a) => a.priceSource === "yahoo" && ["thai_stock", "us_stock", "fund"].includes(a.assetClass));
  const want = x.symbols?.map((s) => s.toUpperCase());
  const today = new Date().toISOString().slice(0, 10);
  const results: { symbol: string; status: "ok" | "error"; events?: number; inserted?: number; updated?: number; message?: string }[] = [];
  for (const a of assets.filter((v) => !want || want.includes(v.symbol.toUpperCase()))) {
    const provider = a.providerSymbol || a.symbol;
    try {
      const h = await fetchDailyHistory(provider, { from: x.from, to: today });
      const r = await upsertDividendEvents(yahooEvents(a.symbol, provider, a.currency, h.dividends));
      results.push({ symbol: a.symbol, status: "ok", events: h.dividends.length, inserted: r.inserted, updated: r.updated });
    } catch (e) {
      results.push({ symbol: a.symbol, status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { results, note: "ข้อมูลจาก Yahoo ไม่มีวันประกาศ วันจ่าย และไม่แยกปันผลปกติ/พิเศษ — เพิ่มข้อมูลจากประกาศ SET ได้ด้วย record_dividend_event" };
}
