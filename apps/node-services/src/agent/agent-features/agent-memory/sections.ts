/**
 * Consolidation edits Memory one `## ` section at a time, so its output grows
 * with the change rather than with the whole Memory. Text before the first
 * section is kept as it is.
 */

/** A model output, or an edit in it, that cannot be published. */
export class InvalidMemoryOutputError extends Error {}

export const MEMORY_EDIT_OPS = ["replace", "add", "delete"] as const;

interface Section {
  readonly heading: string;
  readonly lines: readonly string[];
}

const HEADING = /^## +(.*\S)\s*$/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

// A `## ` line inside a fenced code block is content, not a section.
function parse(markdown: string): {
  preamble: string[];
  sections: Section[];
} {
  const preamble: string[] = [];
  const sections: { heading: string; lines: string[] }[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (marker && (!fence || marker.startsWith(fence)))
      fence = fence ? undefined : marker;
    const heading = fence || marker ? undefined : HEADING.exec(line)?.[1];
    if (heading !== undefined) sections.push({ heading, lines: [line] });
    else (sections.at(-1)?.lines ?? preamble).push(line);
  }
  return { preamble, sections };
}

/** Section headings in document order, as the model must name them. */
export function memorySectionHeadings(memory: string): string[] {
  return parse(memory).sections.map((section) => section.heading);
}

function sectionLines(heading: string, content: string): string[] {
  return [`## ${heading}`, "", ...content.trim().split("\n"), ""];
}

/**
 * Applies the model's edits in order. `replace` keeps a section's place and
 * also merges later sections that repeat its heading; `delete` removes every
 * section with the heading; `add` appends a section with an unused heading.
 */
export function applyMemoryEdits(memory: string, edits: unknown): string {
  if (!Array.isArray(edits))
    throw new InvalidMemoryOutputError("edits is not a list");
  const { preamble, sections } = parse(memory);
  // An empty memory splits into one empty line, which must not lead the result.
  const head = memory ? preamble : [];
  let current: Section[] = sections;
  const touched = new Set<string>();
  for (const edit of edits as unknown[]) {
    const {
      op,
      heading: raw,
      content,
    } = (edit ?? {}) as Record<string, unknown>;
    if (
      !(MEMORY_EDIT_OPS as readonly unknown[]).includes(op) ||
      typeof raw !== "string" ||
      typeof content !== "string"
    )
      throw new InvalidMemoryOutputError("Invalid memory edit");
    const heading = raw
      .trim()
      .replace(/^#+\s*/u, "")
      .trim();
    if (!heading || heading.includes("\n"))
      throw new InvalidMemoryOutputError(
        `Invalid memory section heading: ${raw}`,
      );
    if (touched.has(heading))
      throw new InvalidMemoryOutputError(
        `Memory section edited twice: ${heading}`,
      );
    touched.add(heading);
    const exists = current.some((section) => section.heading === heading);
    if (op !== "delete" && parse(content).sections.length)
      throw new InvalidMemoryOutputError(
        `Memory section content starts another section: ${heading}`,
      );
    if (op === "add") {
      if (exists)
        throw new InvalidMemoryOutputError(
          `Memory section already exists: ${heading}`,
        );
      // A blank line separates the new section from text that has none.
      const last = (current.at(-1)?.lines ?? head).at(-1);
      const lines = sectionLines(heading, content);
      current = [...current, { heading, lines: last ? ["", ...lines] : lines }];
      continue;
    }
    if (!exists)
      throw new InvalidMemoryOutputError(
        `Memory section not found: ${heading}`,
      );
    let replaced = false;
    current = current.flatMap((section) => {
      if (section.heading !== heading) return [section];
      if (op === "delete" || replaced) return [];
      replaced = true;
      return [{ heading, lines: sectionLines(heading, content) }];
    });
  }
  // Untouched text, including a missing final newline, stays byte for byte.
  return [...head, ...current.flatMap((section) => section.lines)].join("\n");
}
