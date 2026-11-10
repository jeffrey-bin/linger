import type { QueryClient } from "@tanstack/react-query";

import type { TeamHubMessageDocumentReference } from "@/features/teamhub/teamhub-message-content";
import type { RoomMessageSender } from "../room-message-sender";
import type {
  TeamHubActorRef,
  TeamHubVoiceLiveTurnMarker,
} from "@/features/teamhub/teamhub-types";
import {
  roomMessagesQueryKey,
  tenantRoomActivityQueryKey,
} from "../../room-queries";
import {
  readRoomComposerDraft,
  writeRoomComposerDraft,
} from "../../room-drafts";
import { composeDirectRoomMessage } from "../direct-room-message";
import { formatMentionToken } from "../message-mentions";
import { appendRoomMessage } from "../room-projection";
import type { VoiceModeSessionTarget } from "./voice-mode-session";
import { voiceTurnIdempotencyKey } from "./voice-turn-key";
import { withVoiceMaterials } from "./voice-material-composition";

/** The draft that preceded dictation, frozen when Voice Mode started. */
export interface VoiceTurnPrefix {
  body: string;
  documentReferences: TeamHubMessageDocumentReference[];
  mentions: TeamHubActorRef[];
}

/**
 * Sends one accepted Voice Mode turn to its Room while that Room's chat is not
 * on screen. Only Message excerpts ride along: Document materials need the
 * Room composer's link authorization, so they wait for a turn sent there.
 * The turn's key keeps a retried turn idempotent.
 */
export async function sendVoiceTurnToRoom({
  composition,
  eventId,
  prefix,
  queryClient,
  target,
  text,
  voiceLiveTurn,
}: {
  composition: RoomMessageSender;
  eventId: string;
  prefix: VoiceTurnPrefix;
  queryClient: QueryClient | undefined;
  target: VoiceModeSessionTarget;
  text: string;
  voiceLiveTurn?: TeamHubVoiceLiveTurnMarker;
}) {
  const scope = {
    accountId: target.accountId,
    roomId: target.roomId,
    tenantId: target.tenantId,
  };
  const materials = (readRoomComposerDraft(scope).voiceMaterials ?? []).filter(
    (item) => item.messageId,
  );
  const reserved = target.recipient
    ? [formatMentionToken(target.recipient)]
    : [];
  let value = withVoiceMaterials(
    {
      body: [prefix.body, text].filter(Boolean).join("\n"),
      documentReferences: prefix.documentReferences.map((item) => ({
        ...item,
      })),
      files: [],
      mentions: [...prefix.mentions],
      messageIdempotencyKey: voiceTurnIdempotencyKey(eventId),
    },
    materials,
    reserved,
  );
  if (target.recipient)
    value = composeDirectRoomMessage(value, target.recipient);
  const idempotencyKey = value.messageIdempotencyKey!;
  const { message } = await composition.createMessage({
    attachments: [],
    body: value.body,
    contextDocumentVersionIds: [],
    contextMessageIds: [],
    documentReferences: value.documentReferences ?? [],
    idempotencyKey,
    mentions: value.mentions,
    onAttachmentProgress: () => undefined,
    roomId: target.roomId,
    skillReferences: [],
    voiceLiveTurn,
  });
  if (queryClient) {
    appendRoomMessage(
      queryClient,
      roomMessagesQueryKey(target.tenantId, target.roomId),
      message,
    );
    void queryClient.invalidateQueries({
      queryKey: tenantRoomActivityQueryKey(target.tenantId),
    });
  }
  // Selected material belongs to the one message it was sent with.
  if (materials.length) {
    const sent = new Set(materials.map((item) => item.id));
    const draft = readRoomComposerDraft(scope);
    writeRoomComposerDraft(scope, {
      ...draft,
      voiceMaterials: (draft.voiceMaterials ?? []).filter(
        (item) => !sent.has(item.id),
      ),
    });
  }
}

/** Returns unsent dictation to the Room draft when exiting away from it. */
export function keepUnsentVoiceText(
  target: VoiceModeSessionTarget,
  prefix: VoiceTurnPrefix,
  text: string,
) {
  const scope = {
    accountId: target.accountId,
    roomId: target.roomId,
    tenantId: target.tenantId,
  };
  writeRoomComposerDraft(scope, {
    ...readRoomComposerDraft(scope),
    body: [prefix.body, text].filter(Boolean).join("\n"),
  });
}
