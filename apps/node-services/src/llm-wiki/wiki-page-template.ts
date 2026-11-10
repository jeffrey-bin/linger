import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import { parseOkfFrontmatter } from "@linger/knowledge-format";
import {
  EMPTY_SECTION_TEXT,
  ENTITY_SECTIONS,
  SESSION_ACTION_PRIORITIES,
  SESSION_ITEM_LABELS,
  SESSION_SECTIONS,
} from "@linger/knowledge-format/sections";
import { validateOkfFrontmatter } from "openwiki/dist/okf/frontmatter.js";

import {
  personalWikiNodeTypeForPath,
  personalWikiSectionDescription,
  personalWikiSectionFormat,
  personalWikiSectionUpdate,
  type PersonalWikiNodeType,
} from "./personal-wiki-node-types.js";
import { isRecord } from "@linger/service-kit";
import { isRawSourceUrl, rawSourceReference } from "./personal-wiki-policy.js";

/**
 * A page JSON the model must repair. The code tells the correction loop whether
 * the problem is a citation, source ref or catalog entry, or the page shape.
 */
export class WikiPageAuthoringError extends Error {
  constructor(
    readonly code: "invalid_evidence_reference" | "invalid_node_structure",
    message: string,
  ) {
    super(message);
    this.name = "WikiPageAuthoringError";
  }
}

function structureError(message: string): WikiPageAuthoringError {
  return new WikiPageAuthoringError("invalid_node_structure", message);
}

function evidenceError(message: string): WikiPageAuthoringError {
  return new WikiPageAuthoringError("invalid_evidence_reference", message);
}

const ajv = new Ajv({ allErrors: true });
const text = { type: "string", minLength: 1, pattern: "\\S" };
const list = { type: "array", items: text, uniqueItems: true };
const itemId = { type: "string", pattern: "^i[1-9]\\d*$" };
const outcomeInput = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "text", "evidence"],
  properties: {
    kind: { enum: ["decision", "completed"] },
    text,
    evidence: text,
  },
};
const actionInput = {
  type: "object",
  additionalProperties: false,
  required: ["text", "evidence"],
  properties: {
    text,
    evidence: text,
    owner: text,
    deadline: text,
    resources: text,
    priority: { enum: [...SESSION_ACTION_PRIORITIES] },
  },
};
const summaryInput = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["keep"],
      properties: { keep: { const: true } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["text", "reason"],
      properties: {
        text,
        reason: text,
        removed_refs: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: "^raw:S" },
        },
      },
    },
  ],
};
const itemsInput = {
  type: "array",
  items: {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { id: itemId, text },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: itemId },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["id", "retracted"],
        properties: { id: itemId, retracted: text },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["merge", "text"],
        properties: {
          merge: {
            type: "array",
            minItems: 2,
            uniqueItems: true,
            items: itemId,
          },
          text,
        },
      },
    ],
  },
};
const sourceMarker = /\[\[source:([^\]]+)\]\]/gu;
type SummaryInput =
  | { keep: true }
  | { text: string; reason: string; removed_refs?: string[] };
interface OutcomeInput {
  kind: "decision" | "completed";
  text: string;
  evidence: string;
}
interface ActionInput {
  text: string;
  evidence: string;
  owner?: string;
  deadline?: string;
  resources?: string;
  priority?: (typeof SESSION_ACTION_PRIORITIES)[number];
}
type SessionInput = string | string[] | OutcomeInput[] | ActionInput[];
type ItemInput =
  | { id?: string; text: string }
  | { id: string }
  | { id: string; retracted: string }
  | { merge: string[]; text: string };
/**
 * A tracked item. Frontmatter stores only the IDs in body order; the text is
 * the rendered list entry, with `[[source:raw:S…]]` markers while reconciling.
 */
interface Item {
  id: string;
  text: string;
}
interface Page {
  title: string;
  description: string;
  fields: Record<string, string | string[]>;
  sections: Record<string, SessionInput | SummaryInput | ItemInput[]>;
  source_refs: string[];
  /** Session authoring only: whether the supplied source had readable content. */
  source_readable?: boolean;
  relations: Record<string, string[]>;
  status?: "draft" | "stable" | "deprecated";
}
/** The current page, with its R-labels mapped back to catalog refs. */
interface PriorPage {
  sections: Record<string, string>;
  items: Record<string, Item[]> | undefined;
  /** Catalog refs the page lists as sources, cited in its text or not. */
  refs: string[];
}

/**
 * One registry-derived schema controls both model input and publication review.
 * Review passes the catalog refs; the prompt omits them because repeating the
 * catalog in every node schema grows the prompt with each cited source.
 * Persisted pages store every section as rendered text, whatever its update
 * rule or authoring format.
 */
export function wikiPageSchema(
  definition: PersonalWikiNodeType,
  refs?: readonly string[],
  persisted = false,
) {
  const fields = definition.fields.filter((field) => field !== "sources");
  const authored = definition.sections.filter(
    (heading) =>
      persisted ||
      personalWikiSectionUpdate(definition, heading) !== "generated",
  );
  const readable = definition.kind === "record" && !persisted;
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "description",
      "fields",
      "sections",
      "source_refs",
      "relations",
      ...(readable ? ["source_readable"] : []),
    ],
    properties: {
      ...(readable ? { source_readable: { type: "boolean" } } : {}),
      title: text,
      description: text,
      status: { enum: ["draft", "stable", "deprecated"] },
      fields: {
        type: "object",
        additionalProperties: false,
        required: fields,
        properties: Object.fromEntries(
          fields.map((field) => [
            field,
            field === "aliases"
              ? list
              : field === "source_kind"
                ? { enum: ["room", "meeting"] }
                : field === "date" || field === "week_start"
                  ? { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }
                  : text,
          ]),
        ),
      },
      sections: {
        type: "object",
        additionalProperties: false,
        required: authored,
        properties: Object.fromEntries(
          authored.map((heading) => {
            const update = persisted
              ? undefined
              : personalWikiSectionUpdate(definition, heading);
            if (update === "summary") return [heading, summaryInput];
            if (update === "items") return [heading, itemsInput];
            const description = personalWikiSectionDescription(
              definition,
              heading,
            );
            const schema = persisted
              ? text
              : sectionFormatSchema(definition, heading);
            return [heading, description ? { ...schema, description } : schema];
          }),
        ),
      },
      source_refs: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: refs
          ? { type: "string", enum: [...refs] }
          : { type: "string", pattern: "^raw:S" },
      },
      relations: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          definition.relations.map((kind) => [kind, list]),
        ),
      },
    },
  };
}

