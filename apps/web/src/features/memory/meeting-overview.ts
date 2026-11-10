import {
  EMPTY_SECTION_TEXT,
  SESSION_ITEM_LABELS,
  SESSION_SECTIONS,
} from "@linger/knowledge-format/sections";
import {
  prepareReadOnlyMarkdown,
  stripKnowledgeCitations,
} from "@/components/read-only-markdown-presentation";

/** One Meeting Summary H3: its intro paragraph and every bullet under it. */
export interface MeetingTopic {
  title: string;
  /** The heading's representative time range, such as `00:00:33 - 00:03:51`. */
  time: string | null;
  intro: string | null;
  points: Array<{ text: string; children: string[] }>;
}

/** A Decision, Completed result or Action, with the rest of its line. */
export interface MeetingOutcome {
  label: "Decision" | "Completed" | "Action" | null;
  text: string;
  children: string[];
}

/**
 * A Session page as the reader shows it, in page order: Markdown runs for the
 * knowledge document, and the sections it presents itself. Sections that only
 * say None observed are left out, except the to-do list and Pattern, which
 * always show. The stored Markdown never changes.
 */
export type MeetingSummaryBlock =
  | { kind: "markdown"; markdown: string }
  | { kind: "keywords"; title: string; keywords: string[] }
  | { kind: "topics"; topics: MeetingTopic[] }
  | { kind: "outcomes"; title: string; outcomes: MeetingOutcome[] };

export function parseMeetingSummary(markdown: string): MeetingSummaryBlock[] {
  const blocks: MeetingSummaryBlock[] = [];
  const pushMarkdown = (text: string) => {
    const last = blocks.at(-1);
    if (last?.kind === "markdown") last.markdown += `\n${text}`;
    else blocks.push({ kind: "markdown", markdown: text });
  };
  for (const section of sections(markdown)) {
    if (section.title === null) {
      pushMarkdown(section.lines.join("\n"));
      continue;
    }
    // Citations and evidence markers go the way the document drops them.
    const body = prepareReadOnlyMarkdown(
      section.lines.slice(1).join("\n"),
      "knowledge",
    ).split("\n");
    const name = section.title;
    if (name === SESSION_SECTIONS.keywords) {
      const keywords = keywordList(body);
      if (keywords.length)
        blocks.push({ kind: "keywords", title: section.title, keywords });
      continue;
    }
    if (name === SESSION_SECTIONS.meetingSummary) {
      const topics = topicList(body);
      if (topics.length) {
        blocks.push({ kind: "topics", topics });
        continue;
      }
    }
    if (
      name === SESSION_SECTIONS.decisionsAndOutcomes ||
      name === SESSION_SECTIONS.actionItems
    ) {
      const outcomes = listItems(body)
        .concat(paragraphs(body).map((text) => ({ text, children: [] })))
        .map(outcome);
      // Action Items reads as the meeting's to-do list and, like Pattern,
      // always shows, saying None observed when empty.
      if (name === SESSION_SECTIONS.actionItems)
        blocks.push({ kind: "outcomes", title: "To-do list", outcomes });
      else if (outcomes.length)
        blocks.push({ kind: "outcomes", title: section.title, outcomes });
      continue;
    }
    const kept = section.lines.filter(
      (line) => !isEmpty(stripKnowledgeCitations(inline(listText(line)))),
    );
    if (kept.slice(1).some((line) => line.trim()))
      pushMarkdown(kept.join("\n"));
    else if (name === SESSION_SECTIONS.pattern)
      pushMarkdown(`${section.lines[0]}\n\n${EMPTY_SECTION_TEXT}`);
  }
  return blocks;
}

/** Splits at H2 headings outside code fences; the lead has no title. */
function sections(markdown: string) {
  const result: Array<{ title: string | null; lines: string[] }> = [
    { title: null, lines: [] },
  ];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence || marker) {
      if (!fence) fence = marker;
      else if (marker && marker[0] === fence[0] && line.trim() === marker)
        fence = undefined;
    } else {
      const heading = /^\s{0,3}##\s+(.+?)\s*#*\s*$/u.exec(line);
      if (heading) {
        result.push({ title: inline(heading[1]!), lines: [line] });
        continue;
      }
    }
    result.at(-1)!.lines.push(line);
  }
  return result.filter(
    (section) =>
      section.title !== null || section.lines.some((line) => line.trim()),
  );
}

