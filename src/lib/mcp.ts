import { createHash } from "node:crypto";
import Ajv from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HarnessError } from "./errors";
import type { ToolPlugin } from "./tools";
import { NATIVE_TOOL_NAMES, type ToolDefinition } from "./types";

export interface McpServerConfig {
  id: string;
  url: string;
  tokenEnv?: string;
  allowHttpLoopback?: boolean;
}

type ValidatedPlugin = ToolPlugin & { validate?: (args: unknown) => unknown };
type Connection = { client: Client; transport: StreamableHTTPClientTransport };

const MAX_SERVERS = 8;
const MAX_TOOLS = 32;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_DESCRIPTION_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const ID = /^[a-z0-9][a-z0-9_]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const reserved = new Set<string>(NATIVE_TOOL_NAMES);

function configError(): never { throw new HarnessError("MCP_CONFIG", "MCP server configuration is invalid."); }
function safeError(code: string, message: string, status = 502): HarnessError { return new HarnessError(code, message, status); }
function byteSize(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function schemaDepth(value: unknown, depth = 0): number {
  if (depth > 24) return depth;
  if (!value || typeof value !== "object") return depth;
  return Math.max(depth, ...Object.values(value as Record<string, unknown>).map((item) => schemaDepth(item, depth + 1)));
}
function hasRemoteRef(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref") return true; // even local refs are disallowed: schemas are self-contained.
    if (hasRemoteRef(item)) return true;
  }
  return false;
}
function boundedText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_DESCRIPTION_BYTES) : "";
}
function safeToolName(serverId: string, remoteName: string, used: Set<string>): string {
  const base = `mcp_${serverId}_${remoteName.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool"}`;
  let candidate = base.slice(0, 64);
  if (used.has(candidate) || reserved.has(candidate)) {
    const suffix = `_${createHash("sha256").update(`${serverId}\0${remoteName}`).digest("hex").slice(0, 8)}`;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  if (used.has(candidate) || reserved.has(candidate)) throw safeError("MCP_TOOLS", "MCP tool names conflict.");
  used.add(candidate);
  return candidate;
}

/** Parse operator-owned HARNESS_MCP_SERVERS configuration without exposing endpoints. */
export function parseMcpServers(value: string): McpServerConfig[] {
  if (value.trim() === "") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return configError(); }
  if (!Array.isArray(parsed) || parsed.length > MAX_SERVERS) return configError();
  const ids = new Set<string>();
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return configError();
    const { id, url, tokenEnv, allowHttpLoopback, ...extra } = item as Record<string, unknown>;
    if (Object.keys(extra).length || typeof id !== "string" || !ID.test(id) || ids.has(id) || typeof url !== "string") return configError();
    ids.add(id);
    if (tokenEnv !== undefined && (typeof tokenEnv !== "string" || !ENV_NAME.test(tokenEnv))) return configError();
    if (allowHttpLoopback !== undefined && typeof allowHttpLoopback !== "boolean") return configError();
    let endpoint: URL;
    try { endpoint = new URL(url); } catch { return configError(); }
    const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback && allowHttpLoopback === true))) return configError();
    return { id, url: endpoint.href, ...(tokenEnv ? { tokenEnv } : {}), ...(allowHttpLoopback ? { allowHttpLoopback } : {}) };
  });
}

export class McpGateway {
  private readonly env: NodeJS.ProcessEnv;
  private readonly connections: Connection[] = [];
  private connectPromise?: Promise<ToolPlugin[]>;

  constructor(private readonly servers: McpServerConfig[], env: NodeJS.ProcessEnv = process.env) {
    // Also validate programmatic construction, rather than trusting an integration caller.
    parseMcpServers(JSON.stringify(servers));
    this.env = env;
  }

  connect(): Promise<ToolPlugin[]> {
    if (!this.connectPromise) this.connectPromise = this.connectAll().catch(async (error: unknown) => {
      await this.close();
      this.connectPromise = undefined;
      throw error;
    });
    return this.connectPromise;
  }