function sectionFormatSchema(
  definition: PersonalWikiNodeType,
  heading: string,
): Record<string, unknown> {
  switch (personalWikiSectionFormat(definition, heading)) {
    case "markdown":
      return { type: "string" };
    case "list": {
      const limit =
        definition.kind === "record"
          ? definition.listLimits[heading]
          : undefined;
      return {
        type: "array",
        items: text,
        ...(limit ? { maxItems: limit } : {}),
      };
    }
    case "outcomes":
      return { type: "array", items: outcomeInput };
    case "actions":
      return { type: "array", items: actionInput };
    default:
      return text;
  }
}

/*
 * Structured output must write every property of a strict object before it
 * may close it. Where the prompt lets the model leave something out, the
 * schema must let it stop there too: a model that wants to close an object
 * whose remaining keys it sees no use for can only stream whitespace, which
 * JSON allows anywhere, and may never stop. So a value the model may omit is
 * an `anyOf` branch chosen at the start, a nullable key comes before the
 * keys that carry content, and an open set is an array, not an object with a
 * key per kind.
 */
const strictObject = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const strictText = { type: "string", minLength: 1 };
const strictList = { type: "array", items: strictText };
const strictNullableText = { type: ["string", "null"] };
/** Written summary text always carries its reason; the Change Log records
 * the reason of a rewrite. */
const strictSummaryText = strictObject({
  text: strictText,
  reason: strictText,
});
/** An existing page's summary: kept, rewritten, or rewritten without the
 * facts of deleted sources, which the model names first. */
const strictSummary = {
  anyOf: [
    strictObject({ keep: { type: "boolean", enum: [true] } }),
    strictSummaryText,
    strictObject({
      removed_refs: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
      },
      reason: strictText,
      text: strictText,
    }),
  ],
};
const strictItems = {
  type: "array",
  items: {
    anyOf: [
      strictObject({ text: strictText }),
      strictObject({ id: { type: "string" }, text: strictText }),
      strictObject({ id: { type: "string" }, retracted: strictText }),
      strictObject({
        merge: { type: "array", items: { type: "string" } },
        text: strictText,
      }),
    ],
  },
};

/**
 * The page JSON as a structured model call writes it. Structured output wants
 * every property required and no `oneOf`, so this twin of `wikiPageSchema`
 * writes optional values as null and update shapes as `anyOf`;
 * `wikiPageFromStrictPayload` turns it back into the page JSON that
 * `renderWikiPage` checks.
 */
export function strictWikiPageSchema(
  definition: PersonalWikiNodeType,
  /** A new page has no text to keep, so it writes every summary. */
  options: { readonly existing: boolean } = { existing: true },
): Record<string, unknown> {
  const fields = definition.fields.filter((field) => field !== "sources");
  const sections = definition.sections.filter(
    (heading) => personalWikiSectionUpdate(definition, heading) !== "generated",
  );
  return strictObject({
    title: strictText,
    description: strictText,
    fields: strictObject(
      Object.fromEntries(
        fields.map((field) => [
          field,
          field === "aliases"
            ? strictList
            : field === "source_kind"
              ? { type: "string", enum: ["room", "meeting"] }
              : strictText,
        ]),
      ),
    ),
    sections: strictObject(
      Object.fromEntries(
        sections.map((heading) => [
          heading,
          strictSectionSchema(definition, heading, options.existing),
        ]),
      ),
    ),
    source_refs: { type: "array", items: { type: "string" } },
    relations: {
      type: "array",
      items: strictObject({
        kind: { type: "string", enum: [...definition.relations] },
        page: strictText,
      }),
    },
    ...(definition.kind === "record"
      ? { source_readable: { type: "boolean" } }
      : {}),
  });
}

function strictSectionSchema(
  definition: PersonalWikiNodeType,
  heading: string,
  existing: boolean,
): Record<string, unknown> {
  const update = personalWikiSectionUpdate(definition, heading);
  if (update === "summary") return existing ? strictSummary : strictSummaryText;
  if (update === "items") return strictItems;
  switch (personalWikiSectionFormat(definition, heading)) {
    case "markdown":
      return { type: "string" };
    case "list": {
      const limit =
        definition.kind === "record"
          ? definition.listLimits[heading]
          : undefined;
      return { ...strictList, ...(limit ? { maxItems: limit } : {}) };
    }
    case "outcomes":
      return {
        type: "array",
        items: strictObject({
          kind: { type: "string", enum: ["decision", "completed"] },
          text: strictText,
          evidence: strictText,
        }),
      };
    case "actions":
      return {
        type: "array",
        items: strictObject({
          owner: strictNullableText,
          deadline: strictNullableText,
          resources: strictNullableText,
          priority: {
            type: ["string", "null"],
            enum: [...SESSION_ACTION_PRIORITIES, null],
          },
          text: strictText,
          evidence: strictText,
        }),
      };
    default:
      return strictText;
  }
}

/**
 * The page JSON `renderWikiPage` checks, from a `strictWikiPageSchema` value.
 * Frontmatter cannot carry citations, so source markers a model put in the
 * title, description, fields or relations are dropped; sections keep theirs.
 */
