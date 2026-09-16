import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const globalForDb = globalThis as typeof globalThis & {
  __nextHarnessPostgresqlPool?: Pool;
};

/** Create the database connection lazily. Importing this module never touches the network. */
export function getDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const existing = globalForDb.__nextHarnessPostgresqlPool;
  const pool = existing ?? new Pool({ connectionString: databaseUrl });
  if (!existing) globalForDb.__nextHarnessPostgresqlPool = pool;
  return drizzle(pool);
}

/** Backwards-compatible lazy facade for starter code that imported `db`.
 * Accessing a method, rather than importing this module, initializes the pool. */
export const db = new Proxy({} as ReturnType<typeof getDb>, {
  get(_target, property, receiver) {
    return Reflect.get(getDb() as object, property, receiver);
  },
});

export async function closeDb(): Promise<void> {
  const pool = globalForDb.__nextHarnessPostgresqlPool;
  if (pool) {
    await pool.end();
    delete globalForDb.__nextHarnessPostgresqlPool;
  }
}
