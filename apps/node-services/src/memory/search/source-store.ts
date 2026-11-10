import { assertDirectoryLock, withDirectoryLock } from "../filesystem-lock.js";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  collectionSessionPath,
  pocketNoteSessionPath,
  SESSION_PATH_PATTERN,
  sessionSourceUri,
} from "../session-source.js";
import type { PersonalKnowledgeQueryRequest } from "@linger/wire-contracts/node-services-internal/client";
import { SESSION_ITEM_LABELS } from "@linger/knowledge-format/sections";
import { markMemoryChanged } from "../fs-utils.js";
import { agentWorkspaceRoot } from "../paths.js";
import type { AnotherMeSubject, SessionlyCollection } from "../types.js";

export interface RawSourceReference {
  sourceId: string;
  anchorPath: string;
  contentHash?: string;
  sourceUri?: string;
  date?: string;
  kind?: string;
}

export type SourceIdentity = Pick<
  PersonalKnowledgeQueryRequest,
  "agent_id" | "tenant_id" | "user_artifact_owner_actor_id"
>;

export interface RawSource {
  schemaVersion: 1;
  id: string;
  identity: SourceIdentity;
  anchorPath: string;
  anchorHash: string;
  contentHash: string;
  title: string;
  sourceUri: string;
  date: string;
  sourceKind?: RawSourceKind;
  originKind?: RawOriginKind;
  sourceVersion?: string;
  representationFormat?: "markdown";
  metadata?: Readonly<Record<string, string>>;
}

export type RawSourceKind =
  | "room_message"
  | "recording_transcript"
  | "document"
  | "pocket_note"
  | "profile"
  | "wiki_page"
  | "period_report";

export type RawOriginKind =
  | "room"
  | "recording"
  | "my_pages"
  | "period_summary"
  | "mail"
  | "pocket_note"
  | "profile"
  | "wiki";

export interface DocumentRawSourceInput {
  identity: SourceIdentity;
  documentId: string;
  /** The version TeamHub normalized: a native body sequence or a file Version. */
  textSourceKind: "native_body" | "file_version";
  textSourceId: string;
  title: string;
  filename: string;
  mediaType: string;
  markdown: string;
  date: string;
  folderPath?: string;
  originKind?: "my_pages" | "mail";
}

const RAW_ROOT = "memory-state/raw";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ROOM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
// Sources that only PostgreSQL stores: TeamHub documents, published Wiki
// pages and Daily or Weekly reports.
const DOCUMENT_DIRECTORY_PATTERN =
  /^memory-state\/raw\/(?:documents|wiki|reports)\/([a-f0-9]{64})$/u;
