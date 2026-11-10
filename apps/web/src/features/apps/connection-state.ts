import type { TeamHubExternalConnection } from "@/features/teamhub/teamhub-types";

const NEEDS_ATTENTION = new Set<TeamHubExternalConnection["status"]>([
  "expired",
  "failed",
]);

export function externalConnectionNeedsAttention(
  connection: TeamHubExternalConnection,
) {
  return (
    NEEDS_ATTENTION.has(connection.status) &&
    connection.status_error_code !== "duplicate_remote_principal"
  );
}

export function establishedExternalConnections(
  connections: TeamHubExternalConnection[],
) {
  return connections.filter((connection) =>
    ["active", "disconnecting", "revoke_pending"].includes(connection.status),
  );
}

export function activeExternalConnections(
  connections: TeamHubExternalConnection[],
) {
  return connections.filter((connection) => connection.status === "active");
}

/**
 * Whether the Connect Link of a pending connection or reauthorization can
 * still be opened. An expired link needs a new authorization.
 */
export function connectLinkOpen(authorization: {
  connect_expires_at?: string;
}) {
  return (
    !authorization.connect_expires_at ||
    Date.parse(authorization.connect_expires_at) > Date.now()
  );
}

/** The Connect Link of a pending authorization while it can still be opened. */
export function usableConnectUrl(authorization?: {
  connect_url?: string;
  connect_expires_at?: string;
}) {
  return authorization?.connect_url && connectLinkOpen(authorization)
    ? authorization.connect_url
    : undefined;
}

/** The open Connect Link of a reauthorization in progress, if any. */
export function reauthorizationConnectUrl(connection?: {
  reauthorizing?: boolean;
  reauthorization_connect_url?: string;
  reauthorization_connect_expires_at?: string;
}) {
  if (!connection?.reauthorizing) return undefined;
  return usableConnectUrl({
    connect_url: connection.reauthorization_connect_url,
    connect_expires_at: connection.reauthorization_connect_expires_at,
  });
}
