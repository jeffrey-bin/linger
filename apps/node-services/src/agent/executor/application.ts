import {
  type AgentResourcesResolver,
  type McpContextResolver,
  TeamHubMcpContextResolverError,
} from "./teamhub-context-resolvers.js";
import type { OpaqueObject } from "@linger/wire-contracts/runner-gateway/types";
import {
  unavailableRuntimeHistory,
  type RuntimeHistoryPage,
} from "./history.js";
import {
  createBuiltinAgentFeatures,
  type BuiltinFeatureServices,
} from "../agent-features/builtin.js";
import type { AgentContextHost } from "./workspace.js";
import {
  createContextRuntimeActivator,
  type ContextViewSessions,
} from "./activation.js";
import {
  createLocalContextRuntimeBackend,
  type LocalContextRuntimeGateway,
} from "./local-backend.js";
import {
  encodeExecutionContextRef,
  type ExecutionContextRef,
  decodeExecutionContextKey,
  type ExecutionContextStore,
} from "./context-ref.js";
import { createAgentLogger } from "../observability/agent-log.js";
import { AgentRunnerDesiredStateError } from "../runner-gateway/agent-runner-desired-state.js";
import {
  LocalComputerOfflineError,
  isLocalComputerOfflineError,
} from "../runner-gateway/local-computer-management.js";
import type { LocalMcpRelayRegistrar } from "../runner-gateway/local-mcp-relay.js";
import { mapLocalRuntimeHistory } from "../runner-gateway/local-runtime-history.js";
import {
  RunnerGatewayError,
  RunnerGatewayProtocolError,
  RunnerOperationError,
} from "../runner-gateway/runner-operation.js";
import {
  parseRuntimeSettings,
  type LocalRuntimeSettings,
} from "../runtime-settings.js";
import type { RuntimeStatusPublisher } from "./runtime-status.js";
import type {
  ContextRuntimeStateFactory,
  RuntimeHistoryInspectionRequest,
} from "./context-executor.js";
import {
  createAgentMemoryServices,
  createMemoryClient,
  type AgentMemoryMaintenance,
} from "../agent-features/agent-memory/index.js";
import { createUserMemoryTracker } from "../agent-features/user-memory/index.js";
import type { Flashback } from "../../flashback.js";
import type { FlashbackSettings } from "../agent-features/flashback/index.js";
import { RunWakeDispatcher } from "../agent-features/inbox-source/index.js";
import {
  createTeamHubContextRuntimeState,
  readRuntimeSessionCheckpoint,
} from "./context-runtime-state.js";
import { TeamHubExecutionContextStore } from "./context-store.js";
import { createTeamHubGhostStore } from "./ghost-store.js";
import {
  TeamHubRuntimeStateError,
  type TeamHubRuntimeStateClient,
} from "./teamhub-runtime-state-client.js";
import { ProviderSessionInspectionError } from "./provider.js";
import {
  type AgentManager as AgentManagerContract,
  AgentManagerError,
} from "./agent-manager-api.js";
import type { AgentIdentityResolver } from "./types.js";
import type { GhostStore } from "./ghost.js";
import { ExecutorRegistry } from "./registry.js";
import { restoreRecentlyUsedContexts } from "./restart-restore.js";

/**
 * Reads the persisted native History of a Local placement without a live
 * Context View, through the Runner Gateway when it supports detached reads.
 */
export function createPersistedHistoryInspector(
  gateway?: Pick<LocalContextRuntimeGateway, "inspectDetachedLocalHistory">,
): (
  request: RuntimeHistoryInspectionRequest<LocalRuntimeSettings>,
) => Promise<RuntimeHistoryPage> {
  const inspectDetachedLocalHistory =
    gateway?.inspectDetachedLocalHistory?.bind(gateway);
  const inspectLocalHistory = inspectDetachedLocalHistory
    ? createDetachedLocalHistoryInspector(inspectDetachedLocalHistory)
    : undefined;
  return (request) => {
    if (request.options.signal?.aborted)
      return Promise.reject(request.options.signal.reason);
    if (inspectLocalHistory) return inspectLocalHistory(request);
    return Promise.resolve(
      unavailableRuntimeHistory(
        request.runtime.placement.runtimeType,
        "Detached Local Runtime history inspection is unsupported",
        "unsupported",
      ),
    );
  };
}

