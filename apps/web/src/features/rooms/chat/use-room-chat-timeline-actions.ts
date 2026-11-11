import { useMemo, useCallback, useEffect } from "react";

import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import { createRoomCardDecisionController } from "@/features/rooms/cards/room-card-decision-controller";
import { createRoomChatMessageActions } from "@/features/rooms/chat/use-room-chat-message-actions";
import { teamHubData } from "@/features/teamhub/teamhub-api";

import { tenantRoomsQueryKey } from "../room-queries";
import { preloadUnifiedDocumentPage } from "../documents/document-route-preload";
import type { MessageComposition } from "./message-composer";
import { useRoomMessagePresentations } from "./room-message-presentations";
import { replaceLoadedRoomMessage } from "./room-projection";
import { useFocusComposerOnEntry } from "./use-focus-composer-on-entry";
import { usePrefetchPanelAfterPaint } from "./use-prefetch-panel-after-paint";
import {
  directPeerCanCompose,
  projectDirectPeerState,
} from "./room-composer-dock";
import type { RoomChatData } from "./use-room-chat-data";
import type { RoomChatConversationState } from "./use-room-chat-conversation-state";

const OLDER_MESSAGES_SCROLL_THRESHOLD_PX = 200;

function prefetchDocumentSurface() {
  // Opening a card still surfaces a failed import through its lazy boundary.
  void preloadUnifiedDocumentPage().catch(() => undefined);
}

/**
 * Owns the timeline and composer actions: card decisions, actor lookups,
 * profile and direct-chat navigation, panel prefetching, older-page loading
 * and sending.
 */
