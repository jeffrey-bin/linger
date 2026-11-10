import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { classifyTeamHubCommandFailure } from "@/features/teamhub/teamhub-command-outcome";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubRoomCreateInput } from "@/features/teamhub/teamhub-types";

import { requireRoomScope, tenantRoomsQueryOptions } from "./room-queries";

export function RoomCreateDialog({
  onClose,
  tenantId,
}: {
  onClose: () => void;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const [name, setName] = useState("");
  const createRoom = useMutation({
    mutationFn: (input: TeamHubRoomCreateInput) =>
      teamHubData(
        client.api.POST("/v0/tenants/{tenantId}/rooms", {
          params: { path: { tenantId } },
          body: input,
        }),
      ).then((room) => requireRoomScope(room, tenantId, room.id)),
    onSuccess: async (room) => {
      await queryClient.invalidateQueries({
        queryKey: tenantRoomsQueryOptions(client, tenantId).queryKey,
      });
      onClose();
      await navigate(`/t/${tenantId}/rooms/${room.id}/chat`, {
        state: { newRoomId: room.id },
      });
    },
  });
  // Warn while typing like Slack does, so a duplicate name is caught before
  // submitting; the server ROOM_NAME_TAKEN conflict stays the authority.
  const rooms = useQuery(tenantRoomsQueryOptions(client, tenantId));
  const trimmedName = name.trim();
  const duplicateName =
    trimmedName.length > 0 &&
    (rooms.data?.items ?? []).some(
      (room) =>
        room.kind === "room" &&
        room.name.trim().toLocaleLowerCase() ===
          trimmedName.toLocaleLowerCase(),
    );

  const failure = createRoom.error
    ? classifyTeamHubCommandFailure(
        createRoom.error,
        "this Room was created",
        "Check your Rooms before you retry.",
      )
    : null;
  // Names only have to be unique among the Rooms this Human is in, so the
  // conflicting Room is always one they can see.
  const nameTakenMessage =
    "You already have a Room with this name. Choose a different name.";
  const failureMessage = duplicateName
    ? nameTakenMessage
    : createRoom.error instanceof Error &&
        "code" in createRoom.error &&
        createRoom.error.code === "ROOM_NAME_TAKEN"
      ? nameTakenMessage
      : failure?.message;

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (name.trim() && !duplicateName) {
      const input: TeamHubRoomCreateInput = {
        name: name.trim(),
      };
      createRoom.mutate(input);
    }
  }

  return (
    <ModalDialog
      onClose={onClose}
      size="md"
      title="Create Room"
      footer={
        <Button
          disabled={!trimmedName || duplicateName}
          form={formId}
          loading={createRoom.isPending}
          tone="primary"
          type="submit"
        >
          Create Room
        </Button>
      }
    >
      <form className="px-5 py-4" id={formId} onSubmit={handleSubmit}>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-app-ink">
            Room name
          </span>
          <input
            aria-invalid={duplicateName || undefined}
            className={`ui-field-control w-full ${
              duplicateName ? "!border-app-danger" : ""
            }`}
            disabled={createRoom.isPending}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            placeholder="Room name"
            ref={nameInputRef}
            value={name}
          />
        </label>

        {failureMessage ? (
          <p className="mt-3 text-sm text-app-danger" role="alert">
            {failureMessage}
          </p>
        ) : null}
      </form>
    </ModalDialog>
  );
}
