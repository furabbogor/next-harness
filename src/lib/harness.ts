import { randomUUID } from "node:crypto";
import { HarnessError, publicError } from "./errors";
import { appendEvent, newSession, publicSession } from "./session";
import type { SessionStore } from "./storage";
import type { Workspace } from "./workspace";
import type { ToolRegistry } from "./tools";
import type { ProviderAdapter } from "./providers/types";
import type { AgentConfig, HarnessEvent, Message, ProviderId, Session, ToolCall, WireEvent } from "./types";

interface HarnessOptions {
  store: SessionStore;
  workspace: Workspace;
  tools: ToolRegistry;
  providers: Record<ProviderId, ProviderAdapter>;
  runTimeoutMs?: number;
  maxToolCalls?: number;
  approvalTtlMs?: number;
}

export interface RunHandle {
  sessionId: string;
  runId: string;
  abort: () => void;
  execute: (emit: (event: WireEvent) => void) => Promise<void>;
}

interface ActiveRun { id: string; controller: AbortController }
interface ApprovalDecision { callId: string; approved: boolean }

function addToolResult(session: Session, call: ToolCall, result: unknown, ok: boolean) {
  session.messages.push({ id: randomUUID(), role: "tool", content: JSON.stringify(result), createdAt: new Date().toISOString(), toolCallId: call.id, toolName: call.name });
  appendEvent(session, ok ? "tool.completed" : "tool.failed", { callId: call.id, name: call.name, result });
}

/** Close outstanding protocol calls on cancellation/failure so later turns remain replayable. */
function settlePending(session: Session, code: string, message: string) {
  if (!session.run) return;
  if (session.run.approval) {
    appendEvent(session, "approval.decided", { approvalId: session.run.approval.id, callId: session.run.approval.call.id, approved: false, reason: code });
    delete session.run.approval;
  }
  for (const call of session.run.pendingCalls) addToolResult(session, call, { ok: false, error: { code, message } }, false);
  session.run.pendingCalls = [];
}

/** Single-process coordinator. Durable state survives restarts; in-flight work is never replayed. */
export class HarnessService {
  readonly store: SessionStore;
  readonly workspace: Workspace;
  private readonly active = new Map<string, ActiveRun>();
  private readonly tools: ToolRegistry;
  private readonly providers: Record<ProviderId, ProviderAdapter>;
  private readonly limits: { runTimeoutMs: number; maxToolCalls: number; approvalTtlMs: number };

  constructor(options: HarnessOptions) {
    this.store = options.store;
    this.workspace = options.workspace;
    this.tools = options.tools;
    this.providers = options.providers;
    this.limits = { runTimeoutMs: options.runTimeoutMs ?? 120000, maxToolCalls: options.maxToolCalls ?? 16, approvalTtlMs: options.approvalTtlMs ?? 1800000 };
  }

  async getSession(id: string): Promise<Session> {
    const session = await this.store.get(id);
    if (!session) throw new HarnessError("NOT_FOUND", "Session not found.", 404);
    if (session.run?.status === "running" && !this.active.has(id)) {
      return this.store.update(id, (draft) => {
        if (draft.run?.status !== "running" || this.active.has(id)) return;
        settlePending(draft, "INTERRUPTED", "The server restarted before this operation settled. It was not replayed.");
        draft.run.status = "failed";
        draft.run.endedAt = new Date().toISOString();
        draft.run.error = { code: "INTERRUPTED", message: "This run was interrupted by a server restart. Check any completed files before retrying." };
        appendEvent(draft, "run.interrupted", draft.run.error);
      });
    }
    return session;
  }

  createSession(config: AgentConfig, title?: string) { return this.store.create(newSession(config, title)); }

  async updateSession(id: string, changes: { title?: string; config?: AgentConfig }) {
    await this.getSession(id);
    return this.store.update(id, (session) => {
      if (changes.config && ["running", "awaiting_approval"].includes(session.run?.status ?? "")) throw new HarnessError("SESSION_BUSY", "Stop the current run before changing its configuration.", 409);
      if (changes.title) session.title = changes.title;
      if (changes.config) session.config = structuredClone(changes.config);
    });
  }