export function wikiPageFromStrictPayload(
  definition: PersonalWikiNodeType,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const uncited = (value: unknown): unknown =>
    typeof value === "string"
      ? value.replace(/\s*\[\[source:[^\]]*\]\]/gu, "").trim()
      : Array.isArray(value)
        ? value.map(uncited)
        : value;
  const unique = (value: unknown) =>
    Array.isArray(value) ? [...new Set(value)] : value;
  const record = (value: unknown) => (isRecord(value) ? value : {});
  const withoutNulls = (value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.entries(value).filter(([, entry]) => entry !== null),
        )
      : value;
  const sections = Object.fromEntries(
    Object.entries(record(payload.sections)).map(([heading, value]) => {
      const update = personalWikiSectionUpdate(definition, heading);
      if (update === "summary") {
        const summary = record(value);
        if (summary.keep === true) return [heading, { keep: true }];
        const removed = unique(summary.removed_refs);
        return [
          heading,
          {
            text: summary.text,
            reason: summary.reason,
            ...(Array.isArray(removed) && removed.length
              ? { removed_refs: removed }
              : {}),
          },
        ];
      }
      if (update === "items")
        return [
          heading,
          (Array.isArray(value) ? value : []).map((entry) => {
            const item = record(entry);
            return "merge" in item
              ? { merge: unique(item.merge), text: item.text }
              : item;
          }),
        ];
      const format = personalWikiSectionFormat(definition, heading);
      if (format === "actions" && Array.isArray(value))
        return [heading, value.map(withoutNulls)];
      if (format === "list") return [heading, unique(value)];
      return [heading, value];
    }),
  );
  return {
    ...payload,
    title: uncited(payload.title),
    description: uncited(payload.description),
    fields: Object.fromEntries(
      Object.entries(record(payload.fields)).map(([field, value]) => [
        field,
        field === "aliases" ? unique(uncited(value)) : uncited(value),
      ]),
    ),
    sections,
    source_refs: unique(payload.source_refs),
    relations: relationsByKind(definition, payload.relations),
  };
}

/** The strict payload's `[{kind, page}]` relations as the page's
 * kind-to-pages map, every allowed kind present. */
function relationsByKind(
  definition: PersonalWikiNodeType,
  value: unknown,
): Record<string, string[]> {
  const relations: Record<string, Set<string>> = Object.fromEntries(
    definition.relations.map((kind) => [kind, new Set<string>()]),
  );
  for (const entry of Array.isArray(value) ? value : []) {
    if (!isRecord(entry) || typeof entry.page !== "string") continue;
    const page = entry.page.replace(/\s*\[\[source:[^\]]*\]\]/gu, "").trim();
    const kind =
      typeof entry.kind === "string" ? relations[entry.kind] : undefined;
    if (kind && page) kind.add(page);
  }
  return Object.fromEntries(
    Object.entries(relations).map(([kind, pages]) => [kind, [...pages]]),
  );
}

function validate(
  page: unknown,
  definition: PersonalWikiNodeType,
  references: ReadonlyMap<string, string>,
  persisted = false,
): asserts page is Page {
  const schema = wikiPageSchema(definition, [...references.keys()], persisted);
  const check = ajv.compile(schema);
  if (!check(page)) {
    const message = `Wiki page schema: ${ajv.errorsText(check.errors, { separator: "; " })}`;
    throw check.errors?.some((error) =>
      error.instancePath.startsWith("/source_refs"),
    )
      ? evidenceError(message)
      : structureError(message);
  }
}

function definitionFor(path: string) {
  const definition = personalWikiNodeTypeForPath(path);
  if (!definition)
    throw structureError("Wiki page schema: unregistered node directory");
  if (
    definition.id === "session" &&
    !/^sessions\/\d{4}-\d{2}-\d{2}\/[^/]+\.md$/u.test(path)
  ) {
    throw structureError(
      "Wiki page schema: Session requires sessions/YYYY-MM-DD/<session-id>.md",
    );
  }
  return definition;
}

/**
 * The model selects IDs; only application code creates labels, raw URLs and H2s.
 * `previous` is the page being replaced. Entity sections are reconciled against
 * it by their declared update rule; Session pages ignore it.
 */
export function renderWikiPage(
  path: string,
  payload: unknown,
  references: ReadonlyMap<string, string>,
  previous?: string,
  now = new Date(),
): string {
  const definition = definitionFor(path);
  validate(payload, definition, references);
  if (payload.source_readable === false)
    throw structureError(
      "Wiki page schema: A non-empty frozen Room/Recording source is available. Read its full original text; do not publish an unavailable-transcript placeholder.",
    );
  const tracked = definition.kind === "entity";
  const update = tracked
    ? reconcileEntitySections(
        definition,
        payload,
        previous ? priorPage(previous, references) : undefined,
        now.toISOString().slice(0, 10),
      )
    : undefined;
  const bodies =
    update?.bodies ?? renderRecordSections(definition, payload.sections);
  // An entity page lists the sources the model selected and those its carried
  // text still cites; a source nothing cites any more is dropped.
  const selected = tracked
    ? [
        ...new Set([
          ...payload.source_refs,
          ...Object.values(bodies).flatMap((body) =>
            citedRefs(body).filter((ref) => references.has(ref)),
          ),
        ]),
      ]
    : payload.source_refs;
  const labels = new Map(selected.map((ref, index) => [ref, `R${index + 1}`]));
  const sources = selected.map((ref) => {
    const resource = references.get(ref)!;
    if (!isRawSourceUrl(resource))
      throw evidenceError(
        "Wiki page schema: catalog contains a non-raw resource",
      );
    return { id: labels.get(ref)!, resource };
  });
  const sections = definition.sections.map((heading) => {
    let body = bodies[heading]!;
    assertAuthoredText(body);
    body = body.replace(/\[\[source:([^\]]+)\]\]/gu, (_marker, ref: string) => {
      const label = labels.get(ref);
      if (!label)
        throw evidenceError(
          `Wiki page schema: cited source_ref is not selected: ${ref}`,
        );
      return `[${label}]`;
    });
    if (body.includes("[[source:"))
      throw evidenceError("Wiki page schema: malformed source marker");
    return `## ${heading}\n\n${body.trim()}`;
  });
  const slug = path.split("/").at(-1)!.replace(/\.md$/u, "");
  if (
    definition.id === "session" &&
    (payload.fields.session_id !== slug ||
      path.split("/")[1] !== payload.fields.date)
  ) {
    throw structureError(
      "Wiki page schema: routed date and identity must agree with the target path",
    );
  }
  const markdown = `---\n${JSON.stringify(
    {
      type: definition.id[0]!.toUpperCase() + definition.id.slice(1),
      title: payload.title,
      description: payload.description,
      ...payload.fields,
      status: payload.status ?? "stable",
      sources,
      relations: payload.relations,
      ...(update
        ? {
            items: Object.fromEntries(
              Object.entries(update.items).map(([heading, items]) => [
                heading,
                items.map((item) => item.id),
              ]),
            ),
          }
        : {}),
      generated: { by: "linger-llm-wiki/1", at: now.toISOString() },
    },
    null,
    2,
  )}\n---\n\n# ${payload.title}\n\n${sections.join("\n\n")}\n`;
  validateWikiPageTemplate(path, markdown, references);
  return markdown;
}

