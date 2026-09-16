import { randomUUID } from "node:crypto";
import { open, mkdir, readdir, lstat, unlink, writeFile, rename, link } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { harnessSessions } from "@/db/schema";
import { HarnessError } from "@/lib/errors";
import type { Session, SessionSummary } from "@/lib/types";

export interface SessionStore {
  kind: "file" | "postgres";
  list(): Promise<SessionSummary[]>;
  get(id: string): Promise<Session | null>;
  create(session: Session): Promise<Session>;
  update(id: string, change: (draft: Session) => void): Promise<Session>;
  delete(id: string): Promise<boolean>;
  health(): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const RECORD_VERSION = 1;

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Tool arguments are deliberately unknown: providers may return any valid JSON value.
  args: z.unknown(),
});
const agentConfigSchema = z.object({
  provider: z.enum(["demo", "deepseek"]),
  model: z.string(),
  preset: z.enum(["builder", "planner", "reviewer"]),
  systemPrompt: z.string(),
  maxSteps: z.number().int().nonnegative(),
  maxTokens: z.number().int().nonnegative(),
  tools: z.array(z.enum(["list_files", "read_file", "write_file", "update_plan"])),
});
const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
  createdAt: z.string(),
  toolCalls: z.array(toolCallSchema).optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  provider: z.enum(["demo", "deepseek"]).optional(),
  reasoningContent: z.string().optional(),
});
const eventSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  sessionId: z.string(),
  runId: z.string(),
  type: z.enum([
    "run.started", "run.resumed", "run.completed", "run.failed", "run.cancelled", "run.interrupted",
    "message.user", "message.assistant", "step.started", "tool.called", "tool.completed", "tool.failed",
    "approval.requested", "approval.decided", "plan.updated",
  ]),
  timestamp: z.string(),
  data: z.record(z.unknown()),
});
const planItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
});
const approvalSchema = z.object({
  id: z.string(),
  call: toolCallSchema,
  expiresAt: z.string(),
});
const runSchema = z.object({
  id: z.string(),
  status: z.enum(["running", "awaiting_approval", "completed", "cancelled", "failed"]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  step: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  pendingCalls: z.array(toolCallSchema),
  approval: approvalSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  config: agentConfigSchema,
  messages: z.array(messageSchema),
  events: z.array(eventSchema),
  plan: z.array(planItemSchema),
  usage: usageSchema,
  run: runSchema.nullable(),
});

function invalid(message: string): HarnessError {
  return new HarnessError("INVALID_SESSION", message, 400);
}
function corrupt(): HarnessError {
  return new HarnessError("CORRUPT_SESSION", "The stored session is invalid.", 500);
}
function validateId(id: string): string {
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new HarnessError("INVALID_ID", "The session id is invalid.", 400);
  }
  return id;
}

/** Parse and check invariants that are not expressible in the wire type. */
export function validateSession(value: unknown, expectedId?: string): Session {
  const parsed = sessionSchema.safeParse(value);
  if (!parsed.success) throw invalid("The session record is invalid.");
  const session = parsed.data as Session;
  if (!UUID_RE.test(session.id) || (expectedId !== undefined && session.id !== expectedId)) {
    throw invalid("The session id is invalid.");
  }
  let previousSeq: number | undefined;
  for (const event of session.events) {
    if (event.sessionId !== session.id) throw invalid("The event belongs to another session.");
    if (previousSeq !== undefined && event.seq !== previousSeq + 1) {
      throw invalid("The event sequence is invalid.");
    }
    previousSeq = event.seq;
  }
  return session;
}

function cloneSession(session: Session): Session {
  // All persisted values are JSON, so this also ensures callers receive a fresh value.
  return JSON.parse(JSON.stringify(session)) as Session;
}

function summary(session: Session): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    provider: session.config.provider,
    model: session.config.model,
    runStatus: session.run?.status ?? null,
    messageCount: session.messages.length,
  };
}

function encode(session: Session): string {
  try {
    return JSON.stringify({ version: RECORD_VERSION, session });
  } catch {
    throw invalid("The session cannot be serialized.");
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new HarnessError("STORAGE_ERROR", "Session storage is unavailable.", 500);
    }
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch {
      throw new HarnessError("STORAGE_ERROR", "Session storage is unavailable.", 500);
    }
  }
}

async function readRecord(file: string): Promise<Session> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_RECORD_BYTES) throw corrupt();
    const handle = await open(file, "r");
    try {
      const current = await handle.stat();
      if (current.size > MAX_RECORD_BYTES) throw corrupt();
      const text = await handle.readFile({ encoding: "utf8" });
      let envelope: unknown;
      try { envelope = JSON.parse(text); } catch { throw corrupt(); }
      if (!envelope || typeof envelope !== "object" || (envelope as { version?: unknown }).version !== RECORD_VERSION) {
        throw corrupt();
      }
      return validateSession((envelope as { session?: unknown }).session);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HarnessError("NOT_FOUND", "The session was not found.", 404);
    }
    throw corrupt();
  }
}

