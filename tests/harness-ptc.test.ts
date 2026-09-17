import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessService } from "@/lib/harness";
import { FileSessionStore } from "@/lib/storage";
import { Workspace } from "@/lib/workspace";
import { createToolRegistry } from "@/lib/tools";
import { DEFAULT_CONFIG } from "@/lib/settings";
import { generateToolSdk, visibleTools } from "@/lib/ptc/sdk";
import type { AgentConfig, Session, WireEvent } from "@/lib/types";
import type { ProviderAdapter } from "@/lib/providers/types";
const fixtures: { root: string; service: HarnessService }[] = [];
async function setup(config: Partial<AgentConfig> = {}, options: { maxToolCalls?: number; approvalTtlMs?: number; runTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-ptc-"));
  const generate = vi.fn<ProviderAdapter["generate"]>(async () => ({ content: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, estimated: true } }));
  const registry = createToolRegistry();
  const store = FileSessionStore(join(root, "sessions"));
  const workspace = Workspace(join(root, "workspaces"));
  const service = new HarnessService({ store, workspace, tools: registry, providers: { demo: { generate }, deepseek: { generate } }, ...options });
  const session = await service.createSession({ ...structuredClone(DEFAULT_CONFIG), ...config });
  fixtures.push({ root, service });
  return { service, session, registry, store, workspace, generate };
}
async function execute(handle: Awaited<ReturnType<HarnessService["start"]>>) { const events: WireEvent[] = []; await handle.execute(event => events.push(event)); return events; }
function programResult(session: Session) { return JSON.parse(session.messages.findLast(message => message.toolName === "run_code")!.content); }
afterEach(async () => { for (const { root, service } of fixtures.splice(0)) { await service.close(); await rm(root, { recursive: true, force: true }); } });

