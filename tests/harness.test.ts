import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessService } from "@/lib/harness";
import { FileSessionStore } from "@/lib/storage";
import { Workspace } from "@/lib/workspace";
import { createToolRegistry } from "@/lib/tools";
import { DEFAULT_CONFIG } from "@/lib/settings";
import { DemoProvider } from "@/lib/providers/demo";
import type { CompletionResult, ProviderAdapter } from "@/lib/providers/types";
import type { AgentConfig, ToolCall, WireEvent } from "@/lib/types";

const directories: string[] = [];
function completion(content = "done", toolCalls: ToolCall[] = []): CompletionResult {
  return { content, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage: { inputTokens: 2, outputTokens: 2, estimated: false } };
}
function adapter(generate: ProviderAdapter["generate"]): ProviderAdapter { return { generate }; }
function call(name: string, args: unknown, id = `call-${randomUUID()}`): ToolCall { return { id, name, args }; }

async function setup(provider: ProviderAdapter = new DemoProvider(0), config: AgentConfig = structuredClone(DEFAULT_CONFIG), options: { runTimeoutMs?: number; maxToolCalls?: number; approvalTtlMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "next-harness-harness-")); directories.push(root);
  const store = FileSessionStore(join(root, "sessions"));
  const workspace = Workspace(join(root, "workspaces"));
  const service = new HarnessService({ store, workspace, tools: createToolRegistry(), providers: { demo: provider, deepseek: provider }, ...options });
  const session = await service.createSession(config);
  return { root, store, workspace, service, session };
}
async function execute(handle: Awaited<ReturnType<HarnessService["start"]>>): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  await handle.execute((event) => events.push(event));
  return events;
}
async function current(service: HarnessService, id: string) { return service.store.get(id).then((value) => value!); }

afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("HarnessService execution protocol", () => {
  it("pauses the demo artifact before writing anything", async () => {
    const { service, workspace, session } = await setup(new DemoProvider(0));
    const handle = await service.start(session.id, "Draft a project plan");
    await execute(handle);
    const saved = await current(service, session.id);
    expect(saved.run?.status).toBe("awaiting_approval");
    expect(saved.run?.approval?.call.name).toBe("write_file");
    expect(await workspace.list(session.id)).toEqual([]);
  });

  it("executes an approved demo write once and persists the real artifact", async () => {
    const { service, workspace, session } = await setup(new DemoProvider(0));
    await execute(await service.start(session.id, "Draft a project plan"));
    const paused = await current(service, session.id);
    const approval = paused.run!.approval!;
    await execute(await service.resume(session.id, approval.id, true));
    const saved = await current(service, session.id);
    const files = await workspace.list(session.id);
    expect(saved.run?.status).toBe("completed");
    expect(files.map((file) => file.path)).toContain("project-plan.md");
    expect(saved.events.filter((event) => event.type === "tool.completed" && event.data.name === "write_file")).toHaveLength(1);
    await expect(service.resume(session.id, approval.id, true)).rejects.toMatchObject({ code: "APPROVAL_STALE" });
  });

  it("records a denied write without creating a file", async () => {
    const { service, workspace, session } = await setup(new DemoProvider(0));
    await execute(await service.start(session.id, "Draft a project plan"));
    const approval = (await current(service, session.id)).run!.approval!;
    await execute(await service.resume(session.id, approval.id, false));
    const saved = await current(service, session.id);
    expect(await workspace.list(session.id)).toEqual([]);
    expect(saved.messages.findLast((message) => message.toolName === "write_file")?.content).toContain("APPROVAL_DENIED");
  });

  it("rejects approvals belonging to another session and stale approvals", async () => {
    const { service, session } = await setup(new DemoProvider(0));
    const other = await service.createSession(structuredClone(DEFAULT_CONFIG));
    await execute(await service.start(session.id, "Draft a project plan"));
    const approval = (await current(service, session.id)).run!.approval!;
    await expect(service.resume(other.id, approval.id, true)).rejects.toMatchObject({ code: "APPROVAL_STALE" });
    await execute(await service.resume(session.id, approval.id, false));
    await expect(service.resume(session.id, approval.id, false)).rejects.toMatchObject({ code: "APPROVAL_STALE" });
  });

  it("rejects a simultaneous run for one session", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const provider = adapter(async ({ signal, onToken }) => {
      signal.throwIfAborted();
      await Promise.race([blocked, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
      onToken("finished");
      return completion("finished");
    });
    const { service, session } = await setup(provider);
    const first = await service.start(session.id, "hello");
    const running = execute(first);
    await expect(service.start(session.id, "again")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    release();
    await running;
  });

  it("cancels an in-flight provider and leaves a replayable settled run", async () => {
    const provider = adapter(async ({ signal }) => {
      signal.throwIfAborted();
      await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      throw new Error("unreachable");
    });
    const { service, session } = await setup(provider);
    const run = execute(await service.start(session.id, "stop this"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.cancel(session.id);
    await run;
    const saved = await current(service, session.id);
    expect(saved.run?.status).toBe("cancelled");
    expect(saved.run?.pendingCalls).toEqual([]);
  });

  it("settles a running run after a process restart without replaying its tool", async () => {
    const { store, workspace, session } = await setup();
    await store.update(session.id, (draft) => {
      draft.run = { id: randomUUID(), status: "running", startedAt: draft.createdAt, step: 1, toolCount: 1, pendingCalls: [call("write_file", { path: "never.txt", content: "no" })] };
    });
    // A fresh service must use the same durable store; in-flight work is not replayed.
    const recovered = new HarnessService({ store, workspace, tools: createToolRegistry(), providers: { demo: new DemoProvider(0), deepseek: new DemoProvider(0) } });
    const saved = await recovered.getSession(session.id);
    expect(saved.run?.status).toBe("failed");
    expect(saved.run?.error?.code).toBe("INTERRUPTED");
    expect(saved.run?.pendingCalls).toEqual([]);
    expect(saved.messages.find((message) => message.toolCallId)?.content).toContain("INTERRUPTED");
    expect(await workspace.list(session.id)).toEqual([]);
  });

  it("fails cleanly at the model-step limit", async () => {
    const config = { ...structuredClone(DEFAULT_CONFIG), maxSteps: 1, tools: ["list_files"] as AgentConfig["tools"] };
    const provider = adapter(async () => completion("", [call("list_files", {})]));
    const { service, session } = await setup(provider, config);
    await execute(await service.start(session.id, "loop"));
    const saved = await current(service, session.id);
    expect(saved.run?.error?.code).toBe("STEP_LIMIT");
  });

  it("fails cleanly at the tool-call limit", async () => {
    const provider = adapter(async () => completion("", [call("list_files", {}, "one"), call("list_files", {}, "two")]));
    const { service, session } = await setup(provider, { ...structuredClone(DEFAULT_CONFIG), tools: ["list_files"] }, { maxToolCalls: 1 });
    await execute(await service.start(session.id, "too many"));
    const saved = await current(service, session.id);
    expect(saved.run?.error?.code).toBe("TOOL_LIMIT");
    expect(saved.run?.pendingCalls).toEqual([]);
  });

  it("converts unknown and disabled model tools into safe tool errors", async () => {
    let unknownCount = 0;
    const provider = adapter(async () => unknownCount++ === 0 ? completion("", [call("not_registered", {})]) : completion("recovered"));
    const unknown = await setup(provider, { ...structuredClone(DEFAULT_CONFIG), tools: [] });
    await execute(await unknown.service.start(unknown.session.id, "unknown"));
    expect((await current(unknown.service, unknown.session.id)).messages.findLast((message) => message.role === "tool")?.content).toContain("UNKNOWN_TOOL");

    let disabledCount = 0;
    const disabledProvider = adapter(async () => disabledCount++ === 0 ? completion("", [call("write_file", { path: "blocked.txt", content: "blocked" })]) : completion("done"));
    const disabled = await setup(disabledProvider, { ...structuredClone(DEFAULT_CONFIG), tools: ["list_files"] });
    await execute(await disabled.service.start(disabled.session.id, "disabled"));
    const saved = await current(disabled.service, disabled.session.id);
    expect(saved.messages.findLast((message) => message.role === "tool")?.content).toContain("TOOL_DISABLED");
    expect(await disabled.workspace.list(disabled.session.id)).toEqual([]);
  });

  it("durably saves the complete streamed text after the provider finishes", async () => {
    const provider = adapter(async ({ onToken }) => { onToken("hello "); onToken("world"); return completion("hello world"); });
    const { service, session } = await setup(provider);
    const events = await execute(await service.start(session.id, "say it"));
    const saved = await current(service, session.id);
    expect(saved.messages.findLast((message) => message.role === "assistant")?.content).toBe("hello world");
    expect(events.filter((event) => event.type === "token").map((event) => event.data.text).join("")).toBe("hello world");
    expect(saved.run?.status).toBe("completed");
  });

  it("enforces the wall-clock run timeout", async () => {
    const provider = adapter(async ({ signal }) => await new Promise<CompletionResult>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const { service, session } = await setup(provider, structuredClone(DEFAULT_CONFIG), { runTimeoutMs: 20 });
    await execute(await service.start(session.id, "slow"));
    expect((await current(service, session.id)).run?.error?.code).toBe("RUN_TIMEOUT");
  });
});
