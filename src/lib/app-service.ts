import path from "node:path";
import { getDb } from "@/db";
import { getServerConfig } from "./config";
import { HarnessService } from "./harness";
import { FileSessionStore, PostgresSessionStore } from "./storage";
import { Workspace } from "./workspace";
import { createToolRegistry } from "./tools";
import { DemoProvider } from "./providers/demo";
import { DeepSeekProvider } from "./providers/deepseek";
import { loadSkills } from "./skills";
import { McpGateway, parseMcpServers } from "./mcp";
const globalService = globalThis as typeof globalThis & { __nextHarnessV2?: HarnessService };
/** One coordinator per persistent Node process, retained during development reloads. */
export function getHarness(): HarnessService {
  if (!globalService.__nextHarnessV2) {
    const config = getServerConfig();
    const servers = parseMcpServers(config.mcpServers);
    globalService.__nextHarnessV2 = new HarnessService({
      store: config.databaseUrl ? PostgresSessionStore(getDb()) : FileSessionStore(path.join(config.dataDir, "sessions")),
      workspace: Workspace(path.join(config.dataDir, "workspaces")), tools: createToolRegistry(),
      providers: { demo: new DemoProvider(), deepseek: new DeepSeekProvider(config.deepseek) },
      runTimeoutMs: config.runTimeoutMs, maxToolCalls: config.maxToolCalls, approvalTtlMs: config.approvalTtlMs,
      ...(config.skillsDir ? { loadSkills: () => loadSkills(config.skillsDir!) } : {}),
      ...(servers.length ? { gateway: new McpGateway(servers) } : {}),
    });
  }
  return globalService.__nextHarnessV2;
}
