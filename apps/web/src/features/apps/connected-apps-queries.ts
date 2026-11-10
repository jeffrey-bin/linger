import { queryOptions } from "@tanstack/react-query";

import type { TeamHubExternalSourceClient } from "@/features/teamhub/teamhub-external-source-client";

export function externalAppsQueryOptions(client: TeamHubExternalSourceClient) {
  return queryOptions({
    queryFn: () => client.listExternalApps(),
    queryKey: ["teamhub", "external-apps"],
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function externalConnectionsQueryKey() {
  return ["teamhub", "external-connections"] as const;
}

export function externalConnectionsQueryOptions(
  client: TeamHubExternalSourceClient,
) {
  return queryOptions({
    queryFn: () => client.listExternalConnections(),
    queryKey: externalConnectionsQueryKey(),
    retry: false,
    staleTime: 2_000,
  });
}

export function tenantExternalConnectionsQueryKey(tenantId: string) {
  return ["teamhub", tenantId, "external-connections"] as const;
}

export function tenantExternalConnectionsQueryOptions(
  client: TeamHubExternalSourceClient,
  tenantId: string,
) {
  return queryOptions({
    queryFn: () => client.listExternalConnections(),
    queryKey: tenantExternalConnectionsQueryKey(tenantId),
    retry: false,
    staleTime: 2_000,
  });
}

export function externalConnectionQueryOptions(
  client: TeamHubExternalSourceClient,
  connectionId: string,
) {
  return queryOptions({
    queryFn: () => client.getExternalConnection(connectionId),
    queryKey: ["teamhub", "external-connections", connectionId],
    retry: false,
    staleTime: 0,
  });
}

export function externalConnectionAgentAccessQueryKey(connectionId: string) {
  return [
    "teamhub",
    "external-connections",
    connectionId,
    "agent-grants",
  ] as const;
}

export function externalConnectionAgentAccessQueryOptions(
  client: TeamHubExternalSourceClient,
  connectionId: string,
) {
  return queryOptions({
    enabled: Boolean(connectionId),
    queryFn: () => client.listExternalConnectionAgentAccess(connectionId),
    queryKey: externalConnectionAgentAccessQueryKey(connectionId),
    retry: false,
    staleTime: 5_000,
  });
}

export function isExternalSourceAccountQuery(queryKey: readonly unknown[]) {
  return (
    queryKey[0] === "teamhub" &&
    typeof queryKey[1] === "string" &&
    queryKey[1] === "external-connections"
  );
}
