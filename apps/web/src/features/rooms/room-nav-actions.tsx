import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Delete02Icon, PinIcon, PinOffIcon } from "@hugeicons/core-free-icons";
import { lazy, Suspense, useState } from "react";
import { createPortal } from "react-dom";

import { ActionMenu } from "@/components/ui/action-menu";
import { Icon } from "@/components/ui/icon";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubRoomListItem,
  TeamHubRoomPage,
} from "@/features/teamhub/teamhub-types";

import { canDeleteTenantAgent } from "./members/agent-permissions";
import {
  teamHubIdentityQueryOptions,
  tenantAgentsQueryOptions,
  tenantRoomsQueryKey,
} from "./room-queries";

const AgentDeleteDialog = lazy(async () => ({
  default: (await import("./room-nav-agent-delete-dialog"))
    .RoomNavAgentDeleteDialog,
}));

/** Pinned Rooms lead their section, the most recently pinned first. */
export function pinnedFirst(rooms: TeamHubRoomListItem[]) {
  const pinned = rooms
    .filter((room) => room.pinned_at)
    .sort((left, right) =>
      (right.pinned_at ?? "").localeCompare(left.pinned_at ?? ""),
    );
  return [...pinned, ...rooms.filter((room) => !room.pinned_at)];
}

export function useRoomPin(tenantId: string) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const queryKey = tenantRoomsQueryKey(tenantId);
  const applyPin = (roomId: string, pinnedAt: string | undefined) =>
    queryClient.setQueryData<TeamHubRoomPage>(queryKey, (current) =>
      current
        ? {
            ...current,
            items: current.items.map((room) =>
              room.id === roomId ? { ...room, pinned_at: pinnedAt } : room,
            ),
          }
        : current,
    );
  return useMutation({
    mutationFn: (intent: { pinned: boolean; roomId: string }) =>
      teamHubData(
        client.api.PUT("/v0/rooms/{roomId}/pin", {
          params: { path: { roomId: intent.roomId } },
          body: { pinned: intent.pinned },
        }),
      ),
    // The row moves at once; the server's pin time replaces the guess. An
    // in-flight list read is cancelled so it can't land on top of the guess.
    onMutate: async ({ pinned, roomId }) => {
      await queryClient.cancelQueries({ queryKey });
      applyPin(roomId, pinned ? new Date().toISOString() : undefined);
    },
    onSuccess: (state) => applyPin(state.room_id, state.pinned_at),
    onError: () => queryClient.invalidateQueries({ queryKey }),
  });
}

// Row actions sit flat until the pointer is on the icon itself (or its menu is
// open); the row's own hover tint is enough to announce them.
const roomNavActionClass =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground aria-expanded:bg-foreground/5 aria-expanded:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function RoomPinButton({
  name,
  onToggle,
  pinned,
}: {
  name: string;
  onToggle: () => void;
  pinned: boolean;
}) {
  const label = `${pinned ? "Unpin" : "Pin"} ${name}`;
  return (
    <button
      aria-label={label}
      className={roomNavActionClass}
      onClick={onToggle}
      title={pinned ? "Unpin" : "Pin"}
      type="button"
    >
      {pinned ? (
        <Icon icon={PinOffIcon} size={14} />
      ) : (
        <Icon icon={PinIcon} size={14} />
      )}
    </button>
  );
}

/** The Agent chat row's menu: pin state, then removing the Agent itself. */
export function AgentRowMenu({
  agentId,
  name,
  onTogglePin,
  pinned,
  tenantId,
}: {
  agentId: string | undefined;
  name: string;
  onTogglePin: () => void;
  pinned: boolean;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const [deleting, setDeleting] = useState(false);
  const { data: identity } = useQuery(teamHubIdentityQueryOptions(client));
  const { data: agents } = useQuery({
    ...tenantAgentsQueryOptions(client, tenantId),
    enabled: agentId !== undefined,
  });
  const currentActorId = identity?.actors.find(
    (actor) => actor.tenant_id === tenantId,
  )?.id;
  const registration = agents?.items.find(
    (agent) => agent.actor.id === agentId,
  );
  const canDelete = canDeleteTenantAgent(registration, currentActorId);
  return (
    <>
      <ActionMenu
        buttonClassName={roomNavActionClass}
        items={[
          {
            icon: pinned ? (
              <Icon icon={PinOffIcon} size={14} />
            ) : (
              <Icon icon={PinIcon} size={14} />
            ),
            label: pinned ? "Unpin" : "Pin",
            onSelect: onTogglePin,
          },
          {
            danger: true,
            disabled: !canDelete,
            icon: <Icon icon={Delete02Icon} size={14} />,
            label: "Delete",
            onSelect: () => setDeleting(true),
            separatorBefore: true,
          },
        ]}
        label={`More actions for ${name}`}
        placement="right-start"
      />
      {deleting && agentId && registration
        ? // The row's action strip is pointer-events: none whenever the
          // pointer leaves the row, and that is inherited through the DOM
          // even by a top-layer dialog, so the dialog lives outside the row.
          createPortal(
            <Suspense fallback={null}>
              <AgentDeleteDialog
                agentId={agentId}
                name={name}
                onClose={() => setDeleting(false)}
                tenantId={tenantId}
              />
            </Suspense>,
            document.body,
          )
        : null}
    </>
  );
}
