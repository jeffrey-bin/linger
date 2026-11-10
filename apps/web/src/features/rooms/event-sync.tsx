import { refreshQueriesInBackground } from "@/features/teamhub/background-query-refresh";
import { artifactPreviewCache } from "./files/artifact-preview-cache";
import {
  type QueryClient,
  type QueryKey,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

import {
  externalConnectionsQueryKey,
  tenantExternalConnectionsQueryKey,
} from "@/features/apps/connected-apps-queries";
import { localComputersQueryKey } from "@/features/local-computer/local-computer-queries";
import { teamHubDocumentsQueryKey } from "@/features/teamhub/document-queries";
import type { TeamHubEventSignal } from "@/features/teamhub/event-transport";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubResourceInvalidation,
  TeamHubRoomEvent,
} from "@/features/teamhub/teamhub-types";

import {
  anotherMeQueryKey,
  isTenantTeamHubQuery,
  roomQueriesKey,
  roomQueryKey,
  tenantActorsQueryKey,
  tenantAgentAvailabilityQueryKey,
  tenantAgentsQueryKey,
  tenantRoomActivityQueryKey,
  tenantRoomsQueryKey,
} from "./room-queries";

/**
 * Applies the /v0/events signals to TanStack Query: Room Events and
 * invalidation hints refresh the queries they name, and a resync refreshes
 * every displayed TeamHub query once. Displayed Room timelines follow their
 * own Room cursor subscriptions.
 */
export function TeamHubEventSync() {
  const { events } = useTeamHubRuntime();
  const queryClient = useQueryClient();

  useEffect(
    () =>
      events.subscribeSignals((signal) => {
        void applyTeamHubEventSignal(queryClient, signal);
      }),
    [events, queryClient],
  );

  return null;
}

export async function applyTeamHubEventSignal(
  queryClient: QueryClient,
  signal: TeamHubEventSignal,
) {
  if (signal.type === "stream.resync") {
    // Inactive queries are marked stale and reload when they mount again.
    await refreshQueriesInBackground(queryClient, {
      predicate: (query) => query.queryKey[0] === "teamhub",
    });
    return;
  }
  if (signal.type === "room.event") {
    await applyRoomEvent(queryClient, signal.event);
    return;
  }
  await applyInvalidation(queryClient, signal.hint);
}

const roomDirectoryEventKinds = new Set([
  "message.created",
  "room.created",
  "room.updated",
  "room.participation.changed",
  "room.deleted",
  "room.member.added",
  "room.member.removed",
  "room.member.role_changed",
]);

// Room Events of a displayed Room; other Rooms arrive as room hints.
async function applyRoomEvent(
  queryClient: QueryClient,
  event: TeamHubRoomEvent,
) {
  const tenantId = event.tenant_id;
  await Promise.all([
    event.event_type === "room.participation.changed"
      ? queryClient.invalidateQueries({ queryKey: roomQueriesKey(tenantId) })
      : undefined,
    roomDirectoryEventKinds.has(event.event_type)
      ? refreshQueriesInBackground(queryClient, {
          exact: true,
          queryKey: tenantRoomsQueryKey(tenantId),
        })
      : undefined,
    // A message moves the Tenant's Room activity, not Agent availability; the
    // Runs it wakes announce their own status.
    event.event_type === "message.created"
      ? refreshActiveQueries(queryClient, [
          tenantRoomActivityQueryKey(tenantId),
        ])
      : undefined,
    event.event_type === "work_item.changed"
      ? refreshWorkItems(queryClient, tenantId)
      : undefined,
  ]);
}

