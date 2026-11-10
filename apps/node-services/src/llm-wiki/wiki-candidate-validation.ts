import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import {
  normalizeOkfMarkdown,
  parseOkfFrontmatter,
  setOkfRootIndexVersion,
  validateOkfDocument,
} from "@linger/knowledge-format";
import {
  canonicalRawSourceUrl,
  isRawSourceUrl,
  OMITTED_PERSONAL_PAGES,
  rawSourceUrlsIn,
} from "./personal-wiki-policy.js";
import { personalWikiNodeTypeForPath } from "./personal-wiki-node-types.js";
import { entityParts } from "./wiki-entity-registry.js";
import { isPublishableWikiMarkdownPath } from "./actor-wiki/wiki-workspace.js";
import { isNodeError, isRecord } from "@linger/service-kit";
import { sha256Hex } from "@linger/service-kit/node";

// Only explicit markup markers count: prose wording is never matched.
const PLACEHOLDER_PATTERNS = [
  /<\s*(?:placeholder|todo|tbd)(?:\s[^>]*)?>/iu,
  /\[\s*(?:placeholder|todo|tbd)\s*\]/iu,
];

export type WikiCandidateIssueCode =
  | "broken_internal_link"
  | "duplicate_entity_identity"
  | "empty_page"
  | "forbidden_personal_page"
  | "invalid_okf"
  | "invalid_publication"
  | "invalid_node_structure"
  | "invalid_evidence_reference"
  | "missing_source_coverage"
  | "missing_target_page"
  | "missing_new_source"
  | "missing_index"
  | "no_content_changes"
  | "no_content_pages"
  | "no_markdown_pages"
  | "placeholder_content"
  | "removed_existing_page"
  | "transient_source_link"
  | "unrelated_page_change";

export interface WikiCandidateIssue {
  code: WikiCandidateIssueCode;
  detail: string;
  page?: string;
  /** Other pages a correction may need to edit, such as a duplicate's twin. */
  relatedPages?: string[];
}

export interface WikiCandidateInspection {
  issues: WikiCandidateIssue[];
  warnings?: WikiCandidateIssue[];
  pageCount: number;
}

export class WikiCandidateValidationError extends Error {
  constructor(readonly issues: WikiCandidateIssue[]) {
    super(
      `Wiki candidate validation failed: ${formatWikiCandidateIssues(issues)}`,
    );
    this.name = "WikiCandidateValidationError";
  }
}

interface WikiCandidateInspectionOptions {
  contentBaseline?: ReadonlyMap<string, string>;
  expectedTargetPaths?: readonly string[];
  /** Each routed target's own incoming citations; one must be on it. */
  targetSourceUrls?: ReadonlyMap<string, readonly string[]>;
  enforceRegisteredNodes?: boolean;
  allowedSourceUrls?: readonly string[];
  newSourceUrls?: readonly string[];
  sourceNodeTypes?: readonly string[];
  requiredSourceUrls?: readonly string[];
  requireContentChange?: boolean;
  requireContentPage?: boolean;
  preserveBaselineContentPages?: boolean;
}

export async function inspectWikiCandidate(
  directory: string,
  options: WikiCandidateInspectionOptions = {},
): Promise<WikiCandidateInspection> {
  const markdownPaths = await listMarkdownFiles(directory).catch(
    (error: unknown) => {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    },
  );
  const markdownPathSet = new Set(markdownPaths);
  const contents = new Map(
    await Promise.all(
      markdownPaths.map(
        async (relativePath) =>
          [
            relativePath,
            await readFile(join(directory, relativePath), "utf8"),
          ] as const,
      ),
    ),
  );
  const changedContentPaths = markdownPaths.filter(
    (relativePath) =>
      !isIndexPage(relativePath) &&
      options.contentBaseline?.get(relativePath) !==
        sha256Hex(contents.get(relativePath) ?? ""),
  );
  const structured =
    options.enforceRegisteredNodes ||
    (options.expectedTargetPaths?.length ?? 0) > 0;

  const issues: WikiCandidateIssue[] = [
    ...inspectRoutedTargets(
      options,
      contents,
      markdownPathSet,
      changedContentPaths,
    ),
    ...inspectPeriodScope(options, changedContentPaths),
    ...inspectSessionScope(options, contents, changedContentPaths),
    ...inspectCandidateCoverage(
      options,
      markdownPaths,
      contents,
      changedContentPaths,
    ),
  ];
  for (const relativePath of markdownPaths) {
    issues.push(
      ...inspectCandidatePage(
        relativePath,
        contents.get(relativePath) ?? "",
        options,
        markdownPathSet,
        changedContentPaths.includes(relativePath),
      ),
    );
  }
  if (structured) {
    issues.push(...inspectDuplicateEntityIdentities(contents));
  }

  // A published, byte-identical page is not editable in this run. New
  // validation rules must not make an unrelated refresh impossible. Security
  // checks on the publication tree still run independently.
  const inherited = (issue: WikiCandidateIssue) =>
    issue.page !== undefined &&
    !isIndexPage(issue.page) &&
    contents.has(issue.page) &&
    !changedContentPaths.includes(issue.page) &&
    issue.code !== "no_content_changes" &&
    issue.code !== "missing_new_source" &&
    issue.code !== "forbidden_personal_page";
  const warnings = issues.filter(inherited);
  return {
    issues: issues.filter((issue) => !inherited(issue)),
    ...(warnings.length ? { warnings } : {}),
    pageCount: markdownPaths.length,
  };
}

