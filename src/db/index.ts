import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type DB = PostgresJsDatabase<typeof schema>;
const globalForDb = globalThis as unknown as { db?: DB };

/** Lazily created so that `next build` does not need DATABASE_URL. */
export function getDb(): DB {
  if (!globalForDb.db) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    // `prepare: false` keeps this compatible with poolers such as Neon / PgBouncer.
    const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 5 });
    globalForDb.db = drizzle({ client, schema });
  }
  return globalForDb.db;
}

export { schema };
