import { getHarness } from "@/lib/app-service";
import { guard } from "@/lib/auth";
import { api, json } from "@/lib/http";
import { publicSession } from "@/lib/session";
import { idSchema, parseInput } from "@/lib/validation";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { guard(request, true); const id = parseInput(idSchema, (await context.params).id); return json({ session: publicSession(await getHarness().cancel(id)) }); });
}
