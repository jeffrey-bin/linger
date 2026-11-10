import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import {
  tenantActorsQueryKey,
  tenantAgentsQueryKey,
  tenantRoomsQueryKey,
} from "../room-queries";

import { CreateAgentFromTemplateDialog } from "./create-agent-from-template-dialog";

/**
 * Owns the runtime and cache wiring for template creation so navigation
 * surfaces only hold the open state and stay free of these dependencies.
 */
export function CreateAgentFromTemplateFlow({
  onClose,
  tenantId,
}: {
  onClose: () => void;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <CreateAgentFromTemplateDialog
      onClose={onClose}
      onCreated={async (actor) => {
        await Promise.all(
          [tenantActorsQueryKey, tenantAgentsQueryKey, tenantRoomsQueryKey].map(
            (queryKey) =>
              queryClient.invalidateQueries({ queryKey: queryKey(tenantId) }),
          ),
        );
        const { id: roomId } = await teamHubData(
          client.api.POST("/v0/tenants/{tenantId}/direct-rooms", {
            params: { path: { tenantId } },
            body: { peer_actor_id: actor.id },
          }),
        );
        await queryClient.invalidateQueries({
          queryKey: tenantRoomsQueryKey(tenantId),
        });
        onClose();
        void navigate(`/t/${tenantId}/rooms/${roomId}/chat`, {
          state: { focusComposer: true },
        });
      }}
      tenantId={tenantId}
    />
  );
}
