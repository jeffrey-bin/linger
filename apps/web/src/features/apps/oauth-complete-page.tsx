import { useEffect } from "react";

import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

export const OAUTH_COMPLETE_PATH = "/oauth/composio-complete";

// The window waits at most this long for TeamHub to take the completion.
const COMPLETE_WAIT_MS = 3000;

export function OAuthCompletePage() {
  const { client } = useTeamHubRuntime();

  useEffect(() => {
    // TeamHub checks the account with Composio; returning here is never
    // evidence that authorization succeeded.
    const connectedAccountId =
      new URLSearchParams(window.location.search).get("connected_account_id") ??
      undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      client
        .completeExternalConnectionAuthorization(connectedAccountId)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, COMPLETE_WAIT_MS);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      window.close();
    });
  }, [client]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
      <div className="max-w-md">
        <h1 className="text-lg">Authorization complete</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You can close this window.
        </p>
      </div>
    </main>
  );
}
