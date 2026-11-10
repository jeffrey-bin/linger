import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import type { RoomRealtimeStatus } from "@/features/teamhub/event-transport";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubMessage,
  TeamHubRoomPage,
} from "@/features/teamhub/teamhub-types";

import { roomQueryKey, tenantRoomsQueryKey } from "../room-queries";
import { createRoomProjection } from "./room-projection";

/** How long joining or catching up may take before the header says so. */
const STATUS_GRACE_MS = 1_500;

export function RoomRealtimeSync({
  currentActorId,
  initialRoomSeq = 0,
  onAppliedRoomSeq,
  onMessageCreated,
  onStatusChange,
  onTeamMdPublished,
  roomId,
  tenantId,
}: {
  currentActorId?: string;
  initialRoomSeq?: number;
  onAppliedRoomSeq?: (roomSeq: number) => void;
  onMessageCreated?: (message: TeamHubMessage) => void;
  onStatusChange?: (status: RoomRealtimeStatus) => void;
  onTeamMdPublished?: () => void;
  roomId: string;
  tenantId: string;
}) {
  const { client, events } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [status, setStatus] = useState<RoomRealtimeStatus>("catching-up");
  const [lingering, setLingering] = useState(false);
  const settled = status === "connected";
  useEffect(() => {
    setLingering(false);
    if (settled) return;
    const timer = window.setTimeout(() => setLingering(true), STATUS_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [settled]);
  const [error, setError] = useState<string | null>(null);
  // UI callbacks; read through refs so they never recreate the subscription.
  const onMessageCreatedRef = useRef(onMessageCreated);
  const onTeamMdPublishedRef = useRef(onTeamMdPublished);
  useEffect(() => {
    onMessageCreatedRef.current = onMessageCreated;
    onTeamMdPublishedRef.current = onTeamMdPublished;
  }, [onMessageCreated, onTeamMdPublished]);
  const leaveUnavailableRoom = useCallback(() => {
    queryClient.removeQueries({
      queryKey: roomQueryKey(tenantId, roomId),
    });
    queryClient.setQueryData<TeamHubRoomPage>(
      tenantRoomsQueryKey(tenantId),
      (current) =>
        current
          ? {
              ...current,
              items: current.items.filter((room) => room.id !== roomId),
            }
          : current,
    );
    void navigate(`/t/${tenantId}/rooms`, { replace: true });
  }, [navigate, queryClient, roomId, tenantId]);
  const revalidateCurrentRoomAccess = useCallback(async () => {
    try {
      const room = await teamHubData(
        client.api.GET("/v0/rooms/{roomId}", { params: { path: { roomId } } }),
      );
      if (room.id !== roomId || room.tenant_id !== tenantId) {
        throw new Error("TeamHub returned a Room outside the active scope.");
      }
      queryClient.setQueryData(roomQueryKey(tenantId, roomId), room);
    } catch (error) {
      if (error instanceof TeamHubError && error.status === 404) {
        leaveUnavailableRoom();
        return;
      }
      throw error;
    }
  }, [client, leaveUnavailableRoom, queryClient, roomId, tenantId]);
  const projection = useMemo(
    () =>
      createRoomProjection({
        currentActorId,
        initialRoomSeq,
        messages: client,
        onMessageCreated: (message) => onMessageCreatedRef.current?.(message),
        onRoomAccessInvalidated: revalidateCurrentRoomAccess,
        onTeamMdPublished: () => onTeamMdPublishedRef.current?.(),
        queryClient,
        roomId,
        tenantId,
      }),
    [
      client,
      currentActorId,
      initialRoomSeq,
      queryClient,
      revalidateCurrentRoomAccess,
      roomId,
      tenantId,
    ],
  );

  useEffect(
    () =>
      events.subscribeRoom({
        applyEvent: async (event) => {
          await projection.applyEvent(event);
          onAppliedRoomSeq?.(projection.getLastAppliedRoomSeq());
        },
        getLastAppliedRoomSeq: projection.getLastAppliedRoomSeq,
        onError: (realtimeError) => setError(realtimeError.message),
        // A Room the Account can no longer read answers 404 and is left.
        onRoomInvalidated: () => {
          void revalidateCurrentRoomAccess().catch((realtimeError: unknown) =>
            setError(
              realtimeError instanceof Error
                ? realtimeError.message
                : "Room refresh failed.",
            ),
          );
        },
        onStatusChange: (nextStatus) => {
          setStatus(nextStatus);
          onStatusChange?.(nextStatus);
          if (nextStatus === "connected") {
            setError(null);
          }
        },
        roomId,
      }),
    [
      events,
      onAppliedRoomSeq,
      onStatusChange,
      projection,
      revalidateCurrentRoomAccess,
      roomId,
    ],
  );

  // Joining or catching up after a load usually settles within a moment; only
  // a state that lasts past the grace shows, so a fresh Room does not flash
  // "Syncing Room" or "Reconnecting". Offline and errors show at once.
  const transient =
    (status === "catching-up" || status === "reconnecting") && !error;
  if ((status === "connected" && !error) || (transient && !lingering)) {
    return null;
  }

  const label =
    status === "offline"
      ? "Offline"
      : status === "catching-up"
        ? "Syncing Room"
        : "Reconnecting";

  return (
    <div
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 border px-1.5 text-[12px] sm:px-2.5 [border-radius:var(--app-control-radius)] ${
        status === "offline"
          ? "border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] text-[var(--app-status-warning-text)]"
          : "border-[var(--app-status-neutral-border)] bg-[var(--app-status-neutral-surface)] text-[var(--app-status-neutral-text)]"
      }`}
      role="status"
      title={error ?? label}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${
          status === "offline"
            ? "bg-[var(--app-status-warning-text)]"
            : "bg-[var(--app-status-neutral-text)]"
        }`}
      />
      <span className="hidden sm:inline">{label}</span>
      <span className="sr-only sm:hidden">{label}</span>
    </div>
  );
}
