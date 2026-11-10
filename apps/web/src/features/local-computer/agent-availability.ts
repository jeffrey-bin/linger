import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { tenantAgentAvailabilityQueryOptions } from "@/features/rooms/room-queries";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubTenantAgent,
  TeamHubTenantAgentAvailabilitySnapshot,
} from "@/features/teamhub/teamhub-types";

export interface AgentAvailability {
  readonly available: boolean;
  readonly activeTaskCount: number;
  readonly label: string;
  readonly status: TeamHubTenantAgentAvailabilitySnapshot["availability"]["status"];
  readonly currentActivity?: TeamHubTenantAgentAvailabilitySnapshot["availability"]["current_activity"];
  /** Which AI app and Computer state TeamHub derived the availability from. */
  readonly localRuntimeStatus?: TeamHubTenantAgentAvailabilitySnapshot["local_runtime_status"];
}

export function useAgentAvailabilities(
  tenantId: string,
): ReadonlyMap<string, AgentAvailability> {
  const { client } = useTeamHubRuntime();
  const snapshot = useSuspenseQuery(
    tenantAgentAvailabilityQueryOptions(client, tenantId),
  );

  return useMemo(() => {
    return projectAgentAvailabilitySnapshots(snapshot.data?.items ?? []);
  }, [snapshot.data]);
}

export function projectAgentAvailabilitySnapshots(
  snapshots: readonly TeamHubTenantAgentAvailabilitySnapshot[],
): ReadonlyMap<string, AgentAvailability> {
  const projected = new Map<string, AgentAvailability>();
  for (const snapshot of snapshots) {
    projected.set(snapshot.actor_id, {
      available: snapshot.availability.status === "online",
      activeTaskCount: snapshot.availability.active_task_count ?? 0,
      currentActivity: snapshot.availability.current_activity,
      label: snapshot.availability.label,
      localRuntimeStatus: snapshot.local_runtime_status,
      status: snapshot.availability.status,
    });
  }
  return projected;
}

/** Counts the Agents that are not online, as TeamHub reports them. */
export function agentStatusSummary(
  agentAvailabilities: ReadonlyMap<string, AgentAvailability>,
  agents: TeamHubTenantAgent[],
): string | undefined {
  const counts = { error: 0, offline: 0, online: 0, unknown: 0 };
  for (const agent of agents)
    counts[availabilityOf(agentAvailabilities, agent).status] += 1;
  const parts = [
    counts.error
      ? `${counts.error} need${counts.error === 1 ? "s" : ""} attention`
      : null,
    counts.offline ? `${counts.offline} offline` : null,
    counts.unknown ? `${counts.unknown} status unavailable` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

export function availabilityOf(
  agentAvailabilities: ReadonlyMap<string, AgentAvailability>,
  agent: TeamHubTenantAgent,
): AgentAvailability {
  return (
    agentAvailabilities.get(agent.actor.id) ?? {
      activeTaskCount: 0,
      available: false,
      label: "Status unavailable",
      status: "unknown",
    }
  );
}
