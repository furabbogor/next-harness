import type { AgentConfig, Message, ToolCall, ToolDefinition, Usage } from "../types";

export interface CompletionInput {
  config: AgentConfig;
  messages: Message[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  onToken: (text: string) => void;
}

export interface CompletionResult {
  content: string;
  reasoningContent?: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: "stop" | "tool_calls";
}

/** Providers stream display text and return the complete message before it is persisted. */
export interface ProviderAdapter {
  generate(input: CompletionInput): Promise<CompletionResult>;
}
