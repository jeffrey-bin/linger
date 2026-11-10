import { queryOptions } from "@tanstack/react-query";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

export const accountProfileQueryKey = (tenantId: string) =>
  ["teamhub", "account-profile", tenantId] as const;

export function accountProfileQueryOptions(
  client: TeamHubClient,
  tenantId: string,
) {
  return queryOptions({
    queryKey: accountProfileQueryKey(tenantId),
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/account-profile", {
          params: { path: { tenantId } },
        }),
      ),
    retry: false,
    staleTime: 5_000,
  });
}
