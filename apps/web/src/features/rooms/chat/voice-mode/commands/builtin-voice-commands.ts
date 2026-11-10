import type { InfiniteData } from "@tanstack/react-query";
import type {
  TeamHubMessage,
  TeamHubMessagePage,
  TeamHubRoomListItem,
  TeamHubSession,
} from "@/features/teamhub/teamhub-types";
import {
  roomMessagesQueryKey,
  teamHubSessionQueryKey,
  tenantRoomsQueryKey,
} from "../../../room-queries";
import {
  collectVoiceElements,
  type VoiceElementArea,
} from "../voice-ui-bridge";
import type { VoiceCommandContext } from "./voice-command";
/** The Rooms the classifier is offered; the live model may match all of them. */
export function conversations(context: VoiceCommandContext, limit = 40) {
  return (
    context.queryClient?.getQueryData<{ items: TeamHubRoomListItem[] }>(
      tenantRoomsQueryKey(context.tenantId),
    )?.items ?? []
  )
    .filter((room) => room.kind !== "thread")
    .slice(0, limit)
    .map((room) => ({ id: room.id, name: room.name }));
}

/**
 * Rooms one can go to: the Room already open is left out, so a loose word
 * such as "chat" or "room" cannot pick it and "open" nothing visible.
 */
export function otherConversations(context: VoiceCommandContext) {
  const open = /\/t\/[^/]+\/rooms\/([^/]+)/.exec(window.location.pathname)?.[1];
  return conversations(context).filter((room) => room.id !== open);
}

const areaLabels: Record<VoiceElementArea, string> = {
  dialog: "open dialog",
  navigation: "left navigation rail",
  sidebar: "left sidebar",
  main: "main area",
  panel: "right panel",
};

/** Element names carry their area, list and place in it, and state, so
 * "the 7th project" or "the next one" can match. */
export function elementOptions(
  options?: Parameters<typeof collectVoiceElements>[1],
) {
  return collectVoiceElements(120, options).map((element) => {
    const where = [
      areaLabels[element.area],
      element.within ? `in ${element.within}` : undefined,
      element.group ? `${element.group} list` : undefined,
      `item ${element.position} of ${element.size}`,
      element.state,
    ].filter(Boolean);
    return { id: element.id, name: `${element.name} (${where.join(", ")})` };
  });
}

/** The Room on screen, else the Room Voice Mode sends to. */
function roomOnScreen(context: VoiceCommandContext) {
  return (
    /\/t\/[^/]+\/rooms\/([^/]+)/.exec(window.location.pathname)?.[1] ??
    context.roomId
  );
}

/** "This message": the newest one on screen that someone else wrote. */
export function latestOtherMessage(context: VoiceCommandContext) {
  const roomId = roomOnScreen(context);
  const myActorIds = new Set(
    context.queryClient
      ?.getQueryData<TeamHubSession>(teamHubSessionQueryKey)
      ?.identity.actors.map((actor) => actor.id) ?? [],
  );
  const messages =
    context.queryClient
      ?.getQueryData<
        InfiniteData<TeamHubMessagePage>
      >(roomMessagesQueryKey(context.tenantId, roomId))
      ?.pages.flatMap((page) => page.items) ?? [];
  let latest: TeamHubMessage | undefined;
  for (const message of messages)
    if (
      message.message_kind === "conversation" &&
      !myActorIds.has(message.author.id) &&
      (!latest || message.created_at > latest.created_at)
    )
      latest = message;
  return latest && { message: latest, roomId };
}

export const reactions = [
  { id: "+1", name: "thumbs up, like" },
  { id: "heart", name: "heart, love" },
  { id: "joy", name: "laughing, joy" },
  { id: "tada", name: "celebrate, congrats" },
  { id: "ok_hand", name: "OK, got it" },
  { id: "eyes", name: "eyes, looking" },
  { id: "pray", name: "thanks, please" },
  { id: "fire", name: "fire, awesome" },
  { id: "clap", name: "clap, well done" },
  { id: "100", name: "100, perfect" },
];

/** Document sections offered with the turn, by id. */
let offeredSections = new Map<string, HTMLElement>();

/** The heading behind a section offered by the last sectionOptions(). */
export function offeredSection(id: string) {
  const heading = offeredSections.get(id);
  return heading?.isConnected ? heading : undefined;
}

export function sectionOptions() {
  const headings = new Set<HTMLElement>();
  for (const container of document.querySelectorAll(
    '[data-voice-scroll="document"]',
  ))
    for (const heading of container.querySelectorAll<HTMLElement>("h1, h2, h3"))
      if (heading.textContent?.trim()) headings.add(heading);
  offeredSections = new Map();
  return [...headings].slice(0, 60).map((heading, index) => {
    const id = `section-${index}`;
    offeredSections.set(id, heading);
    return {
      id,
      name: `${heading.textContent.trim().slice(0, 100)} (section ${index + 1})`,
    };
  });
}
