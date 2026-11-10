import {
  ENTITY_SECTIONS,
  REPORT_SOURCES_SECTION,
  SESSION_ITEM_LABELS,
  SESSION_SECTIONS,
} from "@linger/knowledge-format/sections";

export type ReadOnlyMarkdownPresentation = "default" | "knowledge";

/** Shared by Markdown previews and the collaborative Wiki reading projection. */
export function isKnowledgeSourceHeading(title: string): boolean {
  return title.trim() === REPORT_SOURCES_SECTION;
}

const evidenceMarker = new RegExp(
  String.raw`^\s*(?:[-*+]\s+)?${SESSION_ITEM_LABELS.evidence}: \[R\d+\](?:[\s,;]*\[R\d+\])*\s*$`,
  "u",
);

/** A rendered Evidence item that holds only citation labels. */
export function isKnowledgeEvidenceMarker(text: string): boolean {
  return evidenceMarker.test(text);
}

export function isKnowledgeChangeLogHeading(title: string): boolean {
  return title.trim() === ENTITY_SECTIONS.changeLog;
}

/** Interaction History lists newest first and shows this many by default. */
export const KNOWLEDGE_HISTORY_VISIBLE_ENTRIES = 5;

export function isKnowledgeHistoryHeading(title: string): boolean {
  return title.trim() === ENTITY_SECTIONS.interactionHistory;
}

const citationLabelPart = String.raw`\s*R\d+(?:\s*(?:[-–—~,;，；、]|and|&)\s*R?\d+)*\s*`;
/**
 * Memory evidence that points at internal files rather than reader pages:
 * `[Daily 2026-10-13](memory://…)`, `[2026-08-25 Meeting](agent_<id>/…/x.md)`
 * and bare `[memory://timeline/daily/2026-09-09.md; memory://…]`.
 */
const memoryReference = String.raw`\[[^\]\n]*\]\((?:memory:\/\/|\.\.\/(?:daily|weekly)\/|agent_[0-9a-f]{32}\/)[^)\s]*\)|\[(?:memory|teamhub):\/\/[^\]\n]*\]`;
const memoryReferencePattern = new RegExp(memoryReference, "u");
/** A Room Session link, which readers never see, even leading a line. */
const roomReference = String.raw`\[[^\]\n]*\]\((?:[^)\s]*sessions\/(?:\d{4}-\d{2}-\d{2}\/)?room_[^)\s]*|teamhub:\/\/rooms\/[A-Za-z0-9_-]+\/messages(?:\/[A-Za-z0-9_-]+)?)\)`;
const roomReferencePattern = new RegExp(roomReference, "u");
const citationLabel = String.raw`(?:\\?\[${citationLabelPart}\\?\](?![(:])|[(（]${citationLabelPart}[)）]|${roomReference}|${memoryReference})`;
const citationPattern = new RegExp(
  String.raw`([ \t\u3000]*)(${SESSION_ITEM_LABELS.evidence}: )?(${citationLabel}(?:\s*[,，、;；]?\s*${citationLabel})*)`,
  "gu",
);

/**
 * Text ranges of inline OpenWiki citation labels (`[R1]`, `[R1, R2]`,
 * `(R2)`, trailing `Evidence: [R1].`) and memory file references that
 * readers should not see. Removing
 * the ranges also removes the whitespace and punctuation that only belonged
 * to the citation.
 */
export function knowledgeCitationRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(citationPattern)) {
    const [whole, lead = "", prefix = ""] = match;
    // A memory link standing alone is navigation; only one after prose cites.
    if (
      !text.slice(0, match.index).trim() &&
      memoryReferencePattern.test(whole) &&
      !roomReferencePattern.test(whole)
    )
      continue;
    let start = match.index;
    let end = start + whole.length;
    const rest = text.slice(end);
    if (prefix && /^\s*[\p{L}\p{N}]/u.test(rest)) {
      // "Evidence: [R1] confirms ..." keeps its prose; only the label goes.
      start += lead.length + prefix.length;
      end += /^[ \t\u3000]*/u.exec(rest)![0].length;
    } else if (prefix) {
      end += /^[.。;；]?/u.exec(rest)![0].length;
    }
    if (
      /[(（]/u.test(text[start - 1] ?? "") &&
      /[)）]/u.test(text[end] ?? "")
    ) {
      // "（[Meeting](…)）" leaves no empty brackets behind.
      end += 1;
      start -= 1;
      start -= /[ \t\u3000]*$/u.exec(text.slice(0, start))![0].length;
    }
    if (start === 0 && end < text.length) {
      // Do not leave the following text with leading whitespace.
      end += /^[ \t\u3000]*/u.exec(text.slice(end))![0].length;
    }
    ranges.push([start, end]);
  }
  return ranges;
}

/**
 * Ranges of Room Session links in a text block, given the link spans, widened
 * to the brackets, separators and whitespace that only belonged to them.
 */
