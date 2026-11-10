import { z } from "zod";
import { teamHubIdSchema } from "../message-segments.js";

const MAX_TASK_MESSAGE_CODE_POINTS = 20_000;

const taskId = () =>
  teamHubIdSchema.describe("A Task this Room's Meta delegated.");
const timestamp = (description: string) =>
  z.string().describe(`${description} (RFC 3339).`);
const taskName = () => z.string().describe("Short Task title.");
const taskStatus = () =>
  z
    .enum(["running", "waiting_for_approval", "idle", "failed", "canceled"])
    .describe(
      "None is terminal: task send wakes every state except running, where it queues.",
    );
const reason = () =>
  z
    .string()
    .describe("Why the Task failed (an error code) or was canceled (stopped).");

const taskSummarySchema = z
  .object({
    task_id: taskId(),
    name: taskName(),
    status: taskStatus(),
    reason: reason().optional(),
    created_at: timestamp("When the Task was created"),
    updated_at: timestamp("When the Task last changed"),
  })
  .strict()
  .describe("One Task this Room delegated.");

const taskDetailSchema = z
  .object({
    task_id: taskId(),
    name: taskName(),
    status: taskStatus(),
    reason: reason().optional(),
    origin_room_id: teamHubIdSchema.describe("The Room that delegated it."),
    work_room_id: z
      .string()
      .describe("The Task's execution Room; read-only for Humans."),
    created_at: timestamp("When the Task was created"),
    status_since: timestamp("When the Task entered its current state"),
    recent_activity: z
      .array(
        z
          .object({
            at: timestamp("When it happened"),
            kind: z
              .string()
              .describe(
                "started, message, approval_result, or the state the Task entered.",
              ),
            summary: z.string().describe("Short description."),
          })
          .strict()
          .describe("One state change or input."),
      )
      .max(5)
      .describe("The latest state changes and inputs, newest first."),
    pending_approvals: z
      .array(
        z
          .object({
            kind: z
              .enum(["permission", "connector"])
              .describe("Tool permission or connector write confirmation."),
            id: z.string().describe("The approval card's interaction ID."),
            title: z.string().describe("What the card asks to approve."),
            created_at: timestamp("When the card was posted"),
            expires_at: timestamp("When the card expires").optional(),
          })
          .strict()
          .describe("One approval card in the Room."),
      )
      .describe("Approval cards the AlterEgo is waiting on."),
    last_report: z
      .object({
        at: timestamp("When the report arrived"),
        body: z.string().describe("Report text."),
      })
      .strict()
      .optional()
      .describe("The latest report, truncated to 4000 characters."),
    queued_message_count: z
      .number()
      .int()
      .min(0)
      .describe("Messages waiting behind the running turn."),
  })
  .strict()
  .describe("One Task's current state.");

export const checkTaskSchema = {
  input: z
    .object({ task_id: taskId().optional() })
    .strict()
    .describe(
      "Show one Task, or without task_id list the Tasks this Room delegated.",
    ),
  output: z
    .object({
      task: taskDetailSchema.optional(),
      tasks: z
        .array(taskSummarySchema)
        .max(50)
        .optional()
        .describe("This Room's Tasks, newest first."),
    })
    .strict()
    .describe("One Task's detail, or this Room's Tasks."),
};

export const sendTaskSchema = {
  input: z
    .object({
      task_id: taskId(),
      message: z
        .string()
        .refine((value) => value.trim().length > 0, "String must not be blank.")
        .refine(
          (value) => [...value].length <= MAX_TASK_MESSAGE_CODE_POINTS,
          `String must contain at most ${MAX_TASK_MESSAGE_CODE_POINTS} Unicode characters.`,
        )
        .meta({
          description: "Plain-text instruction for the Task's AlterEgo.",
          minLength: 1,
          maxLength: MAX_TASK_MESSAGE_CODE_POINTS,
        }),
      steer: z
        .boolean()
        .optional()
        .describe(
          "Join the running turn instead of queuing as the next turn when possible.",
        ),
    })
    .strict()
    .describe("Continue, correct, or wake a Task."),
  output: z
    .object({
      accepted: z.literal(true).describe("TeamHub accepted the message."),
      task_id: taskId(),
      status: z.literal("running").describe("The Task is running."),
      delivery: z
        .enum(["started", "queued", "steered"])
        .describe(
          "started woke the Task; queued runs after the current turn; steered was requested into the current turn.",
        ),
      duplicate_request: z
        .boolean()
        .describe("True only when TeamHub recovered a prior committed call."),
    })
    .strict()
    .describe("Task message receipt."),
};

export const stopTaskSchema = {
  input: z
    .object({ task_id: taskId() })
    .strict()
    .describe("Cancel a Task's current turn; its work is kept."),
  output: z
    .object({
      accepted: z.literal(true).describe("TeamHub stopped the Task."),
      task_id: taskId(),
      status: z.literal("canceled").describe("The Task is canceled."),
      duplicate_request: z
        .boolean()
        .describe("True only when TeamHub recovered a prior committed call."),
    })
    .strict()
    .describe("Task stop receipt."),
};
