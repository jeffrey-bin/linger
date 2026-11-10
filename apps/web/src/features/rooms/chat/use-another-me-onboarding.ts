import { useMemo, useState } from "react";

import type {
  TeamHubMessage,
  TeamHubRoom,
} from "@/features/teamhub/teamhub-types";

import { anotherMeIntroStorageKey } from "./another-me-intro";
import type { AgentStreamingTypingAgent } from "./message-timeline";
import {
  isProfileSetupCard,
  usePacedSetupMessages,
} from "./use-paced-setup-messages";
import { orderRoomMessages } from "./use-room-conversation";

/**
 * Another Me's first conversation: a one-time greeting intro, then its setup
 * Messages released one at a time with the same typing status the dock shows
 * for any Agent reply. Setup cards only exist in the Another Me Room, and
 * TeamHub marks its opening read, so a fresh setup is recognised from the
 * Messages: the apps card is pending and the Human has not written yet.
 */
export function useAnotherMeOnboarding<
  Page extends { items: TeamHubMessage[] },
>({
  accountId,
  pages,
  room,
}: {
  accountId: string;
  pages: readonly Page[];
  room: TeamHubRoom;
}) {
  const agent =
    room.kind === "direct" && room.direct_peer?.kind === "agent"
      ? room.direct_peer
      : undefined;
  const ordered = useMemo(() => orderRoomMessages(pages), [pages]);
  const introKey = anotherMeIntroStorageKey(accountId);
  // Decided once on entry; later Messages only feed the pacing below.
  const [fresh] = useState(
    () =>
      Boolean(agent) &&
      ordered.some(
        (message) =>
          isProfileSetupCard(message) &&
          message.card?.intent === "decision_requested" &&
          message.card.kind === "profile_setup_apps" &&
          message.card.status === "pending",
      ) &&
      ordered.every((message) => message.author.id === agent?.id) &&
      !readIntroSeen(introKey),
  );
  const [introPlaying, setIntroPlaying] = useState(fresh);

  const paced = usePacedSetupMessages({
    agentActorId: agent?.id,
    messages: ordered,
    paceInitial: fresh,
    paused: introPlaying,
  });
  const heldKey = [...paced.heldIds].join("\n");
  const visiblePages = useMemo(() => {
    if (!heldKey) return pages;
    const held = new Set(heldKey.split("\n"));
    return pages.map((page) => ({
      ...page,
      items: page.items.filter((message) => !held.has(message.id)),
    }));
  }, [heldKey, pages]);
  // Pacing is local, so the dock shows the Agent as starting without a Run:
  // there is nothing to stop or open.
  const typingAgent = useMemo<AgentStreamingTypingAgent | undefined>(
    () =>
      paced.typing && agent
        ? { display_name: agent.display_name, id: agent.id }
        : undefined,
    [agent, paced.typing],
  );

  return {
    agent,
    // Recorded once watched, so a remount mid-intro plays it again rather
    // than skipping both the intro and the paced setup Messages.
    finishIntro: () => {
      writeIntroSeen(introKey);
      setIntroPlaying(false);
    },
    introPlaying,
    messagesHeld: Boolean(heldKey),
    pages: visiblePages,
    typingAgent,
  };
}

function readIntroSeen(key: string) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeIntroSeen(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Without storage the intro may play again; it never blocks the Room.
  }
}
