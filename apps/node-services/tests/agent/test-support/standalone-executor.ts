import { asError } from "@linger/service-kit";
import type { ComposedContextFeatures } from "../../../src/agent/agent-features/compose.js";
import type {
  ContextInstructionFacts,
  RunTerminalEvent,
} from "../../../src/agent/agent-features/contracts.js";
import { TOOL_APPROVAL_FEATURE_ID } from "../../../src/agent/agent-features/tool-approval/index.js";
import type { ContextRuntimeActivator } from "../../../src/agent/executor/activation.js";
import {
  ContextExecutor,
  type ContextRuntimeStateFactory,
  type ExecutorServices,
} from "../../../src/agent/executor/context-executor.js";
import type {
  ExecutionContextRef,
  SharedTaskScope,
} from "../../../src/agent/executor/context-ref.js";
import type { ExecutorHost } from "../../../src/agent/executor/executor-host.js";
import type { GhostResources } from "../../../src/agent/executor/ghost.js";
import type { RuntimeStatusPublisher } from "../../../src/agent/executor/runtime-status.js";
import type {
  AgentDefinition,
  AgentType,
} from "../../../src/agent/executor/types.js";
import type { AgentLogger } from "../../../src/agent/observability/agent-log.js";

/** The composed feature ports an executor's Runtime calls. */
export type ExecutorFeaturePorts = Pick<
  ComposedContextFeatures,
  | "prepareInput"
  | "onRunEvent"
  | "notificationContext"
  | "afterInboxInputAccepted"
>;

export interface StandaloneExecutorOptions<TRuntimeSettings> {
  readonly ref: ExecutionContextRef;
  readonly sharedTaskScope?: SharedTaskScope;
  readonly configurationRevision?: string;
  readonly actorId: string;
  readonly tenantId: string;
  readonly agentType?: AgentType;
  readonly permissionReview?: true;
  readonly agent: AgentDefinition;
  /** The context instructions feature's rendering; absent keeps `agent`. */
  readonly renderDeveloperInstructions?: (
    facts: ContextInstructionFacts,
  ) => string | undefined;
  readonly runtime: TRuntimeSettings;
  readonly resources: GhostResources;
  readonly features: ExecutorFeaturePorts;
  readonly onRunTerminal?: (signal: RunTerminalEvent) => void;
}

const silentLogger: AgentLogger = {
  log: () => undefined,
  child: () => silentLogger,
};

/**
 * A Context executor outside any registry: the host owns it and allows
 * everything, and the given ports stand in for the composed features. For
 * tests of the Runtime half of the executor.
 */
export async function createStandaloneExecutor<TRuntimeSettings>(input: {
  readonly activator: ContextRuntimeActivator<TRuntimeSettings>;
  readonly stateFactory: ContextRuntimeStateFactory<TRuntimeSettings>;
  readonly statusPublisher?: RuntimeStatusPublisher;
  readonly inspectPersistedHistory?: ExecutorServices<TRuntimeSettings>["inspectPersistedHistory"];
  readonly options: StandaloneExecutorOptions<TRuntimeSettings>;
}): Promise<ContextExecutor<TRuntimeSettings>> {
  const { options } = input;
  const composed: ComposedContextFeatures = {
    matched: options.permissionReview ? [TOOL_APPROVAL_FEATURE_ID] : [],
    contextInstructions: (facts) =>
      options.renderDeveloperInstructions?.(facts),
    notificationContext: (notification) =>
      options.features.notificationContext(notification),
    prepareInput: (message) => options.features.prepareInput(message),
    bindSources: async () => undefined,
    afterInboxInputAccepted: (fact) =>
      options.features.afterInboxInputAccepted(fact),
    onRunTerminal: (event) => options.onRunTerminal?.(event),
    onRunEvent: (event) => options.features.onRunEvent(event),
    decideMaintenance: () => null,
    onMaintenance: () => undefined,
    onTimer: () => undefined,
    release: async () => undefined,
  };
  const executor = new ContextExecutor<TRuntimeSettings>({
    host: standaloneHost<TRuntimeSettings>(),
    services: {
      activator: input.activator,
      stateFactory: input.stateFactory,
      ...(input.statusPublisher
        ? { statusPublisher: input.statusPublisher }
        : {}),
      ...(input.inspectPersistedHistory
        ? { inspectPersistedHistory: input.inspectPersistedHistory }
        : {}),
    },
    features: { composeContext: () => composed },
    record: {
      ref: options.ref,
      targetResidency: "suspended",
      ...(options.ref.kind === "meta" ? { roomKind: "direct" as const } : {}),
      ...(options.sharedTaskScope
        ? { sharedTaskScope: options.sharedTaskScope }
        : {}),
    },
    bootstrap: "restored",
    ghost: {
      agentId: options.ref.agentId,
      actorId: options.actorId,
      tenantId: options.tenantId,
      revision: options.configurationRevision ?? "1",
      agent: options.agent,
      runtime: options.runtime,
      resources: options.resources,
    },
    identity: {
      actorId: options.actorId,
      agentType: options.agentType ?? "general",
      sponsor: { actorId: "sponsor-1", displayName: "Sponsor" },
    },
    logger: silentLogger,
  });
  await executor.open();
  await executor.bindSources();
  executor.publish();
  return executor;
}

