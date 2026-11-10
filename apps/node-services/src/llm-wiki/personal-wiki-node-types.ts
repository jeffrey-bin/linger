import { readFileSync } from "node:fs";
import path from "node:path";

import { promptsRoot } from "../paths.js";
import {
  ENTITY_SECTIONS,
  SESSION_ACTION_PRIORITIES,
  SESSION_SECTIONS,
} from "@linger/knowledge-format/sections";

export type PersonalWikiNodeTypeId =
  | "client"
  | "contact"
  | "project"
  | "session"
  | "topic";

interface PersonalWikiNodeTypeBase {
  id: PersonalWikiNodeTypeId;
  directory: string;
  fields: readonly string[];
  sections: readonly string[];
  relations: readonly string[];
  promptFile: `${PersonalWikiNodeTypeId}.md`;
}

/**
 * How the model authors one record section. The application renders every
 * shape to Markdown, including the item labels and the empty-section text, so
 * readers can rely on them.
 */
export type PersonalWikiSectionFormat =
  | "text"
  | "markdown"
  | "list"
  | "outcomes"
  | "actions";

/** A dated summary of one source; it never merges with other pages. */
interface PersonalWikiRecordType extends PersonalWikiNodeTypeBase {
  kind: "record";
  /** Authoring shape for every section in `sections`. */
  sectionFormats: Readonly<Record<string, PersonalWikiSectionFormat>>;
  /** Item limits of `list` sections that have one. */
  listLimits: Readonly<Record<string, number>>;
}

/**
 * How an update may change one entity section. `summary` text is kept or
 * written with a reason, `items` are tracked by ID, and `generated` sections are
 * written by the application from those changes.
 */
export type PersonalWikiSectionUpdate = "summary" | "items" | "generated";

/**
 * A section's update rule. `limit` caps a `summary` section's characters, and
 * the entries an `items` section or the generated Change Log keeps on the page;
 * older entries are merged or dropped. `entryLimit` caps the
 * characters of one written `items` entry. `shown` makes an `items` section a
 * dated history listed newest first: a writer sees its `shown` newest entries,
 * the others stay unchanged, and new entries go on top.
 */
export interface PersonalWikiSectionRule {
  update: PersonalWikiSectionUpdate;
  limit?: number;
  entryLimit?: number;
  shown?: number;
}

/** Entries kept on the page by an items section. */
const PERSONAL_WIKI_SECTION_LIMIT = 20;
/** Entries the generated Change Log keeps; older ones are dropped. */
const PERSONAL_WIKI_CHANGE_LOG_LIMIT = 5;
/** Characters of one summary section; each citation counts 20. */
const PERSONAL_WIKI_SUMMARY_LIMIT = 3000;
/** Characters of one items entry, including a merged summary; each citation counts 20. */
const PERSONAL_WIKI_ENTRY_LIMIT = 500;
const summary = {
  update: "summary",
  limit: PERSONAL_WIKI_SUMMARY_LIMIT,
} as const;
const tracked = {
  update: "items",
  limit: PERSONAL_WIKI_SECTION_LIMIT,
  entryLimit: PERSONAL_WIKI_ENTRY_LIMIT,
} as const;
/** A dated log, newest first: a writer adds to its top and needs only its
 * newest entries. */
const history = { ...tracked, shown: 8 } as const;
const changeLog = {
  update: "generated",
  limit: PERSONAL_WIKI_CHANGE_LOG_LIMIT,
} as const;

/**
 * A canonical page per real-world entity. Every entity type shares the rules
 * in entity-common.md; its own prompt adds only type-specific guidance.
 */
interface PersonalWikiEntityType extends PersonalWikiNodeTypeBase {
  kind: "entity";
  /** Frontmatter field holding the canonical name. */
  nameField: string;
  /** Section that records the entity's parts instead of separate pages. */
  partsSection: string;
  /** Update rule for every section in `sections`. */
  sectionRules: Readonly<Record<string, PersonalWikiSectionRule>>;
  /** H2 sections of the type's prompt that decide which entity some
   * evidence is about and when it deserves a page; routing reads only these. */
  identitySections: readonly string[];
}

export type PersonalWikiNodeType =
  | PersonalWikiRecordType
  | PersonalWikiEntityType;

const ENTITY_RULES_FILE = "entity-common.md";
const SESSION_MEETING_NOTE_FILES = [
  "content-method.md",
  "discussion.md",
  "summary.md",
  "formatting.md",
  "todos.md",
  "open-questions.md",
  "quality-checklist.md",
] as const;

