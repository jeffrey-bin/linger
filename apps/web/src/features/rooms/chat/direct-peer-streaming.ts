import type { TeamHubRunStatus } from "@/features/teamhub/teamhub-types";

export function visibleDirectPeerRunStatuses(
  runStatuses: readonly TeamHubRunStatus[],
  peerAgentId?: string,
) {
  if (!peerAgentId) return runStatuses;
  return runStatuses.filter((runStatus) => runStatus.agent.id === peerAgentId);
}