const standaloneHost = <TRuntimeSettings>(): ExecutorHost<
  ContextExecutor<TRuntimeSettings>,
  TRuntimeSettings
> => ({
  owns: () => true,
  holds: () => true,
  isClosing: () => false,
  isDeletingAgent: () => false,
  isTerminal: () => false,
  hasLazyRestore: () => false,
  clearLazyRestore: () => undefined,
  runContext: (_ref, operation) => operation(),
  duringOpen: (operation) => operation(),
  trackBackground: (operation) => {
    void operation.catch(() => undefined);
  },
  withConfigTiming: (_ref, _phase, operation) => operation(),
  persistTargetResidency: async () => undefined,
  releaseIdleContext: async () => undefined,
  assertAgentAvailable: () => undefined,
  assertActivationReady: async () => undefined,
  checkActivationOrDefer: async (_executor, pendingFailure) => {
    if (pendingFailure !== undefined) throw asError(pendingFailure);
  },
  isRecoverableRestoreFailure: () => false,
  shouldSuspendRestoreFailure: () => false,
  retryActivationLater: async () => undefined,
  canRunMaintenance: () => false,
  isSuperseded: async () => false,
  takeUpQueuedInputSlow: async () => undefined,
});

/**
 * A test's handle on one standalone executor created later: `create` builds
 * it from options and `executor` reads it back. Run terminals reach the
 * listeners added with `onTerminal`, whichever options created it.
 */
export function createExecutorHandle<TRuntimeSettings>(services: {
  readonly activator: ContextRuntimeActivator<TRuntimeSettings>;
  readonly stateFactory: ContextRuntimeStateFactory<TRuntimeSettings>;
  readonly statusPublisher?: RuntimeStatusPublisher;
  readonly inspectPersistedHistory?: ExecutorServices<TRuntimeSettings>["inspectPersistedHistory"];
}): {
  readonly services: ExecutorServices<TRuntimeSettings>;
  create(
    options: StandaloneExecutorOptions<TRuntimeSettings>,
  ): Promise<ContextExecutor<TRuntimeSettings>>;
  onTerminal(listener: (signal: RunTerminalEvent) => void): void;
  readonly executor: ContextExecutor<TRuntimeSettings>;
} {
  let executor: ContextExecutor<TRuntimeSettings> | undefined;
  const listeners = new Set<(signal: RunTerminalEvent) => void>();
  return {
    services: {
      activator: services.activator,
      stateFactory: services.stateFactory,
      ...(services.statusPublisher
        ? { statusPublisher: services.statusPublisher }
        : {}),
      ...(services.inspectPersistedHistory
        ? { inspectPersistedHistory: services.inspectPersistedHistory }
        : {}),
    },
    async create(options) {
      executor = await createStandaloneExecutor({
        ...services,
        options: {
          ...options,
          onRunTerminal: (signal) => {
            options.onRunTerminal?.(signal);
            for (const listener of listeners) listener(signal);
          },
        },
      });
      return executor;
    },
    onTerminal(listener) {
      listeners.add(listener);
    },
    get executor() {
      if (!executor) throw new Error("The executor was not created");
      return executor;
    },
  };
}