/** Each routed target exists and, when required, cites its new evidence. */
function inspectRoutedTargets(
  options: WikiCandidateInspectionOptions,
  contents: ReadonlyMap<string, string>,
  markdownPathSet: ReadonlySet<string>,
  changedContentPaths: readonly string[],
): WikiCandidateIssue[] {
  const issues: WikiCandidateIssue[] = [];
  for (const targetPath of new Set(options.expectedTargetPaths ?? [])) {
    if (!markdownPathSet.has(targetPath)) {
      issues.push({
        code: "missing_target_page",
        detail: `the routed source requires ${targetPath}`,
        page: targetPath,
      });
    } else if (options.requireContentChange) {
      const content = contents.get(targetPath) ?? "";
      if (!changedContentPaths.includes(targetPath)) {
        issues.push({
          code: "no_content_changes",
          page: targetPath,
          detail:
            "a routed target must incorporate its added or modified evidence",
        });
      }
      const incoming =
        options.targetSourceUrls?.get(targetPath) ??
        options.newSourceUrls ??
        [];
      if (
        incoming.length > 0 &&
        !incoming.some((url) => content.includes(url))
      ) {
        issues.push({
          code: "missing_new_source",
          page: targetPath,
          detail: "a routed target must cite its incoming raw source",
        });
      }
    }
  }
  return issues;
}

/** Daily or Weekly evidence may change only its routed period page. */
function inspectPeriodScope(
  options: WikiCandidateInspectionOptions,
  changedContentPaths: readonly string[],
): WikiCandidateIssue[] {
  const sourceNodeTypes = new Set(options.sourceNodeTypes ?? []);
  if (
    sourceNodeTypes.size !== 1 ||
    !(sourceNodeTypes.has("daily") || sourceNodeTypes.has("weekly"))
  )
    return [];
  const periodType = sourceNodeTypes.has("weekly") ? "Weekly" : "Daily";
  const allowed = new Set(options.expectedTargetPaths ?? []);
  return changedContentPaths
    .filter((relativePath) => !allowed.has(relativePath))
    .map((relativePath) => ({
      code: "unrelated_page_change" as const,
      detail: `${periodType} evidence may update only its routed ${periodType} page`,
      page: relativePath,
    }));
}

/**
 * A Session may change its routed Session page and durable entity pages, and
 * every page it changes must cite that Session.
 */
function inspectSessionScope(
  options: WikiCandidateInspectionOptions,
  contents: ReadonlyMap<string, string>,
  changedContentPaths: readonly string[],
): WikiCandidateIssue[] {
  const sourceNodeTypes = new Set(options.sourceNodeTypes ?? []);
  if (!sourceNodeTypes.has("session")) return [];
  const issues: WikiCandidateIssue[] = [];
  const newSourceUrls = [...new Set(options.newSourceUrls ?? [])];
  const routedTargets = new Set(options.expectedTargetPaths ?? []);
  for (const relativePath of changedContentPaths) {
    const definition = personalWikiNodeTypeForPath(relativePath);
    const isDurableSessionDerivedPage =
      definition !== undefined &&
      ["client", "contact", "project", "topic"].includes(definition.id);
    const isRoutedSourcePage =
      definition !== undefined &&
      sourceNodeTypes.has(definition.id) &&
      routedTargets.has(relativePath);
    if (!isRoutedSourcePage && !isDurableSessionDerivedPage) {
      issues.push({
        code: "unrelated_page_change",
        detail:
          "a Session may update only its routed Session and supported client, contact, project, or topic pages",
        page: relativePath,
      });
    } else if (
      newSourceUrls.length > 0 &&
      !newSourceUrls.some((url) =>
        (contents.get(relativePath) ?? "").includes(url),
      )
    ) {
      issues.push({
        code: "missing_new_source",
        detail:
          "a page changed by a Session must cite a message or transcript of that Session",
        page: relativePath,
      });
    }
  }
  return issues;
}

