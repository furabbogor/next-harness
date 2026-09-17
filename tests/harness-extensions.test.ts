import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessService } from "@/lib/harness";
import { FileSessionStore } from "@/lib/storage";
import { Workspace } from "@/lib/workspace";
import { createToolRegistry, type ToolPlugin } from "@/lib/tools";
import { DEFAULT_CONFIG } from "@/lib/settings";
import { loadSkills } from "@/lib/skills";
import type { CompletionResult, ProviderAdapter } from "@/lib/providers/types";
import type { AgentConfig, Message, Session, ToolCall, WireEvent } from "@/lib/types";

const roots: string[] = [];
const done = (content = "done", toolCalls: ToolCall[] = []): CompletionResult => ({ content, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage: { inputTokens: 1, outputTokens: 1, estimated: false } });
const call = (name: string, args: unknown, id = `call-${randomUUID()}`): ToolCall => ({ id, name, args });
const adapter = (generate: ProviderAdapter["generate"]): ProviderAdapter => ({ generate });
async function setup(provider: ProviderAdapter, config: AgentConfig = structuredClone(DEFAULT_CONFIG), options: ConstructorParameters<typeof HarnessService>[0] extends never ? never : Partial<ConstructorParameters<typeof HarnessService>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-extension-")); roots.push(root);
  const store = FileSessionStore(join(root, "sessions")); const workspace = Workspace(join(root, "workspaces"));
  const service = new HarnessService({ store, workspace, tools: createToolRegistry(), providers: { demo: provider, deepseek: provider }, ...options });
  const session = await service.createSession(config); return { root, store, workspace, service, session };
}
async function run(handle: Awaited<ReturnType<HarnessService["start"]>>): Promise<WireEvent[]> { const events: WireEvent[] = []; await handle.execute(event => events.push(event)); return events; }
async function saved(service: HarnessService, id: string): Promise<Session> { return (await service.getSession(id)); }
function result(session: Session, name = "run_code"): any { return JSON.parse(session.messages.findLast(message => message.toolName === name)!.content); }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("focused HarnessService integration extensions", () => {
  it("projects provider-initiated PTC as run_code only and feeds its result back without nested tool messages", async () => {
    const seen: { tools: string[]; prompt: string; messages: Message[] }[] = [];
    let n = 0;
    const provider = adapter(async input => {
      seen.push({ tools: input.tools.map(tool => tool.name), prompt: input.config.systemPrompt, messages: structuredClone(input.messages) });
      return n++ === 0 ? done("", [call("run_code", { code: "return 7", description: "compute" })]) : done("finished");
    });
    const { service, session } = await setup(provider, { ...structuredClone(DEFAULT_CONFIG), toolMode: "ptc", tools: ["list_files", "read_file"] });
    await run(await service.start(session.id, "compute"));
    const final = await saved(service, session.id);
    expect(seen[0].tools).toEqual(["run_code"]); expect(seen[0].prompt).toContain('"list_files"'); expect(seen[0].prompt).not.toContain('"write_file"');
    expect(seen[1].messages.findLast(message => message.role === "tool")?.content).toContain('"status":"completed"');
    expect(final.messages.filter(message => message.role === "tool")).toHaveLength(1);
    expect(final.messages.filter(message => message.role === "tool").every(message => message.toolCallId)).toBe(true);
    expect(final.run?.status).toBe("completed");
    await service.close();
  });

  it("resumes a model-generated PTC invocation through the same live approval", async () => {
    let calls = 0;
    const provider = adapter(async () => { calls++; return calls === 1 ? done("", [call("run_code", { code: "await tools.write_file({path:'live.txt',content:'approved'}); return 'ok';", description: "live write" }, "parent")]) : done("complete"); });
    const { service, workspace, session } = await setup(provider, { ...structuredClone(DEFAULT_CONFIG), toolMode: "ptc", tools: ["write_file"] });
    await run(await service.start(session.id, "do it"));
    let pending = await saved(service, session.id); expect(pending.run?.status).toBe("awaiting_approval");
    const approval = pending.run!.approval!; await run(await service.resume(session.id, approval.id, true));
    const final = await saved(service, session.id);
    expect(calls).toBe(2); expect(final.run?.status).toBe("completed"); expect((await workspace.read(session.id, "live.txt")).content).toBe("approved");
    expect(final.events.filter(event => event.type === "ptc.started")).toHaveLength(1);
    await service.close();
  });

  it("persists a whole-turn context checkpoint while retaining originals and reuses it after a fresh service", async () => {
    const seen: Message[][] = [];
    const provider = adapter(async input => { seen.push(structuredClone(input.messages)); return done("next"); });
    const config = { ...structuredClone(DEFAULT_CONFIG), contextMaxCharacters: 16000, tools: [] as AgentConfig["tools"] };
    const { service, store, workspace, session, root } = await setup(provider, config);
    const historical: Message[] = [
      { id: "u-old", role: "user", content: "historical requirement ".repeat(3000), createdAt: new Date().toISOString() },
      { id: "a-old", role: "assistant", content: "old answer", toolCalls: [call("list_files", {}, "old-call")], createdAt: new Date().toISOString() },
      { id: "t-old", role: "tool", content: "[]", toolCallId: "old-call", toolName: "list_files", createdAt: new Date().toISOString() },
      { id: "u-mid", role: "user", content: "middle", createdAt: new Date().toISOString() }, { id: "a-mid", role: "assistant", content: "middle answer", createdAt: new Date().toISOString() },
      { id: "u-recent", role: "user", content: "recent", createdAt: new Date().toISOString() }, { id: "a-recent", role: "assistant", content: "recent answer", createdAt: new Date().toISOString() },
    ];
    await store.update(session.id, draft => { draft.messages = historical; });
    await run(await service.start(session.id, "current"));
    const first = await saved(service, session.id); expect(first.context?.throughMessageId).toBe("t-old"); expect(first.messages.map(message => message.id)).toEqual(expect.arrayContaining(historical.map(message => message.id)));
    const fresh = new HarnessService({ store, workspace, tools: createToolRegistry(), providers: { demo: provider, deepseek: provider } });
    await run(await fresh.start(session.id, "after restart"));
    expect(seen.at(-1)?.some(message => message.id === "u-old")).toBe(false); expect((await saved(fresh, session.id)).context?.compactedMessages).toBeGreaterThan(0);
    await service.close(); await fresh.close(); void root;
  });

  it("loads selected skills into the effective prompt and trace, and rejects unknown selections", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-skill-")); roots.push(root);
    await (await import("node:fs/promises")).mkdir(join(root, "checklist")); await (await import("node:fs/promises")).writeFile(join(root, "checklist", "SKILL.md"), "---\nname: Checklist\ndescription: A check\n---\nUSE THE CHECKLIST");
    const loaded = await loadSkills(root); expect(loaded[0].digest).toHaveLength(64);
    const provider = adapter(async input => { expect(input.config.systemPrompt).toContain("USE THE CHECKLIST"); return done("ok"); });
    const { service, session } = await setup(provider, { ...structuredClone(DEFAULT_CONFIG), skills: ["checklist"] }, { loadSkills: async () => loaded });
    await run(await service.start(session.id, "skill")); const final = await saved(service, session.id);
    expect(final.events.find(event => event.type === "skills.loaded")?.data.skills).toEqual(expect.arrayContaining([expect.objectContaining({ id: "checklist", digest: loaded[0].digest })]));
    await service.close();
    const invalid = await setup(provider, structuredClone(DEFAULT_CONFIG), { loadSkills: async () => loaded });
    await expect(invalid.service.createSession({ ...structuredClone(DEFAULT_CONFIG), skills: ["missing"] })).rejects.toMatchObject({ code: "SKILL_SELECTION_INVALID" }); await invalid.service.close();
  });

  it("discovers gateway plugins but rejects disabled calls and approves an enabled exact external call", async () => {
    let executed = 0; let connected = 0;
    const plugin: ToolPlugin = { definition: { name: "mcp_echo", label: "Echo", group: "mcp", description: "echo", approvalRequired: true, parameters: {}, resultType: "string" }, execute: async args => { executed++; return args; } };
    let step = 0;
    const provider = adapter(async () => step++ === 0 ? done("", [call("mcp_echo", { value: "x" })]) : done("done"));
    const gateway = { connect: async () => { connected++; return [plugin]; }, close: async () => undefined };
    const disabled = await setup(provider, { ...structuredClone(DEFAULT_CONFIG), tools: [] }, { gateway });
    expect((await disabled.service.catalog()).tools.map(tool => tool.name)).toContain("mcp_echo"); await run(await disabled.service.start(disabled.session.id, "disabled")); expect(executed).toBe(0); await disabled.service.close();
    step = 0; const enabled = await setup(provider, { ...structuredClone(DEFAULT_CONFIG), tools: ["mcp_echo"] as AgentConfig["tools"] }, { gateway });
    await run(await enabled.service.start(enabled.session.id, "external")); let current = await saved(enabled.service, enabled.session.id); expect(current.run?.status).toBe("awaiting_approval");
    await run(await enabled.service.resume(enabled.session.id, current.run!.approval!.id, true)); expect(executed).toBe(1); expect(connected).toBe(2); expect((await saved(enabled.service, enabled.session.id)).run?.status).toBe("completed"); await enabled.service.close();
  });

  it("bounds delegation to read-only tools and persists usage/child trace with public reasoning redacted", async () => {
    let parent = true; const provider = adapter(async input => {
      if (input.config.systemPrompt.includes("read-only delegated assistant")) return parent ? done("child answer", []) : done("child reasoning", []);
      parent = false; return done("", [call("delegate_task", { task: "inspect" })]);
    });
    const { service, session } = await setup(provider, { ...structuredClone(DEFAULT_CONFIG), tools: ["delegate_task", "write_file", "read_file"] });
    await run(await service.start(session.id, "delegate")); const final = await saved(service, session.id);
    expect(final.events.some(event => event.type === "delegation.started")).toBe(true); expect(final.events.some(event => event.type === "delegation.completed")).toBe(true); expect(final.usage.inputTokens).toBeGreaterThan(0);
    const child = final.events.find(event => event.type === "message.assistant" && event.data.taskId); expect(child?.data.message).toBeDefined(); expect((child?.data.message as Message).reasoningContent).toBeUndefined();
    const childConfig = final.events.find(event => event.type === "delegation.started")?.data.config as AgentConfig; expect(childConfig.tools).toEqual(["read_file"]); expect(childConfig.toolMode).toBe("native");
    await service.close();
  });

  it("executes todo, goal, literal search and exact edit approval in one PTC program", async () => {
    const provider = adapter(async () => done("unused"));
    const { service, workspace, session } = await setup(provider, { ...structuredClone(DEFAULT_CONFIG), toolMode: "ptc", tools: ["todo_write", "set_goal", "search_files", "edit_file"] });
    await workspace.write(session.id, "note.txt", "alpha\nbeta\nalpha");
    await run(await service.startProgram(session.id, "await tools.todo_write({items:[{text:'check',status:'pending'}]}); await tools.set_goal({objective:'ship',status:'active'}); const found=await tools.search_files({query:'alpha'}); await tools.edit_file({path:'note.txt',oldText:'beta',newText:'done'}); return found;", "organize"));
    let pending = await saved(service, session.id); expect(pending.run?.approval?.call.args).toEqual({ path: "note.txt", oldText: "beta", newText: "done" });
    await run(await service.resume(session.id, pending.run!.approval!.id, true)); const final = await saved(service, session.id);
    expect(final.todos?.[0].text).toBe("check"); expect(final.goal).toEqual({ objective: "ship", status: "active" }); expect((await workspace.read(session.id, "note.txt")).content).toContain("done"); expect(result(final).result.value).toEqual({ matches: expect.arrayContaining([expect.objectContaining({ line: 1, text: "alpha" })]), truncated: false });
    await service.close();
  });
});
