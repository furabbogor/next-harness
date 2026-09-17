/** Shared wire and persistence types. No server secrets belong here. */
export type ProviderId = "demo" | "deepseek";
export type PresetId = "builder" | "planner" | "reviewer";
export const NATIVE_TOOL_NAMES = ["list_files", "read_file", "write_file", "edit_file", "search_files", "update_plan", "todo_write", "set_goal", "delegate_task"] as const;
export type ToolName = typeof NATIVE_TOOL_NAMES[number] | "run_code" | `mcp_${string}`;
export type ToolMode = "native" | "ptc" | "both";
export type RunStatus = "running" | "awaiting_approval" | "completed" | "cancelled" | "failed";
export type PlanStatus = "pending" | "in_progress" | "completed";

export interface AgentConfig {
  provider: ProviderId;
  model: string;
  preset: PresetId;
  systemPrompt: string;
  maxSteps: number;
  maxTokens: number;
  tools: ToolName[];
  /** Missing in version-one records means native mode. */
  toolMode?: ToolMode;
  skills?: string[];
  contextMaxCharacters?: number;
}

export interface Usage { inputTokens: number; outputTokens: number; estimated: boolean }
export interface ToolCall { id: string; name: string; args: unknown }
export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  provider?: ProviderId;
  reasoningContent?: string;
}
export interface PlanItem { id: string; text: string; status: PlanStatus }
export const EVENT_TYPES = [
  "run.started", "run.resumed", "run.completed", "run.failed", "run.cancelled", "run.interrupted",
  "message.user", "message.assistant", "step.started", "tool.called", "tool.completed", "tool.failed",
  "approval.requested", "approval.decided", "plan.updated", "todo.updated", "goal.updated",
  "ptc.started", "ptc.log", "ptc.completed", "context.compacted", "context.prepared", "skills.loaded",
  "delegation.started", "delegation.completed", "delegation.failed", "file.added", "session.forked",
] as const;
export type EventType = typeof EVENT_TYPES[number];
export interface HarnessEvent {
  id: string; seq: number; sessionId: string; runId: string; type: EventType;
  timestamp: string; data: Record<string, unknown>;
}
export interface PendingApproval {
  id: string; call: ToolCall; expiresAt: string;
  /** A nested approval belongs to a live PTC program, never a disk checkpoint. */
  parentCallId?: string;
}
export interface RunState {
  id: string; status: RunStatus; startedAt: string; endedAt?: string; deadlineAt?: string; kind?: "agent" | "program";
  step: number; toolCount: number; pendingCalls: ToolCall[];
  approval?: PendingApproval;
  error?: { code: string; message: string };
}
export interface ContextCheckpoint {
  throughMessageId: string; summary: string; createdAt: string; compactedMessages: number;
}
export interface Session {
  id: string; title: string; createdAt: string; updatedAt: string;
  config: AgentConfig; messages: Message[]; events: HarnessEvent[];
  plan: PlanItem[]; todos?: PlanItem[]; goal?: { objective: string; status: "active" | "completed" };
  context?: ContextCheckpoint;
  usage: Usage; run: RunState | null;
}
export interface SessionSummary {
  id: string; title: string; createdAt: string; updatedAt: string;
  provider: ProviderId; model: string; runStatus: RunStatus | null; messageCount: number;
}
export interface WorkspaceFile { path: string; bytes: number; updatedAt: string }
export interface ToolDefinition {
  name: ToolName; label: string; description: string; approvalRequired: boolean;
  parameters: Record<string, unknown>;
  resultType?: string;
  group?: "workspace" | "planning" | "agents" | "runtime" | "mcp";
}
export type WireEvent =
  | { type: "token"; data: { text: string } }
  | { type: "event"; data: HarnessEvent }
  | { type: "snapshot"; data: Session }
  | { type: "done"; data: { sessionId: string; runId: string; status: RunStatus } }
  | { type: "error"; data: { code: string; message: string } };
export interface PublicConfig {
  defaultConfig: AgentConfig;
  providers: { id: ProviderId; label: string; configured: boolean; models: string[] }[];
  tools: ToolDefinition[];
  skills?: { id: string; name: string; description: string; digest: string }[];
  features?: { id: string; label: string; status: "available" | "disabled" | "not_implemented"; detail: string }[];
  storage: "file" | "postgres"; protected: boolean; version: string;
}