const nodeTypes: readonly PersonalWikiNodeType[] = [
  {
    id: "session",
    kind: "record",
    directory: "sessions",
    fields: ["session_id", "date", "source_kind", "sources"],
    sections: Object.values(SESSION_SECTIONS),
    sectionFormats: {
      [SESSION_SECTIONS.objectiveSummary]: "text",
      [SESSION_SECTIONS.keywords]: "list",
      [SESSION_SECTIONS.meetingSummary]: "markdown",
      [SESSION_SECTIONS.mainTopics]: "markdown",
      [SESSION_SECTIONS.decisionsAndOutcomes]: "outcomes",
      [SESSION_SECTIONS.actionItems]: "actions",
      [SESSION_SECTIONS.pattern]: "list",
    },
    listLimits: { [SESSION_SECTIONS.keywords]: 5 },
    relations: ["clients", "contacts", "projects", "topics"],
    promptFile: "session.md",
  },
  entity("client", "client_name", "Basic Info", {
    directory: "clients",
    identitySections: [
      "Field Meanings",
      "Cross-Session Reconciliation",
      "Candidate Screening",
    ],
    fields: ["client_name", "organization", "aliases", "sources"],
    sections: {
      "Basic Info": summary,
      "Collaboration Style": summary,
      "Needs And Constraints": summary,
      Related: tracked,
      "Open Items": tracked,
      "Closed Items": tracked,
      [ENTITY_SECTIONS.changeLog]: changeLog,
    },
    relations: ["contacts", "projects", "topics"],
  }),
  entity("contact", "contact_name", "Relationship Context", {
    directory: "contacts",
    identitySections: [
      "Field Meanings",
      "Cross-Session Reconciliation",
      "Candidate Screening",
    ],
    fields: ["contact_name", "organization", "aliases", "sources"],
    sections: {
      "Basic Info": summary,
      "Relationship Context": summary,
      "Collaboration Style": summary,
      "Needs And Interests": summary,
      Related: tracked,
      [ENTITY_SECTIONS.interactionHistory]: history,
      [ENTITY_SECTIONS.changeLog]: changeLog,
    },
    relations: ["clients", "projects", "topics"],
  }),
  entity("project", "project_name", ENTITY_SECTIONS.projectDirections, {
    directory: "projects",
    identitySections: [
      "Field Meanings",
      "Routing And Grouping",
      "Project Grouping Rules",
    ],
    fields: ["project_name", "project_slug", "aliases", "sources"],
    sections: {
      [ENTITY_SECTIONS.projectSummary]: summary,
      // Its ##### Direction headings are the parts the registry reads.
      [ENTITY_SECTIONS.projectDirections]: summary,
      Related: tracked,
      "Open Items": tracked,
      "Closed Items": tracked,
      [ENTITY_SECTIONS.changeLog]: changeLog,
    },
    relations: ["clients", "contacts", "topics"],
  }),
  entity("topic", "topic_name", "Current Understanding", {
    directory: "topics",
    identitySections: ["Field Meanings", "Continuity"],
    fields: ["topic_name", "aliases", "sources"],
    sections: {
      Overview: summary,
      "Current Understanding": summary,
      Related: tracked,
      [ENTITY_SECTIONS.changeLog]: changeLog,
    },
    relations: ["clients", "contacts", "projects", "topics"],
  }),
];

/** Section order and update rules come from one ordered declaration. */
function entity(
  id: PersonalWikiNodeTypeId,
  nameField: string,
  partsSection: string,
  declaration: {
    directory: string;
    identitySections: readonly string[];
    fields: readonly string[];
    sections: Readonly<
      Record<string, PersonalWikiSectionUpdate | PersonalWikiSectionRule>
    >;
    relations: readonly string[];
  },
): PersonalWikiEntityType {
  return {
    id,
    kind: "entity",
    nameField,
    partsSection,
    directory: declaration.directory,
    fields: declaration.fields,
    sections: Object.keys(declaration.sections),
    sectionRules: Object.fromEntries(
      Object.entries(declaration.sections).map(([heading, rule]) => [
        heading,
        typeof rule === "string" ? { update: rule } : rule,
      ]),
    ),
    relations: declaration.relations,
    identitySections: declaration.identitySections,
    promptFile: `${id}.md`,
  };
}

export const PERSONAL_WIKI_NODE_TYPES = new Map(
  nodeTypes.map((definition) => [definition.id, definition]),
);

export function personalWikiNodeTypeForPath(
  relativePath: string,
): PersonalWikiNodeType | undefined {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  return nodeTypes.find((definition) =>
    normalized.startsWith(`${definition.directory}/`),
  );
}

export const PERSONAL_WIKI_ENTITY_TYPES = nodeTypes.filter(
  (definition): definition is PersonalWikiEntityType =>
    definition.kind === "entity",
);

/** The authoring shape of a record section; entity sections have none. */
export function personalWikiSectionFormat(
  definition: PersonalWikiNodeType,
  heading: string,
): PersonalWikiSectionFormat | undefined {
  return definition.kind === "record"
    ? definition.sectionFormats[heading]
    : undefined;
}

const SECTION_FORMAT_DESCRIPTIONS: Record<PersonalWikiSectionFormat, string> = {
  text: "non-empty string",
  markdown:
    'Markdown string, headings H3 or deeper; "" when the source supports nothing',
  list: "array of one-line strings; [] when the source supports nothing",
  outcomes:
    '[] or array of {"kind": "decision"|"completed", "text", "evidence"}',
  actions: `[] or array of {"owner", "deadline", "resources", "priority": ${SESSION_ACTION_PRIORITIES.map((p) => `"${p}"`).join("|")}, "text", "evidence"}, with null for an owner, deadline, resources or priority the source does not state`,
};

