import { isRecord } from "@linger/service-kit";
import type { RunKind } from "../../model-tasks.js";
import type { ExecutionContextRef } from "./context-ref.js";
import type { Message } from "./types.js";

/** The fields of one queued Inbox Message that say what it is. */
interface QueuedMessageOrigin {
  readonly authorType?: "agent" | "user";
  readonly messageKind?: string;
  readonly firedRoutine?: true;
}

/** Most likely waited on first. */
const byWaiting: readonly RunKind[] = [
  "chat",
  "document",
  "agent_message",
  "task_callback",
  "task",
  "follow_up",
  "routine",
  "proactive",
];

function messageRunKind(origin: QueuedMessageOrigin): RunKind {
  if (origin.messageKind === "agent_runtime")
    return origin.firedRoutine ? "routine" : "proactive";
  if (origin.messageKind === "task_terminal_notice") return "task_callback";
  return origin.authorType === "agent" ? "agent_message" : "chat";
}

function inputRunKinds(message: Message): readonly RunKind[] {
  const notification = (message as unknown as Record<string, unknown>)
    .acceptedNotification;
  // Only a feature's follow-up turn has no Inbox notification in a Meta Context.
  if (!isRecord(notification)) return ["follow_up"];
  if (
    typeof notification.inboxId === "string" &&
    notification.inboxId.startsWith("taskmeta:")
  )
    return ["task_callback"];
  return Array.isArray(notification.messages)
    ? (notification.messages as readonly QueuedMessageOrigin[]).map(
        messageRunKind,
      )
    : ["chat"];
}

/**
 * What queued a Run, for its log; every Run has the same model queue
 * priority. A Run that merges inputs of several kinds takes the one someone
 * is most likely waiting on.
 */
export function runKind(
  ref: ExecutionContextRef | undefined,
  messages: readonly Message[],
): RunKind {
  if (ref?.kind === "document") return "document";
  if (ref?.kind === "alter_ego") return "task";
  return messages
    .flatMap(inputRunKinds)
    .reduce((best, kind) =>
      byWaiting.indexOf(kind) < byWaiting.indexOf(best) ? kind : best,
    );
}
