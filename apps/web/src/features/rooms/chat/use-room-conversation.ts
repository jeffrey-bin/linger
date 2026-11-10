import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { type ComponentProps, useMemo } from "react";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubMessagePresentation } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import type { RoomMessageSender } from "./room-message-sender";

import { tenantRoomActivityQueryKey } from "../room-queries";
import { visibleDirectPeerRunStatuses } from "./direct-peer-streaming";
import type { AgentStreamingStatusDock } from "./message-timeline";
import { useMessageReactionToggle } from "./message-reactions/use-message-reaction-toggle";
import type { RoomMessageOutboxScope } from "./room-message-outbox";
import { useRoomAgentStreamingStatus } from "./use-room-agent-streaming-status";
import { useRoomMessageDelivery } from "./use-room-message-delivery";

/**
 * The live conversation of one Room: Agent streaming from the Run statuses
 * TeamHub pushes, the Message Outbox, and reactions. Room chat and a Thread
 * share it. Until `roomId` names a Room nothing subscribes.
 */
export function useRoomConversation({
  client,
  composition,
  currentActorId,
  directPeerAgentId,
  documentsQueryKey,
  enabled,
  messages,
  messagesQueryKey,
  onMessagePresented,
  openLiveActivity,
  outboxScope,
  roomId,
  tenantId,
}: {
  client: TeamHubClient;
  composition: RoomMessageSender;
  currentActorId?: string;
  /** Streaming shows only this Agent: the peer of a Direct Room. */
  directPeerAgentId?: string;
  documentsQueryKey?: QueryKey;
  enabled: boolean;
  /** The Room's Messages, oldest first. */
  messages: readonly TeamHubMessage[];
  messagesQueryKey: QueryKey;
  onMessagePresented?: (
    messageId: string,
    presentation: TeamHubMessagePresentation,
  ) => void;
  openLiveActivity: (
    agent: { display_name: string; id: string },
    runStatusId: string,
    runId?: string,
  ) => void;
  outboxScope: RoomMessageOutboxScope;
  roomId: string;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  const live = enabled && Boolean(roomId);
  const agentStreaming = useRoomAgentStreamingStatus({
    enabled: live,
    messages,
    roomId,
    tenantId,
  });
  const delivery = useRoomMessageDelivery({
    composition,
    documentsQueryKey,
    messagesQueryKey,
    // The woken Agent's Run status arrives on the event stream.
    onMessageCommitted: () => {
      void queryClient.invalidateQueries({
        queryKey: tenantRoomActivityQueryKey(tenantId),
      });
    },
    onMessagePresented,
    outboxScope,
    roomId,
  });
  const toggleReaction = useMessageReactionToggle({
    client,
    currentActorId,
    queryClient,
    roomId,
    tenantId,
  });
  const streamingRunStatuses = useMemo(
    () =>
      visibleDirectPeerRunStatuses(
        agentStreaming.runStatuses,
        directPeerAgentId,
      ),
    [agentStreaming.runStatuses, directPeerAgentId],
  );
  const dock: ComponentProps<typeof AgentStreamingStatusDock> = {
    cancelRoomRun: (runId, requestId) =>
      teamHubData(
        client.api.POST("/v0/rooms/{roomId}/runs/{runId}/cancel", {
          params: { path: { roomId, runId } },
          body: { request_id: requestId },
        }),
      ),
    redeliverRoomRun: (runId) =>
      teamHubData(
        client.api.POST(
          "/v0/rooms/{roomId}/runs/{runId}/redeliver-unconfirmed-inputs",
          { params: { path: { roomId, runId } } },
        ),
      ),
    runStatuses: streamingRunStatuses,
    onViewActivity: (runStatusId, agent, runId) => {
      if (runId) {
        openLiveActivity(agent, runStatusId, runId);
        return;
      }
      const runStatus = streamingRunStatuses.find(
        (item) => item.id === runStatusId,
      );
      openLiveActivity(
        runStatus?.agent ?? agent,
        runStatus?.id ?? runStatusId,
        runStatus?.run_id,
      );
    },
    runtimePresentationEventsByRunStatusId:
      agentStreaming.runtimePresentationEventsByRunStatusId,
    scopeKey: ["teamhub", tenantId, roomId],
  };

  return {
    agentStreaming,
    delivery,
    dock,
    pendingMessages: delivery.outgoing,
    streamingRunStatuses,
    toggleReaction,
  };
}

/** Infinite-query pages arrive newest first; the timeline reads oldest first. */
export function orderRoomMessages(
  pages: readonly { items: TeamHubMessage[] }[],
) {
  return pages
    .slice()
    .reverse()
    .flatMap((page) => page.items)
    .sort(compareRoomMessages);
}

function compareRoomMessages(
  left: TeamHubMessage,
  right: TeamHubMessage,
): number {
  if (left.created_at !== right.created_at) {
    return left.created_at < right.created_at ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  // A Room notice written with a Message, such as the member a mention just
  // admitted, shares its time and reads before it.
  const leftNotice = left.message_kind === "room_notice";
  if (leftNotice !== (right.message_kind === "room_notice")) {
    return leftNotice ? -1 : 1;
  }
  return left.id < right.id ? -1 : 1;
}