export function roomSessionReferenceRanges(
  text: string,
  links: Array<[number, number]>,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const link of links) {
    let [start, end] = link;
    const last = ranges.at(-1);
    if (last && /^[\s,，、;；]*$/u.test(text.slice(last[1], start))) {
      ranges.pop();
      start = last[0];
    }
    if (
      /[(（]/u.test(text[start - 1] ?? "") &&
      /[)）]/u.test(text[end] ?? "")
    ) {
      start -= 1;
      end += 1;
    }
    const before = /[\s]*[,，、;；]?[\s]*$/u.exec(text.slice(0, start))![0];
    if (before.length < start) start -= before.length;
    else {
      start = 0;
      end += /^[\s,，、;；]*/u.exec(text.slice(end))![0].length;
    }
    ranges.push([start, end]);
  }
  return ranges;
}

export function stripKnowledgeCitations(text: string): string {
  let result = "";
  let cursor = 0;
  for (const [start, end] of knowledgeCitationRanges(text)) {
    result += text.slice(cursor, start);
    cursor = end;
  }
  return result + text.slice(cursor);
}

/**
 * Removes machine-only Markdown metadata for human-facing knowledge previews.
 *
 * This is a presentation transform only. The stored/downloaded Markdown is
 * never changed, and the default renderer keeps the original content intact.
 */
export function prepareReadOnlyMarkdown(
  markdown: string,
  presentation: ReadOnlyMarkdownPresentation = "default",
  documentTitle?: string,
  hiddenSectionTitles: readonly string[] = [],
): string {
  if (presentation !== "knowledge") return markdown;

  let lines = markdown.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  lines = stripFrontmatter(lines);
  lines = stripKnowledgeSections(lines, hiddenSectionTitles);
  lines = stripMainTopicTimes(lines);
  lines = stripDuplicateTitle(lines, documentTitle);
  lines = normalizeDirectoryLinks(lines);
  lines = stripRoomSessionReferences(lines);
  lines = stripCitationLabels(lines);

  return lines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** A Wiki page for one Room conversation, hidden from readers like the graph
 * hides it; meeting and recording Sessions (`capture_session_…`) stay. */
const roomSessionTarget =
  /(?:(?:^|\/)sessions\/(?:\d{4}-\d{2}-\d{2}\/)?room_[A-Za-z0-9_-]+(?:\.md)?(?:#[^)\s]*)?|^teamhub:\/\/rooms\/[A-Za-z0-9_-]+\/messages(?:\/[A-Za-z0-9_-]+)?)$/u;
export function isRoomSessionLink(href: string): boolean {
  return roomSessionTarget.test(href.trim());
}
const leadingListLink = /^(\s*)(?:[-+*]|\d+[.)])\s+\[[^\]\n]+\]\(([^)\s]+)\)/u;

/**
 * The generator lists Room Sessions and appends a related entry on every
 * update. Readers see neither: list items that open a Room Session go (a
 * Room Session link in prose goes with the citations), a list keeps the first
 * item for each linked page, and a heading left with nothing under it goes.
 */
function stripRoomSessionReferences(lines: string[]): string[] {
  const kept: string[] = [];
  const emptied = new Set<number>();
  let heading = -1;
  let fence: string | undefined;
  let listTargets = new Set<string>();
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence || marker) {
      if (!fence) fence = marker;
      else if (marker && marker[0] === fence[0] && line.trim() === marker)
        fence = undefined;
      kept.push(line);
      continue;
    }
    if (/^\s{0,3}#{1,6}\s/u.test(line)) heading = kept.length;
    const item = leadingListLink.exec(line);
    if (!item) {
      // A blank line or prose ends the list whose repeats are tracked.
      if (!/^\s*(?:[-+*]|\d+[.)])\s/u.test(line)) listTargets = new Set();
      kept.push(line);
      continue;
    }
    const target = item[2]!.replace(/#.*$/u, "");
    // Nested items belong to the item above; only top-level repeats go.
    if (
      roomSessionTarget.test(target) ||
      (!item[1] && listTargets.has(target))
    ) {
      emptied.add(heading);
      continue;
    }
    if (!item[1]) listTargets.add(target);
    kept.push(line);
  }
  return stripEmptiedHeadings(kept, emptied);
}

/** Drops a heading whose items were all removed above; authored empty
 * sections stay as written. */