  async deleteSession(id: string) {
    const session = await this.getSession(id);
    if (this.active.has(id) || session.run?.status === "awaiting_approval") throw new HarnessError("SESSION_BUSY", "Stop the run before deleting its session.", 409);
    await this.workspace.removeSession(id);
    await this.store.delete(id);
  }

  async start(id: string, content: string): Promise<RunHandle> {
    await this.getSession(id);
    if (this.active.has(id)) throw new HarnessError("SESSION_BUSY", "This session already has an active run.", 409);
    const active: ActiveRun = { id: randomUUID(), controller: new AbortController() };
    this.active.set(id, active);
    try {
      await this.store.update(id, (session) => {
        if (["running", "awaiting_approval"].includes(session.run?.status ?? "")) throw new HarnessError("SESSION_BUSY", "Finish or stop the current run first.", 409);
        if (session.messages.length >= 160 || session.events.length >= 1600) throw new HarnessError("SESSION_LIMIT", "This session reached its history limit. Export it and start a new session.", 409);
        session.run = { id: active.id, status: "running", startedAt: new Date().toISOString(), step: 0, toolCount: 0, pendingCalls: [] };
        appendEvent(session, "run.started", { provider: session.config.provider, model: session.config.model, config: structuredClone(session.config) });
        const message: Message = { id: randomUUID(), role: "user", content, createdAt: new Date().toISOString() };
        session.messages.push(message);
        appendEvent(session, "message.user", { messageId: message.id });
        if (session.title === "Untitled session") session.title = content.replace(/\s+/g, " ").slice(0, 70);
      });
      return this.handle(id, active);
    } catch (error) { this.active.delete(id); throw error; }
  }

  async resume(id: string, approvalId: string, approved: boolean): Promise<RunHandle> {
    await this.getSession(id);
    if (this.active.has(id)) throw new HarnessError("SESSION_BUSY", "An approval response is already being processed.", 409);
    const active: ActiveRun = { id: "", controller: new AbortController() };
    this.active.set(id, active);
    let decision: ApprovalDecision | undefined;
    let expired = false;
    try {
      await this.store.update(id, (session) => {
        const run = session.run;
        if (run?.status !== "awaiting_approval" || run.approval?.id !== approvalId) throw new HarnessError("APPROVAL_STALE", "This approval is no longer pending. Refresh the session.", 409);
        active.id = run.id;
        if (new Date(run.approval.expiresAt).getTime() <= Date.now()) {
          expired = true;
          settlePending(session, "APPROVAL_EXPIRED", "The approval expired without executing the action.");
          run.status = "failed";
          run.endedAt = new Date().toISOString();
          run.error = { code: "APPROVAL_EXPIRED", message: "The approval expired. Send a new request to prepare a fresh action." };
          appendEvent(session, "run.failed", run.error);
          return;
        }
        if (run.pendingCalls[0]?.id !== run.approval.call.id) throw new HarnessError("INVALID_STATE", "The saved approval does not match the pending action.", 409);
        decision = { callId: run.approval.call.id, approved };
        appendEvent(session, "approval.decided", { approvalId, callId: decision.callId, approved });
        delete run.approval;
        run.status = "running";
        appendEvent(session, "run.resumed", { approved });
      });
      if (expired) throw new HarnessError("APPROVAL_EXPIRED", "The approval expired. No pending action was executed.", 409);
      return this.handle(id, active, decision);
    } catch (error) { this.active.delete(id); throw error; }
  }