const PROFILE_DIRECTORY = `${RAW_ROOT}/profile`;
export const MAX_SOURCE_BYTES = 5_000_000;
const MAX_DOCUMENT_RAW_BYTES = 32 * 1024 * 1024;
export const MAX_SOURCE_FILES = 100;

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** These salts are part of published Raw citation IDs, independent of disk layout. */
function sourceIdentityHash(identity: SourceIdentity, anchor: string): string {
  const key = anchor
    .replace(/^memory-state\/evidence\//u, "memory/front/")
    .replace(/^memory-state\/raw\//u, "memory/graph/raw/");
  return contentHash(`${identity.tenant_id}:${identity.agent_id}:${key}`);
}

/** Short enough for a model to copy exactly; reads resolve the prefixes
 * within the authorized owner scope and verify the current version. */
export const RAW_EVIDENCE_PREFIX_LENGTH = 16;

export function rawEvidenceId(source: RawSource): string {
  return `raw_${source.id.slice(0, RAW_EVIDENCE_PREFIX_LENGTH)}_${source.contentHash.slice(0, RAW_EVIDENCE_PREFIX_LENGTH)}`;
}

// Files here are staging/projection data for publication and indexing, not query authority.

/** Relative, bounded, non-symlink reads only. No source URI is ever fetched. */
export async function readWorkspaceText(
  workspaceRoot: string,
  relativePath: string,
  maxBytes = MAX_SOURCE_BYTES,
): Promise<string | undefined> {
  const parts = relativePath.split("/");
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || part.includes("\\"),
    )
  )
    return undefined;
  try {
    let current = workspaceRoot;
    for (const part of ["", ...parts]) {
      if (part) current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return undefined;
    }
    const file = await fs.open(
      current,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) return undefined;
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          size,
          buffer.length - size,
          size,
        );
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > maxBytes) return undefined;
      return buffer.subarray(0, size).toString("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Trusted ingestion only: call after the corresponding Memory file has been applied. */
export async function storeSessionSource(
  dataRoot: string,
  collection: SessionlyCollection,
): Promise<void> {
  const agentId = collection.subjects[0]?.agentManagementId;
  if (!agentId) throw new Error("Invalid Session source scope");
  const workspaceRoot = agentWorkspaceRoot(dataRoot, agentId);
  try {
    await withDirectoryLock(workspaceRoot, () =>
      writeSessionSource(workspaceRoot, collection),
    );
  } finally {
    await markMemoryChanged(dataRoot, agentId);
  }
}

/**
 * Trusted ingestion only: publish one day's Pocket Note text as Raw after its
 * Session anchor was written. Edits on the same day replace the current
 * version in place.
 */
export async function storePocketNoteSource(
  dataRoot: string,
  subject: Pick<
    AnotherMeSubject,
    "agentManagementId" | "tenantId" | "representedHumanActorId"
  >,
  date: string,
  text: string,
): Promise<void> {
  const workspaceRoot = agentWorkspaceRoot(dataRoot, subject.agentManagementId);
  try {
    await withDirectoryLock(workspaceRoot, () =>
      writePocketNoteSource(workspaceRoot, subject, date, text),
    );
  } finally {
    await markMemoryChanged(dataRoot, subject.agentManagementId);
  }
}

/**
 * The Raw manifest of a TeamHub document from its normalized Markdown in
 * TeamHub's document_texts; only PostgreSQL stores it.
 */
export function documentRawSource(input: DocumentRawSourceInput): RawSource {
  if (
    !DOCUMENT_ID_PATTERN.test(input.documentId) ||
    !DOCUMENT_ID_PATTERN.test(input.textSourceId) ||
    !validSourceDate(input.date) ||
    !input.title.trim() ||
    !input.filename.trim() ||
    !input.markdown.trim() ||
    Buffer.byteLength(input.markdown) > MAX_DOCUMENT_RAW_BYTES
  ) {
    throw new Error("Invalid Document Raw source");
  }
  const markdownHash = contentHash(input.markdown);
  const directory = `${RAW_ROOT}/documents/${contentHash(input.documentId)}`;
  const anchorPath = `${directory}/source.json`;
  const anchor = `${JSON.stringify({
    document_id: input.documentId,
    text_source_id: input.textSourceId,
    sha256: markdownHash,
  })}\n`;
  const metadata = Object.fromEntries(
    Object.entries({
      document_id: input.documentId,
      text_source_kind: input.textSourceKind,
      text_source_id: input.textSourceId,
      filename: input.filename,
      media_type: input.mediaType,
      folder_path: input.folderPath,
    }).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  return {
    schemaVersion: 1,
    id: sourceIdentityHash(input.identity, anchorPath),
    identity: input.identity,
    anchorPath,
    anchorHash: contentHash(anchor),
    contentHash: markdownHash,
    title: input.title.slice(0, 512),
    sourceUri:
      input.textSourceKind === "file_version"
        ? `teamhub://documents/${input.documentId}/versions/${input.textSourceId}`
        : `teamhub://documents/${input.documentId}`,
    date: input.date,
    sourceKind: "document",
    originKind: input.originKind ?? "my_pages",
    sourceVersion: input.textSourceId,
    representationFormat: "markdown",
    metadata,
  };
}

const citationLabelPart = String.raw`[ \t]*R\d+(?:[ \t]*(?:[-–—~,;，；、]|and|&)[ \t]*R?\d+)*[ \t]*`;
const citationLabel = String.raw`(?:\\?\[${citationLabelPart}\\?\](?![(:])|[(（]${citationLabelPart}[)）])`;
const citationLabels = new RegExp(
  String.raw`[ \t\u3000]*(?:${SESSION_ITEM_LABELS.evidence}: )?${citationLabel}(?:[ \t]*[,，、;；]?[ \t]*${citationLabel})*`,
  "gu",
);

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)*/u;

/**
 * The text of a Wiki page that search chunks and reads: its body without the
 * inline citation labels (`[R1]`, `[R1, R2]`, `(R2)`), with the page's
 * description and aliases from its frontmatter after the title, and without
 * the rest of the frontmatter (sources, relations, item IDs). The stored page
 * keeps everything; chunk offsets refer to this text.
 */
export function wikiPageSearchText(markdown: string): string {
  const match = frontmatter.exec(markdown);
  const body = (match ? markdown.slice(match[0].length) : markdown).replace(
    citationLabels,
    "",
  );
  const lines = match ? describedBy(match[1]!) : [];
  if (!lines.length) return body;
  const title = /^# .*(?:\r?\n|$)/u.exec(body)?.[0] ?? "";
  return `${title}${title ? "\n" : ""}${lines.join("\n")}\n\n${body.slice(title.length).replace(/^(?:\r?\n)+/u, "")}`;
}

/** The description and aliases a page's frontmatter names it by. */
function describedBy(block: string): string[] {
  let meta: unknown;
  try {
    meta = JSON.parse(block);
  } catch {
    return [];
  }
  if (!meta || typeof meta !== "object") return [];
  const { description, aliases } = meta as Record<string, unknown>;
  const names = Array.isArray(aliases)
    ? aliases.filter(
        (alias): alias is string =>
          typeof alias === "string" && alias.trim() !== "",
      )
    : [];
  return [
    ...(typeof description === "string" && description.trim()
      ? [description.trim()]
      : []),
    ...(names.length ? [`Aliases: ${names.join(", ")}`] : []),
  ];
}

/** The text of a source that search chunks and reads. */
export function sourceSearchText(
  sourceKind: RawSourceKind | undefined,
  content: string,
): string {
  return sourceKind === "wiki_page" ? wikiPageSearchText(content) : content;
}

/**
 * One page of the Human's published Wiki as Raw, kept at the Wiki's current
 * revision; only PostgreSQL stores it.
 */
export function wikiPageRawSource(input: {
  identity: SourceIdentity;
  pageKey: string;
  title: string;
  documentId: string;
  documentVersionId: string;
  publishedAt: string;
  revision: string;
  markdown: string;
}): RawSource {
  const date = input.publishedAt.slice(0, 10);
  if (
    !input.pageKey ||
    !DOCUMENT_ID_PATTERN.test(input.documentId) ||
    !DOCUMENT_ID_PATTERN.test(input.documentVersionId) ||
    !input.revision ||
    !validSourceDate(date) ||
    Buffer.byteLength(input.markdown) > MAX_DOCUMENT_RAW_BYTES
  ) {
    throw new Error("Invalid Wiki page Raw source");
  }
  const anchorPath = `${RAW_ROOT}/wiki/${contentHash(input.pageKey)}/source.json`;
  return {
    schemaVersion: 1,
    id: sourceIdentityHash(input.identity, anchorPath),
    identity: input.identity,
    anchorPath,
    anchorHash: contentHash(
      `${JSON.stringify({ page_key: input.pageKey, document_version_id: input.documentVersionId })}\n`,
    ),
    contentHash: contentHash(input.markdown),
    title: (input.title.trim() || input.pageKey).slice(0, 512),
    sourceUri: `teamhub://documents/${input.documentId}/versions/${input.documentVersionId}`,
    date,
    sourceKind: "wiki_page",
    originKind: "wiki",
    sourceVersion: input.documentVersionId,
    representationFormat: "markdown",
    metadata: {
      page_key: input.pageKey,
      document_id: input.documentId,
      document_version_id: input.documentVersionId,
      published_at: input.publishedAt,
      wiki_revision: input.revision,
    },
  };
}

/** One Daily or Weekly report, indexed beside the Wiki pages (origin
 * `period_summary`) and never as Raw; only PostgreSQL stores it. */
export function periodReportSource(input: {
  identity: SourceIdentity;
  collection: "daily" | "weekly";
  periodStart: string;
  title: string;
  markdown: string;
}): RawSource {
  if (
    !validSourceDate(input.periodStart) ||
    !input.markdown.trim() ||
    Buffer.byteLength(input.markdown) > MAX_DOCUMENT_RAW_BYTES
  ) {
    throw new Error("Invalid report Raw source");
  }
  const key = `${input.collection}:${input.periodStart}`;
  const anchorPath = `${RAW_ROOT}/reports/${contentHash(key)}/source.json`;
  return {
    schemaVersion: 1,
    id: sourceIdentityHash(input.identity, anchorPath),
    identity: input.identity,
    anchorPath,
    anchorHash: contentHash(`${JSON.stringify({ report: key })}\n`),
    contentHash: contentHash(input.markdown),
    title: (input.title.trim() || key).slice(0, 512),
    sourceUri: `teamhub://memory/${input.collection}/${input.periodStart}`,
    date: input.periodStart,
    sourceKind: "period_report",
    originKind: "period_summary",
    representationFormat: "markdown",
    metadata: { collection: input.collection, period_start: input.periodStart },
  };
}

/**
 * The source kind a search result names: where the source came from. Session
 * and recording Raw written before origins were recorded are told apart by
 * their path.
 */
export function rawSourceOriginKind(source: RawSource): RawOriginKind {
  if (source.originKind) return source.originKind;
  return source.anchorPath.includes("/recordings/") ? "recording" : "room";
}

/** The `memory_index.sources` primary key of one Raw source of one Agent. */
export function databaseSourceId(source: {
  documentId: string;
  identity: SourceIdentity;
}): string {
  return `mis_${createHash("sha256")
    .update(
      `${source.identity.tenant_id}:${source.identity.user_artifact_owner_actor_id}:${source.identity.agent_id}:${source.documentId}`,
    )
    .digest("hex")
    .slice(0, 24)}`;
}

/** The index profile of a source row whose chunks are not committed yet. */
export const PENDING_INDEX_PROFILE = "raw-pending";

/**
 * The represented Human's current Profile Revision as Raw. One source per
 * Agent: a newer Revision replaces the indexed version in place.
 */
export function profileRawSource(input: {
  identity: SourceIdentity;
  revisionId: string;
  date: string;
  markdown: string;
}): RawSource {
  if (
    !DOCUMENT_ID_PATTERN.test(input.revisionId) ||
    !validSourceDate(input.date) ||
    !input.markdown.trim() ||
    Buffer.byteLength(input.markdown) > MAX_SOURCE_BYTES
  ) {
    throw new Error("Invalid Profile Raw source");
  }
  const anchorPath = `${PROFILE_DIRECTORY}/source.json`;
  return {
    schemaVersion: 1,
    id: sourceIdentityHash(input.identity, anchorPath),
    identity: input.identity,
    anchorPath,
    anchorHash: contentHash(
      `${JSON.stringify({ revision_id: input.revisionId })}\n`,
    ),
    contentHash: contentHash(input.markdown),
    title: "User Profile",
    sourceUri: `teamhub://personal-profile/revisions/${input.revisionId}`,
    date: input.date,
    sourceKind: "profile",
    originKind: "profile",
    sourceVersion: input.revisionId,
    representationFormat: "markdown",
    metadata: { profile_revision_id: input.revisionId },
  };
}

export function sessionSourceText(collection: SessionlyCollection): string {
  const room = collection.rooms[0];
  if (!room) throw new Error("Session source has no Room");
  // An independent recording is not speech by its uploader.
  return collection.recording
    ? room.messages.map((message) => message.body).join("\n")
    : room.messages
        .map(
          (message) =>
            `## ${message.createdAt} · ${message.authorDisplayName.replace(/[\r\n]/gu, " ")}\n\nMessage metadata: ${JSON.stringify({ message_id: message.id, author_actor_id: message.authorActorId, author_kind: message.authorKind })}\n\n${escapeMessageHeadings(message.body)}\n${message.attachments.map((attachment) => `\n### Attachment: ${attachment.filename.replace(/[\r\n]/gu, " ")}\n\n${escapeMessageHeadings(attachment.content)}\n`).join("")}`,
        )
        .join("\n");
}

/**
 * Only Session Raw's own message headings start a line with `## `, so a
 * message body cannot pose as another message and name its metadata.
 */
function escapeMessageHeadings(text: string): string {
  return text.replace(/^## /gmu, "\\## ");
}

async function writeSessionSource(
  workspaceRoot: string,
  collection: SessionlyCollection,
): Promise<void> {
  const subject = collection.subjects[0];
  const room = collection.rooms[0];
  if (
    !subject ||
    !room ||
    collection.subjects.length !== 1 ||
    collection.rooms.length !== 1 ||
    room.memorySubjectKey !== subject.memorySubjectKey ||
    room.tenantId !== subject.tenantId ||
    !validSourceDate(collection.date) ||
    !ROOM_PATTERN.test(room.roomId)
  ) {
    throw new Error("Invalid Session source scope");
  }
  const identity: SourceIdentity = {
    agent_id: subject.agentManagementId,
    tenant_id: subject.tenantId,
    user_artifact_owner_actor_id: subject.representedHumanActorId,
  };
  const anchorPath = `memory-state/${collectionSessionPath(collection)}`;
  const anchor = await readWorkspaceText(workspaceRoot, anchorPath);
  if (anchor === undefined)
    throw new Error("Session source anchor is unavailable");
  // Recording transcripts are standalone evidence, not statements made by the uploader.
  const content = sessionSourceText(collection);
  if (Buffer.byteLength(content) > MAX_SOURCE_BYTES)
    throw new Error("Session Raw exceeds the supported byte limit");
  const source: RawSource = {
    schemaVersion: 1,
    id: sourceIdentityHash(identity, anchorPath),
    identity,
    anchorPath,
    anchorHash: contentHash(anchor),
    contentHash: contentHash(content),
    title:
      `${collection.date} ${collection.recording ? `Recording ${collection.recording.captureId}` : room.roomName}`.slice(
        0,
        512,
      ),
    sourceUri: sessionSourceUri(collection),
    date: collection.date,
    sourceKind: collection.recording ? "recording_transcript" : "room_message",
    originKind: collection.recording ? "recording" : "room",
    sourceVersion: contentHash(content),
    representationFormat: "markdown",
    metadata: {
      room_id: room.roomId,
      ...(collection.recording
        ? { capture_id: collection.recording.captureId }
        : {}),
    },
  };
  const directory = sourceDirectory(source)!;
  await ensureSafeDirectory(workspaceRoot, directory);
  const existing = await readRawManifest(workspaceRoot, directory);
  if (
    existing.present &&
    (!existing.source || !sameIdentity(existing.source.identity, identity))
  ) {
    throw new Error("Invalid Session source destination identity");
  }
  await atomicWrite(
    path.join(workspaceRoot, directory, `${source.contentHash}.md`),
    content,
  );
  // A separate manifest per source avoids lost updates between concurrent Rooms.
  await atomicWrite(
    path.join(workspaceRoot, directory, "manifest.json"),
    JSON.stringify(source),
  );
  // Publish the verified manifest before removing old bytes.
  // Retain other dates and Rooms; this is version cleanup, not a history TTL.
  await pruneSnapshots(workspaceRoot, directory, source.contentHash);
}

async function writePocketNoteSource(
  workspaceRoot: string,
  subject: Pick<
    AnotherMeSubject,
    "agentManagementId" | "tenantId" | "representedHumanActorId"
  >,
  date: string,
  text: string,
): Promise<void> {
  if (!validSourceDate(date) || !text)
    throw new Error("Invalid Pocket Note source scope");
  const identity: SourceIdentity = {
    agent_id: subject.agentManagementId,
    tenant_id: subject.tenantId,
    user_artifact_owner_actor_id: subject.representedHumanActorId,
  };
  const anchorPath = `memory-state/${pocketNoteSessionPath(date)}`;
  const anchor = await readWorkspaceText(workspaceRoot, anchorPath);
  if (anchor === undefined)
    throw new Error("Pocket Note source anchor is unavailable");
  const source: RawSource = {
    schemaVersion: 1,
    id: sourceIdentityHash(identity, anchorPath),
    identity,
    anchorPath,
    anchorHash: contentHash(anchor),
    contentHash: contentHash(text),
    title: `${date} Pocket Note`,
    sourceUri: `teamhub://pocket-notes/${date}`,
    date,
    sourceKind: "pocket_note",
    originKind: "pocket_note",
    sourceVersion: contentHash(text),
    representationFormat: "markdown",
  };
  const directory = sourceDirectory(source)!;
  await ensureSafeDirectory(workspaceRoot, directory);
  const existing = await readRawManifest(workspaceRoot, directory);
  if (
    existing.present &&
    (!existing.source || !sameIdentity(existing.source.identity, identity))
  ) {
    throw new Error("Invalid Pocket Note source destination identity");
  }
  await atomicWrite(
    path.join(workspaceRoot, directory, `${source.contentHash}.md`),
    text,
  );
  await atomicWrite(
    path.join(workspaceRoot, directory, "manifest.json"),
    JSON.stringify(source),
  );
  await pruneSnapshots(workspaceRoot, directory, source.contentHash);
}

/**
 * Delete local Raw whose Room TeamHub deleted. The Session summary that
 * anchors it stays in Memory; only the conversation copy goes.
 */
export async function deleteRawSources(
  dataRoot: string,
  agentId: string,
  sources: readonly RawSource[],
): Promise<void> {
  const workspaceRoot = agentWorkspaceRoot(dataRoot, agentId);
  try {
    await withDirectoryLock(workspaceRoot, async () => {
      for (const source of sources) {
        const directory = sourceDirectory(source);
        if (!directory) continue;
        assertDirectoryLock();
        await fs.rm(path.join(workspaceRoot, directory), {
          recursive: true,
          force: true,
        });
      }
    });
  } finally {
    await markMemoryChanged(dataRoot, agentId);
  }
}

/** Read current Raw manifests; query-time identity checks still apply. */
export async function listRawSourcesForAgent(
  workspaceRoot: string,
  agentId: string,
): Promise<RawSource[]> {
  const sources = new Map<string, RawSource>();
  for await (const directory of rawManifestDirectories(workspaceRoot)) {
    const { source } = await readRawManifest(workspaceRoot, directory);
    if (!source || source.identity.agent_id !== agentId) continue;
    sources.set(source.id, source);
  }
  const currentSources: RawSource[] = [];
  for (const source of sources.values()) {
    const current = await currentRawManifest(workspaceRoot, source);
    if (
      current?.source?.id === source.id &&
      current.source.identity.agent_id === agentId
    ) {
      currentSources.push(current.source);
    }
  }
  return currentSources.sort((left, right) => left.id.localeCompare(right.id));
}

export async function listRawSources(
  workspaceRoot: string,
  identity: SourceIdentity,
): Promise<RawSource[]> {
  return (
    await listRawSourcesForAgent(workspaceRoot, identity.agent_id)
  ).filter((source) => sameIdentity(source.identity, identity));
}

export async function readRawSource(
  workspaceRoot: string,
  source: RawSource,
): Promise<string | undefined> {
  if (!HASH_PATTERN.test(source.contentHash)) return undefined;
  const current = await currentRawManifest(workspaceRoot, source);
  if (
    !current?.source ||
    current.source.id !== source.id ||
    current.source.contentHash !== source.contentHash ||
    current.source.anchorHash !== source.anchorHash ||
    !sameIdentity(current.source.identity, source.identity)
  )
    return undefined;
  const anchor = await readWorkspaceText(workspaceRoot, source.anchorPath);
  if (anchor === undefined || contentHash(anchor) !== source.anchorHash)
    return undefined;
  const text = await readWorkspaceText(
    workspaceRoot,
    `${current.directory}/${source.contentHash}.md`,
  );
  return text !== undefined && contentHash(text) === source.contentHash
    ? text
    : undefined;
}

/**
 * Stable, workspace-relative path for the current immutable Raw snapshot.
 * TeamHub documents are read from TeamHub and never projected to disk; their
 * path only names the source in Chunk metadata.
 */
export function rawSourceContentPath(source: RawSource): string | undefined {
  const directory =
    sourceDirectory(source) ??
    documentSourceDirectory(source) ??
    (source.anchorPath === `${PROFILE_DIRECTORY}/source.json`
      ? PROFILE_DIRECTORY
      : undefined);
  if (!directory || !HASH_PATTERN.test(source.contentHash)) return undefined;
  return `${directory}/${source.contentHash}.md`;
}

async function currentRawManifest(
  workspaceRoot: string,
  source: Pick<RawSource, "date" | "anchorPath" | "id">,
): Promise<{ directory: string; source?: RawSource } | undefined> {
  const directory = sourceDirectory(source);
  if (!directory || !HASH_PATTERN.test(source.id)) return undefined;
  return { directory, ...(await readRawManifest(workspaceRoot, directory)) };
}

function sameIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return (
    left.agent_id === right.agent_id &&
    left.tenant_id === right.tenant_id &&
    left.user_artifact_owner_actor_id === right.user_artifact_owner_actor_id
  );
}

function validSourceDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}

