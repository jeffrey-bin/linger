import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { classifyTeamHubCommandFailure } from "@/features/teamhub/teamhub-command-outcome";
import { teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubRoom,
  TeamHubRoomPage,
} from "@/features/teamhub/teamhub-types";

import { roomQueryKey, tenantRoomsQueryKey } from "./room-queries";

export function RoomDeleteDialog({
  onClose,
  room,
  tenantId,
}: {
  onClose: () => void;
  room: TeamHubRoom;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirmationInputRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const [confirmation, setConfirmation] = useState("");
  const mountedRef = useRef(false);
  const deletionConfirmedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (deletionConfirmedRef.current) {
        queryClient.removeQueries({
          queryKey: roomQueryKey(tenantId, room.id),
        });
      }
    };
  }, [queryClient, room.id, tenantId]);
  const deleteRoom = useMutation({
    mutationFn: () =>
      teamHubDone(
        client.api.DELETE("/v0/rooms/{roomId}", {
          params: { path: { roomId: room.id } },
        }),
      ),
    onSuccess: async () => {
      deletionConfirmedRef.current = true;
      // A confirmation can arrive after the user has already left this Room.
      if (!mountedRef.current) {
        queryClient.removeQueries({
          queryKey: roomQueryKey(tenantId, room.id),
        });
      }
      queryClient.setQueryData<TeamHubRoomPage>(
        tenantRoomsQueryKey(tenantId),
        (current) =>
          current
            ? {
                ...current,
                items: current.items.filter(
                  (candidate) => candidate.id !== room.id,
                ),
              }
            : current,
      );
      // The navigation promise can resolve before React commits the new route.
      // The unmount cleanup above owns cache removal while this view is mounted.
      await navigate(`/t/${tenantId}/rooms`, { replace: true });
    },
  });
  const failure = deleteRoom.error
    ? classifyTeamHubCommandFailure(
        deleteRoom.error,
        "this Room was deleted",
        "Check your Rooms before you retry.",
      )
    : null;

  useEffect(() => {
    confirmationInputRef.current?.focus();
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation !== room.name) {
      return;
    }
    deleteRoom.mutate();
  }

  return (
    <ModalDialog
      description="Every member will lose access to this Room. Its messages, files, and history will no longer be available."
      onClose={() => {
        if (!deleteRoom.isPending) {
          onClose();
        }
      }}
      size="sm"
      title="Delete Room"
      footer={
        <>
          <Button disabled={deleteRoom.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={confirmation !== room.name}
            form={formId}
            loading={deleteRoom.isPending}
            tone="danger"
            type="submit"
          >
            <Icon icon={Delete02Icon} size={16} />
            Delete Room
          </Button>
        </>
      }
    >
      <form className="px-5 py-4" id={formId} onSubmit={handleSubmit}>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-app-ink">
            Type <strong>{room.name}</strong> to confirm
          </span>
          <input
            aria-label="Room name confirmation"
            autoComplete="off"
            className="ui-field-control w-full"
            disabled={deleteRoom.isPending}
            onChange={(event) => setConfirmation(event.target.value)}
            ref={confirmationInputRef}
            value={confirmation}
          />
        </label>

        {failure ? (
          <p className="mt-3 text-sm text-app-danger" role="alert">
            {failure.message}
          </p>
        ) : null}
      </form>
    </ModalDialog>
  );
}
