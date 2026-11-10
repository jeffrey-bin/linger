import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubExternalAppKey,
  TeamHubExternalConnection,
} from "@/features/teamhub/teamhub-types";

import { externalConnectionsQueryKey } from "./connected-apps-queries";
import { usableConnectUrl } from "./connection-state";
import { openOAuthUrl } from "./oauth-popup";

/** Composio refused the project API key, so a new key is needed to connect. */
export function isComposioKeyRejected(error: unknown) {
  return (
    error instanceof TeamHubError && error.code === "COMPOSIO_KEY_REJECTED"
  );
}

export function useCreateExternalConnection({
  onKeyRejected,
}: {
  onKeyRejected?: (appKey: TeamHubExternalAppKey) => void;
} = {}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [blockedConnectUrl, setBlockedConnectUrl] = useState("");
  const createConnection = useMutation({
    mutationFn: (appKey: TeamHubExternalAppKey) =>
      client.createExternalConnection(appKey),
    onSuccess: async (connection) => {
      if (connection.connect_url && !openOAuthUrl(connection.connect_url)) {
        setBlockedConnectUrl(connection.connect_url);
      }
      await queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      });
    },
    onError: (error, appKey) => {
      if (isComposioKeyRejected(error)) onKeyRejected?.(appKey);
    },
  });

  function resume(connectUrl: string) {
    setBlockedConnectUrl("");
    if (!openOAuthUrl(connectUrl)) setBlockedConnectUrl(connectUrl);
  }

  function connect(appKey: TeamHubExternalAppKey) {
    setBlockedConnectUrl("");
    createConnection.mutate(appKey);
  }

  async function connectOrResume(
    appKey: TeamHubExternalAppKey,
    pending?: TeamHubExternalConnection,
  ) {
    if (pending) {
      try {
        const connectUrl = usableConnectUrl(
          pending.connect_url
            ? pending
            : await client.getExternalConnection(pending.id),
        );
        if (connectUrl) {
          resume(connectUrl);
          return;
        }
      } catch {
        // Fall through and start a new connection.
      }
    }
    connect(appKey);
  }

  return {
    blockedConnectUrl,
    connect,
    connectOrResume,
    error: createConnection.error,
    isPending: createConnection.isPending,
    resume,
    clearBlockedConnectUrl() {
      setBlockedConnectUrl("");
    },
  };
}
