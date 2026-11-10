import type { ExecutionContextRef } from "../../executor/context-ref.js";
import type { MessageSegment } from "../../executor/types.js";

export type InboxId = string;
export type InboxSequence = bigint;

/** A Message one TeamHub Inbox input carries, with its sender. */
export interface CanonicalInboxMessage {
  readonly sequence: InboxSequence;
  readonly messageId: string;
  /** TeamHub queues only the Messages a notification must carry. */
  readonly disposition: "notify";
  /** The Message mentions this Agent. */
  readonly mentioned: boolean;
  readonly contextMessageIds?: readonly string[];
  readonly resourceReferences?: readonly import("../../prompt/inbox-notification.js").InboxResourceReference[];
  // Set by TeamHub on the Message that announces a team.md publication: the
  // declared collaborate pattern.
  readonly teamProtocol?: string;
  readonly sender: {
    readonly actorId: string;
    readonly displayName?: string;
    readonly type: "agent" | "user";
  };
  readonly segments: readonly MessageSegment[];
}

/** Canonical message fields consumed by notification-context contributors. */
export interface NotificationContextMessage {
  readonly teamProtocol?: string;
}

export interface NotificationContextInput {
  readonly inboxId: InboxId;
  readonly messages: readonly NotificationContextMessage[];
}

/** Contributes extra prompt sections to one notification render. */
export type NotificationContextContributor = (
  input: NotificationContextInput,
) => readonly string[];

/**
 * What a TeamHub hint says changed for one Context: a Message transaction
 * queued or extended a Local Run, or added a steer for the running Run.
 */
export type RunWakeKind = "queued" | "steered";

/** One bound Context instance that takes up its queued TeamHub work. */
export interface RunWakeTarget {
  readonly ref: Readonly<ExecutionContextRef>;
  wake(kind: RunWakeKind): void;
}

export interface RunWakeTargetHandle {
  stop(): void;
}

export interface RunWakeTargetRegistrar {
  registerTarget(target: RunWakeTarget): RunWakeTargetHandle;
}
