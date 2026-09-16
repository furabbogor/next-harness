import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getServerConfig } from "./config";
import { HarnessError } from "./errors";

export const AUTH_COOKIE = "next-harness-session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export function secretsEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function signSession(token: string, now = Date.now()): string {
  const expires = String(now + SESSION_MS);
  return `${expires}.${createHmac("sha256", token).update(`next-harness:v1:${expires}`).digest("hex")}`;
}

export function verifySession(value: string, token: string, now = Date.now()): boolean {
  const parts = value.split(".");
  if (parts.length !== 2 || !/^\d{13}$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) return false;
  const expires = Number(parts[0]);
  if (expires <= now || expires > now + SESSION_MS + 60000) return false;
  const expected = createHmac("sha256", token).update(`next-harness:v1:${parts[0]}`).digest("hex");
  return secretsEqual(parts[1], expected);
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export function authenticated(request: Request): boolean {
  const { accessToken } = getServerConfig();
  if (!accessToken) return true;
  const token = bearer(request);
  if (token !== undefined) return secretsEqual(token, accessToken);
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${AUTH_COOKIE}=`))?.slice(AUTH_COOKIE.length + 1);
  return cookie ? verifySession(cookie, accessToken) : false;
}

/** JSON writes are same-origin. Non-browser clients should use a Bearer token. */
export function assertOrigin(request: Request) {
  const config = getServerConfig();
  const origin = request.headers.get("origin");
  if (origin && origin !== (config.publicOrigin ?? new URL(request.url).origin)) throw new HarnessError("ORIGIN_REJECTED", "Cross-origin writes are not allowed.", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new HarnessError("ORIGIN_REJECTED", "Cross-site writes are not allowed.", 403);
  if (config.accessToken && !origin && !bearer(request) && request.headers.get("cookie")?.includes(`${AUTH_COOKIE}=`)) throw new HarnessError("ORIGIN_REQUIRED", "Cookie-authenticated writes require an Origin header.", 403);
}

export function guard(request: Request, mutating = false) {
  const config = getServerConfig();
  const hostname = new URL(request.url).hostname;
  if (!config.accessToken && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) throw new HarnessError("AUTH_REQUIRED_FOR_REMOTE", "Set HARNESS_ACCESS_TOKEN before accessing this app beyond localhost.", 403);
  if (!authenticated(request)) throw new HarnessError("UNAUTHORIZED", "Unlock the workspace to continue.", 401);
  if (mutating) assertOrigin(request);
}

export function sessionCookie(request: Request, value: string, clear = false): string {
  const config = getServerConfig();
  const secure = (config.publicOrigin ?? request.url).startsWith("https://");
  return `${AUTH_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : SESSION_MS / 1000}${secure ? "; Secure" : ""}`;
}
