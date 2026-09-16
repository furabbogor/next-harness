import { getHarness } from "@/lib/app-service";
import { guard } from "@/lib/auth";
import { api, readJson, streamRun } from "@/lib/http";
import { approvalSchema, idSchema, parseInput } from "@/lib/validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
export async function POST(request: Request, context: { params: Promise<{ id: string; approvalId: string }> }) {
  return api(async () => {
    guard(request, true);
    const params = await context.params;
    const id = parseInput(idSchema, params.id);
    const approvalId = parseInput(idSchema, params.approvalId);
    const { approved } = parseInput(approvalSchema, await readJson(request));
    return streamRun(request, await getHarness().resume(id, approvalId, approved));
  });
}
