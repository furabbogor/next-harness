import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills, selectSkills, skillPrompt } from "@/lib/skills";

const source = (name = "Example", description = "A useful example", body = "Follow this guidance.") => `---\nname: ${name}\ndescription: "${description}"\n---\n${body}\n`;
async function rootWith(...entries: Array<[string, string]>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-skills-"));
  for (const [id, content] of entries) {
    await mkdir(path.join(root, id), { recursive: true });
    await writeFile(path.join(root, id, "SKILL.md"), content);
  }
  return root;
}

describe("operator skill discovery", () => {
  it("discovers bounded direct skills, computes source digests, and frames prompts", async () => {
    const root = await rootWith(["alpha", source("Alpha", "Do alpha", "Alpha body")], ["beta", source("Beta", "Do beta", "Beta body")]);
    const catalog = await loadSkills(root);
    expect(catalog.map((skill) => skill.id)).toEqual(["alpha", "beta"]);
    expect(catalog[0].content).toContain("Alpha body");
    expect(catalog[0].digest).toMatch(/^[a-f0-9]{64}$/);
    const selected = selectSkills(catalog, ["beta"]);
    expect(skillPrompt(selected)).toContain("below the system safety rules");
    expect(skillPrompt(selected)).toContain("BEGIN OPERATOR-SELECTED SKILL: beta");
  });

  it("rejects unknown and duplicate selections", async () => {
    const catalog = await loadSkills(await rootWith(["alpha", source()]));
    expect(() => selectSkills(catalog, ["missing"])).toThrowError(/Unknown skill/);
    expect(() => selectSkills(catalog, ["alpha", "alpha"])).toThrowError(/Duplicate/);
  });

  it("rejects malformed metadata, symlinked paths, and oversized UTF-8 sources", async () => {
    const malformed = await rootWith(["bad", "---\nname: bad\n---\nbody"]);
    await expect(loadSkills(malformed)).rejects.toThrowError(/frontmatter/i);

    const symlinkRoot = await mkdtemp(path.join(os.tmpdir(), "harness-skills-link-"));
    const target = await rootWith(["target", source()]);
    await symlink(path.join(target, "target"), path.join(symlinkRoot, "linked"));
    await expect(loadSkills(symlinkRoot)).rejects.toThrowError(/real directory|path/i);

    const huge = await rootWith(["huge", source("Huge", "description", "é".repeat(9_000))]);
    await expect(loadSkills(huge)).rejects.toThrowError(/16 KiB|limit/i);
  });

  it("errors when an explicitly configured root is absent", async () => {
    await expect(loadSkills(path.join(os.tmpdir(), "definitely-missing-harness-skills"))).rejects.toThrowError(/root/i);
  });
});