/** The candidate as a whole: its root index, content, and provenance. */
function inspectCandidateCoverage(
  options: WikiCandidateInspectionOptions,
  markdownPaths: readonly string[],
  contents: ReadonlyMap<string, string>,
  changedContentPaths: readonly string[],
): WikiCandidateIssue[] {
  const issues: WikiCandidateIssue[] = [];
  if (!contents.has("index.md")) {
    issues.push({
      code: "missing_index",
      detail: "index.md is required at the candidate Wiki root",
    });
  }
  if (markdownPaths.length === 0) {
    issues.push({
      code: "no_markdown_pages",
      detail: "the candidate contains no publishable Markdown pages",
    });
  }
  if (
    options.requireContentPage &&
    !markdownPaths.some((relativePath) => !isIndexPage(relativePath))
  ) {
    issues.push({
      code: "no_content_pages",
      detail:
        "added or modified evidence must produce at least one entity or topic page",
    });
  }
  if (options.preserveBaselineContentPages) {
    for (const relativePath of options.contentBaseline?.keys() ?? []) {
      if (
        isPublishableWikiMarkdownPath(relativePath) &&
        !isIndexPage(relativePath) &&
        !contents.has(relativePath)
      ) {
        issues.push({
          code: "removed_existing_page",
          detail:
            "additive Session updates must preserve existing entity and topic pages",
          page: relativePath,
        });
      }
    }
  }
  const contentCorpus = markdownPaths
    .filter((relativePath) => !isIndexPage(relativePath))
    .map((relativePath) => contents.get(relativePath) ?? "")
    .join("\n");
  for (const sourceUrl of new Set(options.requiredSourceUrls ?? [])) {
    if (!contentCorpus.includes(sourceUrl)) {
      issues.push({
        code: "missing_source_coverage",
        detail: `no entity or topic page preserves required provenance ${sourceUrl}`,
      });
    }
  }
  if (options.requireContentChange && changedContentPaths.length === 0) {
    issues.push({
      code: "no_content_changes",
      detail:
        "added or modified evidence must add or update at least one entity or topic page",
    });
  }
  return issues;
}

/** One page: policy, OKF, registered node structure, evidence, and links. */
function inspectCandidatePage(
  relativePath: string,
  content: string,
  options: WikiCandidateInspectionOptions,
  markdownPathSet: ReadonlySet<string>,
  changed: boolean,
): WikiCandidateIssue[] {
  const issues: WikiCandidateIssue[] = [];
  if (OMITTED_PERSONAL_PAGES.includes(relativePath)) {
    issues.push({
      code: "forbidden_personal_page",
      detail:
        "this generic personal page is not part of the Personal Wiki information architecture",
      page: relativePath,
    });
  }
  if (content.trim().length === 0) {
    issues.push({
      code: "empty_page",
      detail: "the page has no content",
      page: relativePath,
    });
    return issues;
  }
  const okf = inspectOkfDocument(relativePath, content);
  issues.push(
    ...okf.issues.map(({ code, message }) => ({
      code: "invalid_okf" as const,
      detail: `${code}: ${message}`,
      page: relativePath,
    })),
  );
  if (
    !isIndexPage(relativePath) &&
    (options.enforceRegisteredNodes ||
      (options.expectedTargetPaths?.length ?? 0) > 0)
  ) {
    issues.push(
      ...inspectRegisteredNodeStructure(
        relativePath,
        content,
        okf.fields,
        changed,
      ),
    );
    if (options.allowedSourceUrls && changed) {
      const allowed = new Set(options.allowedSourceUrls);
      for (const source of Array.isArray(okf.fields?.sources)
        ? okf.fields.sources
        : []) {
        if (
          isRecord(source) &&
          typeof source.resource === "string" &&
          !allowed.has(source.resource)
        ) {
          issues.push({
            code: "invalid_evidence_reference",
            page: relativePath,
            detail:
              "source resource is not present in the authorized raw source catalog",
          });
        }
      }
    }
    const type = personalWikiNodeTypeForPath(relativePath)?.id;
    if (
      changed &&
      options.enforceRegisteredNodes &&
      type === "session" &&
      !options.expectedTargetPaths?.includes(relativePath)
    ) {
      issues.push({
        code: "invalid_node_structure",
        page: relativePath,
        detail:
          "Session requires an application-routed source; never invent a summary for initialization",
      });
    }
  }
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(content))) {
    issues.push({
      code: "placeholder_content",
      detail:
        "replace placeholder or generic stub text with source-grounded synthesis",
      page: relativePath,
    });
  }
  if (!isIndexPage(relativePath) && !hasSubstantiveBody(content)) {
    issues.push({
      code: "empty_page",
      detail:
        "a concept page must contain source-grounded explanatory body text",
      page: relativePath,
    });
  }
  issues.push(...inspectMarkdownLinks(relativePath, content, markdownPathSet));
  return issues;
}

