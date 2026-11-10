/**
 * Fixed English text the application renders into knowledge Markdown. Models
 * return structured fields; the generators write these headings, labels and
 * markers, and readers locate content by matching them exactly. They are
 * markers, never translated, whatever language the content is in.
 */

/** Session page H2 sections, in page order. */
export const SESSION_SECTIONS = {
  objectiveSummary: "Objective Summary",
  keywords: "Keywords",
  meetingSummary: "Meeting Summary",
  mainTopics: "Main Topics",
  decisionsAndOutcomes: "Decisions And Outcomes",
  actionItems: "Action Items",
  pattern: "Pattern",
} as const;

/** Entity page sections that readers outside the Wiki generator look up. */
export const ENTITY_SECTIONS = {
  projectSummary: "Project Summary",
  projectDirections: "Project Directions",
  interactionHistory: "Interaction History",
  changeLog: "Change Log",
} as const;

/**
 * Labels that lead the rendered list items of Decisions And Outcomes and
 * Action Items (`- Decision: …`) and their nested fields (`  - Owner: …`).
 */
export const SESSION_ITEM_LABELS = {
  decision: "Decision",
  completed: "Completed",
  action: "Action",
  owner: "Owner",
  deadline: "Deadline",
  resources: "Resources",
  priority: "Priority",
  evidence: "Evidence",
} as const;

/** Explicit Action Item priorities, rendered as `Priority: <value>`. */
export const SESSION_ACTION_PRIORITIES = ["high", "medium", "low"] as const;

/** Daily report H2 sections, in page order, before the Sources section. */
export const DAILY_REPORT_SECTIONS = {
  dailyWork: "Daily Work",
  resolvedItems: "Resolved Items",
  unresolvedItems: "Unresolved Items",
  tomorrowFocus: "Tomorrow Focus",
  changesComparedToYesterday: "Changes Compared To Yesterday",
  pattern: "Pattern",
} as const;

/** Weekly report H2 sections, in page order, before the Sources section. */
export const WEEKLY_REPORT_SECTIONS = {
  closedWorks: "Closed Works",
  ongoingWorks: "Ongoing Works",
  openWorks: "Open Works",
  bigChange: "Big Change",
  workIntensity: "Work Intensity",
  pattern: "Pattern",
} as const;

/** The last H2 of a Daily or Weekly report: links to its selected sources. */
export const REPORT_SOURCES_SECTION = "Sources";

/** Leads a Tomorrow Focus item the model proposed rather than one assigned. */
export const SUGGESTED_FOCUS_LABEL = "Suggested focus";

/** The whole body of a rendered section that has no content. */
export const EMPTY_SECTION_TEXT = "None observed.";