/** Session, recording and Pocket Note Raw lives under its business date. */
function sourceDirectory(
  source: Pick<RawSource, "date" | "anchorPath">,
): string | undefined {
  const match = source.anchorPath.startsWith("memory-state/")
    ? SESSION_PATH_PATTERN.exec(source.anchorPath.slice("memory-state/".length))
    : null;
  if (!match || match[1] !== source.date || !validSourceDate(source.date))
    return undefined;
  return `${RAW_ROOT}/${source.date.replaceAll("-", "/")}/${match[2]}`;
}

function documentSourceDirectory(
  source: Pick<RawSource, "anchorPath">,
): string | undefined {
  const directory = source.anchorPath.replace(/\/source\.json$/u, "");
  return DOCUMENT_DIRECTORY_PATTERN.test(directory) ? directory : undefined;
}

function parseRawManifest(
  text: string,
  directory: string,
): RawSource | undefined {
  let source: RawSource;
  try {
    source = JSON.parse(text) as RawSource;
  } catch {
    return undefined;
  }
  if (
    !source ||
    source.schemaVersion !== 1 ||
    typeof source.identity?.agent_id !== "string" ||
    !source.identity.agent_id ||
    typeof source.identity?.tenant_id !== "string" ||
    !source.identity.tenant_id ||
    typeof source.identity?.user_artifact_owner_actor_id !== "string" ||
    !source.identity.user_artifact_owner_actor_id ||
    !HASH_PATTERN.test(source.id) ||
    !HASH_PATTERN.test(source.contentHash) ||
    !HASH_PATTERN.test(source.anchorHash) ||
    typeof source.anchorPath !== "string" ||
    typeof source.title !== "string" ||
    typeof source.sourceUri !== "string" ||
    typeof source.date !== "string" ||
    !sourceDirectory(source) ||
    source.id !== sourceIdentityHash(source.identity, source.anchorPath) ||
    !validOptionalSourceFields(source) ||
    directory !== sourceDirectory(source)
  )
    return undefined;
  return source;
}

