import { artifactPreviewCache } from "./files/artifact-preview-cache";
import {
  type InfiniteData,
  infiniteQueryOptions,
  queryOptions,
  replaceEqualDeep,
} from "@tanstack/react-query";

import {
  TeamHubError,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { collectTeamHubCursorPages } from "@/features/teamhub/teamhub-cursor-pages";
import type {
  TeamHubDocument,
  TeamHubMessage,
  TeamHubRunStatusList,
  TeamHubMessagePage,
  TeamHubRoom,
  TeamHubRoomMemberPage,
  TeamHubTenantAgentPage,
} from "@/features/teamhub/teamhub-types";

export const teamHubQueryRoot = ["teamhub"] as const;

export function isTenantTeamHubQuery(
  queryKey: readonly unknown[],
  tenantId: string,
): boolean {
  return (
    queryKey[0] === "teamhub" &&
    (queryKey[1] === tenantId || queryKey[2] === tenantId)
  );
}

export const teamHubSessionQueryKey = [...teamHubQueryRoot, "session"] as const;
export const teamHubIdentityQueryKey = [
  ...teamHubQueryRoot,
  "identity",
] as const;
export const teamHubTenantsQueryKey = [...teamHubQueryRoot, "tenants"] as const;

type RoomMessagesInfiniteData = InfiniteData<
  TeamHubMessagePage,
  string | undefined
>;
type RoomMessageCard = NonNullable<TeamHubMessagePage["items"][number]["card"]>;

export function teamHubTenantQueryKey(tenantId: string) {
  return [...teamHubQueryRoot, tenantId, "tenant"] as const;
}

export function tenantActorsQueryKey(tenantId: string) {
  return [...teamHubQueryRoot, tenantId, "actors"] as const;
}

export function tenantAgentsQueryKey(tenantId: string) {
  return [...teamHubQueryRoot, tenantId, "agents"] as const;
}

export function tenantAgentAvailabilityQueryKey(tenantId: string) {
  return [...teamHubQueryRoot, tenantId, "agent-availability"] as const;
}

export function anotherMeQueryKey(tenantId: string) {
  return [...teamHubQueryRoot, tenantId, "another-me"] as const;
}

export function tenantRoomsQueryKey(tenantId: string) {
  return [...teamHubQueryRoot, tenantId, "rooms"] as const;
}

export function tenantRoomActivityQueryKey(tenantId: string) {
  return [...teamHubQueryRoot, tenantId, "room-activity"] as const;
}

export function tenantFilesQueryKey(tenantId: string) {
  return [...teamHubQueryRoot, tenantId, "home-files"] as const;
}

export function roomQueriesKey(tenantId: string) {
  return [...teamHubQueryRoot, tenantId, "room"] as const;
}

export function roomQueryKey(tenantId: string, roomId: string) {
  return [...roomQueriesKey(tenantId), roomId] as const;
}

export function roomMembersQueryKey(tenantId: string, roomId: string) {
  return [...teamHubQueryRoot, tenantId, "room", roomId, "members"] as const;
}

export function roomDocumentsQueryKey(tenantId: string, roomId: string) {
  return [...teamHubQueryRoot, tenantId, "room", roomId, "documents"] as const;
}

export function roomRoutinesQueryKey(tenantId: string, roomId: string) {
  return [...teamHubQueryRoot, tenantId, "room", roomId, "routines"] as const;
}

export function roomTeamMdQueryKey(tenantId: string, roomId: string) {
  return [...teamHubQueryRoot, tenantId, "room", roomId, "team-md"] as const;
}

export function roomRunStatusesQueryKey(tenantId: string, roomId: string) {
  return [
    ...teamHubQueryRoot,
    tenantId,
    "room",
    roomId,
    "run-statuses",
  ] as const;
}

export function roomRuntimePresentationEventsQueryKey(
  tenantId: string,
  roomId: string,
  runStatusId: string,
) {
  return [
    ...roomRunStatusesQueryKey(tenantId, roomId),
    runStatusId,
    "runtime-presentation-events",
  ] as const;
}

export function roomMessageRunStatusesQueryKey(
  tenantId: string,
  roomId: string,
  messageIds: readonly string[],
) {
  return [
    ...roomMessageRunStatusesQueryRoot(tenantId, roomId),
    "messages",
    ...messageIds,
  ] as const;
}

export function roomMessageRunStatusesQueryRoot(
  tenantId: string,
  roomId: string,
) {
  return [
    ...roomRunStatusesQueryKey(tenantId, roomId),
    "runtime-presentation-history",
  ] as const;
}

export function roomDocumentQueryKey(
  tenantId: string,
  roomId: string,
  documentId: string,
) {
  return [
    ...teamHubQueryRoot,
    tenantId,
    "room",
    roomId,
    "document",
    documentId,
  ] as const;
}

export function documentQueryKey(tenantId: string, documentId: string) {
  return [...teamHubQueryRoot, tenantId, "document", documentId] as const;
}

export function roomDocumentCommentThreadsQueryKey(
  tenantId: string,
  roomId: string,
  documentId: string,
) {
  return [
    ...roomDocumentQueryKey(tenantId, roomId, documentId),
    "comment-threads",
  ] as const;
}

export function teamHubSessionQueryOptions(client: TeamHubClient) {
  return queryOptions({
    queryFn: ({ signal }) =>
      teamHubData(client.api.GET("/v0/session", { signal })),
    queryKey: teamHubSessionQueryKey,
    retry: false,
    staleTime: 30_000,
  });
}

export function teamHubIdentityQueryOptions(client: TeamHubClient) {
  return queryOptions({
    queryFn: () => teamHubData(client.api.GET("/v0/me")),
    queryKey: teamHubIdentityQueryKey,
    staleTime: 30_000,
  });
}

export function teamHubTenantsQueryOptions(client: TeamHubClient) {
  return queryOptions({
    queryFn: () => teamHubData(client.api.GET("/v0/tenants")),
    queryKey: teamHubTenantsQueryKey,
    staleTime: 30_000,
  });
}

export function teamHubTenantQueryOptions(
  client: TeamHubClient,
  tenantId: string,
) {
  return queryOptions({
    queryFn: async () => {
      const tenant = await teamHubData(
        client.api.GET("/v0/tenants/{tenantId}", {
          params: { path: { tenantId } },
        }),
      );
      return requireScope(tenant.id === tenantId, tenant);
    },
    queryKey: teamHubTenantQueryKey(tenantId),
    staleTime: 30_000,
  });
}

export function tenantActorsQueryOptions(
  client: TeamHubClient,
  tenantId: string,
) {
  return queryOptions({
    queryFn: () =>
      collectTeamHubCursorPages(async (page) => {
        const actors = await teamHubData(
          client.api.GET("/v0/tenants/{tenantId}/actors", {
            params: { path: { tenantId }, query: page },
          }),
        );
        return requireScope(
          actors.items.every((actor) => actor.tenant_id === tenantId),
          actors,
        );
      }),
    queryKey: tenantActorsQueryKey(tenantId),
    staleTime: 30_000,
  });
}

export function tenantAgentsQueryOptions(
  client: TeamHubClient,
  tenantId: string,
) {
  return queryOptions({
    queryFn: () =>
      collectTeamHubCursorPages(async (page) =>
        requireTenantAgentPageScope(
          await teamHubData(
            client.api.GET("/v0/tenants/{tenantId}/agents", {
              params: { path: { tenantId }, query: page },
            }),
          ),
          tenantId,
        ),
      ),
    queryKey: tenantAgentsQueryKey(tenantId),
    staleTime: 30_000,
  });
}

export function tenantAgentAvailabilityQueryOptions(
  client: TeamHubClient,
  tenantId: string,
) {
  return queryOptions({
    queryFn: () =>
      collectTeamHubCursorPages((page) =>
        teamHubData(
          client.api.GET("/v0/tenants/{tenantId}/agent-availability", {
            params: { path: { tenantId }, query: page },
          }),
        ),
      ),
    queryKey: tenantAgentAvailabilityQueryKey(tenantId),
    // Heartbeats are persisted observations. Poll only when Local Computers
    // are present so a lost lifecycle event cannot leave a stale Online label.
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.local_runtime_status)
        ? 5_000
        : false,
    staleTime: 2_000,
  });
}

