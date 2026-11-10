import { queryOptions } from "@tanstack/react-query";

import { collectTeamHubCursorPages } from "@/features/teamhub/teamhub-cursor-pages";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

export function tenantWorkItemTargetQueryKey(
  tenantId: string,
  workItemId: string,
) {
  return ["teamhub", tenantId, "work-items", "target", workItemId] as const;
}

export function tenantWorkItemTargetQueryPrefix(tenantId: string) {
  return ["teamhub", tenantId, "work-items", "target"] as const;
}

export function tenantWorkItemTargetQueryOptions(
  client: Pick<TeamHubClient, "api">,
  tenantId: string,
  workItemId: string,
) {
  return queryOptions({
    queryFn: async () => {
      const item = await teamHubData(
        client.api.GET("/v0/work-items/{workItemId}", {
          params: { path: { workItemId } },
        }),
      );
      if (item.id !== workItemId || item.tenant_id !== tenantId) {
        throw new TeamHubError({
          code: "WORK_ITEM_NOT_FOUND",
          message: "Work Item is unavailable in this Tenant.",
          status: 404,
        });
      }
      return item;
    },
    queryKey: tenantWorkItemTargetQueryKey(tenantId, workItemId),
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}

export function tenantWorkItemsDashboardQueryKey(tenantId: string) {
  return ["teamhub", tenantId, "work-items", "dashboard"] as const;
}

export function tenantAgentWorkItemsQueryKey(
  tenantId: string,
  agentActorId: string,
) {
  return ["teamhub", tenantId, "work-items", "agent", agentActorId] as const;
}

export function tenantAgentWorkItemsQueryOptions(
  client: Pick<TeamHubClient, "api">,
  tenantId: string,
  agentActorId: string,
) {
  return queryOptions({
    queryFn: async () => {
      const page = await collectTeamHubCursorPages((pagination) =>
        teamHubData(
          client.api.GET("/v0/tenants/{tenantId}/work-items", {
            params: {
              path: { tenantId },
              query: { ...pagination, scope: "tenant" },
            },
          }),
        ),
      );
      if (page.items.some((item) => item.tenant_id !== tenantId)) {
        throw new Error(
          "Agent Work Item list does not match the active Tenant.",
        );
      }
      return {
        ...page,
        items: page.items.filter((item) =>
          item.assignees.some(
            (assignment) => assignment.actor.id === agentActorId,
          ),
        ),
      };
    },
    queryKey: tenantAgentWorkItemsQueryKey(tenantId, agentActorId),
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}

export function tenantWorkItemsDashboardQueryOptions(
  client: Pick<TeamHubClient, "api">,
  tenantId: string,
) {
  return queryOptions({
    queryFn: async () => {
      const page = await collectTeamHubCursorPages((pagination) =>
        teamHubData(
          client.api.GET("/v0/tenants/{tenantId}/work-items", {
            params: {
              path: { tenantId },
              query: { ...pagination, scope: "personal" },
            },
          }),
        ),
      );
      if (page.items.some((item) => item.tenant_id !== tenantId)) {
        throw new Error(
          "Work Item Dashboard does not match the active Tenant.",
        );
      }
      return page;
    },
    queryKey: tenantWorkItemsDashboardQueryKey(tenantId),
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}
