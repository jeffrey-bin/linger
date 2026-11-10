import { createHash } from "node:crypto";
import type { WikiChangeSet } from "./backend.js";

export const OMITTED_PERSONAL_PAGES = [
  "quickstart.md",
  "themes.md",
  "commitments.md",
  "personal-logistics.md",
  "open-questions.md",
];

export function canonicalRawSourceUrl(sourceUrl: string): string {
  return sourceUrl.replace(
    /^document:\/\/([^/]+)\/versions\/([^/]+)$/u,
    "teamhub://documents/$1/versions/$2",
  );
}

/**
 * What a Wiki citation opens: one Room message, or an immutable Document
 * version such as a recording's transcript.
 */
const RAW_SOURCE_URL = String.raw`teamhub://(?:rooms/[A-Za-z0-9_-]+/messages/[A-Za-z0-9_-]+|documents/[A-Za-z0-9_-]+/versions/[A-Za-z0-9_-]+)`;
const RAW_SOURCE_URL_PATTERN = new RegExp(`^${RAW_SOURCE_URL}$`, "u");

export function isRawSourceUrl(value: string): boolean {
  return RAW_SOURCE_URL_PATTERN.test(value);
}

/** Every citation target named in a text, in order of appearance. */
export function rawSourceUrlsIn(text: string): string[] {
  return (
    text.match(new RegExp(`${RAW_SOURCE_URL}(?![A-Za-z0-9_/-])`, "gu")) ?? []
  );
}

export function roomMessageUrl(roomId: string, messageId: string): string {
  return `teamhub://rooms/${roomId}/messages/${messageId}`;
}

/** The short catalog token a run cites a source URL by. */
export function rawSourceReference(url: string): string {
  return `raw:S${createHash("sha256").update(canonicalRawSourceUrl(url)).digest("hex").slice(0, 16)}`;
}

export function wikiSourceReferences(
  changes: WikiChangeSet,
  rawSourceUrls: readonly string[] = [],
): Map<string, string> {
  const urls = rawSourceUrls.length
    ? rawSourceUrls
    : [...changes.added, ...changes.modified].map((input) => input.sourceUrl);
  return new Map(
    [...new Set(urls.map(canonicalRawSourceUrl))]
      .sort()
      .map((url) => [rawSourceReference(url), url]),
  );
}
