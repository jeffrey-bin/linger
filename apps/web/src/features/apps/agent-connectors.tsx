import {
  ArrowRight01Icon,
  PlugSocketIcon,
  PlusSignIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowText,
} from "@/components/ui/settings-group";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubExternalApp,
  TeamHubExternalConnection,
} from "@/features/teamhub/teamhub-types";
import { AppLogo } from "./app-logo";
import { establishedExternalConnections } from "./connection-state";
import {
  externalAppsQueryOptions,
  externalConnectionsQueryOptions,
  externalConnectionAgentAccessQueryKey,
  externalConnectionAgentAccessQueryOptions,
} from "./connected-apps-queries";

const GROUP_LABEL = "Accounts this Agent can use";

export function AgentConnectors({
  agentActorId,
  tenantId,
}: {
  agentActorId: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const apps = useQuery(externalAppsQueryOptions(client));
  const connections = useQuery(externalConnectionsQueryOptions(client));
  if (apps.isPending || connections.isPending)
    return (
      <SettingsGroup ariaLabel={GROUP_LABEL}>
        <SettingsRow icon={<Icon icon={PlugSocketIcon} size={16} />}>
          <p className="flex-1 text-[14px] text-muted-foreground" role="status">
            Loading connectors...
          </p>
        </SettingsRow>
      </SettingsGroup>
    );
  if (apps.error || connections.error)
    return (
      <SettingsGroup ariaLabel={GROUP_LABEL}>
        <SettingsRow icon={<Icon icon={PlugSocketIcon} size={16} />}>
          <p
            className="min-w-0 flex-1 text-[14px] text-app-danger"
            role="alert"
          >
            {apps.error?.message ?? connections.error?.message}
          </p>
          <Button
            size="compact"
            onClick={() =>
              void Promise.all([apps.refetch(), connections.refetch()])
            }
          >
            <Icon icon={RefreshIcon} size={14} />
            Retry
          </Button>
        </SettingsRow>
      </SettingsGroup>
    );
  const visible = establishedExternalConnections(
    connections.data?.connections ?? [],
  );
  const connected = (apps.data?.apps ?? []).flatMap((app) => {
    if (!app.capabilities.includes("agent_tools")) return [];
    const accounts = visible.filter(
      (connection) => connection.provider === app.key,
    );
    return accounts.length ? [{ app, accounts }] : [];
  });
  const appsPath = `/t/${tenantId}/apps`;
  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup ariaLabel={GROUP_LABEL}>
        {connected.length ? (
          connected.map(({ app, accounts }) => (
            <section key={app.key} aria-label={app.display_name}>
              {accounts.map((connection) => (
                <AgentConnectionAccess
                  key={connection.id}
                  agentActorId={agentActorId}
                  app={app}
                  connection={connection}
                  managePath={`${appsPath}?app=${app.key}`}
                  tenantId={tenantId}
                />
              ))}
            </section>
          ))
        ) : (
          <SettingsRow icon={<Icon icon={PlugSocketIcon} size={16} />}>
            <SettingsRowText muted title="No connected accounts yet." />
          </SettingsRow>
        )}
      </SettingsGroup>
      <SettingsGroup>
        <Link
          to={appsPath}
          className="block transition-colors duration-150 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
        >
          <SettingsRow icon={<Icon icon={PlusSignIcon} size={16} />}>
            <span className="flex-1 text-[14px] font-medium text-foreground">
              Connect another app
            </span>
            <Icon
              className="text-muted-foreground/70"
              icon={ArrowRight01Icon}
              size={14}
            />
          </SettingsRow>
        </Link>
      </SettingsGroup>
    </div>
  );
}

function AgentConnectionAccess({
  agentActorId,
  app,
  connection,
  managePath,
  tenantId,
}: {
  agentActorId: string;
  app: TeamHubExternalApp;
  connection: TeamHubExternalConnection;
  managePath: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const access = useQuery({
    ...externalConnectionAgentAccessQueryOptions(client, connection.id),
    enabled: connection.status === "active",
  });
  const update = useMutation({
    mutationFn: (granted: boolean) =>
      client.setExternalConnectionAgentAccess(
        connection.id,
        agentActorId,
        granted,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: externalConnectionAgentAccessQueryKey(connection.id),
      });
    },
  });
  const agent = access.data?.agents.find(
    (item) =>
      item.agent_actor_id === agentActorId && item.tenant_id === tenantId,
  );
  const inactive = connection.status !== "active";
  const failure = update.error ?? access.error;
  const description = failure ? (
    <span className="text-app-danger" role="alert">
      {failure.message}
    </span>
  ) : inactive ? (
    <span
      className={connection.status === "pending" ? "town-shimmer-text" : ""}
    >
      {connection.status === "pending"
        ? "Connection pending"
        : "Connection needs attention"}
    </span>
  ) : access.data && !agent ? (
    "Access unavailable for this Agent"
  ) : (
    connection.identity_label || undefined
  );
  return (
    <SettingsRow
      icon={
        <AppLogo name={app.display_name} size="profile" url={app.logo_url} />
      }
    >
      <SettingsRowText
        description={description}
        muted={inactive}
        title={app.display_name}
      />
      {inactive ? (
        <Link
          className="shrink-0 text-xs font-medium text-app-link hover:underline"
          to={managePath}
        >
          Manage
        </Link>
      ) : access.isPending ? (
        <span className="shrink-0 text-xs text-muted-foreground" role="status">
          Loading access...
        </span>
      ) : access.error ? (
        <Button size="compact" onClick={() => void access.refetch()}>
          Retry access
        </Button>
      ) : (
        <input
          type="checkbox"
          role="switch"
          aria-label={`Allow Agent access to ${connection.identity_label || connection.provider}`}
          checked={agent?.granted ?? false}
          disabled={!agent || update.isPending}
          onChange={(event) => update.mutate(event.target.checked)}
          className="agent-connector-switch"
        />
      )}
    </SettingsRow>
  );
}
