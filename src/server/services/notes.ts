import { and, arrayOverlaps, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { noteInput, today, type NoteInput } from "@/lib/validation";
import { resolveSymbols } from "./assets";

export interface NoteFilter {
  q?: string;
  type?: string;
  tag?: string;
  assetId?: number;
  source?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function listNotes(f: NoteFilter = {}) {
  const n = schema.notes;
  const conds = [
    f.q ? or(ilike(n.title, `%${f.q}%`), ilike(n.body, `%${f.q}%`)) : undefined,
    f.type ? eq(n.type, f.type as typeof n.type.enumValues[number]) : undefined,
    f.source ? eq(n.source, f.source as typeof n.source.enumValues[number]) : undefined,
    f.tag ? arrayOverlaps(n.tags, [f.tag]) : undefined,
    f.assetId ? sql`${f.assetId} = any(${n.assetIds})` : undefined,
    f.from ? gte(n.date, f.from) : undefined,
    f.to ? lte(n.date, f.to) : undefined,
  ].filter(Boolean);
  return getDb()
    .select()
    .from(n)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(n.date), desc(n.id))
    .limit(f.limit ?? 200);
}

export async function getNote(id: number) {
  const [row] = await getDb().select().from(schema.notes).where(eq(schema.notes.id, id));
  return row ?? null;
}

export async function createNote(input: NoteInput) {
  const data = noteInput.parse(input);
  const assetIds = await resolveSymbols(data.symbols);
  const [row] = await getDb()
    .insert(schema.notes)
    .values({
      date: data.date ?? today(),
      title: data.title,
      body: data.body,
      type: data.type,
      tags: data.tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
      assetIds,
      conviction: data.conviction ?? null,
      source: data.source ?? "web",
    })
    .returning();
  return row;
}

export async function updateNote(id: number, input: Partial<NoteInput>) {
  const data = noteInput.partial().parse(input);
  const { symbols, ...rest } = data;
  const [row] = await getDb()
    .update(schema.notes)
    .set({ ...rest, ...(symbols ? { assetIds: await resolveSymbols(symbols) } : {}) })
    .where(eq(schema.notes.id, id))
    .returning();
  return row;
}

export async function deleteNote(id: number) {
  await getDb().delete(schema.notes).where(eq(schema.notes.id, id));
}

export async function allTags(): Promise<string[]> {
  const rows = await getDb().execute<{ tag: string }>(
    sql`select distinct unnest(tags) as tag from notes order by tag`,
  );
  return rows.map((r) => r.tag);
}
