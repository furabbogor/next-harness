import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HarnessError } from "./errors";
import { TOOL_DEFINITIONS } from "./settings";
import { validateWorkspacePath, type Workspace } from "./workspace";
import type { PlanItem, ToolCall, ToolDefinition, ToolName } from "./types";

const filePath = z.string().min(1).max(240).superRefine((path, context) => {
  try { validateWorkspacePath(path); } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid workspace path" }); }
});
const item = z.object({ text: z.string().trim().min(1).max(200), status: z.enum(["pending", "in_progress", "completed"]) }).strict();
const schemas = {
  list_files: z.object({}).strict(),
  read_file: z.object({ path: filePath }).strict(),
  write_file: z.object({ path: filePath, content: z.string().max(65536).refine(value => Buffer.byteLength(value, "utf8") <= 65536) }).strict(),
  edit_file: z.object({ path: filePath, oldText: z.string().min(1).max(65536), newText: z.string().max(65536) }).strict(),
  search_files: z.object({ query: z.string().min(1).max(200), caseSensitive: z.boolean().optional() }).strict(),
  update_plan: z.object({ items: z.array(item).min(1).max(8) }).strict(),
  todo_write: z.object({ items: z.array(item).max(12) }).strict(),
  set_goal: z.object({ objective: z.string().trim().min(1).max(1000), status: z.enum(["active", "completed"]) }).strict(),
  delegate_task: z.object({ task: z.string().trim().min(1).max(6000) }).strict(),
  run_code: z.object({ code: z.string().min(1).max(32768).refine(value => Buffer.byteLength(value, "utf8") <= 32768), description: z.string().trim().min(1).max(300) }).strict(),
};
export interface ToolContext {
  sessionId: string; workspace: Workspace; signal: AbortSignal; writeApproved: boolean;
  updatePlan: (items: PlanItem[]) => Promise<void>;
  updateTodos?: (items: PlanItem[]) => Promise<void>;
  setGoal?: (goal: { objective: string; status: "active" | "completed" }) => Promise<void>;
  delegateTask?: (task: string) => Promise<unknown>;
  runCode?: (code: string, description: string) => Promise<unknown>;
}
export interface ToolPlugin {
  definition: ToolDefinition;
  /** Pure validation happens before an approval is requested and again before execution. */
  validate?: (args: unknown) => unknown;
  execute: (args: unknown, context: ToolContext) => Promise<unknown>;
}

/** Explicit host registry. PTC only receives bindings projected from this registry. */
export class ToolRegistry {
  private readonly plugins = new Map<string, ToolPlugin>();
  register(plugin: ToolPlugin): () => void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(plugin.definition.name)) throw new Error("Invalid registered tool name");
    if (this.plugins.has(plugin.definition.name)) throw new Error(`Duplicate tool: ${plugin.definition.name}`);
    this.plugins.set(plugin.definition.name, plugin);
    return () => { if (this.plugins.get(plugin.definition.name) === plugin) this.plugins.delete(plugin.definition.name); };
  }
  all(): ToolDefinition[] { return [...this.plugins.values()].map(plugin => plugin.definition); }
  definitions(enabled: ToolName[]): ToolDefinition[] { return enabled.map(name => this.get(name).definition); }
  get(name: string): ToolPlugin {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new HarnessError("UNKNOWN_TOOL", "The model requested an unknown tool.");
    return plugin;
  }
  validate(call: ToolCall): ToolCall {
    const plugin = this.get(call.name);
    return { ...call, args: plugin.validate ? plugin.validate(call.args) : call.args };
  }
  async execute(call: ToolCall, enabled: ToolName[], context: ToolContext): Promise<unknown> {
    context.signal.throwIfAborted();
    const plugin = this.get(call.name);
    if (!enabled.includes(plugin.definition.name)) throw new HarnessError("TOOL_DISABLED", "This tool is not enabled for the session.", 403);
    if (plugin.definition.approvalRequired && !context.writeApproved) throw new HarnessError("APPROVAL_REQUIRED", "This action needs explicit approval.", 403);
    const checked = this.validate(call);
    context.signal.throwIfAborted();
    return plugin.execute(checked.args, context);
  }
}

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of TOOL_DEFINITIONS) {
    const name = definition.name as keyof typeof schemas;
    registry.register({ definition,
      validate(args) {
        const parsed = schemas[name].safeParse(args);
        if (!parsed.success) throw new HarnessError("TOOL_ARGUMENTS", "The tool received invalid arguments.");
        return parsed.data;
      },
      async execute(args, context) {
        switch (name) {
          case "list_files": return context.workspace.list(context.sessionId);
          case "read_file": return context.workspace.read(context.sessionId, (args as z.infer<typeof schemas.read_file>).path);
          case "write_file": {
            const input = args as z.infer<typeof schemas.write_file>;
            return context.workspace.write(context.sessionId, input.path, input.content);
          }
          case "edit_file": {
            const input = args as z.infer<typeof schemas.edit_file>;
            const file = await context.workspace.read(context.sessionId, input.path);
            context.signal.throwIfAborted();
            const first = file.content.indexOf(input.oldText);
            if (first < 0 || file.content.indexOf(input.oldText, first + 1) >= 0) throw new HarnessError("EDIT_CONFLICT", "The approved text must match exactly once. Read the current file and prepare a new edit.", 409);
            const content = file.content.slice(0, first) + input.newText + file.content.slice(first + input.oldText.length);
            return context.workspace.write(context.sessionId, input.path, content);
          }
          case "search_files": {
            const input = args as z.infer<typeof schemas.search_files>;
            const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
            const matches: { path: string; line: number; text: string }[] = [];
            for (const file of await context.workspace.list(context.sessionId)) {
              context.signal.throwIfAborted();
              const data = await context.workspace.read(context.sessionId, file.path);
              const lines = data.content.split(/\r?\n/);
              for (let index = 0; index < lines.length; index++) {
                if (!(input.caseSensitive ? lines[index] : lines[index].toLowerCase()).includes(needle)) continue;
                if (matches.length === 100) return { matches, truncated: true };
                matches.push({ path: file.path, line: index + 1, text: lines[index].slice(0, 500) });
              }
            }
            return { matches, truncated: false };
          }
          case "update_plan": case "todo_write": {
            const input = args as z.infer<typeof schemas.todo_write>;
            const items = input.items.map(value => ({ ...value, id: randomUUID() }));
            const update = name === "update_plan" ? context.updatePlan : context.updateTodos;
            if (!update) throw new HarnessError("TOOL_UNAVAILABLE", "This planning capability is unavailable.");
            await update(items);
            return { items };
          }
          case "set_goal": {
            if (!context.setGoal) throw new HarnessError("TOOL_UNAVAILABLE", "Session goals are unavailable.");
            const goal = args as z.infer<typeof schemas.set_goal>;
            await context.setGoal(goal); return goal;
          }
          case "delegate_task": {
            if (!context.delegateTask) throw new HarnessError("TOOL_UNAVAILABLE", "Delegation is unavailable in this context.");
            return context.delegateTask((args as z.infer<typeof schemas.delegate_task>).task);
          }
          case "run_code": {
            if (!context.runCode) throw new HarnessError("TOOL_UNAVAILABLE", "Recursive PTC is not allowed.");
            const input = args as z.infer<typeof schemas.run_code>;
            return context.runCode(input.code, input.description);
          }
        }
      },
    });
  }
  return registry;
}
