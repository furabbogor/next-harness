"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, AlertCircle, ArrowDown, ArrowUp, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, Download, FlaskConical, LayoutGrid, LockKeyhole, Menu, MessageSquare, PanelRight, Paperclip, Pencil, Plus, Search, Settings2, ShieldCheck, Square, Trash2, X } from "lucide-react";
import type { AgentConfig, PublicConfig, Session, SessionSummary, WorkspaceFile } from "@/lib/types";
import { DEFAULT_CONFIG, PRESETS } from "@/lib/settings";
import { configSchema } from "@/lib/validation";
import { ApiError, checkResponse, consumeRun, errorMessage, requestJson } from "@/lib/client-api";
import { ApprovalCard, ChatMessage, StreamingMessage, Welcome } from "./chat-view";
import { AddFileDialog, DeleteDialog, FileDialog, HelpDialog, RenameDialog, SettingsDialog, UnlockScreen } from "./dialogs";
import { Inspector, type InspectorTab } from "./inspector";
import { HarnessMark, IconButton, Spinner } from "./ui";

const LAST_SESSION = "next-harness:last-session";
const DEFAULTS_KEY = "next-harness:defaults";
type FilePreview = { path: string; content: string; bytes: number };

export function WorkspaceApp() {
  const [publicConfig, setPublicConfig] = useState<PublicConfig | null>(null);
  const [newConfig, setNewConfig] = useState<AgentConfig>(DEFAULT_CONFIG);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [booting, setBooting] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panelVisible, setPanelVisible] = useState(true);
  const [mobilePanel, setMobilePanel] = useState(false);
  const [tab, setTab] = useState<InspectorTab>("run");
  const [dialog, setDialog] = useState<"settings" | "help" | "add-file" | "rename" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [openingFile, setOpeningFile] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const selectedId = useRef<string | null>(null);
  const busyRef = useRef(false);
  const streamController = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);
  const bootVersion = useRef(0);
  const selectionVersion = useRef(0);

  const config = session?.config ?? newConfig;
  const running = session?.run?.status === "running";
  const awaiting = session?.run?.status === "awaiting_approval";
  const lockedForEdits = busy || running || awaiting;
  const activeId = session?.id;
  const runStatus = session?.run?.status;

  const reportError = useCallback((value: unknown) => {
    setError(errorMessage(value));
    if (value instanceof ApiError && value.status === 401) setLocked(true);
  }, []);

  const refreshSessions = useCallback(async () => {
    const result = await requestJson<{ sessions: SessionSummary[] }>("/api/sessions");
    setSessions(result.sessions);
    return result.sessions;
  }, []);

  const refreshFiles = useCallback(async (id: string) => {
    const result = await requestJson<{ files: WorkspaceFile[] }>(`/api/sessions/${id}/files`);
    if (selectedId.current === id) setFiles(result.files);
  }, []);

  const selectSession = useCallback(async (id: string) => {
    if (busyRef.current) return;
    const version = ++selectionVersion.current;
    selectedId.current = id;
    setSession(null); setFiles([]); setSessionLoading(true); setFilesLoading(true); setError(""); setStreamText(""); setInput(""); setSidebarOpen(false);
    stickToBottom.current = true;
    try {
      const result = await requestJson<{ session: Session }>(`/api/sessions/${id}`);
      if (version !== selectionVersion.current) return;
      setSession(result.session);
      window.history.replaceState(null, "", `/?session=${id}`);
      localStorage.setItem(LAST_SESSION, id);
      await refreshFiles(id);
    } catch (error) { if (version === selectionVersion.current) reportError(error); }
    finally { if (version === selectionVersion.current) { setSessionLoading(false); setFilesLoading(false); } }
  }, [refreshFiles, reportError]);

  const bootstrap = useCallback(async (signal?: AbortSignal) => {
    const version = ++bootVersion.current;
    try {
      const auth = await requestJson<{ required: boolean; authenticated: boolean }>("/api/auth", { signal });
      if (version !== bootVersion.current || signal?.aborted) return;
      if (auth.required && !auth.authenticated) { setLocked(true); return; }
      setLocked(false);
      const [settings, index] = await Promise.all([requestJson<PublicConfig>("/api/config", { signal }), requestJson<{ sessions: SessionSummary[] }>("/api/sessions", { signal })]);
      if (version !== bootVersion.current || signal?.aborted) return;
      setPublicConfig(settings); setSessions(index.sessions);
      let defaults = settings.defaultConfig;
      try { const saved = localStorage.getItem(DEFAULTS_KEY); if (saved) { const result = configSchema.safeParse(JSON.parse(saved)); if (result.success) defaults = result.data; } }
      catch { /* A stale local preference never prevents the workspace from opening. */ }
      setNewConfig(defaults);
      const requested = new URLSearchParams(window.location.search).get("session") ?? localStorage.getItem(LAST_SESSION);
      if (requested && index.sessions.some((item) => item.id === requested)) await selectSession(requested);
    } catch (error) { if (version === bootVersion.current && !signal?.aborted) reportError(error); }
    finally { if (version === bootVersion.current && !signal?.aborted) setBooting(false); }
  }, [reportError, selectSession]);

  useEffect(() => { const controller = new AbortController(); const frame = requestAnimationFrame(() => { void bootstrap(controller.signal); }); return () => { cancelAnimationFrame(frame); controller.abort(); }; }, [bootstrap]);
  useEffect(() => () => { streamController.current?.abort(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSidebarOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }
      if (event.key === "Escape") { setSidebarOpen(false); setMobilePanel(false); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { const textarea = inputRef.current; if (textarea) { textarea.style.height = "auto"; textarea.style.height = `${Math.min(180, Math.max(56, textarea.scrollHeight))}px`; } }, [input]);
  useEffect(() => { if (stickToBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [session?.messages.length, session?.run?.status, streamText]);
  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(""), 3500); return () => clearTimeout(timeout); }, [notice]);
  useEffect(() => {
    if (!activeId || runStatus !== "running" || busy) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const result = await requestJson<{ session: Session }>(`/api/sessions/${activeId}`);
        if (!cancelled && selectedId.current === activeId) { setSession(result.session); if (result.session.run?.status !== "running") { await refreshFiles(activeId); await refreshSessions(); } }
      } catch (error) { clearInterval(timer); if (!cancelled) reportError(error); }
    }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeId, runStatus, busy, refreshFiles, refreshSessions, reportError]);

  function startNewSession() {
    if (busyRef.current) return;
    selectionVersion.current++; selectedId.current = null;
    setSession(null); setFiles([]); setInput(""); setError(""); setQuery(""); setStreamText(""); setSessionLoading(false); setSidebarOpen(false); setTab("run");
    localStorage.removeItem(LAST_SESSION); window.history.replaceState(null, "", "/");
    stickToBottom.current = true; inputRef.current?.focus();
  }

  async function ensureSession(): Promise<Session> {
    if (session) return session;
    const result = await requestJson<{ session: Session }>("/api/sessions", { method: "POST", body: JSON.stringify({ config: newConfig }) });
    selectedId.current = result.session.id; setSession(result.session);
    localStorage.setItem(LAST_SESSION, result.session.id); window.history.replaceState(null, "", `/?session=${result.session.id}`);
    await refreshSessions();
    return result.session;
  }

  async function streamAction(id: string, url: string, payload: unknown, clearInput = false) {
    const controller = new AbortController(); streamController.current = controller;
    try {
      const response = await checkResponse(await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal }));
      if (clearInput) setInput("");
      await consumeRun(response, (event) => {
        if (selectedId.current !== id) return;
        if (event.type === "token") setStreamText((current) => current + event.data.text);
        else if (event.type === "snapshot") { setSession(event.data); setStreamText(""); }
        else if (event.type === "event") setSession((current) => {
          if (!current || current.id !== id || current.events.some((item) => item.id === event.data.id)) return current;
          return { ...current, events: [...current.events, event.data], ...(event.data.type === "step.started" && current.run ? { run: { ...current.run, step: Number(event.data.data.step) } } : {}) };
        });
        else if (event.type === "error") setError(event.data.message);
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) reportError(error);
    } finally {
      streamController.current = null;
      try {
        const result = await requestJson<{ session: Session }>(`/api/sessions/${id}`);
        if (selectedId.current === id) setSession(result.session);
        await Promise.all([refreshSessions(), refreshFiles(id)]);
      } catch (error) { reportError(error); }
      setStreamText(""); setBusy(false); busyRef.current = false; setStopping(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const content = input.trim();
    if (!content || busyRef.current || running || awaiting || booting || sessionLoading || !publicConfig) return;
    busyRef.current = true; setBusy(true); setError(""); setStreamText(""); stickToBottom.current = true;
    try { const target = await ensureSession(); await streamAction(target.id, `/api/sessions/${target.id}/run`, { content }, true); }
    catch (error) { reportError(error); busyRef.current = false; setBusy(false); }
  }

  async function decideApproval(approved: boolean) {
    const approval = session?.run?.approval;
    if (!session || !approval || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); stickToBottom.current = true;
    await streamAction(session.id, `/api/sessions/${session.id}/approvals/${approval.id}`, { approved });
  }

  async function stopRun() {
    if (!session || stopping) return;
    setStopping(true);
    try { const result = await requestJson<{ session: Session }>(`/api/sessions/${session.id}/cancel`, { method: "POST" }); setSession(result.session); if (!busy) { await refreshSessions(); setNotice("Run stopped. Completed file writes are not undone."); } }
    catch (error) { reportError(error); }
    finally { setStopping(false); }
  }

  async function openFile(path: string) {
    if (!session) return;
    setOpeningFile(true); setError("");
    try { const result = await requestJson<{ file: FilePreview }>(`/api/sessions/${session.id}/files?path=${encodeURIComponent(path)}`); setPreview(result.file); }
    catch (error) { reportError(error); }
    finally { setOpeningFile(false); }
  }

  function openInspector(nextTab?: InspectorTab) {
    if (nextTab) setTab(nextTab);
    if (window.matchMedia("(max-width: 1100px)").matches) setMobilePanel(true);
    else setPanelVisible(nextTab ? true : !panelVisible);
  }

  const filteredSessions = useMemo(() => sessions.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())), [sessions, query]);
  const visibleMessages = session?.messages.filter((message) => message.role !== "tool") ?? [];
  const completedSteps = session?.plan.filter((item) => item.status === "completed").length ?? 0;

  if (locked) return <UnlockScreen error={error} onUnlock={async (token) => {
    setError(""); try { await requestJson("/api/auth", { method: "POST", body: JSON.stringify({ token }) }); setLocked(false); await bootstrap(); } catch (error) { reportError(error); }
  }} />;

  return <div className="app-shell">
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`} aria-label="Main navigation"><div className="brand"><HarnessMark /><span>next<span className="brand-light">harness</span><small>THE AGENT WORKSPACE</small></span><span className="beta-badge">BETA</span></div>
      <button className="new-session-button" disabled={busy || booting} onClick={startNewSession}><Plus size={18} /><span>New session</span><span className="new-session-symbol">↗</span></button>
      <div className="sidebar-search"><Search size={14} /><input ref={searchRef} aria-label="Search sessions" placeholder="Find a session…" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>⌘ K</kbd></div>
      <nav className="sidebar-nav"><button className="active" onClick={() => { setSidebarOpen(false); }}><LayoutGrid size={16} /><span>Workspace</span><span className="nav-dot" /></button><button onClick={() => { openInspector("events"); setSidebarOpen(false); }}><Activity size={16} /><span>Activity</span>{session?.events.length ? <small>{session.events.length}</small> : null}</button></nav>
      <div className="sessions-heading"><span>RECENT SESSIONS</span><span>{sessions.length.toString().padStart(2, "0")}</span></div><div className="session-list">{booting ? <div className="sidebar-empty"><Spinner label="Loading sessions" /><p>Opening your workspace…</p></div> : filteredSessions.length ? filteredSessions.map((item) => <div key={item.id} className={`session-item ${session?.id === item.id ? "selected" : ""}`}><button className="session-select" disabled={busy} onClick={() => void selectSession(item.id)}><MessageSquare size={15} /><span><strong>{item.title}</strong><small>{item.runStatus === "awaiting_approval" ? "Needs your approval" : item.runStatus === "running" ? "Running" : item.provider === "demo" ? "Demo session" : "DeepSeek session"}</small></span>{item.runStatus === "awaiting_approval" && <i className="approval-dot" />}</button><IconButton label={`Delete ${item.title}`} className="session-delete" disabled={busy} onClick={() => setDeleteTarget(item)}><Trash2 size={13} /></IconButton></div>) : <div className="sidebar-empty"><MessageSquare size={21} strokeWidth={1.3} /><p>{query ? "No matching sessions." : "A fresh start looks good on you."}</p><span>{query ? "Try another word." : "Your conversations will live here."}</span></div>}</div>
      <div className="sidebar-bottom"><div className="sidebar-tip"><span className="tip-icon"><ShieldCheck size={16} /></span><p>You set the direction.<br /><strong>You approve the changes.</strong></p></div><button className="sidebar-help" onClick={() => setDialog("help")}><BookOpen size={15} /><span>A quick orientation</span><ArrowUpRight size={14} /></button><div className="local-workspace"><span className="workspace-avatar">N</span><div><strong>Local workspace</strong><span><i className={publicConfig ? "connected" : ""} />{publicConfig ? publicConfig.storage === "file" ? "File storage connected" : "PostgreSQL connected" : "Connecting…"}</span></div>{publicConfig?.protected ? <IconButton label="Lock workspace" onClick={async () => { try { await requestJson("/api/auth", { method: "DELETE" }); streamController.current?.abort(); setSession(null); setSessions([]); setFiles([]); setLocked(true); setError(""); } catch (error) { reportError(error); } }}><LockKeyhole size={15} /></IconButton> : <IconButton label="Workspace help" onClick={() => setDialog("help")}><CircleHelp size={16} /></IconButton>}</div></div>
    </aside>
    <div className="workspace-shell"><header className="topbar"><div className="topbar-left"><IconButton label="Open navigation" className="mobile-menu" onClick={() => setSidebarOpen(true)}><Menu size={19} /></IconButton><div className="breadcrumbs"><LayoutGrid size={14} /><span>Workspace</span><ChevronRight size={12} /><button onClick={() => { if (session) setDialog("rename"); }} disabled={!session || busy}>{session?.title ?? "New session"}</button></div></div><div className="topbar-actions"><span className={`provider-badge ${config.provider === "demo" ? "demo" : "live"}`}>{config.provider === "demo" ? <FlaskConical size={12} /> : <span className="status-dot" />}{config.provider === "demo" ? "Demo mode" : "DeepSeek"}</span><span className="topbar-divider" />{session && <><IconButton label="Rename session" disabled={busy} onClick={() => setDialog("rename")}><Pencil size={15} /></IconButton><a className="icon-button" aria-label="Export session" title="Export session JSON" href={`/api/sessions/${session.id}/export`}><Download size={16} /></a></>}<IconButton label="Agent settings" disabled={!publicConfig || lockedForEdits} onClick={() => setDialog("settings")}><Settings2 size={17} /></IconButton><IconButton label="Toggle inspector" className={panelVisible ? "is-active" : ""} onClick={() => openInspector()}><PanelRight size={17} /></IconButton></div></header>
      <div className="workbench"><main className="main-column" id="main-content">
        {(error || notice) && <div className={`app-alert ${error ? "alert-error" : "alert-success"}`} role={error ? "alert" : "status"}>{error ? <AlertCircle size={15} /> : <Check size={15} />}<span>{error || notice}</span>{error && !publicConfig && <button onClick={() => void bootstrap()}>Retry</button>}<IconButton label="Dismiss notification" onClick={() => { setError(""); setNotice(""); }}><X size={14} /></IconButton></div>}
        <div className={`transcript-scroll ${visibleMessages.length ? "has-messages" : ""}`} ref={scrollRef} onScroll={(event) => { const target = event.currentTarget; const near = target.scrollHeight - target.scrollTop - target.clientHeight < 140; stickToBottom.current = near; setShowJump(!near); }}>
          {booting || sessionLoading ? <div className="workspace-loading"><div className="loading-mark"><HarnessMark /></div><Spinner /><p>{sessionLoading ? "Opening your session…" : "A moment to get things ready…"}</p></div> : visibleMessages.length && session ? <div className="transcript"><div className="session-start-marker"><span /><span>THE START OF SOMETHING</span><span /></div>{visibleMessages.map((message) => <ChatMessage key={message.id} message={message} session={session} onFile={(path) => void openFile(path)} />)}{busy && !awaiting && <StreamingMessage text={streamText} />}{!busy && running && <div className="run-reconnecting"><Spinner /><span>Waiting for this run to settle. Saved progress refreshes automatically.</span></div>}{session.run?.approval && <ApprovalCard approval={session.run.approval} busy={busy} onDecision={(approved) => void decideApproval(approved)} />}{session.run?.status === "failed" && session.run.error && <div className="run-result run-result-error"><AlertCircle size={16} /><div><strong>This run needs a fresh start.</strong><p>{session.run.error.message}</p></div></div>}{session.run?.status === "cancelled" && <div className="run-result"><Square size={12} /><p>Run stopped. Saved progress is kept; completed writes are not undone.</p></div>}{session.run?.status === "completed" && <div className="run-result run-result-complete"><Check size={14} /><span>Run complete</span><i />{session.run.step} model step{session.run.step === 1 ? "" : "s"}<i />{session.run.toolCount} tool call{session.run.toolCount === 1 ? "" : "s"}{session.plan.length > 0 && <><i />{completedSteps}/{session.plan.length} plan steps</>}</div>}</div> : <Welcome demo={config.provider === "demo"} onPrompt={(value) => { setInput(value); inputRef.current?.focus(); }} />}
        </div>
        {showJump && <button className="jump-latest" onClick={() => { stickToBottom.current = true; scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }}><ArrowDown size={14} />Latest</button>}
        <div className="composer-area"><form className={`composer ${busy ? "composer-busy" : ""}`} onSubmit={(event) => void sendMessage(event)}><label htmlFor="agent-message" className="visually-hidden">Message your agent</label><textarea id="agent-message" ref={inputRef} placeholder={awaiting ? "Your agent is waiting for a decision above…" : "Give your agent a task. Make it a good one."} value={input} onChange={(event) => setInput(event.target.value)} maxLength={20000} rows={2} disabled={booting || sessionLoading} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} /><div className="composer-toolbar"><div className="composer-tools"><button type="button" className="preset-switch" disabled={!publicConfig || lockedForEdits} onClick={() => setDialog("settings")}><span className="preset-dot" />{PRESETS[config.preset].label}<ChevronDown size={12} /></button><span className="composer-divider" /><IconButton label="Add context file" disabled={lockedForEdits || booting} onClick={() => setDialog("add-file")}><Paperclip size={16} /></IconButton><button type="button" className="workspace-file-link" onClick={() => openInspector("files")}><span>{files.length ? `${files.length} workspace file${files.length === 1 ? "" : "s"}` : "Add a little context"}</span></button></div><div className="composer-send-group">{input.length > 18000 && <span className="character-count">{input.length.toLocaleString()}/20,000</span>}{busy || running || awaiting ? <button type="button" className="stop-button" aria-label="Stop run" onClick={() => void stopRun()} disabled={stopping}>{stopping ? <Spinner /> : <Square size={12} fill="currentColor" />}<span>Stop</span></button> : <button className="send-button" aria-label="Send message" disabled={!input.trim() || booting || sessionLoading || !publicConfig}><ArrowUp size={20} /></button>}</div></div></form><div className="composer-caption"><span><kbd>↵</kbd> Send <i /> <kbd>shift ↵</kbd> New line</span><span><ShieldCheck size={11} />{config.provider === "demo" ? "Scripted demo. Real file actions." : "Every write asks first."}</span></div></div>
      </main>
      {mobilePanel && <button className="inspector-backdrop" aria-label="Close inspector overlay" onClick={() => setMobilePanel(false)} />}
      <div className={`inspector-shell ${panelVisible ? "desktop-visible" : ""} ${mobilePanel ? "mobile-visible" : ""}`}><Inspector session={session} config={config} publicConfig={publicConfig} tab={tab} onTab={setTab} onClose={() => { setPanelVisible(false); setMobilePanel(false); }} onSettings={() => { if (!lockedForEdits && publicConfig) setDialog("settings"); }} files={files} filesLoading={filesLoading} filesLocked={lockedForEdits || booting} onAddFile={() => setDialog("add-file")} onFile={(path) => void openFile(path)} /></div>
      </div>
    </div>
    {dialog === "settings" && publicConfig && <SettingsDialog config={config} publicConfig={publicConfig} existing={Boolean(session)} onClose={() => setDialog(null)} onSave={async (value) => {
      if (session) { const result = await requestJson<{ session: Session }>(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ config: value }) }); setSession(result.session); await refreshSessions(); }
      else { setNewConfig(value); localStorage.setItem(DEFAULTS_KEY, JSON.stringify(value)); }
      setNotice("Agent settings saved.");
    }} />}
    {dialog === "add-file" && <AddFileDialog onClose={() => setDialog(null)} onSave={async (path, content) => { const target = await ensureSession(); await requestJson(`/api/sessions/${target.id}/files`, { method: "POST", body: JSON.stringify({ path, content }) }); await refreshFiles(target.id); setTab("files"); setPanelVisible(true); setNotice("File saved to this session’s workspace."); }} />}
    {dialog === "help" && <HelpDialog onClose={() => setDialog(null)} />}
    {dialog === "rename" && session && <RenameDialog title={session.title} onClose={() => setDialog(null)} onSave={async (title) => { const result = await requestJson<{ session: Session }>(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ title }) }); setSession(result.session); await refreshSessions(); }} />}
    {deleteTarget && <DeleteDialog title={deleteTarget.title} onClose={() => setDeleteTarget(null)} onDelete={async () => { await requestJson(`/api/sessions/${deleteTarget.id}`, { method: "DELETE" }); if (selectedId.current === deleteTarget.id) startNewSession(); await refreshSessions(); setNotice("Session and workspace files deleted."); }} />}
    {preview && session && <FileDialog file={preview} sessionId={session.id} onClose={() => setPreview(null)} />}
    {openingFile && <div className="file-opening" role="status"><Spinner />Opening file…</div>}
  </div>;
}
