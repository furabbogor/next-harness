import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "@/lib/storage";
import type { Session } from "@/lib/types";

const dirs: string[] = [];
function fixture(): Session {
  const id = randomUUID();
  return {
    id, title: "Test", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    config: { provider: "demo", model: "demo", preset: "builder", systemPrompt: "", maxSteps: 4, maxTokens: 100, tools: ["list_files"] },
    messages: [], events: [], plan: [], usage: { inputTokens: 0, outputTokens: 0, estimated: true },
    run: { id: randomUUID(), status: "running", startedAt: "2026-01-01T00:00:00.000Z", step: 0, toolCount: 0, pendingCalls: [] },
  };
}
async function store() {
  const dir = await mkdtemp(join(tmpdir(), "harness-storage-")); dirs.push(dir);
  return FileSessionStore(dir);
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("FileSessionStore", () => {
  it("creates, reloads, lists, updates, and deletes sessions", async () => {
    const s = await store(); const session = fixture();
    await s.create(session);
    const reloaded = await FileSessionStore(dirs[0]);
    expect(await reloaded.get(session.id)).toEqual(session);
    await s.update(session.id, (draft) => { draft.title = "Updated"; draft.messages.push({ id: "m", role: "user", content: "hi", createdAt: draft.updatedAt }); });
    expect((await s.list())[0]).toMatchObject({ id: session.id, title: "Updated", messageCount: 1 });
    expect(await s.delete(session.id)).toBe(true);
    expect(await s.get(session.id)).toBeNull();
  });

  it("serializes concurrent changes and does not commit thrown mutations", async () => {
    const s = await store(); const session = fixture(); await s.create(session);
    await expect(s.update(session.id, (draft) => { draft.title = "discard"; throw new Error("stop"); })).rejects.toThrow("stop");
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.update(session.id, (draft) => { draft.title = `title-${i}`; })));
    expect((await s.get(session.id))?.title).toMatch(/^title-/);
    expect((await s.get(session.id))?.updatedAt).toBeTruthy();
  });

  it("rejects invalid ids and corrupt records", async () => {
    const s = await store();
    await expect(s.get("nope")).rejects.toMatchObject({ code: "INVALID_ID" });
    const dir = dirs[0];
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${randomUUID()}.json`), "not json");
    await expect(s.list()).rejects.toMatchObject({ code: "CORRUPT_SESSION" });
  });

  it("preserves unknown tool arguments", async () => {
    const s = await store(); const session = fixture();
    session.messages.push({ id: "m", role: "assistant", content: "", createdAt: session.createdAt, toolCalls: [{ id: "c", name: "x", args: { nested: [1, true, null] } }] });
    await s.create(session);
    expect((await s.get(session.id))?.messages[0].toolCalls?.[0].args).toEqual({ nested: [1, true, null] });
  });
});
