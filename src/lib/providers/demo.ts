import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Message, ToolCall } from "../types";
import type { CompletionInput, CompletionResult, ProviderAdapter } from "./types";

function toolResult(messages: Message[], name: string): { ok: boolean; result?: unknown } | undefined {
  const message = messages.findLast((item) => item.role === "tool" && item.toolName === name);
  if (!message) return undefined;
  try { return JSON.parse(message.content); } catch { return { ok: false }; }
}

function call(name: string, args: unknown): ToolCall { return { id: `call_${randomUUID()}`, name, args }; }
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** An explicit deterministic walkthrough, not a language model and never a failover. */
export class DemoProvider implements ProviderAdapter {
  constructor(private readonly delayMs = 24) {}

  async generate(input: CompletionInput): Promise<CompletionResult> {
    input.signal.throwIfAborted();
    const userIndex = input.messages.findLastIndex((item) => item.role === "user");
    const prompt = input.messages[userIndex]?.content ?? "Explore this workspace";
    const turn = input.messages.slice(userIndex + 1);
    const has = (name: string) => input.tools.some((tool) => tool.name === name);
    const listed = toolResult(turn, "list_files");
    const planned = toolResult(turn, "update_plan");
    const written = toolResult(turn, "write_file");
    const read = toolResult(turn, "read_file");
    const wantsArtifact = /plan|build|create|draft|write|landing|design|brief|implement/i.test(prompt);
    const wantsExplanation = /explain|how (does|do)|what (is|are)/i.test(prompt) && !wantsArtifact;
    let content = "";
    let toolCalls: ToolCall[] = [];
    const artifact = /landing/i.test(prompt) ? "landing-page.html" : "project-plan.md";

    if (wantsExplanation) {
      content = "## A small, inspectable agent workspace\n\nNext Harness connects a **provider**, a **bounded execution loop**, and a **tool registry**. Every settled message, tool result, and approval is saved with its session.\n\n- **Sessions** keep conversations, plans, configuration, and event history together.\n- **Tools** can list, read, and write text files inside a session-only workspace. Writes stop for your approval.\n- **Runs** stream their progress and stop at a step, tool-call, or time limit.\n- **Providers** are replaceable: this is the deterministic demo, while DeepSeek uses a server-side API key.\n\nTry **“Draft a project plan”** to see a real file-write approval. This demo explains the product; it does not use a language model.";
    } else if (!turn.some((item) => item.role === "assistant") && (has("list_files") || (wantsArtifact && has("update_plan")))) {
      content = wantsArtifact ? "I’ll inspect the workspace and set out a small plan, then prepare a draft for your approval.\n\n*Demo walkthrough — the workflow is deterministic, but the file operations and approvals are real.*" : "I’ll check the files in this session’s workspace. This is a demo run; no external model is called.";
      if (has("list_files")) toolCalls.push(call("list_files", {}));
      if (wantsArtifact && has("update_plan")) toolCalls.push(call("update_plan", { items: [
        { text: "Inspect the session workspace", status: "completed" },
        { text: "Prepare a first draft", status: "in_progress" },
        { text: "Review and approve the artifact", status: "pending" },
      ] }));
    } else if (wantsArtifact && !written && has("write_file")) {
      content = `The next step is to save **${artifact}**. Review the exact file contents in the approval card; nothing will be written unless you approve.`;
      const fileContent = artifact.endsWith(".html")
        ? `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>A considered beginning</title>\n<style>body{margin:0;background:#f4f0e8;color:#262522;font:18px/1.7 system-ui,sans-serif}main{max-width:840px;margin:12vh auto;padding:32px}small{color:#ae5036;text-transform:uppercase;letter-spacing:.16em}h1{font:clamp(42px,8vw,86px)/1.05 Georgia,serif;letter-spacing:-.05em}p{max-width:580px;color:#68655e}a{display:inline-block;margin-top:24px;padding:14px 24px;background:#292823;color:white;border-radius:8px;text-decoration:none}footer{margin-top:100px;font-size:13px}</style>\n</head>\n<body><main><small>A first draft</small><h1>Small ideas.<br>Thoughtful beginnings.</h1><p>${escapeHtml(prompt.slice(0, 1000))}</p><p>This local demo artifact is a starting point. Replace the copy, add your content, and review accessibility before publishing.</p><a href="#details">Explore the idea</a><section id="details"><h2>Make the next step clear.</h2><p>Focus on one audience, one useful outcome, and a simple invitation to act.</p></section><footer>Prepared by Next Harness · deterministic demo</footer></main></body>\n</html>\n`
        : `# Project plan\n\n> Prepared by Next Harness's deterministic demo. This is a starting template, not model-generated analysis.\n\n## Your brief\n\n${prompt}\n\n## 1. Define the outcome\n\n- Identify the primary user and their most important task.\n- Write three measurable acceptance criteria.\n- Confirm constraints, scope, and what is not included.\n\n## 2. Build a small vertical slice\n\n- Sketch the core screen and data flow.\n- Connect one real interaction from interface to persistence.\n- Show loading, empty, and error states.\n\n## 3. Review before expanding\n\n- Test the critical path and permission failures.\n- Review keyboard access and narrow screens.\n- Record remaining assumptions and follow-up work.\n\n## Definition of done\n\nA user can complete the main task, recover from errors, and understand what was saved. Tests must be run and their actual results recorded; this demo has not run them.\n`;
      toolCalls = [call("write_file", { path: artifact, content: fileContent })];
    } else if (written) {
      if (written.ok && planned && turn.filter((item) => item.toolName === "update_plan").length < 2 && has("update_plan")) {
        content = `**${artifact}** was saved after your approval. I’ll mark the walkthrough complete.`;
        toolCalls = [call("update_plan", { items: [
          { text: "Inspect the session workspace", status: "completed" },
          { text: "Prepare a first draft", status: "completed" },
          { text: "Review and approve the artifact", status: "completed" },
        ] })];
      } else {
        content = written.ok
          ? `## Your draft is ready\n\nSaved **\`${artifact}\`** in this session’s workspace. Open it in **Files** to inspect or download it.\n\nThe file write was real and approved by you. The contents came from a deterministic demo template—not a live model—and no builds or tests were executed.\n\nFor open-ended work, configure \`DEEPSEEK_API_KEY\` on the server and select **DeepSeek** in Agent settings.`
          : "The write was **not completed**, so I haven’t saved the draft. Your approval choice was recorded. You can send a new request when you’re ready, or inspect the tool result for details.";
      }
    } else if (listed && !wantsArtifact) {
      const files = Array.isArray(listed.result) ? listed.result as { path: string }[] : [];
      if (files.length && !read && has("read_file")) {
        content = `I found ${files.length} file${files.length === 1 ? "" : "s"}. I’ll read **${files[0].path}** next.`;
        toolCalls = [call("read_file", { path: files[0].path })];
      } else {
        content = files.length
          ? `## Workspace inventory\n\n${files.map((file) => `- \`${file.path}\``).join("\n")}\n\n${read?.ok ? "The first file was read successfully; its exact contents are available in the tool result." : "Open Files to view or download a document."}\n\nThis demo reports actual file operations, but does not perform a semantic code review. Select DeepSeek for an open-ended review.`
          : "Your session workspace is empty. Use **Add file** in the Files panel, or ask me to **draft a project plan** to try the approval flow. Files in other sessions are kept separate.";
      }
    } else {
      content = "You’re in **demo mode**. This deterministic adapter can explain the harness, explore workspace files, or draft a project plan with a real approval step. Enable the relevant tools in Agent settings, or configure DeepSeek for open-ended assistance. No external model was called.";
    }

    for (const chunk of content.match(/.{1,24}(?:\s|$)|.{1,24}/gs) ?? []) {
      input.signal.throwIfAborted();
      if (this.delayMs) await delay(this.delayMs, undefined, { signal: input.signal });
      input.onToken(chunk);
    }
    return { content, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage: { inputTokens: Math.ceil(JSON.stringify(input.messages).length / 4), outputTokens: Math.ceil((content.length + JSON.stringify(toolCalls).length) / 4), estimated: true } };
  }
}
