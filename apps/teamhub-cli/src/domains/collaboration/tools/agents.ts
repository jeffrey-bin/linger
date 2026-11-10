import { z } from "zod";
import { teamHubIdSchema } from "../message-segments.js";

const agentNameSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => value.trim() !== "", "Name must not be blank.");
const agentDescriptionSchema = z.string().max(1_000);
const agentPromptSchema = z
  .string()
  .min(1)
  .max(50_000)
  .refine((value) => value.trim() !== "", "Prompt must not be blank.");

export const getAgentInputSchema = z
  .object({
    actor_id: teamHubIdSchema.describe(
      "Exact Agent Actor ID from teamhub agent list.",
    ),
  })
  .strict()
  .describe("One General Agent of the current Human sponsor to read.");

export const agentProfileSchema = z
  .object({
    actor_id: teamHubIdSchema.describe("Exact Agent Actor ID."),
    name: agentNameSchema.describe("Current Agent display name."),
    description: agentDescriptionSchema.describe(
      "Current Human-facing description of the Agent.",
    ),
    prompt: agentPromptSchema.describe(
      "Complete working instructions of the Agent.",
    ),
  })
  .strict()
  .describe("The current profile of one General Agent.");

export const createAgentInputSchema = z
  .object({
    name: agentNameSchema.describe("Stable role-oriented display name."),
    prompt: agentPromptSchema.describe(
      "Complete standalone working instructions for the new Agent.",
    ),
    description: agentDescriptionSchema
      .optional()
      .describe("Optional Human-facing description of the Agent."),
  })
  .strict()
  .describe(
    "A new General Agent for the current Human sponsor; TeamHub derives its sponsor, Runtime and Room.",
  );

export const updateAgentInputSchema = z
  .object({
    actor_id: teamHubIdSchema
      .optional()
      .describe("Agent Actor ID to change; omit it to change yourself."),
    name: agentNameSchema.optional().describe("New display name."),
    description: agentDescriptionSchema
      .optional()
      .describe("New Human-facing description."),
    prompt: agentPromptSchema
      .optional()
      .describe("New complete working instructions."),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.prompt !== undefined,
    "Provide a name, description or prompt.",
  )
  .describe(
    "Changes to one General Agent of the current Human sponsor; omitted fields are kept.",
  );

export const agentChangeOutputSchema = z
  .object({
    status: z
      .enum(["applied", "confirmation_pending"])
      .describe(
        "applied: TeamHub made the change now. confirmation_pending: it waits for the sponsor's card.",
      ),
    actor_id: teamHubIdSchema
      .optional()
      .describe("The created or changed Agent, when applied."),
    room_id: teamHubIdSchema
      .optional()
      .describe(
        "When applied, the Room a created Agent joined; when pending, the Room holding the card.",
      ),
    message_id: teamHubIdSchema
      .optional()
      .describe("The confirmation card message, when pending."),
    interaction_id: teamHubIdSchema
      .optional()
      .describe("The confirmation interaction, when pending."),
  })
  .strict()
  .describe("Result of creating or changing a General Agent.");

export const getAgentSchema = {
  input: getAgentInputSchema,
  output: agentProfileSchema,
};
export const createAgentSchema = {
  input: createAgentInputSchema,
  output: agentChangeOutputSchema,
};
export const updateAgentSchema = {
  input: updateAgentInputSchema,
  output: agentChangeOutputSchema,
};

export const addRoomMemberSchema = {
  input: z
    .object({
      actor_id: teamHubIdSchema.describe(
        "Exact Agent Actor ID from teamhub agent list.",
      ),
    })
    .strict()
    .describe(
      "One existing Agent to add to the current Room; TeamHub admits it with the Human sponsor's authority.",
    ),
  output: z
    .object({
      room_id: teamHubIdSchema.describe("The Room the Agent is a member of."),
      actor_id: teamHubIdSchema.describe("The added Agent."),
      added: z.boolean().describe("False when the Agent already was a member."),
    })
    .strict()
    .describe("The Agent is a member of the Room."),
};
