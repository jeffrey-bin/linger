import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { parseOkfFrontmatter } from "@linger/knowledge-format";
import type { WikiCandidateIssue } from "./wiki-candidate-validation.js";
import { isRecord } from "@linger/service-kit";

export function isWikiQualityWarning(issue: WikiCandidateIssue): boolean {
  return (
    !issue.page &&
    (issue.code === "missing_source_coverage" ||
      issue.code === "no_content_changes")
  );
}

/** Never infer sources or synthesize content; restore exact prior bytes or omit a new page. */
export async function recoverOptionalWikiPages(input: {
  directory: string;
  baselineDirectory: string;
  baseline: ReadonlyMap<string, string>;
  requiredTargets: readonly string[];
  issues: readonly WikiCandidateIssue[];
}): Promise<{ restored: string[]; omitted: string[] } | undefined> {
  const issues = input.issues.filter((issue) => !isWikiQualityWarning(issue));
  const required = new Set(input.requiredTargets);
  if (
    !issues.length ||
    issues.some(
      (issue) =>
        !issue.page ||
        required.has(issue.page) ||
        issue.page.split("/").includes("..") ||
        issue.page.startsWith("/") ||
        !issue.page.endsWith(".md"),
    )
  )
    return undefined;
  const restored: string[] = [];
  const omitted: string[] = [];
  for (const page of new Set(issues.map((issue) => issue.page!))) {
    if (input.baseline.has(page)) {
      const target = join(input.directory, page);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        await readFile(join(input.baselineDirectory, page)),
      );
      restored.push(page);
    } else {
      await rm(join(input.directory, page), { force: true });
      omitted.push(page);
    }
  }
  if (omitted.length > 0) {
    await removeOmittedWikiReferences(input.directory, new Set(omitted));
  }
  return { restored, omitted };
}

async function removeOmittedWikiReferences(
  directory: string,
  omittedPages: ReadonlySet<string>,
): Promise<void> {
  const relationAliases = omittedRelationAliases(omittedPages);
  for (const page of await listMarkdownFiles(directory)) {
    if (omittedPages.has(page)) continue;
    const target = join(directory, page);
    const content = await readFile(target, "utf8");
    const withoutLinks = removeOmittedMarkdownLinks(
      content,
      page,
      omittedPages,
    );
    const updated = removeOmittedRelations(withoutLinks, relationAliases);
    if (updated !== content) await writeFile(target, updated);
  }
}

function removeOmittedMarkdownLinks(
  content: string,
  page: string,
  omittedPages: ReadonlySet<string>,
): string {
  const lines = content.match(/.*(?:\r?\n|$)/gu) ?? [];
  return lines
    .map((line) => {
      const links = [...line.matchAll(markdownLinkPattern())];
      const omitted = links.some((match) =>
        resolvesToOmittedPage(page, match[2] ?? "", omittedPages),
      );
      if (
        omitted &&
        isIndexPage(page) &&
        /^\s*(?:[-*+]\s+|\d+\.\s+)\[[^\]]+\]\([^)]+\)\s*(?:\r?\n)?$/u.test(line)
      ) {
        return "";
      }
      return line.replace(
        markdownLinkPattern(),
        (marker, label: string, target: string) =>
          resolvesToOmittedPage(page, target, omittedPages) ? label : marker,
      );
    })
    .join("");
}

function markdownLinkPattern(): RegExp {
  return /(?<!!)\[([^\]]*)\]\(([^)]+)\)/gu;
}

function resolvesToOmittedPage(
  page: string,
  rawTarget: string,
  omittedPages: ReadonlySet<string>,
): boolean {
  const normalized = normalizeMarkdownTarget(rawTarget);
  if (!normalized || normalized.startsWith("#") || hasUriScheme(normalized))
    return false;
  const path = normalized.split("#", 1)[0]?.split("?", 1)[0];
  if (!path) return false;
  const resolved = posix.normalize(
    path.startsWith("/")
      ? path.slice(1)
      : posix.join(posix.dirname(page), path),
  );
  const candidates = resolved.endsWith(".md")
    ? [resolved]
    : [resolved, `${resolved}.md`, posix.join(resolved, "index.md")];
  return candidates.some((candidate) => omittedPages.has(candidate));
}

function normalizeMarkdownTarget(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<")) {
    const closing = trimmed.indexOf(">");
    return closing === -1 ? trimmed : trimmed.slice(1, closing);
  }
  return trimmed.split(/\s+["']/u, 1)[0] ?? "";
}

function hasUriScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value);
}

function omittedRelationAliases(
  omittedPages: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const aliases = new Map<string, Set<string>>();
  for (const page of omittedPages) {
    const [kind, ...rest] = page.split("/");
    if (!kind || rest.length === 0) continue;
    const relative = rest.join("/");
    const withoutExtension = relative.replace(/\.md$/u, "");
    const values = aliases.get(kind) ?? new Set<string>();
    for (const value of [
      relative,
      withoutExtension,
      page,
      page.replace(/\.md$/u, ""),
      `/${page}`,
      `/${page.replace(/\.md$/u, "")}`,
    ])
      values.add(value);
    aliases.set(kind, values);
  }
  return aliases;
}

function removeOmittedRelations(
  content: string,
  relationAliases: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(
    content,
  )?.[0];
  const fields = parseOkfFrontmatter(content).fields;
  if (!frontmatter || !fields || !isRecord(fields.relations)) return content;
  let changed = false;
  const relations = Object.fromEntries(
    Object.entries(fields.relations).map(([kind, values]) => {
      const aliases = relationAliases.get(kind);
      if (!aliases || !Array.isArray(values)) return [kind, values];
      const retained = values.filter(
        (value) => typeof value !== "string" || !aliases.has(value),
      );
      if (retained.length !== values.length) changed = true;
      return [kind, retained];
    }),
  );
  if (!changed) return content;
  return `---\n${JSON.stringify({ ...fields, relations }, null, 2)}\n---\n${content.slice(frontmatter.length)}`;
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(directory, relative), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = relative ? posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && child.endsWith(".md")) result.push(child);
    }
  };
  await walk("");
  return result.sort();
}

function isIndexPage(page: string): boolean {
  return page === "index.md" || page.endsWith("/index.md");
}
