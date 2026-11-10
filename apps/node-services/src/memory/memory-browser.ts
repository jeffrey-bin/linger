import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { components } from "@linger/wire-contracts/node-services-internal/types";

import { loadWikiGraphSubjectsForActor } from "./collector.js";
import { walkFiles } from "./fs-utils.js";
import { parseMemoryMarkdown, stringValue } from "./markdown.js";
import { agentMemoryRoot } from "./paths.js";
import { browseMeetings } from "./meeting-browser.js";

const maxContentChars = 200_000;
const defaultLimit = 50;

export type MemoryEntryKind = "daily" | "weekly";
type MemoryEntry = components["schemas"]["MemoryEntry"];
type MemoryEntryPage = components["schemas"]["MemoryEntryPage"];

export class MemoryBrowserNotFoundError extends Error {}

interface BrowserRequest {
  tenantId: string;
  ownerActorId: string;
}

interface MemoryFile {
  id: string;
  kind: MemoryEntryKind;
  relativePath: string;
  absolutePath: string;
  title: string;
  summary: string;
  updatedAt: string;
  date?: string;
}

export async function listMemoryEntries(input: {
  dataRoot: string;
  tenantId: string;
  ownerActorId: string;
  kind?: string;
  cursor?: string;
  limit?: number;
}): Promise<MemoryEntryPage> {
  if (input.kind === "meeting") return browseMeetings(input);
  const subject = await resolveSubject(input);
  const files = await collectMemoryFiles(
    input.dataRoot,
    subject.agentManagementId,
  );
  const filtered = input.kind
    ? files.filter((file) => file.kind === input.kind)
    : files;
  const offset = parseCursor(input.cursor);
  const limit = input.limit ?? defaultLimit;
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    items: page.map((file) => ({
      ...toEntry(file, ""),
      content: "",
    })),
    ...(nextOffset < filtered.length
      ? { next_cursor: String(nextOffset) }
      : {}),
  };
}

export async function getMemoryEntry(input: {
  dataRoot: string;
  tenantId: string;
  ownerActorId: string;
  entryId: string;
}): Promise<MemoryEntry> {
  if (input.entryId.startsWith("meeting_")) {
    const meeting = (await browseMeetings(input)).items[0];
    if (!meeting) throw new MemoryBrowserNotFoundError("Meeting was not found");
    return meeting;
  }
  const subject = await resolveSubject(input);
  const files = await collectMemoryFiles(
    input.dataRoot,
    subject.agentManagementId,
  );
  const file = files.find((candidate) => candidate.id === input.entryId);
  if (!file) throw new MemoryBrowserNotFoundError("Memory entry was not found");
  const content = await fs.readFile(file.absolutePath, "utf8");
  return {
    ...toEntry(file, content.slice(0, maxContentChars)),
  };
}

async function resolveSubject(input: BrowserRequest) {
  const subjects = await loadWikiGraphSubjectsForActor(input.ownerActorId);
  const subject = subjects.find(
    (candidate) => candidate.tenantId === input.tenantId,
  );
  if (!subject) {
    throw new MemoryBrowserNotFoundError("Memory subject was not found");
  }
  return subject;
}

async function collectMemoryFiles(
  dataRoot: string,
  agentId: string,
): Promise<MemoryFile[]> {
  const root = agentMemoryRoot(dataRoot, agentId);
  const files: MemoryFile[] = [];
  for (const directory of ["timeline/daily", "timeline/weekly"]) {
    for await (const absolutePath of walkFiles(path.join(root, directory))) {
      const relativePath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join("/");
      const category = classifyPath(relativePath);
      if (!category) continue;
      const content = await fs.readFile(absolutePath, "utf8");
      const parsed = parseMemoryMarkdown(content);
      const stat = await fs.stat(absolutePath);
      const date = metadataDate(parsed.metadata.date) ?? pathDate(relativePath);
      files.push({
        id: entryId(agentId, relativePath),
        kind: category,
        relativePath,
        absolutePath,
        title: parsed.title,
        summary: parsed.summary,
        updatedAt: stat.mtime.toISOString(),
        ...(date ? { date } : {}),
      });
    }
  }
  return files.sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.relativePath.localeCompare(right.relativePath),
  );
}

function classifyPath(relativePath: string): MemoryEntryKind | undefined {
  if (
    !relativePath.endsWith(".md") ||
    path.posix.basename(relativePath) === "index.md"
  ) {
    return undefined;
  }
  if (/^timeline\/daily\/[^/]+\.md$/u.test(relativePath)) {
    return "daily";
  }
  if (/^timeline\/weekly\/[^/]+\.md$/u.test(relativePath)) {
    return "weekly";
  }
  return undefined;
}

function entryId(agentId: string, relativePath: string): string {
  return `memory_${crypto
    .createHash("sha256")
    .update(`${agentId}\0${relativePath}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function toEntry(file: MemoryFile, content: string): MemoryEntry {
  return {
    content,
    id: file.id,
    kind: file.kind,
    path: file.relativePath,
    title: file.title,
    summary: file.summary,
    updated_at: file.updatedAt,
    ...(file.date ? { date: file.date } : {}),
  };
}

function parseCursor(value: string | undefined): number {
  if (!value) return 0;
  if (!/^[0-9]{1,9}$/u.test(value))
    throw new TypeError("Memory cursor is invalid");
  return Number(value);
}

function metadataDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  const string = stringValue(value);
  return string && /^\d{4}-\d{2}-\d{2}$/u.test(string) ? string : undefined;
}

function pathDate(relativePath: string): string | undefined {
  const match = relativePath.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\.md)?$/u);
  return match?.[1];
}