export function anotherMeQueryOptions(client: TeamHubClient, tenantId: string) {
  return queryOptions({
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/another-me", {
          params: { path: { tenantId } },
        }),
      ),
    queryKey: anotherMeQueryKey(tenantId),
    staleTime: 30_000,
  });
}

export function tenantRoomsQueryOptions(
  client: TeamHubClient,
  tenantId: string,
) {
  return queryOptions({
    queryFn: () =>
      collectTeamHubCursorPages(async (page) => {
        const rooms = await teamHubData(
          client.api.GET("/v0/tenants/{tenantId}/rooms", {
            params: { path: { tenantId }, query: page },
          }),
        );
        return requireScope(
          rooms.items.every((room) => room.tenant_id === tenantId),
          rooms,
        );
      }),
    queryKey: tenantRoomsQueryKey(tenantId),
    staleTime: 10_000,
  });
}

export function roomQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  roomId: string,
) {
  return queryOptions({
    queryFn: async () =>
      requireRoomScope(
        await teamHubData(
          client.api.GET("/v0/rooms/{roomId}", {
            params: { path: { roomId } },
          }),
        ),
        tenantId,
        roomId,
      ),
    queryKey: roomQueryKey(tenantId, roomId),
    staleTime: 10_000,
  });
}

export function roomMembersQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  roomId: string,
) {
  return queryOptions({
    queryFn: async () => {
      let snapshotRoomSeq: number | undefined;
      let firstPage = true;
      const result = await collectTeamHubCursorPages(async (page) => {
        const current = requireMemberPageScope(
          await teamHubData(
            client.api.GET("/v0/rooms/{roomId}/members", {
              params: { path: { roomId }, query: page },
            }),
          ),
          tenantId,
          roomId,
        );
        // A later page cannot move the watermark past changes to earlier pages.
        snapshotRoomSeq = firstPage
          ? current.snapshot_room_seq
          : snapshotRoomSeq !== undefined &&
              current.snapshot_room_seq !== undefined
            ? Math.min(snapshotRoomSeq, current.snapshot_room_seq)
            : undefined;
        firstPage = false;
        return current;
      });
      return { ...result, snapshot_room_seq: snapshotRoomSeq };
    },
    queryKey: roomMembersQueryKey(tenantId, roomId),
    staleTime: 10_000,
  });
}

