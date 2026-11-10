import { readdir, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Deletes the directories the Agent Service wrote before Computers pulled
 * Context Views by manifest digest: the Skill extraction, file-transfer and
 * sandbox roots, each Agent's host-state and Runtime View roots, and the per-Context
 * Runtime state directories, which TeamHub Runtime State replaced. Nothing reads them, and
 * removing an absent directory is a no-op, so every start may run this.
 */
export async function removeRetiredAgentState(
  home: string,
  contextHostRoot: string,
): Promise<void> {
  const workspaces = path.join(home, "agent-manager", "workspaces");
  const targets = ["agent-skills", "context-transfer", "sandboxes"].map(
    (name) => path.join(workspaces, name),
  );
  targets.push(path.join(home, "agent-manager", "runtime-state"));
  let agents: string[] = [];
  try {
    agents = await readdir(contextHostRoot);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  for (const agent of agents) {
    for (const name of [
      "host-state",
      "runtime-views",
      "runtime-view-retired",
    ]) {
      targets.push(path.join(contextHostRoot, agent, name));
    }
  }
  await Promise.all(
    targets.map((target) => rm(target, { recursive: true, force: true })),
  );
}
