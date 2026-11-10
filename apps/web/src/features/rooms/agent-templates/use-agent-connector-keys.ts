import { useQueries, useQuery } from "@tanstack/react-query";

import { establishedExternalConnections } from "@/features/apps/connection-state";
import {
  externalAppsQueryOptions,
  externalConnectionAgentAccessQueryOptions,
  externalConnectionsQueryOptions,
} from "@/features/apps/connected-apps-queries";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

/**
 * The Connected App keys this Agent is allowed to use. Only the catalog key is
 * read: a template records which Apps to authorize, never the connection,
 * account or credential behind them.
 */
export function useAgentConnectorKeys({
  agentActorId,
  enabled = true,
  tenantId,
}: {
  agentActorId: string;
  enabled?: boolean;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const apps = useQuery({ ...externalAppsQueryOptions(client), enabled });
  const connections = useQuery({
    ...externalConnectionsQueryOptions(client),
    enabled,
  });
  // Only Apps that can serve Agent tools can be a template Connector, so a
  // Wiki-only connection never becomes something a consumer must authorize.
  const toolApps = new Set(
    (apps.data?.apps ?? []).flatMap((app) =>
      app.capabilities.includes("agent_tools") ? [app.key] : [],
    ),
  );
  const relevant = establishedExternalConnections(
    connections.data?.connections ?? [],
  ).filter(
    (connection) =>
      connection.status === "active" && toolApps.has(connection.provider),
  );
  const grants = useQueries({
    queries: relevant.map((connection) => ({
      ...externalConnectionAgentAccessQueryOptions(client, connection.id),
      enabled: enabled && Boolean(agentActorId),
    })),
  });
  const keys = new Set<string>();
  grants.forEach((grant, index) => {
    const granted = grant.data?.agents.some(
      (item) =>
        item.agent_actor_id === agentActorId &&
        item.tenant_id === tenantId &&
        item.granted,
    );
    if (granted) keys.add(relevant[index]!.provider);
  });
  return {
    isPending:
      enabled &&
      (apps.isPending ||
        connections.isPending ||
        grants.some((grant) => grant.isPending)),
    keys: [...keys].sort(),
  };
}
