import type { TeamHubTenantAgent } from "@/features/teamhub/teamhub-types";

/** Only the Human who registered an Agent removes it; Another Me stays. */
export function canDeleteTenantAgent(
  registration: TeamHubTenantAgent | undefined,
  currentActorId: string | undefined,
) {
  return (
    registration !== undefined &&
    registration.created_by.id === currentActorId &&
    registration.agent_type !== "anotherme"
  );
}
