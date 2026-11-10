import { parse } from "yaml";
import { isRecord } from "@linger/service-kit";

export interface ParsedMemoryFile {
  metadata: Record<string, unknown>;
  title: string;
  summary: string;
  markdownLinks: MarkdownLink[];
}

export interface MarkdownLink {
  href: string;
  label: string;
}

export function parseMemoryMarkdown(content: string): ParsedMemoryFile {
  const metadata = parseMetadataBlock(content);
  const title =
    stringValue(metadata.title) ??
    firstMarkdownHeading(content) ??
    "Untitled memory";
  return {
    metadata,
    title,
    summary: extractSimpleSummary(content, metadata, title),
    markdownLinks: extractMarkdownLinks(content),
  };
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : stringValue(value) ? [value] : [];
}

function parseMetadataBlock(content: string): Record<string, unknown> {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatter?.[1]) {
    return parseYamlRecord(frontmatter[1]);
  }
  const yamlFence = content.match(/```yaml\n([\s\S]*?)\n```/);
  if (yamlFence?.[1]) {
    return parseYamlRecord(yamlFence[1]);
  }
  return {};
}

function parseYamlRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    // Generated memories sometimes leave colon-bearing YAML scalars unquoted,
    // including list mappings such as `- title: Session: ...`.
    const repaired = raw
      .split("\n")
      .map((line) => {
        const match = line.match(/^(\s*(?:-\s+)?)([A-Za-z_][\w-]*):\s+(.+)$/u);
        if (!match || !match[3]?.includes(":")) return line;
        const value = match[3].trim();
        if (/^["'[{|>]/u.test(value)) return line;
        return `${match[1]}${match[2]}: ${JSON.stringify(value)}`;
      })
      .join("\n");
    const parsed = parse(repaired) as unknown;
    return isRecord(parsed) ? parsed : {};
  }
}

function firstMarkdownHeading(content: string): string | undefined {
  return content
    .split("\n")
    .map((line) => line.match(/^#\s+(.+)$/)?.[1]?.trim())
    .find((heading): heading is string => Boolean(heading));
}

const MAX_SIMPLE_SUMMARY_CHARS = 180;

function extractSimpleSummary(
  content: string,
  metadata: Record<string, unknown>,
  title: string,
): string {
  const body = withoutMetadata(content).replace(/```[\s\S]*?```/gu, "");
  const summary =
    stringValue(metadata.description) ??
    firstSubstantiveParagraph(body) ??
    title;
  return shortenSummary(summary, MAX_SIMPLE_SUMMARY_CHARS);
}

function withoutMetadata(content: string): string {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "")
    .replace(/```yaml\r?\n[\s\S]*?\r?\n```/u, "");
}

function firstSubstantiveParagraph(content: string): string | undefined {
  return content
    .split(/\r?\n\s*\r?\n/u)
    .map(plainMarkdown)
    .find((paragraph) => paragraph.length > 0);
}

function plainMarkdown(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/^\s{0,3}#{1,6}\s+.*$/gmu, " ")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gmu, "")
    .replace(/^\s*>\s?/gmu, "")
    .replace(/!\[([^\]\n]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]\n]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*`~]/gu, "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function shortenSummary(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  const sentenceEnd = firstSentenceEnd(characters, maximum);
  if (sentenceEnd !== undefined) {
    return characters.slice(0, sentenceEnd).join("").trim();
  }
  if (characters.length <= maximum) return normalized;

  const suffix = "...";
  const candidate = characters.slice(0, maximum - suffix.length).join("");
  const minimumBreak = Math.floor(maximum * 0.6);
  const punctuationBreak = Math.max(
    candidate.lastIndexOf(";"),
    candidate.lastIndexOf(","),
    candidate.lastIndexOf("\uff1b"),
    candidate.lastIndexOf("\uff0c"),
  );
  const whitespaceBreak = candidate.lastIndexOf(" ");
  const breakAt =
    punctuationBreak >= minimumBreak
      ? punctuationBreak + 1
      : whitespaceBreak >= minimumBreak
        ? whitespaceBreak
        : candidate.length;
  return `${candidate.slice(0, breakAt).trimEnd()}${suffix}`;
}

function firstSentenceEnd(
  characters: string[],
  maximum: number,
): number | undefined {
  const limit = Math.min(characters.length, maximum);
  for (let index = 0; index < limit; index += 1) {
    const character = characters[index];
    const next = characters[index + 1];
    const isEnd =
      character === "!" ||
      character === "?" ||
      character === "\u3002" ||
      character === "\uff01" ||
      character === "\uff1f" ||
      (character === "." && (next === undefined || /\s/u.test(next)));
    if (isEnd) return index + 1;
  }
  return undefined;
}

function extractMarkdownLinks(content: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const linkPattern = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  for (const match of content.matchAll(linkPattern)) {
    const label = match[1]?.trim();
    const href = match[2]?.trim();
    if (label && href) {
      links.push({ label, href });
    }
  }
  return links;
}
