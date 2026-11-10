import { queryOptions } from "@tanstack/react-query";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import {
  TeamHubError,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";

import { roomTeamMdQueryKey } from "../room-queries";

export function roomTeamMdQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  roomId: string,
) {
  return queryOptions({
    queryKey: roomTeamMdQueryKey(tenantId, roomId),
    queryFn: async () => {
      try {
        return await teamHubData(
          client.api.GET("/v0/rooms/{roomId}/team-md", {
            params: { path: { roomId } },
          }),
        );
      } catch (error) {
        if (error instanceof TeamHubError && error.status === 404) return null;
        throw error;
      }
    },
    staleTime: 0,
    retry: false,
  });
}