function stripEmptiedHeadings(lines: string[], emptied: Set<number>): string[] {
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = emptied.has(index)
      ? /^\s{0,3}(#{1,6})\s/u.exec(lines[index]!)
      : null;
    if (heading) {
      let next = index + 1;
      while (next < lines.length && lines[next]!.trim() === "") next += 1;
      const following = /^\s{0,3}(#{1,6})\s/u.exec(lines[next] ?? "");
      // Nothing before the next sibling or parent heading, or the end.
      if (
        next >= lines.length ||
        (following && following[1]!.length <= heading[1]!.length)
      )
        continue;
    }
    result.push(lines[index]!);
  }
  return result;
}

function stripDuplicateTitle(lines: string[], title?: string): string[] {
  const normalizedTitle = title?.trim().toLowerCase();
  if (!normalizedTitle) return lines;

  const index = lines.findIndex((line) => line.trim() !== "");
  const heading = /^\s{0,3}#\s+(.+?)\s*#*\s*$/u.exec(lines[index] ?? "");

  if (heading?.[1]?.trim().toLowerCase() !== normalizedTitle) return lines;
  return [...lines.slice(0, index), ...lines.slice(index + 1)];
}

function normalizeDirectoryLinks(lines: string[]): string[] {
  let fence: string | undefined;
  return lines.map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      ) {
        fence = undefined;
      }
      return line;
    }
    if (marker) {
      fence = marker;
      return line;
    }
    // Generated directories sometimes quote an entire anchor link as code.
    // Only unwrap that list-prefix shape; leave actual code/examples intact.
    return line.replace(
      /^(\s{0,3}(?:[-+*]|\d+[.)])\s+)`(\[[^\]`\n]+\]\(#[^\s()`]+\))`(?=\s*:)/u,
      "$1$2",
    );
  });
}

function stripCitationLabels(lines: string[]): string[] {
  let fence: string | undefined;
  return lines.map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence || marker) {
      if (!fence) fence = marker;
      else if (marker && marker[0] === fence[0] && line.trim() === marker)
        fence = undefined;
      return line;
    }
    // Inline code keeps its literal text; only prose segments lose labels.
    const indent = /^\s*(?:(?:[-+*]|\d+[.)])\s+)?/u.exec(line)![0];
    return (
      indent +
      line
        .slice(indent.length)
        .split(/(`[^`]*`)/u)
        .map((part, index) =>
          index % 2 === 1 ? part : stripKnowledgeCitations(part),
        )
        .join("")
    );
  });
}

function stripFrontmatter(lines: string[]): string[] {
  const firstContentLine = lines.findIndex((line) => line.trim() !== "");
  if (firstContentLine < 0 || lines[firstContentLine]?.trim() !== "---") {
    return lines;
  }

  for (let index = firstContentLine + 1; index < lines.length; index += 1) {
    if (/^(?:---|\.\.\.)\s*$/u.test(lines[index]?.trim() ?? "")) {
      return [...lines.slice(0, firstContentLine), ...lines.slice(index + 1)];
    }
  }

  return lines;
}

function stripKnowledgeSections(
  lines: string[],
  hiddenSectionTitles: readonly string[],
): string[] {
  const result: string[] = [];
  const hiddenTitles = new Set(hiddenSectionTitles.map(normalizeHeadingTitle));
  let hiddenHeadingLevel: number | null = null;
  let fence: string | undefined;

  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence || marker) {
      if (!fence) {
        fence = marker;
      } else if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      ) {
        fence = undefined;
      }
      if (hiddenHeadingLevel === null) result.push(line);
      continue;
    }

    const heading = /^(\s{0,3})(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      const level = (heading[2] ?? "").length;
      const title = heading[3] ?? "";

      if (hiddenHeadingLevel !== null && level <= hiddenHeadingLevel) {
        hiddenHeadingLevel = null;
      }

      if (
        hiddenHeadingLevel === null &&
        (isKnowledgeSourceHeading(title) ||
          hiddenTitles.has(normalizeHeadingTitle(title)))
      ) {
        hiddenHeadingLevel = level;
        continue;
      }
    }

    if (
      hiddenHeadingLevel === null &&
      !/^\s{0,3}(?:#{1,6}\s+)?generated\s*:/iu.test(line) &&
      !isKnowledgeEvidenceMarker(line)
    )
      result.push(line);
  }

  return result;
}

const mainTopicTime =
  /\s*[[(（【]\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*[-–—~～]\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*[\])）】]\s*$/u;

/**
 * Meeting notes give each Main Topic heading a representative time range;
 * readers see the topic only. Text and other sections keep their times.
 */
function stripMainTopicTimes(lines: string[]): string[] {
  let mainTopicsLevel: number | null = null;
  let fence: string | undefined;
  return lines.map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence || marker) {
      if (!fence) fence = marker;
      else if (marker && marker[0] === fence[0] && line.trim() === marker)
        fence = undefined;
      return line;
    }
    const heading = /^(\s{0,3}#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!heading) return line;
    const level = (heading[1] ?? "").trim().length;
    const title = heading[2] ?? "";
    if (mainTopicsLevel !== null && level <= mainTopicsLevel)
      mainTopicsLevel = null;
    if (mainTopicsLevel === null) {
      if (title.trim() === SESSION_SECTIONS.mainTopics) mainTopicsLevel = level;
      return line;
    }
    const topic = title.replace(mainTopicTime, "").trim();
    return topic ? `${heading[1]} ${topic}` : line;
  });
}

function normalizeHeadingTitle(title: string): string {
  return title
    .replace(/[*_`]/gu, "")
    .trim()
    .replace(/[:：]\s*$/u, "")
    .trim()
    .toLowerCase();
}
