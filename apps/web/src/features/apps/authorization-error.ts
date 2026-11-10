export const INSUFFICIENT_PERMISSION_MESSAGE =
  "This app did not grant enough permission. Reconnect and approve all requested access.";

export function connectionStatusErrorMessage(
  statusErrorCode: string | null | undefined,
): string | undefined {
  switch (statusErrorCode) {
    case "discord_guild_required":
      return "Discord could not verify the authorized Server. Reconnect from Apps.";
    case "duplicate_remote_principal":
      return "This account is already connected.";
    case "provider_auth_failed":
      return INSUFFICIENT_PERMISSION_MESSAGE;
    default:
      return undefined;
  }
}

export function connectionAuthorizationError(connection: {
  status: string;
  status_error_code?: string | null;
}): string | undefined {
  return (
    connectionStatusErrorMessage(connection.status_error_code) ??
    (connection.status === "failed" || connection.status === "expired"
      ? "Authorization failed. Reconnect this app and approve the requested access."
      : undefined)
  );
}
