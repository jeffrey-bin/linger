import type { AcceptedInboxFact } from "../contracts.js";
import type { InboxResourceReference } from "../../prompt/inbox-notification.js";
import type { Message } from "../../executor/types.js";
import type { CanonicalInboxMessage } from "./types.js";
import { isRecord } from "@linger/service-kit";

/**
 * One Message as TeamHub froze it into an Inbox input
 * (`acceptedNotification.messages`). `body` and references are authoritative;
 * `author` is a display name, `authorActorId` and `authorType` the sender.
 */
interface QueuedInboxMessage {
  readonly id: string;
  readonly body: string;
  readonly author?: string;
  readonly authorActorId?: string;
  readonly authorType?: "agent" | "user";
  readonly mentioned?: boolean;
  readonly contextMessageIds?: readonly string[];
  readonly resourceReferences?: readonly InboxResourceReference[];
  readonly teamProtocol?: string;
}

/** How the Shell took up a TeamHub Inbox input. */
export type InboxInputDispatch =
  | { readonly kind: "enqueue"; readonly runId: string }
  | { readonly kind: "steer"; readonly groupId: string };

/**
 * The observation fact of one TeamHub Inbox input the Shell took up: a Run it
 * claimed or a steer it handed to the running Run. Inputs without a frozen
 * notification (trusted turns, feature notices, Document comments) yield none.
 */
export function inboxInputFact(
  message: Message,
  dispatch: InboxInputDispatch,
): AcceptedInboxFact | null {
  const notification = (message as unknown as Record<string, unknown>)
    .acceptedNotification;
  if (!isRecord(notification)) return null;
  const inboxId = notification.inboxId;
  if (typeof inboxId !== "string" || !Array.isArray(notification.messages))
    throw new Error("Queued Inbox input has no canonical notification");
  const sequence = BigInt(
    typeof notification.through === "string" &&
      /^(0|[1-9][0-9]*)$/.test(notification.through)
      ? notification.through
      : "0",
  );
  return {
    inboxId,
    inputId: message.messageId,
    targeted: notification.targeted === true,
    dispatch,
    messages: (notification.messages as readonly unknown[]).map((entry) =>
      factMessage(entry, sequence),
    ),
  };
}

function factMessage(entry: unknown, sequence: bigint): CanonicalInboxMessage {
  if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id)
    throw new Error("Queued Inbox message has no id");
  const queued = entry as unknown as QueuedInboxMessage;
  if (
    typeof queued.body !== "string" ||
    typeof queued.authorActorId !== "string"
  )
    throw new Error("Queued Inbox message has no body or sender");
  const displayName = queued.author?.trim();
  return {
    sequence,
    messageId: queued.id,
    disposition: "notify",
    mentioned: queued.mentioned === true,
    ...(isStringArray(queued.contextMessageIds)
      ? { contextMessageIds: queued.contextMessageIds }
      : {}),
    ...(Array.isArray(queued.resourceReferences)
      ? { resourceReferences: queued.resourceReferences }
      : {}),
    ...(queued.teamProtocol ? { teamProtocol: queued.teamProtocol } : {}),
    sender: {
      actorId: queued.authorActorId,
      ...(displayName ? { displayName } : {}),
      type: queued.authorType === "agent" ? "agent" : "user",
    },
    segments: [{ type: "text", content: queued.body }],
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
