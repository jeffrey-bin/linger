import type { ContextRuntimeBackendActivation } from "../executor/activation.js";
import type { ExecutionContextRef } from "../executor/context-ref.js";
import type { BoundFeatureContext } from "./contracts.js";
import type { InboxSourceHost } from "./inbox-source/feature.js";

/**
 * The host's generic drain that converges feature background work on exit.
 * The ref keys lifecycle bookkeeping only; instance validity is carried by
 * the BoundFeatureContext the callbacks already received.
 */
export type TrackBackground = (
  operation: Promise<unknown>,
  ref: ExecutionContextRef,
  event: string,
) => void;

/**
 * One-shot named timers on a bound Context instance. Setting a name again
 * replaces its timer. Timers survive Runtime suspension and are cancelled
 * with the instance; they live only in this process. When one fires, the
 * host passes its name to the Context's features' `onTimer`, then asks them
 * for a maintenance decision with `{ kind: "timer", name }`. Feature ids
 * prefix the names they own.
 */
export interface FeatureTimers {
  set(context: BoundFeatureContext, name: string, dueAtMs: number): void;
  clear(context: BoundFeatureContext, name: string): void;
}

/**
 * Narrow host capabilities the Context-scoped sources need, bound once by
 * the composition root. Every callback receives the original
 * BoundFeatureContext — carrying that instance's invalidation signal — so
 * the host revalidates the bound instance at its final fence. Capabilities
 * are never resolved by feature id into a replacement Context's handle.
 */
export interface BuiltinFeatureHost {
  /**
   * Takes up TeamHub-queued Inbox input for the bound instance. Required when
   * `services.runWakes` is configured; unused otherwise.
   */
  readonly inbox?: InboxSourceHost;
  readonly trackBackground: TrackBackground;
  readonly timers: FeatureTimers;
}

/**
 * The Run-scope capability one Runtime activation exposes: the backend
 * activation obtained during THAT activation. Never an older Runtime's
 * activation and never a steer-time lookup.
 */
export type BuiltinRunBackend = Pick<
  ContextRuntimeBackendActivation,
  "prepareRunInput"
>;
