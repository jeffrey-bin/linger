import { performance } from "node:perf_hooks";

import {
  createAgentLogger,
  type AgentLogger,
} from "../../observability/agent-log.js";

export interface TeamHubWakeStreamHandle {
  start(): void;
  close(): Promise<void>;
}

const MAX_EVENT_BYTES = 64 * 1024;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const HEADER_TIMEOUT_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

export const createTeamHubWakeStream = (options: {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly requestPath: string;
  readonly component: string;
  readonly eventPrefix: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly logger?: AgentLogger;
  readonly onEvent: (event: string, data: string) => boolean | Promise<boolean>;
  // Reports each connected/disconnected transition once; failed attempts that
  // never connected report nothing.
  readonly onConnectionChanged?: (connected: boolean) => void;
}): TeamHubWakeStreamHandle => {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!options.serviceToken.trim()) {
    throw new TypeError("TeamHub service token must not be empty");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const logger =
    options.logger ?? createAgentLogger({ component: options.component });
  let controller: AbortController | null = null;
  let completion: Promise<void> = Promise.resolve();

  const consume = async (
    signal: AbortSignal,
    onHealthy: () => void,
  ): Promise<void> => {
    const connection = new AbortController();
    const activeSignal = AbortSignal.any([signal, connection.signal]);
    const startedAt = performance.now();
    const headerTimer = setTimeout(
      () => connection.abort(new Error("TeamHub wake headers timed out")),
      HEADER_TIMEOUT_MS,
    );
    let connected = false;
    try {
      const response = await fetchImpl(`${baseUrl}${options.requestPath}`, {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${options.serviceToken}`,
        },
        signal: activeSignal,
      });
      clearTimeout(headerTimer);
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`TeamHub wake stream returned ${response.status}`);
      }
      logger.log("info", `${options.eventPrefix}.connected`, {
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      connected = true;
      options.onConnectionChanged?.(true);
      await consumeServerSentEvents(
        response.body,
        activeSignal,
        async (event, data) => {
          if (await options.onEvent(event, data)) onHealthy();
        },
        () => connection.abort(new Error("TeamHub wake heartbeat timed out")),
      );
    } finally {
      clearTimeout(headerTimer);
      connection.abort();
      if (connected) options.onConnectionChanged?.(false);
    }
  };

  return {
    start() {
      if (controller) return;
      controller = new AbortController();
      const active = controller;
      completion = (async () => {
        let retryMs = RETRY_BASE_MS;
        let consecutiveFailures = 0;
        while (!active.signal.aborted) {
          const startedAt = performance.now();
          try {
            await consume(active.signal, () => {
              retryMs = RETRY_BASE_MS;
              consecutiveFailures = 0;
            });
            retryMs = RETRY_BASE_MS;
          } catch (error) {
            if (active.signal.aborted) return;
            consecutiveFailures += 1;
            logger.log("warn", `${options.eventPrefix}.disconnected`, {
              error,
              retryMs,
              consecutiveFailures,
              elapsedMs: Math.round(performance.now() - startedAt),
            });
          }
          await waitForRetry(retryMs, active.signal);
          retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        }
      })().finally(() => {
        if (controller === active) controller = null;
      });
    },
    async close() {
      controller?.abort();
      await completion;
    },
  };
};

const consumeServerSentEvents = async (
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: string, data: string) => void | Promise<void>,
  onIdleTimeout: () => void,
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let eventBytes = 0;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const idleTimer = setTimeout(onIdleTimeout, HEARTBEAT_TIMEOUT_MS);
      const chunk = await reader.read().finally(() => clearTimeout(idleTimer));
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length > 0) await onEvent(event, data.join("\n"));
          event = "message";
          data = [];
          eventBytes = 0;
        } else {
          eventBytes += line.length + 1;
          if (eventBytes > MAX_EVENT_BYTES) {
            throw new Error("TeamHub wake event is too large");
          }
          if (line.startsWith("event:")) {
            event = line.slice("event:".length).trim();
          } else if (line.startsWith("data:")) {
            data.push(line.slice("data:".length).trimStart());
          }
        }
        newline = buffer.indexOf("\n");
      }
      if (eventBytes + buffer.length > MAX_EVENT_BYTES) {
        throw new Error("TeamHub wake event is too large");
      }
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

const normalizeBaseUrl = (value: string): string => {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("TeamHub base URL is invalid");
  }
  return parsed.toString().replace(/\/$/u, "");
};

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const finish = (): void => {
      signal.removeEventListener("abort", finish);
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
