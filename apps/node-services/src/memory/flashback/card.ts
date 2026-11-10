import {
  DAILY_REPORT_SECTIONS,
  SESSION_ACTION_PRIORITIES,
  SESSION_ITEM_LABELS,
  SESSION_SECTIONS,
  SUGGESTED_FOCUS_LABEL,
} from "@linger/knowledge-format/sections";
import type { FlashbackSuggestion } from "../../flashback.js";

/**
 * What an earlier meeting or day says happened. No model call reads it; a
 * part the page does not hold stays empty.
 */
export type ExperienceCard = Pick<
  FlashbackSuggestion,
  "situation" | "decisions" | "completed" | "openItems"
>;

/** What one activity item of a Daily report records. */
export type DailyItemKind = "work" | "resolved" | "unresolved" | "focus";

/**
 * One activity item of a Daily report: its text without the source links,
 * the Rooms those links cite, and the Projects, Clients and Contacts it names.
 */
export interface DailyItem {
  kind: DailyItemKind;
  text: string;
  rooms: string[];
  entities: string[];
}

/** One day's Daily report as flashback reads it. */
export interface DailyReport {
  date: string;
  title: string;
  items: DailyItem[];
}

const MAX_TEXT = 360;
const MAX_ITEM = 200;
/** The nested field line, as `topBullets` keeps it after trimming. */
const highPriority = `- ${SESSION_ITEM_LABELS.priority}: ${SESSION_ACTION_PRIORITIES[0]}`;
const dailyItemSections = new Map<string, DailyItemKind>([
  [DAILY_REPORT_SECTIONS.dailyWork, "work"],
  [DAILY_REPORT_SECTIONS.resolvedItems, "resolved"],
  [DAILY_REPORT_SECTIONS.unresolvedItems, "unresolved"],
  [DAILY_REPORT_SECTIONS.tomorrowFocus, "focus"],
]);
const suggestedFocus = `${SUGGESTED_FOCUS_LABEL}: `;
/** A rendered source link and the space before it; its label escapes brackets. */
const sourceLink = /\s*\[(?:\\.|[^\]\\])*\]\([^)]*\)/gu;
const roomCitation = /\]\(teamhub:\/\/rooms\/([^/)\s]+)/gu;

/**
 * Reads a meeting's Session page from the fixed sections every Session page
 * carries: the Objective Summary for the situation, Decisions And Outcomes
 * for decisions and completed work, and Action Items for what was left open.
 */
export function experienceCard(body: string): ExperienceCard {
  const sections = topSections(body);
  const section = (heading: string) =>
    sections.find((item) => item.heading === heading)?.text ?? "";
  const actions = section(SESSION_SECTIONS.actionItems);
  const outcomes = section(SESSION_SECTIONS.decisionsAndOutcomes);
  return {
    situation: clip(
      firstParagraph(section(SESSION_SECTIONS.objectiveSummary)) ||
        firstParagraph(sections[0]?.text ?? ""),
      MAX_TEXT,
    ),
    decisions: fieldItems(outcomes, SESSION_ITEM_LABELS.decision, 2),
    completed: fieldItems(outcomes, SESSION_ITEM_LABELS.completed, 2),
    // High-priority actions first: they are what a recall is most useful for.
    openItems: fieldItems(actions, SESSION_ITEM_LABELS.action, 3, (item) =>
      item.split("\n").slice(1).includes(highPriority) ? 0 : 1,
    ),
  };
}

/**
 * Reads the dated activity of a Daily report from the sections the
 * application renders: Daily Work, Resolved Items, Unresolved Items, and the
 * Tomorrow Focus the Human set; a focus the model only suggested is left out.
 * Changes and Pattern compare and generalize, so they are not activity. Every
 * link in an item cites a source, so links leave the text.
 */
export function dailyReport(
  report: { date: string; title: string; content: string },
  names: ReadonlyArray<{ target: string; pattern: RegExp }>,
): DailyReport {
  const items: DailyItem[] = [];
  for (const section of topSections(report.content)) {
    const kind = dailyItemSections.get(section.heading);
    if (!kind) continue;
    for (const item of topBullets(section.text)) {
      if (kind === "focus" && item.startsWith(suggestedFocus)) continue;
      const text = clean(item.replace(sourceLink, ""));
      if (!text) continue;
      items.push({
        kind,
        text: clip(text, MAX_ITEM),
        rooms: [...item.matchAll(roomCitation)].map((match) => match[1]!),
        entities: [
          ...new Set(
            names
              .filter(({ pattern }) => text.match(pattern))
              .map(({ target }) => target),
          ),
        ],
      });
    }
  }
  return { date: report.date, title: report.title, items };
}

/**
 * What a day's items about one thing say: its work for the situation,
 * resolved items as completed, and unresolved items and the set focus as
 * left open. A Daily records no separate decisions.
 */
export function dailyCard(items: readonly DailyItem[]): ExperienceCard {
  const texts = (...kinds: DailyItemKind[]) =>
    items.filter((item) => kinds.includes(item.kind)).map((item) => item.text);
  return {
    situation: clip(texts("work").join(" "), MAX_TEXT),
    decisions: [],
    completed: texts("resolved").slice(0, 2),
    openItems: texts("unresolved", "focus").slice(0, 3),
  };
}

function topSections(body: string) {
  const sections: Array<{ heading: string; text: string }> = [];
  let current = { heading: "", text: "" };
  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+)$/u.exec(line);
    if (heading) {
      sections.push(current);
      current = { heading: heading[1]!.trim(), text: "" };
    } else current.text += `${line}\n`;
  }
  sections.push(current);
  return sections.filter((section) => section.text.trim());
}

function firstParagraph(text: string) {
  return (
    text
      .split(/\n\s*\n/u)
      .map((paragraph) => clean(paragraph))
      .find((paragraph) => paragraph && !paragraph.startsWith("#")) ?? ""
  );
}

/** Top-level bullets with their nested lines, so `Priority:` stays visible. */
function topBullets(text: string) {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    if (/^- /u.test(line)) items.push(line.slice(2));
    else if (/^\s+\S/u.test(line) && items.length)
      items[items.length - 1] += `\n${line.trim()}`;
  }
  return items;
}

function fieldItems(
  text: string,
  field: string,
  limit: number,
  rank: (item: string) => number = () => 0,
) {
  const prefix = `${field}: `;
  return topBullets(text)
    .filter((item) => item.startsWith(prefix))
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) =>
      clip(clean(item.split("\n")[0]!.slice(prefix.length)), MAX_ITEM),
    )
    .filter(Boolean)
    .slice(0, limit);
}

function clean(text: string) {
  return text
    .replace(/\[R\d+\]/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\*\*/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function clip(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}
