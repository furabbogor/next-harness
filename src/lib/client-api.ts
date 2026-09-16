import { createParser } from "eventsource-parser";
import type { WireEvent } from "./types";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code = "REQUEST_FAILED") { super(message); this.name = "ApiError"; }
}

export async function checkResponse(response: Response): Promise<Response> {
  if (response.ok) return response;
  const value = await response.json().catch(() => null) as { error?: { message?: string; code?: string } } | null;
  throw new ApiError(value?.error?.message ?? `Request failed (${response.status}). Please try again.`, response.status, value?.error?.code);
}

export async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await checkResponse(await fetch(url, { ...init, cache: "no-store", headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } }));
  return response.json() as Promise<T>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

/** Decode streamed event boundaries independently of network chunk boundaries. */
export async function consumeRun(response: Response, onEvent: (event: WireEvent) => void) {
  await checkResponse(response);
  if (!response.body) throw new ApiError("The run stream was empty.", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let finished = false;
  const parser = createParser({ onEvent(frame) {
    if (!frame.event || !["token", "event", "snapshot", "done", "error"].includes(frame.event)) return;
    let data: unknown;
    try { data = JSON.parse(frame.data); } catch { throw new ApiError("The run stream could not be decoded. Refresh the session to recover its saved history.", 502); }
    if (!data || typeof data !== "object") throw new ApiError("The run stream contained an invalid event.", 502);
    if (frame.event === "done") finished = true;
    onEvent({ type: frame.event, data } as WireEvent);
  } });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    if (!finished) throw new ApiError("The connection ended before the run settled. Refresh to see saved progress.", 502);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
