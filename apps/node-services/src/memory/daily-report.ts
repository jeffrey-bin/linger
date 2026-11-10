import {
  DAILY_REPORT_SECTIONS,
  SUGGESTED_FOCUS_LABEL,
} from "@linger/knowledge-format/sections";
import {
  renderReportMarkdown,
  reportBullets,
  reportSourceRefsSchema,
  reportTextListSchema,
  reportTextSchema,
  selectReportSources,
} from "./report-render.js";
import type { ReportSourceReference } from "./report-source-references.js";

/** Rendered when the collection has no yesterday Daily to compare with. */
export const NO_YESTERDAY_BASELINE_TEXT = "No yesterday baseline available.";

export interface DailyReportOutput {
  title: string;
  description: string;
  source_refs: string[];
  daily_work: Array<{ topic: string; text: string }>;
  resolved_items: string[];
  unresolved_items: string[];
  tomorrow_focus: Array<{ text: string; suggested: boolean }>;
  changes_compared_to_yesterday: string[];
  pattern: string[];
}

export function dailyReportSchema(sourceRefs: readonly string[]) {
  const object = (properties: Record<string, unknown>) => ({
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  });
  return object({
    title: reportTextSchema,
    description: reportTextSchema,
    source_refs: reportSourceRefsSchema(sourceRefs),
    daily_work: {
      type: "array",
      items: object({ topic: reportTextSchema, text: reportTextSchema }),
    },
    resolved_items: reportTextListSchema,
    unresolved_items: reportTextListSchema,
    tomorrow_focus: {
      type: "array",
      items: object({ text: reportTextSchema, suggested: { type: "boolean" } }),
    },
    changes_compared_to_yesterday: reportTextListSchema,
    pattern: reportTextListSchema,
  });
}

export function renderDailyReport(
  report: DailyReportOutput,
  context: {
    date: string;
    memorySubjectKey: string;
    hasYesterdayBaseline: boolean;
    catalog: readonly ReportSourceReference[];
    now: Date;
  },
): string {
  const sources = selectReportSources(context.catalog, report.source_refs);
  const bullets = (items: readonly string[]) =>
    reportBullets(items.map(sources.line));
  return renderReportMarkdown({
    frontmatter: {
      type: "Daily Memory",
      title: report.title,
      description: report.description,
      date: context.date,
      memory_subject_key: context.memorySubjectKey,
      status: "stable",
      generated: { by: "linger-memory/1", at: context.now.toISOString() },
    },
    title: report.title,
    sections: [
      {
        heading: DAILY_REPORT_SECTIONS.dailyWork,
        body: reportBullets(
          report.daily_work.map(
            ({ topic, text }) =>
              `**${sources.line(topic)}**: ${sources.line(text)}`,
          ),
        ),
      },
      {
        heading: DAILY_REPORT_SECTIONS.resolvedItems,
        body: bullets(report.resolved_items),
      },
      {
        heading: DAILY_REPORT_SECTIONS.unresolvedItems,
        body: bullets(report.unresolved_items),
      },
      {
        heading: DAILY_REPORT_SECTIONS.tomorrowFocus,
        body: reportBullets(
          report.tomorrow_focus.map(({ text, suggested }) =>
            suggested
              ? `${SUGGESTED_FOCUS_LABEL}: ${sources.line(text)}`
              : sources.line(text),
          ),
        ),
      },
      {
        heading: DAILY_REPORT_SECTIONS.changesComparedToYesterday,
        body: context.hasYesterdayBaseline
          ? bullets(report.changes_compared_to_yesterday)
          : NO_YESTERDAY_BASELINE_TEXT,
      },
      { heading: DAILY_REPORT_SECTIONS.pattern, body: bullets(report.pattern) },
    ],
    sources: sources.selected,
  });
}

const evidenceSections = new Set<string>([
  DAILY_REPORT_SECTIONS.dailyWork,
  DAILY_REPORT_SECTIONS.resolvedItems,
  DAILY_REPORT_SECTIONS.unresolvedItems,
  DAILY_REPORT_SECTIONS.tomorrowFocus,
  DAILY_REPORT_SECTIONS.pattern,
]);

/**
 * Whether a rendered Daily records substantive activity: a list item in one
 * of its activity sections. The renderer writes an empty section as
 * EMPTY_SECTION_TEXT and never as a bullet, so this reads structure only.
 */
export function dailyReportHasEvidence(content: string): boolean {
  let section: string | undefined;
  for (const line of content.split(/\r?\n/u)) {
    if (line.startsWith("## ")) section = line.slice(3);
    else if (section && evidenceSections.has(section) && line.startsWith("- "))
      return true;
  }
  return false;
}
