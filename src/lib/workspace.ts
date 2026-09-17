import { randomUUID } from "node:crypto";
import { mkdir, readdir, lstat, open, rename, unlink, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError } from "@/lib/errors";
import type { WorkspaceFile } from "@/lib/types";

export type Workspace = ReturnType<typeof Workspace>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_FILES = 100;
const MAX_PATH_LENGTH = 512;
const MAX_DEPTH = 16;
const SAFE_EXTENSIONS = new Set(["md", "txt", "json", "ts", "tsx", "js", "jsx", "css", "html", "csv", "yaml", "yml", "toml", "sql", "xml", "svg"]);

function workspaceError(code: string, message: string, status = 400): HarnessError {
  return new HarnessError(code, message, status);
}
function validateSessionId(id: string): string {
  if (typeof id !== "string" || !UUID_RE.test(id)) throw workspaceError("INVALID_ID", "The session id is invalid.");
  return id;
}

/** Validate a model-supplied workspace path without resolving it against the host filesystem. */
export function validateWorkspacePath(relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > MAX_PATH_LENGTH) {
    throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
  }
  if (relativePath.includes("\\") || relativePath.includes("\0") || relativePath.startsWith("/")) {
    throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
  }
  // A drive-qualified path is absolute on Windows even when this process is Unix.
  if (/^[A-Za-z]:/.test(relativePath)) throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
  const segments = relativePath.split("/");
  if (segments.length === 0 || segments.length > MAX_DEPTH || segments.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
  }
  const file = segments[segments.length - 1];
  const extension = file.includes(".") ? file.slice(file.lastIndexOf(".") + 1).toLowerCase() : "";
  if (!SAFE_EXTENSIONS.has(extension)) throw workspaceError("UNSUPPORTED_FILE", "Only text workspace files are allowed.");
  if (segments.some((segment) => segment.length > 255)) throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
  return segments.join("/");
}

function bytesFor(content: string): number {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_CONTENT_BYTES) throw workspaceError("CONTENT_TOO_LARGE", "The workspace file is too large.", 413);
  return bytes;
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw workspaceError("WORKSPACE_ERROR", "The workspace is unavailable.", 500);
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const existing = await safeLstat(path);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
    return;
  }
  try { await mkdir(path, { recursive: true, mode: 0o700 }); }
  catch { throw workspaceError("WORKSPACE_ERROR", "The workspace is unavailable.", 500); }
  const after = await safeLstat(path);
  if (!after || after.isSymbolicLink() || !after.isDirectory()) throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
}

async function ensureRoot(root: string): Promise<void> {
  await ensureDirectory(root);
}

async function ensureSessionDirectory(root: string, sessionId: string, create: boolean): Promise<string | null> {
  validateSessionId(sessionId);
  await ensureRoot(root);
  const directory = join(root, sessionId);
  const info = await safeLstat(directory);
  if (!info) {
    if (!create) return null;
    await ensureDirectory(directory);
  } else if (info.isSymbolicLink() || !info.isDirectory()) {
    throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
  }
  return directory;
}

async function ensureNoSymlinkParents(directory: string): Promise<void> {
  const rootInfo = await safeLstat(directory);
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
}

async function ensureNestedDirectory(base: string, segments: string[]): Promise<string> {
  let current = base;
  for (const segment of segments) {
    current = join(current, segment);
    await ensureDirectory(current);
    await ensureNoSymlinkParents(current);
  }
  return current;
}

async function checkNestedDirectory(base: string, segments: string[]): Promise<string> {
  let current = base;
  for (const segment of segments) {
    current = join(current, segment);
    await ensureNoSymlinkParents(current);
  }
  return current;
}

function validateDirectoryPath(relative: string): void {
  if (relative.length > MAX_PATH_LENGTH) throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
  const segments = relative.split("/");
  if (segments.length > MAX_DEPTH || segments.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
  }
}