/**
 * Two pages of one entity type must not share a canonical name or alias:
 * the later one should update the existing entity instead. Pages that both
 * predate this run only warn (see `inherited`), so legacy duplicates never
 * block a refresh.
 */
/** Entity types that describe the same kind of initiative and must not share an identity. */
const SHARED_IDENTITY_SCOPE: Readonly<Record<string, string>> = {
  projects: "initiative",
  topics: "initiative",
};

function inspectDuplicateEntityIdentities(
  contents: ReadonlyMap<string, string>,
): WikiCandidateIssue[] {
  const owners = new Map<string, string[]>();
  const names = new Map<string, string>();
  const parts = new Map<string, { page: string; name: string }>();
  for (const [page, content] of contents) {
    if (isIndexPage(page)) continue;
    const definition = personalWikiNodeTypeForPath(page);
    if (definition?.kind !== "entity") continue;
    const scope =
      SHARED_IDENTITY_SCOPE[definition.directory] ?? definition.directory;
    const fields = parseOkfFrontmatter(content).fields ?? {};
    const identities = [
      fields[definition.nameField],
      ...(Array.isArray(fields.aliases) ? fields.aliases : []),
    ].filter((value): value is string => typeof value === "string");
    for (const identity of new Set(identities.map(identityKey))) {
      if (identity.length < 2) continue;
      const key = `${scope}\0${identity}`;
      owners.set(key, [...(owners.get(key) ?? []), page]);
      names.set(
        key,
        identities.find((value) => identityKey(value) === identity) ?? identity,
      );
    }
    if (scope === definition.directory) continue;
    for (const name of entityParts(content, definition.partsSection)) {
      const identity = identityKey(name);
      if (identity.length >= 2)
        parts.set(`${scope}\0${identity}`, { page, name });
    }
  }
  const issues: WikiCandidateIssue[] = [];
  for (const [key, pages] of owners) {
    const part = parts.get(key);
    if (part && !pages.includes(part.page)) {
      for (const page of pages)
        issues.push({
          code: "duplicate_entity_identity",
          detail: `"${part.name}" is already a part of ${part.page}; record it there instead of a separate page, or give a genuinely distinct entity its own name`,
          page,
          relatedPages: [part.page],
        });
    }
    if (pages.length < 2) continue;
    for (const page of pages) {
      const others = pages.filter((other) => other !== page);
      issues.push({
        code: "duplicate_entity_identity",
        detail: `"${names.get(key)}" also identifies ${others.join(", ")}; merge this entity into one canonical page, or give a genuinely distinct entity its own name and drop the shared alias`,
        page,
        relatedPages: others,
      });
    }
  }
  return issues;
}

