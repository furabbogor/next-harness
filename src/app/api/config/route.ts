import { guard } from "@/lib/auth";
import { getPublicConfig } from "@/lib/config";
import { getHarness } from "@/lib/app-service";
import { api, json } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return api(async () => { guard(request); return json({ ...getPublicConfig(), ...await getHarness().catalog() }); });
}
