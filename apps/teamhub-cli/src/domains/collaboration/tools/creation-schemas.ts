import { z } from "zod";
import { teamHubIdSchema } from "../message-segments.js";

const MAX_CREATION_TITLE_CODE_POINTS = 120;
const MAX_CREATION_DESCRIPTION_CODE_POINTS = 2_000;
const MAX_CREATION_MEMBERS = 100;
const MAX_CREATION_SEGMENTS = 1_000;
const MAX_CREATION_MESSAGE_CODE_POINTS = 50_000;
const MAX_ROOM_CREATION_ARTIFACTS = 5;
const MAX_TASK_REQUIREMENT_CODE_POINTS = 20_000;

function codePointString(input: {
  readonly description: string;
  readonly max: number;
  readonly nonBlank?: boolean;
  readonly optionalEmpty?: boolean;
}): z.ZodType<string> {
  return z
    .string()
    .refine(
      (value) => input.optionalEmpty === true || [...value].length >= 1,
      "String must contain at least one Unicode character.",
    )
    .refine(
      (value) => input.nonBlank !== true || value.trim().length > 0,
      "String must not be blank.",
    )
    .refine(
      (value) => [...value].length <= input.max,
      `String must contain at most ${input.max} Unicode characters.`,
    )
    .meta({
      description: input.description,
      ...(input.optionalEmpty === true ? {} : { minLength: 1 }),
      maxLength: input.max,
    });
}

const creationSegmentContentSchema = codePointString({
  description: "User-visible text carried by this segment.",
  max: MAX_CREATION_MESSAGE_CODE_POINTS,
});

export const creationTextMessageSegmentSchema = z
  .object({
    type: z
      .literal("text")
      .describe("Discriminator identifying the message segment kind."),
    content: creationSegmentContentSchema,
  })
  .strict()
  .describe(
    'Plain text segment. Include both fields, for example {"type":"text","content":"Start here."}.',
  );

export const creationReferenceMessageSegmentSchema = z
  .object({
    type: z
      .literal("reference")
      .describe("Discriminator identifying the message segment kind."),
    content: creationSegmentContentSchema,
    target: teamHubIdSchema.describe(
      "Stable TeamHub Actor identifier referenced by this segment.",
    ),
    target_type: z
      .enum(["agent", "user"])
      .describe("Declared Actor kind; TeamHub verifies it against the target."),
  })
  .strict()
  .describe(
    'Actor-reference segment. Include type:"reference", content, target, and target_type; for example {"type":"reference","content":"@Analyst","target":"actor_analyst","target_type":"agent"}.',
  );

export const creationMessageSegmentSchema = z
  .discriminatedUnion("type", [
    creationTextMessageSegmentSchema,
    creationReferenceMessageSegmentSchema,
  ])
  .describe("One text or Actor-reference segment of the initial message.");

export const creationMessageSegmentsSchema = z
  .array(creationMessageSegmentSchema)
  .min(1)
  .max(MAX_CREATION_SEGMENTS)
  .refine(
    (segments) =>
      segments.reduce(
        (length, segment) => length + [...segment.content].length,
        0,
      ) <= MAX_CREATION_MESSAGE_CODE_POINTS,
    "Combined initial message content must not exceed 50,000 Unicode characters.",
  )
  .refine(
    (segments) => segments.some((segment) => segment.content.trim().length > 0),
    "Combined initial message content must not be blank.",
  )
  .describe(
    "Ordered initial-message segments. Every item must use the text or reference shape above; do not omit the type discriminator.",
  );

const creationMemberIdsSchema = z
  .array(
    teamHubIdSchema.describe(
      "Stable TeamHub Actor identifier of one proposed member.",
    ),
  )
  .min(1)
  .max(MAX_CREATION_MEMBERS)
  .refine(
    (actorIds) => new Set(actorIds).size === actorIds.length,
    "Actor identifiers must be unique.",
  )
  .meta({
    description: "TeamHub Actors included in the proposed resource.",
    uniqueItems: true,
  });

const roomCreationArtifactsSchema = z
  .array(
    teamHubIdSchema.describe(
      "Stable unified Document identifier delivered with the initial Room message.",
    ),
  )
  .min(1)
  .max(MAX_ROOM_CREATION_ARTIFACTS)
  .refine(
    (documentIds) => new Set(documentIds).size === documentIds.length,
    "Artifact Document identifiers must be unique.",
  )
  .meta({
    description:
      "Existing Documents from the authorized source Room to share after approval.",
    uniqueItems: true,
  });

export const createRoomInputSchema = z
  .object({
    name: codePointString({
      description: "Name of the proposed collaboration Room.",
      max: MAX_CREATION_TITLE_CODE_POINTS,
      nonBlank: true,
    }),
    description: codePointString({
      description: "Optional description of the proposed collaboration Room.",
      max: MAX_CREATION_DESCRIPTION_CODE_POINTS,
      optionalEmpty: true,
    }).optional(),
    member_ids: creationMemberIdsSchema.describe(
      "TeamHub Actors who will join the Room after approval.",
    ),
    artifacts: roomCreationArtifactsSchema
      .optional()
      .describe(
        "Optional existing Documents delivered with the initial message after approval.",
      ),
    initial_message_segments: creationMessageSegmentsSchema.describe(
      "Ordered structured segments of the initial message created after approval.",
    ),
  })
  .strict()
  .describe("Arguments accepted by the create_room tool.");

export const createTaskInputSchema = z
  .object({
    name: codePointString({
      description: "Short Task title shown in Task lists.",
      max: MAX_CREATION_TITLE_CODE_POINTS,
      nonBlank: true,
    }),
    requirement: codePointString({
      description:
        "Self-contained plain-text brief: the work, the Room context it needs, Document IDs or file paths, the completion standard, and what to report.",
      max: MAX_TASK_REQUIREMENT_CODE_POINTS,
      nonBlank: true,
    }),
  })
  .strict()
  .describe(
    "Arguments accepted by create_task. The Task starts at once for your own AlterEgo; no approval is requested.",
  );

const creationApprovalOutputShape = {
  accepted: z
    .literal(true)
    .describe("Whether TeamHub accepted the Creation request."),
  status: z
    .literal("pending_approval")
    .describe("Current state of the Creation request."),
  creation_approval_request_id: teamHubIdSchema.describe(
    "Stable identifier of the Creation approval request.",
  ),
  message_id: teamHubIdSchema.describe(
    "Stable identifier of the Human approval card message.",
  ),
};

export const createRoomOutputSchema = z
  .object(creationApprovalOutputShape)
  .strict()
  .describe("Successful result returned by the create_room tool.");
export type CreateRoomInput = z.output<typeof createRoomInputSchema>;

export const createTaskOutputSchema = z
  .object({
    accepted: z.literal(true).describe("Whether TeamHub created the Task."),
    task_id: teamHubIdSchema.describe(
      "Stable Task identifier used by task check, send and stop.",
    ),
    status: z
      .literal("running")
      .describe("A delegated Task starts running immediately."),
    duplicate_request: z
      .boolean()
      .optional()
      .describe("True only when TeamHub recovered a prior committed call."),
  })
  .strict()
  .describe("Successful result returned by the create_task tool.");