/** Review persisted Markdown against the same field/section/reference schema. */
export function validateWikiPageTemplate(
  path: string,
  content: string,
  references: ReadonlyMap<string, string>,
): void {
  const okf = validateOkfFrontmatter(content);
  if (!okf.valid)
    throw structureError(
      `Wiki OKF: ${okf.issues.map((issue) => issue.message).join("; ")}`,
    );
  const definition = definitionFor(path);
  const parsed = parseOkfFrontmatter(content);
  if (!parsed.fields || parsed.issues.length)
    throw structureError("Wiki page schema: invalid frontmatter");
  const fields = parsed.fields;
  if (fields.type !== definition.id[0]!.toUpperCase() + definition.id.slice(1))
    throw structureError(
      "Wiki page schema: type does not match its registered directory",
    );
  const allowedFrontmatterFields = new Set([
    "type",
    "title",
    "description",
    "status",
    ...definition.fields,
    "relations",
    ...(definition.kind === "entity" ? ["items"] : []),
    "graph", // Historical author metadata only; never used for native graph identity/topology.
    "generated",
  ]);
  const unexpectedFields = Object.keys(fields).filter(
    (field) => !allowedFrontmatterFields.has(field),
  );
  if (unexpectedFields.length > 0)
    throw structureError(
      `Wiki page schema: unexpected frontmatter fields: ${unexpectedFields.join(", ")}`,
    );
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
  const sections: Record<string, string> = {};
  const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gmu)];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!;
    if (Object.hasOwn(sections, heading[1]!))
      throw structureError("Wiki page schema: duplicate H2 section");
    sections[heading[1]!] = body
      .slice(
        heading.index + heading[0].length,
        headings[i + 1]?.index ?? body.length,
      )
      .trim();
  }
  if (headings.map((h) => h[1]).join("\n") !== definition.sections.join("\n")) {
    throw structureError(
      `Wiki page schema: required H2 order: ${definition.sections.join("; ")}`,
    );
  }
  const labels = new Set<string>();
  const selected: string[] = [];
  const byResource = new Map(
    [...references].map(([ref, resource]) => [resource, ref]),
  );
  for (const source of Array.isArray(fields.sources) ? fields.sources : []) {
    if (
      !source ||
      typeof source !== "object" ||
      !/^R\d+$/u.test(source.id) ||
      labels.has(source.id)
    ) {
      throw evidenceError(
        "Wiki page schema: invalid or duplicate source label",
      );
    }
    const ref = byResource.get(source.resource);
    if (!ref || !isRawSourceUrl(source.resource))
      throw evidenceError(
        "Wiki page schema: source resource is outside the authorized raw catalog",
      );
    labels.add(source.id);
    selected.push(ref);
  }
  for (const match of body.matchAll(/\[(R\d+)\]/gu)) {
    if (!labels.has(match[1]!))
      throw evidenceError(`Wiki page schema: unbound citation ${match[1]}`);
  }
  if (body.includes("[[source:"))
    throw evidenceError("Wiki page schema: unresolved source marker");
  if (!isRecord(fields.relations))
    throw structureError("Wiki page schema: relations must be an object");
  if (fields.items !== undefined) {
    for (const [heading, ids] of Object.entries(
      trackedItemIds(definition, fields.items),
    )) {
      if (listEntries(sections[heading] ?? "").length !== ids.length)
        throw structureError(
          `Wiki page schema: tracked items do not match the ${heading} entries`,
        );
    }
  }
  validate(
    {
      title: fields.title,
      description: fields.description,
      fields: Object.fromEntries(
        definition.fields
          .filter((f) => f !== "sources")
          .map((f) => [f, fields[f]]),
      ),
      sections,
      source_refs: selected,
      relations: fields.relations,
    },
    definition,
    references,
    true,
  );
  if (definition.id === "session") {
    for (const heading of [
      SESSION_SECTIONS.meetingSummary,
      SESSION_SECTIONS.mainTopics,
    ]) {
      validateSessionTopicCitations(heading, sections[heading]!);
    }
  }
}

/**
 * Apply each entity section's update rule against the page being replaced and
 * write the Change Log from what actually changed. Violations are tool errors
 * the model repairs in the same run.
 */
