import { cn } from "@/lib/cn";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useId, useState } from "react";

import { Icon } from "@/components/ui/icon";
import { AppLogo } from "@/features/apps/app-logo";
import {
  activeExternalConnections,
  externalConnectionNeedsAttention,
} from "@/features/apps/connection-state";
import {
  externalAppsQueryOptions,
  externalConnectionsQueryOptions,
} from "@/features/apps/connected-apps-queries";
import { DisconnectAccountDialog } from "@/features/settings/account-disconnect-dialogs";
import { profileSourcePolicy } from "@/features/settings/profile-source-policy";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubExternalConnection } from "@/features/teamhub/teamhub-types";

// Add source is a large flow; load it only when the Human opens it.
const AccountMoreDialog = lazy(async () => {
  const { AccountMoreDialog } =
    await import("@/features/settings/account-more-dialog");
  return { default: AccountMoreDialog };
});

interface ProfileSource {
  id: string;
  app: string;
  label: string;
  logoUrl?: string;
  provider: string;
  state: "connected" | "connect" | "reconnect";
  connection?: TeamHubExternalConnection;
}

type SourcesView =
  | { kind: "add"; startWith?: string }
  | { kind: "disconnect"; connection: TeamHubExternalConnection };

/**
 * The Profile infobox row: one overlapping logo per profile source app,
 * connected accounts first in color, the rest grayed out to connect.
 */
export function WikiProfileSourcesRow({
  client,
  tenantId,
}: {
  client: TeamHubClient;
  tenantId: string;
}) {
  const apps = useQuery(externalAppsQueryOptions(client));
  const connections = useQuery(externalConnectionsQueryOptions(client));
  const [view, setView] = useState<SourcesView | null>(null);
  const hintId = useId();
  const catalog = apps.data?.apps ?? [];
  const sources: ProfileSource[] = catalog
    .filter(
      (app) =>
        app.capabilities.includes("personal_wiki_import") &&
        profileSourcePolicy(app.key).selection !== "unsupported",
    )
    .flatMap((app): ProfileSource[] => {
      const own = (connections.data?.connections ?? []).filter(
        (connection) => connection.provider === app.key,
      );
      const active = activeExternalConnections(own);
      if (active.length) {
        return active.map((connection) => ({
          app: app.display_name,
          connection,
          id: connection.id,
          label: `${app.display_name} · ${connection.identity_label ?? "Connected account"} — connected`,
          logoUrl: app.logo_url,
          provider: app.key,
          state: "connected",
        }));
      }
      const reconnect = own.some(externalConnectionNeedsAttention);
      return [
        {
          app: app.display_name,
          id: app.key,
          label: `${reconnect ? "Reconnect" : "Connect"} ${app.display_name}`,
          logoUrl: app.logo_url,
          provider: app.key,
          state: reconnect ? "reconnect" : "connect",
        },
      ];
    })
    .sort(
      (left, right) =>
        Number(left.state !== "connected") -
        Number(right.state !== "connected"),
    );

  return (
    <div className="wiki-profile-infobox-row">
      <dt>
        <span className="wiki-profile-sources-label">
          <span aria-describedby={hintId}>Sources</span>
          <span className="wiki-profile-source-tip" id={hintId} role="tooltip">
            Another Me learns from these to write this page
          </span>
        </span>
      </dt>
      <dd className="wiki-profile-sources">
        <ul aria-label="Profile sources" className="flex items-center">
          {sources.map((source) => (
            <li className="wiki-profile-source group/source" key={source.id}>
              <button
                aria-label={source.label}
                className="wiki-profile-source-chip"
                onClick={() =>
                  setView(
                    source.connection
                      ? { connection: source.connection, kind: "disconnect" }
                      : { kind: "add", startWith: source.provider },
                  )
                }
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-full place-items-center",
                    source.state !== "connected" &&
                      "opacity-45 grayscale group-hover/source:opacity-70",
                  )}
                  data-testid="source-logo"
                >
                  <AppLogo
                    name={source.app}
                    size="profile"
                    url={source.logoUrl}
                  />
                </span>
              </button>
              <span aria-hidden="true" className="wiki-profile-source-tip">
                {source.label}
              </span>
            </li>
          ))}
          <li className="wiki-profile-source">
            <button
              aria-label="Add source"
              className="wiki-profile-source-chip text-muted-foreground"
              onClick={() => setView({ kind: "add" })}
              type="button"
            >
              <Icon icon={PlusSignIcon} size={14} />
            </button>
            <span aria-hidden="true" className="wiki-profile-source-tip">
              Add source
            </span>
          </li>
        </ul>
      </dd>
      {view?.kind === "add" ? (
        <Suspense fallback={null}>
          <AccountMoreDialog
            client={client}
            onClose={() => setView(null)}
            startWith={view.startWith}
            tenantId={tenantId}
          />
        </Suspense>
      ) : null}
      {view?.kind === "disconnect" ? (
        <DisconnectAccountDialog
          client={client}
          connection={view.connection}
          onClose={() => setView(null)}
        />
      ) : null}
    </div>
  );
}
