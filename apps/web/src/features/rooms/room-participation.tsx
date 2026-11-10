import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Login01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubRoom } from "@/features/teamhub/teamhub-types";
import {
  roomQueryKey,
  roomQueryOptions,
  roomQueriesKey,
  roomMessagesQueryKey,
  tenantRoomsQueryKey,
} from "./room-queries";

export function useRoomParticipation(room: TeamHubRoom) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (status: "joined" | "left") =>
      teamHubData(
        client.api.PUT("/v0/rooms/{roomId}/participation", {
          params: { path: { roomId: room.parent_room_id ?? room.id } },
          body: { status },
        }),
      ),
    onSuccess: async (updated) => {
      queryClient.setQueryData(
        roomQueryKey(room.tenant_id, updated.id),
        updated,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: roomQueriesKey(room.tenant_id),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantRoomsQueryKey(room.tenant_id),
        }),
        queryClient.invalidateQueries({
          queryKey: roomMessagesQueryKey(room.tenant_id, room.id),
        }),
      ]);
    },
  });
}

export function RoomRejoinBanner({ room }: { room: TeamHubRoom }) {
  const { client } = useTeamHubRuntime();
  const parent = useQuery({
    ...roomQueryOptions(client, room.tenant_id, room.parent_room_id ?? room.id),
    enabled: Boolean(room.parent_room_id),
  });
  const join = useRoomParticipation(room);
  const roomName = parent.data?.name ?? room.name;
  return (
    <div className="shrink-0 border-t border-app-border bg-app-surface p-4 text-center">
      <p className="mb-2 text-sm text-app-muted">
        You left this room. Rejoin to send and receive messages.
      </p>
      <Button
        tone="primary"
        className="w-full"
        disabled={join.isPending}
        onClick={() => join.mutate("joined")}
      >
        <Icon icon={Login01Icon} size={16} />
        {join.isPending ? "Joining..." : `Join ${roomName}`}
      </Button>
      {join.error ? (
        <p role="alert" className="mt-2 text-sm text-app-danger">
          {join.error.message}
        </p>
      ) : null}
    </div>
  );
}
