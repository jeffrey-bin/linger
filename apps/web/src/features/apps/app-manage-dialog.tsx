import {
  Delete02Icon,
  PlusSignIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { StatusPill } from "@/components/ui/status-pill";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubExternalApp,
  TeamHubExternalConnection,
} from "@/features/teamhub/teamhub-types";

import { INSUFFICIENT_PERMISSION_MESSAGE } from "./authorization-error";
import {
  externalConnectionQueryOptions,
  externalConnectionsQueryKey,
} from "./connected-apps-queries";
import { ConnectAppStatus, useConnectAppFlow } from "./connect-app-flow";
import { establishedExternalConnections } from "./connection-state";

export function AppManageDialog({
  app,
  connections,
  onClose,
}: {
  app: TeamHubExternalApp;
  connections: TeamHubExternalConnection[];
  onClose: () => void;
}) {
  const [disconnecting, setDisconnecting] =
    useState<TeamHubExternalConnection | null>(null);
  // Without a Composio key, Connect opens the key dialog on top of this one.
  const connectFlow = useConnectAppFlow();
  const listed = establishedExternalConnections(connections);
  const canConnect = connectFlow.canStart(app);
  const supportsAutoReminders = app.capabilities.includes(
    "proactive_reminders",
  );

  return (
    <>
      <ModalDialog
        closeOnBackdrop
        description={app.description}
        onClose={onClose}
        size="md"
        title={app.display_name}
      >
        <div className="px-5 py-4">
          {canConnect ? (
            <Button
              aria-label={
                listed.length
                  ? `Add another ${app.display_name} account`
                  : `Connect ${app.display_name}`
              }
              disabled={connectFlow.connection.isPending}
              onClick={() => connectFlow.start(app)}
              size="compact"
              tone="secondary"
            >
              <Icon icon={PlusSignIcon} size={14} />
              {listed.length ? "Add account" : "Connect"}
            </Button>
          ) : (
            <Button disabled size="compact">
              Connect
            </Button>
          )}
          <ConnectAppStatus className="mt-3" flow={connectFlow} />
          {listed.length ? (
            <div className="mt-4 divide-y divide-border border-t border-border">
              {listed.map((connection) => (
                <ConnectionRow
                  connection={connection}
                  key={connection.id}
                  supportsAutoReminders={supportsAutoReminders}
                  onDisconnect={() => setDisconnecting(connection)}
                />
              ))}
            </div>
          ) : null}
        </div>
      </ModalDialog>
      {disconnecting ? (
        <DisconnectConnectionDialog
          connection={disconnecting}
          onClose={() => setDisconnecting(null)}
        />
      ) : null}
    </>
  );
}

function ConnectionRow({
  connection,
  supportsAutoReminders,
  onDisconnect,
}: {
  connection: TeamHubExternalConnection;
  supportsAutoReminders: boolean;
  onDisconnect: () => void;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const statusCheck = useMutation({
    mutationFn: () =>
      client.createExternalConnectionStatusCheck(
        connection.id,
        connection.revision,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      }),
  });
  // TeamHub clears the request once the check writes its result.
  const checking = Boolean(connection.status_check_requested_at);
  const duplicateIdentity =
    connection.status_error_code === "duplicate_remote_principal";

  return (
    <div className="flex min-h-[58px] flex-wrap items-center gap-3 py-2.5">
      <div className="min-w-[180px] flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {connection.identity_label ?? "Authorization in progress"}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <ConnectionStatus status={connection.status} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {connection.status === "active" ? (
          <Button
            aria-label={`Check ${connection.identity_label ?? connection.provider}`}
            disabled={statusCheck.isPending || checking}
            onClick={() => statusCheck.mutate()}
            size="compactIcon"
            title="Check connection"
            tone="ghost"
          >
            <Icon
              icon={RefreshIcon}
              className={
                statusCheck.isPending || checking ? "animate-spin" : ""
              }
              size={14}
            />
          </Button>
        ) : null}
        {!["disconnecting", "revoke_pending"].includes(connection.status) ? (
          <Button
            aria-label={`Disconnect ${connection.identity_label ?? connection.provider}`}
            onClick={onDisconnect}
            size="compactIcon"
            title="Disconnect"
            tone="ghost"
          >
            <Icon icon={Delete02Icon} size={14} />
          </Button>
        ) : null}
      </div>
      {connection.status_error_code === "discord_guild_required" ? (
        <p className="basis-full text-xs text-app-danger" role="alert">
          Discord could not verify the authorized Server. Check the Composio
          project credential masking setting, then reconnect.
        </p>
      ) : null}
      {connection.status_error_code === "provider_auth_failed" ? (
        <p className="basis-full text-xs text-app-danger" role="alert">
          {INSUFFICIENT_PERMISSION_MESSAGE}
        </p>
      ) : null}
      {statusCheck.error ? (
        <p className="basis-full text-xs text-app-danger" role="alert">
          {errorMessage(statusCheck.error, "Connection action failed.")}
        </p>
      ) : null}
      {duplicateIdentity ? (
        <p className="basis-full text-xs text-app-danger" role="alert">
          This account is already connected.
        </p>
      ) : null}
      {connection.status === "active" && supportsAutoReminders ? (
        <AutoReminders connection={connection} />
      ) : null}
    </div>
  );
}

