import fs from "node:fs/promises";
import { applyMemoryUpdate, validateMemoryUpdate } from "./apply.js";
import { localDate } from "./date.js";
import { pathExists } from "./fs-utils.js";
import { memoryFilePath } from "./paths.js";
import {
  assertSafeMemorySubjectKey,
  memorySubjectKey,
  type MemorySubjectDescriptor,
} from "./subject.js";

export async function ensureMemoryScaffold(
  memoryRoot: string,
  subjects: readonly MemorySubjectDescriptor[],
): Promise<void> {
  const uniqueSubjects = uniqueSubjectDescriptors(subjects);
  for (const subject of uniqueSubjects) {
    const subjectKey = memorySubjectKey(subject);
    await Promise.all(
      [
        "timeline/daily",
        "timeline/weekly",
        "timeline/meetings",
        "knowledge/people",
        "knowledge/clients",
        "knowledge/projects",
        "knowledge/topics",
      ].map((dir) =>
        fs.mkdir(memoryFilePath(memoryRoot, subjectKey, dir), {
          recursive: true,
        }),
      ),
    );
    const missingFiles: Array<{ path: string; content: string }> = [];
    for (const [relativePath, content] of subjectScaffoldFiles(subject)) {
      const memoryPath = `${subjectKey}/${relativePath}`;
      const targetPath = memoryFilePath(memoryRoot, subjectKey, relativePath);
      if (!(await pathExists(targetPath))) {
        missingFiles.push({ path: memoryPath, content });
      }
    }
    if (missingFiles.length > 0) {
      await applyMemoryUpdate(
        memoryRoot,
        {
          schema_version: 1,
          date: localDate(),
          files: missingFiles,
          memory_log_entries: [],
        },
        { allowedSubjectKeys: [subjectKey] },
      );
    }
    await projectUserProfile(memoryRoot, subjectKey, subject);
  }
}

async function projectUserProfile(
  memoryRoot: string,
  subjectKey: string,
  subject: MemorySubjectDescriptor,
): Promise<void> {
  const options = {
    allowedSubjectKeys: [subjectKey],
    allowedPathPrefixes: ["me/profile.md"],
  };
  // Compare the exact normalized representation that apply will store.
  const update = await validateMemoryUpdate(
    memoryRoot,
    {
      schema_version: 1,
      date: localDate(),
      files: [
        {
          path: `${subjectKey}/me/profile.md`,
          content: userProfile(subject),
        },
      ],
      memory_log_entries: [],
    },
    options,
  );
  const content = update.files[0]!.content;
  const targetPath = memoryFilePath(memoryRoot, subjectKey, "me/profile.md");
  const current = await fs
    .readFile(targetPath, "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  if (current === normalized) {
    return;
  }
  await applyMemoryUpdate(memoryRoot, update, options);
}

function uniqueSubjectDescriptors(
  subjects: readonly MemorySubjectDescriptor[],
): MemorySubjectDescriptor[] {
  const byKey = new Map<string, MemorySubjectDescriptor>();
  for (const subject of subjects) {
    const key = assertSafeMemorySubjectKey(memorySubjectKey(subject));
    const existing = byKey.get(key);
    if (
      existing &&
      existing.representedHumanActorId !== subject.representedHumanActorId
    ) {
      throw new Error(
        `Conflicting represented human for memory subject: ${key}`,
      );
    }
    byKey.set(key, subject);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, subject]) => subject);
}

function subjectScaffoldFiles(
  subject: MemorySubjectDescriptor,
): Array<[string, string]> {
  return [
    [
      "README.md",
      `# Personal memory

- [me/](me/): memory.md holds what to remember when working with you; profile.md is the full profile.
- [timeline/](timeline/): daily reports, weekly reports and meeting notes by date.
- [knowledge/](knowledge/): people, clients, projects and topics.

The system updates these files. Meeting notes and knowledge pages come from the published personal Wiki.
`,
    ],
    ["me/profile.md", userProfile(subject)],
  ];
}

function userProfile(subject?: MemorySubjectDescriptor): string {
  if (subject?.userProfileRevisionId && subject.userProfileMarkdown) {
    return `---
type: User Profile
title: User Profile
description: Canonical profile of the represented human.
status: stable
source_revision_id: ${JSON.stringify(subject.userProfileRevisionId)}
---

# User Profile

${subject.userProfileMarkdown.trim()}
`;
  }
  return `---
type: User Profile
title: User Profile
description: Stable long-term profile of the represented human.
status: draft
---

# User Profile

Stable long-term user memory.

This profile is owned by TeamHub Profile generation. Only initial
Connect, explicit Settings Add source, or authorized maintenance may update it.
Ordinary Memory summarization must not write this file.

## Stable Facts

## Communication Style

## Work Patterns

## Collaboration Preferences

## Identity And Values

## Long-Term Project Preferences

## Evidence Notes
`;
}
