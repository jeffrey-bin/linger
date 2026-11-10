import { isMap, isScalar, parse, parseDocument, visit } from "yaml";
import { isRecord } from "@linger/service-kit";

export const OKF_VERSION = "0.2";

const CONCEPT_STRING_FIELDS = [
  "type",
  "title",
  "description",
  "resource",
  "timestamp",
] as const;
const OKF_STATUS_VALUES = new Set(["draft", "stable", "deprecated"]);
const RESERVED_DOCUMENTS = new Set(["index.md", "log.md"]);
const ISO_DATETIME_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

export interface OkfIssue {
  code: string;
  message: string;
}

export interface OkfValidation {
  fields?: Record<string, unknown>;
  issues: OkfIssue[];
  valid: boolean;
}

export interface OkfDocumentOptions {
  relativePath: string;
  requireRootVersion?: boolean;
}

export function validateOkfDocument(
  content: string,
  options: OkfDocumentOptions,
): OkfValidation {
  const normalizedPath = options.relativePath.replaceAll("\\", "/");
  const filename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  if (RESERVED_DOCUMENTS.has(filename)) {
    return validateReservedDocument(content, normalizedPath, options);
  }
  return validateConceptDocument(content);
}

export function parseOkfFrontmatter(content: string): {
  fields?: Record<string, unknown>;
  issues: OkfIssue[];
} {
  const lines = content.split(/\r?\n/u);
  if (lines[0] !== "---") {
    return {
      issues: [
        issue("missing_opening_delimiter", "File must begin with `---`."),
      ],
    };
  }
  const closingLine = lines.indexOf("---", 1);
  if (closingLine === -1) {
    return {
      issues: [
        issue(
          "missing_closing_delimiter",
          "Opening front matter has no closing `---` delimiter.",
        ),
      ],
    };
  }
  const parsed = parseYamlFrontmatter(lines.slice(1, closingLine).join("\n"));
  if (parsed.fields) {
    return { fields: parsed.fields, issues: [] };
  }
  if (parsed.rootIssue) {
    return { issues: [parsed.rootIssue] };
  }
  return {
    issues: [
      issue(
        "invalid_yaml",
        parsed.error instanceof Error
          ? parsed.error.message
          : String(parsed.error),
      ),
    ],
  };
}

export function normalizeOkfMarkdown(content: string): string {
  const match = FRONTMATTER_BLOCK.exec(content);
  if (!match?.[1]) {
    return content;
  }
  const repaired = repairOkfFrontmatter(match[1]);
  if (repaired === match[1] || !parseYamlFrontmatter(repaired).fields) {
    return content;
  }
  const body = content.slice(match[0].length);
  return `---\n${repaired}\n---\n${body}`;
}

export function setOkfRootIndexVersion(content: string): string {
  const match = FRONTMATTER_BLOCK.exec(content);
  if (!match) {
    return `---\nokf_version: "${OKF_VERSION}"\n---\n\n${content.replace(/^\s+/u, "")}`;
  }
  const block = match[1] ?? "";
  const lines = block.split(/\r?\n/u);
  const versionLine = `okf_version: "${OKF_VERSION}"`;
  const index = lines.findIndex((line) => /^okf_version\s*:/u.test(line));
  if (index === -1) lines.push(versionLine);
  else lines[index] = versionLine;
  return `---\n${lines.join("\n")}\n---\n${content.slice(match[0].length)}`;
}

function parseYamlFrontmatter(
  raw: string,
):
  | { fields: Record<string, unknown>; rootIssue?: never; error?: never }
  | { fields?: never; rootIssue: OkfIssue; error?: never }
  | { fields?: never; rootIssue?: never; error: unknown } {
  const repaired = repairOkfFrontmatter(raw);
  const candidates = repaired === raw ? [raw] : [repaired, raw];
  let firstError: unknown;
  for (const candidate of candidates) {
    try {
      const fields = parse(`\n${candidate}`, {
        maxAliasCount: 100,
        schema: "core",
        uniqueKeys: true,
      }) as unknown;
      if (!isRecord(fields)) {
        return {
          rootIssue: issue(
            "invalid_yaml_root",
            "Front matter must be a YAML mapping.",
          ),
        };
      }
      return { fields };
    } catch (error) {
      firstError ??= error;
    }
  }
  return { error: firstError };
}

