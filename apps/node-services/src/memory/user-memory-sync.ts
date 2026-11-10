// Memory's three writers of memory.md: a newly published Profile Revision
// (TeamHub asks once per publication), nightly Daily and weekly Weekly. Each also refreshes the
// read-only projection memory/me/memory.md.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isNodeError } from "@linger/service-kit";
import { memoryDatabase } from "./database.js";
import { localDate } from "./date.js";
import { withDirectoryLock, assertDirectoryLock } from "./filesystem-lock.js";
import { markMemoryChanged } from "./fs-utils.js";
import { normalizeValidMemoryMarkdown } from "./okf-validation.js";
import { memoryFilePath } from "./paths.js";
import { loadAnotherMeSubjects } from "./collector.js";
import { writeMemoryLog } from "./run-telemetry.js";
import { sessionParts } from "./session-parts.js";
import type { AnotherMeSubject } from "./types.js";
import {
  emptyUserMemory,
  maintainUserMemory,
  postgresUserMemoryStore,
  renderUserMemory,
  reportEvidence,
  type UserMemoryCadence,
  type UserMemoryEvidence,
  type UserMemoryOwner,
  type UserMemoryRevision,
  type UserMemoryStore,
} from "./user-memory.js";

const ownerOf = (subject: AnotherMeSubject): UserMemoryOwner => ({
  tenantId: subject.tenantId,
  ownerActorId: subject.representedHumanActorId,
});

