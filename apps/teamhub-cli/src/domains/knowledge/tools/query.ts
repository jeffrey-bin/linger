import { PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN } from "@linger/wire-contracts/node-services-internal/client";
import { z } from "zod";

export const personalKnowledgeQueryInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(10_000)
      .refine((value) => value.trim() !== "", "Query must not be blank.")
      .describe(
        "The distinctive phrase, entity, or term being asked about, keeping the current request's named project, person, or event. Do not add unrelated topics from earlier turns. When the question names a time, such as last weekend, in 2023, or last month, keep those words in the query and put the resolved dates in eventFrom/eventTo; leave them unset when the question names no time, even when the request carries a date.",
      ),
    alternates: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("One synonym, translation or related term."),
      )
      .max(6)
      .optional()
      .describe(
        "Up to six synonyms, translations (Chinese and English) or related terms the evidence may use instead of the query's words. Each is searched separately beside the query; always pass some when the query is a single wording.",
      ),
    dateFrom: z.iso
      .date()
      .optional()
      .describe(
        "Optional start of the period the question is about, such as when sources were recorded. It only ranks sources and facts from that period higher and never excludes other dates, so leave it unset unless the question names a period.",
      ),
    dateTo: z.iso
      .date()
      .optional()
      .describe(
        "Optional end of the period the question is about; pair with dateFrom. It only ranks results and never excludes other dates.",
      ),
    eventFrom: z.iso
      .date()
      .optional()
      .describe(
        "Inclusive start of when the asked event happened, such as 2026-04-01 for what the Human did last month. It ranks facts and sources from that period higher and never excludes others; it takes precedence over dateFrom/dateTo. Leave unset when the question does not ask about a time.",
      ),
    eventTo: z.iso
      .date()
      .optional()
      .describe(
        "Inclusive end of when the asked event happened; pair with eventFrom. Never a source-date filter.",
      ),
  })
  .strict()
  .refine(
    ({ dateFrom, dateTo }) =>
      dateFrom === undefined || dateTo === undefined || dateFrom <= dateTo,
    { message: "dateFrom must not be after dateTo.", path: ["dateTo"] },
  )
  .refine(
    ({ eventFrom, eventTo }) =>
      eventFrom === undefined || eventTo === undefined || eventFrom <= eventTo,
    { message: "eventFrom must not be after eventTo.", path: ["eventTo"] },
  )
  .describe(
    "Question for one search over every source of the Human's knowledge: Sessions, recordings, My pages, mail, Pocket Notes, the Profile, the published Wiki and Daily and Weekly reports.",
  );

const evidencePrimitiveSchema = z
  .union([
    z.string().max(512).describe("Metadata text value."),
    z.number().describe("Metadata numeric value."),
    z.boolean().describe("Metadata boolean value."),
    z.null().describe("Metadata null value."),
  ])
  .describe("Primitive evidence metadata value.");

export const evidenceSourceSchema = z
  .object({
    kind: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "Where the source came from: room, recording, my_pages, mail, pocket_note, profile, wiki or period_summary.",
      ),
    ref: z
      .string()
      .min(1)
      .max(1_024)
      .describe("Opaque source reference; not a user-facing label."),
    label: z.string().min(1).max(512).optional().describe("Source label."),
  })
  .strict()
  .describe("Origin of one personal knowledge evidence item.");

export const evidenceIdSchema = z
  .string()
  .regex(PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN)
  .describe(
    "Opaque raw_... candidate ID; pass it unchanged to teamhub knowledge read.",
  );

export const evidenceSectionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_-]*$/u)
  .describe("Stable section identifier within one evidence item.");

export const evidenceDirectoryEntrySchema = z
  .object({
    id: evidenceSectionIdSchema,
    title: z.string().min(1).max(512).describe("Markdown section title."),
    level: z.number().int().min(1).max(6).describe("Markdown heading level."),
    purpose: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("Directory guidance, never evidence content."),
  })
  .strict()
  .describe("One available Markdown section for follow-up evidence reading.");

