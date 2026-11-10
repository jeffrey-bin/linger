import { queryOptions } from "@tanstack/react-query";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

export function agentTemplatesQueryKey(tenantId: string) {
  return ["teamhub", tenantId, "agent-templates"] as const;
}

export function agentTemplatesQueryOptions(
  client: Pick<TeamHubClient, "api">,
  tenantId: string,
) {
  return queryOptions({
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/agent-templates", {
          params: { path: { tenantId } },
        }),
      ),
    queryKey: agentTemplatesQueryKey(tenantId),
    retry: false,
    staleTime: 30_000,
  });
}
