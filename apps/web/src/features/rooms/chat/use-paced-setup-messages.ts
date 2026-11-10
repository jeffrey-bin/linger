import { useEffect, useState } from "react";

import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

/** The typing pause before an Agent message, scaled by its length. */
export function pacedMessageDelay(message: TeamHubMessage) {
  if (message.card) return 1200;
  return Math.min(2200, Math.max(900, 600 + message.raw_message.length * 18));
}

export function isProfileSetupCard(message: TeamHubMessage) {
  return (
    message.card?.intent === "decision_requested" &&
    message.card.kind.startsWith("profile_setup_")
  );
}

/**
 * TeamHub posts each Another Me setup step as a burst of Messages in one
 * transaction. This releases the Agent's Messages of such a burst one at a
 * time after a typing pause, so setup reads like the Agent's ordinary replies.
 * Bursts without a setup card, and every Human Message, appear at once.
 */
export function usePacedSetupMessages({
  agentActorId,
  messages,
  paceInitial,
  paused,
}: {
  agentActorId?: string;
  /** The Room's Messages in display order. */
  messages: readonly TeamHubMessage[];
  /** Whether the Messages present on first render are new to the reader. */
  paceInitial: boolean;
  /** Holds the queue, for example while the greeting intro plays. */
  paused: boolean;
}) {
  const [seen, setSeen] = useState<ReadonlySet<string>>(
    () => new Set(paceInitial ? [] : messages.map((message) => message.id)),
  );
  // Older pages load before the newest seen Message; history is never paced.
  let newestSeen = messages.length - 1;
  while (newestSeen >= 0 && !seen.has(messages[newestSeen]!.id)) newestSeen--;
  const unseen = messages.slice(newestSeen + 1);
  const firstHeld = unseen.findIndex(
    (message) => message.author.id === agentActorId,
  );
  // A Human Message after the held ones means the reader has moved on.
  const pacing =
    Boolean(agentActorId) &&
    firstHeld >= 0 &&
    unseen.some(isProfileSetupCard) &&
    unseen
      .slice(firstHeld)
      .every((message) => message.author.id === agentActorId);
  const held = pacing ? unseen.slice(firstHeld) : [];
  const next = held[0];
  // Joined ids keep the effects keyed to the Messages, not to each new array.
  const settledKey = pacing
    ? ""
    : unseen.map((message) => message.id).join("\n");
  const revealKey = next
    ? unseen
        .slice(0, firstHeld + 1)
        .map((message) => message.id)
        .join("\n")
    : "";
  const delay = next ? pacedMessageDelay(next) : 0;

  useEffect(() => {
    if (settledKey) addSeen(setSeen, settledKey);
  }, [settledKey]);

  useEffect(() => {
    if (!revealKey || paused) return;
    const timer = window.setTimeout(() => addSeen(setSeen, revealKey), delay);
    return () => window.clearTimeout(timer);
  }, [delay, paused, revealKey]);

  return {
    heldIds: new Set(held.map((message) => message.id)),
    /** Whether the Agent should look like it is typing its next Message. */
    typing: Boolean(next) && !paused,
  };
}

function addSeen(
  setSeen: (
    update: (current: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void,
  joinedIds: string,
) {
  setSeen((current) => new Set([...current, ...joinedIds.split("\n")]));
}
