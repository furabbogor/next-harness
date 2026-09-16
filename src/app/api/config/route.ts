import { guard } from "@/lib/auth";
import { getPublicConfig } from "@/lib/config";
import { api, json } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return api(async () => { guard(request); return json(getPublicConfig()); });
}
