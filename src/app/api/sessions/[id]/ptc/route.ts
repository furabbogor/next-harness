import { getHarness } from "@/lib/app-service";
import { guard } from "@/lib/auth";
import { api, readJson, streamRun } from "@/lib/http";
import { idSchema, parseInput, programSchema } from "@/lib/validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
/** Direct PTC console execution calls no model/provider. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    guard(request, true);
    const id = parseInput(idSchema, (await context.params).id);
    const { code, description } = parseInput(programSchema, await readJson(request));
    return streamRun(request, await getHarness().startProgram(id, code, description));
  });
}
