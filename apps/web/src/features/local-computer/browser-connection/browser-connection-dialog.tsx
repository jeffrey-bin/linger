import { Cancel01Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormFeedback } from "@/components/ui/form-feedback";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Select, SelectItem } from "@/components/ui/select";
import { StatusPill } from "@/components/ui/status-pill";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubBrowserConnectionStatus } from "@/features/teamhub/teamhub-types";

import { localComputersQueryOptions } from "../local-computer-queries";
import {
  browserConnectionQueryKey,
  browserConnectionQueryOptions,
  configureBrowserConnection,
  disconnectBrowserConnection,
} from "./browser-connection-api";
import {
  browserConnectionErrorMessage,
  browserConnectionStateCopy,
  PLAYWRIGHT_EXTENSION_URL,
} from "./browser-connection-copy";

type PendingAction = "configure" | "disconnect" | null;

/**
 * Connects browser tools on one of the user's Local Computers to their own
 * Chrome. The pasted token lives only in this component's input state until
 * it is sent; it never enters a Message, Card, query cache, or storage.
 */
export function BrowserConnectionDialog({
  computerId: lockedComputerId,
  onClose,
  reason,
  tenantId,
}: {
  /** Connects only this Computer, such as the one a chat card names. */
  computerId?: string;
  onClose: () => void;
  /** Why the guide opened, such as an Agent waiting for Chrome. */
  reason?: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const inventory = useQuery(localComputersQueryOptions(client, tenantId));
  const computers = inventory.data?.items ?? [];
  const [requestedComputerId, setRequestedComputerId] =
    useState(lockedComputerId);
  // A locked Computer never falls back to another one.
  const computer = lockedComputerId
    ? computers.find(({ computer_id }) => computer_id === lockedComputerId)
    : (computers.find(
        ({ computer_id }) => computer_id === requestedComputerId,
      ) ??
      computers.find(({ status }) => status === "online") ??
      computers[0]);
  const online = computer?.status === "online";
  const status = useQuery({
    ...browserConnectionQueryOptions(
      client,
      tenantId,
      computer?.computer_id ?? "",
    ),
    enabled: Boolean(computer && online),
  });
  const [pastedToken, setPastedToken] = useState("");
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [failure, setFailure] = useState<string | null>(null);

  function selectComputer(computerId: string) {
    setRequestedComputerId(computerId);
    setPastedToken("");
    setEditing(false);
    setFailure(null);
  }

  async function run(
    action: Exclude<PendingAction, null>,
    send: () => Promise<TeamHubBrowserConnectionStatus>,
  ) {
    if (!computer) return;
    const computerId = computer.computer_id;
    setPending(action);
    setFailure(null);
    try {
      const next = await send();
      queryClient.setQueryData(
        browserConnectionQueryKey(tenantId, computerId),
        next,
      );
      setEditing(false);
    } catch (error) {
      setFailure(browserConnectionErrorMessage(error));
    } finally {
      setPending(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!computer || pending || !pastedToken.trim()) return;
    const token = pastedToken;
    // Clear the field before the request so the token does not stay in state.
    setPastedToken("");
    void run("configure", () =>
      configureBrowserConnection(client, tenantId, computer.computer_id, token),
    );
  }

  function requestClose() {
    if (!pending) onClose();
  }

  const current = status.data;
  const unsupported = current?.state === "unsupported";
  // A damaged saved connection fails the status read; a new paste replaces it.
  const savedConnectionInvalid =
    status.error instanceof TeamHubError &&
    status.error.code === "BROWSER_CONNECTION_INVALID";
  const showForm =
    online &&
    (status.isSuccess || savedConnectionInvalid) &&
    !unsupported &&
    (editing || !isLinked(current));

  return (
    <ModalDialog
      ariaLabel="Connect my browser"
      className="fixed inset-0 z-50 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[480px] overflow-auto rounded-xl border border-border bg-popover p-0 shadow-lg backdrop:bg-[var(--app-overlay)]"
      onClose={requestClose}
    >
      <div className="p-5">
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg">Connect my browser</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Let Agent browser tasks on this Computer use your everyday Chrome
              and its sign-ins. The token goes only to your Computer and never
              appears in chat.
            </p>
            {reason ? (
              <p className="mt-2 text-sm font-medium text-foreground">
                {reason}
              </p>
            ) : null}
          </div>
          <Button
            aria-label="Close"
            disabled={pending !== null}
            onClick={requestClose}
            size="icon"
            tone="ghost"
          >
            <Icon icon={Cancel01Icon} size={16} />
          </Button>
        </header>

        {inventory.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading your Computers…
          </p>
        ) : inventory.isError ? (
          <FormFeedback tone="danger">
            Can't load your Computers right now.
          </FormFeedback>
        ) : !computer ? (
          <FormFeedback tone="info">
            {lockedComputerId
              ? "This Computer is no longer connected to your account."
              : "You don't have a Local Computer yet. Connect one in Settings > Computers first. Cloud Computers can't use your browser."}
          </FormFeedback>
        ) : (
          <div className="space-y-5">
            {lockedComputerId ? (
              <p className="text-sm text-foreground">
                Computer:{" "}
                <span className="font-medium">{computer.display_name}</span>
              </p>
            ) : (
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-foreground">
                  Computer
                </span>
                <Select
                  aria-label="Computer"
                  className="ui-field-control w-full text-sm"
                  disabled={pending !== null}
                  onValueChange={selectComputer}
                  value={computer.computer_id}
                >
                  {computers.map((item) => (
                    <SelectItem key={item.computer_id} value={item.computer_id}>
                      {item.status === "online"
                        ? item.display_name
                        : `${item.display_name} (offline)`}
                    </SelectItem>
                  ))}
                </Select>
              </label>
            )}

            <BrowserConnectionStatusSection
              current={current}
              error={status.error}
              loading={online && status.isPending}
              online={online}
            />

            {online &&
            current &&
            !unsupported &&
            isLinked(current) &&
            !editing ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={pending !== null}
                  onClick={() => {
                    setFailure(null);
                    setEditing(true);
                  }}
                >
                  Reconfigure
                </Button>
                <Button
                  disabled={pending !== null}
                  onClick={() =>
                    void run("disconnect", () =>
                      disconnectBrowserConnection(
                        client,
                        tenantId,
                        computer.computer_id,
                      ),
                    )
                  }
                  tone="danger"
                >
                  {pending === "disconnect" ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            ) : null}

            {showForm ? (
              <form className="space-y-4" onSubmit={submit}>
                <ol className="list-decimal space-y-1.5 pl-5 text-sm text-foreground">
                  <li>
                    Install{" "}
                    <a
                      className="inline-flex items-center gap-1 font-medium text-app-link underline-offset-2 hover:underline"
                      href={PLAYWRIGHT_EXTENSION_URL}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Playwright Extension
                      <Icon icon={LinkSquare02Icon} size={14} />
                    </a>{" "}
                    in Chrome
                  </li>
                  <li>
                    Click the extension icon and copy the token it shows (the
                    full{" "}
                    <code className="break-all text-xs">
                      PLAYWRIGHT_MCP_EXTENSION_TOKEN=…
                    </code>{" "}
                    line also works)
                  </li>
                  <li>Paste it below and connect</li>
                </ol>
                <Field
                  autoCapitalize="off"
                  autoComplete="off"
                  autoCorrect="off"
                  data-1p-ignore=""
                  data-lpignore="true"
                  disabled={pending !== null}
                  label="Extension token"
                  name="playwright-extension-token"
                  onChange={(event) => {
                    setFailure(null);
                    setPastedToken(event.target.value);
                  }}
                  placeholder="Paste token"
                  spellCheck={false}
                  type="password"
                  value={pastedToken}
                />
                <div className="flex justify-end gap-2">
                  {editing ? (
                    <Button
                      disabled={pending !== null}
                      onClick={() => {
                        setPastedToken("");
                        setEditing(false);
                      }}
                    >
                      Cancel
                    </Button>
                  ) : null}
                  <Button
                    disabled={pending !== null || !pastedToken.trim()}
                    tone="primary"
                    type="submit"
                  >
                    {pending === "configure"
                      ? "Connecting, up to 1 minute…"
                      : "Connect"}
                  </Button>
                </div>
              </form>
            ) : null}

            {failure ? (
              <FormFeedback tone="danger">{failure}</FormFeedback>
            ) : null}
          </div>
        )}
      </div>
    </ModalDialog>
  );
}

function BrowserConnectionStatusSection({
  current,
  error,
  loading,
  online,
}: {
  current: TeamHubBrowserConnectionStatus | undefined;
  error: unknown;
  loading: boolean;
  online: boolean;
}) {
  if (!online) {
    return (
      <FormFeedback tone="info">
        This Computer is offline. Make sure it's on and running Linger Computer.
      </FormFeedback>
    );
  }
  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Checking browser status…
      </p>
    );
  }
  if (!current) {
    return (
      <FormFeedback tone="danger">
        {browserConnectionErrorMessage(error)}
      </FormFeedback>
    );
  }
  return <BrowserConnectionSummary status={current} />;
}

function BrowserConnectionSummary({
  status,
}: {
  status: TeamHubBrowserConnectionStatus;
}) {
  const copy = browserConnectionStateCopy(status.state);
  return (
    <div className="space-y-2" role="status">
      <StatusPill tone={copy.tone}>{copy.short}</StatusPill>
      <p className="text-sm text-foreground">{copy.label}</p>
      {status.message ? (
        <p className="text-sm text-muted-foreground">{status.message}</p>
      ) : null}
    </div>
  );
}

// A user Chrome connection exists, even when the Computer reports a problem.
function isLinked(status: TeamHubBrowserConnectionStatus | undefined) {
  return status?.mode === "user_chrome";
}
