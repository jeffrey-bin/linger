import {
  normalizeOkfMarkdown,
  validateOkfDocument,
  type OkfIssue,
} from "@linger/knowledge-format";

const NON_KNOWLEDGE_MARKDOWN = new Set(["INSTRUCTIONS.md", "README.md"]);
const SESSION_MEMORY_DOCUMENT_PATH =
  /^evidence\/\d{4}-\d{2}-\d{2}\/sessions\/(?:recordings\/)?[^/]+\.md$/u;

export class MemoryOkfValidationError extends Error {
  constructor(
    readonly relativePath: string,
    readonly issues: OkfIssue[],
  ) {
    super(
      `Invalid OKF memory document ${relativePath}: ${issues
        .map(({ code, message }) => `${code}: ${message}`)
        .join("; ")}`,
    );
    this.name = "MemoryOkfValidationError";
  }
}

export function assertValidMemoryMarkdown(
  relativePath: string,
  content: string,
): Record<string, unknown> | undefined {
  return validateMemoryMarkdown(relativePath, content).fields;
}

export function normalizeValidMemoryMarkdown(
  relativePath: string,
  content: string,
): string {
  return validateMemoryMarkdown(relativePath, content).content;
}

export function inspectMemoryMarkdown(
  relativePath: string,
  content: string,
): {
  content: string;
  fields?: Record<string, unknown>;
  issues: OkfIssue[];
} {
  return collectMemoryMarkdownValidation(relativePath, content);
}

function validateMemoryMarkdown(
  relativePath: string,
  content: string,
): { content: string; fields?: Record<string, unknown> } {
  const inspected = collectMemoryMarkdownValidation(relativePath, content);
  if (inspected.issues.length > 0) {
    throw new MemoryOkfValidationError(
      relativePath.replaceAll("\\", "/"),
      inspected.issues,
    );
  }
  return { content: inspected.content, fields: inspected.fields };
}

function collectMemoryMarkdownValidation(
  relativePath: string,
  content: string,
): {
  content: string;
  fields?: Record<string, unknown>;
  issues: OkfIssue[];
} {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  if (!normalizedPath.endsWith(".md")) {
    return { content, issues: [] };
  }
  const filename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  if (NON_KNOWLEDGE_MARKDOWN.has(filename)) {
    return { content, issues: [] };
  }

  const normalizedContent = normalizeOkfMarkdown(content);
  const validation = validateOkfDocument(normalizedContent, {
    relativePath: normalizedPath,
    requireRootVersion: normalizedPath === "index.md",
  });
  const fields = validation.fields ? { ...validation.fields } : undefined;
  const issues = [...validation.issues];
  if (fields) {
    for (const field of requiredFields(normalizedPath)) {
      if (!hasValue(fields[field])) {
        issues.push({
          code: "missing_memory_metadata",
          message: `Required Memory field \`${field}\` is missing or empty.`,
        });
      }
    }
  }
  return {
    content: normalizedContent,
    fields,
    issues,
  };
}

function requiredFields(relativePath: string): string[] {
  // These are Memory document authoring requirements, independent of any graph.
  const required = new Set<string>();
  const requirements: Array<[RegExp, string[]]> = [
    [/^timeline\/daily\/[^/]+\.md$/u, ["type", "date", "memory_subject_key"]],
  ];
  if (!relativePath.endsWith("/index.md")) {
    for (const [pattern, fields] of requirements)
      if (pattern.test(relativePath))
        fields.forEach((field) => required.add(field));
  }

  if (SESSION_MEMORY_DOCUMENT_PATH.test(relativePath)) {
    for (const field of ["type", "date", "room_id", "memory_subject_key"]) {
      required.add(field);
    }
  }
  return [...required];
}

function hasValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== undefined && value !== null;
}