export function useRoomChatTimelineActions(
  {
    actorItems,
    client,
    linkedMessage,
    messages,
    navigate,
    navigation,
    openPanelTab,
    prefetchPanel,
    queryClient,
    room,
    roomId,
    roomMessagePresentations,
    tenantId,
  }: RoomChatData,
  {
    agentAvailability,
    agentDirectory,
    delivery,
    interactionMessages,
    interactions,
    mentionOptions,
    orderedMessages,
    timeline,
  }: RoomChatConversationState,
) {
  const cardDecisionController = useMemo(
    () =>
      createRoomCardDecisionController({
        client,
        onResolved: async (message) => {
          replaceLoadedRoomMessage(queryClient, tenantId, roomId, message);
        },
        roomId,
        tenantId,
      }),
    [client, queryClient, roomId, tenantId],
  );
  const resolvedPresentations = useResolvedRoomMessagePresentations({
    deliveryPresentations: delivery.presentations,
    linkedMessage: linkedMessage.data,
    mentionOptions,
    orderedMessages,
    roomMessagePresentations,
  });
  const actorDisplayNames = useMemo(
    () =>
      Object.fromEntries(
        actorItems.map((actor) => [actor.id, actor.display_name]),
      ),
    [actorItems],
  );
  const actorKinds = useMemo(
    () => Object.fromEntries(actorItems.map((actor) => [actor.id, actor.kind])),
    [actorItems],
  );
  const workspaceAgentIds = useMemo(() => {
    const actorIds = new Set<string>();
    for (const agent of agentDirectory.data?.items ?? []) {
      if (agent.visibility_scope === "workspace") {
        actorIds.add(agent.actor.id);
      }
    }
    return actorIds;
  }, [agentDirectory.data?.items]);
  const openActorProfile = useCallback(
    (actorId: string) => {
      const actor = actorItems.find((candidate) => candidate.id === actorId);
      if (actor?.kind === "agent") {
        navigation.openAgentInfo(actor);
        return;
      }
      navigation.openProfile(actorId);
    },
    [actorItems, navigation],
  );
  // A Room notice about an Agent created after approval opens its direct chat.
  const openDirectChat = useCallback(
    (peerActorId: string) => {
      void teamHubData(
        client.api.POST("/v0/tenants/{tenantId}/direct-rooms", {
          params: { path: { tenantId } },
          body: { peer_actor_id: peerActorId },
        }),
      )
        .then(async ({ id: directRoomId }) => {
          await queryClient.invalidateQueries({
            queryKey: tenantRoomsQueryKey(tenantId),
          });
          await navigate(`/t/${tenantId}/rooms/${directRoomId}/chat`, {
            state: { focusComposer: true },
          });
        })
        .catch(() => openActorProfile(peerActorId));
    },
    [client, navigate, openActorProfile, queryClient, tenantId],
  );
  const timelineActions = useMemo(
    () => ({
      onCardDecision: async (
        decision: Parameters<typeof cardDecisionController.decide>[0],
      ) => {
        await cardDecisionController.decide(decision);
      },
      onOpenUrl: (href: string) => {
        const target = new URL(href);
        openPanelTab({
          kind: "url",
          previewUrl: target.href,
          title: target.hostname,
        });
      },
    }),
    [cardDecisionController, openPanelTab],
  );
  const directPeerState = projectDirectPeerState(
    room,
    agentDirectory.data?.items,
    agentAvailability.data?.items,
  );
  const focusComposerOnEntry = useFocusComposerOnEntry(
    directPeerCanCompose(directPeerState) && room.participation !== "left",
  );
  usePrefetchPanelAfterPaint(
    timeline.initialScrollReady &&
      directPeerCanCompose(directPeerState) &&
      room.participation !== "left",
    prefetchPanel,
  );
  // A card opens the Document surface; warm only that chunk so its /open is
  // not queued behind a cold lazy import. Editor and comment code stay lazy.
  usePrefetchPanelAfterPaint(
    timeline.initialScrollReady &&
      interactionMessages.some((message) =>
        message.segments.some((segment) => segment.type === "document"),
      ),
    prefetchDocumentSurface,
  );
  const chatActions = createRoomChatMessageActions({
    delivery,
    messages,
    room,
    selectedContextMessages: interactions.selectedContextMessages,
    timeline,
  });
  const { loadOlderMessages } = chatActions;
  // Scrolling near the top, or a timeline too short to scroll, loads the
  // previous page; the scroll hook keeps the reader's place as it prepends.
  const loadOlderNearTop = (viewport: HTMLElement) => {
    if (
      messages.hasNextPage &&
      !messages.isFetchingNextPage &&
      viewport.scrollTop <= OLDER_MESSAGES_SCROLL_THRESHOLD_PX
    )
      void loadOlderMessages();
  };
  const timelineViewport = timeline.timelineElement;
  useEffect(() => {
    if (
      timeline.initialScrollReady &&
      timelineViewport &&
      timelineViewport.clientHeight > 0 &&
      timelineViewport.scrollHeight <= timelineViewport.clientHeight
    )
      loadOlderNearTop(timelineViewport);
  });
  async function sendMessage(value: MessageComposition) {
    const contextIds = (
      value.contextMessages ?? interactions.selectedContextMessages
    ).map((message) => message.id);
    await chatActions.sendMessage(value);
    interactions.clearContext(contextIds);
  }
  const directAgentRegistration =
    room.kind === "direct" && room.direct_peer?.kind === "agent"
      ? agentDirectory.data?.items.find(
          (agent) => agent.actor.id === room.direct_peer?.id,
        )
      : undefined;
  return {
    actorDisplayNames,
    actorKinds,
    directAgentRegistration,
    directPeerState,
    focusComposerOnEntry,
    loadOlderNearTop,
    openActorProfile,
    openDirectChat,
    resolvedPresentations,
    sendMessage,
    timelineActions,
    workspaceAgentIds,
  };
}

export type RoomChatTimelineActions = ReturnType<
  typeof useRoomChatTimelineActions
>;

type MessagePresentationResolutionInput = Parameters<
  typeof useRoomMessagePresentations
>[0];

function useResolvedRoomMessagePresentations({
  deliveryPresentations,
  linkedMessage,
  mentionOptions,
  orderedMessages,
  roomMessagePresentations,
}: Omit<MessagePresentationResolutionInput, "messages"> & {
  linkedMessage?: TeamHubMessage;
  orderedMessages: TeamHubMessage[];
}) {
  const messages = useMemo(
    () =>
      linkedMessage ? [...orderedMessages, linkedMessage] : orderedMessages,
    [linkedMessage, orderedMessages],
  );
  return useRoomMessagePresentations({
    deliveryPresentations,
    mentionOptions,
    messages,
    roomMessagePresentations,
  });
}
