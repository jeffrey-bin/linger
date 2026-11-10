export type TeamHubAuthenticationEventKind =
  | "authenticated"
  | "authentication-required";

export type TeamHubAuthenticationReason = "session-expired";

interface TeamHubAuthenticationEvent {
  kind: TeamHubAuthenticationEventKind;
  reason?: TeamHubAuthenticationReason;
  version: 1;
}

interface BroadcastChannelLike {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  close(): void;
  postMessage(message: TeamHubAuthenticationEvent): void;
}

type TeamHubAuthenticationListener = (
  kind: TeamHubAuthenticationEventKind,
  reason?: TeamHubAuthenticationReason,
) => void;

const channelName = "linger:teamhub-authentication:v1";

export function createTeamHubAuthenticationSignals({
  channelFactory = createBrowserBroadcastChannel,
}: {
  channelFactory?: (name: string) => BroadcastChannelLike | null;
} = {}) {
  const listeners = new Set<TeamHubAuthenticationListener>();
  let channel: BroadcastChannelLike | null | undefined;

  function notify(event: TeamHubAuthenticationEvent) {
    for (const listener of listeners) {
      if (event.reason) {
        listener(event.kind, event.reason);
      } else {
        listener(event.kind);
      }
    }
  }

  function getChannel() {
    if (channel !== undefined) {
      return channel;
    }

    channel = channelFactory(channelName);
    channel?.addEventListener("message", (message) => {
      const event = parseAuthenticationEvent(message.data);
      if (event) {
        notify(event);
      }
    });
    return channel;
  }

  function broadcast(
    kind: TeamHubAuthenticationEventKind,
    reason?: TeamHubAuthenticationReason,
  ) {
    getChannel()?.postMessage({ kind, reason, version: 1 });
  }

  return {
    broadcast,
    close() {
      channel?.close();
      channel = undefined;
      listeners.clear();
    },
    publish(
      kind: TeamHubAuthenticationEventKind,
      reason?: TeamHubAuthenticationReason,
    ) {
      notify({ kind, reason, version: 1 });
      broadcast(kind, reason);
    },
    subscribe(listener: TeamHubAuthenticationListener) {
      listeners.add(listener);
      getChannel();
      return () => listeners.delete(listener);
    },
  };
}

export type TeamHubAuthenticationSignals = ReturnType<
  typeof createTeamHubAuthenticationSignals
>;

export const teamHubAuthenticationSignals =
  createTeamHubAuthenticationSignals();

export function announceTeamHubAuthenticated() {
  teamHubAuthenticationSignals.broadcast("authenticated");
}

export function announceTeamHubAuthenticationRequired(
  reason: TeamHubAuthenticationReason = "session-expired",
) {
  teamHubAuthenticationSignals.broadcast("authentication-required", reason);
}

export function reportTeamHubAuthenticationRequired(
  reason: TeamHubAuthenticationReason = "session-expired",
) {
  teamHubAuthenticationSignals.publish("authentication-required", reason);
}

function createBrowserBroadcastChannel(name: string) {
  if (typeof globalThis.BroadcastChannel !== "function") {
    return null;
  }

  try {
    return new globalThis.BroadcastChannel(name);
  } catch {
    return null;
  }
}

function parseAuthenticationEvent(
  value: unknown,
): TeamHubAuthenticationEvent | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("kind" in value) ||
    (value.kind !== "authenticated" && value.kind !== "authentication-required")
  ) {
    return null;
  }

  const reason =
    "reason" in value && value.reason === "session-expired"
      ? value.reason
      : undefined;
  return { kind: value.kind, reason, version: 1 };
}
