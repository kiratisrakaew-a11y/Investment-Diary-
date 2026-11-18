/**
 * Inputs for abnormal-trading analysis: shares outstanding (effective-dated) and company events.
 * XD dates come read-only from dividend_events; nothing is guessed when a value is missing.
 */
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { isoDate, today } from "@/lib/validation";
import { MetricError } from "./asset-metrics";
import { getAssetBySymbol } from "./assets";

/** Events and share counts belong to an existing asset (catches typos); stored under its symbol. */
async function assetSymbol(symbol: string) {
  const a = await getAssetBySymbol(symbol);
  if (!a)
    throw new MetricError(
      404,
      "ASSET_NOT_FOUND",
      `ไม่พบ ${symbol.trim()} ในรายการสินทรัพย์ — add_asset ก่อน`,
    );
  return norm(a.symbol);
}

const S = schema.sharesOutstanding;
const E = schema.stockEvents;
const norm = (s: string) => s.trim().toUpperCase();

export const EVENT_TYPES = ["earnings", "ma", "xd", "news", "other"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  earnings: "ประกาศงบ",
  ma: "M&A",
  xd: "XD",
  news: "ข่าว",
  other: "อื่น ๆ",
};

export const sharesOutstandingInput = z.object({
  symbol: z.string().trim().min(1).max(40),
  effectiveDate: isoDate.describe(
    "Date the share count took effect (YYYY-MM-DD)",
  ),
  shares: z
    .number()
    .positive()
    .finite()
    .describe("Total shares outstanding (number of shares, not millions)"),
  source: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "Where the figure comes from, e.g. SET company profile / annual report",
    ),
  note: z.string().trim().max(500).optional(),
});

export const eventInput = z.object({
  symbol: z.string().trim().min(1).max(40),
  eventDate: isoDate.describe("Date the event became public (YYYY-MM-DD)"),
  eventType: z.enum(EVENT_TYPES),
  description: z.string().trim().max(500).default(""),
  source: z.string().trim().max(200).optional(),
});

/** Same (symbol, effective date) replaces the earlier figure. */
export async function setSharesOutstanding(
  input: z.input<typeof sharesOutstandingInput>,
) {
  const x = sharesOutstandingInput.parse(input);
  if (x.effectiveDate > today())
    throw new MetricError(
      400,
      "VALIDATION_ERROR",
      `วันที่ ${x.effectiveDate} อยู่ในอนาคต`,
    );
  const values = {
    symbol: await assetSymbol(x.symbol),
    effectiveDate: x.effectiveDate,
    shares: x.shares,
    source: x.source,
    note: x.note ?? null,
  };
  const [row] = await getDb()
    .insert(S)
    .values(values)
    .onConflictDoUpdate({
      target: [S.symbol, S.effectiveDate],
      set: {
        shares: values.shares,
        source: values.source,
        note: values.note,
        createdAt: new Date(),
      },
    })
    .returning();
  return row;
}

/** Every share-count row of a symbol, oldest first. */
export async function sharesHistory(symbol: string) {
  return getDb()
    .select()
    .from(S)
    .where(eq(S.symbol, norm(symbol)))
    .orderBy(asc(S.effectiveDate));
}

/** Share count effective on a date (latest effective_date ≤ date), or null with the reason. */
export function sharesAsOfFrom(
  rows: { effectiveDate: string; shares: number; source: string }[],
  date: string,
):
  | { shares: number; effectiveDate: string; source: string }
  | { shares: null; reason: string } {
  let best: (typeof rows)[number] | null = null;
  for (const r of rows)
    if (
      r.effectiveDate <= date &&
      (!best || r.effectiveDate > best.effectiveDate)
    )
      best = r;
  if (best)
    return {
      shares: best.shares,
      effectiveDate: best.effectiveDate,
      source: best.source,
    };
  return {
    shares: null,
    reason: rows.length
      ? `ไม่มีจำนวนหุ้นที่มีผล ณ ${date} (ค่าแรกมีผล ${rows[0].effectiveDate})`
      : "ยังไม่ได้บันทึกจำนวนหุ้น (shares outstanding)",
  };
}

export async function sharesAsOf(symbol: string, date: string) {
  return sharesAsOfFrom(await sharesHistory(symbol), date);
}

export async function recordEvent(input: z.input<typeof eventInput>) {
  const x = eventInput.parse(input);
  const [row] = await getDb()
    .insert(E)
    .values({
      symbol: await assetSymbol(x.symbol),
      eventDate: x.eventDate,
      eventType: x.eventType,
      description: x.description,
      source: x.source ?? null,
    })
    .returning();
  return row;
}

export async function deleteEvent(id: number, symbol?: string) {
  const [row] = await getDb()
    .delete(E)
    .where(and(eq(E.id, id), symbol ? eq(E.symbol, norm(symbol)) : undefined))
    .returning();
  if (!row)
    throw new MetricError(
      404,
      "EVENT_NOT_FOUND",
      `ไม่พบ event #${id}${symbol ? ` ของ ${norm(symbol)}` : ""}`,
    );
  return { deleted: true, id: row.id };
}

export interface StockEventOut {
  id: number | null;
  symbol: string;
  eventDate: string;
  eventType: EventType;
  description: string;
  source: string | null;
  /** stock_events = recorded here; dividend_events = XD from dividend data (read-only). */
  origin: "stock_events" | "dividend_events";
}

/** Events of a symbol in a range, newest first; XD from dividend_events is included unless a recorded XD has the same date. */
export async function listEvents(q: {
  symbol: string;
  from?: string;
  to?: string;
  types?: EventType[];
}): Promise<StockEventOut[]> {
  const sym = norm(q.symbol);
  const db = getDb();
  const own = await db
    .select()
    .from(E)
    .where(
      and(
        eq(E.symbol, sym),
        q.from ? gte(E.eventDate, q.from) : undefined,
        q.to ? lte(E.eventDate, q.to) : undefined,
      ),
    )
    .orderBy(desc(E.eventDate));
  const D = schema.dividendEvents;
  const xd =
    !q.types || q.types.includes("xd")
      ? await db
          .select({
            exDate: D.exDate,
            dps: D.dividendPerShare,
            currency: D.currency,
            source: D.source,
            kind: D.kind,
          })
          .from(D)
          .where(
            and(
              sql`upper(${D.symbol}) = ${sym}`,
              sql`${D.exDate} is not null`,
              q.from ? gte(D.exDate, q.from) : undefined,
              q.to ? lte(D.exDate, q.to) : undefined,
            ),
          )
      : [];
  const ownXd = new Set(
    own.filter((e) => e.eventType === "xd").map((e) => e.eventDate),
  );
  const out: StockEventOut[] = [
    ...own.map((e) => ({
      id: e.id,
      symbol: e.symbol,
      eventDate: e.eventDate,
      eventType: e.eventType as EventType,
      description: e.description,
      source: e.source,
      origin: "stock_events" as const,
    })),
    ...[
      ...new Map(
        xd
          .filter(
            (d) =>
              d.exDate && !ownXd.has(d.exDate) && d.kind !== "indicated_annual",
          )
          .map((d) => [d.exDate!, d]),
      ).values(),
    ].map((d) => ({
      id: null,
      symbol: sym,
      eventDate: d.exDate!,
      eventType: "xd" as const,
      description: `ขึ้นเครื่องหมาย XD ปันผล ${d.dps} ${d.currency}`,
      source: d.source,
      origin: "dividend_events" as const,
    })),
  ];
  return out
    .filter((e) => !q.types || q.types.includes(e.eventType))
    .sort((a, b) => b.eventDate.localeCompare(a.eventDate));
}
