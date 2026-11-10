import { z } from "zod";
import { teamHubIdSchema } from "../message-segments.js";

export const createTeamMdInputSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(65_536)
      .describe(
        "Complete team.md Markdown: a collaborate_pattern frontmatter block followed by the Task Goal, Orchestrator, and Team Member sections. TeamHub stores it verbatim.",
      ),
  })
  .strict()
  .describe("One complete teamMD collaboration protocol document.");

export const createTeamMdOutputSchema = z
  .object({
    created: z
      .literal(true)
      .describe("Whether TeamHub accepted and persisted the team.md."),
    room_id: teamHubIdSchema.describe("Room that now owns this team.md."),
    revision: z
      .number()
      .int()
      .min(1)
      .describe("Revision of this Room's team.md after the write."),
    notified_actor_ids: z
      .array(teamHubIdSchema)
      .max(51)
      .describe(
        "Declared participants TeamHub notified, including the Orchestrator when it is another Agent. The publishing Agent is excluded.",
      ),
  })
  .strict()
  .describe("The persisted team.md and the Team Members it woke.");
export const createTeamMdSchema = {
  input: createTeamMdInputSchema,
  output: createTeamMdOutputSchema,
};