/** The comparable form of a name or alias: letters and digits, lowercase. */
export function identityKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// An untouched page keeps the section layout it was published with; a changed
// page must use the current registered layout.
function inspectRegisteredNodeStructure(
  page: string,
  content: string,
  fields: Record<string, unknown> | undefined,
  changed: boolean,
): WikiCandidateIssue[] {
  const definition = personalWikiNodeTypeForPath(page);
  if (!definition) {
    return [
      {
        code: "invalid_node_structure",
        detail: "new or changed pages must belong to a registered node type",
        page,
      },
    ];
  }
  const errors: WikiCandidateIssue[] = [];
  if (
    definition.id === "session" &&
    !/^sessions\/\d{4}-\d{2}-\d{2}\/[^/]+\.md$/u.test(page)
  ) {
    errors.push({
      code: "invalid_node_structure",
      detail: "Session pages must use sessions/YYYY-MM-DD/<session-id>.md",
      page,
    });
  }
  for (const field of definition.fields) {
    if (field === "sources") {
      if (!Array.isArray(fields?.sources) || fields.sources.length === 0) {
        errors.push({
          code: "invalid_node_structure",
          detail: "sources must contain at least one raw reference",
          page,
        });
      }
      continue;
    }
    if (field === "aliases") {
      if (
        !Array.isArray(fields?.aliases) ||
        fields.aliases.some((alias) => typeof alias !== "string")
      ) {
        errors.push({
          code: "invalid_node_structure",
          detail: "aliases must be a string list",
          page,
        });
      }
      continue;
    }
    if (!isNonEmptyString(fields?.[field])) {
      errors.push({
        code: "invalid_node_structure",
        detail: `${field} is required for ${definition.id} pages`,
        page,
      });
    }
  }
  let previousIndex = -1;
  for (const section of changed ? definition.sections : []) {
    const index = content.search(
      new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, "mu"),
    );
    if (index < 0 || index < previousIndex) {
      errors.push({
        code: "invalid_node_structure",
        detail: `required H2 section is missing or out of order: ${section}`,
        page,
      });
    } else {
      previousIndex = index;
    }
  }
  const sourceLabels = new Set<string>();
  for (const source of Array.isArray(fields?.sources) ? fields.sources : []) {
    if (!isRecord(source)) {
      errors.push({
        code: "invalid_evidence_reference",
        detail:
          "every source must be an object with an R-label and raw TeamHub resource",
        page,
      });
      continue;
    }
    const label = source.id ?? source.label;
    const resource = source.resource;
    if (typeof label !== "string" || !/^R\d+$/u.test(label)) {
      errors.push({
        code: "invalid_evidence_reference",
        detail: "every source must use an R-label such as R1",
        page,
      });
      continue;
    }
    if (typeof resource !== "string" || !isRawSourceUrl(resource)) {
      errors.push({
        code: "invalid_evidence_reference",
        detail:
          "every registered node source must point to a TeamHub Room message or an immutable Document version",
        page,
      });
    }
    if (sourceLabels.has(label)) {
      errors.push({
        code: "invalid_evidence_reference",
        detail: `${label} is duplicated in sources metadata`,
        page,
      });
    }
    sourceLabels.add(label);
  }
  for (const match of content.matchAll(/\[(R\d+)\]/gu)) {
    const label = match[1]!;
    if (!sourceLabels.has(label)) {
      errors.push({
        code: "invalid_evidence_reference",
        detail: `${label} does not resolve in this page's sources metadata`,
        page,
      });
    }
  }
  return errors;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isIndexPage(path: string): boolean {
  return path === "index.md" || path.endsWith("/index.md");
}

