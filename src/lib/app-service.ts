import path from "node:path";
import { getDb } from "@/db";
import { getServerConfig } from "./config";
import { HarnessService } from "./harness";
import { FileSessionStore, PostgresSessionStore } from "./storage";
import { Workspace } from "./workspace";
import { createToolRegistry } from "./tools";
import { DemoProvider } from "./providers/demo";
import { DeepSeekProvider } from "./providers/deepseek";

const globalService = globalThis as typeof globalThis & { __nextHarnessV1?: HarnessService };

/** One coordinator per Node process, retained across development module reloads. */
export function getHarness(): HarnessService {
  if (!globalService.__nextHarnessV1) {
    const config = getServerConfig();
    globalService.__nextHarnessV1 = new HarnessService({
      store: config.databaseUrl ? PostgresSessionStore(getDb()) : FileSessionStore(path.join(config.dataDir, "sessions")),
      workspace: Workspace(path.join(config.dataDir, "workspaces")), tools: createToolRegistry(),
      providers: { demo: new DemoProvider(), deepseek: new DeepSeekProvider(config.deepseek) },
      runTimeoutMs: config.runTimeoutMs, maxToolCalls: config.maxToolCalls, approvalTtlMs: config.approvalTtlMs,
    });
  }
  return globalService.__nextHarnessV1;
}
