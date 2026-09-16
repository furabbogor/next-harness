import { randomUUID } from "node:crypto";
import type { AgentConfig, EventType, HarnessEvent, Session } from "./types";

export function newSession(config: AgentConfig, title = "Untitled session"): Session {
  const now = new Date().toISOString();
  return { id: randomUUID(), title, createdAt: now, updatedAt: now, config: structuredClone(config), messages: [], events: [], plan: [], usage: { inputTokens: 0, outputTokens: 0, estimated: false }, run: null };
}

/** Called only inside a store mutation; events are immutable and strictly ordered. */
export function appendEvent(session: Session, type: EventType, data: Record<string, unknown> = {}): HarnessEvent {
  const event: HarnessEvent = { id: randomUUID(), seq: session.events.length + 1, sessionId: session.id, runId: session.run?.id ?? session.id, type, timestamp: new Date().toISOString(), data };
  session.events.push(event);
  return event;
}

/** Provider reasoning is retained for protocol replay but is not sent to the UI. */
export function publicSession(session: Session): Session {
  return { ...session, messages: session.messages.map((message) => { const copy = { ...message }; delete copy.reasoningContent; return copy; }) };
}