function hasSubstantiveBody(content: string): boolean {
  const body = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "")
    .replace(/^\s*#+\s*.*$/gmu, "")
    .replace(/[\s*_`>#\-[\]()]/gu, "");
  return body.length >= 24;
}

export async function normalizeWikiCandidate(
  directory: string,
  options: {
    sourcePaths?: readonly string[];
    sourceTitles?: readonly string[];
  } = {},
): Promise<void> {
  const markdownPaths = await listMarkdownFiles(directory).catch(
    (error: unknown) => {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    },
  );
  const exactSourcePaths = new Set(
    (options.sourcePaths ?? []).map((sourcePath) =>
      posix.normalize(sourcePath.replace(/^\/+/, "")),
    ),
  );
  const removedSourcePages = new Set(
    markdownPaths.filter((relativePath) => exactSourcePaths.has(relativePath)),
  );
  const removedPages = new Set(removedSourcePages);
  const remainingPaths = markdownPaths.filter(
    (relativePath) => !removedPages.has(relativePath),
  );
  for (const relativePath of remainingPaths) {
    if (relativePath === "index.md" || !relativePath.endsWith("/index.md")) {
      continue;
    }
    const directoryPrefix = `${posix.dirname(relativePath)}/`;
    if (
      !remainingPaths.some(
        (candidate) =>
          candidate !== relativePath && candidate.startsWith(directoryPrefix),
      )
    ) {
      removedPages.add(relativePath);
    }
  }
  const publishablePaths = markdownPaths.filter(
    (relativePath) => !removedPages.has(relativePath),
  );
  await Promise.all(
    [...removedPages].map((relativePath) => rm(join(directory, relativePath))),
  );
  const markdownPathSet = new Set(publishablePaths);
  const sourcePaths = new Set(
    [...(options.sourcePaths ?? []), ...removedSourcePages].flatMap(
      (sourcePath) => [sourcePath, posix.basename(sourcePath)],
    ),
  );
  const sourceTitles = new Set(options.sourceTitles ?? []);
  const originalContents = new Map<string, string>();
  const normalizedContents = new Map<string, string>();
  for (const relativePath of publishablePaths) {
    const content = await readFile(join(directory, relativePath), "utf8");
    originalContents.set(relativePath, content);
    const withRootVersion =
      relativePath === "index.md"
        ? removeDuplicateRootVersion(setOkfRootIndexVersion(content))
        : content;
    const withoutTransientLinks = removeTransientSourceLinks(
      relativePath,
      withRootVersion,
      markdownPathSet,
      sourcePaths,
      sourceTitles,
    );
    const withoutBrokenNavigation = isIndexPage(relativePath)
      ? removeBrokenIndexLinks(
          relativePath,
          withoutTransientLinks,
          markdownPathSet,
        )
      : removeBrokenInternalLinks(
          relativePath,
          withoutTransientLinks,
          markdownPathSet,
        );
    normalizedContents.set(
      relativePath,
      normalizeOkfMarkdown(withoutBrokenNavigation),
    );
  }
  for (const [relativePath, content] of normalizedContents) {
    const normalized = normalizeOkfMarkdown(content);
    if (normalized !== originalContents.get(relativePath)) {
      await writeFile(join(directory, relativePath), normalized, "utf8");
    }
  }
}

export function normalizeRegisteredNodeMetadata(
  relativePath: string,
  content: string,
  additionalResources: readonly string[] = [],
): string {
  const definition = personalWikiNodeTypeForPath(relativePath);
  if (!definition || isIndexPage(relativePath)) return content;
  const fields = inspectOkfDocument(relativePath, content).fields;
  if (!fields) return content;
  const frontmatter = /^(---\r?\n)[\s\S]*?(\r?\n---\r?\n?)([\s\S]*)$/u.exec(
    content,
  );
  if (!frontmatter) return content;
  const body = frontmatter[3] ?? "";
  let changed = false;
  const title =
    typeof fields.title === "string" && fields.title.trim()
      ? fields.title.trim()
      : posix.basename(relativePath, ".md").replaceAll("-", " ");
  const slug = posix.basename(relativePath, ".md");
  const date =
    relativePath.match(/\/(\d{4}-\d{2}-\d{2})\//u)?.[1] ??
    slug.match(/^\d{4}-\d{2}-\d{2}$/u)?.[0];
  const setIdentityDefault = (field: string, value: string | undefined) => {
    if (!value || isNonEmptyString(fields[field])) return;
    fields[field] = value;
    changed = true;
  };
  if (definition.id === "project") {
    setIdentityDefault("project_name", title);
    setIdentityDefault("project_slug", slug);
  }
  if (definition.id === "topic") setIdentityDefault("topic_name", title);
  if (definition.id === "client") {
    setIdentityDefault("client_name", title);
    setIdentityDefault("organization", title);
  }
  if (definition.id === "contact") setIdentityDefault("contact_name", title);
  if (definition.id === "session") {
    setIdentityDefault("session_id", slug);
    setIdentityDefault("date", date);
  }
  if (definition.fields.includes("aliases") && !Array.isArray(fields.aliases)) {
    fields.aliases = [];
    changed = true;
  }
  const rawResources = new Set<string>();
  const rawResourceByLabel = new Map<string, string>();
  for (const source of Array.isArray(fields.sources) ? fields.sources : []) {
    if (!isRecord(source) || typeof source.resource !== "string") continue;
    const resource = canonicalRawSourceUrl(source.resource);
    if (isRawSourceUrl(resource)) {
      rawResources.add(resource);
      const label = source.id ?? source.label;
      if (typeof label === "string" && /^R\d+$/u.test(label)) {
        rawResourceByLabel.set(label, resource);
      }
    }
  }
  for (const resource of [
    ...additionalResources,
    ...rawSourceUrlsIn(content),
  ]) {
    if (isRawSourceUrl(resource)) rawResources.add(resource);
  }
  const sortedResources = [...rawResources].sort();
  if (definition.id === "session") {
    setIdentityDefault(
      "source_kind",
      sortedResources.some((resource) => resource.includes("/documents/"))
        ? "meeting"
        : sortedResources.length > 0
          ? "room"
          : undefined,
    );
  }
  const citedLabels = [
    ...new Set([...body.matchAll(/\[(R\d+)\]/gu)].map((match) => match[1]!)),
  ].sort(compareEvidenceLabels);
  const assignedLabels = new Set<string>();
  const representedResources = new Set<string>();
  const normalizedSources: Array<{ id: string; resource: string }> = [];
  const assign = (label: string, resource: string) => {
    if (assignedLabels.has(label)) return;
    assignedLabels.add(label);
    representedResources.add(resource);
    normalizedSources.push({ id: label, resource });
  };
  for (const label of citedLabels) {
    // Never guess which raw file supports a citation. Missing bindings must
    // fail validation and be repaired by the generator against the evidence.
    const resource = rawResourceByLabel.get(label);
    if (resource) assign(label, resource);
  }
  let nextLabel = 1;
  for (const resource of sortedResources) {
    if (representedResources.has(resource)) continue;
    while (
      assignedLabels.has(`R${nextLabel}`) ||
      citedLabels.includes(`R${nextLabel}`)
    )
      nextLabel += 1;
    assign(`R${nextLabel}`, resource);
    nextLabel += 1;
  }
  normalizedSources.sort((left, right) =>
    compareEvidenceLabels(left.id, right.id),
  );
  if (
    JSON.stringify(fields.sources ?? []) !== JSON.stringify(normalizedSources)
  ) {
    fields.sources = normalizedSources;
    changed = true;
  }
  if (!changed) return content;
  return `---\n${JSON.stringify(fields, null, 2)}\n---\n${(frontmatter[3] ?? "").replace(/^\r?\n/u, "")}`;
}

function compareEvidenceLabels(left: string, right: string): number {
  return Number(left.slice(1)) - Number(right.slice(1));
}

function removeBrokenInternalLinks(
  page: string,
  content: string,
  markdownPaths: ReadonlySet<string>,
): string {
  return content
    .replace(/(?<!!)(\[[^\]]*\])\(([^)]+)\)/gu, (match, label: string) =>
      inspectMarkdownLinks(page, match, markdownPaths).some(
        ({ code }) => code === "broken_internal_link",
      )
        ? label.slice(1, -1)
        : match,
    )
    .replace(/\n{3,}/gu, "\n\n");
}

function removeBrokenIndexLinks(
  page: string,
  content: string,
  markdownPaths: ReadonlySet<string>,
): string {
  return content
    .split(/(?<=\n)/u)
    .filter(
      (line) =>
        !inspectMarkdownLinks(page, line, markdownPaths).some(
          ({ code }) => code === "broken_internal_link",
        ),
    )
    .join("")
    .replace(/\n{3,}/gu, "\n\n");
}

function inspectOkfDocument(relativePath: string, content: string) {
  return validateOkfDocument(normalizeOkfMarkdown(content), {
    relativePath,
    requireRootVersion: true,
  });
}

function removeTransientSourceLinks(
  page: string,
  content: string,
  markdownPaths: ReadonlySet<string>,
  sourcePaths: ReadonlySet<string>,
  sourceTitles: ReadonlySet<string>,
): string {
  const withoutSourceLinks = content.replace(
    /(?<!!)(\[[^\]]*\])\(([^)]+)\)/gu,
    (match, label: string, rawTarget: string) => {
      const target = normalizeMarkdownTarget(rawTarget);
      const targetWithoutFragment = target.split("#", 1)[0]?.split("?", 1)[0];
      if (!targetWithoutFragment || hasUriScheme(targetWithoutFragment)) {
        return match;
      }
      const rootRelativeTarget = targetWithoutFragment.replace(/^\/+/, "");
      const resolved = posix.normalize(
        targetWithoutFragment.startsWith("/")
          ? targetWithoutFragment.slice(1)
          : posix.join(posix.dirname(page), targetWithoutFragment),
      );
      if (resolvesToMarkdownPage(resolved, markdownPaths)) {
        return match;
      }
      const isStagedSource =
        rootRelativeTarget === "inputs" ||
        rootRelativeTarget.startsWith("inputs/") ||
        rootRelativeTarget === "workspace/user" ||
        rootRelativeTarget.startsWith("workspace/user/") ||
        sourcePaths.has(rootRelativeTarget) ||
        sourcePaths.has(posix.basename(rootRelativeTarget)) ||
        isSourcePathVariant(rootRelativeTarget, sourcePaths) ||
        isSourcePathVariant(rootRelativeTarget, sourceTitles);
      return isStagedSource ? label.slice(1, -1) : match;
    },
  );
  return withoutSourceLinks
    .replace(/^\s*-\s*(?:inputs|workspace\/user)\s*$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n");
}

function isSourcePathVariant(
  target: string,
  sourcePaths: ReadonlySet<string>,
): boolean {
  if (!target.endsWith(".md")) return false;
  const targetKey = sourcePathKey(target);
  if (targetKey.length < 4) return false;
  return [...sourcePaths].some((sourcePath) => {
    const sourceKey = sourcePathKey(sourcePath);
    return sourceKey.startsWith(targetKey) || targetKey.startsWith(sourceKey);
  });
}

function sourcePathKey(value: string): string {
  const decoded = safelyDecodeUriComponent(value);
  return posix
    .basename(decoded, ".md")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function safelyDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function removeDuplicateRootVersion(content: string): string {
  const frontmatter = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/u.exec(
    content,
  );
  if (!frontmatter) return content;
  const body = frontmatter[2] ?? "";
  const normalizedBody = body.replace(
    /^(?:\r?\n)*okf_version:\s*["'][^\r\n"']+["']\s*(?:\r?\n)+/u,
    "\n",
  );
  return `${frontmatter[1] ?? ""}${normalizedBody}`;
}

export function assertValidWikiCandidate(
  inspection: WikiCandidateInspection,
): number {
  if (inspection.issues.length > 0) {
    throw new WikiCandidateValidationError(inspection.issues);
  }
  return inspection.pageCount;
}

export function formatWikiCandidateIssues(
  issues: WikiCandidateIssue[],
): string {
  return issues
    .map(
      ({ code, detail, page }) =>
        `${code}${page ? ` (${page})` : ""}: ${detail}`,
    )
    .join("; ");
}

async function listMarkdownFiles(
  directory: string,
  relativeDirectory = "",
): Promise<string[]> {
  const entries = await readdir(join(directory, relativeDirectory), {
    withFileTypes: true,
  });
  const paths: string[] = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? posix.join(relativeDirectory, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      paths.push(...(await listMarkdownFiles(directory, relativePath)));
    } else if (entry.isFile() && isPublishableWikiMarkdownPath(relativePath)) {
      paths.push(relativePath);
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

function inspectMarkdownLinks(
  page: string,
  content: string,
  markdownPaths: ReadonlySet<string>,
): WikiCandidateIssue[] {
  const issues: WikiCandidateIssue[] = [];
  const linkPattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/gu;
  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = normalizeMarkdownTarget(match[1] ?? "");
    if (!rawTarget || rawTarget.startsWith("#") || hasUriScheme(rawTarget)) {
      continue;
    }
    const targetWithoutFragment = rawTarget.split("#", 1)[0]?.split("?", 1)[0];
    if (!targetWithoutFragment) continue;
    const rootRelativeTarget = targetWithoutFragment.replace(/^\/+/, "");
    const resolved = posix.normalize(
      targetWithoutFragment.startsWith("/")
        ? targetWithoutFragment.slice(1)
        : posix.join(posix.dirname(page), targetWithoutFragment),
    );
    if (
      rootRelativeTarget === "inputs" ||
      rootRelativeTarget.startsWith("inputs/") ||
      rootRelativeTarget === "workspace/user" ||
      rootRelativeTarget.startsWith("workspace/user/") ||
      resolved === "inputs" ||
      resolved.startsWith("inputs/") ||
      resolved === "workspace/user" ||
      resolved.startsWith("workspace/user/") ||
      resolved.startsWith("../")
    ) {
      issues.push({
        code: "transient_source_link",
        detail: `Markdown link target ${rawTarget} is not part of the published Wiki`,
        page,
      });
      continue;
    }
    if (!resolvesToMarkdownPage(resolved, markdownPaths)) {
      issues.push({
        code: "broken_internal_link",
        detail: `Markdown link target ${rawTarget} does not resolve to a generated page`,
        page,
      });
    }
  }
  return issues;
}

function normalizeMarkdownTarget(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<")) {
    const closing = trimmed.indexOf(">");
    return closing === -1 ? trimmed : trimmed.slice(1, closing);
  }
  return trimmed.split(/\s+["']/u, 1)[0] ?? "";
}

function resolvesToMarkdownPage(
  target: string,
  markdownPaths: ReadonlySet<string>,
): boolean {
  const candidates = target.endsWith(".md")
    ? [target]
    : [target, `${target}.md`, posix.join(target, "index.md")];
  return candidates.some((candidate) => markdownPaths.has(candidate));
}

function hasUriScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value);
}
