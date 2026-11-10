import { Calendar03Icon } from "@hugeicons/core-free-icons";
import {
  DAILY_REPORT_SECTIONS,
  EMPTY_SECTION_TEXT,
  SUGGESTED_FOCUS_LABEL,
} from "@linger/knowledge-format/sections";
import { Icon } from "@/components/ui/icon";
import type { TeamHubMemoryEntry } from "@/features/teamhub/teamhub-types";
import {
  usePeriodReport,
  type PeriodReportKind,
} from "@/features/memory/wiki-period-reports";

interface DailyReportParts {
  summary: string;
  highlights: string[];
  next: string;
}

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function formatReportDay(day: string): string {
  const parsed = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(parsed) ? dayFormatter.format(parsed) : day;
}

function section(markdown: string, titles: string[]): string {
  for (const title of titles) {
    const match = new RegExp(
      `^## ${title}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
      "mu",
    ).exec(markdown);
    const body = match?.[1]?.trim();
    if (body && body !== EMPTY_SECTION_TEXT) return body;
  }
  return "";
}

function plain(text: string): string {
  return text
    .replace(/\[\[source:[^\]]*\]\]/gu, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`]/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/ ([.,;:!?])/gu, "$1")
    .trim();
}

// A Daily Work item reads "**topic**: detail"; the card shows the topic, as
// the design's one-line Highlights do, and the whole item without one.
function items(block: string): string[] {
  const bullets = block
    .split("\n")
    .filter((line) => /^\s*(?:[-*+]|\d+\.)\s+/u.test(line))
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/u, ""))
    .map((line) => plain(/^\*\*(.+?)\*\*/u.exec(line)?.[1] ?? line));
  return (bullets.length ? bullets : [plain(block)]).filter(Boolean);
}

function frontmatter(content: string) {
  return /^---\n([\s\S]*?)\n---\n/u.exec(content)?.[1] ?? "";
}

function unquote(value: string) {
  return value.trim().replace(/^(["'])(.*)\1$/u, "$2");
}

/** Reads a Daily Memory into the card's summary, Highlights, and Next. */
export function parseDailyReport(
  entry: Pick<TeamHubMemoryEntry, "summary" | "content">,
): DailyReportParts {
  const meta = frontmatter(entry.content);
  const markdown = entry.content.replace(/^---\n[\s\S]*?\n---\n/u, "");
  const description = unquote(/^description:(.*)$/mu.exec(meta)?.[1] ?? "");
  const work = items(
    section(markdown, [
      DAILY_REPORT_SECTIONS.dailyWork,
      DAILY_REPORT_SECTIONS.resolvedItems,
    ]),
  );
  return {
    summary:
      plain(description) ||
      plain(entry.summary) ||
      work[0] ||
      "Open the timeline to read this report.",
    highlights: work.slice(0, 2),
    next: (
      items(section(markdown, [DAILY_REPORT_SECTIONS.tomorrowFocus]))[0] ?? ""
    ).replace(new RegExp(`^${SUGGESTED_FOCUS_LABEL}: `, "u"), ""),
  };
}

export function WikiDailyCard({
  tenantId,
  kind = "daily",
  day,
  entry,
  load = true,
  onOpen,
  className = "",
}: {
  tenantId: string;
  kind?: PeriodReportKind;
  day: string;
  entry?: TeamHubMemoryEntry;
  load?: boolean;
  onOpen: () => void;
  className?: string;
}) {
  // List entries may omit the body; the full entry fills Highlights and Next.
  const full = usePeriodReport(
    tenantId,
    kind,
    day,
    entry,
    load && Boolean(entry) && !entry?.content,
  );
  const parts = entry ? parseDailyReport(full.data ?? entry) : undefined;
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- the whole card is a pointer shortcut; keyboard users open the report with its button
    <article
      aria-label={`${kind === "daily" ? "Daily" : "Weekly"} report ${day}`}
      className={`daily-card ${className}`}
      onClick={(event) => {
        if (
          !(event.target as Element).closest("button,a") &&
          window.getSelection()?.isCollapsed !== false
        )
          onOpen();
      }}
    >
      <div className="daily-card-meta">
        <Icon icon={Calendar03Icon} size={14} />
        <time dateTime={day}>{formatReportDay(day)}</time>
      </div>
      <div className="daily-card-body">
        <button
          aria-label={`Open ${kind === "daily" ? "Daily" : "Weekly"} for ${day}`}
          className="daily-card-summary"
          onClick={onOpen}
          type="button"
        >
          {parts?.summary ??
            `No ${kind === "daily" ? "daily" : "weekly"} report for this ${kind === "daily" ? "day" : "week"}.`}
        </button>
        {parts?.highlights.length ? (
          <div className="daily-card-group">
            <span className="daily-tag">Highlights</span>
            <ul>
              {parts.highlights.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {parts?.next ? (
          <div className="daily-card-group">
            <span className="daily-tag">Next</span>
            <p>{parts.next}</p>
          </div>
        ) : null}
      </div>
    </article>
  );
}
