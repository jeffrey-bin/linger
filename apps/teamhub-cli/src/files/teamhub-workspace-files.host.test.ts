import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHostTeamHubWorkspaceFiles } from "./teamhub-workspace-files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "teamhub-workspace-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const files = createHostTeamHubWorkspaceFiles({
    workspacePath: workspace,
    runtimeWorkspacePath: "/workspace",
    readOnlyPaths: ["documents", "inbox", "memory"],
    signal: new AbortController().signal,
  });
  return { root, workspace, files };
}

describe("TeamHub CLI Host workspace files", () => {
  it("uses trusted writable mappings without following a replaced workspace symlink", async () => {
    const f = await fixture();
    const playground = path.join(f.root, "playground");
    const outside = path.join(f.root, "outside");
    await mkdir(playground);
    await mkdir(outside);
    await symlink(outside, path.join(f.workspace, "playground"), "junction");
    const files = createHostTeamHubWorkspaceFiles({
      workspacePath: f.workspace,
      runtimeWorkspacePath: "/workspace",
      readOnlyPaths: ["documents"],
      writableMappings: [
        { relativePath: "playground", sourcePath: playground },
      ],
      signal: new AbortController().signal,
    });
    const filePath = files.normalize("/workspace/playground/result.txt");
    await files.install(filePath, Buffer.from("result"), null);
    expect(await readFile(path.join(playground, "result.txt"), "utf8")).toBe(
      "result",
    );
    expect(await readdir(outside)).toEqual([]);
    expect(await files.read(filePath)).toMatchObject({ sha256: sha("result") });
  });
  it("downloads bytes atomically and reads the exact regular file", async () => {
    const f = await fixture();
    const normalized = f.files.normalize("/workspace/report.md");
    expect(normalized).toBe("report.md");
    expect(await f.files.read(normalized)).toBeNull();
    await f.files.install(normalized, Buffer.from("downloaded"), null);
    expect(await f.files.read(normalized)).toMatchObject({
      content: Buffer.from("downloaded"),
      sha256: sha("downloaded"),
    });
    if (process.platform !== "win32") {
      expect(
        (await lstat(path.join(f.workspace, normalized))).mode & 0o777,
      ).toBe(0o600);
    }
    expect(await readdir(f.workspace)).toEqual(["report.md"]);
  });

  it.each([
    "/outside/report.md",
    "/workspace",
    "/workspace/..",
    "/workspace/../secret",
    "/workspace/a/../b",
    "/workspace/a//b",
    "/workspace/a\\b",
    "/workspace/a\0b",
  ])("rejects invalid absolute path %s", async (value) => {
    const f = await fixture();
    expect(() => f.files.normalize(value)).toThrow();
  });

  it.each([
    "/workspace/documents/report.md",
    "/workspace/inbox/event.json",
    "/workspace/memory/note.md",
    "/workspace/.agents/skills/builtin/SKILL.md",
  ])("rejects reserved projection path %s", async (value) => {
    const f = await fixture();
    expect(() => f.files.normalize(value)).toThrow();
  });

  it("revalidates relative paths recovered from private Host state", async () => {
    const f = await fixture();
    await expect(f.files.read("../outside")).rejects.toThrow();
    await expect(
      f.files.install("documents/report.md", Buffer.from("bad"), null),
    ).rejects.toThrow();
  });

  it("rejects symbolic links at the file and parent levels", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "secret"), "secret");
    if (process.platform === "win32") {
      const fixtureRoot = process.env.LINGER_TEST_WINDOWS_FILE_LINKS;
      if (!fixtureRoot)
        throw new Error("LINGER_TEST_WINDOWS_FILE_LINKS is required");
      await rename(
        path.join(fixtureRoot, "workspace", "shortcut-original"),
        path.join(f.workspace, "shortcut"),
      );
    } else {
      await symlink(
        path.join(f.root, "secret"),
        path.join(f.workspace, "shortcut"),
      );
    }
    await symlink(f.root, path.join(f.workspace, "parent"), "junction");
    await expect(f.files.read("shortcut")).rejects.toThrow();
    await expect(f.files.read("parent/secret")).rejects.toThrow();
    await expect(
      f.files.install("parent/new", Buffer.from("bad"), null),
    ).rejects.toThrow();
    expect(await readFile(path.join(f.root, "secret"), "utf8")).toBe("secret");
  });

  it("rejects directories and requires the destination parent to exist", async () => {
    const f = await fixture();
    await mkdir(path.join(f.workspace, "folder"));
    await expect(f.files.read("folder")).rejects.toThrow();
    await expect(
      f.files.install("missing/report.md", Buffer.from("new"), null),
    ).rejects.toThrow();
  });

  it("does not overwrite a file changed after download admission", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, "report.md"), "new local content");
    await expect(
      f.files.install(
        "report.md",
        Buffer.from("server"),
        sha("old local content"),
      ),
    ).rejects.toMatchObject({ code: "file_changed" });
    await expect(
      f.files.install("report.md", Buffer.from("server"), null),
    ).rejects.toMatchObject({ code: "file_changed" });
    expect(await readFile(path.join(f.workspace, "report.md"), "utf8")).toBe(
      "new local content",
    );
    expect(await readdir(f.workspace)).toEqual(["report.md"]);
  });

  it("replaces the expected version and leaves no temporary file", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, "report.md"), "old");
    await f.files.install("report.md", Buffer.from("new"), sha("old"));
    expect(await readFile(path.join(f.workspace, "report.md"), "utf8")).toBe(
      "new",
    );
    expect(await readdir(f.workspace)).toEqual(["report.md"]);
  });

  it("rejects operations after Runtime cancellation", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const files = createHostTeamHubWorkspaceFiles({
      workspacePath: f.workspace,
      runtimeWorkspacePath: "/workspace",
      readOnlyPaths: [],
      signal: controller.signal,
    });
    controller.abort();
    await expect(
      files.install("report.md", Buffer.from("new"), null),
    ).rejects.toThrow();
    expect(await readdir(f.workspace)).toEqual([]);
  });
});
