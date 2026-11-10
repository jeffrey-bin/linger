import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubActor,
  TeamHubAgentVisibilityScope,
  TeamHubCreatableAgentType,
  TeamHubLocalRuntimeType,
  TeamHubTenantAgentCreateInput,
} from "@/features/teamhub/teamhub-types";

export interface TenantAgentCreation {
  templateId?: string;
  agentType: TeamHubCreatableAgentType;
  avatarKey?: string;
  description?: string;
  instructions: string;
  model: string;
  reasoningEffort?: TeamHubTenantAgentCreateInput["runtime"]["reasoning_effort"];
  name: string;
  placement?: {
    computerId: string;
    runtimeType: TeamHubLocalRuntimeType;
    type: "local";
    workspaceGrantId: string;
  };
  tenantId: string;
  skillBindings: NonNullable<TeamHubTenantAgentCreateInput["skill_bindings"]>;
  visibilityScope: TeamHubAgentVisibilityScope;
}

/** Creates a tenant Agent; a placed Agent always runs Codex on its Computer. */
export async function createTenantAgent(
  client: Pick<TeamHubClient, "api">,
  input: TenantAgentCreation,
): Promise<TeamHubActor> {
  const description = input.description?.trim();
  const created = await teamHubData(
    client.api.POST("/v0/tenants/{tenantId}/agents", {
      params: { path: { tenantId: input.tenantId } },
      body: {
        agent_type: input.agentType,
        ...(input.templateId ? { template_id: input.templateId } : {}),
        ...(input.avatarKey ? { avatar_key: input.avatarKey } : {}),
        ...(description ? { description } : {}),
        instructions: input.instructions.trim(),
        name: input.name.trim(),
        visibility_scope: input.visibilityScope,
        runtime: {
          model: input.model.trim(),
          ...(input.reasoningEffort
            ? { reasoning_effort: input.reasoningEffort }
            : {}),
          ...(input.placement
            ? {
                placement: {
                  computer_id: input.placement.computerId,
                  runtime_type: input.placement.runtimeType,
                  type: "local" as const,
                  workspace_grant_id: input.placement.workspaceGrantId,
                },
              }
            : {}),
        },
        skill_bindings: input.skillBindings,
      },
    }),
  );
  return created.actor;
}
