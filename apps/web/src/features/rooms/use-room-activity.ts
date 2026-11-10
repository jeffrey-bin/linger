import { useQuery } from "@tanstack/react-query";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { tenantRoomActivityQueryKey } from "./room-queries";

const emptyRoomIds: readonly string[] = [];

export function useRoomActivity(tenantId: string, enabled: boolean) {
  const { client } = useTeamHubRuntime();
  const activity = useQuery({
    queryKey: tenantRoomActivityQueryKey(tenantId),
    queryFn: ({ signal }) =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/room-activity", {
          params: { path: { tenantId } },
          signal,
        }),
      ),
    enabled,
    staleTime: 5_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    retry: false,
  });

  if (!enabled || activity.isError || activity.isPaused) {
    return { failedRoomIds: emptyRoomIds, runningRoomIds: emptyRoomIds };
  }

  const runningRoomIds = activity.data?.running_room_ids ?? emptyRoomIds;
  const runningRooms = new Set(runningRoomIds);
  return {
    failedRoomIds: (activity.data?.failed_room_ids ?? emptyRoomIds).filter(
      (roomId) => !runningRooms.has(roomId),
    ),
    runningRoomIds,
  };
}
