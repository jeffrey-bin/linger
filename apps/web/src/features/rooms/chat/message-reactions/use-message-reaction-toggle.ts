import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import {
  roomMessageQueryKey,
  roomMessageQueryOptions,
  roomMessagesQueryKey,
} from "@/features/rooms/room-queries";
import { teamHubDone } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubMessage,
  TeamHubMessagePage,
  TeamHubMessageReaction,
  TeamHubMessageReactionId,
} from "@/features/teamhub/teamhub-types";

import { hasOwnReaction, toggleMessageReaction } from "./reaction-state";

type ReactionsUpdate = (
  current: TeamHubMessageReaction[] | undefined,
) => TeamHubMessageReaction[] | undefined;

function withReactions(
  message: TeamHubMessage,
  reactions: TeamHubMessageReaction[] | undefined,
): TeamHubMessage {
  const next = { ...message, reactions };
  if (!reactions) delete next.reactions;
  return next;
}

/** Patches one Message's Reactions in both the Room list and detail caches. */
export function patchLoadedMessageReactions(
  queryClient: QueryClient,
  tenantId: string,
  roomId: string,
  messageId: string,
  update: ReactionsUpdate,
) {
  queryClient.setQueryData<InfiniteData<TeamHubMessagePage>>(
    roomMessagesQueryKey(tenantId, roomId),
    (cached) =>
      cached
        ? {
            ...cached,
            pages: cached.pages.map((page) => ({
              ...page,
              items: page.items.map((message) =>
                message.id === messageId
                  ? withReactions(message, update(message.reactions))
                  : message,
              ),
            })),
          }
        : cached,
  );
  queryClient.setQueryData<TeamHubMessage>(
    roomMessageQueryKey(tenantId, roomId, messageId),
    (cached) =>
      cached?.id === messageId
        ? withReactions(cached, update(cached.reactions))
        : cached,
  );
}

function cachedMessage(
  queryClient: QueryClient,
  tenantId: string,
  roomId: string,
  messageId: string,
): TeamHubMessage | undefined {
  const detail = queryClient.getQueryData<TeamHubMessage>(
    roomMessageQueryKey(tenantId, roomId, messageId),
  );
  if (detail?.id === messageId) return detail;
  for (const page of queryClient.getQueryData<InfiniteData<TeamHubMessagePage>>(
    roomMessagesQueryKey(tenantId, roomId),
  )?.pages ?? []) {
    const found = page.items.find((message) => message.id === messageId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Toggles the current Actor's Reaction optimistically. Writes for one Message
 * run in order; a failure re-reads the authoritative Message (or undoes the
 * optimistic change when that read also fails) and rethrows for retry UI.
 */
export function useMessageReactionToggle(input: {
  client: TeamHubClient;
  queryClient: QueryClient;
  tenantId: string;
  roomId: string;
  currentActorId?: string;
}) {
  const queuesRef = useRef(new Map<string, Promise<void>>());
  const { client, currentActorId, queryClient, roomId, tenantId } = input;

  return useCallback(
    (message: TeamHubMessage, reactionId: TeamHubMessageReactionId) => {
      if (!currentActorId) return Promise.resolve();
      const actorId = currentActorId;
      const perform = async () => {
        // Decide against the latest cache so queued clicks alternate correctly.
        const current =
          cachedMessage(queryClient, tenantId, roomId, message.id) ?? message;
        const active = !hasOwnReaction(current, reactionId, actorId);
        patchLoadedMessageReactions(
          queryClient,
          tenantId,
          roomId,
          message.id,
          (current) =>
            toggleMessageReaction(current, reactionId, actorId, active),
        );
        try {
          if (active)
            await teamHubDone(
              client.api.PUT(
                "/v0/rooms/{roomId}/messages/{messageId}/reactions/{reactionId}",
                {
                  params: {
                    path: { roomId, messageId: message.id, reactionId },
                  },
                },
              ),
            );
          else
            await teamHubDone(
              client.api.DELETE(
                "/v0/rooms/{roomId}/messages/{messageId}/reactions/{reactionId}",
                {
                  params: {
                    path: { roomId, messageId: message.id, reactionId },
                  },
                },
              ),
            );
        } catch (error) {
          try {
            const authoritative = await queryClient.fetchQuery({
              ...roomMessageQueryOptions(client, tenantId, roomId, message.id),
              staleTime: 0,
            });
            patchLoadedMessageReactions(
              queryClient,
              tenantId,
              roomId,
              message.id,
              () => authoritative.reactions,
            );
          } catch {
            patchLoadedMessageReactions(
              queryClient,
              tenantId,
              roomId,
              message.id,
              (current) =>
                toggleMessageReaction(current, reactionId, actorId, !active),
            );
          }
          throw error;
        }
      };
      const previous = queuesRef.current.get(message.id);
      const queued = previous
        ? previous.catch(() => undefined).then(perform)
        : perform();
      queuesRef.current.set(message.id, queued);
      const clear = () => {
        if (queuesRef.current.get(message.id) === queued)
          queuesRef.current.delete(message.id);
      };
      void queued.then(clear, clear);
      return queued;
    },
    [client, currentActorId, queryClient, roomId, tenantId],
  );
}
