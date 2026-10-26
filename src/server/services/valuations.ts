import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { evaluate, valuationInput, type ValuationInput } from "@/lib/valuation-schemas";
import { today } from "@/lib/validation";
import { getAssetBySymbol } from "./assets";

export async function listValuations(opts: { symbol?: string; limit?: number } = {}) {
  const v = schema.valuations;
  return getDb()
    .select()
    .from(v)
    .where(opts.symbol ? eq(v.symbol, opts.symbol.toUpperCase()) : undefined)
    .orderBy(desc(v.date), desc(v.id))
    .limit(opts.limit ?? 200);
}

export async function getValuation(id: number) {
  const [row] = await getDb().select().from(schema.valuations).where(eq(schema.valuations.id, id));
  return row ?? null;
}

export interface SaveValuationInput {
  id?: number;
  symbol: string;
  title?: string;
  note?: string;
  date?: string;
  source?: "web" | "claude" | "chatgpt" | "api";
  valuation: ValuationInput;
}

/** Validate, evaluate and store a valuation (insert, or update when `id` is given). */
export async function saveValuation(input: SaveValuationInput) {
  const parsed = valuationInput.parse(input.valuation);
  const summary = evaluate(parsed);
  const symbol = input.symbol.trim().toUpperCase();
  const asset = await getAssetBySymbol(symbol);
  const values = {
    assetId: asset?.id ?? null,
    symbol,
    date: input.date ?? today(),
    method: parsed.method,
    title: input.title ?? "",
    assumptions: parsed.assumptions,
    result: { value: summary.value, price: summary.price, upside: summary.upside },
    intrinsicValue: summary.value,
    priceAtValuation: summary.price,
    note: input.note ?? "",
    source: input.source ?? "web",
  };
  const db = getDb();
  if (input.id) {
    const [row] = await db.update(schema.valuations).set(values).where(eq(schema.valuations.id, input.id)).returning();
    return { valuation: row, summary };
  }
  const [row] = await db.insert(schema.valuations).values(values).returning();
  return { valuation: row, summary };
}

export async function deleteValuation(id: number) {
  await getDb().delete(schema.valuations).where(eq(schema.valuations.id, id));
}

/** Latest saved valuation per symbol, for the holdings / dashboard views. */
export async function latestValuationBySymbol() {
  const rows = await listValuations({ limit: 1000 });
  const map = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (r.method !== "bond" && !map.has(r.symbol)) map.set(r.symbol, r);
  return map;
}
