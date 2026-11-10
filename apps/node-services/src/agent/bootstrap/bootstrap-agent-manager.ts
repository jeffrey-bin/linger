import type { Flashback } from "../../flashback.js";
import {
  createTeamHubAgentResourcesResolver,
  createTeamHubMcpContextResolverClient,
  type TeamHubMcpContextResolverOptions,
} from "../executor/teamhub-context-resolvers.js";
import { performance } from "node:perf_hooks";
import {
  createTeamHubProactiveClient,
  eventDecideInstructions,
} from "../agent-features/proactive/index.js";
import { createTeamHubAgentWakeStream } from "../agent-features/inbox-source/teamhub-agent-wake-stream.js";
import { createTeamHubTaskProgressClient } from "../agent-features/task-progress/index.js";
import {
  closeAgentManagerResources,
  type ShutdownProgress,
} from "./agent-manager-shutdown.js";
import {
  isRecoverableBindingRestoreFailure,
  restorePersistedBindings,
} from "./binding-restore.js";
import { createRuntimeContextRefresh } from "./runtime-context-refresh.js";
export { isRecoverableBindingRestoreFailure, restorePersistedBindings };

import { createAgentContextHost } from "../executor/workspace.js";
import type {
  AgentDebugInspectionApi,
  AgentManager,
  AgentManagerApi,
} from "../executor/agent-manager-api.js";
import { createAgentIdentityHttpResolver } from "../executor/http/agent-identity-http-resolver.js";
import {
  createAgentManagerHttpServer,
  type AgentManagerHttpServerAddress,
  type AgentManagerOperationalReadiness,
} from "../executor/http/agent-manager-http-server.js";
import type { HttpHost } from "../../http-host.js";
import { createAgentManagerApplication } from "../executor/application.js";
import type { AgentIdentityResolver } from "../executor/types.js";
import { createContextViewSessions } from "../executor/activation.js";
import { createAgentLogger } from "../observability/agent-log.js";
import { LocalMcpRelay } from "../runner-gateway/local-mcp-relay.js";
import type { RunnerCredentialAuthenticator } from "../runner-gateway/runner-credential-authority.js";
import type { RunnerGateway } from "../runner-gateway/runner-gateway.js";
import type { LocalRuntimeSettings } from "../runtime-settings.js";
import {
  createTeamHubRuntimeStateClient,
  type TeamHubRuntimeStateClient,
} from "../executor/teamhub-runtime-state-client.js";
import { createRuntimeStatusPublisher } from "../executor/runtime-status.js";
import type { RuntimeModelCall } from "../../runtime-model-call.js";
import {
  createTaskWorker,
  createTeamHubTaskWorkerClient,
} from "../task-manager/index.js";

export interface BootstrapAgentManagerOptions {
  signal?: AbortSignal;
  runGracePeriodMs?: number;
  shutdownProgress?: ShutdownProgress;
  /** Per-Agent roots shared with Memory's projections (`contextHostRoot`). */
  contextHostRoot: string;
  roomBaseUrl: string;
  /** Presented to TeamHub on teamhub-internal calls. */
  serviceToken: string;
  /** Accepted from TeamHub on this role's node-services-internal routes. */
  inboundServiceToken: string;
  roomRequestTimeoutMs?: number;
  /** The process listener shared with the other roles. */
  httpHost?: HttpHost;
  host?: string;
  port?: number;
  identityResolver?: AgentIdentityResolver;
  runnerCredentialAuthority?: RunnerCredentialAuthenticator;
  runnerGateway?: RunnerGateway;
  localContextRuntime?: {
    readonly publicOrigin: string;
  };
  mcpContextFetch?: TeamHubMcpContextResolverOptions["fetch"];
  runtimeStateClient?: TeamHubRuntimeStateClient;
  operationalReadiness?: () =>
    | AgentManagerOperationalReadiness
    | Promise<AgentManagerOperationalReadiness>;
  /** Memory's flashback in this process for Another Me; off when absent. */
  flashback?: Flashback;
  /**
   * Stateless model calls on Local Computer Runtimes: Agent Memory
   * maintenance and TeamHub's /v1/model-calls. Both are off when absent.
   * Shutdown closes it and drops its unfinished calls; their callers ask
   * again.
   */
  modelCall?: RuntimeModelCall;
}

export interface AgentManagerApplication {
  agentManager: AgentManager<LocalRuntimeSettings>;
  address: AgentManagerHttpServerAddress;
  close(): Promise<void>;
}

