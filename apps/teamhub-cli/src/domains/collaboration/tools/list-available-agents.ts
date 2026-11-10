import { z } from "zod";
import { teamHubIdSchema } from "../message-segments.js";

export const availableAgentSchema = z
  .object({
    actor_id: teamHubIdSchema.describe(
      "Exact Agent Actor ID accepted by create_room.",
    ),
    name: z.string().min(1).max(120).describe("Current Agent display name."),
    description: z
      .string()
      .max(1_000)
      .describe("Current Human-facing description of the Agent's capability."),
  })
  .strict()
  .describe("One active General Agent of the current Human sponsor.");

export const listAvailableAgentsInputSchema = z
  .object({
    cursor: teamHubIdSchema
      .optional()
      .describe("Continuation cursor returned by the preceding page."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("Maximum number of Agents to return."),
  })
  .strict()
  .describe("Pagination for Sponsor-authorized Agent discovery.");

export const listAvailableAgentsOutputSchema = z
  .object({
    agents: z
      .array(availableAgentSchema)
      .max(100)
      .describe("Sponsor-authorized active General Agents in this page."),
    next_cursor: teamHubIdSchema
      .optional()
      .describe("Continuation cursor when more Agents remain."),
  })
  .strict()
  .describe("Active General Agents of the current Human sponsor.");
export const listAvailableAgentsSchema = {
  input: listAvailableAgentsInputSchema,
  output: listAvailableAgentsOutputSchema,
};
