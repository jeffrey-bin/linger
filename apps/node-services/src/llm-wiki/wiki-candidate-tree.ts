import {
  access,
  chmod,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, posix } from "node:path";

import { parseFrontmatterFields } from "openwiki/dist/okf/frontmatter.js";
import { isNodeError } from "@linger/service-kit";

import { isComputerOffline, ModelCallError } from "../runtime-model-call.js";
import { checkpointTree } from "./actor-wiki/wiki-workspace.js";
import { ActorAssetError } from "./actor-wiki/actor-asset-client.js";
import { wikiLogger } from "./log.js";
import {
  OMITTED_PERSONAL_PAGES,
  rawSourceUrlsIn,
} from "./personal-wiki-policy.js";
import {
  normalizeRegisteredNodeMetadata,
  WikiCandidateValidationError,
} from "./wiki-candidate-validation.js";

/**
 * The candidate Wiki tree a generation builds in its operation directory:
 * application-owned index pages, provenance bookkeeping, and the error
 * mapping TeamHub reads.
 */

const INDEX_EXCLUDED_FILES = new Set(["index.md", "log.md", "INSTRUCTIONS.md"]);

/**
 * Writes every directory's index.md from its pages' titles and descriptions
 * and its subdirectories, in the deterministic OpenWiki index format. A
 * directory without pages gets none.
 */
export async function synchronizeWikiIndexes(directory: string): Promise<void> {
  const visit = async (relativeDirectory: string): Promise<boolean> => {
    const absolute = join(directory, relativeDirectory);
    const files: { href: string; label: string; description?: string }[] = [];
    const directories: { href: string; label: string }[] = [];
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (await visit(posix.join(relativeDirectory, entry.name)))
          directories.push({
            href: `${encodeURIComponent(entry.name)}/`,
            label: entry.name,
          });
        continue;
      }
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".md") ||
        INDEX_EXCLUDED_FILES.has(entry.name)
      )
        continue;
      const fields =
        parseFrontmatterFields(
          await readFile(join(absolute, entry.name), "utf8"),
        ) ?? {};
      const title = usableString(fields.title);
      const description = usableString(fields.description);
      files.push({
        href: encodeURIComponent(entry.name),
        label: title ?? posix.basename(entry.name, ".md"),
        ...(description ? { description } : {}),
      });
    }
    const root = relativeDirectory === "";
    const indexPath = join(absolute, "index.md");
    if (!root && files.length + directories.length === 0) {
      await rm(indexPath, { force: true });
      return false;
    }
    const sections = [
      renderIndexLinks("Files", files),
      renderIndexLinks("Directories", directories),
    ]
      .filter(Boolean)
      .join("\n\n");
    const version = root ? '---\nokf_version: "0.2"\n---\n\n' : "";
    await writeFile(indexPath, `${version}${sections || "# Files"}\n`);
    return true;
  };
  await visit("");
}

function renderIndexLinks(
  heading: string,
  links: { href: string; label: string; description?: string }[],
): string {
  if (links.length === 0) return "";
  const items = links
    .sort((left, right) => left.href.localeCompare(right.href))
    .map(({ description, href, label }) => {
      const link = `- [${label.replace(/([\\[\]])/gu, "\\$1")}](${href})`;
      return description ? `${link} - ${description}` : link;
    });
  return `# ${heading}\n\n${items.join("\n")}`;
}

function usableString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function generationInvocationError(error: unknown): ActorAssetError {
  if (error instanceof ActorAssetError) return error;
  const detail =
    error instanceof Error && error.message.trim()
      ? error.message.replace(/\s+/gu, " ").slice(0, 500)
      : undefined;
  // A request too large for one invocation fails again on every retry.
  if (error instanceof ModelCallError && error.kind === "invalid_request")
    return new ActorAssetError(
      "WIKI_OPERATION_FAILED",
      `Wiki generation failed${detail ? `: ${detail}` : ""}`,
      "terminal",
      { cause: error },
    );
  // TeamHub waits for the Computer instead of spending a refresh attempt.
  if (isComputerOffline(error))
    return new ActorAssetError(
      "WIKI_COMPUTER_OFFLINE",
      `The Wiki owner's Computer is offline${detail ? `: ${detail}` : ""}`,
      "retryable",
      { cause: error },
    );
  return new ActorAssetError(
    "WIKI_OPERATION_RETRYABLE",
    `Wiki Runtime run is temporarily unavailable${detail ? `: ${detail}` : ""}`,
    "retryable",
    { cause: error },
  );
}

export function logGenerationStep(
  phase: string,
  startedAt: number,
  fields: Record<string, number | undefined> = {},
): void {
  wikiLogger().log("info", "wiki.generation_phase", {
    phase,
    duration_ms: Date.now() - startedAt,
    ...fields,
  });
}

export function safeRunError(error: unknown): string {
  if (error instanceof WikiCandidateValidationError) {
    return `Wiki candidate validation failed: ${[...new Set(error.issues.map((issue) => issue.code))].join(", ")}`.slice(
      0,
      512,
    );
  }
  return error instanceof ActorAssetError
    ? error.message.slice(0, 512)
    : "Wiki generation failed";
}

export async function removeOmittedPersonalPages(
  directory: string,
): Promise<void> {
  await Promise.all(
    OMITTED_PERSONAL_PAGES.map((relativePath) =>
      rm(join(directory, relativePath), { force: true, recursive: true }),
    ),
  );
}

export async function existingTeamHubSourceUrlsByPage(
  directory: string,
  paths: Iterable<string>,
): Promise<Map<string, string[]>> {
  const resourcesByPage = new Map<string, string[]>();
  for (const relativePath of paths) {
    if (!relativePath.endsWith(".md") || isIndexPage(relativePath)) continue;
    const content = await readFile(join(directory, relativePath), "utf8");
    const resources = new Set(rawSourceUrlsIn(content));
    if (resources.size > 0) {
      resourcesByPage.set(relativePath, [...resources].sort());
    }
  }
  return resourcesByPage;
}

export async function normalizeChangedMemoryNodeMetadata(
  directory: string,
  baseline: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [relativePath, digest] of await checkpointTree(directory)) {
    if (
      !relativePath.endsWith(".md") ||
      isIndexPage(relativePath) ||
      baseline.get(relativePath) === digest
    ) {
      continue;
    }
    const path = join(directory, relativePath);
    const content = await readFile(path, "utf8");
    const normalized = normalizeRegisteredNodeMetadata(relativePath, content);
    if (normalized !== content) await writeFile(path, normalized, "utf8");
  }
}

export function isIndexPage(path: string): boolean {
  return path === "index.md" || path.endsWith("/index.md");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function makeTreeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o750);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) await makeTreeWritable(target);
    else if (entry.isFile()) await chmod(target, 0o640);
    else throw new Error("Wiki candidate baseline contains a special file");
  }
}
