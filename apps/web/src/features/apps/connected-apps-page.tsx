import { useQuery } from "@tanstack/react-query";
import { DesktopBarTitle } from "@/app/desktop-frame";
import { type MouseEvent, type ReactNode, useState } from "react";
import { useSearchParams } from "react-router";

import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { cn } from "@/lib/cn";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubExternalApp,
  TeamHubExternalAppKey,
  TeamHubExternalConnection,
} from "@/features/teamhub/teamhub-types";

import { AppLogo } from "./app-logo";
import { appSummary, groupCatalogApps } from "./app-groups";
import {
  AppManageDialog,
  DisconnectConnectionDialog,
} from "./app-manage-dialog";
import { activeExternalConnections } from "./connection-state";
import {
  externalAppsQueryOptions,
  externalConnectionsQueryOptions,
} from "./connected-apps-queries";
import { ConnectAppStatus, useConnectAppFlow } from "./connect-app-flow";

const APP_GRID_CLASS = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";

function stopCardClick(event: MouseEvent) {
  event.stopPropagation();
}

export function ConnectedAppsPage() {
  const { client } = useTeamHubRuntime();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedApp = searchParams.get("app");
  const apps = useQuery(externalAppsQueryOptions(client));
  const connections = useQuery(externalConnectionsQueryOptions(client));
  // "all" shows every group; otherwise one group's id.
  const [filter, setFilter] = useState("all");
  const [connectedOnly, setConnectedOnly] = useState(false);
  // TeamHub lists only Connections that are not revoked.
  const visibleConnections = connections.data?.connections ?? [];
  const allApps = apps.data?.apps ?? [];
  const groups = groupCatalogApps(allApps);
  const catalogApps = groups.flatMap((entry) => entry.apps);
  // Apps outside the groups are not offered, but an account already connected
  // to one stays reachable here so it can be managed or disconnected.
  const connectedApps = [
    ...catalogApps,
    ...allApps.filter((app) => !catalogApps.includes(app)),
  ].filter(
    (app) =>
      activeExternalConnections(
        visibleConnections.filter(
          (connection) => connection.provider === app.key,
        ),
      ).length > 0,
  );
  const filters = [
    { id: "all", label: "All" },
    ...groups.map(({ group }) => ({ id: group.id, label: group.title })),
  ];
  const groupApps = groups.find((entry) => entry.group.id === filter)?.apps;
  // Connected only narrows whichever view is open; with All it is one grid.
  const filteredApps = connectedOnly
    ? (groupApps ?? connectedApps).filter((app) => connectedApps.includes(app))
    : groupApps;

  function renderApp(app: TeamHubExternalApp) {
    return (
      <CatalogAppCard
        app={app}
        connections={visibleConnections.filter(
          (connection) => connection.provider === app.key,
        )}
        key={app.key}
        selected={requestedApp === app.key}
        onOpen={() => openApp(app.key)}
      />
    );
  }

  // Groups decide only what the grid offers; the dialog opens for any app
  // TeamHub lists, so links like Agent Info's `?app=googledrive` still work.
  const selectedApp = apps.data?.apps.find((app) => app.key === requestedApp);

  function openApp(appKey: TeamHubExternalAppKey) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("app", appKey);
        return next;
      },
      { replace: true },
    );
  }

  function closeApp() {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("app");
        return next;
      },
      { replace: true },
    );
  }

  return (
    <main className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto bg-background [scrollbar-gutter:stable]">
      <div className="workspace-file-browser">
        <DesktopBarTitle>
          <h1 className="mb-5 text-2xl text-foreground">Connectors</h1>
        </DesktopBarTitle>
        {apps.isPending || connections.isPending ? (
          <PageMessage busy>Loading connectors...</PageMessage>
        ) : apps.error || connections.error ? (
          <div className="py-10 text-center" role="alert">
            <p className="text-sm text-app-danger">
              {apps.error?.message ??
                connections.error?.message ??
                "Connectors are unavailable."}
            </p>
            <Button
              className="mt-3"
              onClick={() =>
                void Promise.all([apps.refetch(), connections.refetch()])
              }
              size="compact"
            >
              Retry
            </Button>
          </div>
        ) : (
          <>
            {/* The tab row keeps its own bottom margin; the toggle centers on
                the tabs, not on that margin. */}
            <div className="flex items-start gap-3">
              <UnderlineTabs
                className="min-w-0 flex-1"
                items={filters}
                label="Connector categories"
                onChange={setFilter}
                value={filter}
              />
              <Button
                aria-pressed={connectedOnly}
                className="mt-1 shrink-0"
                onClick={() => setConnectedOnly((value) => !value)}
                size="compact"
                tone={connectedOnly ? "primary" : "secondary"}
              >
                Connected only
              </Button>
            </div>
            {filteredApps ? (
              filteredApps.length ? (
                <section
                  aria-label="Application connections"
                  className={APP_GRID_CLASS}
                >
                  {filteredApps.map(renderApp)}
                </section>
              ) : (
                <PageMessage>No connected apps yet.</PageMessage>
              )
            ) : (
              <div aria-label="Application connections" role="region">
                {groups.map(({ group, apps: groupApps }) => (
                  <section
                    aria-labelledby={`connector-group-${group.id}`}
                    className="mb-7 last:mb-0"
                    key={group.id}
                  >
                    <h2
                      className="mb-2.5 text-[14px] font-medium text-muted-foreground"
                      id={`connector-group-${group.id}`}
                    >
                      {group.title}
                    </h2>
                    <div className={APP_GRID_CLASS}>
                      {groupApps.map(renderApp)}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {selectedApp ? (
        <AppManageDialog
          app={selectedApp}
          connections={visibleConnections.filter(
            (connection) => connection.provider === selectedApp.key,
          )}
          onClose={closeApp}
        />
      ) : null}
    </main>
  );
}

function CatalogAppCard({
  app,
  connections,
  selected,
  onOpen,
}: {
  app: TeamHubExternalApp;
  connections: TeamHubExternalConnection[];
  selected: boolean;
  onOpen: () => void;
}) {
  const [disconnecting, setDisconnecting] =
    useState<TeamHubExternalConnection | null>(null);
  const connectFlow = useConnectAppFlow();
  const createConnection = connectFlow.connection;
  const active = activeExternalConnections(connections);
  const pending = connections.find(
    (connection) =>
      connection.status === "pending" && !connection.status_error_code,
  );
  const canConnect = app.availability === "available";
  const canStart = connectFlow.canStart(app);
  const connectedLabel = active.length
    ? active.length === 1
      ? "Connected"
      : `${active.length} accounts`
    : null;
  const authorizing =
    createConnection.isPending || Boolean(createConnection.blockedConnectUrl);
  const summary =
    connectFlow.configured && app.availability === "unavailable"
      ? "Unavailable"
      : authorizing
        ? "Authorizing…"
        : appSummary(app);

  return (
    <article
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3 transition-colors duration-150 motion-reduce:transition-none",
        selected
          ? "border-border-hover bg-muted"
          : "border-border hover:bg-accent/40",
      )}
    >
      <button
        aria-label={app.display_name}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
        type="button"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-card text-foreground shadow-outline">
          <AppLogo name={app.display_name} url={app.logo_url} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {app.display_name}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {connectedLabel ? (
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-[var(--app-status-success-text)]"
              />
            ) : null}
            <span
              className={cn(
                "truncate",
                !connectedLabel && authorizing && "town-shimmer-text",
              )}
            >
              {connectedLabel ?? summary}
            </span>
          </span>
        </span>
      </button>
      {canStart && active.length === 0 ? (
        <Button
          aria-label={`Connect ${app.display_name}`}
          className="px-2.5"
          disabled={createConnection.isPending}
          onClick={(event) => {
            stopCardClick(event);
            connectFlow.start(app, pending);
          }}
          size="compact"
          tone="secondary"
        >
          Connect
        </Button>
      ) : null}
      {canConnect && active.length === 1 ? (
        // Disconnecting is destructive, so it sits in a menu, not beside Connect.
        <ActionMenu
          items={[
            { label: "Manage", onSelect: onOpen },
            {
              danger: true,
              label: "Disconnect",
              onSelect: () => setDisconnecting(active[0] ?? null),
            },
          ]}
          label={`Actions for ${app.display_name}`}
        />
      ) : null}
      <ConnectAppStatus className="basis-full" flow={connectFlow} />
      {disconnecting ? (
        <DisconnectConnectionDialog
          connection={disconnecting}
          onClose={() => setDisconnecting(null)}
        />
      ) : null}
    </article>
  );
}

function PageMessage({
  busy,
  children,
}: {
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <p
      aria-busy={busy}
      className="flex items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground"
      role="status"
    >
      {busy ? <Spinner size={16} /> : null}
      {children}
    </p>
  );
}