function AutoReminders({
  connection,
}: {
  connection: TeamHubExternalConnection;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (enabled: boolean) =>
      client.setExternalConnectionAutoReminders(connection.id, enabled),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      });
    },
  });
  const enabled = update.isPending
    ? update.variables
    : connection.auto_reminders;

  return (
    <div className="basis-full border-t border-border pt-2.5">
      <label className="flex min-h-8 items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">
            Auto reminders
          </span>
          <span className="block text-xs text-muted-foreground">
            Agents check this account for things that need your attention.
          </span>
        </span>
        <input
          aria-label={`Auto reminders for ${connection.identity_label ?? connection.provider}`}
          checked={enabled}
          className="agent-connector-switch"
          disabled={update.isPending}
          onChange={(event) => update.mutate(event.target.checked)}
          role="switch"
          type="checkbox"
        />
      </label>
      {update.error ? (
        <p className="mt-1 text-xs text-app-danger" role="alert">
          {errorMessage(update.error, "Auto reminders could not be updated.")}
        </p>
      ) : null}
    </div>
  );
}

export function DisconnectConnectionDialog({
  connection,
  onClose,
}: {
  connection: TeamHubExternalConnection;
  onClose: () => void;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [disconnected, setDisconnected] = useState(false);
  const disconnect = useMutation({
    mutationFn: () =>
      client.disconnectExternalConnection(connection.id, {
        expected_revision: connection.revision,
      }),
    onSuccess: async () => {
      setDisconnected(true);
      await queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      });
    },
  });
  // The connection is disconnecting until TeamHub revokes the provider
  // account, then revoked; account change events refresh it.
  const current = useQuery({
    ...externalConnectionQueryOptions(client, connection.id),
    enabled: disconnected,
  });
  const ended = current.data ?? disconnect.data;

  useEffect(() => {
    if (current.data?.status !== "revoked") return;
    void queryClient.invalidateQueries({
      queryKey: externalConnectionsQueryKey(),
    });
  }, [current.data?.status, queryClient]);

  return (
    <ModalDialog
      description={connection.identity_label ?? connection.provider}
      onClose={onClose}
      size="md"
      title="Disconnect account?"
      footer={
        <>
          <Button disabled={disconnect.isPending} onClick={onClose}>
            {disconnected ? "Close" : "Cancel"}
          </Button>
          {!disconnected ? (
            <Button
              loading={disconnect.isPending}
              onClick={() => disconnect.mutate()}
              tone="danger"
            >
              Disconnect
            </Button>
          ) : null}
        </>
      }
    >
      <div className="px-5 py-4">
        <p className="text-sm text-muted-foreground">
          Agents lose access to this account. Content already imported is kept.
        </p>
        {ended ? (
          <div
            className="mt-4 space-y-1 border-y border-border py-3 text-sm"
            role="status"
          >
            <p>App access stopped in Linger.</p>
            <p className="text-muted-foreground">
              Provider authorization: {revokeLabel(ended)}
            </p>
          </div>
        ) : null}
        {disconnect.error || current.error ? (
          <p className="mt-3 text-sm text-app-danger" role="alert">
            {errorMessage(
              disconnect.error ?? current.error,
              "Account could not be disconnected.",
            )}
          </p>
        ) : null}
      </div>
    </ModalDialog>
  );
}

function ConnectionStatus({
  status,
}: {
  status: TeamHubExternalConnection["status"];
}) {
  return (
    <StatusPill tone={status === "active" ? "success" : "warning"}>
      {status === "active" ? "Active" : "Disconnecting"}
    </StatusPill>
  );
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof TeamHubError || error instanceof Error)
    return error.message;
  return fallback;
}

function revokeLabel(connection: TeamHubExternalConnection) {
  if (connection.status === "revoked") return "revoked";
  if (connection.status_error_code?.startsWith("provider_revoke_"))
    return "retrying";
  return "pending";
}