function validOptionalSourceFields(source: RawSource): boolean {
  const sourceKinds = new Set<RawSourceKind>([
    "room_message",
    "recording_transcript",
    "document",
    "pocket_note",
    "profile",
    "wiki_page",
    "period_report",
  ]);
  const originKinds = new Set<RawOriginKind>([
    "room",
    "recording",
    "my_pages",
    "period_summary",
    "mail",
    "pocket_note",
    "profile",
    "wiki",
  ]);
  if (source.sourceKind !== undefined && !sourceKinds.has(source.sourceKind))
    return false;
  if (source.originKind !== undefined && !originKinds.has(source.originKind))
    return false;
  if (
    source.sourceVersion !== undefined &&
    (typeof source.sourceVersion !== "string" || !source.sourceVersion)
  )
    return false;
  if (
    source.representationFormat !== undefined &&
    source.representationFormat !== "markdown"
  )
    return false;
  if (source.metadata !== undefined) {
    if (
      !source.metadata ||
      typeof source.metadata !== "object" ||
      Array.isArray(source.metadata) ||
      Object.entries(source.metadata).some(
        ([key, value]) => !key || typeof value !== "string",
      )
    )
      return false;
  }
  return true;
}

async function readRawManifest(
  workspaceRoot: string,
  directory: string,
): Promise<{ present: boolean; source?: RawSource }> {
  try {
    let current = workspaceRoot;
    // Distinguish a missing manifest from unsafe paths, malformed data or a
    // broken publication (fail closed).
    const parts = ["", ...directory.split("/"), "manifest.json"];
    for (const [index, part] of parts.entries()) {
      if (part) current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (
        stat.isSymbolicLink() ||
        (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
      ) {
        return { present: true };
      }
    }
    const text = await readWorkspaceText(
      workspaceRoot,
      `${directory}/manifest.json`,
      16_000,
    );
    const source =
      text === undefined ? undefined : parseRawManifest(text, directory);
    return { present: true, ...(source ? { source } : {}) };
  } catch (error) {
    if (isMissing(error)) return { present: false };
    throw error;
  }
}

async function safeDirectoryEntries(
  workspaceRoot: string,
  directory: string,
): Promise<Dirent[]> {
  try {
    let current = workspaceRoot;
    for (const part of ["", ...directory.split("/")]) {
      if (part) current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    }
    return (await fs.readdir(current, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function* rawManifestDirectories(
  workspaceRoot: string,
): AsyncGenerator<string> {
  const levels = [
    /^\d{4}$/u,
    /^(?:0[1-9]|1[0-2])$/u,
    /^(?:0[1-9]|[12]\d|3[01])$/u,
    ROOM_PATTERN,
  ];
  async function* datedDirectories(
    directory: string,
    level: number,
  ): AsyncGenerator<string> {
    for (const entry of await safeDirectoryEntries(workspaceRoot, directory)) {
      if (!entry.isDirectory() || !levels[level]!.test(entry.name)) continue;
      const child = `${directory}/${entry.name}`;
      if (level === levels.length - 1) {
        yield child;
        if (entry.name === "recordings") {
          for (const capture of await safeDirectoryEntries(
            workspaceRoot,
            child,
          )) {
            if (capture.isDirectory() && ROOM_PATTERN.test(capture.name))
              yield `${child}/${capture.name}`;
          }
        }
      } else yield* datedDirectories(child, level + 1);
    }
  }
  for (const entry of await safeDirectoryEntries(workspaceRoot, RAW_ROOT)) {
    if (entry.isDirectory() && levels[0]!.test(entry.name))
      yield* datedDirectories(`${RAW_ROOT}/${entry.name}`, 1);
  }
}

async function pruneSnapshots(
  workspaceRoot: string,
  directory: string,
  keepHash?: string,
): Promise<void> {
  for (const entry of await safeDirectoryEntries(workspaceRoot, directory)) {
    if (
      entry.isFile() &&
      /^[a-f0-9]{64}\.md$/u.test(entry.name) &&
      entry.name !== `${keepHash}.md`
    ) {
      assertDirectoryLock();
      await fs.unlink(path.join(workspaceRoot, directory, entry.name));
    }
  }
}

async function ensureSafeDirectory(
  root: string,
  relative: string,
): Promise<void> {
  if (
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid source directory");
  if ((await fs.lstat(root)).isSymbolicLink())
    throw new Error("Unsafe source workspace");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe source directory");
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    assertDirectoryLock();
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    assertDirectoryLock();
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code))
  );
}
