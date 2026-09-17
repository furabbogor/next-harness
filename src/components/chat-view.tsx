"use client";
import { useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUpRight, Check, Code2, CheckCheck, ChevronRight, Clipboard, FileCode2, FileText, FolderOpen, Layers3, ListChecks, ShieldCheck, Sparkles, X } from "lucide-react";
import type { Message, PendingApproval, Session, ToolCall } from "@/lib/types";
import { formatBytes, HarnessMark, shortTime, Spinner } from "./ui";

function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return <div className="code-block"><button className="copy-code" type="button" aria-label="Copy code" onClick={async () => {
    try { await navigator.clipboard.writeText(ref.current?.textContent ?? ""); setCopied(true); setCopyError(false); setTimeout(() => setCopied(false), 1800); }
    catch { setCopyError(true); }
  }}>{copied ? <Check size={13} /> : <Clipboard size={13} />}{copied ? "Copied" : copyError ? "Select to copy" : "Copy"}</button><pre ref={ref}>{children}</pre></div>;
}

export function Markdown({ content, onFile }: { content: string; onFile?: (path: string) => void }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    a: ({ href, children }) => href && /^https?:\/\//i.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={12} className="inline-icon" /></a>
      : onFile && href && !href.includes(":") ? <button className="text-link" onClick={() => onFile(href.replace(/^\.\//, ""))}>{children}</button> : <span>{children}</span>,
    img: ({ alt }) => <span className="image-omitted">[Image not loaded{alt ? `: ${alt}` : ""}]</span>,
  }}>{content}</ReactMarkdown></div>;
}

const toolLabels: Record<string, { label: string; icon: typeof FileText }> = {
  list_files: { label: "List workspace", icon: FolderOpen }, read_file: { label: "Read file", icon: FileText },
  write_file: { label: "Write file", icon: FileCode2 }, edit_file: { label: "Edit file", icon: FileCode2 }, search_files: { label: "Search files", icon: FileText }, update_plan: { label: "Update plan", icon: ListChecks }, todo_write: { label: "Write todos", icon: ListChecks }, set_goal: { label: "Set goal", icon: Sparkles }, delegate_task: { label: "Delegate task", icon: Layers3 }, run_code: { label: "Run TypeScript", icon: Code2 },
};

function ToolCard({ call, result, waiting }: { call: ToolCall; result?: Message; waiting: boolean }) {
  const details = toolLabels[call.name] ?? { label: call.name, icon: Layers3 };
  const Icon = details.icon;
  let parsed: { ok?: boolean; result?: unknown; error?: { message: string; code: string } } | null = null;
  try { parsed = result ? JSON.parse(result.content) : null; } catch { parsed = null; }
  const args = call.args && typeof call.args === "object" ? call.args as Record<string, unknown> : {};
  const subtitle = typeof args.path === "string" ? args.path : call.name === "update_plan" && Array.isArray(args.items) ? `${args.items.length} steps` : "Session workspace";
  return <details className={`tool-card ${waiting ? "tool-waiting" : ""}`}>
    <summary><span className="tool-icon"><Icon size={15} /></span><span className="tool-name">{details.label}<small>{subtitle}</small></span><span className={`tool-status ${parsed?.ok ? "success" : result ? "muted" : waiting ? "warning" : ""}`}>
      {result ? parsed?.ok ? <><Check size={13} />Complete</> : <><X size={13} />Not completed</> : waiting ? <><ShieldCheck size={13} />Review</> : <Spinner label="Tool in progress" />}
    </span><ChevronRight size={13} className="details-chevron" /></summary>
    <div className="tool-detail"><span className="eyebrow">Arguments</span><pre>{JSON.stringify(call.args, null, 2)}</pre>{result && <><span className="eyebrow">Result</span><pre>{JSON.stringify(parsed ?? result.content, null, 2)}</pre></>}</div>
  </details>;
}

export function ChatMessage({ message, session, onFile }: { message: Message; session: Session; onFile: (path: string) => void }) {
  if (message.role === "tool") return null;
  if (message.role === "user") return <article className="message user-message"><div className="user-message-content"><span className="message-label">You<span>{shortTime(message.createdAt)}</span></span><p>{message.content}</p></div><span className="user-avatar" aria-hidden="true">Y</span></article>;
  return <article className="message assistant-message"><div className="assistant-avatar"><HarnessMark small /></div><div className="message-body">
    <div className="message-label">Next Harness<span className="tiny-badge">{message.provider === "demo" ? "DEMO" : "DEEPSEEK"}</span><time>{shortTime(message.createdAt)}</time></div>
    {message.content && <Markdown content={message.content} onFile={onFile} />}
    {message.toolCalls?.map((call) => <ToolCard key={call.id} call={call} result={session.messages.find((item) => item.role === "tool" && item.toolCallId === call.id)} waiting={session.run?.approval?.call.id === call.id} />)}
  </div></article>;
}

export function StreamingMessage({ text }: { text: string }) {
  return <article className="message assistant-message streaming-message"><div className="assistant-avatar"><HarnessMark small /></div><div className="message-body"><div className="message-label">Next Harness<span className="streaming-label"><span className="pulse-dot" />Working</span></div>{text ? <Markdown content={text} /> : <div className="thinking-dots" aria-label="Agent is working"><i /><i /><i /></div>}</div></article>;
}

export function ApprovalCard({ approval, busy, onDecision }: { approval: PendingApproval; busy: boolean; onDecision: (approved: boolean) => void }) {
  const args = approval.call.args && typeof approval.call.args === "object" ? approval.call.args as Record<string, unknown> : {};
  const path = typeof args.path === "string" ? args.path : "External action";
  const isEdit = approval.call.name === "edit_file";
  const isMcp = approval.call.name.startsWith("mcp_");
  const content = typeof args.content === "string" ? args.content : JSON.stringify(approval.call.args, null, 2);
  return <section className="approval-card" aria-label={`${isMcp ? "External action" : "File"} approval`}>
    <div className="approval-heading"><span className="approval-shield"><ShieldCheck size={19} /></span><div><h3>{isMcp ? "Review an external action." : "A quick check before we write."}</h3><p>{isMcp ? "This untrusted external action needs your permission." : "This action needs your permission."}</p></div><span className="approval-tag">YOUR CALL</span></div>
    <div className="approval-file"><FileCode2 size={16} /><strong>{isMcp ? approval.call.name : path}</strong><span>{isMcp ? "Complete arguments" : isEdit ? "Exact replacement" : `${formatBytes(new TextEncoder().encode(content).length)}`}</span></div>
    <details open className="approval-preview"><summary>{isEdit ? "Review exact old and new text" : isMcp ? "Review complete arguments" : "Review exact file contents"}<ChevronRight size={13} /></summary><pre>{JSON.stringify(approval.call.args, null, 2)}</pre></details>
    <p className="approval-note">{isEdit ? "The oldText must match exactly; this does not create or replace the whole file." : isMcp ? "Approves this external action only; it is not a file write." : "Approves only this path and content. If the file exists, it will be replaced."} Expires at {shortTime(approval.expiresAt)}.</p>
    <div className="approval-actions"><span><ShieldCheck size={13} />Nothing happens before approval.</span><button className="button secondary" disabled={busy} onClick={() => onDecision(false)}><X size={14} />Deny</button><button className="button approve" disabled={busy} onClick={() => onDecision(true)}>{busy ? <Spinner /> : <CheckCheck size={15} />}{isMcp ? "Approve action" : "Approve"}</button></div>
  </section>;
}

const starters = [
  { icon: Layers3, label: "Make a plan", description: "Take an idea from a maybe to a next step.", prompt: "Draft a project plan for a small web application.", accent: "peach" },
  { icon: FolderOpen, label: "Explore a workspace", description: "Get your bearings. See what’s already here.", prompt: "Explore the files in this workspace.", accent: "sage" },
  { icon: Sparkles, label: "Meet the harness", description: "A quick tour of how it all works.", prompt: "Explain how the agent harness works.", accent: "lavender" },
  { icon: Code2, label: "Try programmatic tools", description: "Inspect and create a summary with approval.", prompt: "Demonstrate PTC: inspect the workspace and create ptc-summary.md with my approval.", accent: "peach" },
];

export function Welcome({ onPrompt, demo }: { onPrompt: (value: string) => void; demo: boolean }) {
  return <div className="welcome"><div className="welcome-kicker"><span className="status-dot" />A LITTLE STRUCTURE. A LOT OF POSSIBILITY.</div>
    <div className="welcome-title-row"><h1>A workspace for<br /><em>what comes next.</em></h1><div className="orbit-art" aria-hidden="true"><span className="orbit one" /><span className="orbit two" /><span className="orbit three" /><span className="orbit-core"><HarnessMark small /></span><i className="orbit-point a" /><i className="orbit-point b" /></div></div>
    <p className="welcome-description">Think it through. Build it out.<br className="small-only" /> Keep every step in view.</p>
    <div className="starter-heading"><span className="eyebrow">A PLACE TO START</span><span>Or bring your own idea below.</span></div>
    <div className="starter-grid">{starters.map(({ icon: Icon, ...starter }) => <button key={starter.label} className={`starter-card ${starter.accent}`} onClick={() => onPrompt(starter.prompt)}><span className="starter-icon"><Icon size={19} strokeWidth={1.6} /></span><h3>{starter.label}</h3><p>{starter.description}</p><ArrowUpRight size={15} className="starter-arrow" /></button>)}</div>
    <div className="welcome-footnote"><ShieldCheck size={14} /><span>{demo ? "Demo mode is on. No API key, no model charges. File actions are real." : "Your keys stay on the server. Every file write waits for your approval."}</span></div>
  </div>;
}
