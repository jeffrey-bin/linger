import {
  Alert02Icon,
  LaptopIcon,
  Logout01Icon,
  SecurityCheckIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { LOGOUT_ERROR_MESSAGE, useLogout } from "@/features/auth/use-logout";
import {
  teamHubSessionQueryOptions,
  teamHubTenantsQueryOptions,
} from "@/features/rooms/room-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { publishLocalComputerEnrollment } from "./local-computer-enrollment-events";

const PKCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface ConnectRequest {
  readonly codeChallenge: string;
  readonly displayName: string;
  readonly existingComputerId?: string;
  readonly redirectUri: URL;
  readonly state: string;
}

export function ConnectComputerPage({
  navigateToCallback = (url) => window.location.assign(url),
}: {
  navigateToCallback?: (url: string) => void;
}) {
  const [searchParams] = useSearchParams();
  const request = useMemo(
    () => parseConnectRequest(searchParams),
    [searchParams],
  );
  const { client } = useTeamHubRuntime();
  const location = useLocation();
  const session = useQuery(teamHubSessionQueryOptions(client));
  const tenants = useQuery(teamHubTenantsQueryOptions(client));
  const [requestedTenantId, setRequestedTenantId] = useState("");
  const [replacementReason, setReplacementReason] = useState<
    "removed" | "wrong-account" | null
  >(null);
  const selectedTenant =
    tenants.data?.items.find(({ id }) => id === requestedTenantId) ??
    tenants.data?.items[0];
  const enrollment = useMutation({
    mutationFn: async () => {
      if (!request || !selectedTenant) {
        throw new Error("Connection request is unavailable.");
      }
      return await teamHubData(
        client.api.POST("/v0/tenants/{tenantId}/local-computer-enrollments", {
          params: { path: { tenantId: selectedTenant.id } },
          body: {
            code_challenge: request.codeChallenge,
            ...(request.existingComputerId
              ? { computer_id: request.existingComputerId }
              : {}),
            display_name: request.displayName,
            redirect_uri: request.redirectUri.toString(),
          },
        }),
      );
    },
    onSuccess: (authorization) => {
      if (!request) return;
      publishLocalComputerEnrollment({
        computerId: authorization.computer_id,
        tenantId: selectedTenant?.id ?? "",
      });
      const callback = request.redirectUri;
      callback.searchParams.set("state", request.state);
      callback.searchParams.set("enrollment_id", authorization.enrollment_id);
      callback.searchParams.set("code", authorization.authorization_code);
      navigateToCallback(callback.toString());
    },
    onError: (error) => {
      if (
        !request?.existingComputerId ||
        !requiresLocalIdentityReplacement(error)
      ) {
        return;
      }
      setReplacementReason(
        error instanceof TeamHubError && error.status === 410
          ? "removed"
          : "wrong-account",
      );
    },
  });
  const switchAccount = useLogout({
    returnTo: `${location.pathname}${location.search}`,
  });

  const confirmReplacement = () => {
    if (!request) return;
    const callback = request.redirectUri;
    callback.searchParams.set("state", request.state);
    callback.searchParams.set("error", "local_computer_replacement_required");
    navigateToCallback(callback.toString());
  };

  const cancelReplacement = () => {
    if (!request) return;
    const callback = request.redirectUri;
    callback.searchParams.set("state", request.state);
    callback.searchParams.set("error", "local_computer_replacement_cancelled");
    navigateToCallback(callback.toString());
  };

  if (!request) {
    return <InvalidConnectionRequest />;
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-5 py-10 text-foreground">
      <section className="w-full max-w-[480px] overflow-hidden rounded-2xl border border-border bg-card shadow-md">
        <header className="flex items-center gap-3 border-b border-border px-6 py-5">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Icon icon={LaptopIcon} size={20} />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Linger Computer
            </p>
            <h1 className="truncate text-lg">
              {request.existingComputerId ? "Reconnect" : "Connect"}{" "}
              {request.displayName}
            </h1>
          </div>
        </header>

        <div className="space-y-5 px-6 py-6">
          <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3.5">
            <Icon
              icon={SecurityCheckIcon}
              className="mt-0.5 shrink-0 text-foreground"
              size={20}
            />
            <div>
              <p className="text-sm font-medium">Local runtime access</p>
              <p className="mt-1 text-sm text-muted-foreground">
                The Computer will appear as an available runtime for your
                account.
              </p>
            </div>
          </div>

          {tenants.isPending ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading spaces...
            </p>
          ) : tenants.error ? (
            <p className="text-sm text-app-danger" role="alert">
              Spaces are unavailable.
            </p>
          ) : tenants.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="status">
              No space is available for this account.
            </p>
          ) : (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">Space</span>
              <Select
                aria-label="Space"
                className="ui-field-control w-full text-sm"
                onValueChange={setRequestedTenantId}
                value={selectedTenant?.id ?? ""}
              >
                {tenants.data.items.map((tenant) => (
                  <SelectItem key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </SelectItem>
                ))}
              </Select>
            </label>
          )}

          {session.data ? (
            <p className="text-sm text-muted-foreground">
              Signed in as{" "}
              <span className="font-medium text-foreground">
                {session.data.identity.account.email}
              </span>
            </p>
          ) : null}

          {replacementReason ? (
            <div
              className="space-y-3 border-l-2 border-app-danger pl-3"
              role="alert"
            >
              <div className="flex items-start gap-2">
                <Icon
                  icon={Alert02Icon}
                  className="mt-0.5 shrink-0 text-app-danger"
                  size={16}
                />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Confirm Local Computer replacement
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {replacementReason === "removed"
                      ? "This Computer was removed from the signed-in account."
                      : "This Computer cannot be renewed by the signed-in account."}{" "}
                    Continuing stops the old local daemon and connects this
                    machine as a new Computer for the account shown above. The
                    old Computer and its Agents are not deleted from the server.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button onClick={cancelReplacement}>Keep current setup</Button>
                <Button onClick={confirmReplacement} tone="danger">
                  Replace local identity
                </Button>
              </div>
            </div>
          ) : enrollment.error ? (
            <p
              className="rounded-lg border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)] px-3 py-2.5 text-sm text-app-danger"
              role="alert"
            >
              The Computer could not be connected. Run setup again.
            </p>
          ) : null}

          {switchAccount.error ? (
            <p className="text-sm text-app-danger" role="alert">
              {LOGOUT_ERROR_MESSAGE}
            </p>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/40 px-6 py-4">
          <Button
            disabled={
              !session.data || switchAccount.isPending || enrollment.isPending
            }
            onClick={() => switchAccount.mutate()}
            tone="ghost"
          >
            <Icon icon={Logout01Icon} size={16} />
            {switchAccount.isPending ? "Signing out..." : "Use another account"}
          </Button>
          <Button
            disabled={
              !selectedTenant ||
              switchAccount.isPending ||
              enrollment.isPending ||
              replacementReason !== null
            }
            onClick={() => enrollment.mutate()}
            tone="primary"
          >
            {enrollment.isPending
              ? "Connecting..."
              : request.existingComputerId
                ? "Reconnect computer"
                : "Connect computer"}
          </Button>
        </footer>
      </section>
    </main>
  );
}

const requiresLocalIdentityReplacement = (error: unknown): boolean =>
  error instanceof TeamHubError &&
  ((error.status === 410 && error.code === "LOCAL_COMPUTER_REMOVED") ||
    (error.status === 404 && error.code === "INVALID_ENROLLMENT"));

function InvalidConnectionRequest() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
      <div className="max-w-sm">
        <h1 className="text-lg">Connection request is invalid</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Return to the terminal and run setup again.
        </p>
      </div>
    </main>
  );
}

