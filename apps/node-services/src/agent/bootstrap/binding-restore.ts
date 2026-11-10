import type { AgentManager } from "../executor/agent-manager-api.js";
import {
  isRecoverableIdentityRestoreFailure,
  isRecoverableLocalContextRestoreFailure,
  isRuntimeProcessIdentityUnavailable,
} from "../executor/application.js";
import type { AgentLogger } from "../observability/agent-log.js";
import type { LocalRuntimeSettings } from "../runtime-settings.js";
import { setTimeout as delay } from "node:timers/promises";

export const LOCAL_RUNNER_RESTORE_INITIAL_RETRY_MS = 1_000;
export const LOCAL_RUNNER_RESTORE_MAX_RETRY_MS = 5 * 60_000;

export const isRecoverableBindingRestoreFailure = (error: unknown): boolean => {
  if (
    isRecoverableIdentityRestoreFailure(error) ||
    isRecoverableLocalContextRestoreFailure(error) ||
    isRuntimeProcessIdentityUnavailable(error)
  ) {
    return true;
  }
  return (
    error instanceof AggregateError &&
    error.errors.length > 0 &&
    error.errors.every(isRecoverableBindingRestoreFailure)
  );
};

export const restorePersistedBindings = async (
  agentManager: Pick<AgentManager<LocalRuntimeSettings>, "restore">,
  signal: AbortSignal,
  logger: AgentLogger,
  options: { readonly onFirstAttemptSettled?: () => void } = {},
): Promise<void> => {
  let retryAttempt = 0;
  let firstAttemptSettled = false;
  const settleFirstAttempt = () => {
    if (firstAttemptSettled) return;
    firstAttemptSettled = true;
    options.onFirstAttemptSettled?.();
  };
  const hasRecoverableFailure = (error: unknown): boolean =>
    isRecoverableBindingRestoreFailure(error) ||
    (error instanceof AggregateError &&
      error.errors.some(hasRecoverableFailure));
  while (!signal.aborted) {
    try {
      await agentManager.restore(
        retryAttempt > 0 ? { onlyUnmaterialized: true } : undefined,
      );
      settleFirstAttempt();
      return;
    } catch (error) {
      settleFirstAttempt();
      if (signal.aborted) return;
      if (!hasRecoverableFailure(error)) {
        logger.log("error", "manager.restore_failed_after_listen", { error });
        return;
      }
      const retryAfterMs = Math.min(
        LOCAL_RUNNER_RESTORE_MAX_RETRY_MS,
        LOCAL_RUNNER_RESTORE_INITIAL_RETRY_MS * 2 ** Math.min(retryAttempt, 9),
      );
      retryAttempt += 1;
      logger.log("warn", "manager.restore_deferred_after_listen", {
        error,
        retryAttempt,
        retryAfterMs,
      });
      try {
        await delay(retryAfterMs, undefined, { signal, ref: false });
      } catch (waitError) {
        if (!signal.aborted) throw waitError;
      }
    }
  }
};
