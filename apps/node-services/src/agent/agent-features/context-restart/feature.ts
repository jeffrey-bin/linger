import { defineFeature, type FeatureDeclaration } from "../contracts.js";
import type { FeatureTimers } from "../host-ports.js";
import {
  CONTEXT_COMPACTED_NOTICE,
  renderCompactInstructions,
} from "./prompt.js";

export const CONTEXT_RESTART_FEATURE_ID = "context-restart";

const COMPACTION_PERIOD_MS = 12 * 60 * 60 * 1_000;
const IDLE_TIMER = `${CONTEXT_RESTART_FEATURE_ID}.idle`;
const COMPACTING_RUNTIMES = new Set(["codex", "claude"]);

export interface ContextRestartFeatureDeps {
  readonly timers: FeatureTimers;
  readonly periodMs?: number;
  readonly now?: () => number;
}

/**
 * Periodic native compaction of a Meta Context. The feature only
 * decides; the core compacts the idle session and then suspends it, so the
 * next input reactivates it with current instructions and memory. Both
 * triggers require a succeeded Run since the last compaction:
 * - before an idle suspend, once the period has passed since the last
 *   compaction (or since the first Run this process saw);
 * - from a timer, once the Context has been idle for the period.
 * State is per Context instance and in-process only.
 */
export const createContextRestartFeature = (
  deps: ContextRestartFeatureDeps,
): FeatureDeclaration => {
  if (typeof deps?.timers?.set !== "function")
    throw new Error("context-restart feature requires timers");
  const periodMs = deps.periodMs ?? COMPACTION_PERIOD_MS;
  const now = deps.now ?? Date.now;
  return defineFeature({
    id: CONTEXT_RESTART_FEATURE_ID,
    match: { contextKinds: ["meta"] },
    context: {
      ports: {
        onRunTerminal: {},
        decideMaintenance: {},
        onMaintenance: {},
        prepareInput: {},
      },
      create: (context) => {
        const runtimeType = (
          context.runtime as
            | { readonly placement?: { readonly runtimeType?: string } }
            | undefined
        )?.placement?.runtimeType;
        const supported = COMPACTING_RUNTIMES.has(runtimeType ?? "");
        let succeededRuns = 0;
        let periodStartedAt: number | undefined;
        let lastRunAt = 0;
        // null: the next new input gets the notice; a string: it went to that message.
        let notice: string | null | undefined;
        const compact = (reason: string) =>
          ({
            kind: "compact",
            reason,
            instructions: renderCompactInstructions(),
          }) as const;
        return {
          onRunTerminal: (bound, event) => {
            if (!supported || event.terminal.type !== "succeeded") return;
            succeededRuns += 1;
            lastRunAt = now();
            periodStartedAt ??= lastRunAt;
            deps.timers.set(bound, IDLE_TIMER, lastRunAt + periodMs);
          },
          decideMaintenance: (_view, trigger) => {
            if (!supported || succeededRuns === 0) return null;
            if (trigger.kind === "timer")
              return trigger.name === IDLE_TIMER &&
                now() - lastRunAt >= periodMs
                ? compact("idle")
                : null;
            return now() - periodStartedAt! >= periodMs
              ? compact("since_last_compaction")
              : null;
          },
          onMaintenance: (bound, event) => {
            if (
              event.phase !== "finished" ||
              event.outcome.status !== "completed"
            )
              return;
            succeededRuns = 0;
            periodStartedAt = now();
            notice = null;
            deps.timers.clear(bound, IDLE_TIMER);
          },
          prepareInput: (_view, message) => {
            if (message.trustedNotification || notice === undefined)
              return null;
            // Pinned to one message id so a replayed input renders the same.
            notice ??= message.messageId;
            if (notice !== message.messageId) {
              notice = undefined;
              return null;
            }
            return { text: CONTEXT_COMPACTED_NOTICE };
          },
        };
      },
    },
  });
};
