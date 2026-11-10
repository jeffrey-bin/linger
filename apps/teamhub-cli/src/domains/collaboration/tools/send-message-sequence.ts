import { z } from "zod";
import { roomIdSchema, teamHubIdSchema } from "../message-segments.js";

const sequenceItemSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(50_000)
      .refine((value) => value.trim() !== "", "Message must not be blank.")
      .describe("One non-blank user-visible message bubble."),
    pause_before: z
      .enum(["none", "brief", "natural"])
      .describe("Delay tier before this bubble: none, brief, or natural."),
  })
  .strict()
  .describe("One ordered message bubble and its presentation delay.");

export const sendMessageSequenceInputSchema = z
  .object({
    source_message_id: teamHubIdSchema
      .optional()
      .describe(
        "Optional visible message in the destination Room that this response answers. Omit when the input has no unique source.",
      ),
    inbox_id: roomIdSchema.describe(
      "Current Room that will receive the message sequence.",
    ),
    messages: z
      .array(sequenceItemSchema)
      .min(2)
      .max(8)
      .describe(
        "Ordered conversational bubbles. The first bubble must use pause_before none.",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.messages[0]?.pause_before !== "none") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The first message must use pause_before none.",
        path: ["messages", 0, "pause_before"],
      });
    }
  })
  .describe("A Room target and ordered conversational message bubbles.");

export const sendMessageSequenceOutputSchema = z
  .object({
    duplicate_request: z
      .boolean()
      .optional()
      .describe("Server-confirmed replay status when available."),
    reason: z
      .string()
      .min(1)
      .optional()
      .describe("Public explanation of a committed replay."),
    accepted: z
      .literal(true)
      .describe("Whether TeamHub accepted the sequence."),
    inbox_id: roomIdSchema.describe("Room receiving the message bubbles."),
    sequence_id: teamHubIdSchema.describe(
      "Stable queued presentation sequence identifier.",
    ),
  })
  .strict()
  .describe("The accepted sequence and its Room target.");
export const sendMessageSequenceSchema = {
  input: sendMessageSequenceInputSchema,
  output: sendMessageSequenceOutputSchema,
};
