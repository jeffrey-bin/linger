import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { cn } from "@/lib/cn";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubExternalApp,
  TeamHubExternalConnection,
} from "@/features/teamhub/teamhub-types";

import { AppLogoTile } from "./app-logo";
import { externalAppsQueryOptions } from "./connected-apps-queries";
import { openOAuthUrl } from "./oauth-popup";
import { ProviderKeyForm } from "./provider-key-form";
import { ComposioKeyGuide } from "./provider-key-guide";
import {
  isComposioKeyRejected,
  useCreateExternalConnection,
} from "./use-create-external-connection";

export type ConnectAppFlow = ReturnType<typeof useConnectAppFlow>;

/**
 * The one way to connect an app. With a connection provider it creates the
 * connection and opens OAuth; without one, or when Composio rejects the key,
 * Connect asks for the Composio key (render `ConnectAppStatus` to show that
 * dialog).
 */
export function useConnectAppFlow() {
  const { client } = useTeamHubRuntime();
  const catalog = useQuery(externalAppsQueryOptions(client));
  const [setupApp, setSetupApp] = useState<TeamHubExternalApp | null>(null);
  const [keyRejected, setKeyRejected] = useState(false);
  const connection = useCreateExternalConnection({
    onKeyRejected: (appKey) => {
      const app = catalog.data?.apps.find((item) => item.key === appKey);
      if (!app) return;
      setKeyRejected(true);
      setSetupApp(app);
    },
  });
  const configured = catalog.data?.provider_configured === true;

  return {
    canSaveKey: catalog.data?.provider_key.can_save === true,
    configured,
    connection,
    /** Composio refused the current key; the dialog asks for a new one. */
    keyRejected,
    setupApp,
    /** Whether Connect is offered: always while the key is missing. */
    canStart(app: TeamHubExternalApp) {
      return (
        Boolean(catalog.data) &&
        (!configured || app.availability === "available")
      );
    },
    closeSetup() {
      setSetupApp(null);
      setKeyRejected(false);
    },
    keySaved() {
      setKeyRejected(false);
    },
    start(app: TeamHubExternalApp, pending?: TeamHubExternalConnection) {
      if (!configured) {
        setSetupApp(app);
        return;
      }
      void connection.connectOrResume(app.key, pending);
    },
  };
}

/** The flow's error, blocked-popup fallback, and key setup dialog. */
export function ConnectAppStatus({
  className,
  flow,
}: {
  className?: string;
  flow: ConnectAppFlow;
}) {
  const { connection, setupApp } = flow;
  return (
    <>
      {connection.error && !isComposioKeyRejected(connection.error) ? (
        <p className={cn("text-xs text-app-danger", className)} role="alert">
          {connection.error instanceof Error
            ? connection.error.message
            : "Connection could not be started."}
        </p>
      ) : null}
      {connection.blockedConnectUrl ? (
        <div className={cn("text-xs", className)} role="status">
          <p className="text-foreground">
            Your browser blocked the authorization popup.
          </p>
          <Button
            className="mt-1.5"
            onClick={() => {
              if (openOAuthUrl(connection.blockedConnectUrl)) {
                connection.clearBlockedConnectUrl();
              }
            }}
            size="compact"
            tone="primary"
          >
            Open authorization window
          </Button>
        </div>
      ) : null}
      {setupApp ? (
        <ModalDialog
          className="app-key-dialog"
          closeOnBackdrop
          description={
            flow.configured && !flow.keyRejected
              ? undefined
              : flow.keyRejected
                ? flow.canSaveKey
                  ? "Composio no longer accepts the saved API key. Save a new key to keep connecting apps."
                  : "Composio rejected this deployment's API key."
                : flow.canSaveKey
                  ? `Connect ${setupApp.display_name} securely through Composio. Add your API key once to enable your connectors.`
                  : undefined
          }
          onClose={flow.closeSetup}
          size="md"
          title={
            <span className="flex items-center gap-2.5">
              <AppLogoTile
                name={setupApp.display_name}
                small
                url={setupApp.logo_url}
              />
              Connect {setupApp.display_name}
            </span>
          }
        >
          <div className="space-y-4 px-5 py-5 text-sm text-app-body">
            {flow.configured && !flow.keyRejected ? (
              <Button
                onClick={() => {
                  flow.closeSetup();
                  connection.connect(setupApp.key);
                }}
                tone="primary"
              >
                Connect {setupApp.display_name}
              </Button>
            ) : flow.canSaveKey ? (
              <>
                <ComposioKeyGuide />
                <ProviderKeyForm onSaved={flow.keySaved} />
              </>
            ) : flow.keyRejected ? (
              <p className="text-app-muted">
                Update <code className="font-mono">COMPOSIO_API_KEY</code> where
                the server reads it. When Linger is installed on this computer,
                that is <code className="font-mono">user.env</code>; reopen the
                Linger app afterwards.
              </p>
            ) : (
              <ConnectorsNotConfiguredMessage />
            )}
          </div>
        </ModalDialog>
      ) : null}
    </>
  );
}

export function ConnectorsNotConfiguredMessage() {
  return (
    <p className="text-app-muted">
      Connecting Gmail, GitHub, Slack, Notion and other apps needs a Composio
      API key. When Linger is installed on this computer, set{" "}
      <code className="font-mono">COMPOSIO_API_KEY</code> in{" "}
      <code className="font-mono">user.env</code>, then reopen the Linger app.
      On a server you run yourself, set it there, or set{" "}
      <code className="font-mono">TEAMHUB_SECRET_ENCRYPTION_KEY</code> to save
      the key here.
    </p>
  );
}
