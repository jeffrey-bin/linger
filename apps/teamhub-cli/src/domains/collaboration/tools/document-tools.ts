import { z } from "zod";
import { teamHubIdSchema } from "../message-segments.js";

export const createDocumentInputSchema = z
  .object({
    title: z.string().min(1).max(255).describe("Document title."),
    markdown: z
      .string()
      .max(1_048_576)
      .describe(
        "Small text-only Markdown body (at most 1 MiB UTF-8). Do not put Base64 or image bytes in this argument.",
      ),
  })
  .strict()
  .describe("Create one native Document in the configured Room or Task.");

export const createDocumentOutputSchema = z
  .object({
    document_id: teamHubIdSchema.describe("Stable Document identifier."),
    revision_id: teamHubIdSchema.describe(
      "Initial immutable Revision identifier.",
    ),
    status: z.literal("created").describe("Document creation completed."),
    replayed: z
      .boolean()
      .describe("Whether TeamHub replayed the same invocation."),
  })
  .strict()
  .describe("Canonical durable Document creation result.");

export const applyDocumentSemanticMutationOutputSchema = z
  .object({
    semantic_mutation_id: teamHubIdSchema.describe(
      "Stable mutation identifier.",
    ),
    status: z
      .enum(["applied", "conflicted"])
      .describe("Canonical mutation outcome."),
    replayed: z.boolean().describe("Whether TeamHub replayed the invocation."),
    revision_id: teamHubIdSchema
      .describe("Created immutable Revision identifier for applied output.")
      .optional(),
    history_entry_id: teamHubIdSchema
      .describe("Created History entry identifier for applied output.")
      .optional(),
    conflict_reason: z
      .string()
      .min(1)
      .max(255)
      .describe("Stable conflict reason for conflicted output.")
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const appliedShape =
      value.status === "applied" &&
      value.revision_id !== undefined &&
      value.history_entry_id !== undefined &&
      value.conflict_reason === undefined;
    const conflictedShape =
      value.status === "conflicted" &&
      value.revision_id === undefined &&
      value.history_entry_id === undefined &&
      value.conflict_reason !== undefined;
    if (!appliedShape && !conflictedShape) {
      context.addIssue({
        code: "custom",
        message: "Semantic mutation result fields do not match its status.",
      });
    }
  })
  .describe("Canonical durable semantic mutation result.");
export const createDocumentSchema = {
  input: createDocumentInputSchema,
  output: createDocumentOutputSchema,
};

const nativeEditIdSchema = teamHubIdSchema.refine(
  (value) => value !== "0",
  "Use a real block ID.",
);
const documentEditBodySchema = z
  .string()
  .min(1)
  .max(262144)
  .refine(
    (value) => value.trim().length > 0,
    "Markdown must contain nonempty blocks.",
  );
const rangeFields = {
  block_id: nativeEditIdSchema.optional(),
  start_block_id: nativeEditIdSchema.optional(),
  end_block_id: nativeEditIdSchema.optional(),
};
export const editDocumentInputSchema = z
  .discriminatedUnion("command", [
    z
      .object({
        document_id: teamHubIdSchema,
        command: z.literal("append"),
        content: documentEditBodySchema,
      })
      .strict(),
    z
      .object({
        document_id: teamHubIdSchema,
        command: z.literal("str_replace"),
        pattern: z
          .string()
          .min(1)
          .max(262144)
          .refine(
            (value) => !/[\r\n]/u.test(value),
            "Pattern must be one line.",
          ),
        content: z
          .string()
          .max(262144)
          .refine(
            (value) => !/[\r\n]/u.test(value),
            "Replacement must be one line.",
          ),
        block_id: nativeEditIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        document_id: teamHubIdSchema,
        command: z.literal("block_insert_before"),
        block_id: nativeEditIdSchema,
        content: documentEditBodySchema,
      })
      .strict(),
    z
      .object({
        document_id: teamHubIdSchema,
        command: z.literal("block_insert_after"),
        block_id: nativeEditIdSchema,
        content: documentEditBodySchema,
      })
      .strict(),
    z
      .object({
        document_id: teamHubIdSchema,
        command: z.literal("block_replace"),
        ...rangeFields,
        content: documentEditBodySchema,
      })
      .strict(),
    z
      .object({
        document_id: teamHubIdSchema,
        command: z.literal("block_delete"),
        ...rangeFields,
      })
      .strict(),
    z
      .object({
        document_id: teamHubIdSchema,
        command: z.literal("set_title"),
        title: z.string().min(1).max(255),
      })
      .strict(),
    ...(["image_insert_after", "image_replace"] as const).map((command) =>
      z
        .object({
          document_id: teamHubIdSchema,
          command: z.literal(command),
          block_id: nativeEditIdSchema,
          asset_id: nativeEditIdSchema,
          caption: z
            .string()
            .max(1000)
            .refine(
              (value) => !/[\r\n]/u.test(value),
              "Caption must be one line.",
            )
            .optional(),
        })
        .strict(),
    ),
  ])
  .superRefine((value, context) => {
    if (
      (value.command === "block_replace" || value.command === "block_delete") &&
      (value.block_id !== undefined
        ? value.start_block_id !== undefined || value.end_block_id !== undefined
        : value.start_block_id === undefined ||
          value.end_block_id === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Provide block_id or both range endpoints.",
      });
    const action = { ...value, document_id: undefined };
    if (
      new TextEncoder().encode(
        JSON.stringify([
          { kind: "edit_document", parser_version: "markdown-v1", ...action },
        ]),
      ).byteLength > 262144
    )
      context.addIssue({
        code: "custom",
        message: "Document edit must encode to at most 262144 bytes.",
      });
  });