export const sessionFactSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(1000)
      .describe("The fact: what | When: ... | Involving: ... | why."),
    factType: z
      .enum(["world", "assistant"])
      .describe(
        "assistant marks what the agent did or suggested, not the Human.",
      ),
    entities: z
      .array(z.string().min(1).max(80).describe("Entity name."))
      .max(10)
      .optional()
      .describe("People, places and things the fact names."),
    occurredStart: z.iso.date().optional().describe("When the event began."),
    occurredEnd: z.iso.date().optional().describe("When the event ended."),
    mentionedAt: z
      .string()
      .min(1)
      .max(64)
      .describe("When the source message said it."),
    evidenceId: evidenceIdSchema,
    sectionId: evidenceSectionIdSchema.describe(
      "Source section stating the fact; read it with evidenceId for the original wording.",
    ),
  })
  .strict()
  .describe(
    "A fact extracted from a Room conversation, located in one source section.",
  );

const evidenceItemSchema = z
  .object({
    id: evidenceIdSchema,
    citeAs: z
      .string()
      .regex(/^S[1-9][0-9]*$/u)
      .describe("Citation label assigned for this result."),
    title: z.string().min(1).max(512).describe("Evidence title."),
    excerpt: z
      .string()
      .min(1)
      .max(600)
      .describe("Short preview of the matched original-source chunk."),
    content: z
      .string()
      .max(6000)
      .optional()
      .describe(
        "Bounded matched chunk text for top-ranked candidates; several chunks are joined in document order with an ellipsis. A trailing ellipsis can indicate truncation. If a required fact is missing, read the returned directory section IDs; content presence does not mean the source is complete.",
      ),
    source: evidenceSourceSchema.describe("Evidence origin."),
    representation: z
      .enum(["source_excerpt", "derived_summary", "structured_fact"])
      .describe("Whether the evidence is source text, a summary, or a fact."),
    facet: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Extensible semantic facet."),
    timeHint: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Time associated with this evidence when available."),
    metadata: z
      .record(z.string(), evidencePrimitiveSchema)
      .refine((value) => Object.keys(value).length <= 20, {
        message: "Evidence metadata must contain at most 20 properties.",
      })
      .optional()
      .describe("Small primitive metadata map."),
    directory: z
      .array(evidenceDirectoryEntrySchema)
      .max(64)
      .optional()
      .describe("Available Markdown headings for a follow-up evidence read."),
  })
  .strict()
  .describe("One bounded piece of evidence for the Agent to synthesize.");

const evidenceGapSchema = z
  .object({
    code: z.string().min(1).max(64).describe("Extensible stable gap code."),
    detail: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("Optional safe detail about the evidence gap."),
  })
  .strict()
  .describe("One reason the retrieved evidence does not cover the query.");

export const personalKnowledgeQueryOutputSchema = z
  .object({
    schemaVersion: z.literal(1).describe("Evidence contract version."),
    status: z
      .enum(["grounded", "partial", "empty"])
      .describe(
        "Candidate retrieval status, not the sufficiency of unread bodies.",
      ),
    items: z
      .array(evidenceItemSchema)
      .max(20)
      .describe(
        "Candidates ordered to match their S1...Sn labels; read relevant sections next.",
      ),
    gaps: z
      .array(evidenceGapSchema)
      .max(20)
      .describe(
        "evidence_sections_not_read requires relevant reads before judging that information is missing.",
      ),
    indexedAt: z
      .union([
        z
          .string()
          .datetime({ offset: true })
          .describe("Newest source snapshot time."),
        z.null().describe("No source snapshot is available."),
      ])
      .describe("Time of the newest source snapshot queried, when available."),
    facts: z
      .array(sessionFactSchema)
      .max(30)
      .optional()
      .describe(
        "Matched Session facts, ranked apart from items. They pinpoint details and event times; read the named source section when the answer depends on exact wording.",
      ),
    requestId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Optional query trace identifier."),
  })
  .strict()
  .describe(
    "Candidate routing hints; do not conclude information is insufficient before reading relevant available sections.",
  );
export const queryPersonalKnowledgeSchema = {
  input: personalKnowledgeQueryInputSchema,
  output: personalKnowledgeQueryOutputSchema,
};