/** Record types have no update rule. */
function personalWikiSectionRule(
  definition: PersonalWikiNodeType,
  heading: string,
): PersonalWikiSectionRule | undefined {
  return definition.kind === "entity"
    ? definition.sectionRules[heading]
    : undefined;
}

export function personalWikiSectionUpdate(
  definition: PersonalWikiNodeType,
  heading: string,
): PersonalWikiSectionUpdate | undefined {
  return personalWikiSectionRule(definition, heading)?.update;
}

export function personalWikiSectionDescription(
  definition: PersonalWikiNodeType,
  heading: string,
): string | undefined {
  if (definition.id !== "session") return undefined;
  if (heading === SESSION_SECTIONS.pattern) {
    const rules = readPrompt("session.md").match(
      /^### Pattern\n([\s\S]*?)(?=^## )/mu,
    )?.[1];
    if (!rules) throw new Error("Session Pattern instructions are missing");
    return rules.trim();
  }
  const filename =
    heading === SESSION_SECTIONS.meetingSummary
      ? "summary.md"
      : heading === SESSION_SECTIONS.mainTopics
        ? "discussion.md"
        : undefined;
  if (!filename) return undefined;
  return `${readPrompt(`session-meeting-note/${filename}`)}

Session JSON field format adaptation: this field holds only the section body; the outer H2 is generated by the app.
The "## Meeting Summary" heading in the source example is not written into the field; in the layered body, main-topic H2 becomes H3 and sub-topic H3 becomes H4.
Inside the field, main topics start at H3, and H1/H2 must not appear. Only adjust heading levels; do not abbreviate anything the original rules require.

${readPrompt("session-evidence.md")}`;
}

/** One registered type's fields, sections and prompt, as a run reads them. */
export function formatPersonalWikiNodeTypeInstruction(
  definition: PersonalWikiNodeType,
): string {
  const prompt = readPrompt(definition.promptFile);
  const references =
    definition.id === "session"
      ? [
          ...SESSION_MEETING_NOTE_FILES.map(
            (filename) =>
              `REFERENCE test-meeting-note 1.0.23/references/${filename}\n\n${readPrompt(`session-meeting-note/${filename}`)}`,
          ),
          readPrompt("session-evidence.md"),
        ].join("\n\n")
      : "";
  const parts =
    definition.kind === "entity"
      ? `\n  Parts section: ${definition.partsSection}`
      : `\n  Required top-level boolean: source_readable (false only when the supplied source has no readable content)`;
  const sections = definition.sections.map((heading) => {
    const format = personalWikiSectionFormat(definition, heading);
    if (format) {
      const limit =
        definition.kind === "record" && definition.listLimits[heading];
      return `${heading} (${SECTION_FORMAT_DESCRIPTIONS[format]}${limit ? `, at most ${limit} items` : ""})`;
    }
    const rule = personalWikiSectionRule(definition, heading);
    if (!rule) return heading;
    const unit = rule.update === "summary" ? "characters" : "entries";
    const entry = rule.entryLimit
      ? ` of at most ${rule.entryLimit} characters`
      : "";
    return `${heading} (${rule.update}${rule.limit ? `, at most ${rule.limit} ${unit}${entry}` : ""})`;
  });
  return `- /${definition.directory}/ (${definition.id})
  Required frontmatter fields: ${definition.fields.join(", ")}
  Required H2 sections in order: ${sections.join("; ")}
  Typed relations: [] or array of {"kind", "page"}, kind one of ${definition.relations.join(", ")}${parts}

${prompt}${references ? `\n\n${references}` : ""}`;
}

/** The rules every durable entity type shares. */
export function personalWikiEntityRules(): string {
  return readPrompt(ENTITY_RULES_FILE);
}

/**
 * What decides which entity a piece of evidence is about and whether it
 * deserves a page: each entity type's identity sections, without the rules
 * for writing its sections.
 */
export function personalWikiIdentityRules(): string {
  return PERSONAL_WIKI_ENTITY_TYPES.map((definition) => {
    const prompt = readPrompt(definition.promptFile);
    const sections = definition.identitySections.map((heading) => {
      const body = new RegExp(
        `^## ${heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
        "mu",
      ).exec(prompt)?.[1];
      if (!body)
        throw new Error(
          `Personal Wiki identity section is missing: ${definition.promptFile} ${heading}`,
        );
      return `### ${heading}\n\n${body.trim()}`;
    });
    return `## ${definition.id[0]!.toUpperCase()}${definition.id.slice(1)} (/${definition.directory}/)\n\n${sections.join("\n\n")}`;
  }).join("\n\n");
}

function readPrompt(filename: string): string {
  const prompt = readFileSync(
    path.join(promptsRoot, "llm-wiki", "personal", filename),
    "utf8",
  ).trim();
  if (!prompt) {
    throw new Error(`Personal Wiki extraction prompt is empty: ${filename}`);
  }
  return prompt;
}