function reconcileEntitySections(
  definition: Extract<PersonalWikiNodeType, { kind: "entity" }>,
  payload: Page,
  prior: PriorPage | undefined,
  date: string,
): {
  bodies: Record<string, string>;
  items: Record<string, Item[]>;
} {
  const bodies: Record<string, string> = {};
  const items: Record<string, Item[]> = {};
  const changes: string[] = [];
  const removedRefs = new Set<string>();
  // Summary issues of every section come back together, so one retry can fix
  // them all.
  const issues: string[] = [];
  let evidenceIssue = false;
  let nextId =
    1 +
    Math.max(
      0,
      ...Object.values(prior?.items ?? {})
        .flat()
        .map((item) => Number(item.id.slice(1))),
    );
  for (const heading of definition.sections) {
    const rule = definition.sectionRules[heading]!;
    if (rule.update === "summary") {
      const input = payload.sections[heading] as SummaryInput;
      const before = prior?.sections[heading];
      if ("keep" in input) {
        if (before === undefined)
          throw structureError(
            `Wiki page update: ${heading} has no previous text to keep; write {"text": ..., "reason": ...}`,
          );
        bodies[heading] = before;
        continue;
      }
      input.removed_refs?.forEach((ref) => removedRefs.add(ref));
      const cited = citedRefs(input.text);
      for (const ref of new Set(
        cited.filter((ref) => !ref.startsWith("raw:")),
      )) {
        evidenceIssue = true;
        issues.push(
          `${heading} has the malformed citation [[source:${ref}]]; write it as [[source:raw:${ref}]].`,
        );
      }
      // Only a rewrite of existing text can drop citations or enter the
      // Change Log; a new section's reason is not logged.
      if (before !== undefined && squash(before) !== squash(input.text)) {
        const dropped = [...new Set(citedRefs(before))].filter(
          (ref) => !cited.includes(ref) && !input.removed_refs?.includes(ref),
        );
        if (dropped.length) {
          evidenceIssue = true;
          const lost = citedPassages(before).filter((passage) =>
            citedRefs(passage).some((ref) => dropped.includes(ref)),
          );
          issues.push(
            `${heading} no longer has the citation markers ${dropped.join(", ")}. The previous text cited them in:\n${lost.map((passage) => `  "${passage}"`).join("\n")}\nKeep each of these facts in ${heading} with its markers exactly as shown (you may reword it and add new facts beside it), or list the ref in "removed_refs" and say why in "reason".`,
          );
        } else changes.push(`Rewrote ${heading}: ${plain(input.reason)}`);
      }
      const length = writtenLength(input.text);
      if (rule.limit && length > rule.limit)
        issues.push(
          `${heading} has ${length} characters; the limit is ${rule.limit}. Condense it to the durable facts, keeping the citations of the facts you keep.`,
        );
      bodies[heading] = input.text;
    } else if (rule.update === "items") {
      const previous = prior?.items?.[heading] ?? [];
      const known = new Set(previous.map((item) => item.id));
      const operations = new Map<string, ItemInput>();
      const added: Item[] = [];
      const merged = new Map<string, Item>();
      const fits = (text: string) => {
        const length = writtenLength(text);
        if (rule.entryLimit && length > rule.entryLimit)
          throw structureError(
            `Wiki page update: an entry in ${heading} has ${length} characters; the limit is ${rule.entryLimit}. Condense it to its key facts, keeping their citations`,
          );
        return text;
      };
      const claim = (id: string, input: ItemInput) => {
        if (!known.has(id) || operations.has(id))
          throw structureError(
            `Wiki page update: ${heading} item ${id} is unknown or repeated; omit "id" for a new item`,
          );
        operations.set(id, input);
      };
      for (const input of payload.sections[heading] as ItemInput[]) {
        if ("merge" in input) {
          input.merge.forEach((id) => claim(id, input));
          const item = { id: `i${nextId++}`, text: fits(input.text) };
          merged.set(input.merge[0]!, item);
          changes.push(
            `Merged ${input.merge.join(", ")} in ${heading} into ${item.id}: ${plain(item.text)}`,
          );
        } else if (input.id === undefined) {
          added.push({
            id: `i${nextId++}`,
            text: fits((input as { text: string }).text),
          });
        } else {
          claim(input.id, input);
        }
      }
      // Entries the update does not mention stay as they are.
      const result: Item[] = [];
      let mergedAt: Item | undefined;
      for (const item of previous) {
        const input = operations.get(item.id);
        if (!input) {
          result.push(item);
        } else if ("merge" in input) {
          mergedAt = merged.get(item.id) ?? mergedAt;
          if (merged.has(item.id)) result.push(mergedAt!);
        } else if ("retracted" in input) {
          changes.push(
            `Retracted from ${heading}: ${plain(item.text)} (${plain(input.retracted)})`,
          );
        } else {
          const text = "text" in input ? fits(input.text) : item.text;
          if (squash(item.text) !== squash(text))
            changes.push(`Updated in ${heading}: ${plain(text)}`);
          result.push({ id: item.id, text });
        }
      }
      // A dated history lists its newest entries first.
      if (rule.shown === undefined) result.push(...added);
      else result.unshift(...added);
      if (added.length)
        changes.push(
          `Added ${added.length} ${added.length === 1 ? "entry" : "entries"} to ${heading}.`,
        );
      if (rule.limit && result.length > rule.limit)
        throw structureError(
          `Wiki page update: ${heading} would have ${result.length} entries; the limit is ${rule.limit}. Merge the oldest entries into one dated summary with {"merge": ["<id>", ...], "text": "..."} so at most ${rule.limit} remain`,
        );
      items[heading] = result;
      bodies[heading] = result.length
        ? result.map((item) => listItem(item.text)).join("\n")
        : EMPTY_SECTION_TEXT;
    }
  }
  if (issues.length) {
    const message = `Wiki page update: fix every issue below in your draft and resend it in full; keep the rest of the draft as it is.\n${issues.map((issue) => `- ${issue.replaceAll("\n", "\n  ")}`).join("\n")}`;
    throw evidenceIssue ? evidenceError(message) : structureError(message);
  }
  // A page written before tracked sections is restructured in one write; its
  // cited sources must survive, as for a rewritten summary.
  if (prior && !prior.items) {
    const cited = new Set(Object.values(bodies).flatMap(citedRefs));
    const dropped = [
      ...new Set(Object.values(prior.sections).flatMap(citedRefs)),
    ].filter((ref) => !cited.has(ref) && !removedRefs.has(ref));
    if (dropped.length)
      throw evidenceError(
        `Wiki page update: restructuring this page dropped ${dropped.join(", ")}; carry the facts those sources support into the new sections, or list them in a summary section's "removed_refs" and explain why in its "reason"`,
      );
  }
  const log = definition.sections.find(
    (heading) => definition.sectionRules[heading]!.update === "generated",
  );
  if (log) {
    // A first write records creation; a pre-tracking page records adoption of
    // tracked sections instead of re-announcing every item it already had.
    const recorded = !prior
      ? ["Created."]
      : !prior.items
        ? ["Adopted tracked sections."]
        : changes;
    bodies[log] = formatChangeLog(
      prior?.sections[log] ?? "",
      recorded.map((entry) => `- ${date} ${clipLogEntry(entry)}`),
      definition.sectionRules[log]!.limit,
    );
  }
  return { bodies, items };
}

