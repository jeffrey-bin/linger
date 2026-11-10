import fs from "node:fs/promises";
import path from "node:path";

import { filesystemMemoryTaskState } from "./task-state.js";

const RUN_RECORD_KINDS = ["sessionly", "daily", "weekly", "wiki-sync"];
const RUN_RECORD_DAYS = 7;
const REBUILD_ARCHIVE_PREFIX = "memory.pre-rebuild-";
// Retired subject files: apply no longer writes the two logs, the index only
// described them, and there is no manual refresh to keep a receipt for.
const RETIRED_UPDATE_FILES = [
  "memory_log.jsonl",
  "db_changes.jsonl",
  "index.md",
  "manual-refresh.json",
];
// Retired scheduler state: the calendar and the Session trigger state live in
// memory_index.scheduler_state and session_trigger_targets.
const RETIRED_STATE_PATHS = ["task-state/session-triggers"];
const RETIRED_CALENDAR_PREFIX = "wiki-calendar.json";

/**
 * Memory's daily file retention. A run record under updates/ goes
 * seven days after anything in it last changed, unless a Wiki sync still waits
 * on that date's Sessions. An Agent keeps only its latest rebuild archive.
 */
export async function pruneMemoryFiles(
  dataRoot: string,
  now = new Date(),
): Promise<void> {
  const cutoff = now.getTime() - RUN_RECORD_DAYS * 24 * 60 * 60_000;
  const updates = path.join(dataRoot, "updates");
  for (const retired of RETIRED_STATE_PATHS)
    await fs.rm(path.join(updates, retired), { recursive: true, force: true });
  // The old calendar and its `.invalid-<time>` copies.
  for (const name of await fileNames(updates))
    if (name.startsWith(RETIRED_CALENDAR_PREFIX))
      await fs.rm(path.join(updates, name), { force: true });
  for (const kind of RUN_RECORD_KINDS) {
    const root = path.join(updates, kind);
    for (const name of await directoryNames(root)) {
      if (
        kind === "sessionly" &&
        (await filesystemMemoryTaskState.hasWikiPending(dataRoot, name))
      )
        continue;
      const directory = path.join(root, name);
      if ((await newestChange(directory)) < cutoff)
        await fs.rm(directory, { recursive: true, force: true });
    }
  }
  for (const name of await directoryNames(dataRoot)) {
    if (name === "updates") continue;
    const agentRoot = path.join(dataRoot, name);
    for (const file of RETIRED_UPDATE_FILES)
      await fs.rm(path.join(agentRoot, "memory", "updates", file), {
        force: true,
      });
    // ISO timestamps in the names sort by time.
    const archives = (await directoryNames(agentRoot))
      .filter((entry) => entry.startsWith(REBUILD_ARCHIVE_PREFIX))
      .sort();
    for (const archive of archives.slice(0, -1))
      await fs.rm(path.join(agentRoot, archive), {
        recursive: true,
        force: true,
      });
  }
}

/** The latest modification time anywhere under target; 0 once it is gone. */
async function newestChange(target: string): Promise<number> {
  try {
    const metadata = await fs.lstat(target);
    let newest = metadata.mtimeMs;
    if (metadata.isDirectory())
      for (const entry of await fs.readdir(target))
        newest = Math.max(newest, await newestChange(path.join(target, entry)));
    return newest;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

async function fileNames(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function directoryNames(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR"].includes(String(error.code))
  );
}
