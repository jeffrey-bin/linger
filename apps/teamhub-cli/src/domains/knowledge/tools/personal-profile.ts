import { z } from "zod";

const revisionId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u)
  .describe("Personal Profile revision ID.");
const createdAt = z
  .string()
  .datetime({ offset: true })
  .describe("When this revision was created.");

const plainText = (max: number, description: string) =>
  z.string().max(max).describe(description);
const point = z
  .object({
    title: z.string().min(1).max(200).describe("Short point title."),
    text: plainText(4000, "Point paragraph; may be empty when items exist."),
    items: z
      .array(z.string().min(1).max(1000).describe("One single-line fact."))
      .max(20)
      .describe("Bullet facts; may be empty when text exists."),
  })
  .strict()
  .describe("One topical point; needs text or at least one item.");
const moduleShape = {
  overview: plainText(4000, "Module overview paragraph; may be empty."),
  points: z.array(point).max(20).describe("Topical points of the module."),
};
const profileModule = z
  .object(moduleShape)
  .strict()
  .describe("One module; needs an overview or at least one point.");
const timelineEntry = z
  .object({
    period: z
      .string()
      .min(1)
      .max(100)
      .describe(
        "Years only, never months: 2009–2013 when both years are known, 2019 when only the start year is known, –2013 when only the end year is known (also when a role only ended before a later one began), or Present for every ongoing role.",
      ),
    organization: z
      .string()
      .min(1)
      .max(200)
      .describe("School or organization."),
    place: plainText(200, "City; empty string when unknown."),
    role: plainText(200, "Role, degree or program; empty string when unknown."),
    description: plainText(
      1000,
      "One sentence on the work; empty string when unknown.",
    ),
    details: z
      .array(z.string().min(1).max(500).describe("One supported detail."))
      .max(3)
      .describe("Up to three supported details."),
  })
  .strict()
  .describe("One education or work entry.");
export const personalProfileDocumentSchema = z
  .object({
    name: z.string().min(1).max(200).describe("The subject's name."),
    background: z
      .object({
        ...moduleShape,
        timeline: z
          .array(timelineEntry)
          .max(40)
          .describe("Education and work, oldest first."),
      })
      .strict()
      .describe("Background; needs an overview, a point or a timeline entry."),
    communication_style: profileModule,
    working_style: profileModule,
    preferences: profileModule,
    writing_style: profileModule,
  })
  .strict()
  .describe(
    "The complete structured Personal Profile. Text is plain: no line may start with #, and images and scripts are rejected. TeamHub renders the Markdown.",
  );

export const getPersonalProfileSchema = {
  input: z
    .object({})
    .strict()
    .describe("Read the Personal Profile of the Human who owns this Agent."),
  output: z
    .object({
      current: z
        .union([
          z
            .object({
              revision_id: revisionId,
              profile: personalProfileDocumentSchema,
              markdown: z
                .string()
                .describe(
                  "The Markdown TeamHub rendered from profile; edit profile, not this.",
                ),
              source_apps: z
                .array(z.string().describe("Connected app key."))
                .max(20)
                .optional()
                .describe(
                  "App keys recorded as evidence; absent when unknown.",
                ),
              created_at: createdAt,
            })
            .strict()
            .describe("The current revision."),
          z.null().describe("The owner has no Personal Profile yet."),
        ])
        .describe("The owner's current Personal Profile revision."),
    })
    .strict()
    .describe("The owner's current Personal Profile."),
};

export const startPersonalProfileBuildSchema = {
  input: z
    .object({})
    .strict()
    .describe(
      "Tell the owner's Profile page that their Personal Profile is being written.",
    ),
  output: z
    .object({
      building_since: z
        .string()
        .datetime({ offset: true })
        .describe("When the build in progress started."),
    })
    .strict()
    .describe("The build in progress; the next write or 30 minutes ends it."),
};

export const writePersonalProfileSchema = {
  input: z
    .object({
      base_revision_id: revisionId
        .optional()
        .describe(
          "revision_id from show; omit only when show returned current: null.",
        ),
      profile: personalProfileDocumentSchema,
      source_apps: z
        .array(
          z
            .string()
            .regex(/^[a-z0-9][a-z0-9_-]{0,119}$/u)
            .describe("Connected app key."),
        )
        .max(20)
        .optional()
        .describe(
          "All app keys actually used as evidence for the complete Profile; omit when unknown.",
        ),
    })
    .strict()
    .describe(
      "Replace the owner's whole Personal Profile with this complete document.",
    ),
  output: z
    .object({ revision_id: revisionId, created_at: createdAt })
    .strict()
    .describe("The current revision after the write."),
};

const accountFields = {
  name: z.string().min(1).max(120).describe("Display name, up to 120 bytes."),
  bio: z.string().max(2000).describe("Short bio, up to 2000 bytes."),
  organization: z.string().max(200).describe("Organization, up to 200 bytes."),
};

export const getAccountProfileSchema = {
  input: z
    .object({})
    .strict()
    .describe("Read the Account fields of the Human who owns this Agent."),
  output: z
    .object(accountFields)
    .strict()
    .describe("The owner's current Account fields."),
};

export const updateAccountProfileSchema = {
  input: z
    .object({
      name: accountFields.name.optional(),
      bio: accountFields.bio.optional(),
      organization: accountFields.organization.optional(),
    })
    .strict()
    .refine(
      (input) => Object.values(input).some((value) => value !== undefined),
      "Set at least one of name, bio or organization.",
    )
    .describe("Set Account fields of the Human who owns this Agent."),
  output: z
    .object(accountFields)
    .strict()
    .describe("The owner's Account fields after the update."),
};