export function roomMessagesQueryKey(tenantId: string, roomId: string) {
  return [...teamHubQueryRoot, tenantId, "room", roomId, "messages"] as const;
}

export function roomMessageQueryKey(
  tenantId: string,
  roomId: string,
  messageId: string,
) {
  return [...roomMessagesQueryKey(tenantId, roomId), messageId] as const;
}

export function roomMessageQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  roomId: string,
  messageId: string,
) {
  return queryOptions({
    queryFn: async () =>
      requireMessageScope(
        await teamHubData(
          client.api.GET("/v0/rooms/{roomId}/messages/{messageId}", {
            params: { path: { roomId, messageId } },
          }),
        ),
        tenantId,
        roomId,
      ),
    queryKey: roomMessageQueryKey(tenantId, roomId, messageId),
    staleTime: 10_000,
  });
}

export function roomMessagesInfiniteQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  roomId: string,
) {
  return infiniteQueryOptions<
    TeamHubMessagePage,
    Error,
    RoomMessagesInfiniteData,
    ReturnType<typeof roomMessagesQueryKey>,
    string | undefined
  >({
    getNextPageParam: resolveNextMessagePageParam,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      requireMessagePageScope(
        await teamHubData(
          client.api.GET("/v0/rooms/{roomId}/messages", {
            params: {
              path: { roomId },
              query: { cursor: pageParam, limit: 50 },
            },
          }),
        ),
        tenantId,
        roomId,
      ),
    queryKey: roomMessagesQueryKey(tenantId, roomId),
    // Bootstrap + event catch-up own navigation recovery. Avoid a second
    // snapshot request when the same history mounts again moments later.
    staleTime: 10_000,
    structuralSharing: (cached, incoming) =>
      replaceEqualDeep(
        cached,
        reconcileRoomMessages(
          cached as RoomMessagesInfiniteData | undefined,
          incoming as RoomMessagesInfiniteData,
        ),
      ),
  });
}

export function roomDocumentsQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  roomId: string,
) {
  return queryOptions({
    queryFn: () =>
      collectTeamHubCursorPages(
        async (page) =>
          requireDocumentPageScope(
            await teamHubData(
              client.api.GET("/v0/rooms/{roomId}/documents", {
                params: { path: { roomId }, query: page },
              }),
            ),
            tenantId,
            roomId,
          ),
        { pageSize: 100 },
      ),
    queryKey: roomDocumentsQueryKey(tenantId, roomId),
    staleTime: 10_000,
  });
}