async function readText(file: string): Promise<{ content: string; bytes: number }> {
  const info = await safeLstat(file);
  if (!info) throw workspaceError("NOT_FOUND", "The workspace file was not found.", 404);
  if (info.isSymbolicLink() || !info.isFile()) throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
  if (info.size > MAX_CONTENT_BYTES) throw workspaceError("CONTENT_TOO_LARGE", "The workspace file is too large.", 413);
  const handle = await open(file, "r");
  try {
    const current = await handle.stat();
    if (current.size > MAX_CONTENT_BYTES) throw workspaceError("CONTENT_TOO_LARGE", "The workspace file is too large.", 413);
    const buffer = await handle.readFile();
    if (buffer.length > MAX_CONTENT_BYTES) throw workspaceError("CONTENT_TOO_LARGE", "The workspace file is too large.", 413);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { throw workspaceError("INVALID_CONTENT", "The workspace file is not valid UTF-8."); }
    return { content, bytes: buffer.length };
  } finally { await handle.close(); }
}

async function listDirectory(directory: string, prefix: string, found: WorkspaceFile[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
    if (entry.isDirectory()) {
      validateDirectoryPath(relative);
      await listDirectory(absolute, relative, found);
    } else if (entry.isFile()) {
      validateWorkspacePath(relative);
      const data = await readText(absolute);
      found.push({ path: relative, bytes: data.bytes, updatedAt: (await lstat(absolute)).mtime.toISOString() });
      if (found.length > MAX_FILES) throw workspaceError("WORKSPACE_LIMIT", "The workspace contains too many files.", 413);
    } else {
      throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
    }
  }
}

export function Workspace(workspaceRoot: string) {
  async function list(sessionId: string): Promise<WorkspaceFile[]> {
    const directory = await ensureSessionDirectory(workspaceRoot, sessionId, false);
    if (!directory) return [];
    const files: WorkspaceFile[] = [];
    await listDirectory(directory, "", files);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }

  async function read(sessionId: string, relativePath: string): Promise<{ path: string; content: string; bytes: number }> {
    const path = validateWorkspacePath(relativePath);
    const directory = await ensureSessionDirectory(workspaceRoot, sessionId, false);
    if (!directory) throw workspaceError("NOT_FOUND", "The workspace file was not found.", 404);
    await ensureNoSymlinkParents(directory);
    const parts = path.split("/");
    await checkNestedDirectory(directory, parts.slice(0, -1));
    const absolute = join(/* turbopackIgnore: true */ directory, ...parts);
    const data = await readText(absolute);
    return { path, ...data };
  }

  async function write(sessionId: string, relativePath: string, content: string): Promise<WorkspaceFile> {
    const path = validateWorkspacePath(relativePath);
    if (typeof content !== "string") throw workspaceError("INVALID_CONTENT", "The workspace content is invalid.");
    const bytes = bytesFor(content);
    const directory = await ensureSessionDirectory(workspaceRoot, sessionId, true) as string;
    const parts = path.split("/");
    const parent = await ensureNestedDirectory(directory, parts.slice(0, -1));
    const absolute = join(/* turbopackIgnore: true */ directory, ...parts);
    await ensureNoSymlinkParents(parent);
    const existing = await safeLstat(absolute);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
    const existingFiles = await list(sessionId);
    if (!existing && existingFiles.length >= MAX_FILES) throw workspaceError("WORKSPACE_LIMIT", "The workspace contains too many files.", 413);
    const temporary = join(parent, `.workspace-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, absolute);
    } catch {
      throw workspaceError("WORKSPACE_ERROR", "The workspace is unavailable.", 500);
    } finally {
      try { await unlink(temporary); } catch { /* best effort cleanup */ }
    }
    const info = await lstat(absolute);
    return { path, bytes, updatedAt: info.mtime.toISOString() };
  }

  async function removeSession(sessionId: string): Promise<void> {
    const directory = await ensureSessionDirectory(workspaceRoot, sessionId, false);
    if (!directory) return;
    const info = await safeLstat(directory);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) throw workspaceError("INVALID_PATH", "The workspace path is invalid.");
    try { await rm(directory, { recursive: true, force: false }); }
    catch { throw workspaceError("WORKSPACE_ERROR", "The workspace is unavailable.", 500); }
  }

  return { list, read, write, removeSession };
}
