import { replaceEqualDeep } from "@tanstack/react-query";
import { useMemo, useRef } from "react";

import {
  presentTeamHubMessageAttachments,
  type TeamHubMessagePresentation,
} from "@/features/teamhub/teamhub-runtime";
import { referencedMessageActors } from "@/features/teamhub/teamhub-message-content";
import type {
  TeamHubActorRef,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

type RoomMessagePresentations = Record<string, TeamHubMessagePresentation>;

interface RoomMessagePresentationInput {
  deliveryPresentations: Readonly<RoomMessagePresentations>;
  mentionOptions: TeamHubActorRef[];
  messages: TeamHubMessage[];
  roomMessagePresentations: Readonly<RoomMessagePresentations>;
}

/**
 * Resolves presentations and keeps every entry whose content did not change
 * from the previous result, so memoized rows skip unrelated Messages.
 */
export function useRoomMessagePresentations({
  deliveryPresentations,
  mentionOptions,
  messages,
  roomMessagePresentations,
}: RoomMessagePresentationInput) {
  const previous = useRef<RoomMessagePresentations | undefined>(undefined);
  return useMemo(() => {
    previous.current = replaceEqualDeep(
      previous.current,
      resolveRoomMessagePresentations({
        deliveryPresentations,
        mentionOptions,
        messages,
        roomMessagePresentations,
      }),
    );
    return previous.current;
  }, [
    deliveryPresentations,
    mentionOptions,
    messages,
    roomMessagePresentations,
  ]);
}

export function resolveRoomMessagePresentations({
  deliveryPresentations,
  mentionOptions,
  messages,
  roomMessagePresentations,
}: RoomMessagePresentationInput): RoomMessagePresentations {
  const presentations = {
    ...deliveryPresentations,
    ...roomMessagePresentations,
  };

  for (const message of messages) {
    const deliveryPresentation = deliveryPresentations[message.id];
    const roomPresentation = roomMessagePresentations[message.id];
    const mentions = roomPresentation?.mentions.length
      ? roomPresentation.mentions
      : deliveryPresentation?.mentions.length
        ? deliveryPresentation.mentions
        : referencedMessageActors(message.segments, mentionOptions);
    presentations[message.id] = {
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
    if (candidate?.length) return candidate;
  }
  return [];
}
