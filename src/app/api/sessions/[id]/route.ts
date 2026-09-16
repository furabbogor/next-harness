import { getHarness } from "@/lib/app-service";
import { guard } from "@/lib/auth";
import { api, json, readJson } from "@/lib/http";
import { publicSession } from "@/lib/session";
import { idSchema, parseInput, updateSessionSchema } from "@/lib/validation";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return api(async () => { guard(request); const id = parseInput(idSchema, (await context.params).id); return json({ session: publicSession(await getHarness().getSession(id)) }); });
}
export async function PATCH(request: Request, context: Context) {
  return api(async () => {
    guard(request, true);
    const id = parseInput(idSchema, (await context.params).id);
    const changes = parseInput(updateSessionSchema, await readJson(request));
    return json({ session: publicSession(await getHarness().updateSession(id, changes)) });
  });
}
export async function DELETE(request: Request, context: Context) {
  return api(async () => { guard(request, true); const id = parseInput(idSchema, (await context.params).id); await getHarness().deleteSession(id); return json({ deleted: true }); });
}