  private async connectAll(): Promise<ToolPlugin[]> {
    const discovered: Array<{ config: McpServerConfig; client: Client; name: string; description?: string; inputSchema: Record<string, unknown> }> = [];
    try {
      for (const config of this.servers) {
        const endpoint = new URL(config.url);
        const token = config.tokenEnv ? this.env[config.tokenEnv] : undefined;
        if (config.tokenEnv && !token) throw safeError("MCP_AUTH", "An MCP authentication secret is unavailable.", 500);
        const fetchLocked = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
          if (requested.href !== endpoint.href) throw safeError("MCP_REQUEST", "MCP request was rejected.");
          const headers = new Headers(init?.headers);
          if (token) headers.set("authorization", `Bearer ${token}`);
          return fetch(input, { ...init, headers, redirect: "error" });
        };
        const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined, fetch: fetchLocked });
        const client = new Client({ name: "next-harness", version: "0.1.0" });
        this.connections.push({ client, transport });
        await client.connect(transport, { timeout: 20_000, maxTotalTimeout: 20_000 });
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout: 20_000, maxTotalTimeout: 20_000 });
          for (const tool of listed.tools) {
            if (discovered.length >= MAX_TOOLS) throw safeError("MCP_TOOLS", "Too many MCP tools were discovered.");
            if (typeof tool.name !== "string" || !tool.name || Buffer.byteLength(tool.name) > 256 || (tool.description !== undefined && (typeof tool.description !== "string" || Buffer.byteLength(tool.description) > MAX_DESCRIPTION_BYTES)) || byteSize(tool.inputSchema) > MAX_SCHEMA_BYTES || schemaDepth(tool.inputSchema) > 24 || hasRemoteRef(tool.inputSchema)) throw safeError("MCP_SCHEMA", "An MCP tool schema is invalid.");
            discovered.push({ config, client, name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
          }
          cursor = listed.nextCursor;
          if (cursor && (cursors.has(cursor) || cursors.size >= MAX_TOOLS)) throw safeError("MCP_TOOLS", "MCP tool pagination is invalid.");
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
      const used = new Set<string>();
      return discovered.map((tool) => this.pluginFor(tool, safeToolName(tool.config.id, tool.name, used)));
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw safeError("MCP_UNAVAILABLE", "An MCP server could not be reached.");
    }
  }

  private pluginFor(tool: { client: Client; name: string; description?: string; inputSchema: Record<string, unknown> }, name: string): ToolPlugin {
    let validate: (args: unknown) => boolean;
    try { validate = new Ajv({ strict: false, allErrors: false }).compile(tool.inputSchema); } catch { throw safeError("MCP_SCHEMA", "An MCP tool schema is invalid."); }
    const definition: ToolDefinition = { name: name as ToolDefinition["name"], label: boundedText(tool.name || name).slice(0, 160) || name, description: boundedText(tool.description), parameters: tool.inputSchema, approvalRequired: true, group: "mcp", resultType: "unknown" };
    const plugin: ValidatedPlugin = {
      definition,
      validate(args: unknown): unknown { if (!validate(args)) throw new HarnessError("TOOL_ARGUMENTS", "The tool received invalid arguments."); return args; },
      async execute(args, context) {
        context.signal.throwIfAborted();
        if (!context.writeApproved) throw new HarnessError("APPROVAL_REQUIRED", "This action needs explicit approval.", 403);
        if (!validate(args)) throw new HarnessError("TOOL_ARGUMENTS", "The tool received invalid arguments.");
        try {
          const result = await tool.client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, { signal: context.signal, timeout: 20_000, maxTotalTimeout: 20_000 });
          if (byteSize(result) > MAX_RESULT_BYTES) throw safeError("MCP_RESULT", "The MCP tool returned too much data.");
          if ("isError" in result && result.isError) throw safeError("MCP_TOOL_ERROR", "The MCP tool reported an error.");
          return result;
        } catch (error) {
          if (error instanceof HarnessError) throw error;
          if (context.signal.aborted) context.signal.throwIfAborted();
          if (error instanceof Error && error.name === "AbortError") throw error;
          throw safeError("MCP_CALL_FAILED", "The MCP tool call failed.");
        }
      },
    };
    return plugin;
  }

  async close(): Promise<void> {
    const active = this.connections.splice(0);
    await Promise.allSettled(active.map(async ({ client, transport }) => { await Promise.allSettled([client.close(), transport.close()]); }));
    this.connectPromise = undefined;
  }
}
