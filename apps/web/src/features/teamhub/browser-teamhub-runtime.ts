import { createRunStatusTransport } from "./run-status-transport";
import type { PageActivity } from "./event-stream";
import { createTeamHubEventTransport } from "./event-transport";
import { createHttpTeamHubClient } from "./teamhub-client";
import type { TeamHubRuntime } from "./teamhub-runtime";
import type { VoiceEventFeed } from "./voice-event-transport";

// TeamHub and the Document Runtime share the page origin; the Vite dev
// server proxies both.
export function createBrowserTeamHubRuntime(): TeamHubRuntime {
  const documentRuntimeUrl = resolveDocumentRuntimeUrl();
  const client = createHttpTeamHubClient();
  const realtimeActivity = createBrowserRealtimeActivity();
  const events = createTeamHubEventTransport({
    pageActivity: realtimeActivity,
  });

  return {
    client,
    documentRuntimeUrl,
    voiceEvents: {
      subscribe(input) {
        let disposed = false;
        let feed: VoiceEventFeed | undefined;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let loaded!: (feed: VoiceEventFeed) => void;
        const ready = new Promise<VoiceEventFeed>((resolve) => {
          loaded = resolve;
        });
        const load = () => {
          void import("./voice-event-transport").then(
            ({ createVoiceEventTransport }) => {
              if (disposed) return;
              feed = createVoiceEventTransport({ client }).subscribe(input);
              loaded(feed);
            },
            () => {
              if (!disposed) {
                input.onMode("recovering");
                retry = setTimeout(load, 1_000);
              }
            },
          );
        };
        load();
        return Object.assign(
          () => {
            disposed = true;
            clearTimeout(retry);
            feed?.();
          },
          {
            async catchUp(signal: AbortSignal) {
              signal.throwIfAborted();
              const active = await Promise.race([
                ready,
                new Promise<never>((_, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => reject(signal.reason as unknown),
                    { once: true },
                  );
                }),
              ]);
              await active.catchUp(signal);
            },
          },
        );
      },
    },
    runStatuses: createRunStatusTransport({ client, events }),
    pageActivity: realtimeActivity,
    events,
  };
}

interface RealtimeLockManager {
  request(
    name: string,
    options: { mode: "exclusive"; steal: true },
    callback: () => Promise<void>,
  ): Promise<unknown>;
}

interface RealtimePageAttention {
  isForeground(): boolean;
  subscribe(listener: (foreground: boolean) => void): void;
}

const realtimeActivityLockName = "linger:teamhub-realtime";

export function createBrowserRealtimeActivity({
  attention = browserRealtimePageAttention,
  lockManager = globalThis.navigator?.locks,
}: {
  attention?: RealtimePageAttention;
  lockManager?: RealtimeLockManager;
} = {}): PageActivity {
  const listeners = new Set<(active: boolean) => void>();
  let active = false;
  let generation = 0;
  let releaseLock: (() => void) | undefined;
  let requesting = false;

  const setActive = (next: boolean) => {
    if (next === active) return;
    active = next;
    for (const listener of listeners) listener(active);
  };
  const release = () => {
    generation += 1;
    requesting = false;
    releaseLock?.();
    releaseLock = undefined;
    setActive(false);
  };
  const acquire = () => {
    if (!attention.isForeground() || active || requesting) return;
    if (!lockManager) {
      setActive(true);
      return;
    }
    const currentGeneration = ++generation;
    let releaseCurrentLock: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      releaseCurrentLock = resolve;
    });
    requesting = true;
    void lockManager
      .request(
        realtimeActivityLockName,
        { mode: "exclusive", steal: true },
        async () => {
          if (currentGeneration !== generation) return;
          requesting = false;
          releaseLock = releaseCurrentLock;
          setActive(true);
          await holding;
        },
      )
      .then(
        () => finishRealtimeLock(currentGeneration),
        () => {
          releaseCurrentLock();
          finishRealtimeLock(currentGeneration);
        },
      );
  };
  const finishRealtimeLock = (finishedGeneration: number) => {
    if (finishedGeneration !== generation) return;
    requesting = false;
    releaseLock = undefined;
    setActive(false);
  };

  attention.subscribe((foreground) => {
    if (foreground) acquire();
    else release();
  });
  acquire();

  return {
    isActive: () => active,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const browserRealtimePageAttention: RealtimePageAttention = {
  isForeground: browserPageIsForeground,
  subscribe(listener) {
    const document = globalThis.document;
    if (!document || !globalThis.addEventListener) return;
    const handleAttention = () => listener(browserPageIsForeground());
    document.addEventListener("visibilitychange", handleAttention);
    globalThis.addEventListener("focus", handleAttention);
    globalThis.addEventListener("pageshow", handleAttention);
    globalThis.addEventListener("pagehide", () => listener(false));
    globalThis.addEventListener("pointerdown", handleAttention);
    globalThis.addEventListener("keydown", handleAttention);
  },
};

function browserPageIsForeground() {
  const document = globalThis.document;
  return document?.visibilityState !== "hidden";
}

export function resolveDocumentRuntimeUrl(
  location = new URL(globalThis.location?.href ?? "http://localhost"),
): string {
  const url = new URL("/document-collaboration", location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
