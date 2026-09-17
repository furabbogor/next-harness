import path from "node:path";
import { z } from "zod";
import { DEFAULT_CONFIG, TOOL_DEFINITIONS } from "./settings";
import { HarnessError } from "./errors";
import type { PublicConfig } from "./types";

const envSchema = z.object({
  HARNESS_DEFAULT_PROVIDER: z.enum(["demo", "deepseek"]).default("demo"),
  DEEPSEEK_API_KEY: z.string().default(""),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.enum(["deepseek-chat", "deepseek-reasoner"]).default("deepseek-chat"),
  DATABASE_URL: z.string().default(""),
  HARNESS_DATA_DIR: z.string().min(1).default(".harness"),
  HARNESS_ACCESS_TOKEN: z.string().default(""),
  HARNESS_PUBLIC_URL: z.string().default(""),
  HARNESS_RUN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(120000),
  HARNESS_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(128).default(32),
  HARNESS_SKILLS_DIR: z.string().default(""),
  HARNESS_MCP_SERVERS: z.string().max(16000).default(""),
  HARNESS_APPROVAL_TTL_MS: z.coerce.number().int().min(1000).max(86400000).default(1800000),
});

/** Resolve server environment lazily, so a keyless production build needs no database. */
export function getServerConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) throw new HarnessError("INVALID_CONFIG", "Server configuration is invalid. Check the documented environment variables.", 503);
  const env = parsed.data;
  const baseUrl = new URL(env.DEEPSEEK_BASE_URL);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new HarnessError("INVALID_CONFIG", "DEEPSEEK_BASE_URL must be an HTTPS URL without credentials, query, or fragment.", 503);
  }
  if (env.HARNESS_ACCESS_TOKEN && env.HARNESS_ACCESS_TOKEN.length < 24) {
    throw new HarnessError("INVALID_CONFIG", "HARNESS_ACCESS_TOKEN must contain at least 24 characters.", 503);
  }
  let publicOrigin: string | undefined;
  if (env.HARNESS_PUBLIC_URL) {
    try {
      const url = new URL(env.HARNESS_PUBLIC_URL);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid origin");
      publicOrigin = url.origin;
    } catch { throw new HarnessError("INVALID_CONFIG", "HARNESS_PUBLIC_URL must be an exact HTTP(S) origin.", 503); }
  }
  return {
    dataDir: path.resolve(env.HARNESS_DATA_DIR), databaseUrl: env.DATABASE_URL,
    accessToken: env.HARNESS_ACCESS_TOKEN, publicOrigin,
    deepseek: { apiKey: env.DEEPSEEK_API_KEY, baseUrl: baseUrl.href.replace(/\/$/, ""), model: env.DEEPSEEK_MODEL },
    defaultProvider: env.HARNESS_DEFAULT_PROVIDER,
    skillsDir: env.HARNESS_SKILLS_DIR ? path.resolve(env.HARNESS_SKILLS_DIR) : undefined,
    mcpServers: env.HARNESS_MCP_SERVERS,
    runTimeoutMs: env.HARNESS_RUN_TIMEOUT_MS, maxToolCalls: env.HARNESS_MAX_TOOL_CALLS, approvalTtlMs: env.HARNESS_APPROVAL_TTL_MS,
  };
}

export function getPublicConfig(): PublicConfig {
  const config = getServerConfig();
  return {
    defaultConfig: { ...DEFAULT_CONFIG, tools: [...DEFAULT_CONFIG.tools], provider: config.defaultProvider, model: config.defaultProvider === "demo" ? "demo-v1" : config.deepseek.model },
    providers: [
      { id: "demo", label: "Demo · no API key", configured: true, models: ["demo-v1"] },
      { id: "deepseek", label: "DeepSeek", configured: Boolean(config.deepseek.apiKey), models: ["deepseek-chat", "deepseek-reasoner"] },
    ], tools: TOOL_DEFINITIONS, storage: config.databaseUrl ? "postgres" : "file", protected: Boolean(config.accessToken), version: "0.2.0",
    features: [
      { id: "ptc", label: "Programmatic tools", status: "available", detail: "Isolated TypeScript, live nested approvals, generated SDK and saved execution traces." },
      { id: "context", label: "Context compaction", status: "available", detail: "Whole-turn extractive summaries; original history is retained." },
      { id: "delegation", label: "Delegated tasks", status: "available", detail: "Bounded read-only child agents using the selected provider." },
      { id: "skills", label: "Selected skills", status: config.skillsDir ? "available" : "disabled", detail: "Operator-managed SKILL.md files; set HARNESS_SKILLS_DIR." },
      { id: "mcp", label: "MCP tools", status: config.mcpServers ? "available" : "disabled", detail: "Opt-in Streamable HTTP gateways; every external call requires approval." },
      { id: "shell", label: "Shell / terminal / SSH", status: "not_implemented", detail: "Not exposed. PTC is not an unrestricted Node or shell runtime." },
      { id: "automation", label: "Schedules / webhooks / browser control", status: "not_implemented", detail: "Reference subsystems not ported to this release." },
    ],
  };
}