async function writeAtomic(file: string, value: string, exclusive: boolean): Promise<void> {
  const directory = join(file, "..");
  const temporary = join(directory, `.session-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (exclusive) await link(temporary, file);
    else await rename(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && exclusive) {
      throw new HarnessError("DUPLICATE", "The session already exists.", 409);
    }
    throw new HarnessError("STORAGE_ERROR", "Session storage is unavailable.", 500);
  } finally {
    try { await unlink(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { /* best effort cleanup */ }
    }
  }
}

class FileStore implements SessionStore {
  readonly kind = "file" as const;
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly sessionDir: string) {}

  private async lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(id, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }

  private file(id: string): string { return join(this.sessionDir, `${validateId(id)}.json`); }

  async health(): Promise<void> { await ensureDirectory(this.sessionDir); }

  async list(): Promise<SessionSummary[]> {
    await this.health();
    let entries;
    try { entries = await readdir(this.sessionDir, { withFileTypes: true }); }
    catch { throw new HarnessError("STORAGE_ERROR", "Session storage is unavailable.", 500); }
    const sessions: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) throw corrupt();
      const id = entry.name.slice(0, -5);
      validateId(id);
      sessions.push(summary(await readRecord(join(this.sessionDir, entry.name))));
    }
    sessions.sort((a, b) => {
      const aTime = Date.parse(a.updatedAt);
      const bTime = Date.parse(b.updatedAt);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return sessions;
  }

  async get(id: string): Promise<Session | null> {
    const file = this.file(id);
    try {
      await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new HarnessError("STORAGE_ERROR", "Session storage is unavailable.", 500);
    }
    return cloneSession(await readRecord(file));
  }

  async create(session: Session): Promise<Session> {
    const checked = validateSession(session);
    const file = this.file(checked.id);
    await ensureDirectory(this.sessionDir);
    const value = encode(checked);
    const result = cloneSession(checked);
    await writeAtomic(file, value, true);
    return result;
  }

  async update(id: string, change: (draft: Session) => void): Promise<Session> {
    validateId(id);
    return this.lock(id, async () => {
      const file = this.file(id);
      const current = await readRecord(file);
      const draft = cloneSession(current);
      change(draft);
      const checked = validateSession(draft, id);
      checked.updatedAt = new Date().toISOString();
      const result = cloneSession(checked);
      await writeAtomic(file, encode(checked), false);
      return result;
    });
  }

  async delete(id: string): Promise<boolean> {
    validateId(id);
    return this.lock(id, async () => {
      const file = this.file(id);
      try {
        const info = await lstat(file);
        if (info.isSymbolicLink() || !info.isFile()) throw corrupt();
        await unlink(file);
        return true;
      } catch (error) {
        if (error instanceof HarnessError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new HarnessError("STORAGE_ERROR", "Session storage is unavailable.", 500);
      }
    });
  }
}

export function FileSessionStore(sessionDir: string): SessionStore {
  return new FileStore(sessionDir);
}

function databaseError(error: unknown): never {
  if (error instanceof HarnessError) throw error;
  const code = (error as { code?: string }).code;
  if (code === "23505") throw new HarnessError("DUPLICATE", "The session already exists.", 409);
  throw new HarnessError("STORAGE_ERROR", "Session storage is unavailable.", 500);
}

function dbSession(row: { payload: unknown }): Session {
  try { return validateSession(row.payload); }
  catch { throw corrupt(); }
}

export function PostgresSessionStore(db: ReturnType<typeof getDb>): SessionStore {
  return new PostgresStore(db);
}

class PostgresStore implements SessionStore {
  readonly kind = "postgres" as const;
  constructor(private readonly db: ReturnType<typeof getDb>) {}

  async health(): Promise<void> {
    try { await this.db.select({ id: harnessSessions.id }).from(harnessSessions).limit(1); }
    catch { throw new HarnessError("STORAGE_ERROR", "Session storage is unavailable.", 500); }
  }

  async list(): Promise<SessionSummary[]> {
    try {
      const rows = await this.db.select().from(harnessSessions).orderBy(desc(harnessSessions.updatedAt));
      return rows.map((row) => summary(dbSession(row)));
    } catch (error) { return databaseError(error); }
  }

  async get(id: string): Promise<Session | null> {
    validateId(id);
    try {
      const rows = await this.db.select().from(harnessSessions).where(eq(harnessSessions.id, id)).limit(1);
      return rows.length === 0 ? null : cloneSession(dbSession(rows[0]));
    } catch (error) { return databaseError(error); }
  }

  async create(session: Session): Promise<Session> {
    const checked = validateSession(session);
    try {
      await this.db.insert(harnessSessions).values({
        id: checked.id,
        title: checked.title,
        createdAt: new Date(checked.createdAt),
        updatedAt: new Date(checked.updatedAt),
        payload: checked,
      });
      return cloneSession(checked);
    } catch (error) { return databaseError(error); }
  }

  async update(id: string, change: (draft: Session) => void): Promise<Session> {
    validateId(id);
    try {
      const result = await this.db.transaction(async (tx) => {
        const rows = await tx.select().from(harnessSessions).where(eq(harnessSessions.id, id)).for("update");
        if (rows.length === 0) throw new HarnessError("NOT_FOUND", "The session was not found.", 404);
        const draft = cloneSession(dbSession(rows[0]));
        change(draft);
        const checked = validateSession(draft, id);
        checked.updatedAt = new Date().toISOString();
        await tx.update(harnessSessions).set({
          title: checked.title,
          updatedAt: new Date(checked.updatedAt),
          payload: checked,
        }).where(eq(harnessSessions.id, id));
        return checked;
      });
      return cloneSession(result);
    } catch (error) { return databaseError(error); }
  }

  async delete(id: string): Promise<boolean> {
    validateId(id);
    try {
      const result = await this.db.delete(harnessSessions).where(eq(harnessSessions.id, id));
      return (result.rowCount ?? 0) > 0;
    } catch (error) { return databaseError(error); }
  }
}
