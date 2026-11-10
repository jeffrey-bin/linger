import { useRoomRunStatusCollection } from "../runtime-status/use-room-run-statuses";
import {
  normalizeRuntimePresentationMessageIds,
  useRoomMessageRunStatuses,
} from "../runtime-status/use-room-message-run-statuses";
import { useRoomRuntimePresentations } from "../runtime-status/use-room-runtime-presentations";
import { useMemo } from "react";

import type {
  TeamHubMessage,
  TeamHubRunStatus,
} from "@/features/teamhub/teamhub-types";

const emptyRunStatuses: readonly TeamHubRunStatus[] = [];

export function useRoomAgentStreamingStatus({
  enabled = true,
  messages,
  roomId,
  tenantId,
}: {
  enabled?: boolean;
  messages: readonly TeamHubMessage[];
  roomId: string;
  tenantId: string;
}) {
  const runStatusCollection = useRoomRunStatusCollection({
    enabled,
    roomId,
    tenantId,
  });
  const liveRunStatuses = runStatusCollection.synchronized
    ? runStatusCollection.items
    : emptyRunStatuses;
  const historicalMessageIds = useMemo(
    () =>
      normalizeRuntimePresentationMessageIds(
        messages.map((message) => message.id),
      ),
    [messages],
  );
  const historicalRunStatuses = useRoomMessageRunStatuses({
    messageIds: historicalMessageIds,
    roomId,
    tenantId,
  });
  const visibleRunStatuses = useMemo(
    () => mergeRunStatuses(liveRunStatuses, historicalRunStatuses),
    [historicalRunStatuses, liveRunStatuses],
  );
  const runStatusesToSync = useMemo(
    () =>
      visibleRunStatuses.filter((runStatus) => runStatus.status === "active"),
    [visibleRunStatuses],
  );
  const runtimePresentations = useRoomRuntimePresentations({
    activeRunStatuses: runStatusesToSync,
    runStatuses: visibleRunStatuses,
    roomId,
    tenantId,
  });
  const progressVersion = [
    ...visibleRunStatuses.map(
      (runStatus) => `${runStatus.id}:${runStatus.revision}`,
    ),
    runtimePresentations.progressVersion,
  ].join("|");

  return {
    runStatuses: visibleRunStatuses,
    progressVersion,
    runtimePresentationEventsByRunStatusId:
      runtimePresentations.eventsByRunStatusId,
  };
}

function mergeRunStatuses(
  liveRunStatuses: readonly TeamHubRunStatus[],
  historicalRunStatuses: readonly TeamHubRunStatus[],
) {
  const runStatusesById = new Map<string, TeamHubRunStatus>();
  for (const runStatus of historicalRunStatuses) {
    if (runStatus.status === "active") continue;
    mergeRunStatusSnapshot(runStatusesById, runStatus);
  }
  for (const runStatus of liveRunStatuses)
    mergeRunStatusSnapshot(runStatusesById, runStatus);

  const latestActiveRunStatusByAgentId = new Map<string, TeamHubRunStatus>();
  for (const runStatus of runStatusesById.values()) {
    if (runStatus.status !== "active") continue;
    const current = latestActiveRunStatusByAgentId.get(runStatus.agent.id);
    if (!current || compareRunStatusRecency(current, runStatus) < 0) {
      latestActiveRunStatusByAgentId.set(runStatus.agent.id, runStatus);
    }
  }

  return [...runStatusesById.values()]
    .filter(
      (runStatus) =>
        runStatus.status !== "active" ||
        latestActiveRunStatusByAgentId.get(runStatus.agent.id)?.id ===
          runStatus.id,
    )
    .sort((left, right) =>
      left.created_at === right.created_at
        ? left.id.localeCompare(right.id)
        : left.created_at.localeCompare(right.created_at),
    );
}

function mergeRunStatusSnapshot(
  runStatusesById: Map<string, TeamHubRunStatus>,
  runStatus: TeamHubRunStatus,
) {
  const current = runStatusesById.get(runStatus.id);
  if (!current || compareRunStatusSnapshotRecency(current, runStatus) < 0) {
    runStatusesById.set(runStatus.id, runStatus);
  }
}

function compareRunStatusRecency(
  left: TeamHubRunStatus,
  right: TeamHubRunStatus,
) {
  const createdAtComparison = left.created_at.localeCompare(right.created_at);
  if (createdAtComparison !== 0) return createdAtComparison;
  const updatedAtComparison = left.updated_at.localeCompare(right.updated_at);
  if (updatedAtComparison !== 0) return updatedAtComparison;
  return left.id.localeCompare(right.id);
}

function compareRunStatusSnapshotRecency(
  left: TeamHubRunStatus,
  right: TeamHubRunStatus,
) {
  if (left.revision !== right.revision) return left.revision - right.revision;
  const updatedAtComparison = left.updated_at.localeCompare(right.updated_at);
  if (updatedAtComparison !== 0) return updatedAtComparison;
  return runStatusTerminalRank(left) - runStatusTerminalRank(right);
}

function runStatusTerminalRank(runStatus: TeamHubRunStatus) {
  return runStatus.status === "active" ? 0 : 1;
}
