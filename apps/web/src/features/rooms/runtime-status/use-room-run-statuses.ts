import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { reportTeamHubAuthenticationRequired } from "@/features/teamhub/teamhub-authentication";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubRunStatus,
  TeamHubRunStatusList,
} from "@/features/teamhub/teamhub-types";

import {
  roomRunStatusesQueryKey,
  roomRunStatusesQueryOptions,
  roomMessageRunStatusesQueryRoot,
  tenantRoomActivityQueryKey,
} from "../room-queries";

interface RoomRunStatusSubscription {
  enabled?: boolean;
  roomId: string;
  tenantId: string;
}

const emptyRunStatuses: readonly TeamHubRunStatus[] = [];

export function useRoomRunStatusCollection({
  enabled = true,
  roomId,
  tenantId,
}: RoomRunStatusSubscription) {
  const { client, runStatuses } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const subscriptionIdentity = useMemo(
    () => ({ client, enabled, runStatuses, roomId, tenantId }),
    [client, enabled, runStatuses, roomId, tenantId],
  );
  const [synchronizedIdentity, setSynchronizedIdentity] =
    useState<typeof subscriptionIdentity>();
  const runStatusQuery = useQuery({
    ...roomRunStatusesQueryOptions(client, tenantId, roomId),
    enabled: false,
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const runStatusQueryKey = roomRunStatusesQueryKey(tenantId, roomId);
    let previousActiveRunStatusIds = collectActiveRunStatusIds(
      queryClient.getQueryData<TeamHubRunStatusList>(runStatusQueryKey)
        ?.items ?? [],
    );
    return runStatuses.subscribe({
      onCollection: (items) => {
        queryClient.setQueryData(runStatusQueryKey, {
          items,
        });
        const activeRunStatusIds = collectActiveRunStatusIds(items);
        if (
          [...previousActiveRunStatusIds].some(
            (runStatusId) => !activeRunStatusIds.has(runStatusId),
          )
        ) {
          void queryClient.invalidateQueries({
            queryKey: roomMessageRunStatusesQueryRoot(tenantId, roomId),
          });
          void queryClient.invalidateQueries({
            queryKey: tenantRoomActivityQueryKey(tenantId),
          });
        }
        previousActiveRunStatusIds = activeRunStatusIds;
        setSynchronizedIdentity(subscriptionIdentity);
      },
      onSessionExpired: reportTeamHubAuthenticationRequired,
      roomId,
    });
  }, [
    enabled,
    runStatuses,
    queryClient,
    roomId,
    subscriptionIdentity,
    tenantId,
  ]);

  return {
    items: runStatusQuery.data?.items ?? emptyRunStatuses,
    synchronized: enabled && synchronizedIdentity === subscriptionIdentity,
  };
}

function collectActiveRunStatusIds(items: readonly TeamHubRunStatus[]) {
  const activeRunStatusIds = new Set<string>();
  for (const item of items) {
    if (item.status === "active") {
      activeRunStatusIds.add(item.id);
    }
  }
  return activeRunStatusIds;
}