describe("PTC application execution", () => {
  it("projects native/PTC/both tools and generates a visible-only SDK", async () => {
    const { registry, session } = await setup({ tools: ["list_files", "read_file"] });
    expect(visibleTools({ ...session.config, toolMode: "native" }, registry).map(tool => tool.name)).toEqual(["list_files", "read_file"]);
    expect(visibleTools({ ...session.config, toolMode: "ptc" }, registry).map(tool => tool.name)).toEqual(["run_code"]);
    expect(visibleTools(session.config, registry).map(tool => tool.name)).toEqual(["list_files", "read_file", "run_code"]);
    const sdk = generateToolSdk(registry.definitions(session.config.tools));
    expect(sdk).toContain('"read_file"(args: { "path": string; }');
    expect(sdk).not.toContain("write_file"); expect(sdk).not.toContain("run_code");
  });
  it("runs real TypeScript directly without invoking a provider", async () => {
    const { service, session, generate } = await setup();
    await execute(await service.startProgram(session.id, "const values: number[] = [1, 2, 3]; console.log('computed'); return values.map(x => x * 2);", "Compute values"));
    const saved = await service.getSession(session.id);
    expect(saved.run).toMatchObject({ status: "completed", step: 0, toolCount: 1 });
    expect(programResult(saved)).toMatchObject({ ok: true, result: { status: "completed", value: [2, 4, 6], logs: ["computed"], sandbox: { directHostAccess: false } } });
    expect(generate).not.toHaveBeenCalled();
  });
  it("continues one live program through two exact approvals without replaying earlier actions", async () => {
    const { service, session, workspace } = await setup();
    const code = "globalThis.starts = (globalThis.starts || 0) + 1; await tools.write_file({path:'first.txt',content:String(globalThis.starts)}); const first = await tools.read_file({path:'first.txt'}); await tools.write_file({path:'second.txt',content:first.content + '-' + globalThis.starts}); return {starts:globalThis.starts};";
    const firstEvents = await execute(await service.startProgram(session.id, code, "Two approved writes"));
    let saved = await service.getSession(session.id);
    expect(saved.run?.status).toBe("awaiting_approval");
    expect(firstEvents.at(-1)).toMatchObject({ type: "done", data: { status: "awaiting_approval" } });
    expect(saved.run?.approval?.call.args).toEqual({ path: "first.txt", content: "1" });
    expect(await workspace.list(session.id)).toEqual([]);
    const firstApproval = saved.run!.approval!.id;
    await execute(await service.resume(session.id, firstApproval, true));
    saved = await service.getSession(session.id);
    expect(saved.run?.approval?.call.args).toEqual({ path: "second.txt", content: "1-1" });
    expect((await workspace.list(session.id)).map(file => file.path)).toEqual(["first.txt"]);
    await expect(service.resume(session.id, firstApproval, true)).rejects.toMatchObject({ code: "APPROVAL_STALE" });
    await execute(await service.resume(session.id, saved.run!.approval!.id, true));
    saved = await service.getSession(session.id);
    expect(saved.run?.status).toBe("completed");
    expect(programResult(saved).result.value.starts).toBe(1);
    expect((await workspace.read(session.id, "second.txt")).content).toBe("1-1");
    expect(saved.events.filter(event => event.type === "tool.completed" && event.data.name === "write_file")).toHaveLength(2);
    expect(saved.events.filter(event => event.type === "ptc.started")).toHaveLength(1);
    expect(saved.messages.filter(message => message.role === "tool")).toHaveLength(1);
  });
  it("lets code handle a denied nested write without creating a file", async () => {
    const { service, session, workspace } = await setup();
    await execute(await service.startProgram(session.id, "try { await tools.write_file({path:'denied.txt',content:'no'}); } catch (error) { return {denied:error.code}; }", "Handle denial"));
    const pending = await service.getSession(session.id);
    await execute(await service.resume(session.id, pending.run!.approval!.id, false));
    const saved = await service.getSession(session.id);
    expect(saved.run?.status).toBe("completed");
    expect(programResult(saved).result.value).toEqual({ denied: "APPROVAL_DENIED" });
    expect(await workspace.list(session.id)).toEqual([]);
  });
  it("fails an unhandled denied write and records its error", async () => {
    const { service, session } = await setup();
    await execute(await service.startProgram(session.id, "await tools.write_file({path:'denied.txt',content:'no'});", "Denied write"));
    const pending = await service.getSession(session.id);
    await execute(await service.resume(session.id, pending.run!.approval!.id, false));
    const saved = await service.getSession(session.id);
    expect(saved.run?.status).toBe("failed"); expect(programResult(saved).ok).toBe(false);
  });
  it("rejects console execution in native-only mode", async () => {
    const { service, session } = await setup({ toolMode: "native" });
    await expect(service.startProgram(session.id, "return 1", "Disabled")).rejects.toMatchObject({ code: "PTC_DISABLED" });
    expect((await service.getSession(session.id)).run).toBeNull();
  });
  it("does not expose disabled bindings or recursive run_code", async () => {
    const { service, session } = await setup({ tools: ["list_files"], toolMode: "ptc" });
    await execute(await service.startProgram(session.id, "return {write: typeof tools.write_file, recursive: typeof tools.run_code};", "Check bindings"));
    expect(programResult(await service.getSession(session.id)).result.value).toEqual({ write: "undefined", recursive: "undefined" });
  });
  it("validates nested arguments before asking for approval", async () => {
    const { service, session, workspace } = await setup();
    await execute(await service.startProgram(session.id, "await tools.write_file({path:'../escape.txt',content:'no'});", "Reject traversal"));
    const saved = await service.getSession(session.id);
    expect(saved.run?.status).toBe("failed"); expect(saved.events.some(event => event.type === "approval.requested")).toBe(false);
    expect(await workspace.list(session.id)).toEqual([]);
  });
  it("shares the parent tool budget with PTC subcalls", async () => {
    const { service, session } = await setup({}, { maxToolCalls: 2 });
    await execute(await service.startProgram(session.id, "await tools.list_files({}); await tools.list_files({});", "Bound calls"));
    const saved = await service.getSession(session.id);
    expect(saved.run).toMatchObject({ status: "failed", toolCount: 2 });
  });
  it("cancels a live approval, terminates the program and never performs the pending action", async () => {
    const { service, session, workspace } = await setup();
    await execute(await service.startProgram(session.id, "await tools.write_file({path:'cancelled.txt',content:'no'});", "Cancel pending write"));
    const approval = (await service.getSession(session.id)).run!.approval!;
    const saved = await service.cancel(session.id);
    expect(saved.run?.status).toBe("cancelled"); expect(saved.run?.pendingCalls).toEqual([]);
    expect(await workspace.list(session.id)).toEqual([]);
    await expect(service.resume(session.id, approval.id, true)).rejects.toMatchObject({ code: "APPROVAL_STALE" });
  });
  it("consumes a nested approval exactly once under concurrent responses", async () => {
    const { service, session } = await setup();
    await execute(await service.startProgram(session.id, "await tools.write_file({path:'once.txt',content:'once'}); return 1;", "Approve once"));
    const approval = (await service.getSession(session.id)).run!.approval!;
    const attempts = await Promise.allSettled([service.resume(session.id, approval.id, true), service.resume(session.id, approval.id, true)]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const success = attempts.find(result => result.status === "fulfilled")!;
    if (success.status === "fulfilled") await execute(success.value);
    expect((await service.getSession(session.id)).events.filter(event => event.type === "tool.completed" && event.data.name === "write_file")).toHaveLength(1);
  });
  it("expires a live approval without replay or execution", async () => {
    const { service, session, workspace } = await setup({}, { approvalTtlMs: 25 });
    await execute(await service.startProgram(session.id, "await tools.write_file({path:'expired.txt',content:'no'});", "Expire approval"));
    await new Promise(resolve => setTimeout(resolve, 150));
    const saved = await service.getSession(session.id);
    expect(saved.run?.status).toBe("failed"); expect(saved.run?.approval).toBeUndefined(); expect(await workspace.list(session.id)).toEqual([]);
  });
  it("fails a persisted nested approval after process restart rather than restarting code", async () => {
    const { service, session, store, workspace } = await setup();
    const parentCallId = randomUUID();
    await store.update(session.id, draft => { draft.run = { id: randomUUID(), status: "awaiting_approval", startedAt: draft.createdAt, kind: "program", step: 0, toolCount: 2, pendingCalls: [{ id: parentCallId, name: "run_code", args: { code: "return 1", description: "Interrupted" } }], approval: { id: randomUUID(), parentCallId, expiresAt: new Date(Date.now() + 30000).toISOString(), call: { id: randomUUID(), name: "write_file", args: { path: "never.txt", content: "never" } } } }; });
    const recovered = await service.getSession(session.id);
    expect(recovered.run?.error?.code).toBe("INTERRUPTED"); expect(recovered.run?.pendingCalls).toEqual([]);
    expect(await workspace.list(session.id)).toEqual([]);
  });
  it("supports Promise.all while serializing host effects in submission order", async () => {
    const { service, session } = await setup();
    await execute(await service.startProgram(session.id, "const values = await Promise.all([tools.list_files({}), tools.search_files({query:'hello'})]); return values;", "Parallel bindings"));
    const saved = await service.getSession(session.id);
    expect(programResult(saved).result.value).toEqual([[], { matches: [], truncated: false }]);
    expect(saved.events.filter(event => event.type === "tool.called" && event.data.parentCallId).map(event => (event.data.call as { name: string }).name)).toEqual(["list_files", "search_files"]);
  });
});
