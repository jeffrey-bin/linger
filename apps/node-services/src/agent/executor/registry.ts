import { isDeepStrictEqual } from "node:util";
import { asError } from "@linger/service-kit";
import type { BuiltinAgentFeatures } from "../agent-features/builtin.js";
import type { ContextBootstrap } from "../agent-features/contracts.js";
import type { RunWakeKind } from "../agent-features/inbox-source/types.js";
import {
  createAgentLogger,
  type AgentLogger,
} from "../observability/agent-log.js";
import {
  AgentIdentityResolutionError,
  AgentManagerError,
  isActivationPending,
  type AgentDeletionOptions,
  type AgentIdentityResolutionErrorKind,
  type AgentManager as AgentManagerContract,
  type AgentRegistrationIdentityReservation,
  type ExecutionContextMessageDelivery,
} from "./agent-manager-api.js";
import {
  ContextExecutor,
  TerminalExecutionContextError,
  type ExecutorServices,
  type PreparationSource,
} from "./context-executor.js";
import {
  encodeExecutionContextRef,
  type ContextTargetResidency,
  type ExecutionContextRecord,
  type ExecutionContextRef,
  type ExecutionContextStore,
} from "./context-ref.js";
import type { ExecutorHost } from "./executor-host.js";
import {
  type AgentUpdate,
  type Ghost,
  type GhostInput,
  type GhostRegistration,
  type GhostStore,
  snapshotGhost,
} from "./ghost.js";
import {
  unavailableRuntimeHistory,
  type RuntimeHistoryInspection,
  type RuntimeHistoryOptions,
} from "./history.js";
import { AgentLifecycleCoordinator } from "./lifecycle-coordinator.js";
import {
  ConcurrencyLimiter,
  type ContextPreparationOutcome,
} from "./restart-restore.js";
import {
  isTeamHubNotFound,
  TeamHubRuntimeStateError,
  withRuntimeConfigTimingContext,
  type RuntimeConfigTimingContext,
} from "./teamhub-runtime-state-client.js";
import type {
  ActorId,
  AgentId,
  AgentIdentityResolver,
  AgentManagerStatus,
  AgentUpdateOptions,
  Message,
  RegisteredAgent,
  ResolvedAgentIdentity,
  RunCancellationStatus,
} from "./types.js";

interface PendingContext<TRuntimeSettings> {
  readonly agentId: AgentId;
  readonly promise: Promise<ContextExecutor<TRuntimeSettings>>;
}

interface DeferredContextRestore<TRuntimeSettings> {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly record: ExecutionContextRecord;
  readonly bootstrap: ContextBootstrap;
  readonly runtime: TRuntimeSettings;
  readonly retryAttempt: number;
}

export interface ContextRestoreFailure<TRuntimeSettings> {
  readonly error: unknown;
  readonly ref: Readonly<ExecutionContextRef>;
  readonly runtime: Readonly<TRuntimeSettings>;
}

export interface ContextRestoreRetryFailure<
  TRuntimeSettings,
> extends ContextRestoreFailure<TRuntimeSettings> {
  readonly retryAttempt: number;
}

export type ContextRestoreTarget<TRuntimeSettings> = Omit<
  ContextRestoreFailure<TRuntimeSettings>,
  "error"
>;

export interface ContextRestoreRecovery<TRuntimeSettings> {
  readonly isRecoverable: (
    failure: ContextRestoreFailure<TRuntimeSettings>,
  ) => boolean;
  readonly shouldSuspend?: (
    failure: ContextRestoreFailure<TRuntimeSettings>,
  ) => boolean;
  readonly maxRetryAttempts?:
    | number
    | ((
        failure: ContextRestoreFailure<TRuntimeSettings>,
      ) => number | undefined);
  readonly retryDelayMs?:
    | number
    | ((failure: ContextRestoreRetryFailure<TRuntimeSettings>) => number);
}

export interface ExecutorRegistryDependencies<TRuntimeSettings> {
  readonly identityResolver: AgentIdentityResolver;
  /** The Runtime services every Context executor activates with. */
  readonly executorServices: ExecutorServices<TRuntimeSettings>;
  /**
   * Per-Context composition from the explicitly assembled feature set. The
   * Manager passes its narrow host capabilities for each bound instance;
   * feature factories and shared services are bound at the composition root.
   */
  readonly features: Pick<BuiltinAgentFeatures, "composeContext">;
  readonly parseRuntime?: (value: unknown) => TRuntimeSettings;
  readonly ghostStore: GhostStore<TRuntimeSettings>;
  readonly contextStore: ExecutionContextStore;
  readonly identityNotFoundGracePeriodMs?: number;
  readonly restoreRecovery?: ContextRestoreRecovery<TRuntimeSettings>;
  readonly restoreConcurrency?: number;
  readonly restorePriority?: (
    target: ContextRestoreTarget<TRuntimeSettings>,
  ) => number;
  readonly shouldActivateOnRestore?: (
    target: ContextRestoreTarget<TRuntimeSettings>,
  ) => Promise<boolean>;
  readonly shouldPrepareContext?: (
    target: ContextRestoreTarget<TRuntimeSettings>,
  ) => boolean;
  /**
   * Best-effort activation without input while a Human is in a Room. allows
   * returns true only when the Context may be pre-activated right now; it must
   * never wake a Computer.
   */
  readonly presencePreparation?: {
    allows(target: ContextRestoreTarget<TRuntimeSettings>): boolean;
  };
  /** Reads persisted History for a Context without binding it; absent means materialize. */
  readonly inspectDetachedHistory?: (input: {
    ref: ExecutionContextRef;
    runtime: TRuntimeSettings;
    options: RuntimeHistoryOptions;
  }) => Promise<RuntimeHistoryInspection>;
  /**
   * Whether a suspended Context may be activated now for feature maintenance.
   * Maintenance never waits for or wakes an offline Computer; absent means
   * timer-driven maintenance runs only on already active Contexts.
   */
  readonly canRunMaintenance?: (runtime: Readonly<TRuntimeSettings>) => boolean;
}

const IDENTITY_RETRY_INITIAL_DELAY_MS = 250;
const IDENTITY_RETRY_MAX_DELAY_MS = 30_000;
const IDENTITY_NOT_FOUND_GRACE_PERIOD_MS = 2 * 60_000;
const RESTORE_CONCURRENCY = 1;
const RESTORE_RETRY_DELAY_MS = 1_000;
const CONTEXT_PREPARATION_CONCURRENCY = 1;
const PRESENCE_PREPARATION_CONCURRENCY = 2;
const PRESENCE_PREPARATION_QUEUE_TIMEOUT_MS = 30_000;

/**
 * The process's Context executors: Agent identities and Ghosts, one
 * executor per Context instance, restore, preparation, deletion and close.
 * Per-key state that outlives an executor instance lives here.
 */
export class ExecutorRegistry<
  TRuntimeSettings,
