import { z } from "zod";
import { teamHubIdSchema } from "../message-segments.js";

const weekdaySchema = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

const clockSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  .describe("Local 24-hour time as HH:MM, for example 09:00.");

const timezoneSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => {
    try {
      Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Use an IANA timezone such as America/New_York.")
  .describe(
    "IANA timezone for the clock time, such as America/New_York. Use the timezone the user stated.",
  );

const dailyScheduleSchema = z
  .object({
    kind: z.literal("daily").describe("Post once every day."),
    time: clockSchema,
    timezone: timezoneSchema,
  })
  .strict()
  .describe("Post once a day at a local clock time.");

const weeklyScheduleSchema = z
  .object({
    kind: z.literal("weekly").describe("Post on selected weekdays each week."),
    weekdays: z
      .array(weekdaySchema.describe("One selected local weekday."))
      .min(1)
      .max(7)
      .refine(
        (days) => new Set(days).size === days.length,
        "Choose each weekday once.",
      )
      .meta({ uniqueItems: true })
      .describe(
        "Selected local weekdays. Use one Routine for multiple days at the same time, e.g. Monday through Friday.",
      ),
    time: clockSchema,
    timezone: timezoneSchema,
  })
  .strict()
  .describe(
    "Post on one or more selected weekdays at the same local clock time.",
  );

const intervalScheduleSchema = z
  .object({
    kind: z
      .literal("every_n_hours")
      .describe("Repeat a fixed number of hours after the previous post."),
    interval_hours: z
      .number()
      .int()
      .min(1)
      .max(168)
      .describe("How many hours between posts, from 1 to 168."),
  })
  .strict()
  .describe("Repeat every N hours, starting from now.");

const onceScheduleSchema = z
  .object({
    kind: z.literal("once").describe("Post a single time, then stop."),
    run_at: z
      .string()
      .datetime({ offset: true })
      .describe(
        "The future moment to post, RFC 3339 with offset, for example 2026-10-22T14:30:00-04:00.",
      ),
    timezone: timezoneSchema.optional(),
  })
  .strict()
  .describe(
    "Post once at a set time, for example a check before a meeting; the Routine is done afterwards.",
  );

export const routineScheduleSchema = z
  .discriminatedUnion("kind", [
    dailyScheduleSchema,
    weeklyScheduleSchema,
    intervalScheduleSchema,
    onceScheduleSchema,
  ])
  .describe(
    "When the Routine posts. daily and weekly use a clock time and timezone. every_n_hours repeats from now. once posts a single time at run_at.",
  );

const mentionSchema = teamHubIdSchema.describe(
  'Omit to post plain text. Use "self" to wake yourself. Otherwise pass the actor id of an Agent still in this room.',
);

export const routineSchema = z
  .object({
    id: teamHubIdSchema.describe("Stable Routine id."),
    name: z.string().min(1).max(120).describe("Routine name."),
    instruction: z
      .string()
      .min(1)
      .max(50_000)
      .describe("Message posted when the Routine fires."),
    mention_actor_id: mentionSchema.optional(),
    schedule: routineScheduleSchema.optional(),
    listener: z
      .object({
        app: z
          .enum(["gmail", "outlook", "google_calendar", "slack"])
          .describe(
            "Connected app whose new events the Routine hands to proactive judgement.",
          ),
      })
      .strict()
      .optional()
      .describe(
        "Present instead of schedule on an app listener. It can only be paused and enabled, and goes away when the Human revokes your access to the app.",
      ),
    enabled: z.boolean().describe("Whether the Routine will post on schedule."),
    next_run_at: z
      .string()
      .min(1)
      .optional()
      .describe("UTC time of the next scheduled post. Absent while paused."),
    tracking_item_id: z
      .string()
      .optional()
      .describe("Tracking Item this Routine serves, when it serves one."),
  })
  .strict()
  .describe("One Routine in the current room.");

export const createRoutineInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(120)
      .describe("Short name shown in the room Routine list."),
    instruction: z
      .string()
      .min(1)
      .max(50_000)
      .describe("The message posted in this room when the Routine fires."),
    schedule: routineScheduleSchema,
    mention_actor_id: mentionSchema.optional(),
    tracking_item_id: z
      .string()
      .regex(/^ti_[a-f0-9]{32}$/u)
      .optional()
      .describe(
        "Tracking Item of your Human this Routine serves; deleting the item deletes the Routine.",
      ),
    tracking_purpose: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("What this Routine checks or reminds for its Tracking Item."),
  })
  .strict()
  .refine(
    (input) =>
      (input.tracking_item_id === undefined) ===
      (input.tracking_purpose === undefined),
    "tracking_item_id and tracking_purpose go together.",
  )
  .describe("Name, message, schedule, and optional mention for a new Routine.");

export const createRoutineOutputSchema = routineSchema;

const routineIdInputSchema = z
  .object({
    routine_id: teamHubIdSchema.describe(
      "Id of a Routine in this room, from list_routines or create_routine.",
    ),
  })
  .strict()
  .describe("The Routine to change.");

export const listRoutinesInputSchema = z
  .object({})
  .strict()
  .describe("Lists every Routine in the current room. No arguments.");

export const listRoutinesOutputSchema = z
  .object({
    routines: z
      .array(routineSchema)
      .max(50)
      .describe("Every Routine in this room."),
  })
  .strict()
  .describe("The current room's Routines.");

export const pauseRoutineInputSchema = routineIdInputSchema;
export const enableRoutineInputSchema = routineIdInputSchema;
export const runRoutineInputSchema = routineIdInputSchema;
export const deleteRoutineInputSchema = routineIdInputSchema;

export const deleteRoutineOutputSchema = z
  .object({
    deleted: z.literal(true).describe("The Routine was deleted."),
    routine_id: teamHubIdSchema.describe("Id of the deleted Routine."),
  })
  .strict()
  .describe("Deletion receipt.");
export const createRoutineSchema = {
  input: createRoutineInputSchema,
  output: createRoutineOutputSchema,
};

export const listRoutinesSchema = {
  input: listRoutinesInputSchema,
  output: listRoutinesOutputSchema,
};

export const pauseRoutineSchema = {
  input: pauseRoutineInputSchema,
  output: routineSchema,
};

export const enableRoutineSchema = {
  input: enableRoutineInputSchema,
  output: routineSchema,
};

export const runRoutineSchema = {
  input: runRoutineInputSchema,
  output: routineSchema,
};

export const deleteRoutineSchema = {
  input: deleteRoutineInputSchema,
  output: deleteRoutineOutputSchema,
};
