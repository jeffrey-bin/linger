import { ensureDir, markMemoryChanged } from "./fs-utils.js";
import fs from "node:fs/promises";
import path from "node:path";
import { memoryDatabase } from "./database.js";
import { memoryFilePath } from "./paths.js";
import { storePocketNoteSource } from "./search/source-store.js";
import { pocketNoteSessionPath } from "./session-source.js";
import type { AnotherMeSubject } from "./types.js";
import { memoryLogger } from "./run-telemetry.js";

export type PocketNoteSubject = Pick<
  AnotherMeSubject,
  | "agentManagementId"
  | "memorySubjectKey"
  | "representedHumanActorId"
  | "tenantId"
>;

export type PocketNoteLoader = (
  subject: PocketNoteSubject,
  date: string,
) => Promise<string | undefined>;

/**
 * Reads the represented Human's Pocket Note page for one local day; a page
 * the Human deleted is not in memory_source.pocket_notes and reads as missing.
 */
export const loadPocketNote: PocketNoteLoader = async (subject, date) => {
  const rows = await memoryDatabase()<{ body: string }[]>`
    SELECT body FROM memory_source.pocket_notes
    WHERE tenant_id = ${subject.tenantId}
      AND owner_actor_id = ${subject.representedHumanActorId}
      AND note_date = ${date}::date`;
  return rows[0]?.body;
};

/** The day's Pocket Note as a Session file, as Daily and Tracking Items read it. */
export function pocketNoteSessionContent(date: string, text: string): string {
  const title = `${date} Pocket Note`;
  return `---\ntype: Session Evidence\ntitle: ${JSON.stringify(title)}\ndate: ${date}\nsource_kind: pocket_note\nsources:\n  - resource: teamhub://pocket-notes/${date}\n---\n\n# ${title}\n\n## Authoritative Raw Evidence\n\n${text}\n`;
}

/**
 * Stages the day's Pocket Note for Raw search, Daily, and Tracking Items.
 * The note is optional Raw context: an empty or missing page withdraws
 * the day's Session file, and any failure is logged and skipped so it never
 * blocks Room or recording collection.
 */
export async function stagePocketNote(
  memoryRoot: string,
  subject: PocketNoteSubject,
  date: string,
  load: PocketNoteLoader = loadPocketNote,
): Promise<boolean> {
  const targetPath = memoryFilePath(
    memoryRoot,
    subject.memorySubjectKey,
    ...pocketNoteSessionPath(date).split("/"),
  );
  try {
    const text = (await load(subject, date))?.trim();
    if (!text) {
      await fs.rm(targetPath, { force: true });
      await markMemoryChanged(memoryRoot, subject.memorySubjectKey);
      return false;
    }
    await ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, pocketNoteSessionContent(date, text));
    await markMemoryChanged(memoryRoot, subject.memorySubjectKey);
    await storePocketNoteSource(memoryRoot, subject, date, text);
    return true;
  } catch (error) {
    memoryLogger().log("warn", "memory.pocket_note_skipped", {
      memory_subject_key: subject.memorySubjectKey,
      date,
      error,
    });
    return false;
  }
}
