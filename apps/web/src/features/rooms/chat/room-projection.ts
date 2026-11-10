import type { TeamHubRoom } from "@/features/teamhub/teamhub-types";
import { refreshQueriesInBackground } from "@/features/teamhub/background-query-refresh";
import { roomBackgroundTasksQueryKey } from "./use-room-background-tasks";
import type {
  InfiniteData,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";

import type {
  TeamHubMessage,
  TeamHubMessagePage,
  TeamHubMessageThreadSummary,
  TeamHubRoomEvent,
  TeamHubRoomPage,
} from "@/features/teamhub/teamhub-types";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { tenantWorkItemsDashboardQueryKey } from "@/features/work-items/work-item-queries";

import {
  roomDocumentsQueryKey,
  roomDocumentCommentThreadsQueryKey,
  roomMembersQueryKey,
  roomMessageQueryKey,
  roomMessagesQueryKey,
  roomQueryKey,
  roomRoutinesQueryKey,
  roomTeamMdQueryKey,
  tenantActorsQueryKey,
  tenantAgentsQueryKey,
  tenantRoomsQueryKey,
} from "../room-queries";
import { patchLoadedMessageReactions } from "./message-reactions/use-message-reaction-toggle";

export function createRoomProjection({
  currentActorId,
  initialRoomSeq = 0,
  messages,
  onMessageCreated,
  onRoomAccessInvalidated,
  onTeamMdPublished,
  queryClient,
  roomId,
  tenantId,
}: {
  currentActorId?: string;
  initialRoomSeq?: number;
  messages?: Pick<TeamHubClient, "api">;
  /** Called for each Message that arrives after the page's snapshot. */
  onMessageCreated?: (message: TeamHubMessage) => void;
  onRoomAccessInvalidated?: () => Promise<void> | void;
  /** Called when an Agent publishes the Room's team.md. */
  onTeamMdPublished?: () => void;
  queryClient: QueryClient;
  roomId: string;
  tenantId: string;
}) {
  if (!Number.isSafeInteger(initialRoomSeq) || initialRoomSeq < 0) {
    throw new TypeError(
      "Initial Room Event sequence must be a non-negative integer.",
    );
  }
  let lastAppliedRoomSeq = initialRoomSeq;

  return {
    async applyEvent(event: TeamHubRoomEvent) {
      if (event.room_seq <= lastAppliedRoomSeq) {
        return;
      }

      if (event.room_seq !== lastAppliedRoomSeq + 1) {
        throw new Error(
          `Room Event sequence gap: expected ${lastAppliedRoomSeq + 1}, received ${event.room_seq}.`,
        );
      }

      // A Room Event kind this client does not know, such as one a newer
      // TeamHub added, projects nothing.
      await projectEvent(queryClient, tenantId, roomId, event, messages, {
        currentActorId,
        onMessageCreated,
        onRoomAccessInvalidated,
        onTeamMdPublished,
      });
      lastAppliedRoomSeq = event.room_seq;
    },
    getLastAppliedRoomSeq() {
      return lastAppliedRoomSeq;
    },
  };
}

async function projectEvent(
  queryClient: QueryClient,
  tenantId: string,
  roomId: string,
  event: TeamHubRoomEvent,
  messages: Pick<TeamHubClient, "api"> | undefined,
  access: {
    currentActorId?: string;
    onMessageCreated?: (message: TeamHubMessage) => void;
    onRoomAccessInvalidated?: () => Promise<void> | void;
    onTeamMdPublished?: () => void;
  },
) {
  const payload = event.payload;

  switch (payload.kind) {
    case "card.changed":
      if (!messages) {
        throw new Error("Message client is unavailable.");
      }
      await hydrateChangedRoomMessage(
        queryClient,
        messages,
        tenantId,
        roomId,
        payload.message_id,
        payload.version,
      );
      return;
    case "message.created":
      appendRoomMessage(
        queryClient,
        roomMessagesQueryKey(tenantId, roomId),
        payload.message,
      );
      access.onMessageCreated?.(payload.message);
      // A created or renamed Agent must resolve before its notice links open
      // its profile; the directory delivery can arrive after the notice.
      if (
        payload.message.notice?.type === "agent_created" ||
        payload.message.notice?.type === "agent_profile_changed"
      ) {
        void refreshQueriesInBackground(queryClient, {
          queryKey: tenantActorsQueryKey(tenantId),
        });
        void refreshQueriesInBackground(queryClient, {
          queryKey: tenantAgentsQueryKey(tenantId),
        });
      }
      // The event omits Routine provenance, so read back only this Message,
      // off the event path: the network must not hold the event queue.
      if (
        messages &&
        payload.message.author.kind === "agent" &&
        payload.message.message_kind === "conversation"
      )
        void getMessage(messages, roomId, payload.message.id).then(
          (authoritative) =>
            replaceLoadedRoomMessage(
              queryClient,
              tenantId,
              roomId,
              authoritative,
            ),
          () =>
            refreshQueriesInBackground(queryClient, {
              queryKey: roomMessagesQueryKey(tenantId, roomId),
            }),
        );
      return;
    case "message.reactions.changed": {
      // The event carries the complete aggregate, so it replaces local state.
      const reactions = payload.reactions.length
        ? payload.reactions
        : undefined;
      patchLoadedMessageReactions(
        queryClient,
        tenantId,
        roomId,
        payload.message_id,
        () => reactions,
      );
      return;
    }
    case "message.thread_summary.updated":
      patchRoomMessageThread(
        queryClient,
        tenantId,
        roomId,
        payload.message_id,
        payload.thread,
      );
      return;
    case "room.participation.changed":
      await queryClient.invalidateQueries({
        queryKey: roomQueryKey(tenantId, roomId),
      });
      await queryClient.invalidateQueries({
        queryKey: tenantRoomsQueryKey(tenantId),
      });
      return;
    case "room.created":
    case "room.updated":
      queryClient.setQueryData<TeamHubRoom>(
        roomQueryKey(tenantId, roomId),
        (current) => ({
          ...payload.room,
          participation: current?.participation,
        }),
      );
      queryClient.setQueryData<TeamHubRoomPage>(
        tenantRoomsQueryKey(tenantId),
        (current) =>
          current
            ? {
                ...current,
                items: current.items.map((room) =>
                  room.id === payload.room.id
                    ? { ...room, ...payload.room }
                    : room,
                ),
              }
            : current,
      );
      return;
    case "room.deleted":
      await access.onRoomAccessInvalidated?.();
      return;
    case "room.member.removed":
      if (
        access.currentActorId &&
        payload.member.actor.id === access.currentActorId
      ) {
        await access.onRoomAccessInvalidated?.();
        return;
      }
      await refreshQueriesInBackground(queryClient, {
        queryKey: roomMembersQueryKey(tenantId, roomId),
      });
      return;
    case "room.member.added":
    case "room.member.role_changed":
      await refreshQueriesInBackground(queryClient, {
        queryKey: roomMembersQueryKey(tenantId, roomId),
      });
      return;
    case "document.created":
      await refreshQueriesInBackground(queryClient, {
        queryKey: roomDocumentsQueryKey(tenantId, roomId),
      });
      return;
    case "document.comment.changed":
      await refreshQueriesInBackground(queryClient, {
        queryKey: roomDocumentCommentThreadsQueryKey(
          tenantId,
          roomId,
          payload.document_id,
        ),
      });
      return;
    // The Run status transport follows agent_run.status_changed itself.
    case "agent_run.status_changed":
    case "capture.session.changed":
    case "room.history.compacted":
    case "message.hidden":
      return;
    case "work_item.changed":
      // A Task this Room's Meta delegated just started or changed.
      await Promise.all([
        refreshActiveQuery(
          queryClient,
          tenantWorkItemsDashboardQueryKey(tenantId),
        ),
        refreshActiveQuery(
          queryClient,
          roomBackgroundTasksQueryKey(tenantId, roomId),
        ),
      ]);
      return;
    case "routine.changed":
      await refreshActiveQuery(
        queryClient,
        roomRoutinesQueryKey(tenantId, roomId),
      );
      return;
    case "team_md.published":
      await refreshActiveQuery(
        queryClient,
        roomTeamMdQueryKey(tenantId, roomId),
      );
      access.onTeamMdPublished?.();
      return;
  }
}

async function refreshActiveQuery(
  queryClient: QueryClient,
  queryKey: QueryKey,
) {
  await refreshQueriesInBackground(queryClient, { queryKey });
}

function getMessage(
  messages: Pick<TeamHubClient, "api">,
  roomId: string,
  messageId: string,
) {
  return teamHubData(
    messages.api.GET("/v0/rooms/{roomId}/messages/{messageId}", {
      params: { path: { roomId, messageId } },
    }),
  );
}

async function hydrateChangedRoomMessage(
  queryClient: QueryClient,
  messages: Pick<TeamHubClient, "api">,
  tenantId: string,
  roomId: string,
  messageId: string,
  eventVersion: number,
) {
  const queryKey = roomMessagesQueryKey(tenantId, roomId);
  const current =
    queryClient.getQueryData<InfiniteData<TeamHubMessagePage>>(queryKey);
  const loaded = current?.pages
    .flatMap((page) => page.items)
    .find((message) => message.id === messageId);

  if (!loaded || (loaded.card?.version ?? 0) >= eventVersion) {
    return;
  }

  const authoritative = await getMessage(messages, roomId, messageId);
  replaceLoadedRoomMessage(queryClient, tenantId, roomId, authoritative);
}

export function replaceLoadedRoomMessage(
  queryClient: QueryClient,
  tenantId: string,
  roomId: string,
  authoritative: TeamHubMessage,
) {
  queryClient.setQueryData<InfiniteData<TeamHubMessagePage>>(
    roomMessagesQueryKey(tenantId, roomId),
    (cached) =>
      cached
        ? {
            ...cached,
            pages: cached.pages.map((page) => ({
              ...page,
              items: page.items.map((message) => {
                if (message.id !== authoritative.id) return message;
                if (
                  message.card &&
                  (!authoritative.card ||
                    message.card.version > authoritative.card.version)
                ) {
                  return message;
                }
                return authoritative;
              }),
            })),
          }
        : cached,
  );
}

export function patchRoomMessageThread(
  queryClient: QueryClient,
  tenantId: string,
  roomId: string,
  messageId: string,
  thread: TeamHubMessageThreadSummary,
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
                message.id === messageId ? { ...message, thread } : message,
              ),
            })),
          }
        : cached,
  );
  queryClient.setQueryData<TeamHubMessage>(
    roomMessageQueryKey(tenantId, roomId, messageId),
    (current) => (current ? { ...current, thread } : current),
  );
}

export function appendRoomMessage(
  queryClient: QueryClient,
  queryKey: QueryKey,
  message: TeamHubMessagePage["items"][number],
) {
  if (message.message_kind === "agent_runtime") {
    return;
  }
  queryClient.setQueryData<InfiniteData<TeamHubMessagePage>>(
    queryKey,
    (current) => {
      if (!current) {
        return current;
      }

      if (
        current.pages.some((page) =>
          page.items.some((item) => item.id === message.id),
        )
      ) {
        return current;
      }

      const [newestPage, ...olderPages] = current.pages;

      if (!newestPage) {
        return current;
      }

      return {
        ...current,
        pages: [
          { ...newestPage, items: [...newestPage.items, message] },
          ...olderPages,
        ],
      };
    },
  );
}