export const bootstrapAgentManager = async (
  options: BootstrapAgentManagerOptions,
): Promise<AgentManagerApplication> => {
  const bootstrapStartedAt = performance.now();
  assertRunnerGatewayConfiguration(options);
  const contextHost = await createAgentContextHost({
    rootPath: options.contextHostRoot,
  });
  const runtimeStateClient =
    options.runtimeStateClient ??
    createTeamHubRuntimeStateClient({
      baseUrl: options.roomBaseUrl,
      serviceToken: options.serviceToken,
      ...(options.roomRequestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.roomRequestTimeoutMs }),
    });
  const runtimeStatusPublisher = createRuntimeStatusPublisher({
    client: runtimeStateClient,
    logger: createAgentLogger({ component: "runtime-status" }),
  });
  const mcpContextClientOptions = {
    baseUrl: options.roomBaseUrl,
    serviceToken: options.serviceToken,
    ...(options.mcpContextFetch === undefined
      ? {}
      : { fetch: options.mcpContextFetch }),
    ...(options.roomRequestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.roomRequestTimeoutMs }),
  };
  const mcpContextResolver = createTeamHubMcpContextResolverClient(
    mcpContextClientOptions,
  );
  const contextViewSessions = createContextViewSessions();
  const localMcpRelay =
    options.runnerGateway && options.localContextRuntime
      ? new LocalMcpRelay({
          publicOrigin: options.localContextRuntime.publicOrigin,
          authorizer: options.runnerGateway,
        })
      : undefined;
  const application = createAgentManagerApplication({
    // Reply rhythm sends through TeamHub's message sequences.
    replyRhythm: {},
    proactive: {
      client: createTeamHubProactiveClient({
        baseUrl: options.roomBaseUrl,
        serviceToken: options.serviceToken,
      }),
    },
    taskProgress: {
      client: createTeamHubTaskProgressClient({
        baseUrl: options.roomBaseUrl,
        serviceToken: options.serviceToken,
      }),
    },
    // Per-Context recall state lives inside the feature session.
    ...(options.flashback ? { flashback: { client: options.flashback } } : {}),
    ...(options.modelCall
      ? { agentMemoryMaintenance: { modelCall: options.modelCall } }
      : {}),
    identityResolver:
      options.identityResolver ??
      createAgentIdentityHttpResolver({
        baseUrl: options.roomBaseUrl,
        serviceToken: options.serviceToken,
        requestTimeoutMs: options.roomRequestTimeoutMs,
      }),
    stateBackend: { kind: "teamhub", client: runtimeStateClient },
    contextHost,
    runnerGateway: options.runnerGateway,
    contextViewSessions,
    localMcpRelay,
    teamhubFiles: {
      baseUrl: options.roomBaseUrl,
      serviceToken: options.serviceToken,
    },
    mcpContextResolver,
    agentResourcesResolver: createTeamHubAgentResourcesResolver(
      mcpContextClientOptions,
    ),
    runtimeStatusPublisher,
  });
  const { agentManager } = application;
  const refreshRuntimeContexts = () => application.refreshRuntimeState();
  const runtimeContextRefresh = createRuntimeContextRefresh(
    refreshRuntimeContexts,
  );
  const taskWorker = createTaskWorker({
    agentManager,
    client: createTeamHubTaskWorkerClient({
      baseUrl: options.roomBaseUrl,
      serviceToken: options.serviceToken,
      ...(options.roomRequestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.roomRequestTimeoutMs }),
    }),
    logger: createAgentLogger({ component: "task-worker" }),
  });
  const runWakes = application.runWakes;
  const wakeStream = runWakes
    ? createTeamHubAgentWakeStream({
        baseUrl: options.roomBaseUrl,
        serviceToken: options.serviceToken,
        onRunWake: (contextKey, kind) => runWakes.wake(contextKey, kind),
        onContextChanged: async (contextKey, stateRevision) => {
          await application.refreshRuntimeContext(contextKey, stateRevision);
        },
        onContextPrepare: (contextKey) =>
          application.prepareRuntimeContextForPresence(contextKey),
        onTaskClaimable: () => taskWorker.wake(),
        onReconcile: async () => {
          // Hints may have been lost while the stream was away.
          taskWorker.wake();
          runtimeContextRefresh.request();
          await runWakes.scanNow();
        },
      })
    : undefined;
  const httpApi: AgentManagerApi<LocalRuntimeSettings> &
    AgentDebugInspectionApi = {
    getGhost: (agentId) => agentManager.getGhost(agentId),
    refreshAgent: (agentId) => agentManager.refreshAgent(agentId),
    cancelLocalRun: (ref, runId) => agentManager.cancelLocalRun(ref, runId),
    deleteAgent: (agentId, deletionOptions) =>
      agentManager.deleteAgent(agentId, deletionOptions),
    inspectDebugContextHistory: (ref, signal) =>
      agentManager.inspectDebugContextHistory(ref, signal),
  };
  // Persisted Context restoration continues after the HTTP listener becomes
  // ready. Keep a lifecycle signal for the period after readiness too, so a
  // shutdown cancels its retry timer instead of reading a closed manager.
  const persistedBindingRestoration = new AbortController();
  let initialization: Promise<void> | undefined;
  const server = createAgentManagerHttpServer({
    api: httpApi,
    ...(options.modelCall ? { modelCall: options.modelCall } : {}),
    proactiveEvents: {
      judge: async (request) => ({
        instructions: eventDecideInstructions(request, new Date()),
      }),
    },
    ...(options.operationalReadiness
      ? { operationalReadiness: options.operationalReadiness }
      : {}),
    beforeReady: (_address, signal) =>
      (initialization = (async () => {
        const restoreLogger = createAgentLogger({
          component: "agent-manager",
        });
        signal.throwIfAborted();
        const phaseStartedAt = performance.now();
        await application.startRuntimeState(signal);
        // The epoch recorded every Computer offline; they may connect now.
        options.runnerGateway?.openConnections();
        const persistedRestoreSignal = AbortSignal.any([
          signal,
          persistedBindingRestoration.signal,
        ]);
        restoreLogger.log("info", "manager.startup_phase_completed", {
          phase: "start_runtime_state",
          elapsedMs: performance.now() - phaseStartedAt,
          bootstrapElapsedMs: performance.now() - bootstrapStartedAt,
        });
        signal.throwIfAborted();
        // Health and REST must come up even when persisted Contexts cannot be
        // restored yet. Local Computers, missing identities, and Codex process
        // identity failures retry in the background after the listener is Ready.
        void restorePersistedBindings(
          agentManager,
          persistedRestoreSignal,
          restoreLogger,
          {
            // Recently used Contexts are restored only after the first
            // restore attempt settles, so restored bindings keep priority.
            // Each Context's restore failure is logged by the restore itself;
            // the catch only keeps an unexpected rejection from crashing the
            // process.
            onFirstAttemptSettled: () => {
              void application
                .restoreRecentlyUsedRuntimeContexts(persistedRestoreSignal)
                .catch((error: unknown) => {
                  restoreLogger.log(
                    "error",
                    "manager.restart_restore_crashed",
                    {
                      error,
                    },
                  );
                });
            },
          },
        );
        taskWorker.start();
        wakeStream?.start();
        signal.throwIfAborted();
        restoreLogger.log("info", "manager.startup_phase_completed", {
          phase: "before_ready",
          bootstrapElapsedMs: performance.now() - bootstrapStartedAt,
        });
      })()),
    runnerCredentialAuthority: options.runnerCredentialAuthority,
    runnerGateway: options.runnerGateway,
    localMcpRelay,
    serviceToken: options.inboundServiceToken,
    ...(options.httpHost ? { httpHost: options.httpHost } : {}),
    host: options.host,
    port: options.port,
  });
  let closePromise: Promise<void> | undefined;
  const closeResources = (): Promise<void> => {
    persistedBindingRestoration.abort();
    return (closePromise ??= closeAgentManagerResources(
      {
        server,
        taskWorker,
        wakeStream: {
          async close() {
            await Promise.all([
              runtimeContextRefresh.close(),
              wakeStream?.close(),
            ]);
          },
        },
        ...(runWakes ? { runWakes } : {}),
        ...(options.modelCall
          ? {
              modelCalls: { close: () => options.modelCall!.close() },
            }
          : {}),
        agentManager: {
          close: () =>
            agentManager.close({
              runGracePeriodMs: options.runGracePeriodMs,
            }),
        },
        runtimeHosts: {
          close: () => application.closeRuntimeHosts(),
        },
        runtimeStatusPublisher,
        contextViewSessions,
        localMcpRelay,
      },
      options.shutdownProgress,
    ));
  };
  const onAbort = (): void => {
    void server.drain();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // The Runner Gateway listener must exist before restored Local bindings
    // reconnect. Health and REST become Ready without waiting for Context
    // restoration so a blocked restore cannot keep the process unready.
    options.signal?.throwIfAborted();
    const address = await server.start();
    options.signal?.throwIfAborted();
    return {
      agentManager,
      address,
      close: () => {
        options.signal?.removeEventListener("abort", onAbort);
        return closeResources();
      },
    };
  } catch (error) {
    options.signal?.removeEventListener("abort", onAbort);
    // Startup operations may still be writing even after the listener aborts
    // its readiness wait. Let them settle before releasing the stores.
    await initialization?.catch(() => undefined);
    try {
      await closeResources();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Agent Manager startup and cleanup failed",
        { cause: closeError },
      );
    }
    throw error;
  }
};

const assertRunnerGatewayConfiguration = (
  options: Pick<
    BootstrapAgentManagerOptions,
    "runnerCredentialAuthority" | "runnerGateway"
  >,
): void => {
  if (options.runnerCredentialAuthority && !options.runnerGateway) {
    throw new TypeError(
      "Runner credential authority requires Runner Gateway to be enabled",
    );
  }
  if (options.runnerGateway && !options.runnerCredentialAuthority) {
    throw new TypeError("Runner Gateway requires a credential authority");
  }
};