// Local placements read persisted native History through the Runner Gateway
// without a live Context View; the registry dispatches by Runtime type.
const createDetachedLocalHistoryInspector = (
  inspectDetachedLocalHistory: NonNullable<
    LocalContextRuntimeGateway["inspectDetachedLocalHistory"]
  >,
): ((
  request: RuntimeHistoryInspectionRequest<LocalRuntimeSettings>,
) => Promise<RuntimeHistoryPage>) => {
  return async (request) => {
    const contextKey = encodeExecutionContextRef(request.ref);
    const providerKind = request.runtime.placement.runtimeType;
    const unavailable = (reason: string): RuntimeHistoryPage =>
      unavailableRuntimeHistory(providerKind, reason);
    let result: Awaited<ReturnType<typeof inspectDetachedLocalHistory>>;
    try {
      result = await inspectDetachedLocalHistory({
        placement: request.runtime.placement,
        agentId: request.ref.agentId,
        executionContextKey: contextKey,
        runtimeInstanceId: contextKey,
        request: {
          runtime: {
            type: request.runtime.placement.runtimeType,
            ...(request.runtime.model ? { model: request.runtime.model } : {}),
            ...(request.runtime.reasoningEffort
              ? { reasoning_effort: request.runtime.reasoningEffort }
              : {}),
          },
          session: request.session as OpaqueObject,
          ...(request.options.cursor ? { cursor: request.options.cursor } : {}),
          ...(request.options.limit ? { limit: request.options.limit } : {}),
        },
        signal: request.options.signal,
      });
    } catch (error) {
      // Offline, not yet reconciled, a Computer without detached_history, or an
      // Agent Runner this Agent Service has not made ready: History is
      // unavailable, not a failed request. Protocol and programming errors
      // still propagate.
      if (
        error instanceof LocalComputerOfflineError ||
        error instanceof AgentRunnerDesiredStateError ||
        (error instanceof RunnerGatewayError &&
          !(error instanceof RunnerGatewayProtocolError))
      ) {
        return unavailable(error.message);
      }
      throw error;
    }
    return mapLocalRuntimeHistory(result);
  };
};

export const supportsRoomContextPreparation = (
  runtime: Readonly<LocalRuntimeSettings>,
  gateway?: Pick<LocalContextRuntimeGateway, "supportsDurableCodexSession">,
): boolean =>
  runtime.placement.runtimeType === "codex" &&
  gateway?.supportsDurableCodexSession?.(runtime.placement.computerId) === true;

/** True only while the Local Computer's runner can execute right now; never wakes it. */
export const isLocalRuntimeExecutionReady = (
  runtime: Readonly<LocalRuntimeSettings>,
  gateway?: Pick<
    NonNullable<AgentManagerApplicationOptions["runnerGateway"]>,
    "isLocalComputerExecutionReady"
  >,
): boolean =>
  gateway?.isLocalComputerExecutionReady(runtime.placement.computerId) === true;

/**
 * Whether a presence hint may activate this Context without input now. Only
 * Meta Contexts qualify, and the Local Computer must be execution ready, so an
 * offline or sleeping Computer is never woken for a hint. Activation never
 * starts a Provider: every Runtime defers its session to the first run.start.
 */
export const allowsPresencePreparation = (
  target: {
    readonly ref: Readonly<ExecutionContextRef>;
    readonly runtime: Readonly<LocalRuntimeSettings>;
  },
  gateway?: Pick<
    NonNullable<AgentManagerApplicationOptions["runnerGateway"]>,
    "isLocalComputerExecutionReady"
  >,
): boolean =>
  target.ref.kind === "meta" &&
  isLocalRuntimeExecutionReady(target.runtime, gateway);