const parseConnectRequest = (
  searchParams: URLSearchParams,
): ConnectRequest | null => {
  const expectedKeys = [
    "code_challenge",
    "display_name",
    "redirect_uri",
    "state",
  ];
  const keys = [...searchParams.keys()].sort();
  if (
    (keys.join(",") !== [...expectedKeys].sort().join(",") &&
      keys.join(",") !== [...expectedKeys, "computer_id"].sort().join(",")) ||
    keys.some((key) => searchParams.getAll(key).length !== 1)
  ) {
    return null;
  }
  const codeChallenge = searchParams.get("code_challenge") ?? "";
  const displayName = searchParams.get("display_name") ?? "";
  const existingComputerId = searchParams.get("computer_id") ?? undefined;
  const redirectUri = safeLoopbackCallback(
    searchParams.get("redirect_uri") ?? "",
  );
  const state = searchParams.get("state") ?? "";
  if (
    !PKCE_PATTERN.test(codeChallenge) ||
    !PKCE_PATTERN.test(state) ||
    displayName.trim().length === 0 ||
    displayName.length > 120 ||
    (existingComputerId !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(existingComputerId)) ||
    !redirectUri
  ) {
    return null;
  }
  return {
    codeChallenge,
    displayName,
    ...(existingComputerId ? { existingComputerId } : {}),
    redirectUri,
    state,
  };
};

const safeLoopbackCallback = (value: string): URL | null => {
  let callback: URL;
  try {
    callback = new URL(value);
  } catch {
    return null;
  }
  const port = Number(callback.port);
  return callback.protocol === "http:" &&
    callback.hostname === "127.0.0.1" &&
    callback.host === `127.0.0.1:${callback.port}` &&
    callback.pathname === "/callback" &&
    callback.username === "" &&
    callback.password === "" &&
    callback.search === "" &&
    callback.hash === "" &&
    Number.isSafeInteger(port) &&
    port > 0 &&
    port <= 65535
    ? callback
    : null;
};
