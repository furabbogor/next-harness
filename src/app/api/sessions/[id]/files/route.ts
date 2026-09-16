import { getHarness } from "@/lib/app-service";
import { guard } from "@/lib/auth";
import { HarnessError } from "@/lib/errors";
import { api, json, readJson } from "@/lib/http";
import { fileSchema, idSchema, parseInput } from "@/lib/validation";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return api(async () => {
    guard(request);
    const id = parseInput(idSchema, (await context.params).id);
    const harness = getHarness();
    await harness.getSession(id);
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (path !== null) {
      const file = await harness.workspace.read(id, path);
      if (url.searchParams.get("download") === "1") return new Response(file.content, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.path.split("/").at(-1)!)}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "sandbox" } });
      return json({ file });
    }
    return json({ files: await harness.workspace.list(id) });
  });
}
export async function POST(request: Request, context: Context) {
  return api(async () => {
    guard(request, true);
    const id = parseInput(idSchema, (await context.params).id);
    const input = parseInput(fileSchema, await readJson(request));
    const harness = getHarness();
    const session = await harness.getSession(id);
    if (["running", "awaiting_approval"].includes(session.run?.status ?? "")) throw new HarnessError("SESSION_BUSY", "Stop the run before editing its workspace files.", 409);
    return json({ file: await harness.workspace.write(id, input.path, input.content) }, 201);
  });
}
