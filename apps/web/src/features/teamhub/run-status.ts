import type { TeamHubRoomRunStatus, TeamHubRunStatus } from "./teamhub-types";

/** Keys a published Run status the way the Room UI tracks it. */
export function runStatusView(run: TeamHubRoomRunStatus): TeamHubRunStatus {
  return {
    id: run.run_id,
    run_id: run.run_id,
    room_id: run.room_id,
    agent: run.agent,
    status: run.status,
    replied: run.replied,
    revision: run.event_ordinal,
    ...(run.stop_reason === undefined ? {} : { stop_reason: run.stop_reason }),
    created_at: run.created_at,
    updated_at: run.updated_at,
  };
}

/**
 * Whether the Agent of this Run is still working for the user. TeamHub owns
 * the answer: an active Run whose Agent has replied is no longer working even
 * while its native turn ends.
 */
export function isRunWorking(
  run: Pick<TeamHubRunStatus, "replied" | "status">,
): boolean {
  return run.status === "active" && !run.replied;
}
