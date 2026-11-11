import { useMemo, useState } from "react";

import type {
  TeamHubDocument,
  TeamHubMessage,
  TeamHubRoomMember,
  TeamHubSkillManifest,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

import { readRoomComposerDraft } from "../room-drafts";
import { roomDocumentsQueryKey } from "../room-queries";
import { useDocumentCardMetadata } from "../files/use-document-card-metadata";
import type { MessageSkillOption } from "./message-composer-references";
import type { VoiceModePresentation } from "./voice-mode/voice-mode-controls";
import type { VoiceLiveDraft } from "./voice-mode/voice-live-draft";
import { voiceModeStatusLabel } from "./voice-mode/voice-mode-presentation";
import { createDirectRoomMessagePresenter } from "./direct-room-message";
import { useRoomMentionOptions } from "./use-room-mention-options";
import {
  orderRoomMessages,
  useRoomConversation,
} from "./use-room-conversation";
import { useRoomMessageInteractions } from "./use-room-message-interactions";
import { useAnotherMeOnboarding } from "./use-another-me-onboarding";
import { useRoomTimelineScroll } from "./use-room-timeline-scroll";
import type { RoomChatData } from "./use-room-chat-data";

/**
 * Owns the Room conversation: presented messages, composer options, message
 * delivery, the voice live draft and timeline scrolling.
 */
export function useRoomChatConversationState({
  client,
  composerDocuments,
  composition,
  identity,
  linkedInTimeline,
  linkedMessage,
  linkedMessageId,
  members,
  messages,
  messagesQuery,
  navigation,
  recordMessagePresentation,
  room,
  roomDocuments,
  roomId,
  skillManifests,
  tenantId,
}: RoomChatData) {
  const onboarding = useAnotherMeOnboarding({
    accountId: identity.account.id,
    pages: messages.data.pages,
    room,
  });
  const {
    interactionMessages,
    linkedPresentedMessage,
    orderedMessages,
    presentedMessages,
  } = usePresentedRoomMessages({
    directPeer: room.direct_peer,
    linkedMessage: linkedMessage.data,
    pages: onboarding.pages,
  });
  const firstMessageId = orderedMessages[0]?.id;
  const draftScope = { accountId: identity.account.id, roomId, tenantId };
  const initialDraft = readRoomComposerDraft(draftScope);
  const currentActorId = identity.actors.find(
    (actor) => actor.tenant_id === tenantId,
  )?.id;
  const { agentAvailability, agentDirectory, mentionOptions } =
    useRoomMentionOptions({
      client,
      members,
      tenantId,
    });
  const documentMetadata = useDocumentCardMetadata(
    client,
    tenantId,
    roomDocuments.data?.items ?? [],
    interactionMessages,
    { documentsPending: roomDocuments.isPending },
  );
  const { documentOptions, documentTitles, skillOptions } =
    useRoomComposerOptions(
      composerDocuments,
      agentDirectory.data?.items ?? [],
      members.items,
      skillManifests.data ?? [],
      tenantId,
    );
  const interactions = useRoomMessageInteractions({
    currentActorId,
    mentionOptions,
    roomId,
    tenantId,
  });
  const conversation = useRoomConversation({
    client,
    composition,
    currentActorId,
    directPeerAgentId:
      room.kind === "direct" && room.direct_peer?.kind === "agent"
        ? room.direct_peer.id
        : undefined,
    documentsQueryKey: roomDocumentsQueryKey(tenantId, roomId),
    enabled: room.participation !== "left",
    messages: orderedMessages,
    messagesQueryKey: messagesQuery.queryKey,
    onMessagePresented: recordMessagePresentation,
    openLiveActivity: navigation.openLiveActivity,
    outboxScope: draftScope,
    roomId,
    tenantId,
  });
  const { agentStreaming, delivery } = conversation;
  // Paced setup is local to this Direct Room's one Agent; the Dock shows it
  // only while that Agent has no Run status.
  const dock = onboarding.typingAgent
    ? { ...conversation.dock, typingAgent: onboarding.typingAgent }
    : conversation.dock;
  const currentActor = identity.actors.find(
    (actor) => actor.tenant_id === tenantId && actor.id === currentActorId,
  );
  const [voiceLiveDraft, setVoiceLiveDraft] = useState<VoiceLiveDraft | null>(
    null,
  );
  function updateVoiceLiveDraft(presentation: VoiceModePresentation) {
    if (
      !presentation.entered ||
      !currentActor ||
      (!presentation.text && !presentation.error)
    ) {
      setVoiceLiveDraft(null);
      return;
    }
    setVoiceLiveDraft({
      actor: currentActor,
      error: presentation.error,
      statusLabel: voiceModeStatusLabel(presentation),
      text: presentation.text,
    });
  }
  const timeline = useRoomTimelineScroll({
    scope: draftScope,
    firstMessageId,
    linkedMessageId,
    linkedMessageReady:
      linkedInTimeline || linkedMessage.data?.id === linkedMessageId,
    messageCount: orderedMessages.length,
    pendingMessageCount: delivery.outgoing.length + (voiceLiveDraft ? 1 : 0),
    progressVersion: `${agentStreaming.progressVersion}:${voiceLiveDraft?.statusLabel ?? ""}:${voiceLiveDraft?.text ?? ""}`,
  });
  return {
    agentAvailability,
    agentDirectory,
    agentStreaming,
    conversation,
    currentActor,
    currentActorId,
    delivery,
    dock,
    documentMetadata,
    documentOptions,
    documentTitles,
    draftScope,
    initialDraft,
    interactionMessages,
    interactions,
    linkedPresentedMessage,
    mentionOptions,
    onboarding,
    orderedMessages,
    presentedMessages,
    skillOptions,
    timeline,
    updateVoiceLiveDraft,
    voiceLiveDraft,
  };
}

export type RoomChatConversationState = ReturnType<
  typeof useRoomChatConversationState
>;

function usePresentedRoomMessages({
  directPeer,
  linkedMessage,
  pages,
}: {
  directPeer: Parameters<typeof createDirectRoomMessagePresenter>[0];
  linkedMessage?: TeamHubMessage;
  pages: readonly { items: TeamHubMessage[] }[];
}) {
  const orderedMessages = useMemo(() => orderRoomMessages(pages), [pages]);
  const present = useMemo(
    () => createDirectRoomMessagePresenter(directPeer),
    [directPeer],
  );
  const presentedMessages = useMemo(
    () => orderedMessages.map(present),
    [orderedMessages, present],
  );
  const linkedPresentedMessage = useMemo(
    () => (linkedMessage ? present(linkedMessage) : undefined),
    [linkedMessage, present],
  );
  const interactionMessages = useMemo(() => {
    if (
      !linkedPresentedMessage ||
      presentedMessages.some(
        (message) => message.id === linkedPresentedMessage.id,
      )
    ) {
      return presentedMessages;
    }
    return [...presentedMessages, linkedPresentedMessage].sort(
      (first, second) =>
        Date.parse(first.created_at) - Date.parse(second.created_at) ||
        first.id.localeCompare(second.id),
    );
  }, [linkedPresentedMessage, presentedMessages]);

  return {
    interactionMessages,
    linkedPresentedMessage,
    orderedMessages,
    presentedMessages,
  };
}

function useRoomComposerOptions(
  documents: TeamHubDocument[],
  agents: TeamHubTenantAgent[],
  members: TeamHubRoomMember[],
  skillManifests: TeamHubSkillManifest[],
  tenantId: string,
) {
  return useMemo(() => {
    const documentOptions = documents
      .map((document) => ({
        documentId: document.id,
        name: document.title,
        tenantId,
        updatedAt: document.updated_at,
      }))
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          left.name.localeCompare(right.name),
      );
    const documentTitles = Object.fromEntries(
      documentOptions.map((document) => [document.documentId, document.name]),
    );

    const roomAgentIds = new Set<string>();
    for (const member of members) {
      if (member.actor.kind === "agent") roomAgentIds.add(member.actor.id);
    }
    const skillOptions: MessageSkillOption[] = [];
    const manifestsByIdentity = new Map(
      skillManifests.map((manifest) => [
        `${manifest.skill_id}\u0000${manifest.manifest_version}`,
        manifest,
      ]),
    );
    for (const agent of agents) {
      if (!roomAgentIds.has(agent.actor.id)) {
        continue;
      }
      for (const skill of agent.skill_bindings) {
        const manifest = manifestsByIdentity.get(
          `${skill.skill_id}\u0000${skill.manifest_version}`,
        );
        skillOptions.push({
          agent: agent.actor,
          description: skill.description ?? manifest?.description,
          manifestVersion: skill.manifest_version,
          name: skill.name,
          skillId: skill.skill_id,
        });
      }
    }
    skillOptions.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.agent.display_name.localeCompare(right.agent.display_name),
    );
    return { documentOptions, documentTitles, skillOptions };
  }, [agents, documents, members, skillManifests, tenantId]);
}
