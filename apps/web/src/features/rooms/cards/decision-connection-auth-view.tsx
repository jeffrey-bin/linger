import {
  AlertCircleIcon,
  Cancel01Icon,
  Clock01Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import type { IconSvgElement } from "@/components/ui/icon";
import { Select, SelectItem } from "@/components/ui/select";
import {
  externalAppsQueryOptions,
  externalConnectionQueryOptions,
  externalConnectionsQueryKey,
  externalConnectionsQueryOptions,
} from "@/features/apps/connected-apps-queries";
import {
  reauthorizationConnectUrl,
  usableConnectUrl,
} from "@/features/apps/connection-state";
import { openOAuthUrl } from "@/features/apps/oauth-popup";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubExternalConnection } from "@/features/teamhub/teamhub-types";

import { CardActions, CardError, CardRow } from "./approval-card-parts";
import { CardBox, CardDone, type ReceiptTone } from "./card-shell";
import { ConnectedAppIcon } from "./connected-app-identity";
import { connectedAppDisplayName } from "./connected-app-names";
import type { DecisionMessageCard } from "./decision-card";
import type { RoomCardDecision } from "./room-message-card-contract";

interface Props {
  card: DecisionMessageCard;
  currentActorId?: string;
  messageId: string;
  onDecision: (decision: RoomCardDecision) => Promise<void> | void;
}

const label = "App authorization requested";

/**
 * A connection authorization: the Human picks or connects an account of the
 * app the Agent needs. Approving records their consent to that Connection
 * before OAuth starts; TeamHub settles the card once the Connection is
 * active, and that wakes the Agent.
 */
export function ConnectionAuthDecision({
  card,
  currentActorId,
  ...rest
}: Props) {
  const { client } = useTeamHubRuntime();
  const catalog = useQuery(externalAppsQueryOptions(client));
  const appKey = card.connection_auth?.app_key ?? "";
  const appName =
    catalog.data?.apps.find((app) => app.key === appKey)?.display_name ??
    connectedAppDisplayName(appKey);

  if (card.status !== "pending" && card.status !== "authorizing") {
    const result = authorizationResult(card);
    return (
      <ConnectionAuthCard
        appKey={appKey}
        appName={appName}
        card={card}
        done={
          <CardDone icon={result.icon} text={result.text} tone={result.tone} />
        }
      />
    );
  }

  return currentActorId === card.decision_owner.id ? (
    <ConnectionAuthorizationActions
      appKey={appKey}
      appName={appName}
      card={card}
      {...rest}
    />
  ) : (
    <ConnectionAuthCard appKey={appKey} appName={appName} card={card} />
  );
}

/** The Agent's ask, then the app, its account picker, and the actions. */
function ConnectionAuthCard({
  actions,
  appKey,
  appName,
  card,
  children,
  done,
  error,
}: {
  actions?: ReactNode;
  appKey: string;
  appName: string;
  card: DecisionMessageCard;
  children?: ReactNode;
  done?: ReactNode;
  error?: string;
}) {
  return (
    <>
      <CardBox heading={card.title} label={label}>
        <CardRow
          icon={<ConnectedAppIcon appKey={appKey} size={16} />}
          title={appName}
        />
        {children}
        {done ??
          (card.status === "authorizing" ? (
            <CardDone icon={Loading03Icon} text="Authorizing…" tone="muted" />
          ) : null)}
        {actions ? <CardActions>{actions}</CardActions> : null}
        {error ? <CardError>{error}</CardError> : null}
      </CardBox>
    </>
  );
}

/** How a settled authorization ended, in a few words. */
function authorizationResult(card: DecisionMessageCard): {
  icon: IconSvgElement;
  text: string;
  tone: ReceiptTone;
} {
  switch (card.status) {
    case "succeeded":
      return { icon: Tick02Icon, text: "Connected", tone: "success" };
    case "denied":
      return { icon: Cancel01Icon, text: "Not connected", tone: "muted" };
    case "expired":
      return { icon: Clock01Icon, text: "Expired", tone: "muted" };
    default:
      return {
        icon: AlertCircleIcon,
        text: "Failed: the sign-in did not complete",
        tone: "danger",
      };
  }
}