function repairOkfFrontmatter(raw: string): string {
  const options = { schema: "core", uniqueKeys: false } as const;
  let repaired = raw;
  let document = parseDocument(repaired, options);
  // Valid YAML (especially block/multiline strings) must not be rewritten line by line.
  if (document.errors.some((error) => error.code !== "BAD_INDENT")) {
    repaired = raw.split(/\r?\n/u).map(repairYamlLine).join("\n");
    document = parseDocument(repaired, options);
  }
  const aligned = repairRootMappingIndentation(repaired, document);
  if (aligned !== repaired) {
    repaired = aligned;
    document = parseDocument(repaired, options);
  }
  if (document.errors.length > 0) return repaired;
  let changed = false;
  visit(document, {
    Map(_key, map) {
      const scalars = new Map<unknown, unknown>();
      map.items = map.items.filter((pair) => {
        if (!isScalar(pair.key) || !isScalar(pair.value)) return true;
        const key = pair.key.value;
        const value = pair.value.value;
        if (scalars.has(key) && Object.is(scalars.get(key), value)) {
          changed = true;
          return false;
        }
        scalars.set(key, value);
        return true;
      });
    },
  });
  return changed ? document.toString().trimEnd() : repaired;
}

function repairRootMappingIndentation(
  raw: string,
  document: ReturnType<typeof parseDocument>,
): string {
  if (
    !isMap(document.contents) ||
    document.errors.length === 0 ||
    document.errors.some((error) => error.code !== "BAD_INDENT")
  )
    return raw;
  const rootKeys = document.contents.items.flatMap(({ key }) =>
    isScalar(key) && key.range ? [key.range[0]] : [],
  );
  // Only an established column-zero root can be aligned without guessing nesting.
  const first = rootKeys[0];
  if (first === undefined || raw.lastIndexOf("\n", first - 1) + 1 !== first)
    return raw;
  const edits = new Map<number, number>();
  for (const error of document.errors) {
    const start = raw.lastIndexOf("\n", error.pos[0] - 1) + 1;
    const end = rootKeys.find(
      (offset) => offset > start && /^[ ]+$/u.test(raw.slice(start, offset)),
    );
    if (end === undefined || error.pos[0] > end) return raw;
    edits.set(start, end);
  }
  // Remove only whitespace at root keys explicitly identified by the parser.
  for (const [start, end] of [...edits].sort(([a], [b]) => b - a)) {
    raw = raw.slice(0, start) + raw.slice(end);
  }
  return raw;
}

function repairYamlLine(line: string): string {
  const match = line.match(
    /^(\s*(?:-\s+)?)([A-Za-z_][\w-]*):(?:\s+(.+?))?\s*$/u,
  );
  if (!match || match[3] === undefined) {
    return line;
  }
  const prefix = match[1] ?? "";
  const key = match[2] ?? "";
  const value = match[3].trim();
  const repaired = repairPlainScalar(value);
  return repaired === value ? line : `${prefix}${key}: ${repaired}`;
}

function repairPlainScalar(value: string): string {
  if (value === "" || /^[{[|>&*!%@`]/u.test(value)) {
    return value;
  }
  if (/^["']/u.test(value)) {
    try {
      // A closing quote may be followed by a valid YAML comment.
      parse(value, { maxAliasCount: 100, schema: "core", uniqueKeys: true });
      return value;
    } catch {
      // Only malformed quoted scalars need the repairs below.
    }
  }
  if (value.startsWith('"')) {
    if (value.endsWith('""') && !isEscaped(value, value.length - 2)) {
      return JSON.stringify(value.slice(1, -2));
    }
    if (!value.endsWith('"') || isEscaped(value, value.length - 1)) {
      return JSON.stringify(value.slice(1));
    }
    return value;
  }
  if (value.startsWith("'")) {
    if (value.endsWith("''")) {
      return JSON.stringify(value.slice(1, -2).replaceAll("''", "'"));
    }
    if (!value.endsWith("'")) {
      return JSON.stringify(value.slice(1));
    }
    return value;
  }
  if (value.endsWith('"') || value.endsWith("'")) {
    return JSON.stringify(value.slice(0, -1).trimEnd());
  }
  if (value.includes(":")) {
    return JSON.stringify(value);
  }
  return value;
}

function isEscaped(value: string, index: number): boolean {
  let count = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && value[cursor] === "\\";
    cursor--
  ) {
    count++;
  }
  return count % 2 === 1;
}

function validateConceptDocument(content: string): OkfValidation {
  const parsed = parseOkfFrontmatter(content);
  if (!parsed.fields) {
    return { issues: parsed.issues, valid: false };
  }
  const fields = parsed.fields;
  const issues: OkfIssue[] = [];
  if (!Object.hasOwn(fields, "type")) {
    issues.push(issue("missing_type", "Required field `type` is missing."));
  }
  for (const field of CONCEPT_STRING_FIELDS) {
    if (Object.hasOwn(fields, field) && !isNonEmptyString(fields[field])) {
      issues.push(
        issue(
          `invalid_${field}`,
          `Field \`${field}\` must be a non-empty string.`,
        ),
      );
    }
  }
  if (
    Object.hasOwn(fields, "tags") &&
    (!Array.isArray(fields.tags) ||
      fields.tags.some((tag) => !isNonEmptyString(tag)))
  ) {
    issues.push(
      issue(
        "invalid_tags",
        "Field `tags` must be a list of non-empty strings.",
      ),
    );
  }
  validateTrustAndLifecycle(fields, issues);
  return { fields, issues, valid: issues.length === 0 };
}

