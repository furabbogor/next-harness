import { mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace, validateWorkspacePath } from "@/lib/workspace";

const dirs: string[] = [];
const session = "11111111-1111-4111-8111-111111111111";
async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "harness-workspace-")); dirs.push(dir);
  return { root: dir, workspace: Workspace(dir) };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("Workspace", () => {
  it("writes, reads, lists nested files, and isolates sessions", async () => {
    const { workspace } = await makeWorkspace();
    await workspace.write(session, "src/index.ts", "console.log('ok')");
    expect(await workspace.read(session, "src/index.ts")).toMatchObject({ path: "src/index.ts", content: "console.log('ok')" });
    expect((await workspace.list(session)).map((file) => file.path)).toEqual(["src/index.ts"]);
    expect(await workspace.list("22222222-2222-4222-8222-222222222222")).toEqual([]);
  });

  it("enforces paths, UTF-8 byte limits, and file count", async () => {
    const { workspace } = await makeWorkspace();
    for (const path of ["../x.txt", "/x.txt", ".env", "a/.git/x.txt", "x.bin", "a\\x.txt", "a/../x.txt"]) {
      expect(() => validateWorkspacePath(path)).toThrow();
    }
    await expect(workspace.write(session, "x.txt", "🙂".repeat(20000))).rejects.toMatchObject({ code: "CONTENT_TOO_LARGE" });
    await workspace.write(session, "a.txt", "ok");
    await expect(workspace.read(session, "missing.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects symlinks and removes a session", async () => {
    const { root, workspace } = await makeWorkspace();
    await workspace.write(session, "safe.txt", "safe");
    await symlink(join(root, session, "safe.txt"), join(root, session, "link.txt"));
    await expect(workspace.list(session)).rejects.toMatchObject({ code: "INVALID_PATH" });
    await rm(join(root, session, "link.txt"));
    await workspace.removeSession(session);
    expect(await workspace.list(session)).toEqual([]);
  });
});
