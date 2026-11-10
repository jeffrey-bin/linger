import { queryOptions } from "@tanstack/react-query";

import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

export function localComputersQueryKey(tenantId: string) {
  return ["teamhub", tenantId, "local-computers"] as const;
}

export function localComputersQueryOptions(
  client: TeamHubClient,
  tenantId: string,
) {
  return queryOptions({
    queryFn: () => client.listTenantLocalComputers(tenantId),
    queryKey: localComputersQueryKey(tenantId),
    retry: false,
    staleTime: 2_000,
  });
}
