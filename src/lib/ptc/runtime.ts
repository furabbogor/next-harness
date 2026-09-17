import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_PTC_LIMITS,
  isFrame,
  isStrictJson,
  jsonByteLength,
  normalizePtcLimits,
  safeError,
  type PtcLimits,
  type StrictJson,
} from "./protocol";

export interface PtcOptions {
  code: string;
  toolNames: string[];
  signal: AbortSignal;
  invoke: (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
  onLog?: (line: string) => void;
  limits?: PtcLimits;
}

export interface PtcResult {
  status: "completed" | "failed";
  value?: unknown;
  logs: string[];
  error?: { code: string; message: string };
  durationMs: number;
  sandbox: { engine: "quickjs-wasm"; process: "child"; directHostAccess: false; network: false; osSandbox: false };
}

const SANDBOX: PtcResult["sandbox"] = {
  engine: "quickjs-wasm",
  process: "child",
  directHostAccess: false,
  network: false,
  osSandbox: false,
};
const KILL_GRACE_MS = 250;

function failed(logs: string[], started: number, code: string, message: string): PtcResult {
  return { status: "failed", logs, error: { code, message }, durationMs: Math.round(performance.now() - started), sandbox: SANDBOX };
}

function validToolNames(names: string[]): boolean {
  return names.length <= 1_000 && new Set(names).size === names.length && names.every((name) => typeof name === "string" && name.length > 0 && name.length <= 128);
}

/** Runs model-authored code in a fresh QuickJS-WASM child process. */
export async function runPtc(options: PtcOptions): Promise<PtcResult> {
  const started = performance.now();
  const logs: string[] = [];
  const limits = normalizePtcLimits(options.limits);
  if (typeof options.code !== "string") return failed(logs, started, "INVALID_CODE", "The script must be text.");
  if (!limits) return failed(logs, started, "INVALID_LIMITS", "The requested runtime limits are invalid.");
  if (!validToolNames(options.toolNames)) return failed(logs, started, "INVALID_TOOLS", "The visible tool list is invalid.");
  if (Buffer.byteLength(options.code, "utf8") > limits.maxCodeBytes) return failed(logs, started, "CODE_LIMIT", "The script exceeds the code-size limit.");
  if (options.signal.aborted) return failed(logs, started, "CANCELLED", "The run was stopped.");

  return new Promise<PtcResult>((resolveResult) => {
    const childSignal = new AbortController();
    let child: ChildProcess | undefined;
    let settled = false;
    let calls = 0;
    let pendingCalls = 0;
    let outputBytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;

    const closeChild = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      // `killed` only means a signal was sent, not that the process exited.
      killTimer = setTimeout(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, KILL_GRACE_MS);
      killTimer.unref();
    };
    const finish = (result: PtcResult) => {
      if (settled) return;
      settled = true;
      childSignal.abort();
      if (wallTimer) clearTimeout(wallTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
      closeChild();
      resolveResult(result);
    };
    const stop = (code: string, message: string) => finish(failed(logs, started, code, message));
    const onAbort = () => stop("CANCELLED", "The run was stopped.");

    try {
      child = fork(resolve(process.cwd(), "runtime", "ptc-worker.mjs"), [], {
        serialization: "json",
        // Avoid inheriting debuggers, loaders, and other parent Node execution hooks.
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        // Do not pass application configuration, credentials, or arbitrary parent env values.
        env: { NODE_ENV: process.env.NODE_ENV === "development" ? "development" : "production", PATH: process.env.PATH ?? "" },
      });
    } catch {
      finish(failed(logs, started, "WORKER_START", "The script runtime could not be started."));
      return;
    }

    wallTimer = setTimeout(() => stop("WALL_TIMEOUT", "The script exceeded its wall-clock limit."), limits.timeoutMs);
    wallTimer.unref();
    options.signal.addEventListener("abort", onAbort, { once: true });

    const send = (message: StrictJson) => {
      if (settled || !child?.connected || !isFrame(message)) return false;
      try { child.send(message); return true; } catch { stop("IPC_ERROR", "The script runtime stopped unexpectedly."); return false; }
    };
    const sendToolError = (id: string, error: { code: string; message: string }) => send({ type: "tool_result", id, ok: false, error });
    const invoke = async (id: string, name: string, args: StrictJson) => {
      try {
        const value = await options.invoke(name, args, childSignal.signal);
        if (settled || childSignal.signal.aborted) return;
        if (!isStrictJson(value) || jsonByteLength(value) === undefined) {
          sendToolError(id, { code: "TOOL_RESULT", message: "The tool returned data that cannot cross the sandbox boundary." });
        } else {
          send({ type: "tool_result", id, ok: true, value });
        }
      } catch (error) {
        if (!settled && !childSignal.signal.aborted) sendToolError(id, safeError(error));
      } finally {
        pendingCalls -= 1;
      }
    };

    child.on("message", (message: unknown) => {
      if (settled) return;
      if (!isFrame(message) || typeof message.type !== "string") return stop("IPC_PROTOCOL", "The script runtime sent an invalid message.");
      if (message.type === "log") {
        if (typeof message.line !== "string" || Buffer.byteLength(message.line, "utf8") > limits.maxOutputBytes) return stop("IPC_PROTOCOL", "The script runtime sent an invalid log message.");
        outputBytes += Buffer.byteLength(message.line, "utf8");
        if (outputBytes > limits.maxOutputBytes) return stop("OUTPUT_LIMIT", "The script exceeded its output limit.");
        logs.push(message.line);
        try { options.onLog?.(message.line); } catch { /* Observers cannot affect execution. */ }
        return;
      }
      if (message.type === "call") {
        if (typeof message.id !== "string" || message.id.length === 0 || message.id.length > 128 || typeof message.name !== "string" || !isStrictJson(message.args)) {
          return stop("IPC_PROTOCOL", "The script runtime sent an invalid tool call.");
        }
        calls += 1;
        if (calls > limits.maxCalls) return stop("CALL_LIMIT", "The script exceeded its host-call limit.");
        if (pendingCalls >= limits.maxPendingCalls) return stop("PENDING_CALL_LIMIT", "The script exceeded its pending-call limit.");
        pendingCalls += 1;
        if (!options.toolNames.includes(message.name)) {
          pendingCalls -= 1;
          sendToolError(message.id, { code: "TOOL_UNAVAILABLE", message: "This tool is not available to the script." });
          return;
        }
        void invoke(message.id, message.name, message.args);
        return;
      }
      if (message.type === "result") {
        if (message.status === "completed" && isStrictJson(message.value)) {
          const bytes = jsonByteLength(message.value) ?? Infinity;
          if (outputBytes + bytes > limits.maxOutputBytes) return stop("OUTPUT_LIMIT", "The script exceeded its output limit.");
          return finish({ status: "completed", value: message.value, logs, durationMs: Math.round(performance.now() - started), sandbox: SANDBOX });
        }
        if (message.status === "failed" && typeof message.code === "string" && typeof message.message === "string") {
          return finish(failed(logs, started, message.code.slice(0, 64), message.message.slice(0, 500)));
        }
      }
      stop("IPC_PROTOCOL", "The script runtime sent an invalid result.");
    });
    child.once("error", () => stop("WORKER_ERROR", "The script runtime stopped unexpectedly."));
    child.once("exit", () => { if (!settled) stop("WORKER_EXIT", "The script runtime stopped unexpectedly."); });

    send({ type: "start", code: options.code, toolNames: options.toolNames, limits: { ...limits } });
  });
}

export { DEFAULT_PTC_LIMITS };
