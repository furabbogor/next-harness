export type StrictJson = null | boolean | number | string | StrictJson[] | { [key: string]: StrictJson };

export interface PtcLimits {
  timeoutMs?: number;
  cpuMs?: number;
  memoryBytes?: number;
  maxOutputBytes?: number;
  maxCodeBytes?: number;
  maxCalls?: number;
  maxPendingCalls?: number;
}

export interface NormalizedPtcLimits {
  timeoutMs: number;
  cpuMs: number;
  memoryBytes: number;
  maxOutputBytes: number;
  maxCodeBytes: number;
  maxCalls: number;
  maxPendingCalls: number;
}

export const DEFAULT_PTC_LIMITS: NormalizedPtcLimits = {
  timeoutMs: 120_000,
  cpuMs: 5_000,
  memoryBytes: 32 * 1024 * 1024,
  maxOutputBytes: 64 * 1024,
  maxCodeBytes: 32 * 1024,
  maxCalls: 32,
  maxPendingCalls: 8,
};

const MAX_FRAME_BYTES = 128 * 1024;

export function normalizePtcLimits(input?: PtcLimits): NormalizedPtcLimits | undefined {
  const values = { ...DEFAULT_PTC_LIMITS, ...input };
  const ranges: Record<keyof NormalizedPtcLimits, readonly [number, number]> = {
    timeoutMs: [1, 10 * 60_000],
    cpuMs: [1, 60_000],
    memoryBytes: [1_048_576, 256 * 1024 * 1024],
    maxOutputBytes: [1, MAX_FRAME_BYTES],
    maxCodeBytes: [1, MAX_FRAME_BYTES],
    maxCalls: [0, 1_000],
    maxPendingCalls: [1, 128],
  };
  for (const [key, range] of Object.entries(ranges) as [keyof NormalizedPtcLimits, readonly [number, number]][]) {
    const value = values[key];
    if (!Number.isSafeInteger(value) || value < range[0] || value > range[1]) return undefined;
  }
  return values;
}

/** Reject values that JSON would silently alter or omit at the process boundary. */
export function isStrictJson(value: unknown): value is StrictJson {
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): boolean => {
    if (depth > 100) return false;
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return true;
    if (typeof candidate === "number") return Number.isFinite(candidate) && !Object.is(candidate, -0);
    if (typeof candidate !== "object" || seen.has(candidate)) return false;
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        for (let index = 0; index < candidate.length; index += 1) {
          if (!(index in candidate) || !visit(candidate[index], depth + 1)) return false;
        }
        return Object.keys(candidate).length === candidate.length && Object.getOwnPropertySymbols(candidate).length === 0;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(candidate).length !== 0) return false;
      return Object.keys(candidate).every((key) => visit((candidate as Record<string, unknown>)[key], depth + 1));
    } catch {
      return false;
    } finally {
      seen.delete(candidate);
    }
  };
  return visit(value, 0);
}

export function jsonByteLength(value: unknown): number | undefined {
  if (!isStrictJson(value)) return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

export function isFrame(value: unknown): value is Record<string, unknown> {
  const bytes = jsonByteLength(value);
  return bytes !== undefined && bytes <= MAX_FRAME_BYTES;
}

export function safeError(error: unknown, fallbackCode = "TOOL_ERROR"): { code: string; message: string } {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate.code) && typeof candidate.message === "string") {
      return { code: candidate.code, message: candidate.message.slice(0, 500) || "The tool failed." };
    }
  }
  return { code: fallbackCode, message: "The tool failed." };
}
