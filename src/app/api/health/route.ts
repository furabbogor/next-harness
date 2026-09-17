import { access } from "node:fs/promises";
import path from "node:path";
import { getHarness } from "@/lib/app-service";
import { json } from "@/lib/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  try {
    const harness = getHarness();
    await harness.store.health(); await harness.ready();
    await access(path.join(process.cwd(), "runtime", "ptc-worker.mjs"));
    return json({ ok: true, status: "healthy", version: "0.2.0", storage: harness.store.kind, ptc: { engine: "quickjs-wasm", worker: "available" } });
  } catch { return json({ ok: false, status: "unavailable", message: "Storage, runtime files, or configured extensions are unavailable." }, 503); }
}
