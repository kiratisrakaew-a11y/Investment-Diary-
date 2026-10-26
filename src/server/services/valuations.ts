import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { evaluate, evaluateMultiStageRi, multiStageRiToolInput, valuationInput, type MultiStageRiToolInput, type ValuationInput } from "@/lib/valuation-schemas";
import { today } from "@/lib/validation";
import { MODEL_VERSION } from "@/lib/governance";
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
  if (summary.value == null) {
    const errs = (summary.details.errors as { message: string }[] | undefined)?.map((e) => e.message);
    throw new Error(`บันทึกไม่ได้: คำนวณมูลค่าไม่ได้ — ${errs?.join("; ") || "ตรวจสอบว่าอัตราคิดลด > growth และข้อมูลครบ"}`);
  }
  const symbol = input.symbol.trim().toUpperCase();
  const asset = await getAssetBySymbol(symbol);
  const values = {
    assetId: asset?.id ?? null,
    symbol,
    date: input.date ?? today(),
    method: parsed.method,
    title: input.title ?? "",
    assumptions: parsed.assumptions,
    // Audit trail: formula version, save time and the warnings shown when it was saved.
    result: {
      value: summary.value,
      price: summary.price,
      upside: summary.upside,
      modelVersion: MODEL_VERSION,
      savedAt: new Date().toISOString(),
      warnings: (summary.details.sanityWarnings as string[] | undefined) ?? [],
    },
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

/** Multi-stage residual income from the flat tool input; saves it when `save` is true. */
export async function multiStageResidualIncome(input: MultiStageRiToolInput | unknown, source: SaveValuationInput["source"]) {
  const x = multiStageRiToolInput.parse(input);
  const r = evaluateMultiStageRi(x);
  if (!x.save) return r.result;
  if (!x.symbol) throw new Error("ต้องระบุ symbol เมื่อ save = true");
  const saved = await saveValuation({ symbol: x.symbol, title: x.title, note: x.note, valuation: r.valuation, source });
  return { ...r.result, saved: { id: saved.valuation.id, symbol: saved.valuation.symbol } };
}

export async function deleteValuation(id: number) {
  await getDb().delete(schema.valuations).where(eq(schema.valuations.id, id));
}

type Row = Awaited<ReturnType<typeof listValuations>>[number];

export interface StockValuationGroup {
  symbol: string;
  assetId: number | null;
  count: number;
  lastDate: string;
  /** Most recent valuation for each method (the "current view" of the stock). */
  latestByMethod: Row[];
  methods: string[];
  low: number | null;
  high: number | null;
  average: number | null;
  /** Median of the latest valuation per method — robust to one outlier method. */
  median: number | null;
  all: Row[];
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarize(symbol: string, rows: Row[]): StockValuationGroup {
  const latest = new Map<string, Row>();
  for (const r of rows) if (!latest.has(r.method)) latest.set(r.method, r); // rows are newest first
  const latestByMethod = [...latest.values()];
  const vals = latestByMethod.map((r) => r.intrinsicValue).filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  return {
    symbol,
    assetId: rows.find((r) => r.assetId != null)?.assetId ?? null,
    count: rows.length,
    lastDate: rows[0]?.date ?? "",
    latestByMethod,
    methods: latestByMethod.map((r) => r.method),
    low: vals.length ? Math.min(...vals) : null,
    high: vals.length ? Math.max(...vals) : null,
    average: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    median: vals.length ? median(vals) : null,
    all: rows,
  };
}

/** Saved stock valuations grouped by symbol (one entry per company), most recently valued first. */
export async function listValuationsGrouped(): Promise<StockValuationGroup[]> {
  const rows = (await listValuations({ limit: 2000 })).filter((r) => r.method !== "bond");
  const bySymbol = new Map<string, Row[]>();
  for (const r of rows) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);
  return [...bySymbol.entries()].map(([sym, rs]) => summarize(sym, rs)).sort((a, b) => b.lastDate.localeCompare(a.lastDate));
}

export async function valuationsForSymbol(symbol: string): Promise<StockValuationGroup | null> {
  const rows = (await listValuations({ symbol, limit: 500 })).filter((r) => r.method !== "bond");
  return rows.length ? summarize(symbol.toUpperCase(), rows) : null;
}

/** Per-symbol summary (average of the latest valuation per method), for the holdings view. */
export async function latestValuationBySymbol() {
  return new Map((await listValuationsGrouped()).map((g) => [g.symbol, g]));
}
