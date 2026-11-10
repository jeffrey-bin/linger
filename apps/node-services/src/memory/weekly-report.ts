import { WEEKLY_REPORT_SECTIONS } from "@linger/knowledge-format/sections";
import {
  renderReportMarkdown,
  reportBullets,
  reportSourceRefsSchema,
  reportTextListSchema,
  reportTextSchema,
  selectReportSources,
} from "./report-render.js";
import type { ReportSourceReference } from "./report-source-references.js";

/** Rendered when the collection has no previous Weekly to compare with. */
export const NO_PREVIOUS_WEEKLY_TEXT = "No previous dynamic profile available.";

export interface WeeklyReportOutput {
  description: string;
  source_refs: string[];
  closed_works: string[];
  ongoing_works: string[];
  open_works: string[];
  big_change: string[];
  work_intensity: string;
  pattern: string[];
}

export function weeklyReportSchema(sourceRefs: readonly string[]) {
  const properties = {
    description: reportTextSchema,
    source_refs: reportSourceRefsSchema(sourceRefs),
    closed_works: reportTextListSchema,
    ongoing_works: reportTextListSchema,
    open_works: reportTextListSchema,
    big_change: reportTextListSchema,
    work_intensity: reportTextSchema,
    pattern: reportTextListSchema,
  };
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

export function renderWeeklyReport(
  report: WeeklyReportOutput,
  context: {
    weekStart: string;
    memorySubjectKey: string;
    hasPreviousWeekly: boolean;
    catalog: readonly ReportSourceReference[];
    now: Date;
  },
): string {
  const sources = selectReportSources(context.catalog, report.source_refs);
  const bullets = (items: readonly string[]) =>
    reportBullets(items.map(sources.line));
  const title = `User Dynamic: ${context.weekStart}`;
  return renderReportMarkdown({
    frontmatter: {
      type: "Weekly User Dynamic Memory",
      title,
      description: report.description,
      week_start: context.weekStart,
      memory_subject_key: context.memorySubjectKey,
      status: "stable",
      generated: { by: "linger-memory/1", at: context.now.toISOString() },
    },
    title,
    sections: [
      {
        heading: WEEKLY_REPORT_SECTIONS.closedWorks,
        body: bullets(report.closed_works),
      },
      {
        heading: WEEKLY_REPORT_SECTIONS.ongoingWorks,
        body: bullets(report.ongoing_works),
      },
      {
        heading: WEEKLY_REPORT_SECTIONS.openWorks,
        body: bullets(report.open_works),
      },
      {
        heading: WEEKLY_REPORT_SECTIONS.bigChange,
        body: context.hasPreviousWeekly
          ? bullets(report.big_change)
          : NO_PREVIOUS_WEEKLY_TEXT,
      },
      {
        heading: WEEKLY_REPORT_SECTIONS.workIntensity,
        body: sources.line(report.work_intensity),
      },
      {
        heading: WEEKLY_REPORT_SECTIONS.pattern,
        body: bullets(report.pattern),
      },
    ],
    sources: sources.selected,
  });
}
