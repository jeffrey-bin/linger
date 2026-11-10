import { useState } from "react";

import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import { isRoomNotice, isTimelineMessage } from "./message-grouping";

/** The timeline's Messages and where the current Actor's next rows group. */
export function useTimelineMessageGroups(
  messages: TeamHubMessage[],
  currentActorId: string | undefined,
) {
  // Messages already in the Room when it opens arrive together as the lane fades
  // in; only Messages newer than the newest of them lift in one by one. Older
  // pages loaded later stay still too, so scrolling back never jumps.
  const [openedAtNewest] = useState(() =>
    messages.reduce(
      (newest, message) =>
        message.created_at > newest ? message.created_at : newest,
      "",
    ),
  );
  const candidateMessages = messages.filter(isTimelineMessage);
  const lastMessage = candidateMessages.at(-1);
  // The current Actor's next rows start a group unless their own Message ends
  // the timeline; a Room notice ends any group.
  const startsOwnGroup =
    !lastMessage ||
    lastMessage.author.id !== currentActorId ||
    isRoomNotice(lastMessage);
  return { candidateMessages, openedAtNewest, startsOwnGroup };
}
