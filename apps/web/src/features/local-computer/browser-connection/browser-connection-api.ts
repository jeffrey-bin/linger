import { queryOptions } from "@tanstack/react-query";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

const browserConnectionPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/browser-connection";

export function browserConnectionQueryKey(
  tenantId: string,
  computerId: string,
) {
  return [
    "teamhub",
    tenantId,
    "local-computer-browser-connection",
    computerId,
  ] as const;
}

// The cached value is the status only. The token never enters a query key,
// query data, or mutation variables.
export function browserConnectionQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
) {
  return queryOptions({
    queryFn: ({ signal }) =>
      teamHubData(
        client.api.GET(browserConnectionPath, {
          params: { path: { tenantId, computerId } },
          signal,
        }),
      ),
    queryKey: browserConnectionQueryKey(tenantId, computerId),
    retry: false,
    staleTime: 10_000,
  });
}

/** Sends the pasted extension text once; TeamHub normalizes and never stores it. */
export function configureBrowserConnection(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  pastedToken: string,
) {
  return teamHubData(
    client.api.PUT(browserConnectionPath, {
      params: { path: { tenantId, computerId } },
      body: { extension_token: pastedToken },
    }),
  );
}

export function disconnectBrowserConnection(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
) {
  return teamHubData(
    client.api.DELETE(browserConnectionPath, {
      params: { path: { tenantId, computerId } },
    }),
  );
}
