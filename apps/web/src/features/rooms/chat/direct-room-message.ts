import { formatTeamHubMentionToken } from "@/features/teamhub/teamhub-message-content";
import type {
  TeamHubActorRef,
  TeamHubMessage,
  TeamHubMessageSegment,
} from "@/features/teamhub/teamhub-types";

import type { MessageComposition } from "./message-composer";

export function composeDirectRoomMessage(
  composition: MessageComposition,
  peer: TeamHubActorRef,
): MessageComposition {
  const token = formatTeamHubMentionToken(peer);
  return {
    ...composition,
    body: composition.body ? `${token} ${composition.body}` : token,
    mentions: [
      peer,
      ...composition.mentions.filter((mention) => mention.id !== peer.id),
    ],
  };
}

/** Sends with the peer's @ while the composer keeps the unprefixed body. */
export function withDirectRoomWireBody<T extends MessageComposition>(
  composition: T,
  peer?: TeamHubActorRef,
): T & { wireBody: string } {
  const wire = peer ? composeDirectRoomMessage(composition, peer) : composition;
  return { ...composition, mentions: wire.mentions, wireBody: wire.body };
}

export function presentDirectRoomMessage(
  message: TeamHubMessage,
  peer?: TeamHubActorRef,
): TeamHubMessage {
  if (!peer || message.author.kind !== "human") {
    return message;
  }
  const [mention, ...rest] = message.segments;
  if (
    mention?.type !== "reference" ||
    mention.target !== peer.id ||
    mention.target_type !== "agent"
  ) {
    return message;
  }
  const segments = dropLeadingWhitespace(rest);
  const raw_message = segments.map((segment) => segment.content).join("");
  if (!segments.length || !raw_message) {
    return message;
  }
  return { ...message, raw_message, segments };
}

function dropLeadingWhitespace(
  segments: TeamHubMessageSegment[],
): TeamHubMessageSegment[] {
  const first = segments[0];
  if (!first) {
    return segments;
  }
  if (first.type !== "text") {
    return segments;
  }
  const content = first.content.replace(/^\s+/, "");
  if (!content) {
    return dropLeadingWhitespace(segments.slice(1));
  }
  return [{ ...first, content }, ...segments.slice(1)];
}
