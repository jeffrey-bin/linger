import {
  EMPTY_SECTION_TEXT,
  REPORT_SOURCES_SECTION,
} from "@linger/knowledge-format/sections";
import { Ajv } from "ajv";
import { stringify } from "yaml";
import type { ReportSourceReference } from "./report-source-references.js";

const ajv = new Ajv({ allErrors: true });

/** A model string that must carry content. */
export const reportTextSchema = {
  type: "string",
  minLength: 1,
  pattern: "\\S",
};

export const reportTextListSchema = { type: "array", items: reportTextSchema };

export function reportSourceRefsSchema(sourceRefs: readonly string[]) {
  return {
    type: "array",
    minItems: 1,
    // Provider structured-output schemas do not support uniqueItems; the
    // renderer rejects duplicates locally.
    items: { type: "string", enum: [...new Set(sourceRefs)] },
  };
}

/** Validates a saved model answer against the schema the model was given, so
 * a stale or hand-edited output fails before anything is rendered. */
export function parseReportOutput<T>(
  raw: string,
  schema: Record<string, unknown>,
  label: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${label} output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const check = ajv.compile(schema);
  if (!check(value))
    throw new Error(
      `${label} output does not match its schema: ${ajv.errorsText(check.errors, { separator: "; " })}`,
    );
  return value as T;
}

export interface ReportSources {
  selected: ReportSourceReference[];
  /** One model string as a single Markdown line with markers resolved. */
  line(text: string): string;
}

export function selectReportSources(
  catalog: readonly ReportSourceReference[],
  sourceRefs: readonly string[],
): ReportSources {
  if (sourceRefs.length === 0)
    throw new Error("Report output requires source_refs");
  if (new Set(sourceRefs).size !== sourceRefs.length)
    throw new Error("Report output contains duplicate source_refs");
  const sources = new Map(catalog.map((source) => [source.sourceRef, source]));
  const selected = sourceRefs.map((sourceRef) => {
    const source = sources.get(sourceRef);
    if (!source)
      throw new Error(
        `Report output selected unknown source_ref: ${sourceRef}`,
      );
    return source;
  });
  const selectedRefs = new Set(sourceRefs);
  return {
    selected,
    line(text) {
      if (
        /(?:[A-Za-z0-9._-]+\/)?evidence\/\d{4}-\d{2}-\d{2}\/sessions\/|(?:memory:\/\/)?timeline\/daily\/|timeline\/weekly\/|teamhub:\/\/(?:rooms|documents)\//u.test(
          text,
        )
      )
        throw new Error(
          "Report output must select Session evidence by source_ref",
        );
      const cited = text.replace(
        /\[\[source:([^\]]+)\]\]/gu,
        (_marker, sourceRef: string) => {
          if (!selectedRefs.has(sourceRef))
            throw new Error(
              `Report output cited an unselected source_ref: ${sourceRef}`,
            );
          return sourceLink(sources.get(sourceRef)!);
        },
      );
      if (cited.includes("[[source:"))
        throw new Error("Report output contains an invalid source_ref marker");
      return cited.replace(/\s+/gu, " ").trim();
    },
  };
}

/** One bullet per rendered line; an empty list is the fixed empty text, so a
 * bullet in a report section always means content. */
export function reportBullets(lines: readonly string[]): string {
  return lines.length > 0
    ? lines.map((line) => `- ${line}`).join("\n")
    : EMPTY_SECTION_TEXT;
}

export interface ReportSection {
  heading: string;
  body: string;
}

export function renderReportMarkdown(report: {
  frontmatter: Record<string, unknown>;
  title: string;
  sections: readonly ReportSection[];
  sources: readonly ReportSourceReference[];
}): string {
  const frontmatter = stringify(
    {
      ...report.frontmatter,
      sources: report.sources.map(({ title, resource }) => ({
        title,
        resource,
      })),
    },
    { lineWidth: 0 },
  ).trimEnd();
  const sections = [
    ...report.sections,
    {
      heading: REPORT_SOURCES_SECTION,
      body: report.sources
        .map((source) => `- ${sourceLink(source)}`)
        .join("\n"),
    },
  ];
  return `---\n${frontmatter}\n---\n\n# ${report.title.replace(/\s+/gu, " ").trim()}\n\n${sections
    .map(({ heading, body }) => `## ${heading}\n\n${body}\n`)
    .join("\n")}`;
}

function sourceLink(source: ReportSourceReference): string {
  const href = source.resource.replace(
    /^memory:\/\/timeline\/(daily|weekly)\//u,
    "../$1/",
  );
  return `[${source.title.replace(/[\\[\]]/gu, "\\$&")}](${href})`;
}
