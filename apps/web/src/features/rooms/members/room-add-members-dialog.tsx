import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubActor } from "@/features/teamhub/teamhub-types";
import {
  roomMembersQueryOptions,
  tenantRoomsQueryOptions,
} from "../room-queries";
import { RoomCreateMembers } from "./room-create-members";
import { RoomMemberAvatars } from "./room-member-avatars";

export function RoomAddMembersDialog({
  onClose,
  roomId,
  tenantId,
}: {
  onClose: () => void;
  roomId: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<TeamHubActor[]>([]);
  // Closing without adding anyone confirms first, so the Room owner learns where
  // members can be added later instead of losing the step silently.
  const [confirmSkip, setConfirmSkip] = useState(false);
  const members = useQuery(roomMembersQueryOptions(client, tenantId, roomId));
  const submit = useMutation({
    // Each member is independent: whatever succeeds stays applied and only the
    // failures remain queued for a retry.
    mutationFn: async () => {
      const results = await Promise.allSettled(
        selected.map((actor) =>
          teamHubData(
            client.api.PUT("/v0/rooms/{roomId}/members/{actorId}", {
              params: { path: { roomId, actorId: actor.id } },
              body: { role: "member" },
            }),
          ),
        ),
      );
      const failedActors = selected.filter(
        (_, index) => results[index]!.status === "rejected",
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: roomMembersQueryOptions(client, tenantId, roomId).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: tenantRoomsQueryOptions(client, tenantId).queryKey,
        }),
      ]);
      return { failedActors };
    },
    onSuccess: ({ failedActors }) => {
      const failedActorIds = new Set(failedActors.map((actor) => actor.id));
      setSelected(selected.filter((actor) => failedActorIds.has(actor.id)));
      if (failedActors.length === 0) onClose();
    },
  });
  const nothingQueued = selected.length === 0;

  return (
    <ModalDialog
      onClose={() => {
        if (submit.isPending) return;
        if (nothingQueued) setConfirmSkip((current) => !current);
        else onClose();
      }}
      size="md"
      title="Add Room members"
      footer={
        confirmSkip ? (
          <>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the field is focused on purpose because the user just opened this dialog or inline editor */}
            <Button autoFocus onClick={() => setConfirmSkip(false)}>
              Go back
            </Button>
            <Button tone="primary" onClick={onClose}>
              Skip for now
            </Button>
          </>
        ) : (
          <Button
            tone="primary"
            onClick={() => submit.mutate()}
            disabled={nothingQueued}
            loading={submit.isPending}
          >
            Add members
          </Button>
        )
      }
    >
      <div className="px-5 py-4">
        <div
          inert={confirmSkip || undefined}
          className={`space-y-4 ${confirmSkip ? "opacity-40" : ""}`}
        >
          <RoomCreateMembers
            disabled={submit.isPending}
            selected={selected}
            onChange={setSelected}
            tenantId={tenantId}
          />
          {submit.data?.failedActors.length ? (
            <p role="alert" className="text-sm text-app-danger">
              Could not add{" "}
              {submit.data.failedActors
                .map((actor) => actor.display_name)
                .join(", ")}
              . Retry these members; successful additions are already saved.
            </p>
          ) : null}
          {submit.error ? (
            <p role="alert" className="text-sm text-app-danger">
              {submit.error.message}
            </p>
          ) : null}
        </div>
        {confirmSkip ? (
          <section
            aria-label="Skip adding members"
            aria-live="polite"
            className="mt-4 border-t border-border pt-4"
          >
            <p className="text-sm leading-6 text-app-body">
              <strong>Skip adding members?</strong> You can add people and
              agents later using the member avatar list{" "}
              <span
                aria-label="Room member avatar list"
                className="room-members-trigger mx-1 inline-flex items-center rounded-full border border-border p-1 align-middle"
              >
                <RoomMemberAvatars
                  actors={
                    members.data?.items.map((member) => member.actor) ?? []
                  }
                />
              </span>{" "}
              at the top right of this room.
            </p>
          </section>
        ) : null}
      </div>
    </ModalDialog>
  );
}
