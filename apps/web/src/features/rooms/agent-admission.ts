import type {
  TeamHubActor,
  TeamHubTenantAgent,
  TeamHubTenantAgentAvailabilitySnapshot,
} from "@/features/teamhub/teamhub-types";

export function eligibleRoomAgents({
  agents,
  availabilitySnapshots,
  roomMemberIds,
  sponsorActorId,
}: {
  agents: TeamHubTenantAgent[];
  availabilitySnapshots: TeamHubTenantAgentAvailabilitySnapshot[];
  roomMemberIds: ReadonlySet<string>;
  sponsorActorId?: string;
}): TeamHubActor[] {
  const availabilityByActorId = new Map(
    availabilitySnapshots.map((snapshot) => [snapshot.actor_id, snapshot]),
  );
  const eligibleActors: TeamHubActor[] = [];
  for (const agent of agents) {
    const localRuntimeReady =
      agent.runtime.placement?.type !== "local" ||
      availabilityByActorId.get(agent.actor.id)?.local_runtime_status
        ?.status === "ready";
    if (
      localRuntimeReady &&
      (agent.visibility_scope === "workspace" ||
        agent.created_by.id === sponsorActorId) &&
      !roomMemberIds.has(agent.actor.id)
    ) {
      eligibleActors.push(agent.actor);
    }
  }
  return eligibleActors;
}