function ConnectionAuthorizationActions({
  appKey,
  appName: fallbackAppName,
  card,
  messageId,
  onDecision,
}: Omit<Props, "currentActorId"> & { appKey: string; appName: string }) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [created, setCreated] = useState<TeamHubExternalConnection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fallbackUrl, setFallbackUrl] = useState("");
  const authorizing = card.status === "authorizing";
  const boundConnectionId = card.connection_auth?.connection_id ?? "";
  const apps = useQuery(externalAppsQueryOptions(client));
  const connections = useQuery({
    ...externalConnectionsQueryOptions(client),
    enabled: !authorizing,
  });
  // The link is read once; the card itself settles from Room events.
  const bound = useQuery({
    ...externalConnectionQueryOptions(client, boundConnectionId),
    enabled: authorizing && Boolean(boundConnectionId),
  });
  const app = apps.data?.apps.find((item) => item.key === appKey);
  const appName = app?.display_name ?? fallbackAppName;
  const agentName = card.requester.display_name;
  const available = (connections.data?.connections ?? []).filter(
    (item) =>
      item.provider === appKey &&
      !["disconnecting", "revoke_pending"].includes(item.status),
  );
  if (created && !available.some((item) => item.id === created.id))
    available.push(created);
  const selected =
    available.find((item) => item.id === selectedId) ??
    available.find((item) => item.status === "active") ??
    available[0];
  const resumeUrl =
    fallbackUrl ||
    reauthorizationConnectUrl(bound.data) ||
    usableConnectUrl(bound.data);

  async function decide(decision: "approve" | "deny", connectionId?: string) {
    await onDecision({
      decision,
      connectionId,
      expectedVersion: card.version,
      messageId,
      requestId: card.decision_id,
    });
  }
  async function authorize(newAccount: boolean) {
    setBusy(true);
    setError("");
    try {
      let connection = newAccount ? undefined : selected;
      let connectUrl = "";
      if (
        app?.supports_reauthorization === false &&
        connection &&
        ["failed", "expired"].includes(connection.status)
      )
        connection = undefined;
      // A pending authorization whose link expired starts over.
      if (connection?.status === "pending") {
        const detail = await client.getExternalConnection(connection.id);
        connectUrl = usableConnectUrl(detail) ?? "";
        if (!connectUrl) connection = undefined;
      }
      if (!connection) {
        if (!app || !app.capabilities.includes("agent_tools"))
          throw new Error("This app is unavailable for Agent access.");
        connection = await client.createExternalConnection(app.key);
        setCreated(connection);
        setSelectedId(connection.id);
        connectUrl = connection.connect_url ?? "";
      } else if (connection.status !== "active" && !connectUrl) {
        connectUrl =
          reauthorizationConnectUrl(connection) ??
          reauthorizationConnectUrl(
            await client.createExternalConnectionReauthorization(
              connection.id,
              connection.revision,
            ),
          ) ??
          "";
      }
      // Consent is durable before OAuth navigation; backend confirmation publishes the completion.
      await decide("approve", connection.id);
      if (connectUrl) {
        setFallbackUrl(connectUrl);
        if (openOAuthUrl(connectUrl)) setFallbackUrl("");
      }
      await queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Authorization could not be started.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    setError("");
    try {
      await decide("deny");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Authorization could not be cancelled.",
      );
    } finally {
      setBusy(false);
    }
  }
  const loadError = apps.error ?? connections.error ?? bound.error;
  const canConnectNew =
    app?.availability === "available" &&
    app.capabilities.includes("agent_tools");
  const loading = !authorizing && (connections.isPending || apps.isPending);
  const primaryAction = resumeUrl ? (
    <Button
      aria-label="Open authorization window"
      disabled={busy}
      size="large"
      tone="primary"
      onClick={() => {
        if (!openOAuthUrl(resumeUrl))
          setError(
            "Your browser blocked the authorization popup. Allow popups and try again.",
          );
      }}
    >
      Open
    </Button>
  ) : authorizing ? null : selected ? (
    <Button
      aria-label={
        selected.status === "active"
          ? `Allow ${agentName}`
          : `Connect ${appName}`
      }
      disabled={busy}
      onClick={() => void authorize(false)}
      size="large"
      tone="primary"
    >
      {selected.status === "active" ? "Allow" : "Connect"}
    </Button>
  ) : loading || canConnectNew ? (
    <Button
      aria-label={`Connect ${appName}`}
      disabled={busy || loading}
      onClick={() => void authorize(true)}
      size="large"
      tone="primary"
    >
      Connect
    </Button>
  ) : null;

  return (
    <ConnectionAuthCard
      actions={
        <>
          {primaryAction}
          <Button
            disabled={busy}
            onClick={() => void cancel()}
            size="large"
            tone="subtle"
          >
            {authorizing ? "Cancel" : "Not now"}
          </Button>
        </>
      }
      appKey={appKey}
      appName={appName}
      card={card}
      error={
        error ||
        (loadError
          ? loadError instanceof Error
            ? loadError.message
            : "Accounts could not be loaded."
          : undefined)
      }
    >
      {!authorizing && available.length > 1 ? (
        <div className="pb-1">
          <Select
            aria-label={`${appName} account`}
            className="h-8 w-full px-2.5 text-sm"
            disabled={busy}
            onValueChange={setSelectedId}
            value={selected?.id ?? ""}
          >
            {available.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {`${connection.identity_label || appName}${
                  connection.status !== "active"
                    ? ` (${connection.status})`
                    : ""
                }`}
              </SelectItem>
            ))}
          </Select>
        </div>
      ) : null}
    </ConnectionAuthCard>
  );
}
