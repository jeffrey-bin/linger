import {
  createAgentLogger,
  type AgentLogger,
} from "../../observability/agent-log.js";
import {
  createTeamHubWakeStream,
  type TeamHubWakeStreamHandle,
} from "./teamhub-wake-stream.js";
import type { RunWakeKind } from "./types.js";

export type AgentWakeStreamHandle = TeamHubWakeStreamHandle;

const CONTEXT_DISPATCH_CONCURRENCY = 4;
const PENDING_HINT_CAPACITY = 256;
// Reconcile wakes the Task Worker, so a persistently failing reconcile must
// back off instead of turning into a steady claim loop against TeamHub.
const RECONCILE_RETRY_BASE_MS = 1_000;
const RECONCILE_RETRY_MAX_MS = 30_000;

/**
 * Follows TeamHub's service wake stream. run.queued and run.steered go to
 * onRunWake and task.claimable to onTaskClaimable without waiting;
 * context.changed hints run in order per Context.
 */
export function createTeamHubAgentWakeStream(options: {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly logger?: AgentLogger;
  /** Must only start work, never wait for it. */
  readonly onRunWake: (contextKey: string, kind: RunWakeKind) => void;
  readonly onContextChanged: (
    contextKey: string,
    stateRevision: string,
  ) => void | Promise<void>;
  /** Best-effort presence hint; must only enqueue work, never wait for it. */
  readonly onContextPrepare?: (contextKey: string) => void;
  /** A commit may have made a Task claimable; must never wait. */
  readonly onTaskClaimable?: () => void;
  readonly onReconcile: () => void | Promise<void>;
  readonly onConnectionChanged?: (connected: boolean) => void;
}): AgentWakeStreamHandle {
  const logger =
    options.logger ?? createAgentLogger({ component: "agent-wake-stream" });
  const dispatchHint = async (
    event: string,
    contextKey: string,
    dispatch: () => void | Promise<void>,
  ) => {
    try {
      await dispatch();
    } catch (error) {
      // Hints carry no recovery authority. A failed claim/refresh is local to
      // this Context; durable discovery and subsequent reconcile retry its work.
      logger.log("warn", "agent_wake_stream.hint_failed", {
        event,
        contextKey,
        error,
      });
    }
  };
  type Hint = { event: "context.changed" } & ContextChange;
  const createDispatcher = () => {
    const pending = new Map<string, Hint[]>();
    const busy = new Set<string>();
    const running = new Set<Promise<void>>();
    let pendingCount = 0;
    let overflowed = false;
    let closed = false;
    let reconcilePending = false;
    let reconcileTask: Promise<void> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelayMs = RECONCILE_RETRY_BASE_MS;
    const reconcile = () => {
      if (closed || reconcileTask || retryTimer || !reconcilePending) return;
      reconcilePending = false;
      reconcileTask = Promise.resolve()
        .then(options.onReconcile)
        .then(() => {
          retryDelayMs = RECONCILE_RETRY_BASE_MS;
        })
        .catch((error) => {
          logger.log("warn", "agent_wake_stream.reconcile_failed", { error });
          if (closed) return;
          reconcilePending = true;
          const delayMs = retryDelayMs;
          retryDelayMs = Math.min(retryDelayMs * 2, RECONCILE_RETRY_MAX_MS);
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            reconcile();
          }, delayMs);
        })
        .finally(() => {
          reconcileTask = undefined;
          reconcile();
        });
    };
    const requestReconcile = () => {
      if (closed) return;
      reconcilePending = true;
      reconcile();
    };
    const pump = () => {
      if (closed) return;
      for (const [key, hints] of pending) {
        if (busy.size >= CONTEXT_DISPATCH_CONCURRENCY) break;
        if (busy.has(key)) continue;
        const hint = hints.shift()!;
        pendingCount -= 1;
        if (hints.length === 0) pending.delete(key);
        busy.add(key);
        const task = dispatchHint(hint.event, key, () =>
          options.onContextChanged(key, hint.stateRevision),
        ).finally(() => {
          busy.delete(key);
          running.delete(task);
          if (pendingCount === 0 && busy.size === 0) overflowed = false;
          pump();
        });
        running.add(task);
      }
    };
    return {
      get closed() {
        return closed;
      },
      enqueue(hint: Hint) {
        if (closed) return;
        const key = hint.contextKey;
        const hints = pending.get(key) ?? [];
        const last = hints.at(-1);
        // A pending Context refresh keeps only the newest revision.
        if (last) {
          if (BigInt(hint.stateRevision) > BigInt(last.stateRevision))
            hints[hints.length - 1] = hint;
          return;
        }
        if (pendingCount >= PENDING_HINT_CAPACITY) {
          if (!overflowed) {
            overflowed = true;
            requestReconcile();
          }
          return;
        }
        hints.push(hint);
        pending.set(key, hints);
        pendingCount += 1;
        pump();
      },
      requestReconcile,
      stop() {
        closed = true;
        pending.clear();
        pendingCount = 0;
        reconcilePending = false;
        clearTimeout(retryTimer);
      },
      async close() {
        await Promise.all([...running, reconcileTask]);
      },
    };
  };
  let dispatcher = createDispatcher();
  let closeTask: Promise<void> | undefined;
  const stream = createTeamHubWakeStream({
    ...options,
    logger,
    component: "agent-wake-stream",
    eventPrefix: "agent_wake_stream",
    requestPath: "/v0/agent-runtime/wakes",
    onEvent(event, data) {
      if (event === "reconcile") {
        dispatcher.requestReconcile();
        return true;
      }
      if (event === "task.claimable") {
        // It names no Task, so it bypasses the ordered Context queue.
        try {
          options.onTaskClaimable?.();
        } catch (error) {
          logger.log("warn", "agent_wake_stream.hint_failed", { event, error });
        }
        return true;
      }
      if (event === "context.prepare") {
        let contextKey: string;
        try {
          contextKey = parseContextHint(data);
        } catch {
          return false;
        }
        // It carries no work, so it bypasses the ordered Context queue. The
        // only failure boundary: a closed manager or malformed key drops it.
        try {
          options.onContextPrepare?.(contextKey);
        } catch (error) {
          logger.log("warn", "agent_wake_stream.hint_failed", {
            event,
            contextKey,
            error,
          });
        }
        return true;
      }
      if (event === "run.queued" || event === "run.steered") {
        let contextKey: string;
        try {
          contextKey = parseContextHint(data);
        } catch {
          return false;
        }
        try {
          options.onRunWake(
            contextKey,
            event === "run.queued" ? "queued" : "steered",
          );
        } catch (error) {
          logger.log("warn", "agent_wake_stream.hint_failed", {
            event,
            contextKey,
            error,
          });
        }
        return true;
      }
      if (event === "context.changed") {
        let change: ContextChange;
        try {
          change = parseContextChanged(data);
        } catch {
          return false;
        }
        dispatcher.enqueue({ event, ...change });
        return true;
      }
      return false;
    },
  });
  return {
    start() {
      if (closeTask) return;
      if (dispatcher.closed) dispatcher = createDispatcher();
      stream.start();
    },
    close() {
      if (closeTask) return closeTask;
      const closing = dispatcher;
      closing.stop();
      closeTask = (async () => {
        await stream.close();
        await closing.close();
      })().finally(() => {
        closeTask = undefined;
      });
      return closeTask;
    },
  };
}

const validIdentity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\r\n]/u.test(value);
export interface ContextChange {
  readonly contextKey: string;
  /** The Context's committed state_revision. */
  readonly stateRevision: string;
}

export const parseContextChanged = (data: string): ContextChange => {
  const value: unknown = JSON.parse(data);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Context wake identity is invalid");
  const { context_key: contextKey, state_revision: stateRevision } =
    value as Record<string, unknown>;
  if (
    !validIdentity(contextKey) ||
    typeof stateRevision !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(stateRevision)
  )
    throw new TypeError("Context wake identity is invalid");
  return Object.freeze({ contextKey, stateRevision });
};

/** context.prepare, run.queued and run.steered carry only the Context key. */
export function parseContextHint(data: string): string {
  const value: unknown = JSON.parse(data);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Context hint identity is invalid");
  const { context_key: contextKey } = value as Record<string, unknown>;
  if (!validIdentity(contextKey))
    throw new TypeError("Context hint identity is invalid");
  return contextKey;
}
