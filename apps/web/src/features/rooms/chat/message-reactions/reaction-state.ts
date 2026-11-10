import type {
  TeamHubMessage,
  TeamHubMessageReaction,
  TeamHubMessageReactionId,
} from "@/features/teamhub/teamhub-types";

/**
 * Returns the Message's Reactions with only `actorId`'s Reaction set to
 * `active`. Groups keep first-reacted order; an emptied group disappears and
 * no Reactions at all is `undefined`, matching TeamHub's omitted field.
 */
export function toggleMessageReaction(
  reactions: readonly TeamHubMessageReaction[] | undefined,
  reactionId: TeamHubMessageReactionId,
  actorId: string,
  active: boolean,
): TeamHubMessageReaction[] | undefined {
  const next: TeamHubMessageReaction[] = [];
  let found = false;
  for (const reaction of reactions ?? []) {
    if (reaction.reaction_id !== reactionId) {
      next.push(reaction);
      continue;
    }
    found = true;
    const others = reaction.actor_ids.filter((id) => id !== actorId);
    const actorIds = active ? [...others, actorId] : others;
    if (actorIds.length) next.push({ ...reaction, actor_ids: actorIds });
  }
  if (!found && active)
    next.push({ reaction_id: reactionId, actor_ids: [actorId] });
  return next.length ? next : undefined;
}

export function hasOwnReaction(
  message: Pick<TeamHubMessage, "reactions">,
  reactionId: TeamHubMessageReactionId,
  actorId: string | undefined,
): boolean {
  return Boolean(
    actorId &&
    message.reactions?.some(
      (reaction) =>
        reaction.reaction_id === reactionId &&
        reaction.actor_ids.includes(actorId),
    ),
  );
}

/** Ordinary chat only: system, approval and other card Messages stay closed. */
export function messageSupportsReactions(message: TeamHubMessage): boolean {
  return (
    message.message_kind === "conversation" &&
    message.card === undefined &&
    message.card_context_message_id === undefined
  );
}