/** Meeting Summary H3 topics; a topic without content gets no card. */
function topicList(body: string[]): MeetingTopic[] {
  const raw: Array<{ title: string; lines: string[] }> = [];
  for (const line of body) {
    const heading = /^\s{0,3}###\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) raw.push({ title: inline(heading[1]!), lines: [] });
    else raw.at(-1)?.lines.push(line);
  }
  return raw.flatMap((topic): MeetingTopic[] => {
    const lines = topic.lines.filter((line) => !/^\s{0,3}#{1,6}\s/u.test(line));
    const intro = paragraphs(lines).join(" ") || null;
    const points = listItems(lines);
    const time = timeRange.exec(topic.title);
    const title = topic.title.replace(timeRange, "").trim();
    return title && (intro || points.length > 0)
      ? [
          {
            title,
            time: time ? time[1]!.replace(/\s*[-–—~]\s*/u, " – ") : null,
            intro,
            points,
          },
        ]
      : [];
  });
}

/** Keywords written as a list, or separated by semicolons or commas. */
function keywordList(body: string[]): string[] {
  return body
    .flatMap((line) => listText(line).split(/[;；,，、]/u))
    .map((keyword) => inline(keyword).replace(/\*\*/gu, "").trim())
    .filter((keyword) => keyword && !isEmpty(keyword))
    .filter((keyword, index, all) => all.indexOf(keyword) === index);
}

const outcomeLabels = [
  SESSION_ITEM_LABELS.decision,
  SESSION_ITEM_LABELS.completed,
  SESSION_ITEM_LABELS.action,
] as const;

function outcome(item: { text: string; children: string[] }): MeetingOutcome {
  const label = outcomeLabels.find((candidate) =>
    item.text.startsWith(`${candidate}: `),
  );
  if (!label) return { label: null, ...item };
  return {
    label,
    text: item.text.slice(label.length + 2),
    children: item.children,
  };
}

/** A list item's text without its marker; other lines unchanged. */
function listText(line: string): string {
  return line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/u, "");
}

const timeRange =
  /\s*[[(（]\s*(\d{1,2}:\d{2}(?::\d{2})?\s*[-–—~]\s*\d{1,2}:\d{2}(?::\d{2})?)\s*[\])）]\s*$/u;

/**
 * Top-level list items; deeper items become children of the item above.
 * Evidence and None observed items are dropped with their children.
 */
function listItems(lines: string[]): MeetingTopic["points"] {
  const matches = lines.map((line) =>
    /^(\s*)(?:[-+*]|\d+[.)])\s+(.*)$/u.exec(line),
  );
  const indents = matches.flatMap((match) =>
    match ? [match[1]!.replace(/\t/gu, "    ").length] : [],
  );
  if (indents.length === 0) return [];
  const top = Math.min(...indents);
  const items: MeetingTopic["points"] = [];
  let parent: MeetingTopic["points"][number] | undefined;
  matches.forEach((match) => {
    if (!match) return;
    const text = inline(match[2]!);
    const kept = text && !isEvidence(text) && !isEmpty(text);
    if (match[1]!.replace(/\t/gu, "    ").length === top) {
      parent = kept ? { text, children: [] } : undefined;
      if (parent) items.push(parent);
    } else if (kept) parent?.children.push(text);
  });
  return items;
}

/** Plain paragraphs, skipping list items and headings. */
function paragraphs(lines: string[]): string[] {
  const result: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = inline(current.join(" "));
    if (text && !isEmpty(text)) result.push(text);
    current = [];
  };
  for (const line of lines) {
    if (
      !line.trim() ||
      /^\s*(?:[-+*]|\d+[.)])\s/u.test(line) ||
      /^\s{0,3}(?:#{1,6}\s|>|\|)/u.test(line)
    )
      flush();
    else current.push(line.trim());
  }
  flush();
  return result;
}

/** Markdown inline syntax reduced to readable text; `**bold**` is kept. */
function inline(text: string): string {
  return text
    .replace(/\[\[source:[^\]]*\]\]/gu, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The exact body the generator writes for a section with no content. */
function isEmpty(text: string): boolean {
  return text === EMPTY_SECTION_TEXT;
}

function isEvidence(text: string): boolean {
  return text.startsWith(`${SESSION_ITEM_LABELS.evidence}: `);
}