export type AgentManagerApplicationStateBackend =
  | {
      readonly kind: "teamhub";
      readonly client: TeamHubRuntimeStateClient;
    }
  | {
      readonly kind: "test";
      readonly ghostStore: GhostStore<LocalRuntimeSettings>;
      readonly contextStore: ExecutionContextStore;
      readonly runtimeStateFactory: ContextRuntimeStateFactory<LocalRuntimeSettings>;
    };

export interface AgentManagerApplicationOptions {
  readonly identityResolver: AgentIdentityResolver;
  readonly stateBackend: AgentManagerApplicationStateBackend;
  readonly contextHost: AgentContextHost;
  readonly runnerGateway?: LocalContextRuntimeGateway & {
    readonly isLocalComputerExecutionReady: (computerId: string) => boolean;
    readonly canReadDetachedHistory?: (
      computerId: string,
      runtimeType: "codex" | "claude" | "pi",
    ) => boolean;
    readonly supportsSessionCompaction?: (
      computerId: string,
      runtimeType: "codex" | "claude" | "pi",
    ) => boolean;
    readonly subscribeLocalComputerReady?: (
      listener: (computerId: string) => void,
    ) => () => void;
  };
  readonly contextViewSessions: ContextViewSessions;
  readonly teamhubFiles?: import("./local-backend.js").TeamHubCliConfigurationSource;
  readonly localMcpRelay?: LocalMcpRelayRegistrar;
  readonly mcpContextResolver?: McpContextResolver;
  readonly agentResourcesResolver?: AgentResourcesResolver;
  readonly runtimeStatusPublisher?: RuntimeStatusPublisher;
  /** Another Me flashback in this process + settings; off when absent. */
  readonly flashback?: {
    readonly client: Flashback;
    readonly settings?: FlashbackSettings;
  };
  /** Another Me proactive review; off when absent. */
  readonly proactive?: BuiltinFeatureServices["proactive"];
  /** Meta Task progress reminders; off when absent. */
  readonly taskProgress?: BuiltinFeatureServices["taskProgress"];
  /** Another Me reply rhythm; off when absent. */
  readonly replyRhythm?: BuiltinFeatureServices["replyRhythm"];
  /** Agent Memory maintenance through stateless model calls; off when absent. */
  readonly agentMemoryMaintenance?: AgentMemoryMaintenance;
}

export interface ContextAgentManagerApplication {
  readonly agentManager: AgentManagerContract<LocalRuntimeSettings>;
  /** Routes TeamHub's queued-input hints; present with TeamHub state. */
  readonly runWakes?: RunWakeDispatcher;
  closeRuntimeHosts(): Promise<void>;
  refreshRuntimeState(): Promise<void>;
  /**
   * Applies a Context change hint: a held Context refreshes; an unheld one
   * binds only when it is a Room Meta Context that never ran.
   */
  refreshRuntimeContext(
    contextKey: string,
    stateRevision?: string,
  ): Promise<boolean>;
  /** Queues a best-effort presence activation; never waits for it. */
  prepareRuntimeContextForPresence(contextKey: string): void;
  /** Activates recently used Contexts after restart; resolves when no more work is pending. */
  restoreRecentlyUsedRuntimeContexts(signal: AbortSignal): Promise<void>;
  startRuntimeState(signal?: AbortSignal): Promise<void>;
}

const RUNTIME_PROCESS_IDENTITY_UNAVAILABLE =
  "Unable to establish Runtime process identity";

export const isRuntimeProcessIdentityUnavailable = (error: unknown): boolean =>
  error instanceof Error &&
  !(
    error instanceof RunnerOperationError &&
    error.code === "CONTEXT_RECOVERY_REQUIRED"
  ) &&
  error.message === RUNTIME_PROCESS_IDENTITY_UNAVAILABLE;

const isTransientMcpContextResolverFailure = (error: unknown): boolean =>
  (error instanceof TeamHubMcpContextResolverError &&
    (error.code === "resolver_unavailable" ||
      (error.upstream?.status === 409 &&
        error.code === "context_identity_invalid"))) ||
  (error instanceof AggregateError &&
    error.errors.some(isTransientMcpContextResolverFailure));