export function roomRoutinesQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  roomId: string,
) {
  return queryOptions({
    queryFn: () =>
      collectTeamHubCursorPages(
        async (page) =>
          teamHubData(
            client.api.GET("/v0/rooms/{roomId}/routines", {
              params: { path: { roomId }, query: page },
            }),
          ),
        { pageSize: 100 },
      ),
    queryKey: roomRoutinesQueryKey(tenantId, roomId),
    staleTime: 5_000,
  });
}

export function roomRunStatusesQueryOptions(
  client: Pick<TeamHubClient, "listRoomRunStatuses">,
  tenantId: string,
  roomId: string,
) {
  return queryOptions({
    queryFn: async () =>
      requireRunStatusListScope(
        await client.listRoomRunStatuses(roomId),
        tenantId,
        roomId,
      ),
    queryKey: roomRunStatusesQueryKey(tenantId, roomId),
    staleTime: 1_000,
  });
}

export function roomMessageRunStatusesQueryOptions(
  client: Pick<TeamHubClient, "listRoomRuntimePresentationRuns">,
  tenantId: string,
  roomId: string,
  messageIds: readonly string[],
) {
  return queryOptions({
    queryFn: async () =>
      requireRunStatusListScope(
        await client.listRoomRuntimePresentationRuns(roomId, messageIds),
        tenantId,
        roomId,
      ),
    queryKey: roomMessageRunStatusesQueryKey(tenantId, roomId, messageIds),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function roomDocumentQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  roomId: string,
  documentId: string,
) {
  return queryOptions({
    queryFn: async () =>
      requireDocumentScope(
        await teamHubData(
          client.api.GET("/v0/documents/{documentId}", {
            params: { path: { documentId } },
          }),
        ),
        tenantId,
        roomId,
        documentId,
      ),
    queryKey: roomDocumentQueryKey(tenantId, roomId, documentId),
    staleTime: 10_000,
  });
}

export function documentQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  documentId: string,
) {
  return queryOptions({
    queryFn: async () => {
      const document = await teamHubData(
        client.api.GET("/v0/documents/{documentId}", {
          params: { path: { documentId } },
        }),
      );
      return requireScope(
        document.id === documentId && document.tenant_id === tenantId,
        document,
      );
    },
    queryKey: documentQueryKey(tenantId, documentId),
    staleTime: 10_000,
  });
}

export function clearTeamHubQueries(queryClient: {
  removeQueries: (filters: { queryKey: readonly unknown[] }) => void;
}) {
  artifactPreviewCache.clear();
  queryClient.removeQueries({ queryKey: teamHubQueryRoot });
}

export function requireRoomScope(
  room: TeamHubRoom,
  tenantId: string,
  roomId: string,
) {
  return requireScope(room.id === roomId && room.tenant_id === tenantId, room);
}

function requireMemberPageScope(
  page: TeamHubRoomMemberPage,
  tenantId: string,
  roomId: string,
) {
  return requireScope(
    page.items.every(
      (member) =>
        member.room_id === roomId && member.actor.tenant_id === tenantId,
    ),
    page,
  );
}

function requireTenantAgentPageScope(
  page: TeamHubTenantAgentPage,
  tenantId: string,
) {
  return requireScope(
    page.items.every(
      (agent) =>
        agent.actor.tenant_id === tenantId &&
        agent.created_by.tenant_id === tenantId,
    ),
    page,
  );
}

function requireMessagePageScope(
  page: TeamHubMessagePage,
  tenantId: string,
  roomId: string,
) {
  return requireScope(
    page.items.every(
      (message) =>
        message.room_id === roomId &&
        message.tenant_id === tenantId &&
        message.author.tenant_id === tenantId,
    ),
    page,
  );
}

function requireRunStatusListScope(
  list: TeamHubRunStatusList,
  tenantId: string,
  roomId: string,
) {
  void tenantId;
  return requireScope(
    list.items.every((runStatus) => runStatus.room_id === roomId),
    list,
  );
}

function reconcileRoomMessages(
  cached: RoomMessagesInfiniteData | undefined,
  incoming: RoomMessagesInfiniteData,
) {
  if (!cached) return incoming;

  const cachedCards = new Map<string, RoomMessageCard>();
  const incomingMessageIds = new Set(
    incoming.pages.flatMap((page) => page.items.map((message) => message.id)),
  );
  const newestIncomingMessage = incoming.pages[0]?.items.at(-1);
  const concurrentMessages = new Map<string, TeamHubMessage>();
  for (const page of cached.pages) {
    for (const message of page.items) {
      if (
        !incomingMessageIds.has(message.id) &&
        (!newestIncomingMessage ||
          compareMessages(message, newestIncomingMessage) > 0)
      ) {
        concurrentMessages.set(message.id, message);
      }
      if (!message.card) continue;
      const current = cachedCards.get(message.id);
      if (!current || message.card.version > current.version) {
        cachedCards.set(message.id, message.card);
      }
    }
  }

  const pages = incoming.pages.map((page) => ({
    ...page,
    items: page.items.map((message) => {
      const cachedCard = cachedCards.get(message.id);
      if (
        !cachedCard ||
        (message.card && message.card.version >= cachedCard.version)
      ) {
        return message;
      }
      return { ...message, card: cachedCard };
    }),
  }));
  const newestPage = pages[0];
  if (newestPage && concurrentMessages.size > 0) {
    pages[0] = {
      ...newestPage,
      items: [
        ...newestPage.items,
        ...Array.from(concurrentMessages.values()).sort(compareMessages),
      ],
    };
  }

  return {
    ...incoming,
    pages,
  };
}

function compareMessages(left: TeamHubMessage, right: TeamHubMessage) {
  if (left.created_at !== right.created_at) {
    return left.created_at < right.created_at ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function requireMessageScope(
  message: TeamHubMessage,
  tenantId: string,
  roomId: string,
) {
  return requireScope(
    message.room_id === roomId &&
      message.tenant_id === tenantId &&
      message.author.tenant_id === tenantId,
    message,
  );
}

function requireDocumentPageScope(
  page: {
    items: TeamHubDocument[];
    page: { has_more: boolean; next_cursor?: string };
  },
  tenantId: string,
  roomId: string,
) {
  return requireScope(
    page.items.every(
      (document) =>
        document.tenant_id === tenantId &&
        document.from.some(
          (source) =>
            source.binding_kind === "room" && source.context_id === roomId,
        ),
    ),
    page,
  );
}

function requireDocumentScope(
  document: TeamHubDocument,
  tenantId: string,
  roomId: string,
  documentId: string,
) {
  return requireScope(
    document.id === documentId &&
      document.tenant_id === tenantId &&
      document.from.some(
        (source) =>
          source.binding_kind === "room" && source.context_id === roomId,
      ),
    document,
  );
}

function requireScope<T>(matches: boolean, value: T): T {
  if (!matches) {
    throw new TeamHubError({
      code: "RESOURCE_NOT_FOUND",
      message: "The requested TeamHub resource is unavailable.",
      status: 404,
    });
  }

  return value;
}

const maximumMessagePageCount = 100;
const maximumMessageCount = 20_000;

function resolveNextMessagePageParam(
  lastPage: TeamHubMessagePage,
  allPages: TeamHubMessagePage[],
  lastPageParam: string | undefined,
  allPageParams: Array<string | undefined>,
) {
  const messageCount = allPages.reduce(
    (total, page) => total + page.items.length,
    0,
  );
  if (
    allPages.length > maximumMessagePageCount ||
    messageCount > maximumMessageCount ||
    (lastPage.page.has_more &&
      (allPages.length === maximumMessagePageCount ||
        messageCount === maximumMessageCount))
  ) {
    throw new TeamHubError({
      code: "PAGINATION_LIMIT_EXCEEDED",
      message: "TeamHub returned more Room history than this client can load.",
      status: 502,
    });
  }

  if (!lastPage.page.has_more) {
    return undefined;
  }

  const nextCursor = lastPage.page.next_cursor;
  if (
    !nextCursor?.trim() ||
    nextCursor === lastPageParam ||
    allPageParams.includes(nextCursor)
  ) {
    throw new TeamHubError({
      code: "INVALID_PAGINATION",
      message: "TeamHub returned an invalid Room Message cursor.",
      status: 502,
    });
  }

  return nextCursor;
}