function validateReservedDocument(
  content: string,
  relativePath: string,
  options: OkfDocumentOptions,
): OkfValidation {
  const isRootIndex = relativePath === "index.md";
  const hasFrontmatter =
    content.startsWith("---\n") || content.startsWith("---\r\n");
  if (!isRootIndex && hasFrontmatter) {
    return {
      issues: [
        issue(
          "reserved_frontmatter",
          "Only the bundle-root index.md may contain front matter.",
        ),
      ],
      valid: false,
    };
  }
  if (!isRootIndex || !options.requireRootVersion) {
    return { issues: [], valid: true };
  }
  const parsed = parseOkfFrontmatter(content);
  if (!parsed.fields) {
    return { issues: parsed.issues, valid: false };
  }
  const issues =
    parsed.fields.okf_version === OKF_VERSION
      ? []
      : [
          issue(
            "invalid_okf_version",
            `Root index.md must declare okf_version: "${OKF_VERSION}".`,
          ),
        ];
  return { fields: parsed.fields, issues, valid: issues.length === 0 };
}

function validateTrustAndLifecycle(
  fields: Record<string, unknown>,
  issues: OkfIssue[],
): void {
  if (Object.hasOwn(fields, "generated") && !isActorEvent(fields.generated)) {
    issues.push(
      issue(
        "invalid_generated",
        "Field `generated` must be a {by, at?} mapping with an absolute ISO 8601 datetime when `at` is present.",
      ),
    );
  }
  if (Object.hasOwn(fields, "verified")) {
    const events = Array.isArray(fields.verified)
      ? fields.verified
      : [fields.verified];
    if (!events.every(isActorEvent)) {
      issues.push(
        issue(
          "invalid_verified",
          "Field `verified` must be a {by, at?} mapping or a list of those mappings.",
        ),
      );
    }
  }
  if (
    Object.hasOwn(fields, "sources") &&
    (!Array.isArray(fields.sources) ||
      fields.sources.some(
        (entry) => !isRecord(entry) || !isNonEmptyString(entry.resource),
      ))
  ) {
    issues.push(
      issue(
        "invalid_sources",
        "Field `sources` must be a list of mappings with a non-empty `resource`.",
      ),
    );
  }
  if (
    Object.hasOwn(fields, "status") &&
    (!isNonEmptyString(fields.status) || !OKF_STATUS_VALUES.has(fields.status))
  ) {
    issues.push(
      issue(
        "invalid_status",
        "Field `status` must be `draft`, `stable`, or `deprecated`.",
      ),
    );
  }
  if (
    Object.hasOwn(fields, "stale_after") &&
    (!isNonEmptyString(fields.stale_after) ||
      !isIsoDateTimeWithOffset(fields.stale_after))
  ) {
    issues.push(
      issue(
        "invalid_stale_after",
        "Field `stale_after` must be an ISO 8601 datetime with an explicit UTC offset.",
      ),
    );
  }
}

function isActorEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.by) &&
    (!Object.hasOwn(value, "at") ||
      (isNonEmptyString(value.at) && isIsoDateTimeWithOffset(value.at)))
  );
}

function isIsoDateTimeWithOffset(value: string): boolean {
  const match = ISO_DATETIME_WITH_OFFSET.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function issue(code: string, message: string): OkfIssue {
  return { code, message };
}
