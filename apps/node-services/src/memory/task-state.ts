import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomicJsonFile } from "./fs-utils.js";
import { SESSION_ID_PATTERN } from "./session-source.js";

export interface MemoryTaskState {
  clearWikiPending(
    memoryRoot: string,
    date: string,
    subjectKey?: string,
  ): Promise<void>;
  hasWikiPending(
    memoryRoot: string,
    date: string,
    subjectKey?: string,
  ): Promise<boolean>;
  markWikiPending(
    memoryRoot: string,
    date: string,
    subjectKey?: string,
  ): Promise<void>;
}

export const filesystemMemoryTaskState: MemoryTaskState = {
  async clearWikiPending(memoryRoot, date, subjectKey) {
    await fs.rm(wikiPendingPath(memoryRoot, date, subjectKey), {
      force: true,
    });
    if (!subjectKey) {
      for (const file of await subjectPendingFiles(memoryRoot, date))
        await fs.unlink(file);
    }
  },

  async hasWikiPending(memoryRoot, date, subjectKey) {
    try {
      await fs.access(wikiPendingPath(memoryRoot, date, subjectKey));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return (
          !subjectKey &&
          (await subjectPendingFiles(memoryRoot, date)).length > 0
        );
      throw error;
    }
  },

  async markWikiPending(memoryRoot, date, subjectKey) {
    await writeAtomicJsonFile(wikiPendingPath(memoryRoot, date, subjectKey), {
      date,
      updated_at: new Date().toISOString(),
    });
  },
};

export function wikiPendingPath(
  memoryRoot: string,
  date: string,
  subjectKey?: string,
): string {
  if (subjectKey && !SESSION_ID_PATTERN.test(subjectKey))
    throw new Error("Invalid pending Memory subject");
  return path.join(
    memoryRoot,
    "updates",
    "task-state",
    "wiki-pending",
    subjectKey ? `${date}/${subjectKey}.json` : `${date}.json`,
  );
}

async function subjectPendingFiles(
  memoryRoot: string,
  date: string,
): Promise<string[]> {
  const directory = path.join(
    memoryRoot,
    "updates",
    "task-state",
    "wiki-pending",
    date,
  );
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          SESSION_ID_PATTERN.test(entry.name.slice(0, -5)) &&
          entry.name.endsWith(".json"),
      )
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