/**
 * Publish one entry per entity and refresh. Intermediate generation batches
 * can each have detailed authoring notes; only the frozen published base and
 * the final accepted candidate determine the entry that survives settlement.
 */
export function finalizeEntityChangeLog(
  path: string,
  candidate: string,
  baseline: string | undefined,
): string {
  const definition = personalWikiNodeTypeForPath(path);
  if (definition?.kind !== "entity" || path.endsWith("/index.md"))
    return candidate;
  const heading = ENTITY_SECTIONS.changeLog;
  const marker = `\n## ${heading}\n`;
  const start = candidate.indexOf(marker);
  if (start < 0 || candidate === baseline) return candidate;

  const fields = parseOkfFrontmatter(candidate).fields ?? {};
  const baseFields = baseline
    ? (parseOkfFrontmatter(baseline).fields ?? {})
    : {};
  const refs = new Map<string, string>();
  const labels = new Map<string, string>();
  for (const page of [baseFields, fields]) {
    for (const source of Array.isArray(page.sources) ? page.sources : []) {
      if (!isRecord(source) || typeof source.resource !== "string") continue;
      const ref = rawSourceReference(source.resource);
      refs.set(ref, source.resource);
      if (page === fields) labels.set(ref, String(source.id));
    }
  }
  const current = priorPage(candidate, refs, fields);
  if (!current) return candidate;
  const prior = baseline ? priorPage(baseline, refs, baseFields) : undefined;
  const notes: string[] = [];
  const details: string[] = [];
  const previousLog = prior?.sections[heading] ?? "";
  // Entries the batches wrote since the published base, newest first.
  const previous = new Set(changeLogEntries(previousLog));
  const authored = changeLogEntries(current.sections[heading] ?? "").filter(
    (entry) => !previous.has(entry),
  );

  if (!prior) {
    notes.push("Created.");
  } else {
    for (const [section, rule] of Object.entries(definition.sectionRules)) {
      if (rule.update === "generated") continue;
      const before = prior.items?.[section];
      const after = current.items?.[section];
      if (
        prior.sections[section] === current.sections[section] &&
        isDeepStrictEqual(before, after)
      )
        continue;

      if (before && after) {
        notes.push(`${section}: ${describeItemChanges(before, after)}`);
      } else {
        notes.push(`Updated ${section}`);
        const prefix = `Rewrote ${section}: `;
        const reason = authored
          .map((line) => line.replace(/^- \d{4}-\d{2}-\d{2} /u, ""))
          .find((line) => line.startsWith(prefix));
        if (reason) details.push(reason.slice(prefix.length));
      }
    }
    const ignored = new Set(["generated", "items", "sources"]);
    const metadata = [
      ...new Set([...Object.keys(baseFields), ...Object.keys(fields)]),
    ].filter(
      (key) =>
        !ignored.has(key) && !isDeepStrictEqual(baseFields[key], fields[key]),
    );
    // The source list follows the text's citations, so a change to it alone
    // is not a change a reader needs in the log.
    if (metadata.length) notes.push(`Updated ${metadata.join(", ")}`);
    if (!notes.length && baseline !== undefined) return baseline;
  }

  // Give every changed section space before optional authoring detail.
  let summary = notes.join(" · ");
  if (summary.length > LOG_ENTRY_LIMIT) {
    summary = notes.map((note) => note.split(":")[0]).join(", ");
    if (summary.length > LOG_ENTRY_LIMIT)
      summary = `Updated ${notes.length} sections or metadata groups.`;
  }
  const settled =
    authored.length === 1
      ? authored[0]!.replace(/^- \d{4}-\d{2}-\d{2} /u, "")
      : "";
  if (
    settled.startsWith(summary + " — ") &&
    settled.length <= LOG_ENTRY_LIMIT
  ) {
    summary = settled;
  } else {
    for (const reason of details) {
      if (summary.length + reason.length + 3 <= LOG_ENTRY_LIMIT)
        summary += ` — ${reason}`;
    }
  }
  const generated = fields.generated;
  const date =
    isRecord(generated) && typeof generated.at === "string"
      ? generated.at.slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  const oldLog = previousLog.replace(
    /\[\[source:([^\]]+)\]\]/gu,
    (_, ref: string) => (labels.has(ref) ? `[${labels.get(ref)}]` : ""),
  );
  const body = formatChangeLog(
    oldLog,
    [`- ${date} ${summary}`],
    definition.sectionRules[heading]!.limit,
  );
  const bodyStart = start + marker.length;
  const nextHeading = candidate.indexOf("\n## ", bodyStart);
  return (
    candidate.slice(0, bodyStart) +
    "\n" +
    body +
    "\n" +
    (nextHeading < 0 ? "" : candidate.slice(nextHeading))
  );
}

function describeItemChanges(
  before: readonly Item[],
  after: readonly Item[],
): string {
  const oldItems = new Map(before.map((item) => [item.id, item.text]));
  const newIds = new Set(after.map((item) => item.id));
  const added = after.filter((item) => !oldItems.has(item.id)).length;
  const edited = after.filter(
    (item) => oldItems.has(item.id) && oldItems.get(item.id) !== item.text,
  ).length;
  const removed = before.filter((item) => !newIds.has(item.id)).length;
  return (
    [
      added && `${added} added`,
      edited && `${edited} updated`,
      removed && `${removed} removed`,
    ]
      .filter(Boolean)
      .join(", ") || "reordered"
  );
}

/** Newest entries first; entries beyond the limit are dropped. */
function formatChangeLog(
  previous: string,
  added: string[],
  limit: number | undefined,
): string {
  const all = [...added, ...changeLogEntries(previous)];
  return (limit ? all.slice(0, limit) : all).join("\n") || EMPTY_SECTION_TEXT;
}