> implements AgentManagerContract<TRuntimeSettings> {
  readonly #identityResolver: AgentIdentityResolver;
  readonly #executorServices: ExecutorServices<TRuntimeSettings>;
  readonly #parseRuntime: (value: unknown) => TRuntimeSettings;
  readonly #ghostStore: GhostStore<TRuntimeSettings>;
  readonly #contextStore: ExecutionContextStore;
  readonly #features: Pick<BuiltinAgentFeatures, "composeContext">;
  readonly #identityNotFoundGracePeriodMs: number;
  readonly #contexts = new Map<string, ContextExecutor<TRuntimeSettings>>();
  readonly #inspectDetachedHistory?: ExecutorRegistryDependencies<TRuntimeSettings>["inspectDetachedHistory"];
  readonly #canRunMaintenance?: ExecutorRegistryDependencies<TRuntimeSettings>["canRunMaintenance"];
  readonly #contextPromises = new Map<
    string,
    PendingContext<TRuntimeSettings>
  >();
  readonly #contextRevisionPromises = new Map<
    string,
    Promise<ContextExecutor<TRuntimeSettings>>
  >();
  readonly #terminalContextKeys = new Set<string>();
  readonly #terminalContextStops = new Map<string, Promise<void>>();
  readonly #bootstrapHints = new Map<string, ContextBootstrap>();
  readonly #resolvedIdentities = new Map<AgentId, ResolvedAgentIdentity>();
  readonly #identityPromises = new Map<
    AgentId,
    Promise<ResolvedAgentIdentity>
  >();
  readonly #identityRetryAttempts = new Map<AgentId, number>();
  readonly #identityResolutionStartedAt = new Map<AgentId, number>();
  readonly #identityTerminalFailures = new Map<AgentId, unknown>();
  readonly #identityRetryTimers = new Map<
    AgentId,
    ReturnType<typeof setTimeout>
  >();
  readonly #deletingAgents = new Set<AgentId>();
  readonly #deletionPromises = new Map<
    AgentId,
    Promise<"deleted" | "not_found">
  >();
  readonly #agentLifecycle = new AgentLifecycleCoordinator();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #deferredContextRestores = new Map<
    string,
    DeferredContextRestore<TRuntimeSettings>
  >();
  #restoreInProgress = 0;
  readonly #restoreDemandedContextKeys = new Set<string>();
  readonly #preparationContextKeys = new Set<string>();
  readonly #preparationRequests = new Map<string, { retry: boolean }>();
  readonly #logger = createAgentLogger({ component: "agent-manager" });
  readonly #restoreRecovery?: ContextRestoreRecovery<TRuntimeSettings>;
  readonly #restorePriority?: ExecutorRegistryDependencies<TRuntimeSettings>["restorePriority"];
  readonly #shouldActivateOnRestore:
    | ExecutorRegistryDependencies<TRuntimeSettings>["shouldActivateOnRestore"]
    | undefined;
  readonly #restoreOperations: ConcurrencyLimiter;
  readonly #lazyRestoreReasons = new Map<
    string,
    "restart" | "unused_preparation"
  >();
  readonly #shouldPrepareContext:
    | ExecutorRegistryDependencies<TRuntimeSettings>["shouldPrepareContext"]
    | undefined;
  readonly #preparationOperations = new ConcurrencyLimiter(
    CONTEXT_PREPARATION_CONCURRENCY,
    "contextPreparationConcurrency",
  );
  readonly #presencePreparation?: ExecutorRegistryDependencies<TRuntimeSettings>["presencePreparation"];
  readonly #presencePreparationOperations = new ConcurrencyLimiter(
    PRESENCE_PREPARATION_CONCURRENCY,
    "presencePreparationConcurrency",
  );
  readonly #unboundContextKeys = new Set<string>();
  readonly #unboundStopAttempts = new Map<string, number>();
  readonly #restoreRetryDelayMs:
    | number
    | ((failure: ContextRestoreRetryFailure<TRuntimeSettings>) => number);
  readonly #host: ExecutorHost<
    ContextExecutor<TRuntimeSettings>,
    TRuntimeSettings
  > = {
    owns: (context) => this.#contexts.get(context.key) === context,
    holds: (context) =>
      this.#contexts.get(context.key) === context &&
      !this.#unboundContextKeys.has(context.key),
    isClosing: () => this.#closePromise !== null,
    isDeletingAgent: (agentId) => this.#deletingAgents.has(agentId),
    isTerminal: (ref) =>
      this.#terminalContextKeys.has(encodeExecutionContextRef(ref)),
    hasLazyRestore: (ref) =>
      this.#lazyRestoreReasons.has(encodeExecutionContextRef(ref)),
    clearLazyRestore: (ref) => {
      this.#lazyRestoreReasons.delete(encodeExecutionContextRef(ref));
    },
    runContext: (ref, operation) =>
      this.#agentLifecycle.runContext(ref, operation),
    duringOpen: (operation) => this.#duringOpen(operation),
    trackBackground: (operation, ref, event, fields) =>
      this.#trackBackground(operation, ref, event, fields),
    withConfigTiming: (ref, phase, operation) =>
      this.#withConfigTiming(ref, phase, operation),
    persistTargetResidency: (ref, targetResidency) =>
      this.#persistTargetResidency(ref, targetResidency),
    releaseIdleContext: (ref) => this.#releaseIdleContext(ref),
    assertAgentAvailable: (agentId) => this.#assertAgentAvailable(agentId),
    assertActivationReady: (agentId, revision) =>
      this.#assertActivationReady(agentId, revision),
    checkActivationOrDefer: (context, pendingFailure) =>
      this.#checkActivationOrDefer(context, pendingFailure),
    isRecoverableRestoreFailure: (ref, runtime, error) =>
      this.#isRecoverableRestoreFailure(ref, runtime, error),
    shouldSuspendRestoreFailure: (ref, runtime, error) =>
      this.#shouldSuspendRestoreFailure(ref, runtime, error),
    retryActivationLater: async (context, error) => {
      const record = await this.#contextStore.get(context.ref);
      if (record)
        await this.#scheduleRestoreRetry(
          record,
          "restored",
          context.runtime,
          error,
          1,
        );
    },
    canRunMaintenance: (runtime) => this.#canRunMaintenance?.(runtime) === true,
    isSuperseded: (context) => this.#isSuperseded(context),
    takeUpQueuedInputSlow: (context, kind) =>
      this.#takeUpQueuedInputSlow(context, kind),
  };
  #unsubscribeContextStore: (() => void) | null = null;
  #unsubscribeContextUnbind: (() => void) | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(options: ExecutorRegistryDependencies<TRuntimeSettings>) {
    this.#identityResolver = options.identityResolver;
    this.#executorServices = options.executorServices;
    this.#parseRuntime =
      options.parseRuntime ?? ((value) => value as TRuntimeSettings);
    this.#ghostStore = options.ghostStore;
    this.#contextStore = options.contextStore;
    this.#features = options.features;
    this.#inspectDetachedHistory = options.inspectDetachedHistory;
    this.#canRunMaintenance = options.canRunMaintenance;
    this.#identityNotFoundGracePeriodMs =
      options.identityNotFoundGracePeriodMs ??
      IDENTITY_NOT_FOUND_GRACE_PERIOD_MS;
    if (
      !Number.isSafeInteger(this.#identityNotFoundGracePeriodMs) ||
      this.#identityNotFoundGracePeriodMs < 0
    ) {
      throw new TypeError(
        "identityNotFoundGracePeriodMs must be a non-negative safe integer",
      );
    }
    this.#restoreRecovery = options.restoreRecovery;
    this.#restorePriority = options.restorePriority;
    this.#shouldActivateOnRestore = options.shouldActivateOnRestore;
    this.#shouldPrepareContext = options.shouldPrepareContext;
    this.#presencePreparation = options.presencePreparation;
    this.#restoreOperations = new ConcurrencyLimiter(
      options.restoreConcurrency ?? RESTORE_CONCURRENCY,
      "restoreConcurrency",
    );
    this.#restoreRetryDelayMs =
      options.restoreRecovery?.retryDelayMs ?? RESTORE_RETRY_DELAY_MS;
    if (
      typeof this.#restoreRetryDelayMs === "number" &&
      (!Number.isSafeInteger(this.#restoreRetryDelayMs) ||
        this.#restoreRetryDelayMs < 1)
    ) {
      throw new TypeError(
        "restore retry delay must be a positive safe integer",
      );
    }
  }

  async registerAgent(
    registration: GhostRegistration<TRuntimeSettings>,
    identity: AgentRegistrationIdentityReservation,
  ): Promise<RegisteredAgent> {
    return this.#duringOpen(async () => {
      const startedAt = Date.now();
      const { agentId } = identity;
      this.#assertAgentAvailable(agentId);
      const ghost = this.#snapshotGhost({ agentId, ...registration });
      const inserted = await this.#ghostStore.insert(ghost);
      if (inserted === "inserted") {
        this.#assertAgentAvailable(agentId);
        this.#logger
          .child({
            agentId,
            agentName: ghost.agent.name,
            tenantId: ghost.tenantId,
          })
          .log("info", "agent.registered", {
            revision: ghost.revision,
            durationMs: elapsedMs(startedAt),
          });
        return { agentId, revision: ghost.revision };
      }

      const existing = await this.#ghostStore.get(agentId);
      if (existing && sameRegistration(existing, ghost)) {
        this.#assertAgentAvailable(agentId);
        return { agentId, revision: ghost.revision };
      }
      throw new AgentManagerError(
        "agent_registration_conflict",
        `Agent identity "${agentId}" has different registration input`,
      );
    });
  }

  async getGhost(
    agentId: AgentId,
  ): Promise<Readonly<Ghost<TRuntimeSettings>> | null> {
    return this.#duringOpen(async () => {
      const ghost = await this.#ghostStore.get(agentId);
      return ghost ? this.#snapshotGhost(ghost) : null;
    });
  }

  async refreshAgent(
    agentId: AgentId,
  ): Promise<Readonly<Ghost<TRuntimeSettings>> | null> {
    return this.#duringOpen(async () => {
      try {
        await this.#ghostStore.refresh?.(agentId);
      } catch (error) {
        // TeamHub serves the configuration of active registrations only.
        if (isTeamHubNotFound(error)) return null;
        throw error;
      }
      const ghost = await this.#ghostStore.get(agentId);
      return ghost ? this.#snapshotGhost(ghost) : null;
    });
  }

  async updateAgent(
    agentId: AgentId,
    update: AgentUpdate<TRuntimeSettings>,
    options: AgentUpdateOptions = {},
  ): Promise<RegisteredAgent> {
    return this.#duringOpen(() => {
      // A preparation carries no input, yet holds the shared lifecycle lock
      // until its activation deadline; the replacement discards its Runtime.
      // Real input clears preparation synchronously, so it is never aborted.
      for (const context of this.#contexts.values()) {
        if (context.ref.agentId === agentId && context.preparation !== null)
          context.abortActivation(
            new Error("Agent configuration is being replaced"),
          );
      }
      return this.#agentLifecycle.run(agentId, async () => {
        const current = await this.#ghostStore.get(agentId);
        if (!current) {
          throw new AgentManagerError(
            "agent_not_registered",
            `Agent "${agentId}" is not registered`,
          );
        }
        const next = this.#snapshotGhost({
          ...current,
          revision: update.revision,
          agent: update.agent,
          runtime: update.runtime,
          resources: update.resources,
        });
        const replacementIsCurrent =
          current.revision === update.revision &&
          isDeepStrictEqual(current, next);
        // A restart can load the reserved revision before its Runner converges.
        // Replays must still validate, dispose and rebind before returning.
        if (
          replacementIsCurrent &&
          !options.beforeReplacement &&
          !options.afterLoadedContextsDisposed
        ) {
          await this.#restoreAgentContexts(agentId);
          return { agentId, revision: current.revision };
        }
        if (
          !replacementIsCurrent &&
          current.revision !== update.expectedRevision &&
          !(await this.#ghostStore.isReplacementCurrent?.(agentId, next))
        ) {
          throw new AgentManagerError(
            "agent_revision_conflict",
            `Agent "${agentId}" configuration revision changed`,
          );
        }
        if (!this.#ghostStore.replace) {
          throw new AgentManagerError(
            "invalid_state",
            "Ghost store does not support configuration updates",
          );
        }

        const contexts = [...this.#contexts.values()].filter(
          (context) => context.ref.agentId === agentId,
        );
        if (this.#agentHasInFlightContextWork(agentId, contexts)) {
          throw new AgentManagerError(
            "agent_busy",
            `Agent "${agentId}" is busy`,
          );
        }
        await options.beforeReplacement?.();
        if (this.#agentHasInFlightContextWork(agentId, contexts)) {
          throw new AgentManagerError(
            "agent_busy",
            `Agent "${agentId}" is busy`,
          );
        }

        for (const context of contexts) {
          await this.#disposeLoadedContext(context);
        }
        await options.afterLoadedContextsDisposed?.();
        const replacement = replacementIsCurrent
          ? "updated"
          : await this.#ghostStore.replace(
              agentId,
              update.expectedRevision,
              next,
            );
        if (replacement === "not_found") {
          throw new AgentManagerError(
            "agent_not_registered",
            `Agent "${agentId}" is not registered`,
          );
        }
        if (replacement === "revision_conflict") {
          throw new AgentManagerError(
            "agent_revision_conflict",
            `Agent "${agentId}" configuration revision changed`,
          );
        }
        await this.#restoreAgentContexts(agentId);
        return { agentId, revision: next.revision };
      });
    });
  }

  async restore(options?: {
    readonly onlyUnmaterialized?: boolean;
  }): Promise<void> {
    this.#assertOpen();
    this.#restoreInProgress += 1;
    const operation = this.#duringOpen(async () => {
      const startedAt = Date.now();
      this.#startContextStoreSync();
      const configurationFailures = new Map<AgentId, unknown>();
      const ghosts = await this.#ghostStore.list(
        undefined,
        (agentId, error) => {
          configurationFailures.set(agentId, error);
        },
      );
      const storedRecords = await this.#contextStore.list();
      for (const record of storedRecords) {
        if (record.terminalReason !== undefined) {
          this.#terminalContextKeys.add(encodeExecutionContextRef(record.ref));
        }
      }
      const records = new Map<
        string,
        {
          readonly bootstrap: ContextBootstrap;
          readonly record: ExecutionContextRecord;
        }
      >(
        storedRecords
          .filter((record) => record.terminalReason === undefined)
          .map((record) => [
            encodeExecutionContextRef(record.ref),
            { bootstrap: "restored", record },
          ]),
      );

      const ghostsByAgentId = new Map(
        ghosts.map((ghost) => [ghost.agentId, ghost] as const),
      );
      let activationCandidateCount = 0;
      let deferredActiveCount = 0;
      const restoreRecords = [...records.values()];
      if (this.#restorePriority || this.#restoreDemandedContextKeys.size > 0) {
        restoreRecords.sort((left, right) => {
          const leftGhost = ghostsByAgentId.get(left.record.ref.agentId);
          const rightGhost = ghostsByAgentId.get(right.record.ref.agentId);
          if (!leftGhost || !rightGhost) return 0;
          return (
            this.#restorePriorityFor(left.record.ref, leftGhost.runtime) -
            this.#restorePriorityFor(right.record.ref, rightGhost.runtime)
          );
        });
      }
      const outcomes = await Promise.allSettled(
        restoreRecords.map(({ bootstrap, record }) =>
          this.#restoreOperations.run(
            async () => {
              const contextKey = encodeExecutionContextRef(record.ref);
              if (options?.onlyUnmaterialized && this.#contexts.has(contextKey))
                return;
              this.#restoreDemandedContextKeys.delete(contextKey);
              // A failed configuration read is not deletion or permission to
              // create a fallback Runtime. Other Agents still restore normally.
              if (configurationFailures.has(record.ref.agentId))
                throw configurationFailures.get(record.ref.agentId);
              const ghost = await this.#ghostStore.get(record.ref.agentId);
              if (!ghost) {
                throw new AgentManagerError(
                  "agent_not_registered",
                  `Execution Context ${encodeExecutionContextRef(record.ref)} has no registered Agent`,
                );
              }
              try {
                const shouldActivate = await this.#restoreRequiresActivation(
                  record,
                  ghost.runtime,
                );
                if (record.targetResidency === "active") {
                  if (shouldActivate) {
                    activationCandidateCount += 1;
                  } else {
                    deferredActiveCount += 1;
                    const key = encodeExecutionContextRef(record.ref);
                    if (!this.#lazyRestoreReasons.has(key)) {
                      this.#lazyRestoreReasons.set(key, "restart");
                    }
                  }
                }
                if (!ghost.actorId) {
                  this.#scheduleMaterialization(record, bootstrap);
                  return;
                }
                const context = await this.#materializeContext(
                  record,
                  bootstrap,
                );
                if (shouldActivate) {
                  await context.requestActive("restore");
                }
              } catch (error) {
                if (error instanceof TerminalExecutionContextError) return;
                if (
                  this.#shouldSuspendRestoreFailure(
                    record.ref,
                    ghost.runtime,
                    error,
                  )
                ) {
                  await this.#suspendRestoreTarget(record, error, "rejected");
                  return;
                }
                if (
                  !this.#isRecoverableRestoreFailure(
                    record.ref,
                    ghost.runtime,
                    error,
                  )
                ) {
                  throw error;
                }
                await this.#scheduleRestoreRetry(
                  record,
                  bootstrap,
                  ghost.runtime,
                  error,
                  1,
                );
              }
            },
            () => {
              const ghost = ghostsByAgentId.get(record.ref.agentId);
              return ghost
                ? this.#restorePriorityFor(record.ref, ghost.runtime)
                : 0;
            },
          ),
        ),
      );
      const failures = outcomes.flatMap((outcome, index) => {
        if (outcome.status !== "rejected") return [];
        // Include failures before executor creation (configuration/identity) and
        // keep their Context association before AggregateError loses it.
        this.#contextLogger(restoreRecords[index]!.record.ref).log(
          "error",
          "manager.context_restore_failed",
          { error: outcome.reason, retryScheduled: false },
        );
        return [outcome.reason];
      });
      for (const [agentId, error] of configurationFailures) {
        if (
          !restoreRecords.some(({ record }) => record.ref.agentId === agentId)
        ) {
          this.#logger.log(
            "error",
            "manager.agent_configuration_restore_failed",
            {
              agentId,
              error,
            },
          );
          failures.push(error);
        }
      }
      this.#logger.log(
        failures.length === 0 ? "info" : "warn",
        "manager.restore_completed",
        {
          contextCount: records.size,
          activationCandidateCount,
          deferredActiveCount,
          failureCount: failures.length,
          restoreConcurrency: this.#restoreOperations.limit,
          durationMs: elapsedMs(startedAt),
        },
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Executor registry failed to restore ${failures.length} Execution Contexts`,
        );
      }
    });
    return operation.finally(() => {
      this.#restoreInProgress -= 1;
      if (this.#restoreInProgress === 0) {
        this.#restoreDemandedContextKeys.clear();
      }
    });
  }

  wakeDeferredContextRestores(
    matches: (target: ContextRestoreTarget<TRuntimeSettings>) => boolean,
  ): number {
    if (this.#closePromise) return 0;
    let wakeCount = 0;
    for (const [key, deferred] of this.#deferredContextRestores) {
      if (!matches({ ref: deferred.record.ref, runtime: deferred.runtime })) {
        continue;
      }
      clearTimeout(deferred.timer);
      this.#deferredContextRestores.delete(key);
      this.#launchRestoreRetry(deferred);
      wakeCount += 1;
    }
    return wakeCount;
  }

  /**
   * Activates an idle Context without input because a Human is in its Room.
   * Best effort: a request that waited too long behind other preparations is
   * dropped, and a repeated hint for a ready Runtime only renews it.
   */
  prepareContextForPresence(
    ref: Readonly<ExecutionContextRef>,
    claim: () => Promise<ExecutionContextRecord | null>,
  ): void {
    this.#assertOpen();
    const presencePreparation = this.#presencePreparation;
    if (!presencePreparation) return;
    const target = Object.freeze({ ...ref }) as Readonly<ExecutionContextRef>;
    const queuedAt = Date.now();
    // Bind inside the Context queue: the bind's store-sync callback queues
    // behind this operation, so it cannot release the Context before activation.
    const operation = this.#presencePreparationOperations.run(() =>
      this.#agentLifecycle.runContext(target, async () => {
        if (Date.now() - queuedAt > PRESENCE_PREPARATION_QUEUE_TIMEOUT_MS)
          return;
        // Check eligibility before binding so an offline Computer does not
        // churn bindings, and so a skip never holds a bound Context.
        if (
          this.#closePromise ||
          this.#deletingAgents.has(target.agentId) ||
          this.#terminalContextKeys.has(encodeExecutionContextRef(target))
        )
          return;
        const ghost = await this.#ghostStore.get(target.agentId);
        if (
          !ghost ||
          !presencePreparation.allows({ ref: target, runtime: ghost.runtime })
        )
          return;
        const record = await claim();
        if (record)
          await this.#prepareContext(record.ref, queuedAt, "room_presence");
      }),
    );
    this.#trackBackground(
      operation,
      target,
      "binding.presence_preparation_failed",
    );
  }

  /**
   * Activates a Context that was used before this Agent Service restarted.
   * It only activates: no input is accepted and no Run starts. A Context that
   * is already hot, or whose activation a real message started first, is
   * skipped. The restore runs inside the Context queue and awaits completion.
   */
  restoreContextAfterRestart(
    ref: Readonly<ExecutionContextRef>,
    claim: () => Promise<ExecutionContextRecord | null>,
    admitsRuntime: (runtime: Readonly<TRuntimeSettings>) => boolean,
  ): Promise<ContextPreparationOutcome> {
    this.#assertOpen();
    const target = Object.freeze({ ...ref }) as Readonly<ExecutionContextRef>;
    const queuedAt = Date.now();
    return this.#agentLifecycle.runContext(target, async () => {
      const record = await claim();
      if (!record) return { status: "skipped" };
      return this.#prepareContext(
        record.ref,
        queuedAt,
        "restart_restore",
        admitsRuntime,
      );
    });
  }

  scheduleContextPreparation(ref: Readonly<ExecutionContextRef>): void {
    this.#assertOpen();
    if (!this.#shouldPrepareContext) return;
    const target = Object.freeze({ ...ref }) as Readonly<ExecutionContextRef>;
    const key = encodeExecutionContextRef(target);
    if (this.#preparationContextKeys.has(key)) {
      const pending = this.#preparationRequests.get(key);
      if (pending) pending.retry = true;
      return;
    }
    this.#preparationContextKeys.add(key);
    const request = { retry: false };
    this.#preparationRequests.set(key, request);
    const queuedAt = Date.now();
    const operation = this.#preparationOperations
      .run(() =>
        this.#agentLifecycle.runContext(target, () =>
          this.#prepareContext(target, queuedAt),
        ),
      )
      .catch((error: unknown) => {
        if (isActivationPending(error)) {
          this.#preparationContextKeys.delete(key);
          return;
        }
        throw error;
      })
      .finally(() => {
        this.#preparationRequests.delete(key);
        // A publication wake can arrive while the old projection is being
        // checked. Replay that wake after a deferred attempt releases its key.
        if (
          request.retry &&
          !this.#closePromise &&
          !this.#preparationContextKeys.has(key)
        ) {
          this.scheduleContextPreparation(target);
        }
      });
    this.#trackBackground(operation, target, "binding.preparation_failed");
  }

  async ensureBinding(ref: ExecutionContextRef): Promise<void> {
    return this.#duringOpen(async () => {
      this.#prioritizeContextRestore(ref);
      await this.#ensureMaterializedContext(ref);
    }, ref);
  }

  async ensureAgentIdentity(agentId: AgentId): Promise<void> {
    return this.#duringOpen(async () => {
      this.#assertAgentAvailable(agentId);
      if (!(await this.#ghostStore.get(agentId))) {
        throw new AgentManagerError(
          "agent_not_registered",
          `Agent "${agentId}" is not registered`,
        );
      }
      await this.#requestIdentityResolution(agentId);
    });
  }

  async submitTrustedTurn(
    delivery: ExecutionContextMessageDelivery,
  ): Promise<{ readonly agentRunRef: string }> {
    return this.#duringOpen(async () => {
      const context = await this.#ensureMaterializedContext(
        delivery.target,
        false,
      );
      const runId = await context.acceptTrustedTurn(delivery.messages);
      try {
        await context.requestActive("trusted_turn");
      } catch (error) {
        this.#contextLogger(delivery.target).log(
          "warn",
          "activation.after_trusted_turn_failed",
          { error },
        );
        throw error;
      }
      return { agentRunRef: runId };
    }, delivery.target);
  }

  async steerActiveTurn(delivery: {
    readonly target: ExecutionContextRef;
    readonly message: Message;
  }): Promise<{ readonly agentRunRef: string } | null> {
    return this.#duringOpen(async () => {
      const context = this.#contexts.get(
        encodeExecutionContextRef(delivery.target),
      );
      if (!context) return null;
      const runId = await context.steerActiveTurn(delivery.message);
      return runId ? { agentRunRef: runId } : null;
    }, delivery.target);
  }

  async cancelTrustedTurn(delivery: ExecutionContextMessageDelivery): Promise<{
    readonly agentRunRef: string;
    readonly cancelStatus: RunCancellationStatus;
  }> {
    return this.#duringOpen(async () => {
      const context = await this.#ensureMaterializedContext(
        delivery.target,
        false,
      );
      const canceled = await context.cancelTrustedTurn(delivery.messages);
      return {
        agentRunRef: canceled.runId,
        cancelStatus: canceled.status,
      };
    });
  }

  async observeTurn(ref: ExecutionContextRef, agentRunRef: string) {
    return this.#duringOpen(async () => {
      const context = await this.#ensureMaterializedContext(ref, false);
      return context.observeTurn(agentRunRef);
    });
  }

  async getContextStatus(
    ref: ExecutionContextRef,
  ): Promise<AgentManagerStatus | null> {
    return this.#duringOpen(
      async () =>
        this.#contexts.get(encodeExecutionContextRef(ref))?.status ?? null,
    );
  }

  async inspectDebugContextHistory(
    ref: ExecutionContextRef,
    options: RuntimeHistoryOptions,
  ) {
    return this.#duringOpen(async () => {
      const notPersisted = unavailableRuntimeHistory(
        "unknown",
        "Execution Context is not persisted",
      );
      const key = encodeExecutionContextRef(ref);
      if (!this.#contexts.has(key) && this.#inspectDetachedHistory) {
        // Reading History must not bind the Context: a binding would hold a
        // notification target and Runtime view nothing releases.
        const persisted = await this.#loadPersistedDebugContext(ref);
        if (!persisted) return notPersisted;
        return this.#inspectDetachedHistory({
          ref,
          runtime: persisted.ghost.runtime,
          options,
        });
      }
      const context = await this.#materializePersistedDebugContext(ref);
      if (!context) return notPersisted;
      return context.inspectRuntimeHistory(options);
    });
  }

  async startContext(ref: ExecutionContextRef): Promise<void> {
    return this.#duringOpen(
      () =>
        this.#agentLifecycle.runContext(ref, async () => {
          const context = await this.#ensureMaterializedContext(ref, false);
          await context.requestActive("start");
        }),
      ref,
    );
  }

  async resumeContext(ref: ExecutionContextRef): Promise<void> {
    return this.#duringOpen(
      () =>
        this.#agentLifecycle.runContext(ref, async () => {
          this.#assertAgentAvailable(ref.agentId);
          const record = await this.#contextStore.get(ref);
          if (!record) {
            throw new AgentManagerError(
              "binding_not_found",
              `Execution Context ${encodeExecutionContextRef(ref)} is not registered`,
            );
          }
          const context = await this.#materializeCurrentContextRevision(record);
          await context.requestActive("resume");
        }),
      ref,
    );
  }

  async suspendContext(ref: ExecutionContextRef): Promise<void> {
    return this.#duringOpen(() =>
      this.#agentLifecycle.runContext(ref, async () => {
        this.#assertAgentAvailable(ref.agentId);
        this.#clearRestoreRetry(ref);
        const context = this.#requireContext(ref);
        await context.requestSuspend();
      }),
    );
  }

  async stopContext(ref: ExecutionContextRef): Promise<void> {
    return this.#duringOpen(async () => {
      this.#assertAgentAvailable(ref.agentId);
      this.#clearRestoreRetry(ref);
      const key = encodeExecutionContextRef(ref);
      const context = this.#requireContext(ref);
      const failures = await context.invalidateAndStop(() =>
        context.requestPermanentStop(),
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Execution Context ${key} stop cleanup failed`,
        );
      }
      context.stopForwardingTurnTerminals();
      await this.#contextStore.remove(ref);
      this.#contexts.delete(key);
      this.#unboundStopAttempts.delete(key);
    });
  }

  async cancelLocalRun(
    ref: ExecutionContextRef,
    runId: string,
  ): Promise<RunCancellationStatus> {
    return this.#duringOpen(async () => {
      const context = await this.#ensureMaterializedContext(ref, false);
      return context.cancelRun(runId);
    });
  }

  async deleteAgent(
    agentId: AgentId,
    options: AgentDeletionOptions = {},
  ): Promise<"deleted" | "not_found"> {
    return this.#duringOpen(async () => {
      const current = this.#deletionPromises.get(agentId);
      if (current) return current;
      const deletion = this.#deleteAgent(agentId, options);
      this.#deletionPromises.set(agentId, deletion);
      try {
        return await deletion;
      } finally {
        if (this.#deletionPromises.get(agentId) === deletion) {
          this.#deletionPromises.delete(agentId);
        }
      }
    });
  }

  close(options: { readonly runGracePeriodMs?: number } = {}): Promise<void> {
    this.#closePromise ??= this.#performClose(options.runGracePeriodMs ?? 0);
    return this.#closePromise;
  }

  async #restoreAgentContexts(agentId: AgentId): Promise<void> {
    const records = (await this.#contextStore.list()).filter(
      (record) => record.ref.agentId === agentId,
    );
    const ghost = await this.#ghostStore.get(agentId);
    if (!ghost) {
      throw new AgentManagerError(
        "agent_not_registered",
        `Agent "${agentId}" is not registered`,
      );
    }
    await Promise.all(
      records
        .filter((record) => record.terminalReason !== undefined)
        .map((record) => this.#reconcileStoredContext(record)),
    );
    const outcomes = await Promise.allSettled(
      records
        .filter((record) => record.terminalReason === undefined)
        .map((record) =>
          this.#restoreOperations.run(async () => {
            try {
              const context = await this.#materializeContext(
                record,
                "restored",
              );
              if (
                record.targetResidency === "active" &&
                (this.#lazyRestoreReasons.get(
                  encodeExecutionContextRef(record.ref),
                ) !== "unused_preparation" ||
                  (await this.#restoreRequiresActivation(
                    record,
                    context.runtime,
                  )))
              ) {
                await context.requestActive("agent_update");
              }
            } catch (error) {
              // The callback must return before TeamHub can commit active.
              // Materialization/activation already retained a background retry.
              if (
                !(error instanceof TerminalExecutionContextError) &&
                !isActivationPending(error)
              )
                throw error;
            }
          }),
        ),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Agent "${agentId}" configuration updated but contexts failed to restart`,
      );
    }
  }

  async #ensureMaterializedContext(
    ref: ExecutionContextRef,
    requestStoredTarget = true,
  ): Promise<ContextExecutor<TRuntimeSettings>> {
    this.#assertAgentAvailable(ref.agentId);
    const ghost = await this.#ghostStore.get(ref.agentId);
    if (!ghost) {
      throw new AgentManagerError(
        "agent_not_registered",
        `Agent "${ref.agentId}" is not registered`,
      );
    }
    const ensured = await this.#contextStore.ensure(
      ref,
      requestStoredTarget ? "active" : "suspended",
    );
    const context = await this.#materializeCurrentContextRevision(
      ensured.record,
      ensured.created ? "new" : "restored",
    );
    if (requestStoredTarget && ensured.record.targetResidency === "active") {
      context.trackTransition(
        context.requestActive("ensure_binding"),
        "activation.ensure_failed",
      );
    }
    return context;
  }

  async #materializeCurrentContextRevision(
    record: ExecutionContextRecord,
    bootstrap: ContextBootstrap = "restored",
  ): Promise<ContextExecutor<TRuntimeSettings>> {
    this.#assertContextMaterializable(record);
    const key = encodeExecutionContextRef(record.ref);
    // Share the whole replacement, including disposal of the old cold executor.
    // The lower-level creation singleflight starts too late to fence disposal.
    let pending = this.#contextRevisionPromises.get(key);
    if (!pending) {
      pending = this.#withConfigTiming(record.ref, "unscoped", () =>
        this.#reconcileMaterializedContextRevision(record, bootstrap),
      );
      this.#contextRevisionPromises.set(key, pending);
    }
    try {
      const context = await pending;
      this.#assertContextMaterializable(record);
      return context;
    } finally {
      if (this.#contextRevisionPromises.get(key) === pending) {
        this.#contextRevisionPromises.delete(key);
      }
    }
  }

  async #reconcileMaterializedContextRevision(
    record: ExecutionContextRecord,
    bootstrap: ContextBootstrap,
  ): Promise<ContextExecutor<TRuntimeSettings>> {
    const loaded = this.#contexts.get(encodeExecutionContextRef(record.ref));
    const canRefresh =
      loaded !== undefined &&
      loaded.canRefreshConfiguration() &&
      !loaded.hasActiveTransitions;
    if (canRefresh) {
      await this.#ghostStore.refresh?.(record.ref.agentId);
    }
    let context = await this.#materializeContext(record, bootstrap);
    const ghost = await this.#ghostStore.get(record.ref.agentId);
    if (
      !ghost ||
      context.configurationRevision === ghost.revision ||
      !canRefresh ||
      context !== loaded ||
      !context.canRefreshConfiguration() ||
      context.hasActiveTransitions
    ) {
      return context;
    }
    if (context.status === "active") {
      // Input may adopt a prepared Runtime while the authority read waits.
      // Serialize the final unused check with acceptance before invalidating it.
      const invalidated = await context.invalidateAdmissionIf(() =>
        context.canRefreshConfiguration(),
      );
      if (!invalidated) return context;
    }
    // A cold Context may already own queued inputs, so its public session-clear
    // operation correctly reports busy. Stop only its in-process resources;
    // the replacement loads the durable queue and discards a stale Provider
    // session at activation using the authoritative configuration revision.
    await this.#disposeLoadedContext(context);
    context = await this.#materializeContext(
      (await this.#contextStore.get(record.ref)) ?? record,
      "restored",
    );
    return context;
  }

  /**
   * A used Context keeps its Runtime across Runs. When its Agent's Runtime or
   * placement changed, the idle Context is replaced under the admission
   * boundary so the next Run activates the committed configuration.
   */
  async #replaceSupersededIdleContext(
    context: ContextExecutor<TRuntimeSettings>,
  ): Promise<ContextExecutor<TRuntimeSettings> | null> {
    if (context.status !== "active" || !(await this.#isSuperseded(context)))
      return null;
    const invalidated = await context.invalidateAdmissionIf(
      () => !context.isBusy() && context.admissionFailure() === null,
    );
    if (!invalidated) return null;
    const ref = context.ref;
    await this.#disposeLoadedContext(context);
    const stored = await this.#contextStore.get(ref);
    if (!stored) return null;
    return this.#materializeContext(
      { ...stored, targetResidency: "active" },
      "restored",
    );
  }

  async #disposeLoadedContext(
    context: ContextExecutor<TRuntimeSettings>,
  ): Promise<void> {
    this.#clearRestoreRetry(context.ref);
    // Attempt every owned cleanup even when an earlier step fails; suspend
    // must still precede stop to unwind an unused preparation intention.
    const failures: unknown[] = [];
    try {
      await context.releaseFeatures();
    } catch (error) {
      failures.push(error);
    }
    if (context.preparation !== null) {
      // Replacing configuration must not turn unused preparation into an
      // unbounded active intention when the replacement Context is created.
      try {
        await context.requestSuspend();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await context.requestStop();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Execution Context ${encodeExecutionContextRef(context.ref)} disposal failed`,
      );
    }
    context.stopForwardingTurnTerminals();
    const key = encodeExecutionContextRef(context.ref);
    this.#contexts.delete(key);
    this.#bootstrapHints.delete(key);
  }

  async #materializePersistedDebugContext(
    ref: ExecutionContextRef,
  ): Promise<ContextExecutor<TRuntimeSettings> | null> {
    const current = this.#contexts.get(encodeExecutionContextRef(ref));
    if (current) return current;
    const persisted = await this.#loadPersistedDebugContext(ref);
    if (!persisted) return null;
    return this.#materializeCurrentContextRevision(persisted.record);
  }

  /** Validates a persisted, non-terminal Context for debug reads without binding it. */
  async #loadPersistedDebugContext(ref: ExecutionContextRef): Promise<{
    readonly ghost: Readonly<Ghost<TRuntimeSettings>>;
    readonly record: ExecutionContextRecord;
  } | null> {
    this.#assertAgentAvailable(ref.agentId);
    const ghost = await this.#ghostStore.get(ref.agentId);
    if (!ghost) {
      throw new AgentManagerError(
        "agent_not_registered",
        `Agent "${ref.agentId}" is not registered`,
      );
    }
    const record = await this.#contextStore.get(ref);
    if (!record || record.terminalReason !== undefined) return null;
    return { ghost, record };
  }

  async #materializeContext(
    record: ExecutionContextRecord,
    bootstrap: ContextBootstrap,
  ): Promise<ContextExecutor<TRuntimeSettings>> {
    this.#assertAgentAvailable(record.ref.agentId);
    this.#assertContextMaterializable(record);
    const key = encodeExecutionContextRef(record.ref);
    const rememberedBootstrap = this.#bootstrapHints.get(key);
    const effectiveBootstrap =
      rememberedBootstrap === "new" || bootstrap === "new" ? "new" : "restored";
    this.#bootstrapHints.set(key, effectiveBootstrap);
    const current = this.#contexts.get(key);
    if (current) {
      this.#bootstrapHints.delete(key);
      return current;
    }

    let pending = this.#contextPromises.get(key);
    if (!pending) {
      pending = {
        agentId: record.ref.agentId,
        promise: this.#withConfigTiming(record.ref, "create", () =>
          this.#createContext(record, effectiveBootstrap),
        ),
      };
      this.#contextPromises.set(key, pending);
    }
    try {
      const context = await pending.promise;
      this.#assertContextMaterializable(record);
      this.#bootstrapHints.delete(key);
      return context;
    } catch (error) {
      const ghost = await this.#ghostStore.get(record.ref.agentId);
      // A general Agent identity callback can race active -> updating after
      // the pre-materialization check. Recheck before classifying its 404.
      let failure = error;
      if (
        ghost &&
        error instanceof AgentManagerError &&
        (error.code === "identity_unavailable" ||
          error.code === "identity_resolution_failed")
      ) {
        try {
          await this.#assertActivationReady(record.ref.agentId, ghost.revision);
        } catch (readinessError) {
          failure = readinessError;
        }
      }
      if (ghost && isActivationPending(failure)) {
        // Registration waiting owns this retry, not the identity 404 grace timer.
        this.#clearIdentityRetryTimer(record.ref.agentId);
        this.#identityTerminalFailures.delete(record.ref.agentId);
        this.#identityResolutionStartedAt.delete(record.ref.agentId);
        await this.#scheduleRestoreRetry(
          record,
          effectiveBootstrap,
          ghost.runtime,
          failure,
          1,
        );
      }
      throw failure;
    } finally {
      if (this.#contextPromises.get(key) === pending) {
        this.#contextPromises.delete(key);
      }
    }
  }

  async #createContext(
    record: ExecutionContextRecord,
    bootstrap: ContextBootstrap,
  ): Promise<ContextExecutor<TRuntimeSettings>> {
    const key = encodeExecutionContextRef(record.ref);
    let logger = this.#contextLogger(record.ref);
    const startedAt = Date.now();
    logger.log("info", "binding.create_started");
    // TeamHub may commit a profile while this service is unreachable. Refresh
    // only when creating an executor; active ones retain their accepted work.
    // Reuse only this read; input acceptance and Runtime activation recheck.
    const refreshed = await this.#ghostStore.refresh?.(record.ref.agentId, {
      shareInFlight: true,
    });
    const storedGhost = await this.#ghostStore.get(record.ref.agentId);
    if (storedGhost)
      await this.#assertActivationReady(
        record.ref.agentId,
        storedGhost.revision,
        refreshed?.revision === storedGhost.revision
          ? refreshed.activationReady
          : undefined,
      );
    const { ghost, identity } = await this.#requireIdentityResolvedGhost(
      record.ref.agentId,
      storedGhost,
    );
    const context = new ContextExecutor<TRuntimeSettings>({
      host: this.#host,
      services: this.#executorServices,
      features: this.#features,
      record,
      bootstrap,
      ghost,
      identity,
      logger,
    });
    logger = logger.child({ tenantId: ghost.tenantId });
    try {
      await context.open();
      await context.bindSources();
      this.#contexts.set(key, context);
      context.publish();
      if (this.#unboundContextKeys.has(key)) {
        const operation = this.#agentLifecycle.runContext(record.ref, () =>
          this.#stopUnboundContext(record.ref, context),
        );
        this.#trackBackground(
          operation,
          record.ref,
          "binding.unbind_stop_failed",
        );
      } else {
        context.scheduleIdleTimer();
      }
      logger.log("info", "binding.create_completed", {
        revision: ghost.revision,
        status: context.status,
        durationMs: elapsedMs(startedAt),
      });
      return context;
    } catch (error) {
      this.#contexts.delete(key);
      const cleanupErrors = await context.abandon(error);
      logger.log("error", "binding.create_failed", {
        durationMs: elapsedMs(startedAt),
        error,
      });
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Execution Context ${key} creation and cleanup failed`,
          { cause: error },
        );
      }
      // No Binding resources remain after confirmed cleanup. A later creation
      // checks current authority instead of inheriting this failed attempt's fence.
      this.#unboundContextKeys.delete(key);
      throw error;
    }
  }

  async #prepareContext(
    ref: Readonly<ExecutionContextRef>,
    queuedAt = Date.now(),
    source: PreparationSource = "room_preparation",
    admitsRuntime?: (runtime: Readonly<TRuntimeSettings>) => boolean,
  ): Promise<ContextPreparationOutcome> {
    const preparationStartedAt = Date.now();
    const queueWaitMs = preparationStartedAt - queuedAt;
    const key = encodeExecutionContextRef(ref);
    const presence = source === "room_presence";
    const restart = source === "restart_restore";
    if (
      this.#closePromise ||
      this.#deletingAgents.has(ref.agentId) ||
      this.#terminalContextKeys.has(key)
    ) {
      return { status: "skipped" };
    }
    const record = await this.#contextStore.get(ref);
    // A presence hint may also target a used Context, or one restored as
    // active whose Runtime was deferred; only an already warm Runtime is skipped.
    if (presence && this.#hasReadyRuntime(key)) {
      this.#renewIdleOnPresence(key);
      // Advisory: the executor decides whether the Provider needs an early start.
      this.#contexts.get(key)!.prestartProviderForPresence();
      return { status: "skipped" };
    }
    if (restart && this.#hasReadyRuntime(key)) return { status: "skipped" };
    if (!record) return { status: "skipped" };
    // A presence hint was admitted before its bind; a skip releases the idle
    // Context the bind took.
    const ghost = await this.#ghostStore.get(ref.agentId);
    if (
      record.terminalReason !== undefined ||
      (source === "room_preparation" &&
        record.targetResidency !== "suspended") ||
      !ghost ||
      !(
        presence ||
        (restart
          ? admitsRuntime?.(ghost.runtime)
          : this.#shouldPrepareContext?.({
              ref: record.ref,
              runtime: ghost.runtime,
            }))
      )
    ) {
      if (record.targetResidency === "suspended")
        await this.#releaseIdleContext(record.ref);
      return { status: "skipped" };
    }
    const bootstrap = source === "room_preparation" ? "new" : "restored";
    const context = await this.#materializeContext(record, bootstrap);
    if (
      this.#closePromise ||
      this.#deletingAgents.has(ref.agentId) ||
      this.#terminalContextKeys.has(key) ||
      context.status === "stopped" ||
      (presence || restart
        ? this.#hasReadyRuntime(key) || context.activationInFlight
        : context.targetResidency !== "suspended")
    )
      return { status: "skipped" };
    // Preparation is an ordinary authorized activation. Persist active before
    // resolving MCP, and retain the complete Runtime for the first input.
    context.markPreparation(source);
    const logger = this.#contextLogger(ref);
    const startedAt = Date.now();
    logger.log("info", "binding.preparation_started", {
      bootstrap,
      source,
      queueWaitMs,
      materializationMs: startedAt - preparationStartedAt,
    });
    try {
      await context.requestActive(source);
      logger.log("info", "binding.preparation_completed", {
        durationMs: elapsedMs(startedAt),
        queueWaitMs,
        materializationMs: startedAt - preparationStartedAt,
        totalDurationMs: elapsedMs(queuedAt),
        bootstrap,
        source,
      });
      if (presence) context.prestartProviderForPresence();
      return { status: "restored" };
    } catch (error) {
      // Real input takes over the active intention synchronously. A background
      // failure must never suspend work that arrived during preparation.
      const currentContext = this.#contexts.get(key);
      if (context.preparation !== null) {
        this.#clearRestoreRetry(ref);
        await context.requestSuspend();
        if (presence || restart) {
          logger.log(
            "info",
            presence
              ? "binding.presence_preparation_abandoned"
              : "binding.restart_restore_abandoned",
            { error },
          );
          // The bind took the Context without work; release it unless input
          // arrived while the Runtime was being suspended.
          if (
            context.targetResidency === "suspended" &&
            !context.activationInFlight
          )
            await this.#releaseIdleContext(ref);
          return restart && !isActivationPending(error)
            ? { status: "failed", error }
            : { status: "skipped" };
        }
      } else if (
        !isActivationPending(error) &&
        currentContext === context &&
        currentContext.targetResidency === "active" &&
        currentContext.status !== "stopped"
      ) {
        // An accepted foreground input shared the failed preparation attempt.
        // Give that input one ordinary activation attempt after the shared
        // transition settles; authorization is checked again before starting.
        await context.requestActive("preparation_input_recovery", false);
        return { status: "skipped" };
      }
      if (isActivationPending(error)) {
        this.#preparationContextKeys.delete(key);
        logger.log("debug", "binding.preparation_deferred", {
          reason: "agent_configuration_pending",
        });
        return { status: "skipped" };
      }
      throw error;
    }
  }

  /**
   * A presence hint keeps an idle Runtime warm for another idle window, so a
   * person still in the Room does not wait for a cold start. An unused
   * preparation keeps its short window; the Web stops the hints when the
   * person leaves or goes inactive.
   */
  #renewIdleOnPresence(key: string): void {
    this.#contexts.get(key)?.renewIdleWindow();
  }

  #hasReadyRuntime(key: string): boolean {
    const context = this.#contexts.get(key);
    return context?.status === "active" && context.isRuntimeReady();
  }

  #scheduleMaterialization(
    record: ExecutionContextRecord,
    bootstrap: ContextBootstrap,
  ): void {
    if (this.#closePromise || this.#deletingAgents.has(record.ref.agentId)) {
      return;
    }
    const key = encodeExecutionContextRef(record.ref);
    if (
      record.terminalReason !== undefined ||
      this.#terminalContextKeys.has(key)
    ) {
      this.#terminalContextKeys.add(key);
      return;
    }
    if (this.#contexts.has(key) || this.#contextPromises.has(key)) return;
    const operation = (async () => {
      try {
        const context = await this.#materializeContext(record, bootstrap);
        if (
          record.targetResidency === "active" &&
          !this.#lazyRestoreReasons.has(key)
        ) {
          await context.requestActive("materialize");
        }
      } catch (error) {
        if (!(error instanceof TerminalExecutionContextError)) throw error;
      }
    })();
    this.#trackBackground(operation, record.ref, "binding.materialize_failed");
  }

  async #restoreRequiresActivation(
    record: Readonly<ExecutionContextRecord>,
    runtime: Readonly<TRuntimeSettings>,
  ): Promise<boolean> {
    if (record.targetResidency !== "active") return false;
    return (
      (await this.#shouldActivateOnRestore?.({ ref: record.ref, runtime })) ??
      true
    );
  }

  #isRecoverableRestoreFailure(
    ref: ExecutionContextRef,
    runtime: TRuntimeSettings,
    error: unknown,
  ): boolean {
    if (isActivationPending(error)) return true;
    try {
      return (
        this.#restoreRecovery?.isRecoverable({ error, ref, runtime }) ?? false
      );
    } catch {
      return false;
    }
  }

  #shouldSuspendRestoreFailure(
    ref: ExecutionContextRef,
    runtime: TRuntimeSettings,
    error: unknown,
  ): boolean {
    if (isActivationPending(error)) return false;
    if (
      error instanceof AgentManagerError &&
      error.code === "agent_activation_rejected"
    )
      return true;
    try {
      return (
        this.#restoreRecovery?.shouldSuspend?.({ error, ref, runtime }) ?? false
      );
    } catch {
      return false;
    }
  }

  async #scheduleRestoreRetry(
    record: ExecutionContextRecord,
    bootstrap: ContextBootstrap,
    runtime: TRuntimeSettings,
    error: unknown,
    retryAttempt: number,
  ): Promise<void> {
    if (
      this.#closePromise ||
      this.#deletingAgents.has(record.ref.agentId) ||
      (record.targetResidency !== "active" && !isActivationPending(error))
    ) {
      return;
    }
    const key = encodeExecutionContextRef(record.ref);
    retryAttempt = Math.max(
      retryAttempt,
      this.#unboundStopAttempts.get(key) ?? 0,
    );
    const failure = { error, ref: record.ref, runtime };
    if (!this.#hasRestoreRetryBudget(failure, retryAttempt)) {
      // Keep suspension inside the caller's lifecycle operation: store sync must
      // re-read the persisted suspended state before it can reconcile again.
      await this.#suspendRestoreTarget(record, error, "retry_exhausted");
      return;
    }
    if (this.#deferredContextRestores.has(key)) return;
    const configuredRetryDelayMs = this.#resolveRestoreRetryDelayMs({
      ...failure,
      retryAttempt,
    });
    if (this.#unboundStopAttempts.has(key))
      this.#unboundStopAttempts.set(key, retryAttempt);
    const retryDelayMs = this.#unboundStopAttempts.has(key)
      ? Math.max(
          configuredRetryDelayMs,
          Math.min(
            30_000,
            RESTORE_RETRY_DELAY_MS * 2 ** Math.min(5, retryAttempt - 1),
          ),
        )
      : configuredRetryDelayMs;
    this.#contextLogger(record.ref).log("warn", "activation.restore_deferred", {
      error,
      retryAttempt,
      retryDelayMs,
    });
    const timer = setTimeout(() => {
      const deferred = this.#deferredContextRestores.get(key);
      if (!deferred || deferred.timer !== timer) return;
      this.#deferredContextRestores.delete(key);
      this.#launchRestoreRetry(deferred);
    }, retryDelayMs);
    timer.unref();
    this.#deferredContextRestores.set(key, {
      timer,
      record,
      bootstrap,
      runtime,
      retryAttempt,
    });
  }

  #launchRestoreRetry(
    deferred: DeferredContextRestore<TRuntimeSettings>,
  ): void {
    const operation = this.#agentLifecycle.runContext(deferred.record.ref, () =>
      this.#restoreOperations.run(() =>
        this.#retryRestore(
          deferred.record,
          deferred.bootstrap,
          deferred.runtime,
          deferred.retryAttempt,
        ),
      ),
    );
    this.#trackBackground(
      operation,
      deferred.record.ref,
      "activation.restore_retry_failed",
    );
  }

  #hasRestoreRetryBudget(
    failure: ContextRestoreFailure<TRuntimeSettings>,
    retryAttempt: number,
  ): boolean {
    // Waiting for the registration saga is not a failed Provider attempt.
    if (isActivationPending(failure.error)) return true;
    const configured = this.#restoreRecovery?.maxRetryAttempts;
    const maximum =
      typeof configured === "function" ? configured(failure) : configured;
    if (maximum === undefined) return true;
    if (!Number.isSafeInteger(maximum) || maximum < 0) {
      throw new TypeError(
        "restore max retry attempts must be a non-negative safe integer",
      );
    }
    return retryAttempt <= maximum;
  }

  #resolveRestoreRetryDelayMs(
    failure: ContextRestoreRetryFailure<TRuntimeSettings>,
  ): number {
    const retryDelayMs =
      typeof this.#restoreRetryDelayMs === "function"
        ? this.#restoreRetryDelayMs(failure)
        : this.#restoreRetryDelayMs;
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) {
      throw new TypeError(
        "restore retry delay must be a positive safe integer",
      );
    }
    return retryDelayMs;
  }

  async #retryRestore(
    record: ExecutionContextRecord,
    bootstrap: ContextBootstrap,
    runtime: TRuntimeSettings,
    retryAttempt: number,
  ): Promise<void> {
    if (this.#closePromise || this.#deletingAgents.has(record.ref.agentId)) {
      return;
    }
    const key = encodeExecutionContextRef(record.ref);
    if (this.#unboundContextKeys.has(key) && this.#contexts.has(key)) {
      await this.#stopUnboundContext(record.ref);
      return;
    }
    let current: ExecutionContextRecord | null;
    try {
      current = await this.#contextStore.get(record.ref);
    } catch (error) {
      // A failed authority read is not permission to activate, nor evidence that
      // the retained recovery intent disappeared. Retry only transient transport
      // failures; the next attempt must re-read current residency and fencing.
      if (!(error instanceof TeamHubRuntimeStateError) || !error.retryable)
        throw error;
      await this.#scheduleRestoreRetry(
        record,
        bootstrap,
        runtime,
        error,
        retryAttempt + 1,
      );
      return;
    }
    if (
      !current ||
      current.targetResidency !== record.targetResidency ||
      current.terminalReason !== undefined
    )
      return;
    // get() refreshes the record. list() exposes only the Contexts this
    // process holds; a readable unheld Context cannot authorize
    // rematerialization after an unbind.
    if (
      !(await this.#contextStore.list()).some(
        ({ ref }) => encodeExecutionContextRef(ref) === key,
      )
    )
      return;
    try {
      const context = await this.#materializeCurrentContextRevision(
        current,
        bootstrap,
      );
      if (
        current.targetResidency === "active" &&
        (!this.#lazyRestoreReasons.has(
          encodeExecutionContextRef(current.ref),
        ) ||
          (await this.#restoreRequiresActivation(current, context.runtime)))
      ) {
        await context.requestActive("restore_retry");
      }
      this.#contextLogger(record.ref).log(
        "info",
        "activation.restore_recovered",
      );
    } catch (error) {
      if (this.#shouldSuspendRestoreFailure(record.ref, runtime, error)) {
        await this.#suspendRestoreTarget(current, error, "rejected");
        return;
      }
      if (!this.#isRecoverableRestoreFailure(record.ref, runtime, error)) {
        throw error;
      }
      await this.#scheduleRestoreRetry(
        current,
        bootstrap,
        runtime,
        error,
        retryAttempt + 1,
      );
    }
  }

  async #suspendRestoreTarget(
    record: ExecutionContextRecord,
    error: unknown,
    reason: "rejected" | "retry_exhausted",
  ): Promise<void> {
    this.#clearRestoreRetry(record.ref);
    const context = this.#contexts.get(encodeExecutionContextRef(record.ref));
    if (context) {
      await context.requestSuspend();
    } else {
      const updated = await this.#contextStore.setTargetResidency(
        record.ref,
        "suspended",
      );
      if (updated === "not_found") return;
    }
    this.#contextLogger(record.ref).log(
      "warn",
      "activation.restore_suspended",
      {
        error,
        reason,
      },
    );
  }

  #clearRestoreRetry(ref: ExecutionContextRef): void {
    const key = encodeExecutionContextRef(ref);
    const deferred = this.#deferredContextRestores.get(key);
    if (!deferred) return;
    clearTimeout(deferred.timer);
    this.#deferredContextRestores.delete(key);
  }

  #agentHasInFlightContextWork(
    agentId: AgentId,
    contexts: readonly ContextExecutor<TRuntimeSettings>[],
  ): boolean {
    if (contexts.some((context) => context.isBusy())) {
      return true;
    }
    for (const pending of this.#contextPromises.values()) {
      if (pending.agentId === agentId) return true;
    }
    return false;
  }

  async #assertActivationReady(
    agentId: AgentId,
    revision: string,
    refreshedReadiness?: boolean,
  ): Promise<void> {
    if (refreshedReadiness === undefined) {
      const check = this.#ghostStore.isActivationReady;
      if (!check) return; // Explicit in-memory/demo backends have no registration saga.
      refreshedReadiness = await check.call(
        this.#ghostStore,
        agentId,
        revision,
      );
    }
    if (refreshedReadiness) return;
    throw new AgentManagerError(
      "agent_activation_pending",
      "Agent registration must be active at the Context configuration revision before activation",
    );
  }

  async #isSuperseded(
    context: ContextExecutor<TRuntimeSettings>,
  ): Promise<boolean> {
    // TeamHub commits an Agent update or move in its registration row, and
    // the registration change already refreshed the cached Ghost. A Runtime
    // created before a Runtime or placement change would run the queued
    // input on the old placement, so it is replaced first. A profile-only
    // change keeps the Runtime: its next claim delivers the profile update.
    // The Ghost is cached, so this adds no TeamHub request to the hot path;
    // a revoked Agent is left to deletion.
    const ghost = await this.#ghostStore.get(context.ref.agentId);
    return (
      ghost !== null &&
      (ghost.runtimeRevision ?? ghost.revision) !== context.runtimeRevision
    );
  }

  async #takeUpQueuedInputSlow(
    context: ContextExecutor<TRuntimeSettings>,
    kind: RunWakeKind,
  ): Promise<void> {
    const record = context.record;
    const ref = record.ref;
    const key = context.key;
    const queuedAt = performance.now();
    await this.#agentLifecycle.runContext(ref, async () => {
      if (
        this.#closePromise ||
        this.#deletingAgents.has(ref.agentId) ||
        this.#contexts.get(key) !== context ||
        this.#terminalContextKeys.has(key) ||
        this.#unboundContextKeys.has(key) ||
        this.#deferredContextRestores.has(key)
      )
        return;
      this.#contextLogger(ref).log("info", "activation.requested", {
        reason: "queued_input",
        kind,
        lifecycleWaitMs: Math.round(performance.now() - queuedAt),
      });
      // A cold Context whose profile was superseded is replaced first, so
      // the queued Run executes with the current configuration.
      const current = context.canRefreshConfiguration()
        ? await this.#materializeCurrentContextRevision({
            ...record,
            targetResidency: "active",
          })
        : ((await this.#replaceSupersededIdleContext(context)) ?? context);
      // TeamHub needs no residency write for a Context that already targets
      // active residency; only a suspended one is recorded as wanted again.
      await current.requestActive(
        "queued_input",
        current.targetResidency !== "active",
      );
      current.notifyQueuedInput(kind);
    });
  }

  async #checkActivationOrDefer(
    context: ContextExecutor<TRuntimeSettings>,
    pendingFailure?: unknown,
  ): Promise<void> {
    try {
      if (pendingFailure !== undefined) throw asError(pendingFailure);
      await this.#withConfigTiming(context.ref, "activation", () =>
        this.#assertActivationReady(
          context.ref.agentId,
          context.configurationRevision,
        ),
      );
    } catch (error) {
      if (isActivationPending(error)) {
        const record = await this.#contextStore.get(context.ref);
        if (record)
          await this.#scheduleRestoreRetry(
            record,
            "restored",
            context.runtime,
            error,
            1,
          );
      }
      throw error;
    }
  }

  async #releaseIdleContext(ref: Readonly<ExecutionContextRef>): Promise<void> {
    await this.#contextStore.releaseIfIdle?.(ref);
  }

  #startContextStoreSync(): void {
    if (!this.#unsubscribeContextStore && this.#contextStore.subscribe) {
      this.#unsubscribeContextStore = this.#contextStore.subscribe((record) => {
        const key = encodeExecutionContextRef(record.ref);
        if (record.terminalReason === undefined) {
          // Binding again is not proof that the previous resources were
          // cleaned up. Keep the unbind mark until cleanup succeeds.
          if (!this.#contexts.has(key)) this.#unboundContextKeys.delete(key);
        }
        // Subscribers are synchronous notifications: enqueue, never await here.
        const operation = this.#agentLifecycle.runContext(
          record.ref,
          async () => {
            // The notifying store already holds the latest observed record;
            // any later change publishes again and queues behind this one.
            const current = record.terminalReason
              ? record
              : (this.#contextStore.cached?.(record.ref) ??
                (await this.#contextStore.get(record.ref)));
            if (current) {
              const hadBinding = this.#contexts.has(key);
              await this.#reconcileStoredContext(current);
              if (
                current.terminalReason === undefined &&
                current.targetResidency === "suspended"
              ) {
                if (this.#shouldPrepareContext)
                  this.scheduleContextPreparation(current.ref);
                else if (!hadBinding && !this.#deferredContextRestores.has(key))
                  await this.#releaseIdleContext(current.ref);
              }
            }
          },
        );
        this.#trackBackground(
          operation,
          record.ref,
          "binding.store_sync_failed",
        );
      });
    }
    if (!this.#unsubscribeContextUnbind && this.#contextStore.subscribeUnbind) {
      this.#unsubscribeContextUnbind = this.#contextStore.subscribeUnbind(
        (ref) => {
          const key = encodeExecutionContextRef(ref);
          this.#unboundContextKeys.add(key);
          const operation = this.#agentLifecycle.runContext(ref, () =>
            this.#stopUnboundContext(ref),
          );
          this.#trackBackground(operation, ref, "binding.unbind_stop_failed");
        },
      );
    }
  }

  async #reconcileStoredContext(
    record: Readonly<ExecutionContextRecord>,
  ): Promise<void> {
    if (this.#closePromise || this.#deletingAgents.has(record.ref.agentId)) {
      return;
    }
    const key = encodeExecutionContextRef(record.ref);
    if (
      record.terminalReason === undefined &&
      this.#unboundContextKeys.has(key)
    ) {
      return;
    }
    if (record.terminalReason !== undefined) {
      this.#terminalContextKeys.add(key);
      this.#unboundStopAttempts.delete(key);
      this.#lazyRestoreReasons.delete(key);
      this.#clearRestoreRetry(record.ref);
      await this.#stopTerminalContext(record.ref, record.terminalReason);
      return;
    }
    if (this.#terminalContextKeys.has(key)) {
      // TeamHub can rebuild a deleted per-Room Context for a new membership
      // epoch. Only a freshly owned, nonterminal record can retire its tombstone.
      const owned = await this.#contextStore.list();
      if (
        !owned.some((current) => encodeExecutionContextRef(current.ref) === key)
      )
        return;
      this.#terminalContextKeys.delete(key);
    }
    if (
      this.#deferredContextRestores.get(key)?.record.targetResidency ===
      record.targetResidency
    ) {
      return;
    }
    if (record.targetResidency !== "active") {
      this.#clearRestoreRetry(record.ref);
      this.#lazyRestoreReasons.delete(key);
    }
    const ghost = await this.#ghostStore.get(record.ref.agentId);
    if (!ghost) return;
    const existing = this.#contexts.get(key);
    const wasMaterialized = existing !== undefined;
    const bootstrap = wasMaterialized ? "restored" : "new";
    const context =
      record.targetResidency === "active"
        ? await this.#materializeCurrentContextRevision(record, bootstrap)
        : (existing ?? (await this.#materializeContext(record, bootstrap)));
    if (record.targetResidency === "active") {
      if (
        this.#lazyRestoreReasons.has(key) &&
        !(await this.#restoreRequiresActivation(record, ghost.runtime))
      ) {
        return;
      }
      const runtimeReady = context.isRuntimeReady();
      if (runtimeReady) context.clearAutomaticActivationFailure();
      if (
        !wasMaterialized ||
        context.targetResidency !== "active" ||
        !runtimeReady
      ) {
        const previousFailure = context.automaticActivationFailure;
        try {
          // Explicit inputs and management calls may have no deferred retry yet.
          // Preserve the original classification without activating again.
          if (previousFailure) throw previousFailure.error;
          await context.requestActive("store_sync", false);
        } catch (error) {
          if (error instanceof TerminalExecutionContextError) return;
          if (
            this.#shouldSuspendRestoreFailure(record.ref, ghost.runtime, error)
          ) {
            await this.#suspendRestoreTarget(record, error, "rejected");
            return;
          }
          if (
            this.#isRecoverableRestoreFailure(record.ref, ghost.runtime, error)
          ) {
            await this.#scheduleRestoreRetry(
              record,
              bootstrap,
              ghost.runtime,
              error,
              1,
            );
            return;
          }
          if (!previousFailure) throw error;
        }
      } else {
        context.notifyWorkAvailable();
      }
      return;
    }
    if (context.targetResidency === record.targetResidency) return;
    const failures = await context.invalidateAndStop(() =>
      context.requestStop(),
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Execution Context ${key} residency-change cleanup failed`,
      );
    }
    context.stopForwardingTurnTerminals();
    if (this.#contexts.get(key) === context) {
      this.#contexts.delete(key);
      await this.#releaseIdleContext(record.ref);
    }
  }

  async #stopTerminalContext(
    ref: ExecutionContextRef,
    terminalReason: NonNullable<ExecutionContextRecord["terminalReason"]>,
  ): Promise<void> {
    const key = encodeExecutionContextRef(ref);
    const current = this.#terminalContextStops.get(key);
    if (current) return current;
    const operation = (async () => {
      const pending = this.#contextPromises.get(key)?.promise;
      const created = pending ? await pending.catch(() => null) : null;
      const context = this.#contexts.get(key) ?? created;
      if (!context) return;
      const failures = await context.invalidateAndStop(() =>
        context.requestStop(),
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Execution Context ${key} terminal cleanup failed`,
        );
      }
      context.stopForwardingTurnTerminals();
      if (this.#contexts.get(key) === context) this.#contexts.delete(key);
      this.#contextLogger(ref).log("info", "binding.terminated", {
        terminalReason,
      });
    })();
    this.#terminalContextStops.set(key, operation);
    try {
      await operation;
    } finally {
      if (this.#terminalContextStops.get(key) === operation) {
        this.#terminalContextStops.delete(key);
      }
    }
  }

  /**
   * Stop resources of a Context this process stopped holding, or that
   * TeamHub rebound to a new Room membership, without deleting durable
   * Context state. A later bind publishes a normal store event and rebuilds
   * the binding through #reconcileStoredContext.
   */
  async #stopUnboundContext(
    ref: ExecutionContextRef,
    expected?: ContextExecutor<TRuntimeSettings>,
  ): Promise<void> {
    if (this.#closePromise || this.#deletingAgents.has(ref.agentId)) return;
    const key = encodeExecutionContextRef(ref);
    const context = this.#contexts.get(key);
    if (!context || (expected !== undefined && context !== expected)) return;
    // Binding replacement is not evidence of recovery. Preserve consecutive
    // cleanup failures until the Context restores.
    const retryAttempt = (this.#unboundStopAttempts.get(key) ?? 0) + 1;
    this.#unboundStopAttempts.set(key, retryAttempt);

    if (context.preparation !== null) {
      // An unbound Context cannot change residency. After it binds again, keep
      // this unused Runtime cold until queued work or explicit input arrives.
      this.#lazyRestoreReasons.set(key, "unused_preparation");
    }

    const failures = await context.invalidateAndStop(() =>
      context.requestStop(),
    );
    this.#clearRestoreRetry(ref);
    this.#contextLogger(ref).log(
      failures.length === 0 ? "info" : "warn",
      "binding.unbound",
      {
        ...(failures.length === 0 ? {} : { cleanupFailures: failures }),
        contextKey: key,
      },
    );
    if (failures.length === 0) {
      context.stopForwardingTurnTerminals();
      if (this.#contexts.get(key) === context) this.#contexts.delete(key);
      this.#unboundContextKeys.delete(key);
    } else {
      this.#unboundContextKeys.add(key);
    }
    try {
      const record = await this.#contextStore.get(ref);
      const ghost = await this.#ghostStore.get(ref.agentId);
      const held = (await this.#contextStore.list()).some(
        ({ ref: currentRef }) => encodeExecutionContextRef(currentRef) === key,
      );
      if (
        record &&
        ghost &&
        record.terminalReason === undefined &&
        record.targetResidency === "active" &&
        (held || failures.length > 0)
      ) {
        await this.#scheduleRestoreRetry(
          record,
          this.#bootstrapHints.get(key) ?? "restored",
          ghost.runtime,
          failures[0] ?? new Error("Execution Context was unbound"),
          retryAttempt,
        );
      }
    } catch (error) {
      if (error instanceof TeamHubRuntimeStateError && error.retryable) {
        await this.#scheduleRestoreRetry(
          { ref, targetResidency: context.targetResidency },
          this.#bootstrapHints.get(key) ?? "restored",
          context.runtime,
          error,
          retryAttempt,
        );
      }
      this.#contextLogger(ref).log("warn", "binding.unbind_restore_failed", {
        error,
        contextKey: key,
      });
    }
  }

  async #persistTargetResidency(
    ref: ExecutionContextRef,
    targetResidency: ContextTargetResidency,
  ): Promise<void> {
    const updated = await this.#contextStore.setTargetResidency(
      ref,
      targetResidency,
    );
    if (updated === "not_found") {
      throw new AgentManagerError(
        "binding_not_found",
        `Execution Context ${encodeExecutionContextRef(ref)} is not persisted`,
      );
    }
  }

  async #deleteAgent(
    agentId: AgentId,
    options: AgentDeletionOptions,
  ): Promise<"deleted" | "not_found"> {
    const ghost = await this.#ghostStore.get(agentId);
    const deletionIdentity = ghost
      ? null
      : await this.#ghostStore.getDeletionIdentity?.(agentId);
    const cleanupIdentity = ghost ?? deletionIdentity;

    this.#deletingAgents.add(agentId);
    try {
      this.#clearIdentityRetryTimer(agentId);
      const storedRecords = await this.#contextStore.listByAgent(agentId);
      if (deletionIdentity) {
        const expectedKeys = new Set(
          deletionIdentity.contextRefs.map(encodeExecutionContextRef),
        );
        if (
          deletionIdentity.agentId !== agentId ||
          expectedKeys.size !== storedRecords.length ||
          storedRecords.some(
            ({ ref }) => !expectedKeys.has(encodeExecutionContextRef(ref)),
          )
        )
          throw new Error("Agent deletion identity has changed Contexts");
      }
      for (const record of storedRecords) {
        this.#clearRestoreRetry(record.ref);
      }
      await Promise.allSettled(
        [...this.#contextPromises.values()]
          .filter((pending) => pending.agentId === agentId)
          .map(({ promise }) => promise),
      );
      await Promise.allSettled(
        storedRecords.flatMap((record) => {
          const operation = this.#terminalContextStops.get(
            encodeExecutionContextRef(record.ref),
          );
          return operation ? [operation] : [];
        }),
      );
      const contexts = [...this.#contexts.values()].filter(
        (context) => context.ref.agentId === agentId,
      );
      // Commit Runner cleanup before deactivation can need an offline Computer.
      if (cleanupIdentity) await options.beforeIdentityRemoval?.();

      const behaviorStops = await Promise.allSettled(
        contexts.map((context) => context.releaseFeatures()),
      );
      const shellStops = await Promise.allSettled(
        contexts.map((context) => context.requestPermanentStop()),
      );
      const failures = [...behaviorStops, ...shellStops].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Agent "${agentId}" deletion failed to stop all Execution Contexts`,
        );
      }
      for (const context of contexts) context.stopForwardingTurnTerminals();

      await this.#contextStore.removeByAgent(agentId);
      for (const context of contexts) {
        const key = encodeExecutionContextRef(context.ref);
        this.#contexts.delete(key);
        this.#unboundStopAttempts.delete(key);
        this.#bootstrapHints.delete(key);
      }
      for (const record of storedRecords) {
        const key = encodeExecutionContextRef(record.ref);
        this.#unboundStopAttempts.delete(key);
        this.#bootstrapHints.delete(key);
        this.#lazyRestoreReasons.delete(key);
        this.#preparationContextKeys.delete(key);
        this.#terminalContextKeys.delete(key);
        this.#terminalContextStops.delete(key);
      }

      await Promise.allSettled(
        this.#identityPromises.has(agentId)
          ? [this.#identityPromises.get(agentId)!]
          : [],
      );
      this.#identityPromises.delete(agentId);
      this.#resolvedIdentities.delete(agentId);
      this.#identityRetryAttempts.delete(agentId);
      this.#identityResolutionStartedAt.delete(agentId);
      this.#identityTerminalFailures.delete(agentId);
      if (!cleanupIdentity) return "not_found";
      return (await this.#ghostStore.remove(agentId)) === "removed" ||
        deletionIdentity
        ? "deleted"
        : "not_found";
    } finally {
      this.#deletingAgents.delete(agentId);
    }
  }

  async #requireIdentityResolvedGhost(
    agentId: AgentId,
    ghost: Readonly<Ghost<TRuntimeSettings>> | null,
  ): Promise<{
    readonly ghost: Readonly<Ghost<TRuntimeSettings>> & { actorId: ActorId };
    readonly identity: ResolvedAgentIdentity;
  }> {
    if (!ghost) {
      throw new AgentManagerError(
        "agent_not_registered",
        `Agent "${agentId}" is not registered`,
      );
    }
    const snapshot = this.#snapshotGhost(ghost);
    try {
      const identity = await this.#requestIdentityResolution(agentId);
      return {
        ghost: this.#snapshotGhost({
          ...snapshot,
          actorId: identity.actorId,
        }) as Readonly<Ghost<TRuntimeSettings>> & { actorId: ActorId },
        identity,
      };
    } catch (error) {
      const terminalFailure = this.#identityTerminalFailures.get(agentId);
      if (this.#identityTerminalFailures.has(agentId)) {
        throw new AgentManagerError(
          "identity_resolution_failed",
          `Agent "${agentId}" identity resolution failed: ${unknownErrorMessage(terminalFailure)}`,
        );
      }
      throw new AgentManagerError(
        "identity_unavailable",
        `Agent "${agentId}" identity is unavailable: ${unknownErrorMessage(error)}`,
      );
    }
  }

  #requestIdentityResolution(agentId: AgentId): Promise<ResolvedAgentIdentity> {
    this.#clearIdentityRetryTimer(agentId);
    const resolved = this.#resolvedIdentities.get(agentId);
    if (resolved) return Promise.resolve(resolved);
    const terminalFailure = this.#identityTerminalFailures.get(agentId);
    if (this.#identityTerminalFailures.has(agentId)) {
      return Promise.reject(terminalFailure);
    }
    const current = this.#identityPromises.get(agentId);
    if (current) return current;

    this.#identityResolutionStartedAt.set(
      agentId,
      this.#identityResolutionStartedAt.get(agentId) ?? Date.now(),
    );
    const startedAt = Date.now();
    const logger = this.#logger.child({ agentId });
    logger.log("info", "agent.identity_resolution.started");
    const pending = (async () => {
      const identity = await this.#identityResolver.resolveIdentity(agentId);
      if (!identity.actorId) {
        throw new TypeError("Resolved Actor ID must not be empty");
      }
      if (!identity.sponsor.actorId || !identity.sponsor.displayName.trim()) {
        throw new TypeError("Resolved Agent sponsor identity is invalid");
      }
      const storedGhost = await this.#ghostStore.get(agentId);
      if (!storedGhost) {
        throw new AgentManagerError(
          "agent_not_registered",
          `Agent "${agentId}" is not registered`,
        );
      }
      if (storedGhost.actorId && storedGhost.actorId !== identity.actorId) {
        throw new TypeError(
          `Resolved Actor ID does not match Agent "${agentId}" persisted identity`,
        );
      }
      if (
        !storedGhost.actorId &&
        (await this.#ghostStore.setActorId(agentId, identity.actorId)) ===
          "not_found"
      ) {
        throw new AgentManagerError(
          "agent_not_registered",
          `Agent "${agentId}" is not registered`,
        );
      }
      return identity;
    })();
    this.#identityPromises.set(agentId, pending);
    void pending.then(
      (identity) => {
        if (this.#identityPromises.get(agentId) === pending) {
          this.#identityPromises.delete(agentId);
        }
        this.#resolvedIdentities.set(agentId, identity);
        this.#identityRetryAttempts.delete(agentId);
        this.#identityResolutionStartedAt.delete(agentId);
        this.#identityTerminalFailures.delete(agentId);
        logger.log("info", "agent.identity_resolution.completed", {
          actorId: identity.actorId,
          sponsorActorId: identity.sponsor.actorId,
          durationMs: elapsedMs(startedAt),
        });
        this.#scheduleAgentMaterialization(agentId);
      },
      (error) => {
        if (this.#identityPromises.get(agentId) === pending) {
          this.#identityPromises.delete(agentId);
        }
        const resolutionStartedAt =
          this.#identityResolutionStartedAt.get(agentId) ?? startedAt;
        const resolutionElapsedMs = elapsedMs(resolutionStartedAt);
        const failureKind = identityResolutionFailureKind(error);
        const retryable =
          failureKind === "transient" ||
          (failureKind === "not_found" &&
            resolutionElapsedMs < this.#identityNotFoundGracePeriodMs);
        if (retryable) {
          logger.log("warn", "agent.identity_resolution.failed", {
            failureKind,
            retryable,
            durationMs: elapsedMs(startedAt),
            resolutionElapsedMs,
            error,
          });
          this.#scheduleIdentityResolutionRetry(agentId);
          return;
        }
        this.#identityRetryAttempts.delete(agentId);
        this.#identityResolutionStartedAt.delete(agentId);
        this.#clearIdentityRetryTimer(agentId);
        this.#identityTerminalFailures.set(agentId, error);
        logger.log("error", "agent.identity_resolution.terminal_failed", {
          failureKind,
          retryable,
          durationMs: elapsedMs(startedAt),
          resolutionElapsedMs,
          error,
        });
      },
    );
    return pending;
  }

  #scheduleAgentMaterialization(agentId: AgentId): void {
    if (this.#closePromise || this.#deletingAgents.has(agentId)) return;
    const operation = (async () => {
      const records = (await this.#contextStore.list()).filter(
        (record) => record.ref.agentId === agentId,
      );
      for (const record of records) {
        if (!this.#bootstrapHints.has(encodeExecutionContextRef(record.ref))) {
          continue;
        }
        this.#scheduleMaterialization(record, "restored");
      }
    })();
    this.#trackBackground(operation, agentId, "binding.repair_failed");
  }

  #scheduleIdentityResolutionRetry(agentId: AgentId): void {
    if (this.#closePromise || this.#deletingAgents.has(agentId)) return;
    const retryAttempt = (this.#identityRetryAttempts.get(agentId) ?? 0) + 1;
    this.#identityRetryAttempts.set(agentId, retryAttempt);
    const delayMs = Math.min(
      IDENTITY_RETRY_INITIAL_DELAY_MS * 2 ** (retryAttempt - 1),
      IDENTITY_RETRY_MAX_DELAY_MS,
    );
    const timer = setTimeout(() => {
      this.#identityRetryTimers.delete(agentId);
      if (!this.#closePromise && !this.#deletingAgents.has(agentId)) {
        void this.#requestIdentityResolution(agentId);
      }
    }, delayMs);
    this.#identityRetryTimers.set(agentId, timer);
  }

  #clearIdentityRetryTimer(agentId: AgentId): void {
    const timer = this.#identityRetryTimers.get(agentId);
    if (!timer) return;
    clearTimeout(timer);
    this.#identityRetryTimers.delete(agentId);
  }

  #requireContext(ref: ExecutionContextRef): ContextExecutor<TRuntimeSettings> {
    const context = this.#contexts.get(encodeExecutionContextRef(ref));
    if (!context) {
      throw new AgentManagerError(
        "binding_not_found",
        `Execution Context ${encodeExecutionContextRef(ref)} is not materialized`,
      );
    }
    return context;
  }

  #restorePriorityFor(
    ref: ExecutionContextRef,
    runtime: Readonly<TRuntimeSettings>,
  ): number {
    if (this.#restoreDemandedContextKeys.has(encodeExecutionContextRef(ref))) {
      return Number.MIN_SAFE_INTEGER;
    }
    return this.#restorePriority?.({ ref, runtime }) ?? 0;
  }

  #prioritizeContextRestore(ref: ExecutionContextRef): void {
    if (this.#restoreInProgress > 0) {
      this.#restoreDemandedContextKeys.add(encodeExecutionContextRef(ref));
    }
  }

  #assertContextMaterializable(record: Readonly<ExecutionContextRecord>): void {
    const key = encodeExecutionContextRef(record.ref);
    if (record.terminalReason !== undefined) {
      this.#terminalContextKeys.add(key);
    }
    if (this.#terminalContextKeys.has(key)) {
      throw new TerminalExecutionContextError(record.ref);
    }
  }

  #assertAgentAvailable(agentId: AgentId): void {
    if (this.#deletingAgents.has(agentId)) {
      throw new AgentManagerError(
        "agent_deleting",
        `Agent "${agentId}" is being deleted`,
      );
    }
  }

  #snapshotGhost(
    ghost: GhostInput<TRuntimeSettings>,
  ): Readonly<Ghost<TRuntimeSettings>> {
    let runtime: TRuntimeSettings;
    try {
      runtime = this.#parseRuntime(ghost.runtime);
    } catch (error) {
      throw new AgentManagerError(
        "invalid_runtime",
        `Invalid Agent runtime: ${unknownErrorMessage(error)}`,
      );
    }
    return snapshotGhost({ ...ghost, runtime });
  }

  #trackBackground(
    operation: Promise<unknown>,
    target: ExecutionContextRef | AgentId,
    event: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    const tracked = operation.catch((error: unknown) => {
      const logger =
        typeof target === "string"
          ? this.#logger.child({ agentId: target })
          : this.#contextLogger(target);
      logger.log("warn", event, { ...fields, error });
    });
    this.#operations.add(tracked);
    void tracked.finally(() => this.#operations.delete(tracked));
  }

  async #performClose(runGracePeriodMs: number): Promise<void> {
    const runGraceDeadline = Date.now() + runGracePeriodMs;
    const failures: unknown[] = [];
    this.#unsubscribeContextStore?.();
    this.#unsubscribeContextStore = null;
    this.#unsubscribeContextUnbind?.();
    this.#unsubscribeContextUnbind = null;
    const stoppingContexts = new Set<ContextExecutor<TRuntimeSettings>>();
    const stops: Promise<void>[] = [];
    const observeStop = (operation: Promise<unknown>): void => {
      // Attach rejection handling before waiting for any other lifecycle work.
      // A late allSettled leaves a window for Node's unhandled rejection exit.
      stops.push(
        operation.then(
          () => undefined,
          (error: unknown) => {
            failures.push(error);
          },
        ),
      );
    };
    const requestContextStop = (
      context: ContextExecutor<TRuntimeSettings>,
    ): void => {
      if (stoppingContexts.has(context)) return;
      stoppingContexts.add(context);
      // The serialized invalidation converges before either cleanup starts so
      // source.stop observes the invalidated signal; a failed invalidation
      // must never skip the mandatory cleanup.
      const invalidation = invokeClose(() => context.invalidateAdmission());
      observeStop(invalidation);
      const afterInvalidation = (operation: () => void | Promise<void>) =>
        invalidation.then(
          () => invokeClose(operation),
          () => invokeClose(operation),
        );
      observeStop(afterInvalidation(() => context.features.release()));
      observeStop(
        context.stopForShutdown(afterInvalidation, () =>
          Math.max(0, runGraceDeadline - Date.now()),
        ),
      );
    };
    for (const timer of this.#identityRetryTimers.values()) clearTimeout(timer);
    this.#identityRetryTimers.clear();
    for (const deferred of this.#deferredContextRestores.values()) {
      clearTimeout(deferred.timer);
    }
    this.#deferredContextRestores.clear();
    this.#lazyRestoreReasons.clear();
    for (const context of this.#contexts.values()) {
      context.clearIdleTimer();
      requestContextStop(context);
    }

    await Promise.allSettled([...this.#operations]);
    await Promise.allSettled(
      [...this.#contextPromises.values()].map(({ promise }) => promise),
    );
    await Promise.allSettled([...this.#identityPromises.values()]);

    for (const context of this.#contexts.values()) {
      context.clearIdleTimer();
      requestContextStop(context);
    }

    await Promise.all(stops);
    for (const context of this.#contexts.values()) {
      context.stopForwardingTurnTerminals();
    }

    const storesClosed = await Promise.allSettled([
      this.#contextStore.close(),
      this.#ghostStore.close(),
    ]);
    for (const result of storesClosed) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    this.#bootstrapHints.clear();
    this.#preparationContextKeys.clear();
    this.#unboundContextKeys.clear();
    this.#unboundStopAttempts.clear();
    this.#terminalContextKeys.clear();
    this.#terminalContextStops.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Executor registry close failed");
    }
  }

  async #duringOpen<T>(
    operation: () => Promise<T>,
    timingRef?: ExecutionContextRef,
  ): Promise<T> {
    this.#assertOpen();
    const pending = timingRef
      ? this.#withConfigTiming(timingRef, "unscoped", operation, true)
      : operation();
    this.#operations.add(pending);
    try {
      return await pending;
    } finally {
      this.#operations.delete(pending);
    }
  }

  #assertOpen(): void {
    if (this.#closePromise) {
      throw new AgentManagerError(
        "manager_closed",
        "Executor registry is closed",
      );
    }
  }

  #contextLogger(ref: ExecutionContextRef): AgentLogger {
    return this.#logger.child({
      agentId: ref.agentId,
      contextKey: encodeExecutionContextRef(ref),
      contextKind: ref.kind,
    });
  }

  #withConfigTiming<T>(
    ref: ExecutionContextRef,
    phase: RuntimeConfigTimingContext["phase"],
    operation: () => T,
    newTrace = false,
  ): T {
    return withRuntimeConfigTimingContext(
      {
        agentId: ref.agentId,
        contextKey: encodeExecutionContextRef(ref),
        contextKind: ref.kind,
        phase,
      },
      operation,
      newTrace,
    );
  }
}

const elapsedMs = (startedAt: number): number => Date.now() - startedAt;

const sameRegistration = <TRuntimeSettings>(
  existing: Readonly<Ghost<TRuntimeSettings>>,
  expected: Readonly<Ghost<TRuntimeSettings>>,
): boolean => {
  // permissionReview is TeamHub's deployment fact, not part of a registration.
  const {
    actorId: _existingActorId,
    permissionReview: _existingPermissionReview,
    ...existingRegistration
  } = existing;
  const {
    actorId: _expectedActorId,
    permissionReview: _expectedPermissionReview,
    ...expectedRegistration
  } = expected;
  return isDeepStrictEqual(existingRegistration, expectedRegistration);
};

const unknownErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const identityResolutionFailureKind = (
  error: unknown,
): AgentIdentityResolutionErrorKind =>
  error instanceof AgentIdentityResolutionError ? error.kind : "permanent";

const invokeClose = (operation: () => void | Promise<void>): Promise<void> => {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
};
