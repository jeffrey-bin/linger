import type { components } from "@linger/wire-contracts/teamhub-public/types";
import { queryOptions } from "@tanstack/react-query";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

export type ComputerPermissionStatus =
  components["schemas"]["ComputerPermissionStatus"];
export type ComputerPermissionAction =
  components["schemas"]["ComputerPermissionAction"];

const computerPermissionsPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/permissions";
// Granting happens in macOS outside the page, so only polling notices it.
// Each read also lets TeamHub settle a fully granted card.
const pendingPollMs = 2_000;

export function computerPermissionsQueryKey(
  tenantId: string,
  computerId: string,
) {
  return [
    "teamhub",
    tenantId,
    "local-computer-permissions",
    computerId,
  ] as const;
}

export function computerPermissionsQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  poll: boolean,
) {
  return queryOptions({
    queryFn: ({ signal }) =>
      teamHubData(
        client.api.GET(computerPermissionsPath, {
          params: { path: { tenantId, computerId } },
          signal,
        }),
      ),
    queryKey: computerPermissionsQueryKey(tenantId, computerId),
    refetchInterval: poll ? pendingPollMs : false,
    retry: false,
  });
}

/** Raises the macOS prompt, opens its Settings pane, or relaunches Linger. */
export function actOnComputerPermission(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  action: ComputerPermissionAction,
) {
  return teamHubData(
    client.api.POST(computerPermissionsPath, {
      params: { path: { tenantId, computerId } },
      body: action,
    }),
  );
}