  async cancel(id: string): Promise<Session> {
    const session = await this.getSession(id);
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(new HarnessError("CANCELLED", "The run was stopped by the user.", 409));
      return session;
    }
    if (session.run?.status !== "awaiting_approval") return session;
    return this.store.update(id, (draft) => {
      if (draft.run?.status !== "awaiting_approval") return;
      settlePending(draft, "CANCELLED", "The run was stopped without executing the pending action.");
      draft.run.status = "cancelled";
      draft.run.endedAt = new Date().toISOString();
      appendEvent(draft, "run.cancelled", { reason: "user" });
    });
  }

  private handle(sessionId: string, active: ActiveRun, decision?: ApprovalDecision): RunHandle {
    let executed = false;
    return { sessionId, runId: active.id,
      abort: () => active.controller.abort(new HarnessError("CANCELLED", "The client disconnected; the run was stopped.", 409)),
      execute: async (emit) => {
        if (executed) throw new Error("A run handle can only execute once");
        executed = true;
        await this.drive(sessionId, active, emit, decision);
      },
    };
  }

  private async drive(id: string, active: ActiveRun, send: (event: WireEvent) => void, initialDecision?: ApprovalDecision) {
    const signal = active.controller.signal;
    const emit = (event: WireEvent) => { try { send(event); } catch { active.controller.abort(new HarnessError("CANCELLED", "The client disconnected.", 409)); } };
    const snapshot = (session: Session) => emit({ type: "snapshot", data: publicSession(session) });
    const event = (entry: HarnessEvent) => emit({ type: "event", data: entry });
    const update = async (change: (draft: Session) => void) => {
      const current = await this.store.get(id);
      const count = current?.events.length ?? 0;
      const session = await this.store.update(id, (draft) => {
        if (draft.run?.id !== active.id) throw new HarnessError("RUN_STALE", "The active run no longer matches this session.", 409);
        change(draft);
      });
      for (const entry of session.events.slice(count)) event(entry);
      return session;
    };
    const timer = setTimeout(() => active.controller.abort(new HarnessError("RUN_TIMEOUT", "The run exceeded its time limit. Try a smaller request.", 408)), this.limits.runTimeoutMs);
    let partial = "";
    let decision = initialDecision;
    try {
      snapshot(await this.getSession(id));
      while (true) {
        signal.throwIfAborted();
        let session = await this.getSession(id);
        if (session.run?.status !== "running") return;
        const call = session.run.pendingCalls[0];
        if (call) {
          const called = session.events.some((entry) => entry.runId === active.id && entry.type === "tool.called" && (entry.data.call as ToolCall | undefined)?.id === call.id);
          if (!called) {
            if (session.run.toolCount >= this.limits.maxToolCalls) throw new HarnessError("TOOL_LIMIT", "The run reached its tool-call limit. Review the results before continuing.", 422);
            session = await update((draft) => { draft.run!.toolCount++; appendEvent(draft, "tool.called", { call }); });
          }
          let result: unknown;
          let ok = true;
          try {
            const plugin = this.tools.get(call.name);
            const enabled = session.config.tools.includes(plugin.definition.name);
            if (!enabled) throw new HarnessError("TOOL_DISABLED", "The requested tool is disabled for this session.", 403);
            const resolved = decision?.callId === call.id ? decision : undefined;
            if (plugin.definition.approvalRequired && !resolved) {
              session = await update((draft) => {
                draft.run!.status = "awaiting_approval";
                draft.run!.approval = { id: randomUUID(), call: structuredClone(call), expiresAt: new Date(Date.now() + this.limits.approvalTtlMs).toISOString() };
                appendEvent(draft, "approval.requested", { approval: draft.run!.approval });
              });
              snapshot(session);
              return;
            }
            if (resolved) decision = undefined;
            if (resolved && !resolved.approved) throw new HarnessError("APPROVAL_DENIED", "The user declined this action. Do not claim it was executed.", 403);
            const value = await this.tools.execute(call, session.config.tools, {
              sessionId: id, workspace: this.workspace, signal, writeApproved: resolved?.approved === true,
              updatePlan: async (items) => { await update((draft) => { draft.plan = items; appendEvent(draft, "plan.updated", { items }); }); },
            });
            result = { ok: true, result: value };
          } catch (error) {
            if (signal.aborted) throw error;
            ok = false;
            const safe = publicError(error);
            result = { ok: false, error: { code: safe.code, message: safe.message } };
          }
          session = await update((draft) => {
            if (draft.run!.pendingCalls[0]?.id !== call.id) throw new Error("Pending tool changed during execution");
            addToolResult(draft, call, result, ok);
            draft.run!.pendingCalls.shift();
          });
          snapshot(session);
          continue;
        }
        if (session.run.step >= session.config.maxSteps) throw new HarnessError("STEP_LIMIT", "The run reached its model-step limit. Review its work, then send a follow-up or increase the limit.", 422);
        if (JSON.stringify(session.messages).length + session.config.systemPrompt.length > 180000) throw new HarnessError("CONTEXT_LIMIT", "This session is too large for another model request. Export it and start a new session.", 422);
        session = await update((draft) => { draft.run!.step++; appendEvent(draft, "step.started", { step: draft.run!.step, provider: draft.config.provider }); });
        partial = "";
        const completion = await this.providers[session.config.provider].generate({
          config: session.config, messages: session.messages, tools: this.tools.definitions(session.config.tools), signal,
          onToken: (text) => { partial += text; emit({ type: "token", data: { text } }); },
        });
        signal.throwIfAborted();
        if (!completion.content && !completion.toolCalls.length) throw new HarnessError("EMPTY_RESPONSE", "The model returned no text or tool calls.", 502);
        session = await update((draft) => {
          const message: Message = { id: randomUUID(), role: "assistant", content: completion.content, createdAt: new Date().toISOString(), provider: draft.config.provider,
            ...(completion.toolCalls.length ? { toolCalls: completion.toolCalls } : {}), ...(completion.reasoningContent ? { reasoningContent: completion.reasoningContent } : {}) };
          draft.messages.push(message);
          draft.run!.pendingCalls = structuredClone(completion.toolCalls);
          draft.usage.inputTokens += completion.usage.inputTokens || (completion.usage.estimated ? Math.ceil(JSON.stringify(session.messages).length / 4) : 0);
          draft.usage.outputTokens += completion.usage.outputTokens;
          draft.usage.estimated ||= completion.usage.estimated;
          appendEvent(draft, "message.assistant", { messageId: message.id, usage: completion.usage });
          if (!completion.toolCalls.length) { draft.run!.status = "completed"; draft.run!.endedAt = new Date().toISOString(); appendEvent(draft, "run.completed", { steps: draft.run!.step, toolCalls: draft.run!.toolCount }); }
        });
        partial = "";
        snapshot(session);
        if (session.run?.status === "completed") return;
      }
    } catch (error) {
      const safe = signal.aborted
        ? signal.reason instanceof HarnessError ? signal.reason : new HarnessError("CANCELLED", "The run was stopped.", 409)
        : publicError(error);
      try {
        const session = await update((draft) => {
          if (partial) {
            const message: Message = { id: randomUUID(), role: "assistant", content: `${partial}\n\n> Incomplete response: ${safe.message}`, createdAt: new Date().toISOString(), provider: draft.config.provider };
            draft.messages.push(message);
            appendEvent(draft, "message.assistant", { messageId: message.id, incomplete: true });
          }
          settlePending(draft, safe.code, safe.message);
          draft.run!.status = safe.code === "CANCELLED" ? "cancelled" : "failed";
          draft.run!.endedAt = new Date().toISOString();
          draft.run!.error = { code: safe.code, message: safe.message };
          appendEvent(draft, safe.code === "CANCELLED" ? "run.cancelled" : "run.failed", { code: safe.code, message: safe.message });
        });
        snapshot(session);
      } catch (persistError) {
        console.error("[next-harness] Failed to settle run", persistError instanceof Error ? persistError.name : "Unknown error");
      }
      if (safe.code !== "CANCELLED") emit({ type: "error", data: { code: safe.code, message: safe.message } });
    } finally {
      clearTimeout(timer);
      if (this.active.get(id)?.id === active.id) this.active.delete(id);
      const session = await this.store.get(id).catch(() => null);
      emit({ type: "done", data: { sessionId: id, runId: active.id, status: session?.run?.status ?? "failed" } });
    }
  }
}
