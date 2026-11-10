import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseOkfFrontmatter } from "@linger/knowledge-format";
import {
  PERSONAL_WIKI_ENTITY_TYPES,
  type PersonalWikiNodeTypeId,
} from "./personal-wiki-node-types.js";

/**
 * A read-only index of the existing durable pages: routing tasks see it (or
 * its candidates) to map new evidence to existing entities. Never published.
 */

const MAX_SUMMARY_CHARS = 160;

/** One existing durable page as the registry lists it. */
export interface WikiEntityEntry {
  path: string;
  type: PersonalWikiNodeTypeId;
  name: string;
  aliases: string[];
  parts: string[];
  updated: string | undefined;
  description: string;
}

/** Every durable page under `wikiRoot`, by type and path. */
export async function readEntityIndex(
  wikiRoot: string,
): Promise<WikiEntityEntry[]> {
  const entries: WikiEntityEntry[] = [];
  for (const definition of PERSONAL_WIKI_ENTITY_TYPES) {
    const pages = await markdownPages(join(wikiRoot, definition.directory));
    for (const page of pages.sort()) {
      const content = await readFile(page, "utf8");
      const fields = parseOkfFrontmatter(content).fields ?? {};
      entries.push({
        path: relative(wikiRoot, page).replaceAll("\\", "/"),
        type: definition.id,
        name:
          text(fields[definition.nameField]) ||
          text(fields.title) ||
          (/^# (.+)$/mu.exec(content)?.[1] ?? "").trim() ||
          "unknown",
        aliases: Array.isArray(fields.aliases)
          ? fields.aliases.map(text).filter(Boolean)
          : [],
        parts: entityParts(content, definition.partsSection),
        updated: latestChangeDate(content),
        description: clip(text(fields.description)),
      });
    }
  }
  return entries;
}

/** The registry file: one line per page, grouped by type. */
export function renderEntityRegistry(
  entries: readonly WikiEntityEntry[],
): string {
  const lines = [
    "# Existing Wiki entities",
    "",
    "Application-generated and read-only. Use it to find existing entities before writing; it is navigation, not evidence.",
    "Each line: path | name | aliases | parts | last update | summary.",
  ];
  for (const definition of PERSONAL_WIKI_ENTITY_TYPES) {
    lines.push("", `## ${definition.directory}/ (${definition.id})`);
    const pages = entries.filter((entry) => entry.type === definition.id);
    lines.push(
      ...(pages.length
        ? pages.map(
            (entry) =>
              `- ${[
                entry.path,
                entry.name,
                `aliases: ${entry.aliases.join("; ") || "none"}`,
                `parts: ${entry.parts.join("; ") || "none"}`,
                `updated: ${entry.updated ?? "unknown"}`,
                entry.description,
              ]
                .filter(Boolean)
                .join(" | ")}`,
          )
        : ["- none"]),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function markdownPages(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, {
      withFileTypes: true,
      recursive: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== "index.md",
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Subheadings inside one H2 section: the entity's recorded parts. */
export function entityParts(content: string, section: string): string[] {
  const body = new RegExp(
    `^## ${escapeRegExp(section)}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
    "mu",
  ).exec(content)?.[1];
  if (!body) return [];
  return [...body.matchAll(/^#{3,6} (.+)$/gmu)].map((match) =>
    match[1]!.replace(/^[A-Z][A-Za-z ]{0,30}:\s+/u, "").trim(),
  );
}

/** The newest dated entry in the page's Change Log. */
function latestChangeDate(content: string): string | undefined {
  const log = /^## Change Log\s*$([\s\S]*?)(?=^## |(?![\s\S]))/mu.exec(
    content,
  )?.[1];
  const dates = [...(log ?? "").matchAll(/^\s*-\s*(\d{4}-\d{2}-\d{2})/gmu)].map(
    (match) => match[1]!,
  );
  return dates.sort().at(-1);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function clip(value: string): string {
  return value.length > MAX_SUMMARY_CHARS
    ? `${value.slice(0, MAX_SUMMARY_CHARS - 1)}…`
    : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
