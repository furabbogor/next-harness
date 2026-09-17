import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/types";
import { compactContext, contextSize, projectContext } from "@/lib/context";

const message = (role: Message["role"], content: string, extra: Partial<Message> = {}): Message => ({ id: randomUUID(), role, content, createdAt: new Date(0).toISOString(), ...extra });
const turn = (text: string, withTool = false): Message[] => {
  const user = message("user", text);
  const call = { id: randomUUID(), name: "read_file", args: { path: text } };
  const assistant = message("assistant", `planning ${text}`, withTool ? { toolCalls: [call] } : {});
  return withTool ? [user, assistant, message("tool", `result ${text}`, { toolCallId: call.id, toolName: call.name }), message("assistant", `outcome ${text}`)] : [user, assistant];
};

describe("context projection and compaction", () => {
  it("compacts only complete turns and never separates a tool call from its result", () => {
    const messages = [...turn("old", true), ...turn("middle", true), ...turn("recent", true)];
    const recent = messages.slice(4);
    const checkpoint = compactContext(messages, undefined, { maxCharacters: contextSize(recent), keepRecentTurns: 2 });
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.throughMessageId).toBe(messages[3].id);
    expect(checkpoint!.compactedMessages).toBe(4);
    expect(checkpoint!.summary).toContain("old");
    expect(projectContext(messages, checkpoint)).toEqual(recent);
    expect(projectContext(messages, checkpoint).some((entry) => entry.role === "tool")).toBe(true);
  });

  it("combines an older checkpoint with newly omitted turns", () => {
    const initial = [...turn("one"), ...turn("two"), ...turn("three")];
    const first = compactContext(initial, undefined, { maxCharacters: contextSize(initial.slice(2)), keepRecentTurns: 2 });
    expect(first).toBeDefined();
    const extended = [...initial, ...turn("four")];
    const second = compactContext(extended, first, { maxCharacters: contextSize(extended.slice(4)), keepRecentTurns: 2 });
    expect(second).toBeDefined();
    expect(second!.summary).toContain("OLDER CHECKPOINT SUMMARY");
    expect(second!.summary).toContain(first!.summary.slice(0, 20));
    expect(second!.compactedMessages).toBe(first!.compactedMessages + 2);
  });

  it("rejects stale checkpoints and leaves a too-large protected suffix intact", () => {
    const messages = [...turn("a"), ...turn("b")];
    expect(() => projectContext(messages, { throughMessageId: "missing", summary: "x", createdAt: "now", compactedMessages: 1 })).toThrowError(/checkpoint/i);
    const checkpoint = compactContext(messages, undefined, { maxCharacters: 1, keepRecentTurns: 2 });
    expect(checkpoint).toBeUndefined();
  });

  it("retains the active turn when zero recent turns is requested", () => {
    const messages = [...turn("older"), ...turn("active")];
    const checkpoint = compactContext(messages, undefined, { maxCharacters: contextSize(messages.slice(2)), keepRecentTurns: 0 });
    expect(projectContext(messages, checkpoint)).toEqual(messages.slice(2));
  });

  it("reserves summary space for newly compacted requirements", () => {
    const initial = [...turn("ancient ".repeat(500)), ...turn("new requirement: preserve retries"), ...turn("recent")];
    const previous = { throughMessageId: initial[1].id, summary: "old history ".repeat(500).slice(0, 1000), createdAt: new Date(0).toISOString(), compactedMessages: 2 };
    const next = compactContext(initial, previous, { maxCharacters: contextSize(initial.slice(4)), keepRecentTurns: 1, summaryCharacters: 1000 });
    expect(next?.summary.length).toBeLessThanOrEqual(1000);
    expect(next?.summary).toContain("old history");
    expect(next?.summary).toContain("preserve retries");
  });

  it("does not create a checkpoint under the budget and validates limits", () => {
    const messages = turn("small");
    expect(compactContext(messages, undefined, { maxCharacters: contextSize(messages) })).toBeUndefined();
    expect(() => compactContext(messages, undefined, { maxCharacters: 0 })).toThrowError(/maxCharacters/);
    expect(() => compactContext(messages, undefined, { summaryCharacters: 10 })).toThrowError(/summaryCharacters/);
  });
});