/** Characters a citation counts toward a length limit. */
const CITATION_LENGTH = 20;

/** Length against a section limit: the prose plus a fixed cost per citation. */
function writtenLength(text: string): number {
  return (
    text.replace(sourceMarker, "").trim().length +
    citedRefs(text).length * CITATION_LENGTH
  );
}

/** Characters of one generated Change Log entry. */
const LOG_ENTRY_LIMIT = 200;

function clipLogEntry(entry: string): string {
  return entry.length > LOG_ENTRY_LIMIT
    ? `${entry.slice(0, LOG_ENTRY_LIMIT - 1)}…`
    : entry;
}

/** Change Log entries, keeping each entry's continuation lines with it. */
function changeLogEntries(body: string): string[] {
  const entries: string[] = [];
  for (const line of body.trim().split("\n")) {
    if (!line.trim() || line.trim() === EMPTY_SECTION_TEXT) continue;
    else if (/^- /u.test(line) || !entries.length) entries.push(line);
    else entries[entries.length - 1] += `\n${line}`;
  }
  return entries;
}

/** The rendered entries of an items section, in order. */
function listEntries(body: string): string[] {
  if (body.trim() === EMPTY_SECTION_TEXT) return [];
  const entries: string[] = [];
  for (const line of body.split("\n")) {
    if (/^- /u.test(line)) entries.push(line.slice(2));
    else if (entries.length)
      entries[entries.length - 1] += `\n${line.replace(/^ {2}/u, "")}`;
  }
  return entries.map((entry) => entry.trimEnd());
}

/** Read the replaced page, mapping its R-labels back to catalog refs. */
function priorPage(
  content: string,
  references: ReadonlyMap<string, string>,
  fields = parseOkfFrontmatter(content).fields,
): PriorPage | undefined {
  if (!fields) return undefined;
  const byResource = new Map(
    [...references].map(([ref, resource]) => [resource, ref]),
  );
  const refByLabel = new Map<string, string>();
  for (const source of Array.isArray(fields.sources) ? fields.sources : []) {
    const ref = isRecord(source)
      ? byResource.get(String(source.resource))
      : undefined;
    if (ref) refByLabel.set(String(source.id), ref);
  }
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
  const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gmu)];
  const sections: Record<string, string> = {};
  headings.forEach((heading, index) => {
    sections[heading[1]!] = body
      .slice(
        heading.index + heading[0].length,
        headings[index + 1]?.index ?? body.length,
      )
      .trim()
      // A source missing from this run's catalog can no longer be cited.
      .replace(/ ?\[(R\d+)\]/gu, (label, id: string) => {
        const ref = refByLabel.get(id);
        return ref
          ? `${label.startsWith(" ") ? " " : ""}[[source:${ref}]]`
          : "";
      });
  });
  return {
    sections,
    items: priorItems(fields.items, sections),
    refs: [...new Set(refByLabel.values())],
  };
}

/** Oldest entries a writer also sees when an update may have to merge them. */
const MERGE_SHOWN = 3;

/**
 * A published page as a writer sees it. The application rebuilds the source
 * list, item IDs and Change Log when it renders the update, so they are left
 * out; citations show the raw refs a writer cites with, item entries their
 * IDs, and a history section only its newest entries, plus the oldest ones
 * when adding a few could exceed the section's limit.
 */
export function wikiPageForModel(
  path: string,
  content: string,
  references: ReadonlyMap<string, string>,
): string {
  const prior = priorPage(content, references);
  if (!prior) return content;
  const definition = definitionFor(path);
  const fields = { ...parseOkfFrontmatter(content).fields };
  for (const key of ["sources", "items", "generated"]) delete fields[key];
  const sections = Object.entries(prior.sections).flatMap(([heading, body]) => {
    const rule =
      definition.kind === "entity"
        ? definition.sectionRules[heading]
        : undefined;
    if (rule?.update === "generated") return [];
    const entries = prior.items?.[heading];
    if (rule?.update !== "items" || !entries?.length)
      return [`## ${heading}\n\n${body}`];
    const label = (item: Item) => listItem(`[${item.id}] ${item.text}`);
    const recent = rule.shown ?? entries.length;
    const oldest =
      rule.limit && entries.length + MERGE_SHOWN > rule.limit ? MERGE_SHOWN : 0;
    if (entries.length <= oldest + recent)
      return [`## ${heading}\n\n${entries.map(label).join("\n")}`];
    const hidden = entries.length - oldest - recent;
    const note = `(${hidden} ${rule.shown === undefined ? "earlier" : "older"} ${hidden === 1 ? "entry is" : "entries are"} not shown and stay unchanged.)`;
    // A history lists its newest entries first and its oldest last.
    return [
      `## ${heading}\n\n${(rule.shown === undefined
        ? [
            ...entries.slice(0, oldest).map(label),
            note,
            ...entries.slice(-recent).map(label),
          ]
        : [
            ...entries.slice(0, recent).map(label),
            note,
            ...entries.slice(entries.length - oldest).map(label),
          ]
      ).join("\n")}`,
    ];
  });
  return `---\n${JSON.stringify(fields, null, 2)}\n---\n\n# ${typeof fields.title === "string" ? fields.title : ""}\n\n${sections.join("\n\n")}\n`;
}

/**
 * Pair the frontmatter IDs with the section entries. A page whose entries no
 * longer match its IDs is treated as untracked, like a page from before them.
 */
function priorItems(
  value: unknown,
  sections: Record<string, string>,
): Record<string, Item[]> | undefined {
  if (value === undefined) return undefined;
  try {
    const items: Record<string, Item[]> = {};
    for (const [heading, ids] of Object.entries(
      trackedItemIds(undefined, value),
    )) {
      const entries = listEntries(sections[heading] ?? "");
      if (entries.length !== ids.length) return undefined;
      items[heading] = ids.map((id, index) => ({ id, text: entries[index]! }));
    }
    return items;
  } catch {
    return undefined;
  }
}

