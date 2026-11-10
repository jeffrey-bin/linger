import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeRetiredAgentState } from "../../../src/agent/bootstrap/retired-agent-state.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("retired Agent Service state", () => {
  it("removes the retired roots and keeps each Agent's live directories", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "retired-agent-state-"));
    roots.push(home);
    const workspaces = path.join(home, "agent-manager", "workspaces");
    const contextHost = path.join(workspaces, "context-host");
    const agent = path.join(contextHost, "agent-1");
    for (const directory of [
      path.join(workspaces, "agent-skills", "agent-1"),
      path.join(workspaces, "context-transfer"),
      path.join(workspaces, "sandboxes"),
      path.join(home, "agent-manager", "runtime-state", "a".repeat(64)),
      path.join(agent, "runtime-views", "view-1"),
      path.join(agent, "runtime-view-retired"),
      path.join(agent, "host-state"),
      path.join(agent, "playground"),
    ]) {
      await mkdir(directory, { recursive: true });
    }
    await writeFile(path.join(agent, "playground", "note.md"), "keep\n");

    await removeRetiredAgentState(home, contextHost);

    expect((await readdir(workspaces)).sort()).toEqual(["context-host"]);
    expect(await readdir(path.join(home, "agent-manager"))).toEqual([
      "workspaces",
    ]);
    expect(await readdir(agent)).toEqual(["playground"]);
  });

  it("accepts a home that has no Agent state yet", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "retired-agent-state-"));
    roots.push(home);
    await expect(
      removeRetiredAgentState(
        home,
        path.join(home, "agent-manager", "workspaces", "context-host"),
      ),
    ).resolves.toBeUndefined();
  });
});
