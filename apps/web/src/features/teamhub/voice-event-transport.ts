import {
  type EventSourceFactory,
  type EventSourceLike,
  reconnectDelay,
} from "./event-stream";
import { teamHubData, teamHubUrl } from "./teamhub-api";
import { resolveTeamHubBaseUrl } from "./teamhub-base-url";
import type { TeamHubClient } from "./teamhub-client";
import { TeamHubError } from "./teamhub-error";
import type {
  TeamHubVoiceEventPage,
  TeamHubVoiceTranscriptEventPage,
} from "./teamhub-types";
import { VoiceRequestScope } from "./voice-request-scope";

const knownVoiceEventKinds = new Set<string>([
  "transcript",
  "capture",
  "session",
]);

export interface VoiceEventSubscription {
  voiceSessionId: string;
  onEvents(page: TeamHubVoiceEventPage): void;
  onTranscriptPage(page: TeamHubVoiceTranscriptEventPage): void;
  onMode(mode: "sse" | "polling" | "recovering"): void;
  onAccessLost(): void;
}
/** Stops the subscription when called. */
export interface VoiceEventFeed {
  (): void;
  /**
   * Reads every transcript event committed after the feed cursor, and the
   * current session and Captures, over HTTP and delivers them before
   * resolving; Voice Mode confirms its last words with it once
   * input has ended.
   */
  catchUp(signal: AbortSignal): Promise<void>;
}
export interface VoiceEventTransport {
  subscribe(input: VoiceEventSubscription): VoiceEventFeed;
}

