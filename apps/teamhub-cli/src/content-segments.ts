import { unified } from "unified";
import remarkParse from "remark-parse";

interface Node {
  type: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

interface Range {
  start: number;
  end: number;
}

function markdownRanges(content: string, types: readonly string[]): Range[] {
  const tree = unified().use(remarkParse).parse(content) as Node;
  const ranges: Range[] = [];
  const visit = (node: Node) => {
    if (types.includes(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
      return;
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return ranges;
}

/**
 * Decode the escapes a shell leaves in an inline body: \n, \t and \\.
 * Code spans and code blocks, located in the raw text, stay literal.
 */
export function decodeInlineEscapes(content: string): string {
  const code = markdownRanges(content, ["code", "inlineCode"]);
  return content.replace(
    /\\([\\nt])/g,
    (escape, char: string, offset: number) =>
      code.some((range) => offset >= range.start && offset < range.end)
        ? escape
        : char === "n"
          ? "\n"
          : char === "t"
            ? "\t"
            : "\\",
  );
}

/** Preserve source Markdown and convert only explicit, non-code Actor links. */
export function parseActorReferences(
  content: string,
  style: "message" | "comment" = "message",
): Record<string, unknown>[] {
  const excluded = markdownRanges(content, [
    "code",
    "inlineCode",
    "html",
    "image",
    "imageReference",
    "linkReference",
  ]);
  const segments: Record<string, unknown>[] = [];
  // Whitespace around or between mentions is not a sendable text segment.
  const pushText = (text: string) => {
    if (text.trim()) segments.push({ type: "text", content: text });
  };
  const explicit = /\[@([^\]\r\n]+)\]\((user|agent):([^)\r\n]*)\)/g;
  let cursor = 0;
  for (const match of content.matchAll(explicit)) {
    const start = match.index;
    let escapes = 0;
    for (let index = start - 1; index >= 0 && content[index] === "\\"; index--)
      escapes++;
    if (
      escapes % 2 ||
      excluded.some((range) => start >= range.start && start < range.end)
    )
      continue;
    const [, label, kind, actorID] = match;
    if (!actorID || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(actorID)) {
      throw new Error("Actor reference must contain a valid Actor ID.");
    }
    if (start > cursor) pushText(content.slice(cursor, start));
    segments.push(
      style === "comment"
        ? { type: "reference", actor_id: actorID, content: label }
        : {
            type: "reference",
            target: actorID,
            target_type: kind,
            content: label,
          },
    );
    cursor = start + match[0].length;
  }
  pushText(content.slice(cursor));
  if (segments.length === 0) segments.push({ type: "text", content });
  return segments;
}
