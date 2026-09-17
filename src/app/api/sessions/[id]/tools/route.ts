import { getHarness } from "@/lib/app-service";
import { guard } from "@/lib/auth";
import { api, json } from "@/lib/http";
import { idSchema, parseInput } from "@/lib/validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { guard(request); const id = parseInput(idSchema, (await context.params).id); return json(await getHarness().toolSdk(id)); });
}
