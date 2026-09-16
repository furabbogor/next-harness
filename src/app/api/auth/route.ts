import { z } from "zod";
import { AUTH_COOKIE, assertOrigin, authenticated, secretsEqual, sessionCookie, signSession } from "@/lib/auth";
import { getServerConfig } from "@/lib/config";
import { HarnessError } from "@/lib/errors";
import { api, json, readJson } from "@/lib/http";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";
const failures = globalThis as typeof globalThis & { __harnessLoginFailures?: { count: number; resetAt: number } };

export async function GET(request: Request) {
  return api(async () => json({ required: Boolean(getServerConfig().accessToken), authenticated: authenticated(request) }));
}

export async function POST(request: Request) {
  return api(async () => {
    assertOrigin(request);
    const { token } = parseInput(z.object({ token: z.string().max(1000) }).strict(), await readJson(request, 2048));
    const config = getServerConfig();
    const bucket = failures.__harnessLoginFailures ??= { count: 0, resetAt: Date.now() + 60000 };
    if (Date.now() > bucket.resetAt) { bucket.count = 0; bucket.resetAt = Date.now() + 60000; }
    if (bucket.count >= 8) throw new HarnessError("LOGIN_RATE_LIMIT", "Too many unlock attempts. Wait one minute and try again.", 429);
    if (!config.accessToken || !secretsEqual(token, config.accessToken)) { bucket.count++; throw new HarnessError("UNAUTHORIZED", "The access token is incorrect.", 401); }
    bucket.count = 0;
    return json({ authenticated: true }, 200, { "Set-Cookie": sessionCookie(request, signSession(config.accessToken)) });
  });
}

export async function DELETE(request: Request) {
  return api(async () => { assertOrigin(request); return json({ authenticated: false, cookie: AUTH_COOKIE }, 200, { "Set-Cookie": sessionCookie(request, "", true) }); });
}