/** A disposable read-only view; this Markdown is never parsed back. */
export function renderUserMemoryFile(
  revision: UserMemoryRevision | null,
): string {
  return `---
type: user_memory
title: Memory
description: Read-only projection of the Human's memory.md.
---
${renderUserMemory(revision?.sections ?? emptyUserMemory()).replace(
  "# Memory\n",
  `# Memory\n\nVersion: ${revision?.version ?? 0}. This file is generated from TeamHub; editing it changes nothing.\n`,
)}`;
}

export async function projectUserMemory(
  memoryRoot: string,
  subjectKey: string,
  owner: UserMemoryOwner,
  store: Pick<UserMemoryStore, "latest">,
): Promise<void> {
  const target = memoryFilePath(memoryRoot, subjectKey, "me/memory.md");
  await withDirectoryLock(
    path.join(path.dirname(target), ".memory-projection"),
    async () => {
      // Read after acquiring the file lock so an older snapshot cannot overwrite a newer one.
      const content = normalizeValidMemoryMarkdown(
        "me/memory.md",
        renderUserMemoryFile(await store.latest(owner)),
      );
      const current = await fs
        .readFile(target, "utf8")
        .catch((error: unknown) => {
          if (isNodeError(error, "ENOENT")) return null;
          throw error;
        });
      if (current === content) return;
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        assertDirectoryLock();
        await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
        assertDirectoryLock();
        await fs.rename(temporary, target);
        await markMemoryChanged(memoryRoot, subjectKey);
      } finally {
        await fs.unlink(temporary).catch((error: unknown) => {
          if (!isNodeError(error, "ENOENT")) throw error;
        });
      }
    },
  );
}

async function maintain(
  memoryRoot: string,
  subject: AnotherMeSubject,
  input: {
    cadence: UserMemoryCadence;
    date: string;
    parts: UserMemoryEvidence[][];
    profileRevisionId?: string;
  },
  store: UserMemoryStore,
): Promise<void> {
  const owner = ownerOf(subject);
  const result = await maintainUserMemory(
    { ...input, owner, human: subject.representedHumanDisplayName },
    store,
  );
  await projectUserMemory(memoryRoot, subject.memorySubjectKey, owner, store);
  writeMemoryLog("memory_user_memory_updated", {
    memory_subject_key: subject.memorySubjectKey,
    cadence: input.cadence,
    date: input.date,
    ...result,
  });
}

async function readReport(file: string): Promise<string> {
  return reportEvidence(
    await fs.readFile(file, "utf8").catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return "";
      throw error;
    }),
  );
}

/** The Profile Revision memory.md was built from, so a new Revision can be
 * compared with it; null when it is gone. */
async function profileMarkdown(
  owner: UserMemoryOwner,
  revisionId: string,
): Promise<string | null> {
  const [row] = await memoryDatabase()<{ markdown: string }[]>`
    SELECT markdown FROM memory_source.personal_profile_revisions
    WHERE id = ${revisionId} AND tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.ownerActorId}
  `;
  return row?.markdown ?? null;
}

/** The new Profile, after the one memory.md was built from when it exists. */
export function profileEvidence(
  current: { id: string; markdown: string },
  previous: { id: string; markdown: string } | null,
): UserMemoryEvidence[] {
  return [
    ...(previous
      ? [
          {
            ref: "previous_profile",
            kind: "profile" as const,
            content: previous.markdown,
            source: previous.id,
          },
        ]
      : []),
    {
      ref: "profile",
      kind: "profile",
      content: current.markdown,
      source: current.id,
    },
  ];
}

/** Takes in a Profile Revision newer than the one memory.md was built from;
 * the first one builds memory.md. The earlier Revision goes in too, so facts
 * the Human removed from their Profile can leave memory.md. Cheap when
 * nothing changed. */
export async function syncProfileMemory(
  memoryRoot: string,
  subject: AnotherMeSubject,
  date: string,
  store: UserMemoryStore = postgresUserMemoryStore(memoryDatabase()),
  previousProfile: typeof profileMarkdown = profileMarkdown,
): Promise<void> {
  if (!subject.userProfileRevisionId || !subject.userProfileMarkdown) return;
  const latest = await store.latest(ownerOf(subject));
  if (latest?.baseProfileRevisionId === subject.userProfileRevisionId) return;
  const previous = latest?.baseProfileRevisionId
    ? await previousProfile(ownerOf(subject), latest.baseProfileRevisionId)
    : null;
  await maintain(
    memoryRoot,
    subject,
    {
      cadence: "profile",
      date,
      parts: [
        profileEvidence(
          {
            id: subject.userProfileRevisionId,
            markdown: subject.userProfileMarkdown,
          },
          previous && latest?.baseProfileRevisionId
            ? { id: latest.baseProfileRevisionId, markdown: previous }
            : null,
        ),
      ],
      profileRevisionId: subject.userProfileRevisionId,
    },
    store,
  );
}

/** Takes in the Human's newly published Profile Revision; TeamHub asks once
 * per publication. A Human without AnotherMe has no memory.md. */
export async function syncProfileMemoryForOwner(
  memoryRoot: string,
  tenantId: string,
  ownerActorId: string,
): Promise<void> {
  const subject = (await loadAnotherMeSubjects()).find(
    (candidate) =>
      candidate.tenantId === tenantId &&
      candidate.representedHumanActorId === ownerActorId,
  );
  if (!subject) {
    writeMemoryLog("memory_user_memory_profile_skipped", {
      tenant_id: tenantId,
      owner_actor_id: ownerActorId,
      reason: "no_another_me",
    });
    return;
  }
  await syncProfileMemory(memoryRoot, subject, localDate());
}

/** Nightly, on a day with Sessions: the day's Sessions, whose edits must
 * quote the Human, and the day's Daily report. A large day is read in parts. */
export async function syncDailyMemory(
  memoryRoot: string,
  subject: AnotherMeSubject,
  date: string,
  sessions: readonly { path: string; content: string }[],
  store: UserMemoryStore = postgresUserMemoryStore(memoryDatabase()),
): Promise<void> {
  const dailyPath = memoryFilePath(
    memoryRoot,
    subject.memorySubjectKey,
    "timeline/daily",
    `${date}.md`,
  );
  const parts = dailyEvidenceParts(sessions, await readReport(dailyPath), date);
  await maintain(memoryRoot, subject, { cadence: "daily", date, parts }, store);
}

/** The Sessions in parts, with the Daily report in the first part. */
export function dailyEvidenceParts(
  sessions: readonly { path: string; content: string }[],
  daily: string,
  date: string,
): UserMemoryEvidence[][] {
  const parts: UserMemoryEvidence[][] = sessionParts(sessions).map((part) =>
    part.map((session, i) => ({
      ref: `S${i + 1}`,
      kind: "session",
      content: session.content,
      source: session.path,
    })),
  );
  if (daily)
    (parts[0] ??= []).push({
      ref: "daily",
      kind: "daily",
      content: daily,
      source: `timeline/daily/${date}.md`,
    });
  return parts;
}

export async function syncWeeklyMemory(
  memoryRoot: string,
  subject: AnotherMeSubject,
  week: { start: string; end: string },
  store: UserMemoryStore = postgresUserMemoryStore(memoryDatabase()),
): Promise<void> {
  const weekly = await readReport(
    memoryFilePath(
      memoryRoot,
      subject.memorySubjectKey,
      "timeline/weekly",
      `${week.start}.md`,
    ),
  );
  if (!weekly) return;
  await maintain(
    memoryRoot,
    subject,
    {
      cadence: "weekly",
      date: week.end,
      parts: [
        [
          {
            ref: "weekly",
            kind: "weekly",
            content: weekly,
            source: `timeline/weekly/${week.start}.md`,
          },
        ],
      ],
    },
    store,
  );
}
