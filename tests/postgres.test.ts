import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { closeDb, getDb } from "@/db";
import { PostgresSessionStore } from "@/lib/storage";
import type { Session } from "@/lib/types";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);

function fixture(): Session {
  const id = randomUUID();
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    title: "PostgreSQL integration",
    createdAt: now,
    updatedAt: now,
    config: { provider: "demo", model: "demo", preset: "builder", systemPrompt: "", maxSteps: 4, maxTokens: 100, tools: ["list_files"] },
    messages: [{ id: "m-1", role: "user", content: "goal", createdAt: now }],
    events: [],
    plan: [],
    todos: [{ id: "todo-1", text: "verify persistence", status: "pending" }],
    goal: { objective: "verify PostgreSQL", status: "active" },
    context: { throughMessageId: "m-1", summary: "prior context", createdAt: now, compactedMessages: 1 },
    usage: { inputTokens: 1, outputTokens: 2, estimated: true },
    run: {
      id: randomUUID(), status: "awaiting_approval", startedAt: now, step: 1, toolCount: 1, pendingCalls: [],
      approval: { id: "approval-1", call: { id: "call-1", name: "nested_tool", args: { nested: { ok: true } } }, expiresAt: "2026-01-01T01:00:00.000Z", parentCallId: "parent-call-1" },
    },
  };
}

const suite = describe.skipIf(!enabled);
suite("PostgreSQL session store (opt-in integration)", () => {
  let store: ReturnType<typeof PostgresSessionStore>;
  const schema = `harness_test_${randomUUID().replaceAll("-", "")}`;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let admin: Pool | undefined;
  let schemaCreated = false;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    await closeDb();
    process.env.DATABASE_URL = scopedUrl.href;
    // Exercise the production migration entrypoint twice, within only our schema.
    await execFileAsync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/migrate.ts"], { env: process.env });
    await execFileAsync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/migrate.ts"], { env: process.env });
    store = PostgresSessionStore(getDb());
    await store.health();
  });

  afterAll(async () => {
    try {
      await closeDb();
      if (schemaCreated) await admin?.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin?.end();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it("applies migrations idempotently and creates, reads, lists, updates, and deletes", async () => {
    const session = fixture();
    expect(await store.create(session)).toEqual(session);
    expect(await store.get(session.id)).toEqual(session);
    expect(await store.list()).toEqual([expect.objectContaining({ id: session.id, title: session.title, messageCount: 1 })]);
    const updated = await store.update(session.id, (draft) => { draft.title = "updated"; draft.messages.push({ id: "m-2", role: "assistant", content: "done", createdAt: draft.updatedAt }); });
    expect(updated.title).toBe("updated");
    expect((await store.get(session.id))?.messages).toHaveLength(2);
    expect(await store.delete(session.id)).toBe(true);
    expect(await store.get(session.id)).toBeNull();
    expect(await store.delete(session.id)).toBe(false);
  });

  it("rolls back a thrown mutation and serializes concurrent mutations without lost updates", async () => {
    const session = fixture();
    await store.create(session);
    // The transaction rolls back, but PostgresStore currently maps arbitrary callback
    // errors to STORAGE_ERROR (unlike FileStore); preserve that observed contract here.
    await expect(store.update(session.id, (draft) => { draft.title = "must rollback"; throw new Error("intentional mutation failure"); })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect((await store.get(session.id))?.title).toBe(session.title);

    await Promise.all(Array.from({ length: 12 }, (_, index) => store.update(session.id, (draft) => {
      draft.title += `|${index}`;
    })));
    const title = (await store.get(session.id))?.title ?? "";
    for (let index = 0; index < 12; index += 1) expect(title).toContain(`|${index}`);
    await store.delete(session.id);
  });

  it("round-trips version-2 context, todos, goal, and nested approval state", async () => {
    const session = fixture();
    await store.create(session);
    const loaded = await store.get(session.id);
    expect(loaded).toMatchObject({
      todos: [{ id: "todo-1", text: "verify persistence", status: "pending" }],
      goal: { objective: "verify PostgreSQL", status: "active" },
      context: { throughMessageId: "m-1", summary: "prior context", compactedMessages: 1 },
      run: { status: "awaiting_approval", approval: { parentCallId: "parent-call-1", call: { args: { nested: { ok: true } } } } },
    });
    await store.delete(session.id);
  });
});
