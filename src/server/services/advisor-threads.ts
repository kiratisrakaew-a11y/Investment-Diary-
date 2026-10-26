import { desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { askAdvisor, type ChatTurn } from "../advisor";

export async function listThreads() {
  return getDb()
    .select({ id: schema.advisorThreads.id, title: schema.advisorThreads.title, updatedAt: schema.advisorThreads.updatedAt })
    .from(schema.advisorThreads)
    .orderBy(desc(schema.advisorThreads.updatedAt))
    .limit(50);
}

export async function getThread(id: number) {
  const [row] = await getDb().select().from(schema.advisorThreads).where(eq(schema.advisorThreads.id, id));
  return row ?? null;
}

export async function deleteThread(id: number) {
  await getDb().delete(schema.advisorThreads).where(eq(schema.advisorThreads.id, id));
}

/** Append a user message to a thread (creating it if needed), ask the advisor, store the reply. */
export async function sendToAdvisor(threadId: number | null, message: string) {
  const db = getDb();
  const existing = threadId ? await getThread(threadId) : null;
  const history: ChatTurn[] = [...(existing?.messages ?? []), { role: "user", content: message }];
  const { reply, toolsUsed } = await askAdvisor(history);
  const messages: ChatTurn[] = [...history, { role: "assistant", content: reply }];
  let id = existing?.id;
  if (id) {
    await db.update(schema.advisorThreads).set({ messages, updatedAt: sql`now()` }).where(eq(schema.advisorThreads.id, id));
  } else {
    const [row] = await db
      .insert(schema.advisorThreads)
      .values({ title: message.slice(0, 80), messages })
      .returning({ id: schema.advisorThreads.id });
    id = row.id;
  }
  return { threadId: id, reply, toolsUsed };
}
