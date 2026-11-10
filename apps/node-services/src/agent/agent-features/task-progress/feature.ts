import { randomUUID } from "node:crypto";
import {
  defineFeature,
  type BoundFeatureContext,
  type FeatureContext,
  type FeatureDeclaration,
} from "../contracts.js";
import type { FeatureTimers, TrackBackground } from "../host-ports.js";
import type { AgentLogger } from "../../observability/agent-log.js";
import type { Message } from "../../executor/types.js";
import type { TaskProgressClient, TaskProgressSnapshot } from "./client.js";
import { renderTaskProgressReminder } from "./prompt.js";

export const TASK_PROGRESS_FEATURE_ID = "task-progress";

const CHECK_TIMER = `${TASK_PROGRESS_FEATURE_ID}.check`;
/** How long the Agent stays silent in its Room before its Meta is reminded. */
const QUIET_MS = 10 * 60_000;
/** A reminder let pass with nothing changed doubles the wait, up to this. */
const MAX_WAIT_MS = 2 * 60 * 60_000;
/** How soon a busy Meta or a failed read is checked again. */
const RETRY_MS = 60_000;

export interface TaskProgressFeatureDeps {
  readonly client: TaskProgressClient;
  readonly timers: FeatureTimers;
  readonly trackBackground: TrackBackground;
  readonly logger: AgentLogger;
  readonly now?: () => number;
}

interface Reminder {
  readonly at: number;
  readonly fingerprint: string;
  readonly waitMs: number;
}

/** What a reminder said about the Tasks; any change resets the wait. */
function fingerprint(snapshot: TaskProgressSnapshot): string {
  return JSON.stringify(
    snapshot.tasks.map((task) => [
      task.task_id,
      task.status,
      task.pending_approvals,
      task.last_report_at ?? null,
      task.latest_step?.title ?? null,
    ]),
  );
}

function reminderMessage(snapshot: TaskProgressSnapshot, now: number): Message {
  const rawMessage = renderTaskProgressReminder(snapshot, now);
  // No source Inbox: the check shows no activity in the Room unless the
  // Meta decides to speak.
  return {
    messageId: `task-progress-${randomUUID()}`,
    rawMessage,
    segments: [{ type: "text", content: rawMessage }],
  };
}

/**
 * Reminds a Meta to tell the user how its long Tasks go. While a Task it
 * coordinates is running or waiting for an approval and its Agent has said
 * nothing in the Room for the quiet period, a trusted follow-up lists those
 * Tasks; the Meta checks and speaks, or stays silent. A reminder let pass
 * with nothing changed doubles the next wait. Nothing is sent while a Live
 * call coordinates the work or the Meta is in a Run, and a Task's idle
 * report still reaches the Meta through its callback. State is per Context
 * instance and in-process only.
 */
export function createTaskProgressFeature(
  deps: TaskProgressFeatureDeps,
): FeatureDeclaration {
  if (
    typeof deps?.client?.read !== "function" ||
    typeof deps.timers?.set !== "function" ||
    typeof deps.trackBackground !== "function" ||
    !deps.logger
  )
    throw new Error(
      "task-progress feature requires client, timers, trackBackground and logger",
    );
  const now = deps.now ?? Date.now;
  return defineFeature({
    id: TASK_PROGRESS_FEATURE_ID,
    match: { contextKinds: ["meta"] },
    context: {
      ports: { onContextBound: {}, onRunTerminal: {}, onTimer: {} },
      create: () => {
        let dueAt: number | undefined;
        let checking = false;
        let reminder: Reminder | undefined;
        const arm = (context: BoundFeatureContext, at: number) => {
          dueAt = at;
          deps.timers.set(context, CHECK_TIMER, at);
        };
        const check = async (context: FeatureContext) => {
          if (context.ref.kind !== "meta") return;
          const { agentId, roomId } = context.ref;
          let snapshot: TaskProgressSnapshot;
          try {
            snapshot = await deps.client.read(roomId, agentId, context.signal);
          } catch (error) {
            if (context.signal.aborted) return;
            deps.logger.log("warn", "task_progress.read_failed", {
              agent_id: agentId,
              room_id: roomId,
              error,
            });
            return arm(context, now() + RETRY_MS);
          }
          const at = now();
          // The Live call tells the user meanwhile; look again afterwards.
          if (snapshot.live_foreground) return arm(context, at + QUIET_MS);
          // Nothing at work: the next Run, which may delegate, arms again.
          if (snapshot.tasks.length === 0) {
            reminder = undefined;
            return;
          }
          const print = fingerprint(snapshot);
          const spokeAt = snapshot.agent_last_spoke_at
            ? Date.parse(snapshot.agent_last_spoke_at)
            : 0;
          const letPass =
            reminder !== undefined &&
            spokeAt <= reminder.at &&
            reminder.fingerprint === print;
          const waitMs = letPass
            ? Math.min(reminder!.waitMs * 2, MAX_WAIT_MS)
            : QUIET_MS;
          const due = Math.max(spokeAt, reminder?.at ?? 0) + waitMs;
          // A longer wait still looks every quiet period, so a change resets it.
          if (at < due) return arm(context, Math.min(due, at + QUIET_MS));
          if (context.activeRunId() !== undefined)
            return arm(context, at + RETRY_MS);
          const submission = await context.followUp(
            reminderMessage(snapshot, at),
            { canSubmit: () => context.activeRunId() === undefined },
          );
          if (submission.status === "skipped") {
            if (!context.signal.aborted) arm(context, now() + RETRY_MS);
            return;
          }
          reminder = { at, fingerprint: print, waitMs };
          deps.logger.log("info", "task_progress.reminded", {
            agent_id: agentId,
            room_id: roomId,
            tasks: snapshot.tasks.length,
            wait_ms: waitMs,
          });
          arm(context, at + QUIET_MS);
        };
        return {
          onContextBound: (bound) => arm(bound, now() + QUIET_MS),
          onRunTerminal: (bound) => {
            if (dueAt === undefined) arm(bound, now() + QUIET_MS);
          },
          onTimer: (context, name) => {
            if (name !== CHECK_TIMER || checking) return;
            dueAt = undefined;
            checking = true;
            deps.trackBackground(
              check(context).finally(() => {
                checking = false;
              }),
              context.ref,
              "task_progress.check_failed",
            );
          },
        };
      },
    },
  });
}
