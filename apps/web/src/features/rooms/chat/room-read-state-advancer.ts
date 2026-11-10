import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

export function createRoomReadStateAdvancer({
  client,
  initialReadThroughRoomSeq = 0,
  onError,
  refreshRoomList,
  roomId,
}: {
  client: Pick<TeamHubClient, "api">;
  initialReadThroughRoomSeq?: number;
  onError?: (error: Error) => void;
  refreshRoomList: (readThroughRoomSeq: number) => Promise<void> | void;
  roomId: string;
}) {
  let acknowledgedRoomSeq = initialReadThroughRoomSeq;
  let projectedRoomSeq = initialReadThroughRoomSeq;
  let targetRoomSeq = initialReadThroughRoomSeq;
  let running = false;
  let disposed = false;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRetry = () => {
    if (disposed || retryTimer) {
      return;
    }
    const delay = Math.min(1_000 * 2 ** retryAttempt, 30_000);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void flush();
    }, delay);
  };

  const flush = async () => {
    if (running || disposed) {
      return;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    running = true;
    try {
      while (
        !disposed &&
        (targetRoomSeq > acknowledgedRoomSeq ||
          acknowledgedRoomSeq > projectedRoomSeq)
      ) {
        if (targetRoomSeq > acknowledgedRoomSeq) {
          const requestedRoomSeq = targetRoomSeq;
          const state = await teamHubData(
            client.api.PUT("/v0/rooms/{roomId}/read-state", {
              params: { path: { roomId } },
              body: { through_room_seq: requestedRoomSeq },
            }),
          );
          acknowledgedRoomSeq = Math.max(
            acknowledgedRoomSeq,
            state.read_through_room_seq,
          );
        }
        if (acknowledgedRoomSeq > projectedRoomSeq) {
          const refreshThroughRoomSeq = acknowledgedRoomSeq;
          await refreshRoomList(refreshThroughRoomSeq);
          projectedRoomSeq = Math.max(projectedRoomSeq, refreshThroughRoomSeq);
        }
      }
      retryAttempt = 0;
    } catch (error) {
      onError?.(
        error instanceof Error
          ? error
          : new Error("Room read-state update failed."),
      );
      scheduleRetry();
    } finally {
      running = false;
    }
  };

  return {
    advance(roomSeq: number) {
      if (
        disposed ||
        !Number.isSafeInteger(roomSeq) ||
        roomSeq <= targetRoomSeq
      ) {
        return;
      }
      targetRoomSeq = roomSeq;
      void flush();
    },
    dispose() {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    },
  };
}
