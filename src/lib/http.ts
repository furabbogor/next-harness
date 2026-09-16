import { HarnessError, publicError } from "./errors";
import type { RunHandle } from "./harness";
import type { WireEvent } from "./types";

export function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });
}

export async function api(action: () => Promise<Response>): Promise<Response> {
  try { return await action(); }
  catch (error) {
    const safe = publicError(error);
    if (safe.status >= 500) console.error("[next-harness] Request failed", safe.code, error instanceof Error ? error.name : "Unknown error");
    return json({ error: { code: safe.code, message: safe.message } }, safe.status);
  }
}

export async function readJson(request: Request, limit = 512 * 1024): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new HarnessError("CONTENT_TYPE", "Send an application/json request body.", 415);
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw new HarnessError("BODY_TOO_LARGE", "The request body is too large.", 413);
  if (!request.body) throw new HarnessError("INVALID_JSON", "A JSON body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new HarnessError("BODY_TOO_LARGE", "The request body is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new HarnessError("INVALID_JSON", "The request body is not valid JSON."); }
}

/** Fetch-based SSE; disconnects stop active work rather than leaving an unbounded job. */
export function streamRun(request: Request, handle: RunHandle): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: WireEvent) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)); }
        catch { closed = true; handle.abort(); }
      };
      request.signal.addEventListener("abort", handle.abort, { once: true });
      if (request.signal.aborted) handle.abort();
      heartbeat = setInterval(() => {
        if (!closed) { try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { closed = true; handle.abort(); } }
      }, 10000);
      void handle.execute(emit).catch((error) => { const safe = publicError(error); emit({ type: "error", data: { code: safe.code, message: safe.message } }); }).finally(() => {
        clearInterval(heartbeat);
        request.signal.removeEventListener("abort", handle.abort);
        if (!closed) { closed = true; controller.close(); }
      });
    },
    cancel() { closed = true; clearInterval(heartbeat); handle.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" } });
}
