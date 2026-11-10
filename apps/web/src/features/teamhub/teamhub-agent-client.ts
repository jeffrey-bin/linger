import { idempotencyHeader, teamHubData, type TeamHubApi } from "./teamhub-api";
import type { TeamHubClient } from "./teamhub-client";

export function createTeamHubAgentClient(
  api: TeamHubApi,
): Pick<TeamHubClient, "listTenantLocalComputers" | "uploadAgentSkillPackage"> {
  return {
    uploadAgentSkillPackage: (
      tenantId,
      agentId,
      file,
      fileName,
      idempotencyKey,
    ) => {
      const form = new FormData();
      form.set("package", file, fileName);
      return teamHubData(
        api.POST("/v0/tenants/{tenantId}/agents/{agentId}/skill-packages", {
          params: {
            path: { tenantId, agentId },
            header: idempotencyHeader(idempotencyKey),
          },
          body: form as never,
          bodySerializer: (body) => body,
        }),
      );
    },
    listTenantLocalComputers: async (tenantId) => {
      const page = await teamHubData(
        api.GET("/v0/tenants/{tenantId}/local-computers", {
          params: { path: { tenantId } },
        }),
      );
      return {
        ...page,
        items: page.items.map((computer) => ({
          ...computer,
          runtimes: computer.runtimes.filter(
            ({ type }) =>
              type === "codex" || type === "claude" || type === "pi",
          ),
        })),
      };
    },
  };
}
