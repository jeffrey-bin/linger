import { z } from "zod";
import { teamHubIdSchema } from "../message-segments.js";

const documentCommentTextSchema = z
  .string()
  .min(1)
  .max(50_000)
  .describe("Non-empty user-visible Document Comment text.");

export const documentCommentSegmentSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("text").describe("Plain text segment discriminator."),
        content: documentCommentTextSchema,
      })
      .strict()
      .describe("Plain text Document Comment segment."),
    z
      .object({
        type: z
          .literal("reference")
          .describe("Actor reference segment discriminator."),
        content: documentCommentTextSchema,
        actor_id: teamHubIdSchema.describe(
          "Stable TeamHub Actor referenced by this segment.",
        ),
      })
      .strict()
      .describe("Document Comment segment referencing a visible Actor."),
  ])
  .describe("One structured Document Comment segment.");

const documentCommentSegmentsSchema = z
  .array(documentCommentSegmentSchema)
  .min(1)
  .max(1_000)
  .describe("Ordered non-empty Document Comment segments.");

const documentCommentSelectionSchema = z
  .object({
    quoted_text: z.string().max(50_000).describe("Attached selected text."),
    context_before: z
      .string()
      .max(50_000)
      .describe("Text immediately before the attached selection."),
    context_after: z
      .string()
      .max(50_000)
      .describe("Text immediately after the attached selection."),
  })
  .strict()
  .describe("Current attached Document Comment selection.");

const documentCommentSchema = z
  .object({
    comment_id: teamHubIdSchema.describe("Stable Document Comment identifier."),
    parent_comment_id: teamHubIdSchema
      .optional()
      .describe("Optional parent Comment within this Thread."),
    author: z
      .object({
        display_name: z
          .string()
          .min(1)
          .max(255)
          .describe("Current display name of the Comment author."),
        kind: z
          .enum(["human", "agent"])
          .describe("Human or Agent author kind."),
      })
      .strict()
      .describe("Visible author of this Document Comment."),
    segments: documentCommentSegmentsSchema,
    created_at: z
      .string()
      .datetime({ offset: true })
      .describe("RFC 3339 creation time of this Comment."),
  })
  .strict()
  .describe("Latest visible version of one non-deleted Comment.");

export const getDocumentCommentThreadInputSchema = z
  .object({
    thread_id: teamHubIdSchema.describe(
      "Document Comment Thread identifier from the current notification.",
    ),
  })
  .strict()
  .describe("Current Document Comment Thread to read.");

export const getDocumentCommentThreadOutputSchema = z
  .object({
    thread_id: teamHubIdSchema.describe(
      "Stable identifier of the current Document Comment Thread.",
    ),
    selection: documentCommentSelectionSchema.describe(
      "Attached selection for this Thread.",
    ),
    comments: z
      .array(documentCommentSchema)
      .max(1_000)
      .describe("Latest visible non-deleted Comments in creation order."),
  })
  .strict()
  .describe("Attached selection and visible Comments for one active Thread.");

export const replyDocumentCommentInputSchema = z
  .object({
    thread_id: teamHubIdSchema.describe(
      "Document Comment Thread identifier from the current notification.",
    ),
    parent_comment_id: teamHubIdSchema
      .optional()
      .describe("Optional Comment being replied to within the Thread."),
    segments: documentCommentSegmentsSchema.describe(
      "Ordered text and Actor-reference segments for the reply.",
    ),
  })
  .strict()
  .describe("Reply content and target within the current Document Thread.");

export const replyDocumentCommentOutputSchema = z
  .object({
    thread_id: teamHubIdSchema.describe("Thread that received the reply."),
    comment_id: teamHubIdSchema.describe("Created Agent Comment identifier."),
    replayed: z.boolean().describe("Whether TeamHub replayed this invocation."),
  })
  .strict()
  .describe("Durably accepted Document Comment reply.");

export const replaceDocumentCommentTextInputSchema = z
  .object({
    thread_id: teamHubIdSchema.describe(
      "Document Comment Thread whose attached selected text will be replaced.",
    ),
    replace_str: z
      .string()
      .min(1)
      .max(50_000)
      .describe("Exact replacement text for the attached selection."),
  })
  .strict()
  .describe("Replacement text for the current Thread selection.");

export const replaceDocumentCommentTextOutputSchema = z
  .object({
    thread_id: teamHubIdSchema.describe("Thread whose selection was replaced."),
    status: z
      .enum(["applied", "conflicted"])
      .describe("Whether the replacement committed or conflicted."),
    replayed: z.boolean().describe("Whether TeamHub replayed this invocation."),
    revision_id: teamHubIdSchema
      .optional()
      .describe("Committed Document Revision when applied."),
    history_entry_id: teamHubIdSchema
      .optional()
      .describe("Committed Document History entry when applied."),
    conflict_reason: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "Stable conflict reason when the selection cannot be replaced.",
      ),
    observation: z
      .string()
      .min(1)
      .max(512)
      .describe("Concise result observation for the Agent."),
  })
  .strict()
  .superRefine((value, context) => {
    const applied =
      value.status === "applied" &&
      value.revision_id !== undefined &&
      value.history_entry_id !== undefined &&
      value.conflict_reason === undefined;
    const conflicted =
      value.status === "conflicted" &&
      value.revision_id === undefined &&
      value.history_entry_id === undefined &&
      value.conflict_reason !== undefined;
    if (!applied && !conflicted) {
      context.addIssue({
        code: "custom",
        message: "Document replacement result fields do not match its status.",
      });
    }
  })
  .describe("Committed Revision result or explicit replacement conflict.");
export const getDocumentCommentThreadSchema = {
  input: getDocumentCommentThreadInputSchema,
  output: getDocumentCommentThreadOutputSchema,
};

export const replyDocumentCommentSchema = {
  input: replyDocumentCommentInputSchema,
  output: replyDocumentCommentOutputSchema,
};

export const replaceDocumentCommentTextSchema = {
  input: replaceDocumentCommentTextInputSchema,
  output: replaceDocumentCommentTextOutputSchema,
};
