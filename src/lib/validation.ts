import { z } from "zod";
import { HarnessError } from "./errors";
import { NATIVE_TOOL_NAMES } from "./types";

export const idSchema = z.string().uuid();
export const nativeToolNameSchema = z.union([z.enum(NATIVE_TOOL_NAMES), z.string().regex(/^mcp_[a-z0-9_]{1,59}$/).transform(value => value as `mcp_${string}`)]);
export const configSchema = z.object({
  provider: z.enum(["demo", "deepseek"]),
  model: z.enum(["demo-v1", "deepseek-chat", "deepseek-reasoner"]),
  preset: z.enum(["builder", "planner", "reviewer"]),
  systemPrompt: z.string().trim().min(1).max(12000),
  maxSteps: z.number().int().min(1).max(12),
  maxTokens: z.number().int().min(256).max(8192),
  tools: z.array(nativeToolNameSchema).max(41).refine(value => new Set(value).size === value.length, "Tools must be unique"),
  toolMode: z.enum(["native", "ptc", "both"]).default("native"),
  skills: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(8).default([]).refine(value => new Set(value).size === value.length, "Skills must be unique"),
  contextMaxCharacters: z.number().int().min(16000).max(180000).default(60000),
}).strict().refine(value => value.provider === "demo" ? value.model === "demo-v1" : value.model !== "demo-v1", "Model does not match provider");
export const createSessionSchema = z.object({ title: z.string().trim().min(1).max(100).optional(), config: configSchema.optional() }).strict();
export const updateSessionSchema = z.object({ title: z.string().trim().min(1).max(100).optional(), config: configSchema.optional() }).strict().refine(value => value.title !== undefined || value.config !== undefined, "No changes supplied");
export const messageSchema = z.object({ content: z.string().trim().min(1).max(20000) }).strict();
export const programSchema = z.object({ code: z.string().min(1).max(32768), description: z.string().trim().min(1).max(300) }).strict();
export const approvalSchema = z.object({ approved: z.boolean() }).strict();
export const fileSchema = z.object({ path: z.string().min(1).max(240), content: z.string().max(65536) }).strict();
export function parseInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HarnessError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid request.", 400);
  return parsed.data;
}
