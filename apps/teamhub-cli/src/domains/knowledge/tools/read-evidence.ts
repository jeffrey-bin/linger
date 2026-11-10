import { z } from "zod";
import {
  evidenceDirectoryEntrySchema,
  evidenceIdSchema,
  evidenceSectionIdSchema,
  evidenceSourceSchema,
} from "./query.js";

const sectionRequestSchema = z
  .object({
    sectionId: evidenceSectionIdSchema,
    offset: z
      .number()
      .int()
      .min(0)
      .max(200_000)
      .optional()
      .describe("Character offset for continuing a truncated section."),
  })
  .strict()
  .describe("One Markdown section page to read.");

export const personalKnowledgeEvidenceReadInputSchema = z
  .object({
    evidenceId: evidenceIdSchema,
    sectionRequests: z
      .array(sectionRequestSchema)
      .min(1)
      .max(8)
      .refine(
        (value) =>
          new Set(value.map(({ sectionId }) => sectionId)).size ===
          value.length,
        { message: "Section requests must use unique section IDs." },
      )
      .describe("Sections selected from the candidate directory."),
  })
  .strict()
  .describe("Selected evidence sections to read after candidate search.");

const evidenceSectionSchema = z
  .object({
    id: evidenceSectionIdSchema,
    title: z.string().min(1).max(512).describe("Markdown section title."),
    level: z.number().int().min(1).max(6).describe("Markdown heading level."),
    content: z
      .string()
      .max(12_000)
      .describe("Verbatim Markdown content for the requested section page."),
    offset: z
      .number()
      .int()
      .min(0)
      .max(200_000)
      .describe("Character offset of this page."),
    truncated: z
      .boolean()
      .describe("Whether more content remains in this section."),
    nextOffset: z
      .number()
      .int()
      .min(1)
      .max(200_000)
      .optional()
      .describe("Offset for the next page when the section is truncated."),
  })
  .strict()
  .describe("One requested Markdown section page.");

export const personalKnowledgeEvidenceReadOutputSchema = z
  .object({
    schemaVersion: z.literal(1).describe("Evidence read contract version."),
    evidenceId: evidenceIdSchema,
    title: z.string().min(1).max(512).describe("Evidence title."),
    source: evidenceSourceSchema,
    timeHint: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Time associated with this evidence when available."),
    directory: z
      .array(evidenceDirectoryEntrySchema)
      .max(64)
      .describe("Current Markdown section directory."),
    sections: z
      .array(evidenceSectionSchema)
      .max(8)
      .describe("Requested verbatim section pages."),
    missingSections: z
      .array(evidenceSectionIdSchema)
      .max(8)
      .describe("Requested section IDs that are no longer available."),
    complete: z
      .boolean()
      .describe("Whether all requested section pages were returned in full."),
  })
  .strict()
  .describe("Selected source evidence for the Agent to use in its answer.");
export const readPersonalKnowledgeEvidenceSchema = {
  input: personalKnowledgeEvidenceReadInputSchema,
  output: personalKnowledgeEvidenceReadOutputSchema,
};
