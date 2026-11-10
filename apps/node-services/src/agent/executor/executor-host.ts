import type { RuntimeConfigTimingContext } from "./teamhub-runtime-state-client.js";
import type {
  ContextTargetResidency,
  ExecutionContextRef,
} from "./context-ref.js";
import type { RunWakeKind } from "../agent-features/inbox-source/types.js";
import type { AgentId } from "./types.js";

/**
 * The registry state a Context executor consults. Everything kept per
 * Context key across executor instances (ownership, unbind and terminal
 * marks, lazy restores, restore retries, the lifecycle queue) stays in the
 * registry; an executor only reaches it through this port, so the registry
 * imports the executor and never the reverse. `TExecutor` is the executor
 * class, kept generic so this port imports nothing from it.
 */
export interface ExecutorHost<TExecutor, TRuntimeSettings> {
  /** The executor is the published instance of its Context key. */
  owns(executor: TExecutor): boolean;
  /** Published and still bound: not unbound by the Context store. */
  holds(executor: TExecutor): boolean;
  isClosing(): boolean;
  isDeletingAgent(agentId: AgentId): boolean;
  isTerminal(ref: ExecutionContextRef): boolean;
  hasLazyRestore(ref: ExecutionContextRef): boolean;
  clearLazyRestore(ref: ExecutionContextRef): void;
  /** Runs an operation in the Context's lifecycle queue. */
  runContext<T>(
    ref: ExecutionContextRef,
    operation: () => Promise<T>,
  ): Promise<T>;
  /** Runs an operation while the registry is open and tracks it for close. */
  duringOpen<T>(operation: () => Promise<T>): Promise<T>;
  trackBackground(
    operation: Promise<unknown>,
    ref: ExecutionContextRef,
    event: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void;
  withConfigTiming<T>(
    ref: ExecutionContextRef,
    phase: RuntimeConfigTimingContext["phase"],
    operation: () => T,
  ): T;
  persistTargetResidency(
    ref: ExecutionContextRef,
    targetResidency: ContextTargetResidency,
  ): Promise<void>;
  releaseIdleContext(ref: Readonly<ExecutionContextRef>): Promise<void>;
  assertAgentAvailable(agentId: AgentId): void;
  assertActivationReady(agentId: AgentId, revision: string): Promise<void>;
  /**
   * Checks the Agent registration before an activation. A pending
   * registration schedules a restore retry and rethrows.
   */
  checkActivationOrDefer(
    executor: TExecutor,
    pendingFailure?: unknown,
  ): Promise<void>;
  isRecoverableRestoreFailure(
    ref: ExecutionContextRef,
    runtime: TRuntimeSettings,
    error: unknown,
  ): boolean;
  shouldSuspendRestoreFailure(
    ref: ExecutionContextRef,
    runtime: TRuntimeSettings,
    error: unknown,
  ): boolean;
  /** Schedules a restore retry for an input whose activation failed recoverably. */
  retryActivationLater(executor: TExecutor, error: unknown): Promise<void>;
  /** Whether a suspended Context may be activated now for maintenance. */
  canRunMaintenance(runtime: Readonly<TRuntimeSettings>): boolean;
  /** The Agent's Runtime or placement changed after this executor was created. */
  isSuperseded(executor: TExecutor): Promise<boolean>;
  /**
   * Queued input that the executor cannot take up directly: activation and
   * any Runtime replacement go through the Context's lifecycle queue.
   */
  takeUpQueuedInputSlow(executor: TExecutor, kind: RunWakeKind): Promise<void>;
}
