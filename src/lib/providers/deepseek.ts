import { createParser } from "eventsource-parser";
import { z } from "zod";
import { HarnessError } from "../errors";
import type { ToolCall } from "../types";
import type { CompletionInput, CompletionResult, ProviderAdapter } from "./types";

const chunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      content: z.string().nullish(), reasoning_content: z.string().nullish(),
      tool_calls: z.array(z.object({ index: z.number().int().min(0).max(31), id: z.string().optional(), function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() })).optional(),
    }).optional(),
    finish_reason: z.string().nullish(),
  })).optional(),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).nullish(),
  error: z.unknown().optional(),
});

/** Incrementally decode provider SSE, including split UTF-8 and split tool arguments. */
export async function readCompletionStream(response: Response, input: Pick<CompletionInput, "signal" | "onToken">): Promise<CompletionResult> {
  if (!response.body) throw new HarnessError("PROVIDER_PROTOCOL", "DeepSeek returned an empty stream.", 502);
  let content = "";
  let reasoningContent = "";
  let receivedBytes = 0;
  let finishReason: string | undefined;
  let usage: CompletionResult["usage"] | undefined;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const parser = createParser({
    onEvent(event) {
      if (event.data === "[DONE]") return;
      let json: unknown;
      try { json = JSON.parse(event.data); } catch { throw new HarnessError("PROVIDER_PROTOCOL", "DeepSeek returned malformed stream data.", 502); }
      const parsed = chunkSchema.safeParse(json);
      if (!parsed.success || parsed.data.error) throw new HarnessError("PROVIDER_PROTOCOL", "DeepSeek returned an invalid completion event.", 502);
      const chunk = parsed.data;
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, estimated: false };
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (choice.delta?.content) { content += choice.delta.content; input.onToken(choice.delta.content); }
      if (choice.delta?.reasoning_content) reasoningContent += choice.delta.reasoning_content;
      for (const part of choice.delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
        if (part.id) call.id += part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
        calls.set(part.index, call);
      }
    },
    onError() { throw new HarnessError("PROVIDER_PROTOCOL", "DeepSeek returned an invalid event stream.", 502); },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      input.signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > 2 * 1024 * 1024) throw new HarnessError("PROVIDER_LIMIT", "The provider response exceeded the safety limit.", 502);
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (finishReason === "length") throw new HarnessError("OUTPUT_LIMIT", "The model reached its output limit. Increase the token limit or ask for a smaller result.", 422);
  if (finishReason !== "stop" && finishReason !== "tool_calls") throw new HarnessError("PROVIDER_PROTOCOL", "The provider stream ended without a complete response.", 502);
  const toolCalls: ToolCall[] = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
    if (!call.id || !call.name || call.id.length > 200 || call.name.length > 100) throw new HarnessError("PROVIDER_PROTOCOL", "The provider returned an invalid tool call.", 502);
    try { return { id: call.id, name: call.name, args: JSON.parse(call.arguments || "{}") }; }
    catch { throw new HarnessError("TOOL_ARGUMENTS", "The provider returned malformed tool arguments.", 502); }
  });
  if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) throw new HarnessError("PROVIDER_PROTOCOL", "The provider repeated a tool-call identifier.", 502);
  if (finishReason === "tool_calls" && !toolCalls.length) throw new HarnessError("PROVIDER_PROTOCOL", "The provider requested tools without a tool call.", 502);
  return { content, reasoningContent: reasoningContent || undefined, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage: usage ?? { inputTokens: 0, outputTokens: Math.ceil((content.length + reasoningContent.length) / 4), estimated: true } };
}

export class DeepSeekProvider implements ProviderAdapter {
  constructor(private readonly options: { apiKey: string; baseUrl: string }, private readonly fetcher: typeof fetch = fetch) {}

  async generate(input: CompletionInput): Promise<CompletionResult> {
    if (!this.options.apiKey) throw new HarnessError("PROVIDER_NOT_CONFIGURED", "DeepSeek is not configured. Set DEEPSEEK_API_KEY on the server, or explicitly choose Demo in Agent settings.", 503);
    const messages = [
      { role: "system", content: input.config.systemPrompt },
      ...input.messages.map((message) => ({
        role: message.role, content: message.content || (message.toolCalls?.length ? null : ""),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
        ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}),
      })),
    ];
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", signal: input.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ model: input.config.model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: input.config.maxTokens,
          ...(input.tools.length ? { tools: input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
        }),
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      throw new HarnessError("PROVIDER_UNAVAILABLE", "Could not reach DeepSeek. Check server connectivity and provider configuration.", 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new HarnessError("PROVIDER_AUTH", "DeepSeek rejected the server API key. Check its validity and account permissions.", 502);
      if (response.status === 429) throw new HarnessError("PROVIDER_RATE_LIMIT", "DeepSeek is rate-limiting requests. Please wait before trying again.", 429);
      throw new HarnessError("PROVIDER_ERROR", `DeepSeek could not complete the request (HTTP ${response.status}). Check the model, account balance, and server configuration.`, 502);
    }
    return readCompletionStream(response, input);
  }
}