async function applyInvalidation(
  queryClient: QueryClient,
  hint: TeamHubResourceInvalidation,
) {
  const tenantId = hint.tenant_id;
  switch (hint.resource) {
    case "room":
      // A Room the stream follows by cursor sends Room Events, not hints, so
      // a hint names a Room shown without one, such as a Room the Account
      // left; rereading it is how that view learns of a rejoin.
      await Promise.all([
        refreshQueriesInBackground(queryClient, {
          exact: true,
          queryKey: tenantRoomsQueryKey(tenantId),
        }),
        refreshQueriesInBackground(queryClient, {
          exact: true,
          queryKey: roomQueryKey(tenantId, hint.id),
        }),
        refreshAgentStatus(queryClient, tenantId),
        refreshWorkItems(queryClient, tenantId),
      ]);
      return;
    case "directory":
      await Promise.all([
        refreshActiveQueries(queryClient, [
          tenantActorsQueryKey(tenantId),
          tenantAgentsQueryKey(tenantId),
          // Room rows carry their Direct peer's name, so a renamed Actor
          // renames its Chat row too.
          tenantRoomsQueryKey(tenantId),
          ...findQueryKeys(
            queryClient,
            (queryKey) =>
              queryKey.length === 5 &&
              isTenantTeamHubQuery(queryKey, tenantId) &&
              queryKey[2] === "room" &&
              queryKey[4] === "members",
          ),
        ]),
        refreshAgentStatus(queryClient, tenantId),
      ]);
      return;
    case "agents":
    case "computers":
      await Promise.all([
        refreshAgentStatus(queryClient, tenantId),
        refreshActiveQueries(queryClient, [localComputersQueryKey(tenantId)]),
      ]);
      return;
    case "another-me":
      // A new Another Me joins the directory and brings its Chat.
      await Promise.all([
        refreshActiveQueries(queryClient, [
          anotherMeQueryKey(tenantId),
          tenantActorsQueryKey(tenantId),
          tenantAgentsQueryKey(tenantId),
          tenantRoomsQueryKey(tenantId),
        ]),
        refreshAgentStatus(queryClient, tenantId),
      ]);
      return;
    case "connections":
      await refreshActiveQueries(queryClient, [
        externalConnectionsQueryKey(),
        tenantExternalConnectionsQueryKey(tenantId),
      ]);
      return;
    case "work-items":
      await Promise.all([
        refreshWorkItems(queryClient, tenantId),
        refreshAgentStatus(queryClient, tenantId),
      ]);
      return;
    case "document-access":
      // Access may have been revoked: no retained preview bytes outlive it.
      artifactPreviewCache.clear();
      await refreshDocument(queryClient, hint.id);
      return;
    case "document":
      await refreshDocument(queryClient, hint.id);
      return;
  }
}

function refreshDocument(queryClient: QueryClient, documentId: string) {
  return Promise.all([
    refreshQueriesInBackground(queryClient, {
      queryKey: teamHubDocumentsQueryKey,
    }),
    refreshQueriesInBackground(queryClient, {
      predicate: (query) => query.queryKey.includes(documentId),
    }),
  ]);
}

// Agent availability and Room activity.
function refreshAgentStatus(queryClient: QueryClient, tenantId: string) {
  return refreshActiveQueries(queryClient, [
    tenantAgentAvailabilityQueryKey(tenantId),
    tenantRoomActivityQueryKey(tenantId),
  ]);
}

// The Work Item dashboard, details, and Task lists of the Tenant.
function refreshWorkItems(queryClient: QueryClient, tenantId: string) {
  return refreshActiveQueries(queryClient, [
    ["teamhub", tenantId, "work-items"],
    ["teamhub", tenantId, "tasks"],
  ]);
}

function findQueryKeys(
  queryClient: QueryClient,
  matches: (queryKey: QueryKey) => boolean,
) {
  return queryClient
    .getQueryCache()
    .findAll({ predicate: (query) => matches(query.queryKey) })
    .map((query) => query.queryKey);
}

async function refreshActiveQueries(
  queryClient: QueryClient,
  queryKeys: readonly QueryKey[],
) {
  await Promise.all(
    queryKeys.map((queryKey) =>
      refreshQueriesInBackground(queryClient, { queryKey }),
    ),
  );
}
