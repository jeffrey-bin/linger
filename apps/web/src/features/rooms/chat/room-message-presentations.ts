import {
  presentTeamHubMessageAttachments,
  type TeamHubMessagePresentation,
} from "@/features/teamhub/teamhub-runtime";
import { referencedMessageActors } from "@/features/teamhub/teamhub-message-content";
import type {
  TeamHubActorRef,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

export function resolveRoomMessagePresentations({
  deliveryPresentations,
  mentionOptions,
  messages,
  roomMessagePresentations,
}: {
  deliveryPresentations: Readonly<Record<string, TeamHubMessagePresentation>>;
  mentionOptions: TeamHubActorRef[];
  messages: TeamHubMessage[];
  roomMessagePresentations: Readonly<
    Record<string, TeamHubMessagePresentation>
  >;
}) {
  const presentations = {
    ...deliveryPresentations,
    ...roomMessagePresentations,
  };

  for (const message of messages) {
    const deliveryPresentation = deliveryPresentations[message.id];
    const roomPresentation = roomMessagePresentations[message.id];
    const existing = presentations[message.id];
    const mentions = roomPresentation?.mentions.length
      ? roomPresentation.mentions
      : deliveryPresentation?.mentions.length
        ? deliveryPresentation.mentions
        : referencedMessageActors(message.segments, mentionOptions);
    presentations[message.id] = {
      ...existing,
      attachments: firstPresentedAttachments(
        roomPresentation?.attachments,
        deliveryPresentation?.attachments,
        presentTeamHubMessageAttachments(message),
      ),
      mentions,
    };
  }

  return presentations;
}

function firstPresentedAttachments(
  ...candidates: Array<TeamHubMessagePresentation["attachments"] | undefined>
): TeamHubMessagePresentation["attachments"] {
  for (const candidate of candidates) {
    if (candidate?.length) return [...candidate];
  }
  return [];
}
