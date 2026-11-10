import { z } from "zod";
import { roomIdSchema, teamHubIdSchema } from "../message-segments.js";

export const sendDirectMessageInputSchema = z
  .object({
    messages: z
      .array(
        z
          .string()
          .min(1)
          .max(50_000)
          .refine((value) => value.trim() !== "", "Message must not be blank.")
          .describe("One non-empty message body."),
      )
      .min(1)
      .max(100)
      .describe(
        "Ordered private messages to send to the Human sponsor resolved from context.",
      ),
  })
  .strict()
  .describe("Arguments accepted by the send_direct_message tool.");

export const sendDirectMessageOutputSchema = z
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
      .describe("Whether TeamHub accepted and persisted all messages."),
    inbox_id: roomIdSchema.describe(
      "Bare Room identifier of the sponsor direct-message Room.",
    ),
    message_ids: z
      .array(
        teamHubIdSchema.describe(
          "Stable identifier of one created direct message.",
        ),
      )
      .min(1)
      .max(100)
      .describe("Stable identifiers of the created messages, in input order."),
    room_created: z
      .boolean()
      .describe("Whether this call created the sponsor direct-message Room."),
  })
  .strict()
  .describe("Successful result returned by the send_direct_message tool.");
export const sendDirectMessageSchema = {
  input: sendDirectMessageInputSchema,
  output: sendDirectMessageOutputSchema,
};
