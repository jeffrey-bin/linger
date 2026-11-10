import {
  defineFeature,
  type BoundFeatureContext,
  type FeatureDeclaration,
} from "../contracts.js";
import type { RunWakeKind, RunWakeTargetRegistrar } from "./types.js";

export const INBOX_SOURCE_FEATURE_ID = "inbox-source";

/**
 * Narrow per-Context host capability bound once by the composition root.
 * Every callback receives the restricted bound context so the host acts only
 * on the bound instance, never on a replacement Context with the same ref.
 */
export interface InboxSourceHost {
  /**
   * TeamHub queued Inbox work for the bound Context: activate it when needed
   * and let its Shell claim the Run or read the steer.
   */
  takeUpQueuedInput(context: BoundFeatureContext, kind: RunWakeKind): void;
}

/**
 * Narrow assembly dependencies bound once by the composition root: the
 * service-shared wake dispatcher and the per-Context host capability.
 */
export interface InboxSourceFeatureDeps {
  readonly wakes: RunWakeTargetRegistrar;
  readonly host: InboxSourceHost;
}

/**
 * The Inbox is the Context's source of TeamHub input. TeamHub queues a Run or
 * a steer in the transaction that writes each Message; on Context binding
 * this feature registers the bound instance for that Context's wake hints and
 * hands each one to the host. The registration stops with the Context.
 */
export function createInboxSourceFeature(
  deps: InboxSourceFeatureDeps,
): FeatureDeclaration {
  if (typeof deps?.wakes?.registerTarget !== "function" || !deps.host)
    throw new Error("inbox-source feature requires wakes and host");
  return defineFeature({
    id: INBOX_SOURCE_FEATURE_ID,
    match: { contextKinds: ["meta"] },
    context: {
      ports: { onContextBound: {} },
      create: (context) => ({
        onContextBound: () => {
          const handle = deps.wakes.registerTarget({
            ref: Object.freeze({ ...context.ref }),
            wake: (kind) => deps.host.takeUpQueuedInput(context, kind),
          });
          return {
            stop: async () => handle.stop(),
          };
        },
      }),
    },
  });
}
