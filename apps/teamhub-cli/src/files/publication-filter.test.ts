import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packContextSkillFolder } from "./context-skill-folder-packer.js";

const temporaryDirectories: string[] = [];
const publicFiles = {
  "SKILL.md":
    "---\nname: safe-package\ndescription: Published Skill\n---\nUse references.\n",
  "references/guide.md": "Public guidance\n",
  ".editorconfig": "root = true\n",
};
const excludedFiles = [
  ".teamhub/cli/credential",
  ".agents/private.json",
  ".git/config",
  "node_modules/dependency/index.js",
  ".env",
  ".env.local",
  ".env.example",
  "references/.teamhub/cli/credential",
  "references/.agents/private.json",
  "references/.git/config",
  "references/node_modules/dependency/index.js",
  "references/.env.production",
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-filter-"));
  temporaryDirectories.push(root);
  const folder = path.join(root, "skill");
  const write = async (name: string, content: string) => {
    const destination = path.join(folder, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  };
  for (const [name, content] of Object.entries(publicFiles))
    await write(name, content);
  return { root, folder, write };
}

describe("folder publication filtering", () => {
  it("keeps Skill ZIP bytes and digest identical when private or dependency files are present", async () => {
    const { root, write } = await fixture();
    const pack = () =>
      packContextSkillFolder({
        playgroundRootPath: root,
        folderPath: "skill",
        signal: AbortSignal.timeout(5_000),
      });
    const clean = await pack();
    for (const name of excludedFiles)
      await write(name, "private fixture contents\n");
    await write(".simplexai/workspace.json", "private runtime metadata\n");

    const packed = await pack();
    expect(packed.fileCount).toBe(3);
    expect(packed.archive).toEqual(clean.archive);
    expect(packed.packageSha256).toBe(clean.packageSha256);
    await expect(
      packContextSkillFolder({
        playgroundRootPath: root,
        folderPath: "skill",
        signal: AbortSignal.timeout(5_000),
        limits: { maxEntries: 4, maxFiles: 3 },
      }),
    ).resolves.toMatchObject({ fileCount: 3 });
  });

  it("does not follow ignored dependency symlinks, while rejecting published symlinks", async () => {
    const { root, folder } = await fixture();
    await symlink(
      path.join(root, "missing-dependency-store"),
      path.join(folder, "node_modules"),
      "junction",
    );
    const pack = () =>
      packContextSkillFolder({
        playgroundRootPath: root,
        folderPath: "skill",
        signal: AbortSignal.timeout(5_000),
      });
    expect((await pack()).fileCount).toBe(3);
    if (process.platform === "win32") {
      const fixtureRoot = process.env.LINGER_TEST_WINDOWS_FILE_LINKS;
      if (!fixtureRoot)
        throw new Error("LINGER_TEST_WINDOWS_FILE_LINKS is required");
      await rename(
        path.join(fixtureRoot, "standalone", "publication"),
        path.join(folder, "references", "linked.md"),
      );
    } else
      await symlink(
        path.join(folder, "SKILL.md"),
        path.join(folder, "references", "linked.md"),
      );
    await expect(pack()).rejects.toMatchObject({
      code: "unsupported_entry_type",
    });
  });
});
