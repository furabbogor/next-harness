import { describe, expect, it, afterEach, vi } from "vitest";
import { assertOrigin, authenticated, guard, signSession, verifySession } from "@/lib/auth";
import { getPublicConfig } from "@/lib/config";
import { readJson } from "@/lib/http";

afterEach(() => { vi.unstubAllEnvs(); });

const token = "a-secure-test-token-that-is-at-least-24-chars";

describe("authentication and request-boundary security", () => {
  it("accepts a fresh signed cookie but rejects tampering, expiry, and key rotation", () => {
    const now = Date.parse("2026-09-17T00:00:00.000Z");
    const cookie = signSession(token, now);
    expect(verifySession(cookie, token, now + 1)).toBe(true);
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("0") ? "1" : "0"}`;
    expect(verifySession(tampered, token, now + 1)).toBe(false);
    expect(verifySession(cookie, token, now + 7 * 24 * 60 * 60 * 1000 + 1)).toBe(false);
    expect(verifySession(cookie, `${token}-rotated`, now + 1)).toBe(false);
  });

  it("supports bearer authentication and does not treat a wrong token as authenticated", () => {
    vi.stubEnv("HARNESS_ACCESS_TOKEN", token);
    expect(authenticated(new Request("http://localhost/api", { headers: { authorization: `Bearer ${token}` } }))).toBe(true);
    expect(authenticated(new Request("http://localhost/api", { headers: { authorization: "Bearer wrong" } }))).toBe(false);
  });

  it("does not expose API keys, access tokens, database URLs, or server base URLs in public config", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-secret-value");
    vi.stubEnv("HARNESS_ACCESS_TOKEN", token);
    vi.stubEnv("DATABASE_URL", "postgres://user:password@db.internal/app");
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://provider.internal.example");
    const publicConfig = getPublicConfig();
    const serialized = JSON.stringify(publicConfig);
    expect(serialized).not.toContain("deepseek-secret-value");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("provider.internal.example");
    expect(publicConfig.providers.find((provider) => provider.id === "deepseek")?.configured).toBe(true);
  });

  it("rejects cross-origin and cross-site JSON writes", () => {
    vi.stubEnv("HARNESS_ACCESS_TOKEN", token);
    const crossOrigin = new Request("https://app.example/api", { headers: { origin: "https://evil.example" } });
    expect(() => assertOrigin(crossOrigin)).toThrowError(expect.objectContaining({ code: "ORIGIN_REJECTED" }));
    const crossSite = new Request("https://app.example/api", { headers: { "sec-fetch-site": "cross-site" } });
    expect(() => assertOrigin(crossSite)).toThrowError(expect.objectContaining({ code: "ORIGIN_REJECTED" }));
  });

  it("requires an Origin header for cookie-authenticated writes", () => {
    vi.stubEnv("HARNESS_ACCESS_TOKEN", token);
    const request = new Request("http://localhost/api", { headers: { cookie: "next-harness-session=not-a-valid-cookie" } });
    expect(() => assertOrigin(request)).toThrowError(expect.objectContaining({ code: "ORIGIN_REQUIRED" }));
  });

  it("requires authentication for protected remote access", () => {
    vi.stubEnv("HARNESS_ACCESS_TOKEN", token);
    expect(() => guard(new Request("https://remote.example/api"))).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    vi.stubEnv("HARNESS_ACCESS_TOKEN", "");
    expect(() => guard(new Request("https://remote.example/api"))).toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED_FOR_REMOTE" }));
  });

  it("enforces the request byte limit even when Content-Length is absent or untrustworthy", async () => {
    for (const contentLength of [undefined, "1"]) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"content":"1234567890"}'));
          controller.close();
        },
      });
      const headers = new Headers({ "content-type": "application/json" });
      if (contentLength) headers.set("content-length", contentLength);
      const request = new Request("http://localhost/api", { method: "POST", headers, body, duplex: "half" } as RequestInit & { duplex: "half" });
      await expect(readJson(request, 10)).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
    }
  });

  it("rejects non-JSON request bodies before parsing", async () => {
    const request = new Request("http://localhost/api", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    await expect(readJson(request)).rejects.toMatchObject({ code: "CONTENT_TYPE" });
  });

  it("rejects malformed and oversized session tokens without throwing", () => {
    vi.stubEnv("HARNESS_ACCESS_TOKEN", token);
    for (const value of ["", "1", "not.a.cookie", `${Date.now()}.bad`]) {
      expect(authenticated(new Request("http://localhost/api", { headers: { cookie: `next-harness-session=${value}` } }))).toBe(false);
    }
    expect(() => verifySession("not even close", token)).not.toThrow();
  });
});
