import type { TeamHubAuthenticationReason } from "./teamhub-authentication";

// One EventSource lifecycle for the TeamHub streams: connection generations,
// reconnect backoff with jitter, waiting for the network, Session expiry and
// page activity. Each stream adds its URL and event parsing.

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export type EventSourceFactory = (
  url: string,
  options: { withCredentials: boolean },
) => EventSourceLike;

export interface EventStreamClock {
  clearTimeout(timer: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
}

export interface EventStreamNetwork {
  isOnline(): boolean;
  subscribeOnline(listener: () => void): () => void;
}

export interface PageActivity {
  isActive(): boolean;
  subscribe(listener: (active: boolean) => void): () => void;
}

export const alwaysActivePageActivity: PageActivity = {
  isActive: () => true,
  subscribe: () => () => undefined,
};

export interface EventStreamOptions {
  clock?: EventStreamClock;
  eventSourceFactory?: EventSourceFactory;
  maximumReconnectDelayMs?: number;
  network?: EventStreamNetwork;
  pageActivity?: PageActivity;
  random?: () => number;
  reconnectDelayMs?: number;
}

// One connection attempt. A replaced, failed, stopped or disposed attempt is
// no longer current, and every callback it still receives is ignored.
export interface EventStreamConnection {
  fail(error: Error): void;
  isCurrent(): boolean;
  resetBackoff(): void;
  // Ends the stream for good, as Session expiry does.
  stop(): void;
}

export interface EventStreamHandlers {
  // Message of the error reported when the EventSource closes.
  closedMessage: string;
  // Named events; data is the raw event text.
  events: Record<
    string,
    (data: string, connection: EventStreamConnection) => void
  >;
  onError?: (error: Error) => void;
  onOpen?: (connection: EventStreamConnection) => void;
  onSessionExpired: (reason: TeamHubAuthenticationReason) => void;
  // A failed connection waits for the network or for its backoff.
  onWaiting?: (state: "offline" | "reconnecting") => void;
  // Builds each connection's URL; a stream may first catch up over REST.
  prepare(
    connection: EventStreamConnection,
    reconnecting: boolean,
  ): Promise<URL> | URL;
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAXIMUM_RECONNECT_DELAY_MS = 30_000;

// openEventStream keeps one credentialed EventSource open while the page is
// active and returns its disposer.
export function openEventStream(
  options: EventStreamOptions,
  handlers: EventStreamHandlers,
): () => void {
  const clock = options.clock ?? browserClock;
  const eventSourceFactory =
    options.eventSourceFactory ?? ((url, init) => new EventSource(url, init));
  const network = options.network ?? browserNetwork;
  const pageActivity = options.pageActivity ?? alwaysActivePageActivity;
  const random = options.random ?? Math.random;
  const reconnectDelayMs =
    options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const maximumReconnectDelayMs =
    options.maximumReconnectDelayMs ?? DEFAULT_MAXIMUM_RECONNECT_DELAY_MS;

  let disposed = false;
  let expired = false;
  let source: EventSourceLike | undefined;
  let reconnectTimer: unknown;
  let stopWaitingForOnline: (() => void) | undefined;
  let reconnectAttempt = 0;
  let generation = 0;
  let pageActive = pageActivity.isActive();

  const closeSource = () => {
    source?.close();
    source = undefined;
  };
  const clearWait = () => {
    if (reconnectTimer !== undefined) {
      clock.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    stopWaitingForOnline?.();
    stopWaitingForOnline = undefined;
  };

  const connection = (current: number): EventStreamConnection => {
    const isCurrent = () => !disposed && !expired && current === generation;
    return {
      isCurrent,
      fail(error) {
        if (
          !isCurrent() ||
          reconnectTimer !== undefined ||
          stopWaitingForOnline
        ) {
          return;
        }
        closeSource();
        const waiting = ++generation;
        handlers.onError?.(error);
        const reconnect = () => {
          clearWait();
          if (!disposed && !expired && waiting === generation) {
            connect(true);
          }
        };
        if (network.isOnline()) {
          handlers.onWaiting?.("reconnecting");
        } else {
          handlers.onWaiting?.("offline");
          stopWaitingForOnline = network.subscribeOnline(() => {
            if (network.isOnline()) reconnect();
          });
        }
        const delay = reconnectDelay({
          attempt: reconnectAttempt,
          baseDelayMs: reconnectDelayMs,
          maximumDelayMs: maximumReconnectDelayMs,
          random,
        });
        reconnectAttempt += 1;
        reconnectTimer = clock.setTimeout(() => {
          reconnectTimer = undefined;
          reconnect();
        }, delay);
      },
      resetBackoff() {
        if (isCurrent()) reconnectAttempt = 0;
      },
      stop() {
        if (!isCurrent()) return;
        expired = true;
        generation += 1;
        clearWait();
        closeSource();
      },
    };
  };

  const open = (active: EventStreamConnection, url: URL) => {
    if (!active.isCurrent()) return;
    const next = eventSourceFactory(url.href, { withCredentials: true });
    if (!active.isCurrent()) {
      next.close();
      return;
    }
    source = next;
    next.addEventListener("open", () => {
      if (active.isCurrent()) handlers.onOpen?.(active);
    });
    for (const [type, handle] of Object.entries(handlers.events)) {
      next.addEventListener(type, (event) => {
        if (active.isCurrent()) handle(event.data as string, active);
      });
    }
    next.addEventListener("session.expired", () => {
      if (!active.isCurrent()) return;
      active.stop();
      handlers.onSessionExpired("session-expired");
    });
    next.addEventListener("error", () => {
      active.fail(new Error(handlers.closedMessage));
    });
  };

  // A synchronous prepare opens the EventSource in the same call.
  const connect = (reconnecting: boolean) => {
    if (disposed || expired || !pageActive) return;
    const active = connection(++generation);
    closeSource();
    const fail = (error: unknown) =>
      active.fail(
        error instanceof Error ? error : new Error(handlers.closedMessage),
      );
    try {
      const url = handlers.prepare(active, reconnecting);
      if (url instanceof URL) open(active, url);
      else url.then((resolved) => open(active, resolved), fail);
    } catch (error) {
      fail(error);
    }
  };

  const stopObservingPageActivity = pageActivity.subscribe((active) => {
    if (disposed || expired || active === pageActive) return;
    pageActive = active;
    if (!active) {
      generation += 1;
      clearWait();
      closeSource();
      return;
    }
    connect(true);
  });

  if (pageActive) connect(false);

  return () => {
    disposed = true;
    generation += 1;
    stopObservingPageActivity();
    clearWait();
    closeSource();
  };
}

// reconnectDelay doubles from the base delay up to the maximum and scales it
// by a random factor between 0.5 and 1, so tabs do not reconnect in step.
export function reconnectDelay({
  attempt,
  baseDelayMs,
  maximumDelayMs,
  random,
}: {
  attempt: number;
  baseDelayMs: number;
  maximumDelayMs: number;
  random: () => number;
}) {
  const exponentialDelay = Math.min(
    maximumDelayMs,
    baseDelayMs * 2 ** Math.min(attempt, 20),
  );
  const jitter = 0.5 + Math.min(1, Math.max(0, random())) * 0.5;
  return Math.max(1, Math.round(exponentialDelay * jitter));
}

const browserClock: EventStreamClock = {
  clearTimeout: (timer) =>
    globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
};

const browserNetwork: EventStreamNetwork = {
  isOnline: () => globalThis.navigator?.onLine !== false,
  subscribeOnline(listener) {
    globalThis.addEventListener?.("online", listener, { once: true });
    return () => globalThis.removeEventListener?.("online", listener);
  },
};
