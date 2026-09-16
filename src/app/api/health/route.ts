import { getHarness } from "@/lib/app-service";
import { json } from "@/lib/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  try {
    const harness = getHarness();
    await harness.store.health();
    return json({ ok: true, status: "healthy", version: "0.1.0", storage: harness.store.kind });
  } catch {
    return json({ ok: false, status: "unavailable", message: "Storage or server configuration is unavailable." }, 503);
  }
}
