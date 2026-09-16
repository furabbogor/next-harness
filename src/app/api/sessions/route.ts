import { getHarness } from "@/lib/app-service";
import { guard } from "@/lib/auth";
import { getPublicConfig } from "@/lib/config";
import { api, json, readJson } from "@/lib/http";
import { publicSession } from "@/lib/session";
import { createSessionSchema, parseInput } from "@/lib/validation";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return api(async () => { guard(request); return json({ sessions: await getHarness().store.list() }); });
}
export async function POST(request: Request) {
  return api(async () => {
    guard(request, true);
    const input = parseInput(createSessionSchema, await readJson(request));
    const session = await getHarness().createSession(input.config ?? getPublicConfig().defaultConfig, input.title);
    return json({ session: publicSession(session) }, 201);
  });
}
