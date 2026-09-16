import "dotenv/config";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/index.js";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const migration = await readFile(new URL("../drizzle/0000_sessions.sql", import.meta.url), "utf8");
  const db = getDb();
  await db.execute(sql.raw(migration));
  await closeDb();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  try { await closeDb(); } catch { /* preserve the migration failure */ }
  process.exitCode = 1;
});
