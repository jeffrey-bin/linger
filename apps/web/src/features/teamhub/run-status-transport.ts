import { type TeamHubAuthenticationReason } from "./teamhub-authentication";
import type { TeamHubClient } from "./teamhub-client";
import { TeamHubError } from "./teamhub-error";
import type { TeamHubRunStatus } from "./teamhub-types";
import { runStatusView } from "./run-status";
import type { TeamHubEventTransport } from "./event-transport";
import { roomDiagnostic } from "@/lib/room-diagnostics";

export interface RunStatusSubscription {
  onCollection: (runs: TeamHubRunStatus[]) => void;
  onError?: (error: Error) => void;
  onSessionExpired: (reason: TeamHubAuthenticationReason) => void;
  roomId: string;
}

export interface RunStatusTransport {
  subscribe(input: RunStatusSubscription): () => void;
}

const snapshotRetryBaseMs = 1_000;
const snapshotRetryMaxMs = 30_000;

/**
 * Follows the Run statuses a Room shows: the list endpoint is the snapshot,
 * and /v0/events carries each later change. A Room the page follows by
 * cursor delivers its agent_run.status_changed Room Events; any other Room
 * only sends a room hint with its new room_seq, and a resync means hints
 * were lost, so both reread the snapshot. A failed snapshot read is retried
 * with backoff until one succeeds, because nothing else repairs a Run that
 * ended while the stream was down.
 */
export function createRunStatusTransport({
  client,
  events,
}: {
  client: Pick<TeamHubClient, "listRoomRunStatuses">;
  events: Pick<TeamHubEventTransport, "subscribeSignals">;
}): RunStatusTransport {
  return {
    subscribe(input) {
      let runs = new Map<string, TeamHubRunStatus>();
      let disposed = false;
      let loads = 0;
      let failedLoads = 0;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      const publish = () => input.onCollection([...runs.values()]);
      const apply = (run: TeamHubRunStatus) => {
        const current = runs.get(run.id);
        if (current && run.revision < current.revision) return false;
        runs.set(run.id, run);
        return true;
      };
      const load = async () => {
        const current = ++loads;
        clearTimeout(retryTimer);
        retryTimer = undefined;
        try {
          const beforeLoad = new Map(runs);
          const list = await client.listRoomRunStatuses(input.roomId);
          if (disposed || current !== loads) return;
          const announced = runs;
          runs = new Map(list.items.map((run) => [run.id, run]));
          // An announcement that arrived during the read and is newer than
          // the snapshot survives it.
          for (const [id, run] of announced) {
            if (beforeLoad.get(id) !== run) apply(run);
          }
          failedLoads = 0;
          publish();
        } catch (error) {
          if (disposed || current !== loads) return;
          if (error instanceof TeamHubError && error.status === 401) {
            input.onSessionExpired("session-expired");
            return;
          }
          retryTimer = setTimeout(
            () => void load(),
            Math.min(
              snapshotRetryBaseMs * 2 ** failedLoads,
              snapshotRetryMaxMs,
            ),
          );
          failedLoads += 1;
          input.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      };
      // The highest room_seq this subscription saw as a Room Event; a room
      // hint at or below it changed only the Room summary.
      let seenRoomSeq = 0;
      const unsubscribe = events.subscribeSignals((signal) => {
        if (signal.type === "stream.resync") {
          void load();
          return;
        }
        if (signal.type === "resource.invalidated") {
          const { hint } = signal;
          if (
            hint.resource === "room" &&
            hint.id === input.roomId &&
            (hint.room_seq ?? 0) > seenRoomSeq
          )
            void load();
          return;
        }
        const { event } = signal;
        if (event.room_id !== input.roomId) return;
        seenRoomSeq = Math.max(seenRoomSeq, event.room_seq);
        const payload = event.payload as Record<string, unknown>;
        if (payload.kind !== "agent_run.status_changed") return;
        const run = parseRunStatus(payload.run, input.roomId);
        if (!run) {
          input.onError?.(
            new Error("Invalid agent_run.status_changed event was ignored."),
          );
          return;
        }
        if (!apply(run)) return;
        recordTerminalReceipt(run);
        publish();
      });
      void load();
      return () => {
        disposed = true;
        clearTimeout(retryTimer);
        unsubscribe();
      };
    },
  };
}

function parseRunStatus(
  value: unknown,
  roomId: string,
): TeamHubRunStatus | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Record<string, unknown>;
  const agent = run.agent as Record<string, unknown> | undefined;
  if (
    typeof run.run_id !== "string" ||
    run.room_id !== roomId ||
    agent?.kind !== "agent" ||
    typeof agent.id !== "string" ||
    typeof agent.display_name !== "string" ||
    (run.status !== "active" &&
      run.status !== "completed" &&
      run.status !== "aborted") ||
    typeof run.replied !== "boolean" ||
    !Number.isSafeInteger(run.event_ordinal) ||
    (run.event_ordinal as number) < 0 ||
    (run.stop_reason !== undefined && typeof run.stop_reason !== "string") ||
    typeof run.created_at !== "string" ||
    typeof run.updated_at !== "string"
  ) {
    return null;
  }
  return runStatusView(run as unknown as Parameters<typeof runStatusView>[0]);
}

// Receipt time only: this does not assert React committed or the spinner stopped.
function recordTerminalReceipt(run: TeamHubRunStatus) {
  if (run.status === "active") return;
  roomDiagnostic("room.run_status_terminal_received", {
    roomId: run.room_id,
    runId: run.run_id,
    eventOrdinal: run.revision,
    result: run.status,
    observedAtUnixMs: Date.now(),
    observedAtMonotonicMs: performance.now(),
    timeOrigin: performance.timeOrigin,
  });
}