function trackedItemIds(
  definition: PersonalWikiNodeType | undefined,
  value: unknown,
): Record<string, string[]> {
  const invalid = () =>
    structureError("Wiki page schema: invalid tracked items");
  if (!isRecord(value)) throw invalid();
  const seen = new Set<string>();
  for (const [heading, ids] of Object.entries(value)) {
    if (
      (definition &&
        personalWikiSectionUpdate(definition, heading) !== "items") ||
      !Array.isArray(ids)
    )
      throw invalid();
    for (const id of ids) {
      if (typeof id !== "string" || !/^i[1-9]\d*$/u.test(id) || seen.has(id))
        throw invalid();
      seen.add(id);
    }
  }
  return value as Record<string, string[]>;
}

/**
 * Section strings cite sources only through `[[source:…]]` markers; the
 * application writes the H2s, R-labels and raw URLs.
 */
function assertAuthoredText(value: string): void {
  if (/^##\s|\[(R\d+)\]|teamhub:\/\//mu.test(value)) {
    throw evidenceError(
      "Wiki page schema: section content must not author H2 headings, R-labels or raw URLs; use [[source:raw:S1]]",
    );
  }
}

/** Render each record section from its authoring shape. */
function renderRecordSections(
  definition: PersonalWikiNodeType,
  sections: Page["sections"],
): Record<string, string> {
  const line = (value: string) => {
    assertAuthoredText(value);
    return squash(value);
  };
  const bodies: Record<string, string> = {};
  for (const heading of definition.sections) {
    const value = sections[heading] as SessionInput;
    let body: string;
    switch (personalWikiSectionFormat(definition, heading)) {
      case "list":
        body = (value as string[]).map((item) => `- ${line(item)}`).join("\n");
        break;
      case "outcomes":
        body = (value as OutcomeInput[])
          .map(
            (item) =>
              `- ${SESSION_ITEM_LABELS[item.kind]}: ${line(item.text)}\n  - ${SESSION_ITEM_LABELS.evidence}: ${line(item.evidence)}`,
          )
          .join("\n");
        break;
      case "actions":
        body = (value as ActionInput[])
          .map((item) =>
            [
              `- ${SESSION_ITEM_LABELS.action}: ${line(item.text)}`,
              ...(["owner", "deadline", "resources", "priority"] as const)
                .filter((field) => item[field] !== undefined)
                .map(
                  (field) =>
                    `  - ${SESSION_ITEM_LABELS[field]}: ${line(item[field]!)}`,
                ),
              `  - ${SESSION_ITEM_LABELS.evidence}: ${line(item.evidence)}`,
            ].join("\n"),
          )
          .join("\n");
        break;
      default:
        body = normalizeSessionLineBreaks((value as string).trim());
    }
    bodies[heading] = body.trim() ? body : EMPTY_SECTION_TEXT;
  }
  return bodies;
}

function citedRefs(body: string): string[] {
  return [...body.matchAll(sourceMarker)].map((match) => match[1]!);
}

/** The passages of a text, each ending with the run of citations it carries. */
function citedPassages(body: string): string[] {
  const passages: string[] = [];
  let start = 0;
  for (const run of body.matchAll(/(?:\[\[source:[^\]]+\]\]\s*)+/gu)) {
    const end = run.index + run[0].length;
    passages.push(body.slice(start, end).trim());
    start = end;
  }
  return passages;
}

function listItem(text: string): string {
  return text
    .trim()
    .replace(/^[-*]\s+/u, "")
    .split("\n")
    .map((line, index) => (index === 0 ? `- ${line}` : line && `  ${line}`))
    .join("\n");
}

/** One line of item text for the Change Log, without citations. */
function plain(value: string): string {
  return squash(value.replace(sourceMarker, "").replace(/^[-*]\s+/u, ""));
}

function squash(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

// Some structured responses double-escape every Markdown line break. Normalize
// only an unambiguous single-line layout; code and mixed layouts stay untouched.
function normalizeSessionLineBreaks(body: string): string {
  if (
    /[\r\n]/u.test(body) ||
    /`{2}|~{3}/u.test(body) ||
    !/^(?:#{1,6}|[-*])[\t ]/u.test(body) ||
    !/\\n(?:\\n| {0,3}(?:#{1,6}|[-*])[\t ])/u.test(body)
  ) {
    return body;
  }
  const parts = body.split(/(`[^`]*`)/u);
  if (parts.some((part, index) => index % 2 === 0 && part.includes("`")))
    return body;
  return parts
    .map((part, index) => (index % 2 ? part : part.replaceAll("\\n", "\n")))
    .join("");
}

function validateSessionTopicCitations(heading: string, body: string): void {
  if (body.trim() === EMPTY_SECTION_TEXT) return;
  // A quoted code example is not a citation, nor a new narrative topic.
  let fence: string | undefined;
  const prose = body
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split(/\r?\n/u)
    .filter((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length)
          fence = undefined;
        return false;
      }
      return !fence;
    })
    .join("\n")
    .replace(/(`+)[\s\S]*?\1/gu, "");
  if (/\\n(?:\\n|#{1,6}[\t ]|[-*][\t ])/u.test(prose)) {
    throw structureError(
      `Wiki page format: escaped Markdown line breaks in ${heading}. Encode real line breaks in the JSON string, not literal backslash-n text. Change only newline escaping; copy every other heading, paragraph, list item, value and citation verbatim from your previous page. Do not summarize, merge or rewrite the content.`,
    );
  }
  const blocks = prose
    .split(/(?=^ {0,3}###[\t ]+\S)/mu)
    .filter((s) => s.trim());
  const missing = blocks.flatMap((block, index) =>
    /\[R\d+\]/u.test(block.replace(/^ {0,3}###[\t ]+[^\n]*(?:\n|$)/u, ""))
      ? []
      : [index + 1],
  );
  if (!blocks.length || missing.length) {
    throw evidenceError(
      `Wiki page evidence: missing citation in ${heading} topic(s) ${missing.join(", ") || "1"}. Add a supported selected-source citation inside each missing topic, even for a single-source Session. Copy all other page text verbatim; do not summarize, merge or rewrite it, and do not invent references.`,
    );
  }
}
