import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";

import { localComputersQueryKey } from "@/features/local-computer/local-computer-queries";
import { teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubRoom } from "@/features/teamhub/teamhub-types";

import {
  roomQueryKey,
  teamHubQueryRoot,
  tenantActorsQueryKey,
  tenantAgentsQueryKey,
  tenantRoomsQueryKey,
} from "../room-queries";

export function useAgentDeletion(
  tenantId: string,
  actorId: string,
  onDeleted: () => void,
) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { roomId } = useParams();
  return useMutation({
    mutationFn: async () => {
      const currentRoom = roomId
        ? queryClient.getQueryData<TeamHubRoom>(roomQueryKey(tenantId, roomId))
        : undefined;
      await teamHubDone(
        client.api.DELETE("/v0/tenants/{tenantId}/agents/{agentId}", {
          params: { path: { tenantId, agentId: actorId } },
        }),
      );
      return currentRoom?.kind === "direct" &&
        currentRoom.direct_peer?.id === actorId
        ? currentRoom.id
        : undefined;
    },
    onSuccess: async (deletedRoomId) => {
      onDeleted();
      if (deletedRoomId) {
        queryClient.removeQueries({
          queryKey: roomQueryKey(tenantId, deletedRoomId),
        });
        await navigate(`/t/${tenantId}/rooms`, { replace: true });
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: tenantRoomsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantActorsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantAgentsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: [...teamHubQueryRoot, tenantId, "room"],
        }),
        queryClient.invalidateQueries({
          queryKey: localComputersQueryKey(tenantId),
        }),
      ]);
    },
  });
}
