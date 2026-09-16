import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HarnessError } from "./errors";
import { TOOL_DEFINITIONS } from "./settings";
import type { PlanItem, ToolCall, ToolDefinition, ToolName } from "./types";
import type { Workspace } from "./workspace";

const schemas = {
  list_files: z.object({}).strict(),
  read_file: z.object({ path: z.string().min(1).max(240) }).strict(),
  write_file: z.object({ path: z.string().min(1).max(240), content: z.string().max(65536) }).strict(),
  update_plan: z.object({ items: z.array(z.object({ text: z.string().trim().min(1).max(200), status: z.enum(["pending", "in_progress", "completed"]) }).strict()).min(1).max(8) }).strict(),
};

export interface ToolContext {
  sessionId: string;
  workspace: Workspace;
  signal: AbortSignal;
  writeApproved: boolean;
  updatePlan: (items: PlanItem[]) => Promise<void>;
}

export interface ToolPlugin {
  definition: ToolDefinition;
  execute: (args: unknown, context: ToolContext) => Promise<unknown>;
}

/** Explicit server-side registry: no dynamic imports or model-supplied executable code. */
export class ToolRegistry {
  private readonly plugins = new Map<string, ToolPlugin>();

  register(plugin: ToolPlugin): void {
    if (this.plugins.has(plugin.definition.name)) throw new Error(`Duplicate tool: ${plugin.definition.name}`);
    this.plugins.set(plugin.definition.name, plugin);
  }

  definitions(enabled: ToolName[]): ToolDefinition[] {
    return enabled.map((name) => this.get(name).definition);
  }

  get(name: string): ToolPlugin {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new HarnessError("UNKNOWN_TOOL", "The model requested an unknown tool.");
    return plugin;
  }

  async execute(call: ToolCall, enabled: ToolName[], context: ToolContext): Promise<unknown> {
    context.signal.throwIfAborted();
    if (!enabled.includes(call.name as ToolName)) throw new HarnessError("TOOL_DISABLED", "This tool is not enabled for the session.", 403);
    const plugin = this.get(call.name);
    if (plugin.definition.approvalRequired && !context.writeApproved) throw new HarnessError("APPROVAL_REQUIRED", "This action needs explicit approval.", 403);
    return plugin.execute(call.args, context);
  }
}

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of TOOL_DEFINITIONS) {
    registry.register({ definition, async execute(args, context) {
      const parsed = schemas[definition.name].safeParse(args);
      if (!parsed.success) throw new HarnessError("TOOL_ARGUMENTS", "The tool received invalid arguments.");
      switch (definition.name) {
        case "list_files": return context.workspace.list(context.sessionId);
        case "read_file": return context.workspace.read(context.sessionId, (parsed.data as z.infer<typeof schemas.read_file>).path);
        case "write_file": {
          const input = parsed.data as z.infer<typeof schemas.write_file>;
          return context.workspace.write(context.sessionId, input.path, input.content);
        }
        case "update_plan": {
          const input = parsed.data as z.infer<typeof schemas.update_plan>;
          const items = input.items.map((item) => ({ ...item, id: randomUUID() }));
          await context.updatePlan(items);
          return { items };
        }
      }
    } });
  }
  return registry;
}
