import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import { dateTimeFormat } from "@/lib/date-format";

import { settledCardNotice } from "../cards/card-notice";
import { knownRoomMessageCard } from "../cards/room-message-card";

const messageDateFormatter = dateTimeFormat({
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});
const messageClockFormatter = dateTimeFormat({
  hour: "numeric",
  minute: "2-digit",
});

/** Conversation separator, e.g. "Friday, October 23, 2026 at 3:04 PM". */
export function formatMessageTime(timestamp: string) {
  const date = new Date(timestamp);
  return `${messageDateFormatter.format(date)} at ${messageClockFormatter.format(date)}`;
}

export function messageStartsConversation(
  message: TeamHubMessage,
  previous?: TeamHubMessage,
) {
  return timeStartsConversation(message.created_at, previous?.created_at);
}

/** Five quiet minutes or a new day start a conversation. */
export function timeStartsConversation(
  current: string | number,
  previous?: string | number,
) {
  if (previous === undefined) return true;
  const currentDate = new Date(current);
  const previousDate = new Date(previous);
  return (
    currentDate.getTime() - previousDate.getTime() >= 5 * 60 * 1000 ||
    currentDate.toDateString() !== previousDate.toDateString()
  );
}

/** Card context Messages render inside their card, and runtime Messages never
 * render as rows. */
export function isTimelineMessage(message: TeamHubMessage) {
  return (
    !message.card_context_message_id && message.message_kind !== "agent_runtime"
  );
}

/** A Room notice or a settled card's system line is a centered line, never
 * part of an author's group, so the next Message shows its author again. */
export function isRoomNotice(message: TeamHubMessage) {
  if (message.message_kind === "room_notice") return true;
  const card = knownRoomMessageCard(message.card);
  return Boolean(card && settledCardNotice(card, undefined));
}
