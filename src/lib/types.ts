/** Shared wire and persistence types. No server configuration or secrets belong here. */
export type ProviderId = "demo" | "deepseek";
export type PresetId = "builder" | "planner" | "reviewer";
export type ToolName = "list_files" | "read_file" | "write_file" | "update_plan";
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
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

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

export interface PlanItem {
  id: string;
  text: string;
  status: PlanStatus;
}

export type EventType =
  | "run.started" | "run.resumed" | "run.completed" | "run.failed" | "run.cancelled" | "run.interrupted"
  | "message.user" | "message.assistant" | "step.started"
  | "tool.called" | "tool.completed" | "tool.failed"
  | "approval.requested" | "approval.decided" | "plan.updated";

export interface HarnessEvent {
  id: string;
  seq: number;
  sessionId: string;
  runId: string;
  type: EventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface PendingApproval {
  id: string;
  call: ToolCall;
  expiresAt: string;
}

export interface RunState {
  id: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  step: number;
  toolCount: number;
  pendingCalls: ToolCall[];
  approval?: PendingApproval;
  error?: { code: string; message: string };
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  config: AgentConfig;
  messages: Message[];
  events: HarnessEvent[];
  plan: PlanItem[];
  usage: Usage;
  run: RunState | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: ProviderId;
  model: string;
  runStatus: RunStatus | null;
  messageCount: number;
}

export interface WorkspaceFile {
  path: string;
  bytes: number;
  updatedAt: string;
}

export interface ToolDefinition {
  name: ToolName;
  label: string;
  description: string;
  approvalRequired: boolean;
  parameters: Record<string, unknown>;
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
  storage: "file" | "postgres";
  protected: boolean;
  version: string;
}
