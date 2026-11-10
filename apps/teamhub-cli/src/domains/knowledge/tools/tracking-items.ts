import { z } from "zod";

const fields = {
  kind: z
    .enum(["todo", "question", "meeting"])
    .describe("Action, unresolved question, or scheduled plan."),
  content: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("One matter to follow up."),
  due_at: z
    .union([
      z
        .string()
        .datetime({ offset: true })
        .describe("Exact time with timezone offset."),
      z.null().describe("No explicit time."),
    ])
    .describe(
      "Only an explicit deadline or meeting time; never invent a time for a vague period.",
    ),
  due_text: z
    .union([
      z.string().min(1).max(500).describe("Original time expression."),
      z.null().describe("No vague period."),
    ])
    .describe(
      "Original vague period, interpreted using source_date and source_timezone.",
    ),
  source_ref: z
    .string()
    .min(1)
    .max(2048)
    .describe("Authorized message, event or raw Session evidence reference."),
  source_date: z.iso.date().describe("Date of the source evidence."),
  source_timezone: z.string().min(1).describe("IANA timezone of the source."),
};
const version = {
  id: z
    .string()
    .regex(/^ti_[a-f0-9]{32}$/u)
    .describe("Stable Tracking Item ID."),
  expected_revision: z
    .number()
    .int()
    .positive()
    .describe("Revision read before editing; conflicts require rereading."),
};
export const trackingItemSchema = z
  .object({
    ...fields,
    id: version.id,
    status: z.enum(["open", "done"]).describe("Current follow-up state."),
    created_at: z
      .string()
      .datetime({ offset: true })
      .describe("Original creation time, unchanged by edits."),
    updated_at: z
      .string()
      .datetime({ offset: true })
      .describe("Last edit time."),
    revision: z
      .number()
      .int()
      .positive()
      .describe("Current concurrency version."),
    routines: z
      .array(
        z
          .object({
            routine_id: z.string().describe("Associated Routine ID."),
            purpose: z.string().describe("What this Routine checks."),
          })
          .strict()
          .describe("One associated Routine."),
      )
      .describe("Current Routines for this matter."),
  })
  .strict()
  .describe("One owner follow-up fact.");
export const listTrackingItemsInputSchema = z
  .object({
    cursor: z
      .string()
      .optional()
      .describe("Exact next_cursor from the previous page."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Page size; does not limit the total collection."),
    include_closed: z
      .boolean()
      .optional()
      .describe("Include done or expired items for reconciliation."),
  })
  .strict()
  .describe("List current owner items by stable ID.");
export const listTrackingItemsOutputSchema = z
  .object({
    items: z.array(trackingItemSchema).describe("Items in this page."),
    next_cursor: z
      .string()
      .describe("Cursor for the next page, empty at the end."),
  })
  .strict()
  .describe("A page of owner items.");
export const listTrackingItemsSchema = {
  input: listTrackingItemsInputSchema,
  output: listTrackingItemsOutputSchema,
};
export const addTrackingItemSchema = {
  input: z
    .object({
      ...fields,
      idempotency_key: z
        .string()
        .min(1)
        .max(200)
        .describe("Stable key for this new matter; retain across retries."),
    })
    .strict()
    .describe("Create or update one owner follow-up."),
  output: trackingItemSchema,
};
export const updateTrackingItemSchema = {
  input: z
    .object({
      ...fields,
      ...version,
      status: z.enum(["open", "done"]).describe("Current follow-up state."),
    })
    .strict()
    .describe("Create or update one owner follow-up."),
  output: trackingItemSchema,
};
export const completeTrackingItemSchema = {
  input: z
    .object(version)
    .strict()
    .describe("Complete one item at its observed revision."),
  output: trackingItemSchema,
};