// One subscription owns both transports. HTTP and SSE never apply concurrent
// responses. Background tabs keep this independent of the microphone publisher.
// It shares the TeamHub address resolution and reconnect backoff with the
// other streams, but keeps its own lifecycle for the HTTP fallback.
export function createVoiceEventTransport(options: {
  client: Pick<TeamHubClient, "api">;
  baseUrl?: string;
  eventSourceFactory?: EventSourceFactory;
  random?: () => number;
}): VoiceEventTransport {
  const baseUrl = resolveTeamHubBaseUrl(options.baseUrl);
  const random = options.random ?? Math.random;
  return {
    subscribe(input) {
      const requests = new VoiceRequestScope();
      const controller = new AbortController();
      let disposed = false;
      let source: EventSourceLike | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      // Set by the bootstrap page's snapshot: every later transcript event
      // arrives after it.
      let cursor: string | undefined;
      let bootstrapped!: () => void;
      const ready = new Promise<void>((resolve) => {
        bootstrapped = resolve;
      });
      let nextConnectAt = 0;
      let failures = 0;
      const clearSource = () => {
        source?.close();
        source = undefined;
        clearTimeout(watchdog);
      };
      const stop = () => {
        disposed = true;
        controller.abort();
        clearTimeout(timer);
        clearSource();
      };
      const lostAccess = () => {
        stop();
        input.onAccessLost();
      };
      // Session and Capture items are current snapshots that every HTTP
      // page repeats; deliver one only when it changed. An HTTP catch-up can
      // resolve after an SSE page read later, so a snapshot older than the
      // delivered one for the same resource is stale and dropped.
      const delivered = new Map<
        string,
        { encoded: string; updatedAt: number }
      >();
      const apply = (page: TeamHubVoiceEventPage) => {
        // Opaque cursor identity. Positions stay strings so long-lived
        // databases never round a bigint through JS.
        const position = cursorPosition(page.next_cursor, input.voiceSessionId);
        const current = cursor
          ? cursorPosition(cursor, input.voiceSessionId)
          : 0n;
        if (position < current) return;
        // A kind this client does not know still advances the cursor.
        const items = page.items.filter((event) => {
          if (!knownVoiceEventKinds.has(event.kind)) return false;
          const resource = event.capture ?? event.session;
          if (!resource) return true;
          const key = event.capture ? `capture:${resource.id}` : "session";
          const encoded = JSON.stringify(event);
          const updatedAt = Date.parse(resource.updated_at);
          const previous = delivered.get(key);
          if (
            previous &&
            (previous.encoded === encoded || updatedAt < previous.updatedAt)
          )
            return false;
          delivered.set(key, { encoded, updatedAt });
          return true;
        });
        if (items.length) input.onEvents({ ...page, items });
        cursor = page.next_cursor;
      };
      const readEvents = async (signal: AbortSignal) => {
        let page: TeamHubVoiceEventPage;
        do {
          page = await requests.run(
            (requestSignal) =>
              teamHubData(
                options.client.api.GET(
                  "/v0/voice-sessions/{voiceSessionId}/events",
                  {
                    params: {
                      path: { voiceSessionId: input.voiceSessionId },
                      query: { after: cursor },
                    },
                    signal: requestSignal,
                  },
                ),
              ),
            signal,
          );
          if (disposed) return;
          apply(page);
        } while (page.has_more);
      };
      const schedule = (delay: number) => {
        if (disposed) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          void (cursor === undefined ? bootstrap() : poll());
        }, delay);
      };
      const failed = (error: unknown) => {
        if (disposed) return;
        if (
          error instanceof TeamHubError &&
          [401, 403, 404].includes(error.status)
        ) {
          lostAccess();
          return;
        }
        input.onMode("recovering");
        schedule(
          reconnectDelay({
            attempt: failures++,
            baseDelayMs: 500,
            maximumDelayMs: 5_000,
            random,
          }),
        );
      };
      const fallback = (candidate: EventSourceLike) => {
        if (disposed || source !== candidate) return;
        clearSource();
        input.onMode("polling");
        nextConnectAt = Date.now() + 5_000;
        schedule(0);
      };
      const connect = () => {
        if (disposed) return;
        const url = teamHubUrl(
          baseUrl,
          "/v0/voice-sessions/{voiceSessionId}/events/stream",
          { path: { voiceSessionId: input.voiceSessionId } },
        );
        if (cursor) url.searchParams.set("after", cursor);
        let candidate: EventSourceLike;
        try {
          candidate = (
            options.eventSourceFactory ??
            ((url, init) => new EventSource(url, init))
          )(url.href, { withCredentials: true });
        } catch {
          nextConnectAt = Date.now() + 5_000;
          schedule(500);
          return;
        }
        source = candidate;
        const current = () => !disposed && source === candidate;
        const renew = () => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => fallback(candidate), 15_000);
        };
        const consume = (action: () => void) => {
          if (!current()) return;
          try {
            action();
            renew();
          } catch {
            fallback(candidate);
          }
        };
        candidate.addEventListener("voice.events", (event) =>
          consume(() => {
            apply(JSON.parse(event.data) as TeamHubVoiceEventPage);
          }),
        );
        candidate.addEventListener("voice.partial", (event) =>
          consume(() => {
            input.onTranscriptPage(
              JSON.parse(event.data) as TeamHubVoiceTranscriptEventPage,
            );
          }),
        );
        candidate.addEventListener("voice.ready", () =>
          consume(() => {
            failures = 0;
            input.onMode("sse");
          }),
        );
        candidate.addEventListener("error", () => fallback(candidate));
        candidate.addEventListener("session.expired", () => {
          if (current()) lostAccess();
        });
        candidate.addEventListener("access.revoked", () => {
          if (current()) lostAccess();
        });
        // An open TCP connection without flushed SSE is not healthy.
        watchdog = setTimeout(() => fallback(candidate), 3_000);
      };
      // The accepted transcript so far, once: its first page's snapshot
      // cursor is where the event feed starts.
      const bootstrap = async () => {
        if (disposed) return;
        try {
          let transcriptCursor: { id: string; updatedAt: string } | undefined;
          let snapshot: string | undefined;
          let transcriptPage: TeamHubVoiceTranscriptEventPage;
          do {
            transcriptPage = await requests.run(
              (signal) =>
                teamHubData(
                  options.client.api.GET(
                    "/v0/voice-sessions/{voiceSessionId}/transcript-events",
                    {
                      params: {
                        path: { voiceSessionId: input.voiceSessionId },
                        query: {
                          after_updated_at: transcriptCursor?.updatedAt,
                          after_id: transcriptCursor?.id,
                        },
                      },
                      signal,
                    },
                  ),
                ),
              controller.signal,
            );
            if (disposed) return;
            if (snapshot === undefined) {
              if (!transcriptPage.event_cursor)
                throw new Error("Voice transcript page has no event cursor");
              cursorPosition(transcriptPage.event_cursor, input.voiceSessionId);
              snapshot = transcriptPage.event_cursor;
            }
            input.onTranscriptPage(transcriptPage);
            const last = transcriptPage.items.at(-1);
            if (last)
              transcriptCursor = { id: last.id, updatedAt: last.updated_at };
          } while (transcriptPage.items.length === 100);
          cursor = snapshot;
          bootstrapped();
          failures = 0;
          connect();
        } catch (error) {
          failed(error);
        }
      };
      // While SSE is down, read only the event feed after the cursor; the
      // transcript is never paged again.
      const poll = async () => {
        if (disposed) return;
        try {
          await readEvents(controller.signal);
          if (disposed) return;
          failures = 0;
          input.onMode("polling");
          if (Date.now() >= nextConnectAt) connect();
          else schedule(500);
        } catch (error) {
          failed(error);
        }
      };
      input.onMode("polling");
      void bootstrap();
      return Object.assign(stop, {
        async catchUp(signal: AbortSignal) {
          signal.throwIfAborted();
          await Promise.race([
            ready,
            new Promise<never>((_, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(signal.reason as unknown),
                { once: true },
              );
            }),
          ]);
          await readEvents(AbortSignal.any([controller.signal, signal]));
        },
      });
    },
  };
}

function cursorPosition(cursor: string, sessionId: string): bigint {
  const prefix = `${sessionId}:`;
  const value = cursor.startsWith(prefix) ? cursor.slice(prefix.length) : "";
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid voice cursor");
  return BigInt(value);
}
