import { getHarness } from "@/lib/app-service";
import { guard } from "@/lib/auth";
import { api } from "@/lib/http";
import { publicSession } from "@/lib/session";
import { idSchema, parseInput } from "@/lib/validation";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    guard(request);
    const id = parseInput(idSchema, (await context.params).id);
    const session = publicSession(await getHarness().getSession(id));
    return new Response(JSON.stringify({ format: "next-harness-session", version: 1, exportedAt: new Date().toISOString(), session }, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="next-harness-${id}.json"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  });
}