export const isRecoverableLocalContextRestoreFailure = (
  error: unknown,
): boolean => {
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 &&
      error.errors.every(isRecoverableLocalContextRestoreFailure)
    );
  }
  if (
    error instanceof LocalComputerOfflineError ||
    isRuntimeProcessIdentityUnavailable(error) ||
    isTransientMcpContextResolverFailure(error) ||
    (error instanceof TeamHubRuntimeStateError && error.retryable) ||
    (error instanceof TeamHubRuntimeStateError &&
      error.status === 404 &&
      error.code === "NOT_FOUND") ||
    (error instanceof TeamHubRuntimeStateError &&
      error.status === 409 &&
      error.code === "AGENT_RUNTIME_CONFLICT") ||
    (error instanceof RunnerOperationError &&
      (error.code === "stale_connection_epoch" ||
        (error.code === "CONTEXT_VIEW_FAILED" && error.retryable)))
  ) {
    return true;
  }
  return false;
};

export const isRecoverableContextRestoreFailure = (input: {
  readonly error: unknown;
}): boolean =>
  isRecoverableIdentityRestoreFailure(input.error) ||
  isRecoverableLocalContextRestoreFailure(input.error);

export const shouldSuspendContextRestoreFailure = (input: {
  readonly error: unknown;
}): boolean => {
  if (
    input.error instanceof RunnerOperationError &&
    input.error.code === "CONTEXT_VIEW_FAILED" &&
    !input.error.retryable
  ) {
    return true;
  }
  if (
    input.error instanceof TeamHubMcpContextResolverError &&
    input.error.code === "context_identity_invalid" &&
    input.error.upstream?.status !== 409
  ) {
    return true;
  }
  return (
    input.error instanceof AggregateError &&
    input.error.errors.some((error) =>
      shouldSuspendContextRestoreFailure({ error }),
    )
  );
};

// Offline is a wait for a Computer, not a failed Provider retry budget.
// Keep the active intent so ready events and restart recovery can resume pending work.
export const resolveContextRestoreMaxRetryAttempts = (input: {
  readonly error: unknown;
}): number | undefined =>
  isTransientMcpContextResolverFailure(input.error) ? 6 : undefined;

const RECOVERABLE_RESTORE_IDENTITY_CODES = new Set([
  "identity_unavailable",
  "identity_resolution_failed",
]);

export const isRecoverableIdentityRestoreFailure = (
  error: unknown,
): boolean => {
  if (
    error instanceof AgentManagerError &&
    RECOVERABLE_RESTORE_IDENTITY_CODES.has(error.code)
  ) {
    return true;
  }
  return (
    error instanceof AggregateError &&
    error.errors.length > 0 &&
    error.errors.every(isRecoverableIdentityRestoreFailure)
  );
};

const MAX_RESTORE_RETRY_DELAY_MS = 300_000;
const LOCAL_OFFLINE_RESTORE_RETRY_BASE_DELAY_MS = 30_000;

export const resolveContextRestoreRetryDelayMs = (input: {
  readonly error: unknown;
  readonly ref: Readonly<ExecutionContextRef>;
  readonly retryAttempt?: number;
}): number => {
  if (
    input.error instanceof AgentManagerError &&
    input.error.code === "agent_activation_pending"
  )
    return 1_000;
  const retryAttempt = Math.max(1, input.retryAttempt ?? 1);
  const multiplier = 2 ** Math.min(retryAttempt - 1, 5);
  if (isLocalComputerOfflineError(input.error)) {
    return Math.min(
      MAX_RESTORE_RETRY_DELAY_MS,
      LOCAL_OFFLINE_RESTORE_RETRY_BASE_DELAY_MS * multiplier,
    );
  }
  return 1_000 * multiplier;
};

