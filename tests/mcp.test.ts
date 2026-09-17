import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpGateway, parseMcpServers } from "@/lib/mcp";

const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };

type Fixture = { server: Server; url: string; calls: string[]; close: () => Promise<void> };
async function fixture(): Promise<Fixture> {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    const raw = await new Promise<string>((resolve) => { let body = ""; request.on("data", (chunk: Buffer) => { body += chunk; }); request.on("end", () => resolve(body)); });
    if (!raw) { response.writeHead(request.method === "GET" ? 405 : 200).end(); return; }
    const message = JSON.parse(raw) as { id?: number; method?: string; params?: { cursor?: string; name?: string; arguments?: Record<string, unknown> } };
    const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); };
    if (message.method === "initialize") return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "local-fixture", version: "1" } });
    if (message.method === "notifications/initialized") { response.writeHead(202).end(); return; }
    if (message.method === "tools/list") {
      if (!message.params?.cursor) return reply({ tools: [{ name: "same-name", description: "A read only-looking fixture tool", inputSchema: schema, annotations: { readOnlyHint: true } }], nextCursor: "page-2" });
      return reply({ tools: [{ name: "same_name", description: "Second page", inputSchema: schema }] });
    }
    if (message.method === "tools/call") {
      calls.push(message.params?.name ?? "");
      if (message.params?.name === "same_name") return reply({ content: [{ type: "text", text: "remote error" }], isError: true });
      if (message.params?.arguments?.value === "wait") return; // client cancellation supplies the test abort.
      return reply({ content: [{ type: "text", text: `ok:${message.params?.arguments?.value}` }], structuredContent: { echoed: message.params?.arguments?.value } });
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}/mcp`, calls, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

const context = (writeApproved: boolean, signal = new AbortController().signal) => ({ sessionId: "s", workspace: {} as never, signal, writeApproved, updatePlan: async () => {} });
const gateways: McpGateway[] = [];
const fixtures: Fixture[] = [];
afterEach(async () => { await Promise.all(gateways.splice(0).map((gateway) => gateway.close())); await Promise.all(fixtures.splice(0).map((item) => item.close())); });

async function connected() {
  const local = await fixture(); fixtures.push(local);
  const gateway = new McpGateway([{ id: "local", url: local.url, allowHttpLoopback: true }], {} as NodeJS.ProcessEnv); gateways.push(gateway);
  return { local, gateway, plugins: await gateway.connect() };
}

describe("McpGateway", () => {
  it("uses the SDK streamable HTTP handshake, follows tool pagination, and yields distinct deterministic names", async () => {
    const { gateway, plugins } = await connected();
    expect(await gateway.connect()).toBe(plugins); // concurrent/idempotent result cache
    expect(plugins.map((plugin) => plugin.definition.name)).toEqual(["mcp_local_same_name", "mcp_local_same_name_1511c2dc"]);
    expect(plugins.every((plugin) => plugin.definition.group === "mcp" && plugin.definition.approvalRequired)).toBe(true);
  });

  it("executes an approved tool and preserves MCP JSON content", async () => {
    const { local, plugins } = await connected();
    await expect(plugins[0].execute({ value: "hello" }, context(true))).resolves.toMatchObject({ content: [{ type: "text", text: "ok:hello" }], structuredContent: { echoed: "hello" } });
    expect(local.calls).toEqual(["same-name"]);
  });

  it("requires approval despite an untrusted readOnlyHint", async () => {
    const { plugins } = await connected();
    await expect(plugins[0].execute({ value: "hello" }, context(false))).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("rejects invalid tool arguments before a remote call", async () => {
    const { local, plugins } = await connected();
    await expect(plugins[0].execute({ value: 1 }, context(true))).rejects.toMatchObject({ code: "TOOL_ARGUMENTS" });
    expect(local.calls).toEqual([]);
  });

  it("honors aborts and maps remote tool errors", async () => {
    const { plugins } = await connected();
    const abort = new AbortController();
    const pending = plugins[0].execute({ value: "wait" }, context(true, abort.signal));
    setTimeout(() => abort.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(plugins[1].execute({ value: "hello" }, context(true))).rejects.toMatchObject({ code: "MCP_TOOL_ERROR" });
  });

  it("rejects malformed endpoint configuration and requires a supplied token variable", async () => {
    for (const value of ["{", '[{"id":"UPPER","url":"https://example.test"}]', '[{"id":"a","url":"http://example.test"}]', '[{"id":"a","url":"https://user:pass@example.test"}]']) expect(() => parseMcpServers(value)).toThrowError(expect.objectContaining({ code: "MCP_CONFIG" }));
    await expect(new McpGateway([{ id: "local", url: "https://example.test", tokenEnv: "MCP_TOKEN" }], {} as NodeJS.ProcessEnv).connect()).rejects.toMatchObject({ code: "MCP_AUTH" });
  });
});
