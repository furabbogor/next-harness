import { describe, expect, it } from "vitest";
import { DeepSeekProvider, readCompletionStream } from "@/lib/providers/deepseek";
import { DEFAULT_CONFIG } from "@/lib/settings";
import type { CompletionInput } from "@/lib/providers/types";

const input = (overrides: Partial<CompletionInput> = {}): CompletionInput => ({
  config: { ...structuredClone(DEFAULT_CONFIG), provider: "deepseek", model: "deepseek-chat" },
  messages: [{ id: "u", role: "user", content: "hello", createdAt: new Date(0).toISOString() }],
  tools: [], signal: new AbortController().signal, onToken: () => undefined, ...overrides,
});
function sse(events: string[], chunkSize = 0): Response {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${event}\n\n`).join(""));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = chunkSize ? Math.min(bytes.length, offset + chunkSize) : bytes.length;
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function chunk(json: unknown): string { return JSON.stringify(json); }

const stop = (content: string) => chunk({ choices: [{ delta: { content }, finish_reason: null }] });

describe("DeepSeek provider stream protocol", () => {
  it("decodes split UTF-8 content and reports streamed usage", async () => {
    const seen: string[] = [];
    const response = sse([
      stop("hé🙂"),
      chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      chunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
      "[DONE]",
    ], 1);
    const result = await readCompletionStream(response, { signal: new AbortController().signal, onToken: (text) => seen.push(text) });
    expect(result.content).toBe("hé🙂");
    expect(seen.join("")).toBe("hé🙂");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, estimated: false });
  });

  it("reassembles tool identifiers, names, JSON arguments, and usage across chunks", async () => {
    const response = sse([
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_", function: { name: "write_", arguments: "{\"path\":\"x" } }] } }] }),
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "1", function: { name: "file", arguments: ".txt\",\"content\":\"ok\"}" } }] } }] }),
      chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      chunk({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 5 } }),
      "[DONE]",
    ], 3);
    const result = await readCompletionStream(response, { signal: new AbortController().signal, onToken: () => undefined });
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "write_file", args: { path: "x.txt", content: "ok" } }]);
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 5, estimated: false });
  });

  it("does not silently fall back when the DeepSeek key is missing", async () => {
    let called = false;
    const provider = new DeepSeekProvider({ apiKey: "", baseUrl: "https://example.test" }, async () => { called = true; return new Response(); });
    await expect(provider.generate(input())).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    expect(called).toBe(false);
  });

  it("maps malformed SSE JSON to a provider protocol error", async () => {
    const provider = new DeepSeekProvider({ apiKey: "secret", baseUrl: "https://example.test" }, async () => sse(["{not-json"]));
    await expect(provider.generate(input())).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL" });
  });

  it("rejects a stream that ends without a complete finish reason", async () => {
    const provider = new DeepSeekProvider({ apiKey: "secret", baseUrl: "https://example.test" }, async () => sse([stop("partial"), "[DONE]"]));
    await expect(provider.generate(input())).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL" });
  });

  it("rejects output-limit completions with a specific safe error", async () => {
    const provider = new DeepSeekProvider({ apiKey: "secret", baseUrl: "https://example.test" }, async () => sse([chunk({ choices: [{ delta: {}, finish_reason: "length" }] }), "[DONE]"]));
    await expect(provider.generate(input())).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
  });

  it.each([[401, "PROVIDER_AUTH"], [403, "PROVIDER_AUTH"], [429, "PROVIDER_RATE_LIMIT"], [500, "PROVIDER_ERROR"]] as const)("maps HTTP %s without leaking the response body", async (status, code) => {
    const provider = new DeepSeekProvider({ apiKey: "secret", baseUrl: "https://example.test" }, async () => new Response("private provider detail", { status }));
    await expect(provider.generate(input())).rejects.toMatchObject({ code });
  });

  it("passes tools and server-side configuration in the request", async () => {
    let requestBody = "";
    const provider = new DeepSeekProvider({ apiKey: "secret", baseUrl: "https://example.test/" }, async (_url, init) => {
      requestBody = String(init?.body);
      return sse([chunk({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }), "[DONE]"]);
    });
    const result = await provider.generate(input({ tools: [{ name: "read_file", label: "Read", description: "read", approvalRequired: false, parameters: { type: "object" } }] }));
    expect(result.content).toBe("ok");
    expect(requestBody).toContain('"model":"deepseek-chat"');
    expect(requestBody).toContain('"name":"read_file"');
    expect(requestBody).not.toContain("secret");
  });
});