export const createAgentManagerApplication = (
  options: AgentManagerApplicationOptions,
): ContextAgentManagerApplication => {
  const stateBackend = options.stateBackend;
  const runtimeStateContextStore =
    stateBackend.kind === "teamhub"
      ? new TeamHubExecutionContextStore({
          client: stateBackend.client,
        })
      : undefined;
  // Binds a Context; the store publishes the record, and the bound Context
  // then takes up its wake.
  const bindRuntimeContext = async (
    contextKey: string,
    mode: "work" | "changed",
    stateRevision?: string,
  ): Promise<boolean> => {
    const record = await runtimeStateContextStore?.claimByKey(
      contextKey,
      mode === "changed",
      mode,
      stateRevision,
    );
    if (!record) return false;
    agentManager.scheduleContextPreparation(record.ref);
    return true;
  };
  const refreshRuntimeContext = (contextKey: string, stateRevision?: string) =>
    bindRuntimeContext(contextKey, "changed", stateRevision);
  const runWakes =
    stateBackend.kind === "teamhub"
      ? new RunWakeDispatcher({
          claimContext: (contextKey) => bindRuntimeContext(contextKey, "work"),
          listWaitingContexts: (signal) =>
            stateBackend.client.listWaitingContexts(signal),
          logger: createAgentLogger({ component: "run-wake" }),
        })
      : undefined;
  const runtimeStateFactory: ContextRuntimeStateFactory<LocalRuntimeSettings> =
    stateBackend.kind === "teamhub"
      ? async (
          input: Parameters<
            ContextRuntimeStateFactory<LocalRuntimeSettings>
          >[0],
        ) =>
          createTeamHubContextRuntimeState({
            client: stateBackend.client,
            ref: input.ref,
            configurationRevision: input.configurationRevision,
            providerKind: input.runtime.type,
            // The acceptance already returned the state it committed.
            onInputCommitted: (state) =>
              runtimeStateContextStore!.observeCommittedState(input.ref, state),
            trackOwnRevisionAdvance: () =>
              runtimeStateContextStore!.trackOwnRevisionAdvance(input.ref),
          })
      : stateBackend.runtimeStateFactory;
  const memoryClient =
    stateBackend.kind === "teamhub" && options.teamhubFiles
      ? createMemoryClient(options.teamhubFiles)
      : undefined;
  // Shared maintenance Coordinator + activation projection, created once for
  // the process; the host (the registry) binds at start() below.
  const agentMemoryServices =
    memoryClient && stateBackend.kind === "teamhub"
      ? createAgentMemoryServices({
          memory: memoryClient,
          contextHost: options.contextHost,
          runtimeState: stateBackend.client,
          logger: createAgentLogger({ component: "agent-memory" }),
          ...(options.agentMemoryMaintenance
            ? { maintenance: options.agentMemoryMaintenance }
            : {}),
          ...(options.runnerGateway?.canReadDetachedHistory
            ? {
                canReadHistory: (computerId, runtimeType) =>
                  options.runnerGateway!.canReadDetachedHistory!(
                    computerId,
                    runtimeType,
                  ),
              }
            : {}),
        })
      : undefined;
  const userMemories = createUserMemoryTracker();
  // One explicit builtin assembly for the whole process: shared clients,
  // Coordinators, and budgets are bound here, never per Context.
  const features = createBuiltinAgentFeatures({
    services: {
      logger: createAgentLogger({ component: "agent-features" }),
      ...(runWakes ? { runWakes } : {}),
      ...(options.flashback ? { flashback: options.flashback } : {}),
      ...(options.proactive ? { proactive: options.proactive } : {}),
      ...(options.taskProgress ? { taskProgress: options.taskProgress } : {}),
      ...(options.replyRhythm ? { replyRhythm: options.replyRhythm } : {}),
      ...(agentMemoryServices
        ? { agentMemory: agentMemoryServices.featureDeps }
        : {}),
      // Compaction drops detail from the native context; only a deployment
      // that keeps extracting memory may compact.
      ...(agentMemoryServices && options.agentMemoryMaintenance
        ? { contextRestart: {} }
        : {}),
      userMemories,
      resolveUserMemory: async (agentId) =>
        (await options.identityResolver.resolveIdentity(agentId))
          .representedHuman?.memory,
    },
  });
  const contextViewContent = options.runnerGateway?.contextViewContent;
  const localBackend =
    options.runnerGateway && contextViewContent && options.localMcpRelay
      ? createLocalContextRuntimeBackend({
          gateway: options.runnerGateway,
          contextViewContent,
          mcpRelay: options.localMcpRelay,
          teamhubFiles: options.teamhubFiles,
        })
      : undefined;
  const runtimeActivator = createContextRuntimeActivator<LocalRuntimeSettings>({
    contextHost: options.contextHost,
    features,
    viewSessions: options.contextViewSessions,
    resolveBackend() {
      if (localBackend) return localBackend;
      throw new Error("Local Context Runtime services are unavailable");
    },
    ...(options.mcpContextResolver
      ? { mcpContextResolver: options.mcpContextResolver }
      : {}),
    agentResourcesResolver: options.agentResourcesResolver,
    logger: createAgentLogger({ component: "context-runtime" }),
  });
  const inspectHistory = createPersistedHistoryInspector(options.runnerGateway);
  const ghostStore =
    stateBackend.kind === "teamhub"
      ? createTeamHubGhostStore({
          client: stateBackend.client,
          listAgentIds: async () =>
            (await runtimeStateContextStore!.list()).map(
              (context) => context.ref.agentId,
            ),
          parseRuntime: parseRuntimeSettings,
        })
      : stateBackend.ghostStore;
  const contextStore =
    stateBackend.kind === "teamhub"
      ? runtimeStateContextStore!
      : stateBackend.contextStore;

  const agentManager = new ExecutorRegistry<LocalRuntimeSettings>({
    features,
    identityResolver: options.identityResolver,
    ghostStore,
    contextStore,
    ...(stateBackend.kind === "teamhub"
      ? {
          inspectDetachedHistory: async ({ ref, runtime, options }) => {
            const result = await stateBackend.client.getSession(
              encodeExecutionContextRef(ref),
              options.signal,
            );
            const nativeSession =
              result.available && result.session
                ? readRuntimeSessionCheckpoint(result.session).nativeSession
                : null;
            if (!nativeSession) {
              return unavailableRuntimeHistory(
                runtime.placement.runtimeType,
                "Runtime session is unavailable",
              );
            }
            try {
              return await inspectHistory({
                ref,
                runtime,
                session: nativeSession,
                options,
              });
            } catch (error) {
              if (options.signal?.aborted) throw error;
              if (error instanceof ProviderSessionInspectionError) {
                return unavailableRuntimeHistory(
                  runtime.placement.runtimeType,
                  error.message,
                  error.status,
                );
              }
              throw error;
            }
          },
        }
      : {}),
    restoreRecovery: {
      isRecoverable: isRecoverableContextRestoreFailure,
      shouldSuspend: shouldSuspendContextRestoreFailure,
      maxRetryAttempts: resolveContextRestoreMaxRetryAttempts,
      retryDelayMs: resolveContextRestoreRetryDelayMs,
    },
    shouldActivateOnRestore: async ({ ref }) =>
      stateBackend.kind === "teamhub"
        ? (
            await stateBackend.client.getWorkState(
              encodeExecutionContextRef(ref),
            )
          ).has_pending_work
        : true,
    restoreConcurrency: 2,
    parseRuntime: parseRuntimeSettings,
    executorServices: {
      activator: runtimeActivator,
      stateFactory: runtimeStateFactory,
      ...(options.runtimeStatusPublisher
        ? { statusPublisher: options.runtimeStatusPublisher }
        : {}),
      inspectPersistedHistory: inspectHistory,
    },
    // Maintenance wakes a suspended Context only on a ready Computer whose
    // Runtime can compact its native session right now.
    ...(options.runnerGateway?.supportsSessionCompaction
      ? {
          canRunMaintenance: (runtime: Readonly<LocalRuntimeSettings>) =>
            options.runnerGateway!.supportsSessionCompaction!(
              runtime.placement.computerId,
              runtime.placement.runtimeType,
            ),
        }
      : {}),
    // New Room preparation retains a fully authorized Runtime. Unused prepared
    // Contexts use the Manager's bounded idle policy.
    presencePreparation: {
      allows: (target) =>
        allowsPresencePreparation(target, options.runnerGateway),
    },
    shouldPrepareContext: ({ ref, runtime }) =>
      ref.kind === "meta" &&
      runtimeStateContextStore?.isUnusedContext(ref) === true &&
      supportsRoomContextPreparation(runtime, options.runnerGateway),
  });
  // Bind the late host and start shared Memory maintenance. Before this call
  // the featureDeps wake closure fails loudly; after close() it resolves
  // quietly, so a Context terminal during shutdown never observes a TDZ.
  agentMemoryServices?.start(agentManager);
  let unsubscribeLocalComputerReady =
    options.runnerGateway?.subscribeLocalComputerReady?.((computerId) => {
      agentManager.wakeDeferredContextRestores(
        ({ runtime }) => runtime.placement.computerId === computerId,
      );
    });
  runWakes?.start();
  return {
    agentManager,
    closeRuntimeHosts: async () => {
      runWakes?.close();
      // Shared Memory maintenance drains in-flight work before the runtime
      // lifecycle bindings come down; a terminal forwarded during close still
      // resolves through the stopped-wake semantics.
      await agentMemoryServices?.close();
      unsubscribeLocalComputerReady?.();
      unsubscribeLocalComputerReady = undefined;
    },
    refreshRuntimeContext,
    prepareRuntimeContextForPresence: (contextKey) => {
      const store = runtimeStateContextStore;
      if (!store) return;
      agentManager.prepareContextForPresence(
        decodeExecutionContextKey(contextKey),
        () => store.claimByKey(contextKey, true, "ensure"),
      );
    },
    restoreRecentlyUsedRuntimeContexts: (signal) => {
      const store = runtimeStateContextStore;
      if (!store || stateBackend.kind !== "teamhub") return Promise.resolve();
      const client = stateBackend.client;
      const gateway = options.runnerGateway;
      return restoreRecentlyUsedContexts({
        listRecentlyUsed: (signal) => client.listRecentlyUsedContexts(signal),
        restore: (ref) =>
          agentManager.restoreContextAfterRestart(
            ref,
            () =>
              store.claimByKey(encodeExecutionContextRef(ref), true, "ensure"),
            (runtime) => isLocalRuntimeExecutionReady(runtime, gateway),
          ),
        admit: async (ref) => {
          const runtime = (await ghostStore.get(ref.agentId))?.runtime;
          if (!runtime || !gateway) return { status: "ineligible" };
          return isLocalRuntimeExecutionReady(runtime, gateway)
            ? { status: "eligible" }
            : { status: "offline", computerId: runtime.placement.computerId };
        },
        isRecoverableFailure: (error) =>
          isRecoverableContextRestoreFailure({ error }),
        subscribeLocalComputerReady: (listener) =>
          gateway?.subscribeLocalComputerReady?.(listener) ?? (() => {}),
        logger: createAgentLogger({ component: "agent-manager" }),
        signal,
      });
    },
    refreshRuntimeState: async () => {
      if (!runtimeStateContextStore) return;
      await runtimeStateContextStore.refreshAvailableContexts();
      const records = await runtimeStateContextStore.list();
      for (const record of records) {
        agentManager.scheduleContextPreparation(record.ref);
      }
    },
    startRuntimeState: async (signal) => {
      const startup = await runtimeStateContextStore?.start(signal);
      if (!startup) return;
      createAgentLogger({ component: "runtime-state" }).log(
        "info",
        "contexts.reconciled",
        { ...startup.reconciliation },
      );
      // Queued work of the previous epoch is taken up like a fresh hint.
      for (const contextKey of startup.waitingContextKeys)
        runWakes?.wake(contextKey, "queued");
    },
    ...(runWakes ? { runWakes } : {}),
  };
};
