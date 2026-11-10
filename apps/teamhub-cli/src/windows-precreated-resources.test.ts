import { lstat, readFile, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { executeMessageSend } from "./message-send-executor.js";
import type { TeamHubHttpClient } from "./http-client.js";
import { packContextSkillFolder } from "./files/context-skill-folder-packer.js";
import { createHostTeamHubWorkspaceFiles } from "./files/teamhub-workspace-files.js";

const fixtureRoot = process.env.LINGER_TEST_WINDOWS_FILE_LINKS;
const enabled = process.platform === "win32" && !!fixtureRoot;

it.runIf(enabled)(
  "rejects a mixed message with a private file link before network",
  async () => {
    const root = path.join(fixtureRoot!, "message");
    const alias = path.join(root, "alias.pdf");
    const target = path.join(root, ".teamhub", "private.pdf");
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await realpath(alias)).toBe(await realpath(target));
    const before = await readFile(target);
    const request = vi.fn<TeamHubHttpClient["request"]>();
    const client = {
      config: {
        url: "https://example.test",
        token: "fixture",
        identityKey: "fixture",
      },
      request,
      get api(): TeamHubHttpClient["api"] {
        throw new Error("unexpected request");
      },
    } satisfies TeamHubHttpClient;
    await expect(
      executeMessageSend(
        {
          inbox_id: "room_example",
          message_segments: [
            { type: "document", "content-path": "valid.pdf" },
            { type: "document", "content-path": "alias.pdf" },
          ],
        },
        {
          client,
          cwd: root,
          stateRoot: root,
          operationId: "precreated-link",
          target: { type: "room", id: "room_example" },
        },
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(await readFile(target)).toEqual(before);
  },
);

it.runIf(enabled)("rejects a precreated nested Skill file link", async () => {
  const root = path.join(fixtureRoot!, "skill");
  const alias = path.join(
    root,
    "playground",
    "skills",
    "example",
    "linked.txt",
  );
  const target = path.join(root, "outside.txt");
  expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  expect(await realpath(alias)).toBe(await realpath(target));
  const before = await readFile(target);
  await expect(
    packContextSkillFolder({
      playgroundRootPath: path.join(root, "playground"),
      folderPath: "skills/example",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "unsupported_entry_type" });
  expect(await readFile(target)).toEqual(before);
  await rm(alias);
  const playground = path.join(root, "playground");
  const skill = path.join(playground, "skills", "example");
  const intermediate = path.join(playground, "skill-link");
  await symlink(skill, intermediate, "junction");
  expect((await lstat(intermediate)).isSymbolicLink()).toBe(true);
  await expect(
    packContextSkillFolder({
      playgroundRootPath: playground,
      folderPath: "skill-link",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "unsupported_entry_type" });
  const rootLink = path.join(root, "playground-link");
  await symlink(playground, rootLink, "junction");
  expect((await lstat(rootLink)).isSymbolicLink()).toBe(true);
  await expect(
    packContextSkillFolder({
      playgroundRootPath: rootLink,
      folderPath: "skills/example",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
});

it.runIf(enabled)(
  "rejects a precreated workspace file link and parent junction",
  async () => {
    const root = path.join(fixtureRoot!, "workspace");
    const workspace = path.join(root, "work");
    const target = path.join(root, "secret");
    const alias = path.join(workspace, "shortcut");
    const parent = path.join(workspace, "parent");
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await realpath(alias)).toBe(await realpath(target));
    await symlink(root, parent, "junction");
    expect((await lstat(parent)).isSymbolicLink()).toBe(true);
    expect(await realpath(parent)).toBe(await realpath(root));
    const before = await readFile(target);
    const files = createHostTeamHubWorkspaceFiles({
      workspacePath: workspace,
      runtimeWorkspacePath: "/workspace",
      readOnlyPaths: ["documents", "inbox", "memory"],
      signal: new AbortController().signal,
    });
    await expect(files.read("shortcut")).rejects.toThrow();
    await expect(files.read("parent/secret")).rejects.toThrow();
    await expect(
      files.install("parent/new", Buffer.from("bad"), null),
    ).rejects.toThrow();
    expect(await readFile(target)).toEqual(before);
  },
);
