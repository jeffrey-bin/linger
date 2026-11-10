import { randomUUID } from "node:crypto";
import { ContextRuntimeCleanupError } from "../../../src/agent/executor/activation.js";
import { RunnerOperationError } from "../../../src/agent/runner-gateway/runner-operation.js";
import {
  createBuiltinAgentFeatures,
  type BuiltinFeatureServices,
} from "../../../src/agent/agent-features/builtin.js";
import {
  composeContextFeatures,
  type ComposedContextFeatures,
} from "../../../src/agent/agent-features/compose.js";
import {
  defineFeature,
  type BoundFeatureContext,
  type ContextBootstrap,
  type FeatureDeclaration,
  type MaintenanceAction,
  type MaintenanceEvent,
} from "../../../src/agent/agent-features/contracts.js";
import type {
  BuiltinFeatureHost,
  FeatureTimers,
} from "../../../src/agent/agent-features/host-ports.js";
import type { FlashbackResponse } from "../../../src/flashback.js";
import { mergePromptInputContribution } from "../../../src/agent/prompt/input-contribution-merger.js";
import {
  resolveContextRestoreMaxRetryAttempts,
  resolveContextRestoreRetryDelayMs,
} from "../../../src/agent/executor/application.js";
import {
  LOCAL_COMPUTER_IDLE_TIMEOUT_MS,
  LocalComputerOfflineError,
} from "../../../src/agent/runner-gateway/local-computer-management.js";
import type { RuntimeHistoryPage } from "../../../src/agent/executor/history.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setImmediate as nextTurn,
  setTimeout as delay,
} from "node:timers/promises";
import {
  TeamHubRuntimeStateError,
  createTeamHubRuntimeStateClient,
} from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import { createTeamHubGhostStore } from "../../../src/agent/executor/ghost-store.js";
import { createTeamHubRuntimeStateClientFake } from "../test-support/teamhub-runtime-state-client.js";
import { restorePersistedBindings } from "../../../src/agent/bootstrap/binding-restore.js";
import type { LocalRuntimeSettings } from "../../../src/agent/runtime-settings.js";
import {
  claimAgentFailureAlert,
  setAgentLogOptions,
  type AgentLogger,
} from "../../../src/agent/observability/agent-log.js";
import { createAgentManagerHttpServer } from "../../../src/agent/executor/http/agent-manager-http-server.js";
import {
  AgentManagerError,
  AgentIdentityResolutionError,
} from "../../../src/agent/executor/agent-manager-api.js";
import {
  ExecutorRegistry,
  type ExecutorRegistryDependencies,
  type ContextRestoreRecovery,
} from "../../../src/agent/executor/registry.js";
import { createInMemoryGhostStore } from "../test-support/in-memory-ghost-store.js";
import type {
  GhostInput,
  Ghost,
  GhostStore,
} from "../../../src/agent/executor/ghost.js";
import type {
  ResolvedAgentIdentity,
  Message,
} from "../../../src/agent/executor/types.js";
import {
  encodeExecutionContextRef,
  type ContextTargetResidency,
  type EnsureExecutionContextResult,
  type ExecutionContextRecord,
  type ExecutionContextRef,
  type ExecutionContextStore,
} from "../../../src/agent/executor/context-ref.js";
import { createInMemoryExecutionContextStore } from "../test-support/in-memory-execution-context-store.js";
import type {
  RunWakeTarget,
  RunWakeTargetRegistrar,
} from "../../../src/agent/agent-features/inbox-source/types.js";
import { inboxInputFact } from "../../../src/agent/agent-features/inbox-source/accepted-fact.js";
import {
  Deferred,
  FakeRuntime,
  fakeActivator,
} from "../test-support/fake-activator.js";

interface TestRuntime {
  readonly model: string;
  readonly computerId?: string;
}

/**
 * Test-only Context source. It records each Context bind/stop so lifecycle
 * tests keep their install and stop-gate observations.
 */
class RecordingSourceProbe {
  stopGate: Deferred | null = null;
  readonly starts: {
    readonly agentActorId: string;
    readonly agentName: string;
    readonly bootstrap: ContextBootstrap;
    readonly target: ExecutionContextRef;
  }[] = [];
  readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }
}

/**
 * Test feature that decides maintenance from probe flags, registers timers
 * through the host, and records every maintenance event.
 */
class MaintenanceProbe {
  idleDecision: MaintenanceAction | null = null;
  timerDecision: MaintenanceAction | null = null;
  readonly events: MaintenanceEvent[] = [];
  bound: BoundFeatureContext | null = null;
  timers: FeatureTimers | null = null;
  /** Timer names onTimer saw, with whether it got the submitting form. */
  readonly fired: { name: string; canSubmit: boolean }[] = [];
}

const maintenanceProbeFeature = (
  probe: MaintenanceProbe,
  host: BuiltinFeatureHost,
): FeatureDeclaration =>
  defineFeature({
    id: "test-maintenance-probe",
    match: { contextKinds: ["meta"] },
    context: {
      ports: {
        onContextBound: {},
        decideMaintenance: {},
        onMaintenance: {},
        onTimer: {},
      },
      create: () => ({
        onContextBound: (bound) => {
          probe.bound = bound;
          probe.timers = host.timers;
        },
        onTimer: (context, name) => {
          probe.fired.push({ name, canSubmit: "followUp" in context });
        },
        decideMaintenance: (_view, trigger) =>
          trigger.kind === "timer" ? probe.timerDecision : probe.idleDecision,
        onMaintenance: (_bound, event) => {
          probe.events.push(event);
        },
      }),
    },
  });

const recordingSourceProbe = (
  probe: RecordingSourceProbe,
): FeatureDeclaration =>
  defineFeature({
    id: "test-source-probe",
    context: {
      ports: { onContextBound: {} },
      create: (bound) => ({
        onContextBound: (_context, input) => {
          probe.starts.push({
            agentActorId: bound.actorId,
            agentName: bound.agentName,
            bootstrap: input.bootstrap,
            target: bound.ref,
          });
          return {
            stop: async () => {
              probe.events.push(
                `behavior:stop:${encodeExecutionContextRef(bound.ref)}`,
              );
              await probe.stopGate?.promise;
            },
          };
        },
      }),
    },
  });

class RecordingRunWakes implements RunWakeTargetRegistrar {
  readonly stopped: string[] = [];
  readonly targets: RunWakeTarget[] = [];

  registerTarget(target: RunWakeTarget) {
    this.targets.push(target);
    return {
      stop: () => {
        this.stopped.push(encodeExecutionContextRef(target.ref));
      },
    };
  }

  /** The registered target of one Context. */
  target(ref: ExecutionContextRef): RunWakeTarget {
    const key = encodeExecutionContextRef(ref);
    const target = [...this.targets]
      .reverse()
      .find((candidate) => encodeExecutionContextRef(candidate.ref) === key);
    if (!target) throw new Error(`No run wake target for ${key}`);
    return target;
  }
}

class RecordingContextStore implements ExecutionContextStore {
  readonly delegate = createInMemoryExecutionContextStore();
  readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  ensure(
    ref: ExecutionContextRef,
    initialTargetResidency?: ContextTargetResidency,
  ): Promise<EnsureExecutionContextResult> {
    return this.delegate.ensure(ref, initialTargetResidency);
  }

  get(ref: ExecutionContextRef): Promise<ExecutionContextRecord | null> {
    return this.delegate.get(ref);
  }

  list(): Promise<readonly ExecutionContextRecord[]> {
    return this.delegate.list();
  }

  listByAgent(agentId: string): Promise<readonly ExecutionContextRecord[]> {
    return this.delegate.listByAgent(agentId);
  }

  setTargetResidency(
    ref: ExecutionContextRef,
    targetResidency: ContextTargetResidency,
  ): Promise<"updated" | "not_found"> {
    return this.delegate.setTargetResidency(ref, targetResidency);
  }

  remove(ref: ExecutionContextRef): Promise<"removed" | "not_found"> {
    this.events.push(`contexts:remove:${encodeExecutionContextRef(ref)}`);
    return this.delegate.remove(ref);
  }

  removeByAgent(agentId: string): Promise<number> {
    this.events.push(`contexts:remove-agent:${agentId}`);
    return this.delegate.removeByAgent(agentId);
  }

  async close(): Promise<void> {
    this.events.push("contexts:close");
    await this.delegate.close();
  }
}

class PushContextStore extends RecordingContextStore {
  readonly listeners = new Set<
    (record: Readonly<ExecutionContextRecord>) => void
  >();
  readonly leaseLossListeners = new Set<
    (ref: Readonly<ExecutionContextRef>) => void
  >();
  readonly terminalRecords = new Map<string, ExecutionContextRecord>();
  persistedTransitions = 0;

  override async listByAgent(
    agentId: string,
  ): Promise<readonly ExecutionContextRecord[]> {
    const records = await super.listByAgent(agentId);
    return records.map(
      (record) =>
        this.terminalRecords.get(encodeExecutionContextRef(record.ref)) ??
        record,
    );
  }

  override async setTargetResidency(
    ref: ExecutionContextRef,
    targetResidency: ContextTargetResidency,
  ): Promise<"updated" | "not_found"> {
    this.persistedTransitions += 1;
    return super.setTargetResidency(ref, targetResidency);
  }

  subscribe(
    listener: (record: Readonly<ExecutionContextRecord>) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeUnbind(
    listener: (ref: Readonly<ExecutionContextRef>) => void,
  ): () => void {
    this.leaseLossListeners.add(listener);
    return () => this.leaseLossListeners.delete(listener);
  }

  async publish(
    ref: ExecutionContextRef,
    targetResidency: ContextTargetResidency,
  ): Promise<void> {
    const result = await this.delegate.setTargetResidency(ref, targetResidency);
    if (result !== "updated") throw new Error("Context was not found");
    const record = await this.delegate.get(ref);
    if (!record) throw new Error("Context was not retained");
    for (const listener of this.listeners) listener(record);
  }

  publishTerminated(
    ref: ExecutionContextRef,
    terminalReason: "room_deleted" | "context_deleted" = "room_deleted",
  ): void {
    const record: ExecutionContextRecord = {
      ref,
      targetResidency: "suspended",
      terminalReason,
    };
    this.terminalRecords.set(encodeExecutionContextRef(ref), record);
    for (const listener of this.listeners) listener(record);
  }

  publishLeaseLoss(ref: ExecutionContextRef): void {
    for (const listener of this.leaseLossListeners) listener(ref);
  }
}

class RecordingGhostStore implements GhostStore<TestRuntime> {
  readonly delegate = createInMemoryGhostStore<TestRuntime>();
  readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  insert(
    ghost: GhostInput<TestRuntime>,
  ): Promise<"inserted" | "agent_id_conflict"> {
    return this.delegate.insert(ghost);
  }

  get(agentId: string) {
    return this.delegate.get(agentId);
  }

  list() {
    return this.delegate.list();
  }

  setActorId(agentId: string, actorId: string) {
    return this.delegate.setActorId(agentId, actorId);
  }

  remove(agentId: string): Promise<"removed" | "not_found"> {
    this.events.push(`ghost:remove:${agentId}`);
    return this.delegate.remove(agentId);
  }

  async close(): Promise<void> {
    this.events.push("ghost:close");
    await this.delegate.close();
  }
}

const registration = {
  tenantId: "tenant-test",
  revision: "revision-1",
  agent: { name: "Context Agent", instructions: "Use explicit tools." },
  runtime: { model: "test-model" },
  resources: { skills: [], mcpServers: [] },
} as const;

const metaRef = (agentId = "agent-1"): ExecutionContextRef => ({
  kind: "meta",
  agentId,
  roomId: "room-1",
});

const roomMetaRef = (
  roomId: string,
  agentId = "agent-1",
): ExecutionContextRef => ({ kind: "meta", agentId, roomId });

const alterEgoRef = (
  taskId = "task-1",
  agentId = "agent-1",
): ExecutionContextRef => ({ kind: "alter_ego", agentId, taskId });

const documentRef = (
  documentId = "document-1",
  agentId = "agent-1",
): ExecutionContextRef => ({ kind: "document", agentId, documentId });

const message = (messageId = "message-1") => ({
  messageId,
  rawMessage: "Inbox A changed.",
  segments: [{ type: "text" as const, content: "Inbox A changed." }] as const,
});

const availableHistory = (): RuntimeHistoryPage => ({
  status: "available",
  providerKind: "codex",
  source: "codex_rollout",
  snapshot: {
    id: "snapshot-history",
    threadId: "thread-history",
    capturedAt: "2026-09-04T00:00:00.000Z",
    recordCount: 0,
    tailState: "clean",
  },
  instructions: {
    status: "available",
    source: "codex_rollout",
    blocks: [],
  },
  records: [],
});

const resolvedIdentity = (agentId: string): ResolvedAgentIdentity => ({
  actorId: `actor:${agentId}`,
  agentType: "general",
  sponsor: {
    actorId: "actor:test-sponsor",
    displayName: "Test Sponsor",
  },
});

const shouldPrepareRoomMetaContext: NonNullable<
  ExecutorRegistryDependencies<TestRuntime>["shouldPrepareContext"]
> = ({ ref }) => ref.kind === "meta";

interface HarnessOptions {
  readonly identityResolver?: (
    agentId: string,
  ) => Promise<ResolvedAgentIdentity>;
  readonly ghostStore?: GhostStore<TestRuntime>;
  readonly contextStore?: ExecutionContextStore;
  readonly sources?: RecordingSourceProbe;
  readonly runWakes?: RunWakeTargetRegistrar;
  readonly flashback?: BuiltinFeatureServices["flashback"];
  readonly agentMemory?: BuiltinFeatureServices["agentMemory"];
  readonly maintenance?: MaintenanceProbe;
  readonly canRunMaintenance?: ExecutorRegistryDependencies<TestRuntime>["canRunMaintenance"];
  readonly createRuntime?: (ref: ExecutionContextRef) => FakeRuntime;
  readonly restoreRecovery?: ContextRestoreRecovery<TestRuntime>;
  readonly restoreConcurrency?: number;
  readonly restorePriority?: ExecutorRegistryDependencies<TestRuntime>["restorePriority"];
  readonly shouldActivateOnRestore?: ExecutorRegistryDependencies<TestRuntime>["shouldActivateOnRestore"];
  readonly shouldPrepareContext?: ExecutorRegistryDependencies<TestRuntime>["shouldPrepareContext"];
  readonly presencePreparation?: ExecutorRegistryDependencies<TestRuntime>["presencePreparation"];
  readonly inspectDetachedHistory?: ExecutorRegistryDependencies<TestRuntime>["inspectDetachedHistory"];
}

const wireLocalRuntime = {
  type: "local" as const,
  model: "test-model",
  placement: {
    tenant_id: "tenant-test",
    owner_actor_id: "owner-1",
    computer_id: "computer-1",
    runtime_type: "codex" as const,
    workspace_grant_id: "grant-1",
    assignment_revision: "1",
  },
};

const managers: ExecutorRegistry<TestRuntime>[] = [];

const createHarness = (options: HarnessOptions = {}) => {
  const fakes = new Map<string, FakeRuntime>();
  // The latest composed features of each Context.
  const composed = new Map<string, ComposedContextFeatures>();
  const sources = options.sources ?? new RecordingSourceProbe();
  const contextStore =
    options.contextStore ?? createInMemoryExecutionContextStore();
  const ghostStore =
    options.ghostStore ?? createInMemoryGhostStore<TestRuntime>();
  const featureLogEntries: {
    readonly level: string;
    readonly event: string;
    readonly fields?: unknown;
  }[] = [];
  const featureLogger: AgentLogger = {
    log(level, event, fields) {
      featureLogEntries.push({ level, event, fields });
    },
    child() {
      return featureLogger;
    },
  };
  const builtin = createBuiltinAgentFeatures({
    services: {
      logger: featureLogger,
      ...(options.runWakes ? { runWakes: options.runWakes } : {}),
      ...(options.flashback ? { flashback: options.flashback } : {}),
      ...(options.agentMemory ? { agentMemory: options.agentMemory } : {}),
    },
  });
  const manager = new ExecutorRegistry<TestRuntime>({
    identityResolver: {
      resolveIdentity:
        options.identityResolver ??
        (async (agentId) => resolvedIdentity(agentId)),
    },
    executorServices: fakeActivator((ref) => {
      const fake = options.createRuntime?.(ref) ?? new FakeRuntime();
      fake.history ??= availableHistory();
      fakes.set(encodeExecutionContextRef(ref), fake);
      return fake;
    }),
    ghostStore,
    contextStore,
    features: {
      composeContext: (input) => {
        const features = composeContextFeatures({
          context: input.context,
          features: [
            ...builtin.contextDeclarations(input.host),
            recordingSourceProbe(sources),
            ...(options.maintenance
              ? [maintenanceProbeFeature(options.maintenance, input.host)]
              : []),
          ],
          mergeInputContribution: mergePromptInputContribution,
          ...(input.logger ? { logger: input.logger } : {}),
        });
        composed.set(encodeExecutionContextRef(input.context.ref), features);
        return features;
      },
    },
    ...(options.restoreRecovery
      ? { restoreRecovery: options.restoreRecovery }
      : {}),
    ...(options.restoreConcurrency === undefined
      ? {}
      : { restoreConcurrency: options.restoreConcurrency }),
    ...(options.restorePriority
      ? { restorePriority: options.restorePriority }
      : {}),
    ...(options.shouldActivateOnRestore
      ? { shouldActivateOnRestore: options.shouldActivateOnRestore }
      : {}),
    ...(options.shouldPrepareContext
      ? { shouldPrepareContext: options.shouldPrepareContext }
      : {}),
    ...(options.presencePreparation
      ? { presencePreparation: options.presencePreparation }
      : {}),
    ...(options.inspectDetachedHistory
      ? { inspectDetachedHistory: options.inspectDetachedHistory }
      : {}),
    ...(options.canRunMaintenance
      ? { canRunMaintenance: options.canRunMaintenance }
      : {}),
  });
  managers.push(manager);
  return {
    contextStore,
    featureLogEntries,
    ghostStore,
    manager,
    fakes,
    composed,
    sources,
  };
};

const seedGhost = async (
  store: GhostStore<TestRuntime>,
  agentId = "agent-1",
  overrides: Partial<GhostInput<TestRuntime>> = {},
): Promise<void> => {
  await store.insert({
    ...registration,
    agentId,
    actorId: `actor:${agentId}`,
    ...overrides,
  });
};

/** The request of the Context's latest Runtime activation, once it ran. */
const activationOf = async (
  harness: { readonly fakes: ReadonlyMap<string, FakeRuntime> },
  ref: ExecutionContextRef,
) => {
  const key = encodeExecutionContextRef(ref);
  await vi.waitFor(() =>
    expect(harness.fakes.get(key)?.lastActivation).toBeDefined(),
  );
  return harness.fakes.get(key)!.lastActivation!;
};

/**
 * Leaves the executor active with no ready Runtime: its next Run finds the
 * Agent's resources changed and both Runtime recovery activations fail.
 */
const exhaustRuntimeRecovery = async (
  fake: FakeRuntime,
  wake: () => void,
): Promise<void> => {
  const activations = fake.activations.length;
  fake.startError = new Error("Runtime recovery activation failed");
  fake.prepareNextRun = async () => false;
  fake.state.queueInboxRun([message("resources-changed")]);
  wake();
  await vi.waitFor(() =>
    expect(fake.activations).toHaveLength(activations + 2),
  );
  await vi.waitFor(() => expect(fake.state.hasQueuedRuns()).toBe(false));
  fake.startError = null;
  fake.prepareNextRun = null;
};

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setAgentLogOptions();
  await Promise.all(
    managers.splice(0).map((manager) => manager.close().catch(() => undefined)),
  );
});

describe("Execution Context AgentManager", () => {
  it("restores a later Agent inbox while an earlier configuration is unavailable", async () => {
    let unavailable = true;
    const failure = new TeamHubRuntimeStateError(503, "migration pending");
    const ghostStore = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({
        getConfig: async (agentId) => {
          if (agentId === "agent-a" && unavailable) throw failure;
          return {
            agent_id: agentId,
            actor_id: `actor:${agentId}`,
            tenant_id: "tenant-test",
            configuration_revision: "1",
            runtime_configuration_revision: "1",
            content_hash: "a".repeat(64),
            permission_review: false,
            agent: registration.agent,
            runtime: wireLocalRuntime,
            resources: { skills: [], mcp_servers: [] },
          };
        },
      }),
      listAgentIds: async () => ["agent-a", "agent-b"],
      parseRuntime: (value) => value as LocalRuntimeSettings,
    });
    const contextStore = createInMemoryExecutionContextStore();
    const blocked = { ...roomMetaRef("room-a"), agentId: "agent-a" };
    const ready = { ...roomMetaRef("room-b"), agentId: "agent-b" };
    await contextStore.ensure(blocked, "suspended");
    await contextStore.ensure(ready, "suspended");
    const runWakes = new RecordingRunWakes();
    const harness = createHarness({
      ghostStore: ghostStore as GhostStore<TestRuntime>,
      contextStore,
      runWakes,
    });

    const controller = new AbortController();
    const log = vi.fn();
    const restoration = restorePersistedBindings(
      harness.manager,
      controller.signal,
      {
        log,
        child: () => {
          throw new Error("Unexpected child logger");
        },
      },
    );
    try {
      await vi.waitFor(() =>
        expect(harness.fakes.has(encodeExecutionContextRef(ready))).toBe(true),
      );
      const fake = harness.fakes.get(encodeExecutionContextRef(ready))!;
      expect(fake.calls).toEqual(["create"]);
      expect(harness.fakes.has(encodeExecutionContextRef(blocked))).toBe(false);
      await expect(contextStore.get(blocked)).resolves.toMatchObject({
        targetResidency: "suspended",
      });
      // TeamHub queued a Run for the ready Agent during the rollout.
      runWakes.target(ready).wake("queued");
      await vi.waitFor(() => expect(fake.calls).toContain("queued:queued"));
      expect(fake.calls.indexOf("resume")).toBeLessThan(
        fake.calls.indexOf("queued:queued"),
      );
      const callsBeforeRetry = [...fake.calls];

      unavailable = false;
      await restoration;
      expect(
        harness.fakes.get(encodeExecutionContextRef(blocked))!.calls,
      ).toEqual(["create"]);
      expect(harness.fakes.get(encodeExecutionContextRef(ready))).toBe(fake);
      expect(fake.calls).toEqual(callsBeforeRetry);
      expect(log).toHaveBeenCalledWith(
        "warn",
        "manager.restore_deferred_after_listen",
        expect.objectContaining({ retryAttempt: 1, retryAfterMs: 1000 }),
      );
    } finally {
      controller.abort();
      await restoration;
    }
  });

  it("rechecks readiness when another refresh changed the projected revision", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    await seedGhost(ghostStore, "agent-1", registration);
    const isActivationReady = vi.fn(async () => false);
    Object.assign(ghostStore, {
      refresh: async (agentId: string) => {
        const current = (await ghostStore.get(agentId))!;
        await ghostStore.replace!(agentId, current.revision, {
          ...current,
          revision: "revision-2",
        });
        return { revision: "revision-1", activationReady: true };
      },
      isActivationReady,
    });
    const harness = createHarness({ ghostStore });
    await expect(
      harness.manager.ensureBinding(roomMetaRef("room-refresh-interleaving")),
    ).rejects.toMatchObject({ code: "agent_activation_pending" });
    expect(isActivationReady).toHaveBeenCalledExactlyOnceWith(
      "agent-1",
      "revision-2",
    );
    expect(harness.fakes.size).toBe(0);
  });

  it.each(["active", "suspended"] as const)(
    "recovers %s Context materialization after generic TeamHub 500s",
    async (residency) => {
      vi.useFakeTimers();
      let unavailable = true;
      const fetchRequest = vi.fn(async () =>
        unavailable
          ? Response.json(
              {
                error: {
                  code: "INTERNAL_ERROR",
                  message: "request could not be completed",
                },
              },
              { status: 500 },
            )
          : Response.json({
              configuration_revision: "revision-1",
            }),
      );
      const remoteStore = createTeamHubGhostStore({
        client: createTeamHubRuntimeStateClient({
          baseUrl: "https://teamhub.example.test",
          serviceToken: "test",
          fetch: fetchRequest,
        }),
        listAgentIds: async () => [],
        parseRuntime: (value) => value as LocalRuntimeSettings,
      });
      const ghostStore = Object.assign(
        createInMemoryGhostStore<TestRuntime>(),
        {
          isActivationReady: remoteStore.isActivationReady!.bind(remoteStore),
        },
      );
      await seedGhost(ghostStore, "agent-1", registration);
      const contextStore = createInMemoryExecutionContextStore();
      const refs = [
        roomMetaRef("room-1"),
        roomMetaRef("room-2"),
        roomMetaRef("room-3"),
      ];
      for (const ref of refs) await contextStore.ensure(ref, residency);
      const harness = createHarness({
        ghostStore,
        contextStore,
        restoreConcurrency: 8,
        shouldActivateOnRestore: async () => false,
      });

      await expect(harness.manager.restore()).resolves.toBeUndefined();
      expect(fetchRequest).toHaveBeenCalledTimes(3);
      expect(harness.fakes.size).toBe(0);
      unavailable = false;
      await vi.advanceTimersByTimeAsync(1_000);
      for (const ref of refs) {
        expect(
          harness.fakes.get(encodeExecutionContextRef(ref))?.calls,
        ).toEqual(["create"]);
        expect(await contextStore.get(ref)).toMatchObject({
          targetResidency: residency,
        });
      }
      await remoteStore.close();
    },
  );

  it("logs each rejected startup Context even when failure precedes Shell creation", async () => {
    vi.stubEnv("AGENT_LOG_LEVEL", "error");
    setAgentLogOptions({ format: "json" });
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const ghostStore = Object.assign(
        createInMemoryGhostStore<TestRuntime>(),
        {
          isActivationReady: async () => {
            throw Object.assign(
              new Error("configuration rejected token=private-token"),
              {
                code: "CONFIGURATION_REJECTED",
                retryable: false,
              },
            );
          },
        },
      );
      await seedGhost(ghostStore, "agent-1", registration);
      const contextStore = createInMemoryExecutionContextStore();
      const ref = roomMetaRef("room-failed");
      await contextStore.ensure(ref, "active");
      const harness = createHarness({ ghostStore, contextStore });
      await expect(harness.manager.restore()).rejects.toBeInstanceOf(
        AggregateError,
      );
      const entries = output.mock.calls.map(([line]) =>
        JSON.parse(String(line)),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          event: "manager.context_restore_failed",
          contextKey: encodeExecutionContextRef(ref),
          retryScheduled: false,
          error: {
            name: "Error",
            reason: "configuration rejected token=[Redacted]",
            frames: expect.any(String),
            code: "CONFIGURATION_REJECTED",
            retryable: false,
          },
        }),
      );
      expect(JSON.stringify(entries)).not.toContain("private-token");
    } finally {
      vi.unstubAllEnvs();
      setAgentLogOptions();
    }
  });

  it("does not acknowledge a trusted turn until Runtime activation succeeds", async () => {
    const activationError = new Error("Task projection is not ready");
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    await seedGhost(ghostStore);
    const harness = createHarness({
      ghostStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = activationError;
        return fake;
      },
    });
    const ref = alterEgoRef();

    await expect(
      harness.manager.submitTrustedTurn({
        target: ref,
        messages: [message()],
      }),
    ).rejects.toBe(activationError);

    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls).toEqual(["create", "submitTrustedTurn", "start"]);

    fake.startError = null;
    await expect(
      harness.manager.submitTrustedTurn({
        target: ref,
        messages: [message()],
      }),
    ).resolves.toEqual({ agentRunRef: expect.any(String) });
    expect(fake.calls).toEqual([
      "create",
      "submitTrustedTurn",
      "start",
      "submitTrustedTurn",
      "start",
    ]);
  });

  it.each([
    {
      // The executor's Runtime log owns the alert; the registry aggregates.
      caseName: "unexpected failures as error",
      activationError: new Error("Runtime activation failed"),
      expectedLevel: "error",
      expectedEvent: "runtime.activation.failed",
      unexpectedEvent: "activation.waiting_for_projection",
      alreadyAlerted: false,
    },
    {
      caseName: "upstream failures already alerted as warning",
      activationError: new Error("Runtime activation already emitted an alert"),
      expectedLevel: "warn",
      expectedEvent: "activation.failed",
      unexpectedEvent: "activation.waiting_for_projection",
      alreadyAlerted: true,
    },
  ])(
    "logs $caseName",
    async ({
      activationError,
      expectedEvent,
      expectedLevel,
      unexpectedEvent,
      alreadyAlerted,
    }) => {
      if (alreadyAlerted)
        expect(claimAgentFailureAlert(activationError)).toBe(true);
      vi.stubEnv("AGENT_LOG_LEVEL", "debug");
      setAgentLogOptions({ format: "json" });
      const standardOutput = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const errorOutput = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const warningOutput = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const harness = createHarness({
        createRuntime: () => {
          const fake = new FakeRuntime();
          fake.startError = activationError;
          return fake;
        },
      });
      await harness.manager.registerAgent(registration, {
        agentId: "agent-1",
      });
      const ref = roomMetaRef("room-log-classification");

      await expect(harness.manager.startContext(ref)).rejects.toBe(
        activationError,
      );

      const entries = [
        ...standardOutput.mock.calls,
        ...warningOutput.mock.calls,
        ...errorOutput.mock.calls,
      ]
        .map(([line]) => JSON.parse(String(line)))
        .filter((entry) => /^(runtime\.)?activation\./.test(entry.event));
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: expectedLevel,
          event: expectedEvent,
          contextKey: encodeExecutionContextRef(ref),
        }),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          event: "activation.failed",
          reason: "start",
          contextKey: encodeExecutionContextRef(ref),
        }),
      );
      expect(entries).not.toContainEqual(
        expect.objectContaining({ event: unexpectedEvent }),
      );
    },
  );

  it("coalesces concurrent trusted-turn activation failures", async () => {
    const activationError = new Error("Task projection is not ready");
    const startGate = new Deferred();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    await seedGhost(ghostStore);
    const harness = createHarness({
      ghostStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = activationError;
        fake.startGate = startGate;
        return fake;
      },
    });
    const ref = alterEgoRef();

    const first = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("message-1")],
    });
    await vi.waitFor(() => {
      const fake = harness.fakes.get(encodeExecutionContextRef(ref));
      expect(fake?.calls).toContain("start");
    });
    const second = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("message-2")],
    });
    await vi.waitFor(() => {
      const fake = harness.fakes.get(encodeExecutionContextRef(ref));
      expect(
        fake?.calls.filter((call) => call === "submitTrustedTurn"),
      ).toHaveLength(2);
    });
    startGate.resolve();

    await expect(first).rejects.toBe(activationError);
    await expect(second).rejects.toBe(activationError);
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);
  });

  it("defers and retries an explicitly recoverable restored Context", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const temporarilyUnavailable = new Error("Local Computer is offline");
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = temporarilyUnavailable;
        return fake;
      },
      restoreRecovery: {
        retryDelayMs: 1_000,
        isRecoverable: ({ error }) => error === temporarilyUnavailable,
      },
    });

    await expect(harness.manager.restore()).resolves.toBeUndefined();
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    expect(fake.calls).toEqual(["create", "start"]);
    await expect(harness.manager.getContextStatus(metaRef())).resolves.toBe(
      "created",
    );

    fake.startError = null;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fake.calls).toEqual(["create", "start", "start"]);
    await expect(harness.manager.getContextStatus(metaRef())).resolves.toBe(
      "active",
    );
  });

  it("isolates a backoff-limited Local restore failure from three Host runs and service readiness", async () => {
    const localAgentId = "agent-local-offline";
    const hostAgentIds = ["agent-host-a", "agent-host-b", "agent-host-c"];
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore, localAgentId, {
      runtime: { model: "test-model", computerId: "computer-offline" },
    });
    await contextStore.ensure(metaRef(localAgentId), "active");
    await Promise.all(
      hostAgentIds.map((agentId) => seedGhost(ghostStore, agentId)),
    );

    class TimedRecordingFake extends FakeRuntime {
      readonly startTimes: number[] = [];

      override activate(
        request: Parameters<FakeRuntime["activate"]>[0],
      ): ReturnType<FakeRuntime["activate"]> {
        this.startTimes.push(performance.now());
        return super.activate(request);
      }
    }

    const offline = new Error("Local Computer is offline");
    const localFake = new TimedRecordingFake();
    localFake.startError = offline;
    const retryDelays: number[] = [];
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: (ref) =>
        ref.agentId === localAgentId ? localFake : new FakeRuntime(),
      restoreRecovery: {
        isRecoverable: ({ error }) => error === offline,
        maxRetryAttempts: 3,
        retryDelayMs: ({ retryAttempt }) => {
          const delay = 30 * 2 ** (retryAttempt - 1);
          retryDelays.push(delay);
          return delay;
        },
      },
    });
    await harness.manager.restore();

    const server = createAgentManagerHttpServer({
      api: harness.manager,

      serviceToken: "isolation-service-token",
      port: 0,
    });
    const address = await server.start();

    try {
      const readinessStatuses: number[] = [];
      const readinessMonitor = (async () => {
        for (let index = 0; index < 30; index += 1) {
          readinessStatuses.push((await fetch(`${address.url}/readyz`)).status);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();
      const hostRuns = await Promise.all(
        hostAgentIds.map((agentId, index) =>
          harness.manager.submitTrustedTurn({
            target: metaRef(agentId),
            messages: [message(`host-message-${index + 1}`)],
          }),
        ),
      );

      await vi.waitFor(
        () => {
          expect(localFake.startTimes).toHaveLength(4);
        },
        { timeout: 1_000 },
      );
      await vi.waitFor(async () =>
        expect(await contextStore.get(metaRef(localAgentId))).toMatchObject({
          targetResidency: "suspended",
        }),
      );
      await readinessMonitor;

      expect(hostRuns).toHaveLength(3);
      for (const agentId of hostAgentIds) {
        const fake = harness.fakes.get(
          encodeExecutionContextRef(metaRef(agentId)),
        );
        expect(fake?.calls).toEqual(["create", "submitTrustedTurn", "start"]);
      }
      expect(readinessStatuses).toHaveLength(30);
      expect(new Set(readinessStatuses)).toEqual(new Set([200]));
      expect(retryDelays).toEqual([30, 60, 120]);
      for (const [index, delay] of retryDelays.entries()) {
        expect(
          localFake.startTimes[index + 1]! - localFake.startTimes[index]!,
        ).toBeGreaterThanOrEqual(delay - 5);
      }
    } finally {
      await server.close();
    }
  });

  it("notifies a ready Context of work after an explicit start cleared a failed activation", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = new Error("activation failed");
        return fake;
      },
    });
    await expect(harness.manager.restore()).rejects.toThrow(AggregateError);
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    // A repeated Store observation does not repeat the failed activation.
    await contextStore.publish(metaRef(), "active");
    await nextTurn();
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);

    fake.startError = null;
    await harness.manager.startContext(metaRef());
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
    // TeamHub queued a Run; the next Store observation wakes the ready Runtime.
    fake.state.queueInboxRun([message("message-queued")]);
    await contextStore.publish(metaRef(), "active");
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
  });

  it("allows fresh trusted-turn input after a failed automatic activation", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = new Error("activation failed");
        return fake;
      },
    });
    await expect(harness.manager.restore()).rejects.toThrow(AggregateError);
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    await contextStore.publish(metaRef(), "active");
    await nextTurn();
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);

    fake.startError = null;
    await harness.manager.submitTrustedTurn({
      target: metaRef(),
      messages: [message()] as const,
    });
    await nextTurn();
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
    expect(fake.received).toHaveLength(1);
    await expect(harness.manager.getContextStatus(metaRef())).resolves.toBe(
      "active",
    );
  });

  it("accepts a new suspended-to-active intention after activation failed", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    let firstActivation = true;
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        if (firstActivation) fake.startError = new Error("activation failed");
        firstActivation = false;
        return fake;
      },
    });
    await expect(harness.manager.restore()).rejects.toThrow(AggregateError);
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;

    await contextStore.publish(metaRef(), "suspended");
    await nextTurn();
    expect(fake.calls).toContain("stop");
    await expect(harness.manager.getContextStatus(metaRef())).resolves.toBe(
      null,
    );

    await contextStore.publish(metaRef(), "active");
    await nextTurn();
    const replacement = harness.fakes.get(
      encodeExecutionContextRef(metaRef()),
    )!;
    expect(replacement).not.toBe(fake);
    expect(replacement.calls).toContain("start");
    await expect(harness.manager.getContextStatus(metaRef())).resolves.toBe(
      "active",
    );
  });

  it("waits for an explicit wake without retrying active store projections", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    await seedGhost(ghostStore, "agent-1", {
      runtime: { model: "test-model", computerId: "computer-1" },
    });
    await contextStore.ensure(metaRef(), "active");
    const temporarilyUnavailable = new Error("Local Computer is offline");
    const retryAttempts: number[] = [];
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = temporarilyUnavailable;
        return fake;
      },
      restoreRecovery: {
        retryDelayMs: ({ retryAttempt }) => {
          retryAttempts.push(retryAttempt);
          return 60_000;
        },
        isRecoverable: ({ error }) => error === temporarilyUnavailable,
      },
    });

    await expect(harness.manager.restore()).resolves.toBeUndefined();
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);

    await contextStore.publish(metaRef(), "active");
    await contextStore.publish(metaRef(), "active");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);
    expect(retryAttempts).toEqual([1]);

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
    expect(retryAttempts).toEqual([1, 2]);

    await contextStore.publish(metaRef(), "active");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
    expect(retryAttempts).toEqual([1, 2]);

    fake.startError = null;
    expect(
      harness.manager.wakeDeferredContextRestores(
        ({ runtime }) => runtime.computerId === "computer-1",
      ),
    ).toBe(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.calls.filter((call) => call === "start")).toHaveLength(3);
  });

  it("clears an explicit-wake restore when Agent configuration is replaced", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore, "agent-1", {
      runtime: { model: "test-model", computerId: "computer-1" },
    });
    await contextStore.ensure(metaRef(), "active");
    const temporarilyUnavailable = new Error("Local Computer is offline");
    let shellCount = 0;
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        shellCount += 1;
        const fake = new FakeRuntime();
        if (shellCount === 1) fake.startError = temporarilyUnavailable;
        return fake;
      },
      restoreRecovery: {
        retryDelayMs: 60_000,
        isRecoverable: ({ error }) => error === temporarilyUnavailable,
      },
    });

    await expect(harness.manager.restore()).resolves.toBeUndefined();
    await expect(
      harness.manager.updateAgent("agent-1", {
        expectedRevision: "revision-1",
        revision: "revision-2",
        agent: registration.agent,
        runtime: { model: "test-model", computerId: "computer-2" },
        resources: registration.resources,
      }),
    ).resolves.toEqual({ agentId: "agent-1", revision: "revision-2" });

    expect(
      harness.manager.wakeDeferredContextRestores(
        ({ runtime }) => runtime.computerId === "computer-1",
      ),
    ).toBe(0);
    expect(
      harness.fakes.get(encodeExecutionContextRef(metaRef()))?.runtimeSettings,
    ).toEqual({ model: "test-model", computerId: "computer-2" });
  });

  it("wakes a matching deferred restore without leaving its retry timer armed", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore, "agent-1", {
      runtime: { model: "test-model", computerId: "computer-1" },
    });
    await contextStore.ensure(metaRef(), "active");
    const temporarilyUnavailable = new Error("Local Computer is offline");
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = temporarilyUnavailable;
        return fake;
      },
      restoreRecovery: {
        retryDelayMs: 60_000,
        isRecoverable: ({ error }) => error === temporarilyUnavailable,
      },
    });

    await expect(harness.manager.restore()).resolves.toBeUndefined();
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    fake.startError = null;

    expect(
      harness.manager.wakeDeferredContextRestores(
        ({ runtime }) => runtime.computerId === "computer-2",
      ),
    ).toBe(0);
    expect(
      harness.manager.wakeDeferredContextRestores(
        ({ ref, runtime }) =>
          ref.kind === "meta" && runtime.computerId === "computer-1",
      ),
    ).toBe(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
  });

  it("restores active Contexts one at a time by default", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore, "agent-1");
    const refs = Array.from({ length: 6 }, (_, index) =>
      roomMetaRef(`room-${index + 1}`),
    );
    for (const ref of refs) await contextStore.ensure(ref, "active");
    const startGate = new Deferred();
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startGate = startGate;
        return fake;
      },
    });

    const restoration = harness.manager.restore();
    try {
      await vi.waitFor(() => {
        expect(
          [...harness.fakes.values()].flatMap((fake) =>
            fake.calls.filter((call) => call === "start"),
          ),
        ).toHaveLength(1);
      });
      expect(harness.fakes).toHaveLength(1);
    } finally {
      startGate.resolve();
      await restoration;
    }
    expect(
      [...harness.fakes.values()].flatMap((fake) =>
        fake.calls.filter((call) => call === "start"),
      ),
    ).toHaveLength(refs.length);
  });

  it("activates only restored Contexts with authoritative pending work", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore, "agent-1");
    const idleRef = roomMetaRef("room-idle");
    const pendingRef = roomMetaRef("room-pending");
    await contextStore.ensure(idleRef, "active");
    await contextStore.ensure(pendingRef, "active");
    const inspected: string[] = [];
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldActivateOnRestore: async ({ ref }) => {
        const key = encodeExecutionContextRef(ref);
        inspected.push(key);
        return key === encodeExecutionContextRef(pendingRef);
      },
    });

    await harness.manager.restore();

    expect(inspected).toEqual([
      encodeExecutionContextRef(idleRef),
      encodeExecutionContextRef(pendingRef),
    ]);
    expect(
      harness.fakes.get(encodeExecutionContextRef(idleRef))?.calls,
    ).toEqual(["create"]);
    expect(
      harness.fakes.get(encodeExecutionContextRef(pendingRef))?.calls,
    ).toEqual(["create", "start"]);
  });

  it("wakes a lazily restored active Context when a new message arrives", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const ref = alterEgoRef();
    await contextStore.ensure(ref, "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldActivateOnRestore: async () => false,
    });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls).toEqual(["create"]);

    await harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("wake-idle-context")],
    });
    await vi.waitFor(() => expect(fake.calls).toContain("start"));

    expect(fake.calls).toEqual(["create", "submitTrustedTurn", "start"]);
  });

  it("keeps a lazily restored idle Context cold across active store refreshes", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    await seedGhost(ghostStore);
    const ref = alterEgoRef();
    await contextStore.ensure(ref, "active");
    let hasPendingWork = false;
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        return fake;
      },
      shouldActivateOnRestore: async () => hasPendingWork,
    });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls).toEqual(["create"]);

    await contextStore.publish(ref, "active");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fake.calls).toEqual(["create"]);

    hasPendingWork = true;
    await contextStore.publish(ref, "active");
    await vi.waitFor(() => expect(fake.calls).toContain("start"));
  });

  it("restores higher-priority Contexts before a slower stored Context", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const localRef = roomMetaRef("room-local", "agent-local");
    const unplacedRef = roomMetaRef("room-unplaced", "agent-unplaced");
    await seedGhost(ghostStore, "agent-local", {
      runtime: { model: "local-model", computerId: "computer-offline" },
    });
    await seedGhost(ghostStore, "agent-unplaced", {
      runtime: { model: "unplaced-model" },
    });
    await contextStore.ensure(localRef, "active");
    await contextStore.ensure(unplacedRef, "active");
    const starts: string[] = [];
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: (ref) => {
        const fake = new FakeRuntime();
        fake.onActivate = () => {
          starts.push(ref.agentId);
        };
        return fake;
      },
      restorePriority: ({ runtime }) =>
        runtime.computerId === undefined ? 0 : 1,
    });

    await harness.manager.restore();

    expect(starts).toEqual(["agent-unplaced", "agent-local"]);
  });

  it("promotes newly pending work ahead of queued idle Context restores", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore, "agent-1", registration);
    const refs = ["first", "idle", "new-message"].map((roomId) =>
      roomMetaRef(roomId),
    );
    for (const ref of refs) await contextStore.ensure(ref, "suspended");
    const firstGate = new Deferred();
    const created: string[] = [];
    let pendingRoom = "";
    const harness = createHarness({
      ghostStore,
      contextStore,
      restoreConcurrency: 1,
      restorePriority: ({ ref }) =>
        ref.kind === "meta" && ref.roomId === pendingRoom ? 0 : 1,
      createRuntime: (ref) => {
        created.push(ref.kind === "meta" ? ref.roomId : ref.kind);
        const fake = new FakeRuntime();
        if (created.length === 1) fake.createGate = firstGate;
        return fake;
      },
    });
    const restore = harness.manager.restore();
    await vi.waitFor(() => expect(created).toEqual(["first"]));
    pendingRoom = "new-message";
    firstGate.resolve();
    await restore;
    expect(created).toEqual(["first", "new-message", "idle"]);
  });

  it("promotes a Context when its Room receives a message during restore", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore, "agent-1", registration);
    const refs = ["first", "idle", "new-message"].map((roomId) =>
      roomMetaRef(roomId),
    );
    for (const ref of refs) await contextStore.ensure(ref, "suspended");
    const firstGate = new Deferred();
    const created: string[] = [];
    const harness = createHarness({
      ghostStore,
      contextStore,
      restoreConcurrency: 1,
      createRuntime: (ref) => {
        created.push(ref.kind === "meta" ? ref.roomId : ref.kind);
        const fake = new FakeRuntime();
        if (created.length === 1) fake.createGate = firstGate;
        return fake;
      },
    });
    const restore = harness.manager.restore();
    await vi.waitFor(() => expect(created).toEqual(["first"]));

    const demand = harness.manager.ensureBinding(roomMetaRef("new-message"));
    firstGate.resolve();
    await demand;
    await restore;

    expect(created).toEqual(["first", "new-message", "idle"]);
  });

  it("keeps a previously active idle session cold until new input arrives", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore, "agent-1", registration);
    const ref = roomMetaRef("old-native-session");
    const idleRef = roomMetaRef("old-suspended-session");
    await contextStore.ensure(ref, "active");
    await contextStore.ensure(idleRef, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldActivateOnRestore: async () => false,
    });
    await harness.manager.restore();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(
      harness.fakes.get(encodeExecutionContextRef(idleRef))?.calls,
    ).toEqual(["create"]);
    expect(fake.received).toEqual([]);
    expect(fake.calls).toEqual(["create"]);
    await harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("wake-old-native-session")],
    });
    await vi.waitFor(() => expect(fake.calls).toContain("start"));
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);
  });

  it("persists suspension instead of retrying a rejected restored Context", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    await contextStore.ensure(alterEgoRef(), "active");
    const rejected = new Error("Context identity is no longer valid");
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = rejected;
        return fake;
      },
      restoreRecovery: {
        isRecoverable: () => false,
        shouldSuspend: ({ error }) => error === rejected,
      },
    });

    await expect(harness.manager.restore()).resolves.toBeUndefined();
    expect(await contextStore.get(alterEgoRef())).toEqual({
      ref: alterEgoRef(),
      targetResidency: "suspended",
    });
    const fake = harness.fakes.get(encodeExecutionContextRef(alterEgoRef()))!;
    // The failed activation left no Runtime to deactivate.
    expect(fake.calls).toEqual(["create", "start"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);
  });

  it.each(["timeout", "server_error", "suspended", "forbidden"] as const)(
    "handles recovery authority reads safely after %s",
    async (scenario) => {
      vi.useFakeTimers();
      class FailingReadStore extends PushContextStore {
        failRead = false;
        override async get(ref: ExecutionContextRef) {
          if (this.failRead) {
            this.failRead = false;
            throw new TeamHubRuntimeStateError(
              scenario === "forbidden"
                ? 403
                : scenario === "server_error"
                  ? 500
                  : null,
              "TeamHub read failed",
            );
          }
          return super.get(ref);
        }
      }
      const contextStore = new FailingReadStore();
      const ghostStore = createInMemoryGhostStore<TestRuntime>();
      await seedGhost(ghostStore);
      await contextStore.ensure(metaRef(), "active");
      const offline = new LocalComputerOfflineError();
      const harness = createHarness({
        ghostStore,
        contextStore,
        createRuntime: () => {
          const fake = new FakeRuntime();
          fake.startError = offline;
          return fake;
        },
        restoreRecovery: {
          isRecoverable: ({ error }) => error === offline,
          retryDelayMs: 1000,
        },
      });
      await harness.manager.restore();
      contextStore.failRead = true;
      await vi.advanceTimersByTimeAsync(1000);
      const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
      fake.startError = null;
      if (scenario === "suspended")
        await contextStore.setTargetResidency(metaRef(), "suspended");
      await vi.advanceTimersByTimeAsync(10_000);
      harness.manager.wakeDeferredContextRestores(() => true);
      await vi.advanceTimersByTimeAsync(0);
      if (scenario === "timeout" || scenario === "server_error") {
        expect(await harness.manager.getContextStatus(metaRef())).toBe(
          "active",
        );
        expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
      } else {
        expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);
        expect(harness.manager.wakeDeferredContextRestores(() => true)).toBe(0);
        if (scenario === "suspended")
          expect(await contextStore.get(metaRef())).toMatchObject({
            targetResidency: "suspended",
          });
      }
    },
  );

  it.each(["recovered", "exhausted", "suspended"] as const)(
    "retains accepted input after preparation fails: %s",
    async (outcome) => {
      vi.useFakeTimers();
      const ghostStore = createInMemoryGhostStore<TestRuntime>();
      const contextStore = new PushContextStore();
      const runWakes = new RecordingRunWakes();
      await seedGhost(ghostStore);
      await contextStore.ensure(metaRef(), "active");
      const preparationTimeout = new Error("preparation retired after timeout");
      const harness = createHarness({
        ghostStore,
        contextStore,
        runWakes,
        shouldActivateOnRestore: async () => false,
        createRuntime: () => {
          const fake = new FakeRuntime();
          fake.startError = preparationTimeout;
          return fake;
        },
        restoreRecovery: {
          isRecoverable: ({ error }) => error === preparationTimeout,
          retryDelayMs: 1000,
          maxRetryAttempts: 1,
        },
      });
      await harness.manager.restore();
      const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
      expect(fake.calls).toEqual(["create"]);
      // TeamHub queued the Run; the Context only has to take it up.
      runWakes.targets[0]!.wake("queued");
      await vi.advanceTimersByTimeAsync(999);
      expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);
      expect(fake.calls).not.toContain("queued:queued");
      if (outcome === "recovered") fake.startError = null;
      if (outcome === "suspended")
        await harness.manager.suspendContext(metaRef());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fake.calls.filter((call) => call === "start")).toHaveLength(
        outcome === "suspended" ? 1 : 2,
      );
      expect(await contextStore.get(metaRef())).toMatchObject({
        targetResidency: outcome === "recovered" ? "active" : "suspended",
      });
      expect(harness.manager.wakeDeferredContextRestores(() => true)).toBe(0);
    },
  );

  it("logs non-negative activation timing for queued input on a cold Context", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AGENT_LOG_LEVEL", "debug");
    setAgentLogOptions({ format: "json" });
    const standardOutput = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const runWakes = new RecordingRunWakes();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      runWakes,
      shouldActivateOnRestore: async () => false,
      createRuntime: () => {
        const fake = new FakeRuntime();
        return fake;
      },
    });
    await harness.manager.restore();
    runWakes.targets[0]!.wake("queued");
    await vi.advanceTimersByTimeAsync(1000);
    const entries = standardOutput.mock.calls.map(([line]) =>
      JSON.parse(String(line)),
    );
    const requested = entries.find(
      (entry) =>
        entry.event === "activation.requested" &&
        entry.reason === "queued_input",
    );
    const started = entries.find(
      (entry) =>
        entry.event === "activation.started" && entry.reason === "queued_input",
    );
    expect(requested).toMatchObject({
      kind: "queued",
      lifecycleWaitMs: expect.any(Number),
    });
    expect(started).toMatchObject({
      transitionWaitMs: expect.any(Number),
      activationCheckMs: expect.any(Number),
    });
    for (const entry of [requested, started])
      for (const [key, value] of Object.entries(entry ?? {}))
        if (typeof value === "number" && key.endsWith("Ms"))
          expect(value).toBeGreaterThanOrEqual(0);
  });

  it("queued-input wakes respect an existing offline backoff", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const runWakes = new RecordingRunWakes();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const offline = new LocalComputerOfflineError();
    const harness = createHarness({
      ghostStore,
      contextStore,
      runWakes,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = offline;
        return fake;
      },
      restoreRecovery: {
        isRecoverable: ({ error }) => error === offline,
        retryDelayMs: 300_000,
      },
    });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    for (let index = 0; index < 3; index++) {
      runWakes.targets[0]!.wake("queued");
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);
    fake.startError = null;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await harness.manager.getContextStatus(metaRef())).toBe("active");
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
  });

  it("replaces a ready Context whose Agent moved before taking up queued input", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const runWakes = new RecordingRunWakes();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const created: FakeRuntime[] = [];
    const harness = createHarness({
      ghostStore,
      contextStore,
      runWakes,
      createRuntime: () => {
        const fake = new FakeRuntime();
        created.push(fake);
        return fake;
      },
    });
    await harness.manager.restore();
    await vi.waitFor(async () =>
      expect(await harness.manager.getContextStatus(metaRef())).toBe("active"),
    );
    runWakes.target(metaRef()).wake("queued");
    await vi.waitFor(() =>
      expect(created[0]!.calls).toContain("queued:queued"),
    );

    // TeamHub committed a move; the registration change refreshed the Ghost.
    const current = (await ghostStore.get("agent-1"))!;
    await ghostStore.replace!("agent-1", current.revision, {
      ...current,
      revision: "revision-2",
    });
    runWakes.target(metaRef()).wake("queued");

    await vi.waitFor(() => expect(created).toHaveLength(2));
    await vi.waitFor(() =>
      expect(created[1]!.calls).toContain("queued:queued"),
    );
    expect(created[0]!.calls).toContain("stop");
    expect(
      created[0]!.calls.filter((call) => call === "queued:queued"),
    ).toHaveLength(1);
    expect(created[1]!.configurationRevision).toBe("revision-2");
  });

  it("a profile-only edit does not replace the Runtime", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const runWakes = new RecordingRunWakes();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const created: FakeRuntime[] = [];
    const harness = createHarness({
      ghostStore,
      contextStore,
      runWakes,
      createRuntime: () => {
        const fake = new FakeRuntime();
        created.push(fake);
        return fake;
      },
    });
    await harness.manager.restore();
    await vi.waitFor(async () =>
      expect(await harness.manager.getContextStatus(metaRef())).toBe("active"),
    );
    runWakes.target(metaRef()).wake("queued");
    await vi.waitFor(() =>
      expect(created[0]!.calls).toContain("queued:queued"),
    );

    // TeamHub committed a profile edit: a newer revision whose Runtime and
    // placement are unchanged. The next claim delivers the profile update.
    const current = (await ghostStore.get("agent-1"))!;
    await ghostStore.replace!("agent-1", current.revision, {
      ...current,
      revision: "revision-2",
      runtimeRevision: current.revision,
      agent: { ...current.agent, name: "Renamed" },
    });
    runWakes.target(metaRef()).wake("queued");

    await vi.waitFor(() =>
      expect(
        created[0]!.calls.filter((call) => call === "queued:queued"),
      ).toHaveLength(2),
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.calls).not.toContain("stop");
  });

  it("explicit suspension wins over an in-flight restore snapshot", async () => {
    vi.useFakeTimers();
    const readStarted = new Deferred();
    const releaseRead = new Deferred();
    class DelayedReadStore extends PushContextStore {
      holdRead = false;
      override async get(ref: ExecutionContextRef) {
        const record = await super.get(ref);
        if (this.holdRead) {
          this.holdRead = false;
          readStarted.resolve();
          await releaseRead.promise;
        }
        return record;
      }
    }
    const contextStore = new DelayedReadStore();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const offline = new LocalComputerOfflineError();
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = offline;
        return fake;
      },
      restoreRecovery: {
        isRecoverable: ({ error }) => error === offline,
        retryDelayMs: 1000,
      },
    });
    await harness.manager.restore();
    contextStore.holdRead = true;
    await vi.advanceTimersByTimeAsync(1000);
    await readStarted.promise;
    const suspension = harness.manager.suspendContext(metaRef());
    await vi.advanceTimersByTimeAsync(0);
    releaseRead.resolve();
    await suspension;
    await vi.advanceTimersByTimeAsync(0);
    expect(await contextStore.get(metaRef())).toMatchObject({
      targetResidency: "suspended",
    });
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    expect(fake.calls).not.toContain("deactivate");
    await expect(harness.manager.getContextStatus(metaRef())).resolves.toBe(
      "suspended",
    );
    expect(harness.manager.wakeDeferredContextRestores(() => true)).toBe(0);
  });

  it("keeps offline work recoverable beyond six retries, across restart, and wakes only once", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AGENT_LOG_LEVEL", "info");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    let contextStore = new PushContextStore();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const offline = new LocalComputerOfflineError();
    const recovery: ContextRestoreRecovery<TestRuntime> = {
      isRecoverable: ({ error }) => error === offline,
      maxRetryAttempts: resolveContextRestoreMaxRetryAttempts,
      retryDelayMs: resolveContextRestoreRetryDelayMs,
    };
    const makeHarness = () =>
      createHarness({
        ghostStore,
        contextStore,
        restoreRecovery: recovery,
        createRuntime: () => {
          const fake = new FakeRuntime();
          fake.startError = offline;
          return fake;
        },
      });
    const first = makeHarness();
    await first.manager.restore();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(await contextStore.get(metaRef())).toMatchObject({
      targetResidency: "active",
    });
    const fake = first.fakes.get(encodeExecutionContextRef(metaRef()))!;
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(9);
    expect(fake.calls).not.toContain("suspend:start");
    expect(errors).not.toHaveBeenCalled();
    const persisted = await contextStore.list();
    await first.manager.close();
    contextStore = new PushContextStore();
    for (const record of persisted)
      await contextStore.ensure(record.ref, record.targetResidency);
    const second = makeHarness();
    await second.manager.restore();
    const recovered = second.fakes.get(encodeExecutionContextRef(metaRef()))!;
    recovered.startError = null;
    expect(second.manager.wakeDeferredContextRestores(() => true)).toBe(1);
    expect(second.manager.wakeDeferredContextRestores(() => true)).toBe(0);
    await contextStore.publish(metaRef(), "active");
    await vi.advanceTimersByTimeAsync(0);
    expect(await second.manager.getContextStatus(metaRef())).toBe("active");
    expect(recovered.calls.filter((call) => call === "start")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(recovered.calls.filter((call) => call === "start")).toHaveLength(2);
  });

  it("finishes retry-budget suspension before reconciling a concurrent active snapshot", async () => {
    vi.useFakeTimers();
    const suspensionWrite = new Deferred();
    const suspensionStarted = new Deferred();
    class DelayedSuspendStore extends PushContextStore {
      override async setTargetResidency(
        ref: ExecutionContextRef,
        target: ContextTargetResidency,
      ) {
        if (target === "suspended") {
          suspensionStarted.resolve();
          await suspensionWrite.promise;
        }
        return super.setTargetResidency(ref, target);
      }
    }
    const contextStore = new DelayedSuspendStore();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const unavailable = new Error("dependency unavailable");
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = unavailable;
        return fake;
      },
      restoreRecovery: {
        isRecoverable: ({ error }) => error === unavailable,
        maxRetryAttempts: 1,
        retryDelayMs: 1_000,
      },
    });
    await harness.manager.restore();
    await vi.advanceTimersByTimeAsync(1_000);
    await suspensionStarted.promise;
    await contextStore.publish(metaRef(), "active");
    await vi.advanceTimersByTimeAsync(0);
    suspensionWrite.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    expect(await contextStore.get(metaRef())).toMatchObject({
      targetResidency: "suspended",
    });
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
    expect(fake.calls).not.toContain("resume");
  });

  it("suspends a recoverable restored Context after its retry budget", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const unavailable = new Error("TeamHub is unavailable");
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = unavailable;
        return fake;
      },
      restoreRecovery: {
        isRecoverable: ({ error }) => error === unavailable,
        maxRetryAttempts: 2,
        retryDelayMs: ({ retryAttempt }) => retryAttempt * 1_000,
      },
    });

    await expect(harness.manager.restore()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await contextStore.get(metaRef())).toEqual({
      ref: metaRef(),
      roomKind: "collaboration",
      targetResidency: "suspended",
    });
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(3);
    await expect(harness.manager.getContextStatus(metaRef())).resolves.toBe(
      "suspended",
    );
  });

  it("rejects registering an existing Agent identity with a different definition", async () => {
    const harness = createHarness();
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });

    await expect(
      harness.manager.registerAgent(
        { ...registration, agent: { ...registration.agent, name: "Other" } },
        { agentId: "agent-1" },
      ),
    ).rejects.toMatchObject({ code: "agent_registration_conflict" });
    expect((await harness.ghostStore.get("agent-1"))?.agent.name).toBe(
      registration.agent.name,
    );
  });

  it("keeps registered Agents cold and materializes only the addressed Room", async () => {
    const harness = createHarness();

    await harness.manager.registerAgent(registration, {
      agentId: "agent-1",
    });
    await expect(harness.contextStore.list()).resolves.toEqual([]);
    expect(harness.fakes).toHaveLength(0);

    const room1 = roomMetaRef("room-1");
    const room2 = roomMetaRef("room-2");
    await expect(
      harness.manager.submitTrustedTurn({
        target: room1,
        messages: [
          {
            ...message("room-1-message"),
            sourceInboxIds: ["room:room-1"],
          },
        ],
      }),
    ).resolves.toEqual({ agentRunRef: expect.any(String) });

    const room1Fake = harness.fakes.get(encodeExecutionContextRef(room1));
    expect(room1Fake?.calls).toContain("submitTrustedTurn");
    expect(room1Fake?.received[0]?.[0]?.sourceInboxIds).toEqual([
      "room:room-1",
    ]);
    expect(harness.fakes.has(encodeExecutionContextRef(room2))).toBe(false);
  });

  it("reads debug history from a cold persisted Context without activating it", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const ref = roomMetaRef("room-history");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.persistedSession = { threadId: "thread-history" };
        return fake;
      },
    });

    expect(harness.fakes).toHaveLength(0);
    await expect(
      harness.manager.inspectDebugContextHistory(ref, {}),
    ).resolves.toEqual(availableHistory());

    const fake = harness.fakes.get(encodeExecutionContextRef(ref));
    expect(fake?.calls).toEqual(["create", "inspectRuntimeHistory"]);
    await expect(contextStore.get(ref)).resolves.toEqual({
      ref,
      roomKind: "collaboration",
      targetResidency: "suspended",
    });

    const missing = roomMetaRef("room-missing");
    await expect(
      harness.manager.inspectDebugContextHistory(missing, {}),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "Execution Context is not persisted",
    });
    await expect(contextStore.get(missing)).resolves.toBeNull();
    expect(harness.fakes.has(encodeExecutionContextRef(missing))).toBe(false);
  });

  it("reads debug history of persisted Contexts without binding them", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore, "agent-1");
    const refs = ["room-a", "room-b", "room-c"].map((roomId) =>
      roomMetaRef(roomId),
    );
    for (const ref of refs) await contextStore.ensure(ref, "suspended");
    const runWakes = new RecordingRunWakes();
    const registerTarget = vi.spyOn(runWakes, "registerTarget");
    const inspectDetachedHistory = vi.fn(async () => availableHistory());
    const harness = createHarness({
      ghostStore,
      contextStore,
      runWakes,
      inspectDetachedHistory,
    });

    for (const ref of refs) {
      await expect(
        harness.manager.inspectDebugContextHistory(ref, {}),
      ).resolves.toEqual(availableHistory());
    }

    expect(inspectDetachedHistory).toHaveBeenCalledTimes(3);
    expect(inspectDetachedHistory).toHaveBeenNthCalledWith(1, {
      ref: refs[0],
      runtime: registration.runtime,
      options: {},
    });
    expect(harness.fakes).toHaveLength(0);
    expect(registerTarget).not.toHaveBeenCalled();
  });

  it("uses the bound executor for debug history when one is restored", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const ref = roomMetaRef("room-live-history");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const inspectDetachedHistory = vi.fn(async () => availableHistory());
    const harness = createHarness({
      ghostStore,
      contextStore,
      inspectDetachedHistory,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.persistedSession = { threadId: "thread-history" };
        return fake;
      },
    });
    await harness.manager.ensureBinding(ref);

    await expect(
      harness.manager.inspectDebugContextHistory(ref, {}),
    ).resolves.toEqual(availableHistory());

    const fake = harness.fakes.get(encodeExecutionContextRef(ref));
    expect(fake?.calls).toContain("inspectRuntimeHistory");
    expect(inspectDetachedHistory).not.toHaveBeenCalled();
  });

  it("rejects debug history for missing or terminal Contexts and unknown Agents without detached reads", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore, "agent-1");
    const terminal = roomMetaRef("room-terminal");
    const getRecord = contextStore.get.bind(contextStore);
    vi.spyOn(contextStore, "get").mockImplementation(async (ref) =>
      encodeExecutionContextRef(ref) === encodeExecutionContextRef(terminal)
        ? {
            ref,
            targetResidency: "suspended",
            terminalReason: "room_deleted",
          }
        : getRecord(ref),
    );
    const inspectDetachedHistory = vi.fn(async () => availableHistory());
    const harness = createHarness({
      ghostStore,
      contextStore,
      inspectDetachedHistory,
    });

    await expect(
      harness.manager.inspectDebugContextHistory(
        roomMetaRef("room-missing"),
        {},
      ),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "Execution Context is not persisted",
    });
    await expect(
      harness.manager.inspectDebugContextHistory(terminal, {}),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "Execution Context is not persisted",
    });
    await expect(
      harness.manager.inspectDebugContextHistory(
        roomMetaRef("room-x", "agent-unknown"),
        {},
      ),
    ).rejects.toMatchObject({ code: "agent_not_registered" });
    expect(inspectDetachedHistory).not.toHaveBeenCalled();
  });

  it("restores cold per-Room run wake targets and wakes only the addressed Context", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const runWakes = new RecordingRunWakes();
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(roomMetaRef("room-1"), "suspended");
    await contextStore.ensure(roomMetaRef("room-2"), "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      runWakes,
    });

    await expect(harness.manager.restore()).resolves.toBeUndefined();

    expect(harness.fakes).toHaveLength(2);
    expect(runWakes.targets.map(({ ref }) => ref)).toEqual([
      roomMetaRef("room-1"),
      roomMetaRef("room-2"),
    ]);
    for (const fake of harness.fakes.values()) {
      expect(fake.calls).toEqual(["create"]);
    }
    await expect(harness.contextStore.list()).resolves.toHaveLength(2);
    const persistedTransitionsBeforeWake = contextStore.persistedTransitions;

    runWakes.target(roomMetaRef("room-1")).wake("queued");
    const firstFake = harness.fakes.get(
      encodeExecutionContextRef(roomMetaRef("room-1")),
    )!;
    await vi.waitFor(() => expect(firstFake.calls).toContain("queued:queued"));
    expect(firstFake.calls.indexOf("resume")).toBeLessThan(
      firstFake.calls.indexOf("queued:queued"),
    );
    // TeamHub queued the Run without touching the Context; activation
    // records the active residency.
    expect(contextStore.persistedTransitions).toBe(
      persistedTransitionsBeforeWake + 1,
    );
    expect(
      harness.fakes.get(encodeExecutionContextRef(roomMetaRef("room-2")))
        ?.calls,
    ).toEqual(["create"]);
    await expect(
      contextStore.get(roomMetaRef("room-2")),
    ).resolves.toMatchObject({ targetResidency: "suspended" });
  });

  it("activates different Rooms of one Agent concurrently for queued input", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const runWakes = new RecordingRunWakes();
    const first = roomMetaRef("room-1");
    const second = roomMetaRef("room-2");
    const firstResume = new Deferred();
    const secondResume = new Deferred();
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(first, "suspended");
    await contextStore.ensure(second, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      runWakes,
      createRuntime: (ref) => {
        const fake = new FakeRuntime();
        // Both Rooms ran before; activation resumes their sessions.
        fake.persistedSession = { threadId: "thread-persisted" };
        fake.resumeGate =
          encodeExecutionContextRef(ref) === encodeExecutionContextRef(first)
            ? firstResume
            : secondResume;
        return fake;
      },
    });
    await harness.manager.restore();
    const [firstTarget, secondTarget] = runWakes.targets;
    const firstFake = harness.fakes.get(encodeExecutionContextRef(first))!;
    const secondFake = harness.fakes.get(encodeExecutionContextRef(second))!;

    try {
      firstTarget!.wake("queued");
      await vi.waitFor(() => expect(firstFake.calls).toContain("resume"));

      // The second Room activates while the first is still resuming.
      secondTarget!.wake("queued");
      await vi.waitFor(() => expect(secondFake.calls).toContain("resume"));
    } finally {
      firstResume.resolve();
      secondResume.resolve();
    }
    await vi.waitFor(async () => {
      await expect(harness.manager.getContextStatus(first)).resolves.toBe(
        "active",
      );
      await expect(harness.manager.getContextStatus(second)).resolves.toBe(
        "active",
      );
    });
  });

  it.each([
    { name: "Local Codex", type: "local", runtimeType: "codex", steers: true },
    {
      name: "Local Claude",
      type: "local",
      runtimeType: "claude",
      steers: false,
    },
    { name: "Local Pi", type: "local", runtimeType: "pi", steers: false },
  ])(
    "routes Another Me flashback through the $name provider",
    async ({ type, runtimeType, steers }) => {
      const runWakes = new RecordingRunWakes();
      const client = {
        suggest: vi.fn(
          async (): Promise<FlashbackResponse> => ({
            reason: "suggested",
            suggestion: {
              episode: "daily/2026-08-25",
              title: "Earlier project decision",
              date: "2026-08-25",
              cue: {
                id: "projects/test",
                title: "Test Project",
                via: "name",
              },
              ties: ["mention"],
              strength: 0.9,
              score: 0.8,
              situation: "The owner selected a small trial.",
              decisions: ["Start with a small trial."],
              completed: [],
              openItems: [],
            },
          }),
        ),
        record: vi.fn(async () => undefined),
      };
      const flashback = {
        client,
        settings: {
          followUpWindowMs: 60_000,
          followUpMinScore: 0.6,
          claimWaitMs: 0,
        },
      };
      const harness = createHarness({
        runWakes,
        flashback,
        identityResolver: async (agentId) => ({
          ...resolvedIdentity(agentId),
          agentType: "anotherme",
          representedHuman: { actorId: "human-owner", displayName: "Owner" },
        }),
      });
      const runtime = {
        ...registration.runtime,
        type,
        placement: { type: "local", computerId: "computer-1", runtimeType },
      };
      await harness.manager.registerAgent(
        { ...registration, runtime },
        { agentId: "agent-1" },
      );
      await harness.manager.startContext(metaRef());
      const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
      // TeamHub queued the owner's Message; its Run is still replying.
      fake.holdRuns = true;
      const runId = fake.state.queueInboxRun([message("queued-input")]);
      runWakes.target(metaRef()).wake("queued");
      await vi.waitFor(() => expect(fake.currentRun).toBeDefined());
      // The executor took up a queued Inbox input carrying the owner's Message.
      const fact = inboxInputFact(
        {
          ...message("flashback-input"),
          acceptedNotification: {
            inboxId: "room:room-1",
            through: "1",
            targeted: false,
            messages: [
              {
                id: "owner-message",
                body: "What did we decide?",
                authorActorId: "human-owner",
                authorType: "user",
                mentioned: false,
              },
            ],
          },
        } as Message,
        { kind: "enqueue", runId },
      );
      harness.composed
        .get(encodeExecutionContextRef(metaRef()))!
        .afterInboxInputAccepted(fact!);
      await vi.waitFor(() =>
        expect(client.suggest).toHaveBeenCalledWith({
          tenant_id: registration.tenantId,
          owner_actor_id: "human-owner",
          room_id: "room-1",
          text: "What did we decide?",
        }),
      );
      if (steers) {
        await vi.waitFor(() => expect(client.record).toHaveBeenCalledOnce());
        expect(fake.steered.at(-1)?.rawMessage).toContain(
          '<historical_context source="flashback">',
        );
      } else {
        await vi.waitFor(() =>
          expect(
            harness.featureLogEntries.some(
              (entry) => entry.event === "flashback.outcome",
            ),
          ).toBe(true),
        );
        expect(fake.steered).toEqual([]);
        expect(client.record).not.toHaveBeenCalled();
      }
      expect(fake.calls).not.toContain("submitTrustedTurn");
      fake.currentRun!.succeed();
    },
  );

  it("keeps an active ready Context on its current residency after an Inbox notification", async () => {
    const contextStore = new PushContextStore();
    const runWakes = new RecordingRunWakes();
    const harness = createHarness({ contextStore, runWakes });

    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    await harness.manager.ensureBinding(metaRef());
    await vi.waitFor(() => expect(runWakes.targets).toHaveLength(1));
    await harness.manager.startContext(metaRef());
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    await vi.waitFor(() => expect(fake.calls).toContain("start"));
    await expect(harness.manager.getContextStatus(metaRef())).resolves.toBe(
      "active",
    );
    const persistedTransitionsBeforeDelivery =
      contextStore.persistedTransitions;

    runWakes.target(metaRef()).wake("queued");
    await vi.waitFor(() => expect(fake.calls).toContain("queued:queued"));
    await harness.manager.close();

    expect(contextStore.persistedTransitions).toBe(
      persistedTransitionsBeforeDelivery,
    );
  });

  it("reactivates an active Context whose Runtime is not ready after an Inbox notification", async () => {
    const contextStore = new PushContextStore();
    const runWakes = new RecordingRunWakes();
    const harness = createHarness({ contextStore, runWakes });

    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    await harness.manager.ensureBinding(metaRef());
    await vi.waitFor(() => expect(runWakes.targets).toHaveLength(1));
    await harness.manager.startContext(metaRef());
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    await exhaustRuntimeRecovery(fake, () =>
      runWakes.target(metaRef()).wake("queued"),
    );
    const activationsBeforeDelivery = fake.activations.length;
    const persistedTransitionsBeforeDelivery =
      contextStore.persistedTransitions;

    fake.state.queueInboxRun([message("after-recovery")]);
    runWakes.target(metaRef()).wake("queued");
    await vi.waitFor(() =>
      expect(fake.activations).toHaveLength(activationsBeforeDelivery + 1),
    );
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    await harness.manager.close();

    // The Context already targets active residency, so nothing is persisted.
    expect(contextStore.persistedTransitions).toBe(
      persistedTransitionsBeforeDelivery,
    );
  });

  it.each(["general", "anotherme"] as const)(
    "defers %s update and idempotent replay until registration is active",
    async (agentType) => {
      vi.useFakeTimers();
      let active = true;
      const ghostStore = Object.assign(
        createInMemoryGhostStore<TestRuntime>(),
        {
          isActivationReady: vi.fn(async () => active),
        },
      );
      const contextStore = new PushContextStore([]);
      const harness = createHarness({
        ghostStore,
        contextStore,
        identityResolver: async (agentId) => {
          if (!active)
            throw new AgentIdentityResolutionError(
              "not_found",
              "registration is updating",
            );
          return { ...resolvedIdentity(agentId), agentType };
        },
        restoreRecovery: { isRecoverable: () => false, retryDelayMs: 10 },
      });
      await harness.manager.registerAgent(registration, { agentId: "agent-1" });
      await harness.manager.restore();
      await harness.manager.startContext(metaRef());
      const original = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
      active = false;
      const update = {
        expectedRevision: "revision-1",
        revision: "revision-2",
        agent: registration.agent,
        runtime: { model: "updated-model" },
        resources: { skills: [], mcpServers: [] },
      };
      await expect(
        harness.manager.updateAgent("agent-1", update),
      ).resolves.toEqual({
        agentId: "agent-1",
        revision: "revision-2",
      });
      await harness.manager.updateAgent("agent-1", update);
      await contextStore.publish(metaRef(), "active");
      await vi.advanceTimersByTimeAsync(30);
      expect(original.calls).toContain("stop");
      expect(harness.fakes.get(encodeExecutionContextRef(metaRef()))).toBe(
        original,
      );
      expect(await contextStore.get(metaRef())).toMatchObject({
        targetResidency: "active",
      });
      active = true;
      await vi.advanceTimersByTimeAsync(10);
      const replacement = harness.fakes.get(
        encodeExecutionContextRef(metaRef()),
      )!;
      expect(replacement).not.toBe(original);
      expect(replacement.calls.filter((call) => call === "start")).toHaveLength(
        1,
      );
      expect(replacement.configurationRevision).toBe("revision-2");
    },
  );

  it("defers restart recovery and store sync while registration is updating", async () => {
    vi.useFakeTimers();
    let active = false;
    const ghostStore = Object.assign(createInMemoryGhostStore<TestRuntime>(), {
      isActivationReady: async () => active,
    });
    await seedGhost(ghostStore);
    const contextStore = new PushContextStore([]);
    await contextStore.ensure(metaRef(), "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      restoreRecovery: { isRecoverable: () => false, retryDelayMs: 10 },
    });
    await harness.manager.restore();
    await contextStore.publish(metaRef(), "active");
    await vi.advanceTimersByTimeAsync(30);
    expect(harness.fakes.size).toBe(0);
    expect(await contextStore.get(metaRef())).toMatchObject({
      targetResidency: "active",
    });
    active = true;
    await vi.advanceTimersByTimeAsync(10);
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);
  });

  it.each(["active", "suspended"] as const)(
    "does not resolve identity before registration is active for a restored %s Context",
    async (residency) => {
      vi.useFakeTimers();
      let active = false;
      const identityResolver = vi.fn(async (agentId: string) => {
        if (!active)
          throw new AgentIdentityResolutionError(
            "not_found",
            "general updating identity returns 404",
          );
        return resolvedIdentity(agentId);
      });
      const ghostStore = Object.assign(
        createInMemoryGhostStore<TestRuntime>(),
        { isActivationReady: async () => active },
      );
      await seedGhost(ghostStore);
      const contextStore = new PushContextStore();
      await contextStore.ensure(metaRef(), residency);
      const harness = createHarness({
        ghostStore,
        contextStore,
        identityResolver,
        restoreRecovery: { isRecoverable: () => false, retryDelayMs: 10 },
      });
      await harness.manager.restore();
      await contextStore.publish(metaRef(), residency);
      await vi.advanceTimersByTimeAsync(30);
      expect(identityResolver).not.toHaveBeenCalled();
      expect(harness.fakes.size).toBe(0);
      expect(await contextStore.get(metaRef())).toMatchObject({
        targetResidency: residency,
      });
      active = true;
      await vi.advanceTimersByTimeAsync(10);
      expect(identityResolver).toHaveBeenCalledTimes(1);
      const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
      expect(fake.calls.filter((call) => call === "start")).toHaveLength(
        residency === "active" ? 1 : 0,
      );
      expect(await contextStore.get(metaRef())).toMatchObject({
        targetResidency: residency,
      });
    },
  );

  it.each(["agent_activation_rejected", "agent_revision_conflict"] as const)(
    "does not retry %s after a pending registration becomes invalid",
    async (code) => {
      vi.useFakeTimers();
      const check = vi.fn(async () => false);
      const ghostStore = Object.assign(
        createInMemoryGhostStore<TestRuntime>(),
        { isActivationReady: check },
      );
      await seedGhost(ghostStore);
      const contextStore = new PushContextStore();
      await contextStore.ensure(metaRef(), "active");
      const harness = createHarness({
        ghostStore,
        contextStore,
        restoreRecovery: { isRecoverable: () => false, retryDelayMs: 10 },
      });
      await harness.manager.restore();
      check.mockRejectedValue(
        new AgentManagerError(code, "registration no longer usable"),
      );
      await vi.advanceTimersByTimeAsync(10);
      const checks = check.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      expect(check).toHaveBeenCalledTimes(checks);
      expect(harness.fakes.size).toBe(0);
      expect(await contextStore.get(metaRef())).toMatchObject({
        targetResidency:
          code === "agent_activation_rejected" ? "suspended" : "active",
      });
      if (code === "agent_revision_conflict") {
        check.mockResolvedValue(true);
        await harness.manager.updateAgent("agent-1", {
          expectedRevision: "revision-1",
          revision: "revision-2",
          agent: registration.agent,
          runtime: { model: "new" },
          resources: { skills: [], mcpServers: [] },
        });
        expect(
          harness.fakes.get(encodeExecutionContextRef(metaRef()))!.calls,
        ).toContain("start");
      }
    },
  );

  it("hands a racing identity 404 back to registration waiting without an independent identity retry", async () => {
    vi.useFakeTimers();
    let active = true;
    const identityResolver = vi.fn(async (agentId: string) => {
      if (identityResolver.mock.calls.length === 1) {
        active = false;
        throw new AgentIdentityResolutionError(
          "not_found",
          "registration entered updating",
        );
      }
      if (!active) throw new Error("identity retry bypassed registration gate");
      return resolvedIdentity(agentId);
    });
    const ghostStore = Object.assign(createInMemoryGhostStore<TestRuntime>(), {
      isActivationReady: async () => active,
    });
    await seedGhost(ghostStore);
    const contextStore = new PushContextStore();
    await contextStore.ensure(metaRef(), "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      identityResolver,
      restoreRecovery: { isRecoverable: () => false, retryDelayMs: 10 },
    });
    await harness.manager.restore();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(identityResolver).toHaveBeenCalledTimes(1);
    expect(harness.fakes.size).toBe(0);
    active = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(identityResolver).toHaveBeenCalledTimes(2);
    expect(
      harness.fakes.get(encodeExecutionContextRef(metaRef()))!.calls,
    ).toContain("start");
  });

  it("rechecks registration when MCP rejects an activation racing an update", async () => {
    vi.useFakeTimers();
    let active = true;
    const rejected = new Error("MCP context_identity_invalid");
    const ghostStore = Object.assign(createInMemoryGhostStore<TestRuntime>(), {
      isActivationReady: async () => active,
    });
    await seedGhost(ghostStore);
    const contextStore = new PushContextStore();
    await contextStore.ensure(metaRef(), "active");
    const fake = new FakeRuntime();
    fake.onActivate = () => {
      if (active) {
        active = false;
        throw rejected;
      }
    };
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => fake,
      restoreRecovery: {
        isRecoverable: () => false,
        shouldSuspend: ({ error }) => error === rejected,
        retryDelayMs: 10,
      },
    });
    await harness.manager.restore();
    expect(await contextStore.get(metaRef())).toMatchObject({
      targetResidency: "active",
    });
    fake.onActivate = null;
    active = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
  });

  it("does not deadlock when a Context write publishes synchronously during update", async () => {
    class ReentrantStore extends PushContextStore {
      override async setTargetResidency(
        ref: ExecutionContextRef,
        residency: ContextTargetResidency,
      ) {
        const result = await super.setTargetResidency(ref, residency);
        await this.publish(ref, residency);
        return result;
      }
    }
    const contextStore = new ReentrantStore();
    const harness = createHarness({ contextStore });
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    await harness.manager.restore();
    await harness.manager.startContext(metaRef());
    await harness.manager.updateAgent("agent-1", {
      expectedRevision: "revision-1",
      revision: "revision-2",
      agent: registration.agent,
      runtime: { model: "new" },
      resources: { skills: [], mcpServers: [] },
    });
    await vi.waitFor(() =>
      expect(
        harness.fakes.get(encodeExecutionContextRef(metaRef()))!.calls,
      ).toContain("start"),
    );
    expect(
      harness.fakes.get(encodeExecutionContextRef(metaRef()))!
        .configurationRevision,
    ).toBe("revision-2");
  });

  it("replaces Agent configuration by revision and restarts active Contexts", async () => {
    const harness = createHarness();
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    await harness.manager.startContext(metaRef());
    const key = encodeExecutionContextRef(metaRef());
    await vi.waitFor(() => {
      expect(harness.fakes.get(key)?.calls).toContain("start");
    });
    const originalFake = harness.fakes.get(key)!;

    await expect(
      harness.manager.updateAgent("agent-1", {
        expectedRevision: "revision-1",
        revision: "revision-2",
        agent: {
          name: "Updated Context Agent",
          instructions: "Use the updated profile.",
        },
        runtime: { model: "updated-model" },
        resources: {
          skills: [
            {
              skillId: "simplexai_create_meeting_minutes",
              manifestVersion: "1.0.0",
              name: "Create Meeting Minutes",
              packageName: "create-meeting-minutes",
              packageSha256: "a".repeat(64),
              config: {},
            },
          ],
          mcpServers: [],
        },
      }),
    ).resolves.toEqual({ agentId: "agent-1", revision: "revision-2" });

    expect(originalFake.calls).toContain("stop");
    await vi.waitFor(() => {
      const replacementFake = harness.fakes.get(key);
      expect(replacementFake).not.toBe(originalFake);
      expect(replacementFake?.calls).toContain("start");
      expect(replacementFake?.runtimeSettings).toEqual({
        model: "updated-model",
      });
    });
    await expect(harness.manager.getGhost("agent-1")).resolves.toMatchObject({
      revision: "revision-2",
      agent: { name: "Updated Context Agent" },
      runtime: { model: "updated-model" },
      resources: {
        skills: [
          expect.objectContaining({
            skillId: "simplexai_create_meeting_minutes",
          }),
        ],
      },
    });
  });

  it("replays lifecycle hooks when a cold manager already reads the reserved target revision", async () => {
    const harness = createHarness();
    await seedGhost(harness.ghostStore);
    const calls: string[] = [];
    const update = {
      expectedRevision: "previous-revision",
      revision: "revision-1",
      agent: registration.agent,
      runtime: registration.runtime,
      resources: registration.resources,
    };
    await harness.manager.updateAgent("agent-1", update, {
      beforeReplacement: async () => {
        calls.push("validate");
      },
      afterLoadedContextsDisposed: async () => {
        calls.push("rebind");
      },
    });
    expect(calls).toEqual(["validate", "rebind"]);
    expect((await harness.manager.getGhost("agent-1"))?.revision).toBe(
      "revision-1",
    );
  });

  it("reconciles an independently committed profile before a Human update without bypassing busy checks", async () => {
    const store = createInMemoryGhostStore<TestRuntime>();
    const replace = store.replace!.bind(store);
    const authoritative = vi.fn(async () => true);
    Object.assign(store, {
      isReplacementCurrent: authoritative,
      replace: async (
        id: string,
        _expected: string,
        next: Ghost<TestRuntime>,
      ) => replace(id, (await store.get(id))!.revision, next),
    });
    const harness = createHarness({ ghostStore: store });
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    await harness.manager.startContext(metaRef());
    const key = encodeExecutionContextRef(metaRef());
    const old = harness.fakes.get(key)!;
    const update = {
      expectedRevision: "revision-2",
      revision: "revision-3",
      agent: { name: "Human edit", instructions: "Updated after CLI profile." },
      runtime: registration.runtime,
      resources: registration.resources,
    };
    old.busy = true;
    await expect(
      harness.manager.updateAgent("agent-1", update),
    ).rejects.toMatchObject({ code: "agent_busy" });
    expect(old.calls).not.toContain("stop");
    expect((await store.get("agent-1"))!.revision).toBe("revision-1");
    old.busy = false;
    authoritative.mockResolvedValueOnce(false);
    await expect(
      harness.manager.updateAgent("agent-1", update),
    ).rejects.toMatchObject({ code: "agent_revision_conflict" });
    await expect(
      harness.manager.updateAgent("agent-1", update),
    ).resolves.toMatchObject({ revision: "revision-3" });
    expect(old.calls).toContain("stop");
    expect(harness.fakes.get(key)).not.toBe(old);
    expect((await store.get("agent-1"))!.revision).toBe("revision-3");
  });

  // TeamHub commits a self-initialized profile without the Agent Service, so
  // loaded Contexts keep their revision and only the Ghost store moves on.
  const commitInitializedProfile = async (
    ghostStore: GhostStore<TestRuntime>,
  ): Promise<void> => {
    const current = (await ghostStore.get("agent-1"))!;
    await ghostStore.replace!("agent-1", current.revision, {
      ...current,
      revision: "revision-2",
      agent: {
        name: "Research Partner",
        instructions: "Investigate and synthesize evidence for the Sponsor.",
      },
    });
  };

  it("uses the initialized profile for a new Room and new Tasks from new or old Rooms", async () => {
    const harness = createHarness();
    await harness.manager.registerAgent(registration, {
      agentId: "agent-1",
    });
    await harness.manager.startContext(roomMetaRef("room-old"));
    await commitInitializedProfile(harness.ghostStore);

    const newRoom = roomMetaRef("room-new");
    const newRoomTask = alterEgoRef("task-from-new-room");
    const oldRoomTask = alterEgoRef("task-from-old-room");
    await harness.manager.startContext(newRoom);
    await harness.manager.startContext(newRoomTask);
    await harness.manager.startContext(oldRoomTask);

    for (const ref of [newRoom, newRoomTask, oldRoomTask]) {
      const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
      expect(fake.configurationRevision).toBe("revision-2");
      expect(fake.lastActivation?.agent).toMatchObject({
        name: "Research Partner",
        instructions: expect.stringContaining("Investigate and synthesize"),
      });
    }
    expect(
      harness.fakes.get(encodeExecutionContextRef(roomMetaRef("room-old")))
        ?.configurationRevision,
    ).toBe("revision-1");
  });

  it("refreshes a suspended old Room to the initialized profile before resuming", async () => {
    const harness = createHarness();
    await harness.manager.registerAgent(registration, {
      agentId: "agent-1",
    });
    const ref = roomMetaRef("room-old");
    const key = encodeExecutionContextRef(ref);
    await harness.manager.startContext(ref);
    const loaded = harness.fakes.get(key)!;
    await commitInitializedProfile(harness.ghostStore);

    await harness.manager.suspendContext(ref);
    await harness.manager.resumeContext(ref);

    const refreshed = harness.fakes.get(key)!;
    expect(refreshed).not.toBe(loaded);
    expect(loaded.calls).not.toContain("clearRuntimeSession");
    expect(loaded.calls).toContain("stop");
    expect(refreshed.configurationRevision).toBe("revision-2");
    expect(refreshed.lastActivation?.agent.name).toBe("Research Partner");
    expect(refreshed.lastActivation?.agent.developerInstructions).toContain(
      '"display_name":"Research Partner","actor_id":"actor:agent-1","agent_type":"general"',
    );
    expect(refreshed.activations).toHaveLength(1);
  });

  it("keeps an activation that starts while the profile refresh is awaiting authority", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const refreshEntered = new Deferred();
    const refreshRelease = new Deferred();
    let blockRefresh = false;
    let committed = false;
    Object.assign(ghostStore, {
      refresh: async (agentId: string) => {
        if (blockRefresh) {
          refreshEntered.resolve();
          await refreshRelease.promise;
        }
        const current = await ghostStore.get(agentId);
        if (current && committed && current.revision === "revision-1") {
          await ghostStore.replace!(agentId, current.revision, {
            ...current,
            revision: "revision-2",
          });
        }
      },
      isActivationReady: async () => true,
    });
    const harness = createHarness({ ghostStore });
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    await harness.manager.startContext(metaRef());
    await harness.manager.suspendContext(metaRef());
    const key = encodeExecutionContextRef(metaRef());
    const old = harness.fakes.get(key)!;
    old.receiveGate = new Deferred();
    old.resumeGate = new Deferred();
    const delivery = harness.manager.submitTrustedTurn({
      target: metaRef(),
      messages: [message("accepted-before-profile-commit")],
    });
    await vi.waitFor(() => expect(old.calls).toContain("submitTrustedTurn"));
    blockRefresh = true;
    const ensuring = harness.manager.ensureBinding(metaRef());
    await refreshEntered.promise;
    old.receiveGate.resolve();
    await vi.waitFor(() => expect(old.calls).toContain("resume"));
    committed = true;
    refreshRelease.resolve();
    let ensureFinished = false;
    void ensuring.then(() => {
      ensureFinished = true;
    });
    try {
      await vi.waitFor(() => expect(ensureFinished).toBe(true));
      expect(harness.fakes.get(key)).toBe(old);
      expect(old.calls).not.toContain("stop");
      expect(old.received.flat().map(({ messageId }) => messageId)).toEqual([
        "accepted-before-profile-commit",
      ]);
    } finally {
      old.resumeGate.resolve();
      await ensuring;
      await delivery;
    }
  });

  it.each(["suspended", "created"] as const)(
    "refreshes a %s Context on a durable work wake after standalone profile initialization",
    async (residency) => {
      const ghostStore = createInMemoryGhostStore<TestRuntime>();
      let committed = false;
      Object.assign(ghostStore, {
        refresh: async (agentId: string) => {
          const current = await ghostStore.get(agentId);
          if (current && committed && current.revision === "revision-1") {
            await ghostStore.replace!(agentId, current.revision, {
              ...current,
              revision: "revision-2",
              agent: { ...current.agent, name: "Saved profile" },
            });
          }
        },
        isActivationReady: async (_agentId: string, revision: string) => {
          if (committed && revision !== "revision-2") {
            throw new AgentManagerError(
              "agent_revision_conflict",
              "Stale profile",
            );
          }
          return true;
        },
      });
      await seedGhost(ghostStore);
      const contextStore = new PushContextStore();
      const ref = metaRef();
      await contextStore.ensure(
        ref,
        residency === "created" ? "active" : "suspended",
      );
      let hasQueuedWork = false;
      // A replacement reads the same durable queue.
      const databasePath = `refresh-${residency}-${randomUUID()}`;
      const harness = createHarness({
        ghostStore,
        contextStore,
        shouldActivateOnRestore: async () => hasQueuedWork,
        createRuntime: () => {
          const fake = new FakeRuntime();
          fake.databasePath = databasePath;
          return fake;
        },
      });
      await harness.manager.restore();
      const key = encodeExecutionContextRef(ref);
      const old = harness.fakes.get(key)!;
      committed = true;
      // TeamHub already accepted a Run; the old executor is busy with it.
      old.state.queueInboxRun([message("already-accepted-run")]);
      hasQueuedWork = true;
      await contextStore.publish(ref, "active");
      await vi.waitFor(() =>
        expect(harness.fakes.get(key)?.inputs).toHaveLength(1),
      );
      const refreshed = harness.fakes.get(key)!;
      expect(refreshed).not.toBe(old);
      expect(refreshed.configurationRevision).toBe("revision-2");
      expect(refreshed.lastActivation?.agent.name).toBe("Saved profile");
      expect(old.calls.filter((call) => call === "stop")).toHaveLength(1);
      expect(old.calls).not.toContain("clearRuntimeSession");
      expect(old.calls.some((call) => call.startsWith("cancelRun:"))).toBe(
        false,
      );
      expect(await contextStore.get(ref)).toMatchObject({
        targetResidency: "active",
      });
      await contextStore.publish(ref, "active");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(refreshed.inputs).toHaveLength(1);
    },
  );

  it("shares one cold Context replacement across concurrent message deliveries", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const sources = new RecordingSourceProbe();
    const createdShells: FakeRuntime[] = [];
    const harness = createHarness({
      ghostStore,
      sources,
      createRuntime: () => {
        const fake = new FakeRuntime();
        createdShells.push(fake);
        return fake;
      },
    });
    await harness.manager.registerAgent(registration, {
      agentId: "agent-1",
    });
    const ref = roomMetaRef("room-concurrent-profile-refresh");
    await harness.manager.startContext(ref);
    await harness.manager.suspendContext(ref);
    const original = createdShells[0]!;
    const current = (await ghostStore.get(ref.agentId))!;
    await ghostStore.replace!(ref.agentId, current.revision, {
      ...current,
      revision: "revision-2",
    });
    const stopGate = new Deferred();
    sources.stopGate = stopGate;
    const first = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("first")],
    });
    await vi.waitFor(() => expect(sources.events).toHaveLength(1));
    const second = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("second")],
    });
    // Drain the second call up to the blocked disposal, without a timing race.
    await new Promise<void>((resolve) => setImmediate(resolve));
    stopGate.resolve();
    await Promise.all([first, second]);

    expect(sources.events).toEqual([
      `behavior:stop:${encodeExecutionContextRef(ref)}`,
    ]);
    expect(createdShells).toHaveLength(2);
    expect(original.received).toEqual([]);
    expect(
      createdShells[1]!.received.flat().map(({ messageId }) => messageId),
    ).toEqual(["first", "second"]);
    expect(createdShells[1]!.configurationRevision).toBe("revision-2");
    expect(harness.fakes.get(encodeExecutionContextRef(ref))).toBe(
      createdShells[1],
    );
  });

  it("rejects new work when a shared cold replacement was superseded during creation", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    Object.assign(ghostStore, {
      isActivationReady: async (agentId: string, revision: string) => {
        if ((await ghostStore.get(agentId))?.revision !== revision) {
          throw new AgentManagerError(
            "agent_revision_conflict",
            "Stale profile",
          );
        }
        return true;
      },
    });
    const creationGate = new Deferred();
    const createdShells: FakeRuntime[] = [];
    const harness = createHarness({
      ghostStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        if (createdShells.length === 1) fake.createGate = creationGate;
        createdShells.push(fake);
        return fake;
      },
    });
    await harness.manager.registerAgent(registration, {
      agentId: "agent-1",
    });
    const ref = roomMetaRef("room-superseded-cold-replacement");
    await harness.manager.startContext(ref);
    await harness.manager.suspendContext(ref);
    const oldGhost = (await ghostStore.get(ref.agentId))!;
    await ghostStore.replace!(ref.agentId, oldGhost.revision, {
      ...oldGhost,
      revision: "revision-2",
    });
    const first = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("first")],
    });
    const firstOutcome = first.catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(createdShells[1]?.configurationRevision).toBe("revision-2"),
    );
    const previous = (await ghostStore.get(ref.agentId))!;
    await ghostStore.replace!(ref.agentId, previous.revision, {
      ...previous,
      revision: "revision-3",
    });
    const second = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("second")],
    });
    const secondOutcome = second.catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    creationGate.resolve();

    expect(await firstOutcome).toMatchObject({
      code: "agent_revision_conflict",
    });
    expect(await secondOutcome).toMatchObject({
      code: "agent_revision_conflict",
    });
    expect(createdShells).toHaveLength(2);
    expect(createdShells.flatMap((fake) => fake.received)).toEqual([]);
    expect(
      createdShells[0]!.calls.filter((call) => call === "stop"),
    ).toHaveLength(1);

    await harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("first"), message("second")],
    });
    expect(createdShells).toHaveLength(3);
    expect(createdShells[2]!.configurationRevision).toBe("revision-3");
    expect(
      createdShells[2]!.received.flat().map(({ messageId }) => messageId),
    ).toEqual(["first", "second"]);
    expect(
      createdShells[1]!.calls.filter((call) => call === "stop"),
    ).toHaveLength(1);
  });

  it("does not accept work into a cold Shell replaced during its readiness check", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const readinessEntered = new Deferred();
    const readinessRelease = new Deferred();
    let blockOldReadiness = false;
    Object.assign(ghostStore, {
      isActivationReady: async (agentId: string, revision: string) => {
        const ready = (await ghostStore.get(agentId))?.revision === revision;
        if (blockOldReadiness && revision === "revision-1") {
          readinessEntered.resolve();
          await readinessRelease.promise;
        }
        if (!ready)
          throw new AgentManagerError(
            "agent_revision_conflict",
            "Stale profile",
          );
        return true;
      },
    });
    const harness = createHarness({ ghostStore });
    await harness.manager.registerAgent(registration, {
      agentId: "agent-1",
    });
    const ref = roomMetaRef("room-replaced-during-input-readiness");
    await harness.manager.startContext(ref);
    await harness.manager.suspendContext(ref);
    const key = encodeExecutionContextRef(ref);
    const old = harness.fakes.get(key)!;
    blockOldReadiness = true;
    const delivery = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("input-after-readiness")],
    });
    const outcome = delivery.catch((error: unknown) => error);
    await readinessEntered.promise;
    const previous = (await ghostStore.get(ref.agentId))!;
    await ghostStore.replace!(ref.agentId, previous.revision, {
      ...previous,
      revision: "revision-2",
    });
    await harness.manager.ensureBinding(ref);
    const replacement = harness.fakes.get(key)!;
    readinessRelease.resolve();

    expect(await outcome).toMatchObject({ code: "agent_revision_conflict" });
    expect(replacement).not.toBe(old);
    expect(old.calls.filter((call) => call === "stop")).toHaveLength(1);
    expect(old.received).toEqual([]);
    await harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("input-after-readiness")],
    });
    expect(
      replacement.received.flat().map(({ messageId }) => messageId),
    ).toEqual(["input-after-readiness"]);
  });

  it("loads a committed profile without callback only for new or suspended Contexts", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    let committed = false;
    const refresh = vi.fn(async (agentId: string) => {
      const current = await ghostStore.get(agentId);
      if (current && committed && current.revision === "revision-1") {
        await ghostStore.replace!(agentId, current.revision, {
          ...current,
          revision: "revision-2",
          agent: {
            ...current.agent,
            name: "Research Partner",
            instructions: "Use the saved profile.",
          },
        });
      }
    });
    Object.assign(ghostStore, {
      refresh,
      isActivationReady: async (_agentId: string, revision: string) => {
        if (committed && revision !== "revision-2") {
          throw new AgentManagerError(
            "agent_revision_conflict",
            "Snapshot is stale",
          );
        }
        return true;
      },
    });
    const harness = createHarness({ ghostStore });
    await harness.manager.registerAgent(registration, {
      agentId: "agent-1",
    });
    const oldRef = roomMetaRef("room-profile-current");
    const oldKey = encodeExecutionContextRef(oldRef);
    await harness.manager.startContext(oldRef);
    const original = harness.fakes.get(oldKey)!;
    original.busy = true;
    committed = true;
    await harness.manager.submitTrustedTurn({
      target: oldRef,
      messages: [message("already-accepted")],
    });
    expect(harness.fakes.get(oldKey)).toBe(original);
    expect(original.calls).not.toContain("stop");
    expect(
      original.received.flat().map(({ messageId }) => messageId),
    ).toContain("already-accepted");
    const nextRef = roomMetaRef("room-profile-next");
    await harness.manager.startContext(nextRef);
    expect(
      harness.fakes.get(encodeExecutionContextRef(nextRef))
        ?.configurationRevision,
    ).toBe("revision-2");
    expect((await activationOf(harness, nextRef)).agent.name).toBe(
      "Research Partner",
    );
    expect(harness.fakes.get(oldKey)).toBe(original);
    original.busy = false;
    await harness.manager.suspendContext(oldRef);
    await harness.manager.resumeContext(oldRef);
    const replacement = harness.fakes.get(oldKey)!;
    expect(replacement).not.toBe(original);
    expect(replacement.configurationRevision).toBe("revision-2");
    expect(original.calls).not.toContain("clearRuntimeSession");
  });

  it("rejects Agent configuration replacement while a Context is busy", async () => {
    const harness = createHarness();
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    await harness.manager.startContext(metaRef());
    const key = encodeExecutionContextRef(metaRef());
    await vi.waitFor(() => {
      expect(harness.fakes.get(key)?.calls).toContain("start");
    });
    harness.fakes.get(key)!.busy = true;
    const beforeReplacement = vi.fn();

    await expect(
      harness.manager.updateAgent(
        "agent-1",
        {
          expectedRevision: "revision-1",
          revision: "revision-2",
          agent: registration.agent,
          runtime: { model: "updated-model" },
          resources: registration.resources,
        },
        { beforeReplacement },
      ),
    ).rejects.toMatchObject({ code: "agent_busy" });

    expect(beforeReplacement).not.toHaveBeenCalled();
    await expect(harness.manager.getGhost("agent-1")).resolves.toMatchObject({
      revision: "revision-1",
      runtime: registration.runtime,
    });
  });

  it("rebinds Local Runner after loaded Contexts are disposed", async () => {
    const harness = createHarness();
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    await harness.manager.startContext(metaRef());
    const key = encodeExecutionContextRef(metaRef());
    await vi.waitFor(() => {
      expect(harness.fakes.get(key)?.calls).toContain("start");
    });
    const loaded = harness.fakes.get(key)!;
    const beforeReplacement = vi.fn(async () => {
      expect(loaded.calls).not.toContain("stop");
    });
    const afterLoadedContextsDisposed = vi.fn(async () => {
      expect(loaded.calls).toContain("stop");
    });

    await expect(
      harness.manager.updateAgent(
        "agent-1",
        {
          expectedRevision: "revision-1",
          revision: "revision-2",
          agent: registration.agent,
          runtime: { model: "updated-model" },
          resources: registration.resources,
        },
        { beforeReplacement, afterLoadedContextsDisposed },
      ),
    ).resolves.toEqual({ agentId: "agent-1", revision: "revision-2" });

    expect(beforeReplacement).toHaveBeenCalledOnce();
    expect(afterLoadedContextsDisposed).toHaveBeenCalledOnce();
    expect(beforeReplacement.mock.invocationCallOrder[0]).toBeLessThan(
      afterLoadedContextsDisposed.mock.invocationCallOrder[0]!,
    );
  });

  it("registers each Meta Context for TeamHub run wakes and stops with it", async () => {
    const runWakes = new RecordingRunWakes();
    const harness = createHarness({ runWakes });

    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    await harness.manager.ensureBinding(metaRef());
    await vi.waitFor(() => expect(runWakes.targets).toHaveLength(1));

    expect(harness.sources.starts).toHaveLength(1);
    expect(runWakes.targets[0]!.ref).toEqual(metaRef());
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    await activationOf(harness, metaRef());
    // A Run is replying when TeamHub steers a Message into it.
    fake.holdRuns = true;
    const runId = fake.state.queueInboxRun([message("running-input")]);
    runWakes.target(metaRef()).wake("queued");
    await vi.waitFor(() => expect(fake.currentRun).toBeDefined());
    fake.state.queueMessageSteer(message("steered-input"), { runId });
    runWakes.target(metaRef()).wake("steered");
    await vi.waitFor(() => expect(fake.providerSteers).toHaveLength(1));
    fake.currentRun!.succeed();

    await harness.manager.stopContext(metaRef());
    expect(runWakes.stopped).toEqual([encodeExecutionContextRef(metaRef())]);
  });

  it("preserves new-Context Behavior bootstrap across identity retry", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const harness = createHarness({
      identityResolver: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new AgentIdentityResolutionError(
            "transient",
            "identity is not visible yet",
          );
        }
        return resolvedIdentity("agent-1");
      },
    });

    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    await expect(
      harness.manager.ensureBinding(metaRef()),
    ).rejects.toMatchObject({ code: "identity_unavailable" });
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(attempts).toBe(2);
    expect(harness.sources.starts).toEqual([
      expect.objectContaining({ bootstrap: "new", target: metaRef() }),
    ]);
  });

  it("materializes an alterEgo with the same Ghost", async () => {
    const harness = createHarness();
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    const ref = alterEgoRef();
    if (ref.kind !== "alter_ego") throw new Error("expected alterEgo ref");

    await harness.manager.ensureBinding(ref);

    const record = await harness.contextStore.get(ref);
    expect(record).toEqual({ ref, targetResidency: "active" });
    const activation = await activationOf(harness, ref);
    expect(activation).toMatchObject({
      ref,
      actorId: "actor:agent-1",
      runtime: registration.runtime,
    });
    expect(activation.agent.developerInstructions).toContain(
      JSON.stringify({
        display_name: registration.agent.name,
        actor_id: "actor:agent-1",
        agent_type: "general",
      }),
    );
    expect(activation.agent.developerInstructions).toContain(
      "You are an AlterEgo of the source Agent, working in the background on one delegated Task.",
    );
    expect(activation.agent.developerInstructions).toContain(
      "Your final reply in each turn is the only thing the Meta receives",
    );
    expect(harness.sources.starts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bootstrap: "new",
          target: ref,
        }),
      ]),
    );
  });

  it.each([true, false])(
    "reviews Runtime permission prompts only with TeamHub's judge (%s)",
    async (permissionReview) => {
      const harness = createHarness();
      await harness.manager.registerAgent(
        {
          ...registration,
          ...(permissionReview ? { permissionReview: true as const } : {}),
        },
        { agentId: "agent-1" },
      );
      const ref = alterEgoRef();
      await harness.manager.ensureBinding(ref);
      const options = await activationOf(harness, ref);
      expect(options?.permissionReview).toBe(
        permissionReview ? true : undefined,
      );
      expect(
        options?.agent.developerInstructions?.includes(
          "<tool-approval-protocol>",
        ),
      ).toBe(permissionReview);
      // Each activation renders the instructions again with its own facts.
      expect(options?.agent.developerInstructions).toContain(
        "Connected app writes",
      );
      expect(
        options?.renderDeveloperInstructions?.({
          connectedApps: false,
          compactInstructions: false,
        }),
      ).not.toContain("Connected app writes");
    },
  );

  it("materializes a Document with Meta configuration and no Inbox behavior", async () => {
    const runWakes = new RecordingRunWakes();
    const harness = createHarness({ runWakes });
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    const ref = documentRef();
    await harness.manager.ensureBinding(ref);

    const { agent } = await activationOf(harness, ref);
    expect(agent.developerInstructions).toContain(
      "You work only on the active Document comment and its current Document.",
    );
    expect(agent.developerInstructions).toContain(
      "./<document-id>/comments.md",
    );
    expect(agent.developerInstructions).toContain("./<document-id>/latest.md");
    expect(agent.developerInstructions).not.toContain("./playground/document");
    expect(harness.sources.starts).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: ref })]),
    );
    expect(runWakes.targets).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ ref })]),
    );
  });

  it("restores a persisted Ghost with its resolved Another Me identity", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      identityResolver: async (agentId) => ({
        ...resolvedIdentity(agentId),
        agentType: "anotherme",
        representedHuman: {
          actorId: "actor:represented-human",
          displayName: "Represented Human",
          memory: {
            version: 1,
            markdown: "- Uses concise, evidence-based replies. [2026-11-01]",
          },
        },
      }),
    });

    await harness.manager.restore();

    const instructions = (await activationOf(harness, metaRef())).agent
      .developerInstructions;
    expect(instructions).toContain("Represented Human");
    // memory.md reaches the Runtime through the user-memory feature at activation.
    expect(instructions).not.toContain("evidence-based replies");
  });

  it("identifies the meta role without replacing Ghost developer instructions", async () => {
    const harness = createHarness();
    await harness.manager.registerAgent(
      {
        ...registration,
        agent: {
          ...registration.agent,
          developerInstructions: "Keep the Agent-specific operating rules.",
        },
      },
      { agentId: "agent-1" },
    );
    await harness.manager.ensureBinding(metaRef());

    const instructions = (await activationOf(harness, metaRef())).agent
      .developerInstructions;
    expect(instructions).toContain("Keep the Agent-specific operating rules.");
    expect(instructions).toContain(
      JSON.stringify({
        display_name: registration.agent.name,
        actor_id: "actor:agent-1",
        agent_type: "general",
      }),
    );
    expect(instructions?.indexOf("## Who you are")).toBeLessThan(
      instructions?.indexOf("Keep the Agent-specific operating rules.") ?? -1,
    );
    expect(
      instructions?.indexOf("Keep the Agent-specific operating rules."),
    ).toBeLessThan(instructions?.indexOf("## How a turn works") ?? -1);
    expect(instructions).not.toContain("Test Sponsor");
    expect(instructions).toContain(
      "The current tool inventory is authoritative",
    );
  });

  it("durably accepts trusted-turn input before requesting a suspended Context wake", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const ref = alterEgoRef();
    await contextStore.ensure(ref, "suspended");
    const receiveGate = new Deferred();
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.persistedSession = { threadId: "thread-persisted" };
        fake.receiveGate = receiveGate;
        return fake;
      },
    });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;

    const delivery = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message()],
    });
    await vi.waitFor(() => expect(fake.calls).toContain("submitTrustedTurn"));
    expect(fake.calls).not.toContain("resume");

    receiveGate.resolve();
    await delivery;
    await vi.waitFor(() => expect(fake.calls).toContain("resume"));
    expect(fake.calls.indexOf("submitTrustedTurn")).toBeLessThan(
      fake.calls.indexOf("resume"),
    );
    await expect(contextStore.get(ref)).resolves.toEqual({
      ref,
      targetResidency: "active",
    });
  });

  it("reactivates an active binding whose Runtime recovery was exhausted", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const runWakes = new RecordingRunWakes();
    await seedGhost(ghostStore);
    const ref = metaRef();
    await contextStore.ensure(ref, "active");
    const harness = createHarness({ ghostStore, contextStore, runWakes });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    await vi.waitFor(() => expect(fake.activations).toHaveLength(1));
    await exhaustRuntimeRecovery(fake, () =>
      runWakes.target(ref).wake("queued"),
    );
    const activationsBeforeInput = fake.activations.length;

    await harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message()],
    });

    await vi.waitFor(() =>
      expect(fake.activations).toHaveLength(activationsBeforeInput + 1),
    );
    expect(fake.received).toHaveLength(1);
    await expect(contextStore.get(ref)).resolves.toMatchObject({
      ref,
      targetResidency: "active",
    });
  });

  it("serializes suspend and resume transitions within one Context", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const ref = alterEgoRef();
    await contextStore.ensure(ref, "active");
    const suspendGate = new Deferred();
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.suspendGate = suspendGate;
        return fake;
      },
    });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;

    const suspension = harness.manager.suspendContext(ref);
    const resumption = harness.manager.resumeContext(ref);
    await vi.waitFor(() => expect(fake.calls).toContain("deactivate"));
    expect(fake.calls).not.toContain("resume");
    await expect(harness.manager.getContextStatus(ref)).resolves.toBe("active");

    suspendGate.resolve();
    await Promise.all([suspension, resumption]);
    expect(fake.calls.indexOf("deactivate")).toBeLessThan(
      fake.calls.indexOf("resume"),
    );
    await expect(harness.manager.getContextStatus(ref)).resolves.toBe("active");
  });

  it.each(["recover", "exhaust", "physical"] as const)(
    "bounds idle cleanup retries and retains active state until release: %s",
    async (scenario) => {
      vi.useFakeTimers();
      vi.stubEnv("AGENT_LOG_LEVEL", "info");
      setAgentLogOptions({ format: "json" });
      const output = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const warnings = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const contextStore = createInMemoryExecutionContextStore();
      const releaseIfIdle = vi.fn(async () => true);
      Object.assign(contextStore, { releaseIfIdle });
      const harness = createHarness({ contextStore });
      const ref = metaRef();
      await harness.manager.registerAgent(registration, { agentId: "agent-1" });
      await harness.manager.startContext(ref);
      const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
      const teardown = vi.fn(async () => {
        if (scenario === "physical")
          throw new ContextRuntimeCleanupError([
            new Error("writer stop unconfirmed"),
          ]);
        if (scenario !== "recover" || teardown.mock.calls.length === 1)
          throw new RunnerOperationError(
            "CONTEXT_VIEW_FAILED",
            "cleanup blocked",
            false,
          );
      });
      fake.onDeactivate = teardown;
      try {
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(teardown).toHaveBeenCalledOnce();
        expect(releaseIfIdle).not.toHaveBeenCalled();
        expect((await contextStore.get(ref))?.targetResidency).toBe("active");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(teardown).toHaveBeenCalledTimes(
          scenario === "physical" ? 1 : scenario === "recover" ? 2 : 3,
        );
        expect((await contextStore.get(ref))?.targetResidency).toBe(
          scenario === "recover" ? "suspended" : "active",
        );
        await vi.advanceTimersByTimeAsync(2 * 20 * 60_000);
        expect(teardown).toHaveBeenCalledTimes(
          scenario === "physical" ? 1 : scenario === "recover" ? 2 : 3,
        );
        if (scenario === "recover")
          expect(releaseIfIdle).toHaveBeenCalledOnce();
        else expect(releaseIfIdle).not.toHaveBeenCalled();
        const logs = JSON.stringify([
          ...output.mock.calls,
          ...warnings.mock.calls,
        ]);
        expect(logs).toContain("idle_suspend.attempt_started");
        if (scenario !== "recover")
          expect(logs).toContain("idle_suspend.blocked");
      } finally {
        output.mockRestore();
        warnings.mockRestore();
        fake.onDeactivate = null;
        await harness.manager.close();
        vi.useRealTimers();
      }
    },
  );

  it.each(["suspend", "stop"] as const)(
    "honors a later %s after Inbox recovery queues behind idle teardown",
    async (request) => {
      vi.useFakeTimers();
      const runWakes = new RecordingRunWakes();
      const contextStore = createInMemoryExecutionContextStore();
      const harness = createHarness({ runWakes, contextStore });
      const ref = metaRef();
      await harness.manager.registerAgent(registration, { agentId: "agent-1" });
      await harness.manager.startContext(ref);
      const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
      const release = new Deferred();
      const teardown = vi.fn(async () => {
        if (teardown.mock.calls.length === 1) await release.promise;
      });
      fake.onDeactivate = teardown;
      try {
        await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS);
        expect(teardown).toHaveBeenCalledOnce();
        runWakes.target(ref).wake("queued");
        await vi.advanceTimersByTimeAsync(0);
        const later =
          request === "suspend"
            ? harness.manager.suspendContext(ref)
            : harness.manager.stopContext(ref);
        await vi.advanceTimersByTimeAsync(0);
        release.resolve();
        await later;
        if (request === "suspend") {
          expect(fake.calls.indexOf("resume")).toBeGreaterThan(-1);
          expect(fake.calls).toContain("queued:queued");
          expect(fake.calls.indexOf("resume")).toBeLessThan(
            fake.calls.lastIndexOf("deactivate"),
          );
        } else {
          // A permanent stop cancels the queued reactivation.
          expect(fake.calls).not.toContain("resume");
          expect(fake.calls).toContain("stop");
        }
        if (request === "suspend") {
          expect(await contextStore.get(ref)).toMatchObject({
            targetResidency: "suspended",
          });
        } else {
          expect(await contextStore.get(ref)).toBeNull();
        }
        const calls = [...fake.calls];
        await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS);
        expect(fake.calls).toEqual(calls);
      } finally {
        release.resolve();
      }
    },
  );

  it("runs a feature's maintenance before the idle suspend of the same window", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const ref = metaRef();
    await contextStore.ensure(ref, "active");
    const maintenance = new MaintenanceProbe();
    maintenance.idleDecision = {
      kind: "compact",
      reason: "test",
      instructions: "keep ids",
    };
    const harness = createHarness({ ghostStore, contextStore, maintenance });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;

    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS);

    const compactAt = fake.calls.indexOf("compactSession:keep ids");
    const suspendAt = fake.calls.indexOf("deactivate");
    expect(compactAt).toBeGreaterThanOrEqual(0);
    expect(suspendAt).toBeGreaterThan(compactAt);
    expect(maintenance.events).toEqual([
      {
        phase: "started",
        trigger: { kind: "idle_suspend" },
        action: maintenance.idleDecision,
      },
      {
        phase: "finished",
        trigger: { kind: "idle_suspend" },
        action: maintenance.idleDecision,
        outcome: { status: "completed" },
      },
    ]);
    await expect(harness.manager.getContextStatus(ref)).resolves.toBe(
      "suspended",
    );
  });

  it("does not suspend after maintenance when work arrived meanwhile", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const ref = metaRef();
    await contextStore.ensure(ref, "active");
    const maintenance = new MaintenanceProbe();
    maintenance.idleDecision = { kind: "compact", reason: "test" };
    const harness = createHarness({ ghostStore, contextStore, maintenance });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    fake.compactGate = new Deferred();
    fake.holdRuns = true;

    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS);
    expect(fake.calls).toContain("compactSession:");
    // A trusted turn arrives while the session compacts.
    const submitted = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("arrived-during-compaction")],
    });
    await vi.advanceTimersByTimeAsync(0);
    await submitted;

    expect(fake.calls).not.toContain("deactivate");
    expect(maintenance.events.at(-1)).toMatchObject({
      phase: "finished",
      outcome: { status: "skipped", reason: "input_arrived" },
    });
    await expect(harness.manager.getContextStatus(ref)).resolves.toBe("active");
  });

  it("reports compaction the Runtime cannot do now as unavailable", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const ref = metaRef();
    await contextStore.ensure(ref, "active");
    const maintenance = new MaintenanceProbe();
    maintenance.idleDecision = { kind: "compact", reason: "test" };
    const harness = createHarness({ ghostStore, contextStore, maintenance });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    fake.compactResult = { status: "unavailable" };

    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS);

    expect(fake.calls).toContain("compactSession:");
    expect(maintenance.events.at(-1)).toMatchObject({
      phase: "finished",
      outcome: { status: "skipped", reason: "unavailable" },
    });
  });

  it("wakes a suspended Context for timer maintenance and suspends it again", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const ref = metaRef();
    await contextStore.ensure(ref, "suspended");
    const maintenance = new MaintenanceProbe();
    maintenance.timerDecision = { kind: "compact", reason: "idle" };
    const canRunMaintenance = vi.fn(() => true);
    const harness = createHarness({
      ghostStore,
      contextStore,
      maintenance,
      canRunMaintenance,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.persistedSession = { threadId: "thread-persisted" };
        return fake;
      },
    });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls).toEqual(["create"]);

    maintenance.timers!.set(maintenance.bound!, "probe", Date.now() + 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(maintenance.fired).toEqual([{ name: "probe", canSubmit: true }]);
    expect(canRunMaintenance).toHaveBeenCalledOnce();
    expect(fake.calls).toEqual([
      "create",
      "resume",
      "compactSession:",
      "deactivate",
    ]);
    expect(maintenance.events.at(-1)).toMatchObject({
      phase: "finished",
      trigger: { kind: "timer", name: "probe" },
      outcome: { status: "completed" },
    });
    await expect(harness.manager.getContextStatus(ref)).resolves.toBe(
      "suspended",
    );
    // Waking for maintenance never persisted an active target.
    await expect(contextStore.get(ref)).resolves.toMatchObject({
      targetResidency: "suspended",
    });
  });

  it("skips timer maintenance on an unavailable Computer and cancels timers with the instance", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const ref = metaRef();
    await contextStore.ensure(ref, "suspended");
    const maintenance = new MaintenanceProbe();
    maintenance.timerDecision = { kind: "compact", reason: "idle" };
    const harness = createHarness({
      ghostStore,
      contextStore,
      maintenance,
      canRunMaintenance: () => false,
    });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;

    maintenance.timers!.set(maintenance.bound!, "probe", Date.now() + 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls).toEqual(["create"]);
    expect(maintenance.events).toEqual([
      {
        phase: "finished",
        trigger: { kind: "timer", name: "probe" },
        action: maintenance.timerDecision,
        outcome: { status: "skipped", reason: "unavailable" },
      },
    ]);

    maintenance.timers!.set(maintenance.bound!, "probe", Date.now() + 1_000);
    await harness.manager.stopContext(ref);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(maintenance.events).toHaveLength(1);
    expect(maintenance.fired).toHaveLength(1);
  });

  it("idle-suspends meta and alterEgo after the Local Computer idle window", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const meta = metaRef();
    const alterEgo = alterEgoRef();
    await contextStore.ensure(meta, "active");
    await contextStore.ensure(alterEgo, "active");
    const harness = createHarness({ ghostStore, contextStore });
    await harness.manager.restore();
    const fakes = [meta, alterEgo].map(
      (ref) => harness.fakes.get(encodeExecutionContextRef(ref))!,
    );

    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS - 1);
    for (const fake of fakes) {
      expect(fake.calls).not.toContain("deactivate");
    }

    await vi.advanceTimersByTimeAsync(1);
    for (const [index, ref] of [meta, alterEgo].entries()) {
      expect(fakes[index]!.calls).toContain("deactivate");
      await expect(harness.manager.getContextStatus(ref)).resolves.toBe(
        "suspended",
      );
      await expect(contextStore.get(ref)).resolves.toMatchObject({
        ref,
        targetResidency: "suspended",
      });
    }
  });

  it("starts Behavior but does not activate a restored suspended Context", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const ref = alterEgoRef();
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({ ghostStore, contextStore });

    await harness.manager.restore();

    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls).toEqual(["create"]);
    expect(harness.sources.starts).toEqual([
      expect.objectContaining({ bootstrap: "restored", target: ref }),
    ]);
    await expect(harness.manager.getContextStatus(ref)).resolves.toBe(
      "suspended",
    );
  });

  it("releases a newly held suspended Context when its runtime cannot be prepared", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const releaseIfIdle = vi.fn(async () => true);
    Object.assign(contextStore, { releaseIfIdle });
    const ref = roomMetaRef("room-no-preparation");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldPrepareContext: () => false,
    });
    harness.manager.scheduleContextPreparation(ref);
    await vi.waitFor(() => expect(releaseIfIdle).toHaveBeenCalledWith(ref));
    expect(harness.fakes.has(encodeExecutionContextRef(ref))).toBe(false);
  });

  it("prepares each new Room once through active authority and retains the ready Runtime", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const ref = roomMetaRef("room-new");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.onActivate = async () => {
          expect((await contextStore.get(ref))?.targetResidency).toBe("active");
        };
        return fake;
      },
    });

    harness.manager.scheduleContextPreparation(ref);
    await vi.waitFor(() => {
      expect(
        harness.fakes.get(encodeExecutionContextRef(ref))?.calls,
      ).toContain("start");
    });
    harness.manager.scheduleContextPreparation(ref);
    await Promise.resolve();

    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls).toEqual(["create", "start"]);
    await expect(harness.manager.getContextStatus(ref)).resolves.toBe("active");
    await expect(contextStore.get(ref)).resolves.toEqual({
      ref,
      roomKind: "collaboration",
      targetResidency: "active",
    });
    expect(contextStore.persistedTransitions).toBe(1);

    await harness.manager.startContext(ref);
    expect(fake.calls).toEqual(["create", "start"]);
  });

  it("reclaims unused prepared Rooms after 30 seconds without changing the configured idle policy", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const ref = roomMetaRef("room-unused-preparation");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
    });
    harness.manager.scheduleContextPreparation(ref);
    await vi.advanceTimersByTimeAsync(0);
    expect(await harness.manager.getContextStatus(ref)).toBe("active");
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fake.calls).not.toContain("deactivate");
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.calls).toContain("deactivate");
    expect((await contextStore.get(ref))?.targetResidency).toBe("suspended");

    await harness.manager.startContext(ref);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.calls.filter((call) => call === "deactivate")).toHaveLength(1);
    expect(await harness.manager.getContextStatus(ref)).toBe("active");
  });

  it.each(["agent_update", "restore"] as const)(
    "does not extend unused preparation expiry during %s",
    async (reason) => {
      vi.useFakeTimers();
      const ghostStore = createInMemoryGhostStore<TestRuntime>();
      const contextStore = createInMemoryExecutionContextStore();
      const ref = roomMetaRef("room-preparation-management-refresh");
      await seedGhost(ghostStore, "agent-1");
      await contextStore.ensure(ref, "suspended");
      const harness = createHarness({
        ghostStore,
        contextStore,
        shouldPrepareContext: shouldPrepareRoomMetaContext,
      });
      harness.manager.scheduleContextPreparation(ref);
      await vi.advanceTimersByTimeAsync(0);
      const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
      await vi.advanceTimersByTimeAsync(29_000);

      if (reason === "agent_update") {
        await harness.manager.updateAgent("agent-1", {
          expectedRevision: registration.revision,
          revision: registration.revision,
          agent: registration.agent,
          runtime: registration.runtime,
          resources: registration.resources,
        });
      } else {
        await harness.manager.restore();
      }
      await vi.advanceTimersByTimeAsync(1_000);

      expect(fake.calls.filter((call) => call === "deactivate")).toHaveLength(
        1,
      );
      expect((await contextStore.get(ref))?.targetResidency).toBe("suspended");
      harness.manager.scheduleContextPreparation(ref);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fake.activations).toHaveLength(1);
    },
  );

  it("releases unused preparation when an Agent profile replacement disposes its Runtime", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const ref = roomMetaRef("room-preparation-profile-replaced");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
    });
    harness.manager.scheduleContextPreparation(ref);
    await vi.advanceTimersByTimeAsync(0);
    const key = encodeExecutionContextRef(ref);
    const preparedFake = harness.fakes.get(key)!;

    await harness.manager.updateAgent("agent-1", {
      expectedRevision: registration.revision,
      revision: "revision-2",
      agent: registration.agent,
      runtime: { model: "updated-model" },
      resources: registration.resources,
    });

    expect(preparedFake.calls).toContain("stop");
    expect((await contextStore.get(ref))?.targetResidency).toBe("suspended");
    const replacementFake = harness.fakes.get(key)!;
    expect(replacementFake).not.toBe(preparedFake);
    expect(replacementFake.calls).toEqual(["create"]);
    expect(replacementFake.configurationRevision).toBe("revision-2");
    await harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message()],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(replacementFake.activations).toHaveLength(1);
    expect((await contextStore.get(ref))?.targetResidency).toBe("active");
  });

  it("retains input that arrives while configuration refresh waits", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const ref = roomMetaRef("room-prepared-profile-race");
    const runWakes = new RecordingRunWakes();
    const entered = new Deferred();
    const release = new Deferred();
    let holdRefresh = false;
    Object.assign(ghostStore, {
      refresh: async () => {
        if (holdRefresh) {
          entered.resolve();
          await release.promise;
          await commitInitializedProfile(ghostStore);
        }
      },
      isActivationReady: async () => true,
    });
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      runWakes,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
      createRuntime: () => {
        const fake = new FakeRuntime();
        return fake;
      },
    });
    harness.manager.scheduleContextPreparation(ref);
    await vi.waitFor(async () =>
      expect(await harness.manager.getContextStatus(ref)).toBe("active"),
    );
    const key = encodeExecutionContextRef(ref);
    const original = harness.fakes.get(key)!;
    holdRefresh = true;
    const refreshing = harness.manager.ensureBinding(ref);
    try {
      await entered.promise;
      runWakes.target(ref).wake("queued");
    } finally {
      release.resolve();
    }
    await refreshing;
    // An unused preparation does not take queued input before the refresh
    // settles: TeamHub claims the Run at the committed revision, so the
    // input runs on the replacement and is not lost.
    await vi.waitFor(() =>
      expect(harness.fakes.get(key)!.calls).toContain("queued:queued"),
    );
    const current = harness.fakes.get(key)!;
    expect(current).not.toBe(original);
    expect(current.configurationRevision).toBe("revision-2");
    expect(original.calls).not.toContain("queued:queued");
  });

  it.each(["trusted"] as const)(
    "retains %s input when invalidation is already queued behind acceptance",
    async () => {
      const ghostStore = createInMemoryGhostStore<TestRuntime>();
      const contextStore = createInMemoryExecutionContextStore();
      const ref = roomMetaRef("room-prepared-admission-race");
      Object.assign(ghostStore, { isActivationReady: async () => true });
      await seedGhost(ghostStore, "agent-1");
      await contextStore.ensure(ref, "suspended");
      const harness = createHarness({
        ghostStore,
        contextStore,
        shouldPrepareContext: shouldPrepareRoomMetaContext,
        createRuntime: () => {
          const fake = new FakeRuntime();
          return fake;
        },
      });
      harness.manager.scheduleContextPreparation(ref);
      await vi.waitFor(async () =>
        expect(await harness.manager.getContextStatus(ref)).toBe("active"),
      );
      const key = encodeExecutionContextRef(ref);
      const original = harness.fakes.get(key)!;
      original.receiveGate = new Deferred();
      const delivery = harness.manager.submitTrustedTurn({
        target: ref,
        messages: [message()],
      });
      // Durable acceptance owns the admission boundary.
      await vi.waitFor(() =>
        expect(original.calls).toContain("submitTrustedTurn"),
      );
      const refreshed = new Deferred();
      Object.assign(ghostStore, {
        refresh: async () => {
          await commitInitializedProfile(ghostStore);
          refreshed.resolve();
        },
      });
      const refreshing = harness.manager.ensureBinding(ref);
      try {
        // The outer checks pass while acceptance owns the boundary; the
        // queued invalidation must recheck after acceptance clears preparation.
        await refreshed.promise;
        await nextTurn();
        expect(original.calls).not.toContain("stop");
      } finally {
        original.receiveGate.resolve();
      }
      await delivery;
      await refreshing;
      expect(harness.fakes.get(key)).toBe(original);
      expect(original.calls).not.toContain("stop");
      expect(original.received).toHaveLength(1);
      expect(original.configurationRevision).toBe("revision-1");
    },
  );

  it("keeps a fenced unused preparation cold after reclaim and management refresh until input arrives", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const ref = roomMetaRef("room-preparation-lease-reclaimed");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
      shouldActivateOnRestore: async () => false,
    });
    await harness.manager.restore();
    harness.manager.scheduleContextPreparation(ref);
    await vi.advanceTimersByTimeAsync(0);
    const key = encodeExecutionContextRef(ref);
    const preparedFake = harness.fakes.get(key)!;
    expect(await harness.manager.getContextStatus(ref)).toBe("active");

    contextStore.publishLeaseLoss(ref);
    await vi.advanceTimersByTimeAsync(0);
    expect(preparedFake.calls).toContain("stop");
    await contextStore.publish(ref, "active");
    await vi.advanceTimersByTimeAsync(1_000);
    const replacementFake = harness.fakes.get(key)!;
    expect(replacementFake).not.toBe(preparedFake);
    expect(replacementFake.calls).toEqual(["create"]);

    await harness.manager.restore();
    await harness.manager.updateAgent("agent-1", {
      expectedRevision: registration.revision,
      revision: registration.revision,
      agent: registration.agent,
      runtime: registration.runtime,
      resources: registration.resources,
    });
    expect(replacementFake.calls).toEqual(["create"]);
    await harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message()],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(replacementFake.calls).toContain("start");
  });

  it("replaces an unused prepared Context after a profile-only edit before its first Run", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const runWakes = new RecordingRunWakes();
    const ref = roomMetaRef("room-preparation-profile-edited");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      runWakes,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
    });
    harness.manager.scheduleContextPreparation(ref);
    await vi.advanceTimersByTimeAsync(0);
    const key = encodeExecutionContextRef(ref);
    const preparedFake = harness.fakes.get(key)!;

    // TeamHub committed a profile edit after the Room was prepared: a newer
    // revision whose Runtime and placement are unchanged. TeamHub accepts
    // the Context's first Session only at the revision the Run was claimed
    // under, so the queued Run must not adopt the older preparation.
    const current = (await ghostStore.get("agent-1"))!;
    await ghostStore.replace!("agent-1", current.revision, {
      ...current,
      revision: "revision-2",
      runtimeRevision: current.revision,
      agent: { ...current.agent, name: "Renamed" },
    });
    runWakes.target(ref).wake("queued");
    await vi.advanceTimersByTimeAsync(0);

    expect(preparedFake.calls).not.toContain("queued:queued");
    const replacementFake = harness.fakes.get(key)!;
    expect(replacementFake).not.toBe(preparedFake);
    expect(replacementFake.configurationRevision).toBe("revision-2");
    expect(replacementFake.calls).toContain("queued:queued");
  });

  it("input adopts preparation before its short idle expiry", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const ref = roomMetaRef("room-preparation-adopted");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
    });
    harness.manager.scheduleContextPreparation(ref);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29_999);
    await harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message()],
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);
    expect(fake.calls.some((call) => call === "deactivate")).toBe(false);
    expect((await contextStore.get(ref))?.targetResidency).toBe("active");
  });

  it("keeps the foreground active intention when input races preparation expiry", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const ref = roomMetaRef("room-preparation-expiry-race");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const gate = new Deferred();
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
      createRuntime: () => {
        const fake = new FakeRuntime();
        let first = true;
        fake.onDeactivate = async () => {
          if (first) {
            first = false;
            await gate.promise;
          }
        };
        return fake;
      },
    });
    harness.manager.scheduleContextPreparation(ref);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    const submitted = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message()],
    });
    await vi.advanceTimersByTimeAsync(0);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await submitted;
    expect((await contextStore.get(ref))?.targetResidency).toBe("active");
    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS);
    expect(
      harness.fakes
        .get(encodeExecutionContextRef(ref))!
        .calls.filter((call) => call === "deactivate"),
    ).toHaveLength(2);
    expect((await contextStore.get(ref))?.targetResidency).toBe("suspended");
  });

  it("serializes background preparations while foreground activation bypasses the queue", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const first = roomMetaRef("room-first");
    const foreground = roomMetaRef("room-foreground");
    const trailing = roomMetaRef("room-trailing");
    const firstPreparationGate = new Deferred();
    await seedGhost(ghostStore, "agent-1");
    for (const ref of [first, foreground, trailing]) {
      await contextStore.ensure(ref, "suspended");
    }
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
      createRuntime: (ref) => {
        const fake = new FakeRuntime();
        if (
          encodeExecutionContextRef(ref) === encodeExecutionContextRef(first)
        ) {
          fake.startGate = firstPreparationGate;
        }
        return fake;
      },
    });

    harness.manager.scheduleContextPreparation(first);
    harness.manager.scheduleContextPreparation(foreground);
    await vi.waitFor(() => {
      expect(
        harness.fakes.get(encodeExecutionContextRef(first))?.calls,
      ).toContain("start");
    });
    expect(harness.fakes.has(encodeExecutionContextRef(foreground))).toBe(
      false,
    );

    try {
      await harness.manager.startContext(foreground);
      const foregroundFake = harness.fakes.get(
        encodeExecutionContextRef(foreground),
      )!;
      expect(foregroundFake.calls).toEqual(["create", "start"]);

      harness.manager.scheduleContextPreparation(trailing);
      expect(harness.fakes.has(encodeExecutionContextRef(trailing))).toBe(
        false,
      );
    } finally {
      firstPreparationGate.resolve();
    }
    await vi.waitFor(() => {
      expect(
        harness.fakes.get(encodeExecutionContextRef(trailing))?.calls,
      ).toContain("start");
    });

    expect(
      harness.fakes.get(encodeExecutionContextRef(foreground))?.calls,
    ).toEqual(["create", "start"]);
    await expect(contextStore.get(foreground)).resolves.toEqual({
      ref: foreground,
      roomKind: "collaboration",
      targetResidency: "active",
    });
  });

  it("keeps a running preparation active when foreground resume wins", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const ref = roomMetaRef("room-racing");
    const preparationGate = new Deferred();
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startGate = preparationGate;
        return fake;
      },
    });

    harness.manager.scheduleContextPreparation(ref);
    await vi.waitFor(() => {
      expect(
        harness.fakes.get(encodeExecutionContextRef(ref))?.calls,
      ).toContain("start");
    });
    const activation = harness.manager.resumeContext(ref);
    preparationGate.resolve();
    await activation;

    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls).toEqual(["create", "start"]);
    await expect(harness.manager.getContextStatus(ref)).resolves.toBe("active");
    await expect(contextStore.get(ref)).resolves.toEqual({
      ref,
      roomKind: "collaboration",
      targetResidency: "active",
    });
  });

  it("returns failed preparation to suspended and leaves a real input free to activate", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const ref = roomMetaRef("room-preparation-denied");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = new Error("Room authority revoked");
        return fake;
      },
    });
    harness.manager.scheduleContextPreparation(ref);
    await vi.waitFor(async () =>
      expect(await harness.manager.getContextStatus(ref)).toBe("suspended"),
    );
    expect((await contextStore.get(ref))?.targetResidency).toBe("suspended");
    harness.manager.scheduleContextPreparation(ref);
    await Promise.resolve();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);
    fake.startError = null;
    await harness.manager.startContext(ref);
    // The failed activation left no Runtime to deactivate.
    expect(fake.calls).toEqual(["create", "start", "start"]);
    expect((await contextStore.get(ref))?.targetResidency).toBe("active");
  });

  it("does not roll back foreground input when its concurrent preparation fails", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const ref = roomMetaRef("room-preparation-input-race");
    const gate = new Deferred();
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
      createRuntime: () => {
        const fake = new FakeRuntime();
        let first = true;
        fake.onActivate = async () => {
          if (first) {
            first = false;
            await gate.promise;
            throw new Error("Preparation activation interrupted");
          }
        };
        return fake;
      },
    });
    harness.manager.scheduleContextPreparation(ref);
    await vi.waitFor(() =>
      expect(
        harness.fakes.get(encodeExecutionContextRef(ref))?.calls,
      ).toContain("start"),
    );
    const submitted = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message()],
    });
    await vi.waitFor(() =>
      expect(
        harness.fakes.get(encodeExecutionContextRef(ref))?.received,
      ).toHaveLength(1),
    );
    gate.resolve();
    // The submission joined the failed preparation activation and reports it;
    // its accepted input still drives a fresh activation.
    await expect(submitted).rejects.toThrow(
      "Preparation activation interrupted",
    );
    await vi.waitFor(async () =>
      expect(await harness.manager.getContextStatus(ref)).toBe("active"),
    );
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls).not.toContain("deactivate");
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
    expect((await contextStore.get(ref))?.targetResidency).toBe("active");
  });

  it("applies authoritative residency without writing it back and stops revoked execution", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const ref = roomMetaRef("room-projected");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({ ghostStore, contextStore });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;

    await contextStore.publish(ref, "active");
    await vi.waitFor(() => expect(fake.activations).toHaveLength(1));

    await contextStore.publish(ref, "suspended");
    await vi.waitFor(() => expect(fake.calls).toContain("stop"));
    expect(contextStore.persistedTransitions).toBe(0);
  });

  it("does not carry a cleaned-up failed Binding's lease-loss marker into its replacement", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const ref = roomMetaRef("room-create-failure-fence");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const failedCreation = new Error("Runtime state creation failed");
    const created: FakeRuntime[] = [];
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        created.push(fake);
        if (created.length === 1) {
          fake.onOpen = () => {
            contextStore.publishLeaseLoss(ref);
            throw failedCreation;
          };
        }
        return fake;
      },
    });
    await expect(harness.manager.restore()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [failedCreation],
    });
    expect(created).toHaveLength(1);
    // The failed open left no Runtime state to close.
    expect(created[0]!.calls).toEqual(["create"]);
    // A new ensure reads current authority without relying on a store wake to
    // erase process state left by the failed materialization.
    await harness.manager.ensureBinding(ref);
    await nextTurn();
    expect(created).toHaveLength(2);
    const replacement = created[1]!;
    expect(replacement.calls).toEqual(["create"]);
    await expect(harness.manager.getContextStatus(ref)).resolves.toBe(
      "suspended",
    );
    await harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("after-failed-binding")],
    });
    expect(created).toHaveLength(2);
    expect(
      replacement.received.flat().map(({ messageId }) => messageId),
    ).toEqual(["after-failed-binding"]);
    expect(replacement.calls).not.toContain("stop");
  });

  it("cancels a running binding before accepting authoritative suspension", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const ref = roomMetaRef("room-authority-revoked");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldActivateOnRestore: async () => true,
    });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    await contextStore.publish(ref, "suspended");
    await vi.waitFor(() => expect(fake.calls).toContain("stop"));
  });

  it("does not let a stale idle callback suspend or release a reclaimed Context", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const releaseIfIdle = vi.fn(async () => true);
    const contextStore = Object.assign(new PushContextStore(), {
      releaseIfIdle,
    });
    const ref = roomMetaRef("room-idle-fence-rebind");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldActivateOnRestore: async () => true,
    });
    await harness.manager.restore();
    const key = encodeExecutionContextRef(ref);
    const firstFake = harness.fakes.get(key)!;
    const gate = new Deferred();
    const idle = vi.fn(async () => {
      await gate.promise;
    });
    firstFake.onDeactivate = idle;
    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS);
    expect(idle).toHaveBeenCalledOnce();
    const residency = vi.spyOn(contextStore, "setTargetResidency");
    contextStore.publishLeaseLoss(ref);
    await contextStore.publish(ref, "active");
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      residency.mock.calls.filter(([, target]) => target === "suspended"),
    ).toEqual([]);
    expect(releaseIfIdle).not.toHaveBeenCalled();
    expect((await contextStore.get(ref))?.targetResidency).toBe("active");
    expect(harness.fakes.get(key)).not.toBe(firstFake);
    expect(harness.fakes.get(key)?.calls).toContain("start");
  });

  it("stops a fenced local binding and rematerializes it after lease reclaim", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const ref = roomMetaRef("room-lease-loss");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldActivateOnRestore: async () => true,
    });
    await harness.manager.restore();

    const key = encodeExecutionContextRef(ref);
    const firstFake = harness.fakes.get(key)!;
    contextStore.publishLeaseLoss(ref);
    await vi.waitFor(() => expect(firstFake.calls).toContain("stop"));

    await contextStore.publish(ref, "active");
    // Lease cleanup schedules the default one-second restore retry. Advance
    // that clock explicitly instead of racing waitFor's one-second deadline.
    await vi.advanceTimersByTimeAsync(1_000);
    const current = harness.fakes.get(key);
    expect(current).not.toBe(firstFake);
    expect(current?.calls).toContain("create");
    expect(current?.calls).toContain("start");
    expect(firstFake.calls.filter((call) => call === "stop")).toHaveLength(1);
    await expect(contextStore.get(ref)).resolves.toEqual({
      ref,
      roomKind: "collaboration",
      targetResidency: "active",
    });
  });

  it("observes a Shell stop failure immediately while other cleanup is pending", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    await seedGhost(ghostStore);
    await contextStore.ensure(metaRef(), "active");
    const sources = new RecordingSourceProbe();
    const harness = createHarness({ ghostStore, contextStore, sources });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(metaRef()))!;
    const failure = new Error("terminal persistence failed");
    fake.stopError = failure;
    sources.stopGate = new Deferred();
    const unhandled: unknown[] = [];
    const observe = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", observe);
    const closed = harness.manager.close().catch((error: unknown) => error);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      sources.stopGate.resolve();
      const result = await closed;
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toContain(failure);
      process.off("unhandledRejection", observe);
    }
  });

  it("contains a failed lease-loss cleanup and retries cleanup before restoring", async () => {
    vi.useFakeTimers();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const ref = roomMetaRef("room-cleanup-failure");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldActivateOnRestore: async () => true,
    });
    await harness.manager.restore();
    const key = encodeExecutionContextRef(ref);
    const first = harness.fakes.get(key)!;
    first.stopError = new Error("native cleanup unconfirmed");
    contextStore.publishLeaseLoss(ref);
    await vi.advanceTimersByTimeAsync(0);
    await contextStore.publish(ref, "active");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.fakes.get(key)).toBe(first);
    first.stopError = null;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.fakes.get(key)).toBe(first);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.fakes.get(key)).not.toBe(first);
    expect(harness.fakes.get(key)?.calls).toContain("start");
  });

  it("releases a Context after an authoritative suspension stops its binding", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const releaseIfIdle = vi.fn(async () => true);
    Object.assign(contextStore, { releaseIfIdle });
    const ref = roomMetaRef("room-authority-idle-release");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "active");
    const harness = createHarness({ ghostStore, contextStore });
    await harness.manager.restore();
    await contextStore.publish(ref, "suspended");
    await vi.waitFor(() => expect(releaseIfIdle).toHaveBeenCalledWith(ref));
    expect(harness.fakes.get(encodeExecutionContextRef(ref))?.calls).toContain(
      "stop",
    );
  });

  it("materializes a newly leased Room Context after its deletion tombstone was rebuilt", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const ref = roomMetaRef("room-context-rebuilt");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "active");
    const harness = createHarness({ ghostStore, contextStore });
    await harness.manager.restore();
    const key = encodeExecutionContextRef(ref);
    const oldFake = harness.fakes.get(key)!;
    contextStore.publishTerminated(ref, "context_deleted");
    await vi.waitFor(() => expect(oldFake.calls).toContain("stop"));
    contextStore.terminalRecords.delete(key);
    await contextStore.publish(ref, "active");
    await vi.waitFor(() => expect(harness.fakes.get(key)).not.toBe(oldFake));
    expect(harness.fakes.get(key)?.calls).toContain("start");
  });

  it("unregisters run wakes and stops a terminal Room Context", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const runWakes = new RecordingRunWakes();
    const ref = roomMetaRef("room-deleted");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      runWakes,
    });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    const persistedTransitionsBeforeTermination =
      contextStore.persistedTransitions;

    contextStore.publishTerminated(ref);

    await vi.waitFor(() => {
      expect(runWakes.stopped).toEqual([encodeExecutionContextRef(ref)]);
      expect(fake.calls).toContain("stop");
    });
    await expect(harness.manager.getContextStatus(ref)).resolves.toBeNull();
    expect(contextStore.persistedTransitions).toBe(
      persistedTransitionsBeforeTermination,
    );
  });

  it("does not restore a terminal Room Context during an idempotent Agent update", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const ref = roomMetaRef("room-deleted");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "active");
    const harness = createHarness({ ghostStore, contextStore });
    await harness.manager.restore();

    contextStore.publishTerminated(ref);
    await vi.waitFor(async () => {
      await expect(harness.manager.getContextStatus(ref)).resolves.toBeNull();
    });

    await harness.manager.updateAgent("agent-1", {
      expectedRevision: registration.revision,
      revision: registration.revision,
      agent: registration.agent,
      runtime: registration.runtime,
      resources: registration.resources,
    });

    await expect(harness.manager.getContextStatus(ref)).resolves.toBeNull();
  });

  it("stops a Context whose terminal projection arrives while it is being created", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const ref = roomMetaRef("room-deleted");
    const fake = new FakeRuntime();
    fake.createGate = new Deferred();
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => fake,
    });

    const restoring = harness.manager.restore();
    await vi.waitFor(() => expect(fake.calls).toContain("create"));
    contextStore.publishTerminated(ref);
    fake.createGate.resolve();

    await expect(restoring).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fake.calls).toContain("stop"));
    await expect(harness.manager.getContextStatus(ref)).resolves.toBeNull();
    expect(fake.calls).not.toContain("start");
  });

  it("targets cancellation to exactly one Context", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const first = alterEgoRef("task-1");
    const second = alterEgoRef("task-2");
    await contextStore.ensure(first, "suspended");
    await contextStore.ensure(second, "suspended");
    const harness = createHarness({ ghostStore, contextStore });
    await harness.manager.restore();
    const firstFake = harness.fakes.get(encodeExecutionContextRef(first))!;
    const secondFake = harness.fakes.get(encodeExecutionContextRef(second))!;
    // A Run of the second Context was running before this process restored it.
    const runId = secondFake.state.queueInboxRun([message("running")]);
    secondFake.state.claimLocalRun();

    await expect(harness.manager.cancelLocalRun(second, runId)).resolves.toBe(
      "cancel_requested",
    );
    expect(firstFake.calls).not.toContain(`cancelRun:${runId}`);
    expect(secondFake.calls).toContain(`cancelRun:${runId}`);
  });

  it("materializes a durable Context before canceling a recovered Local Run", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const target = alterEgoRef("task-recovered");
    await contextStore.ensure(target, "suspended");
    const harness = createHarness({ ghostStore, contextStore });

    const result = await harness.manager.cancelLocalRun(
      target,
      "local-run-recovered",
    );

    expect(result).toBe("not_found");
    expect(
      harness.fakes.get(encodeExecutionContextRef(target))?.calls,
    ).toContain("cancelRun:local-run-recovered");
  });

  it("commits cleanup before stopping Fakes and deleting Context records and Ghost", async () => {
    const events: string[] = [];
    const ghostStore = new RecordingGhostStore(events);
    const contextStore = new RecordingContextStore(events);
    const sources = new RecordingSourceProbe(events);
    await seedGhost(ghostStore);
    const meta = metaRef();
    const alterEgo = alterEgoRef();
    await contextStore.ensure(meta, "suspended");
    await contextStore.ensure(alterEgo, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      sources,
      createRuntime: (ref) => {
        const fake = new FakeRuntime();
        fake.onStop = () => {
          events.push(`fake:stop:${encodeExecutionContextRef(ref)}`);
        };
        return fake;
      },
    });
    await harness.manager.restore();

    await expect(
      harness.manager.deleteAgent("agent-1", {
        beforeIdentityRemoval: async () => {
          events.push("identity:cleanup");
        },
      }),
    ).resolves.toBe("deleted");

    const lastBehavior = Math.max(
      ...events
        .map((event, index) => (event.startsWith("behavior:stop") ? index : -1))
        .filter((index) => index >= 0),
    );
    const firstFake = events.findIndex((event) =>
      event.startsWith("fake:stop"),
    );
    const records = events.indexOf("contexts:remove-agent:agent-1");
    const cleanup = events.indexOf("identity:cleanup");
    const ghost = events.indexOf("ghost:remove:agent-1");
    expect(lastBehavior).toBeLessThan(firstFake);
    expect(cleanup).toBeLessThan(firstFake);
    expect(cleanup).toBeLessThan(records);
    expect(cleanup).toBeLessThan(ghost);
    await expect(contextStore.listByAgent("agent-1")).resolves.toEqual([]);
    await expect(ghostStore.get("agent-1")).resolves.toBeNull();
  });

  it("keeps native deletion idempotent across stopContext then deleteAgent", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const meta = metaRef();
    const alterEgo = alterEgoRef();
    await contextStore.ensure(meta, "suspended");
    await contextStore.ensure(alterEgo, "suspended");
    const deletions: string[] = [];
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: (ref) => {
        const fake = new FakeRuntime();
        fake.onStop = () => {
          deletions.push(encodeExecutionContextRef(ref));
        };
        return fake;
      },
    });
    await harness.manager.restore();

    await harness.manager.stopContext(meta);
    await expect(harness.manager.deleteAgent("agent-1")).resolves.toBe(
      "deleted",
    );

    expect(deletions).toEqual([
      encodeExecutionContextRef(meta),
      encodeExecutionContextRef(alterEgo),
    ]);
    await expect(contextStore.listByAgent("agent-1")).resolves.toEqual([]);
    await expect(ghostStore.get("agent-1")).resolves.toBeNull();
  });

  const blockedActivationHarness = async (events: string[]) => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    await seedGhost(ghostStore);
    const harness = createHarness({
      ghostStore,
      createRuntime: () => {
        const fake = new FakeRuntime(events);
        fake.startGate = new Deferred();
        return fake;
      },
    });
    const ref = alterEgoRef();
    const turn = harness.manager
      .submitTrustedTurn({ target: ref, messages: [message("message-1")] })
      .catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(
        harness.fakes.get(encodeExecutionContextRef(ref))?.calls,
      ).toContain("start");
    });
    return { harness, ref, turn };
  };

  it("aborts a blocked activation so deleting the Agent does not wait for it", async () => {
    const events: string[] = [];
    const { harness, ref, turn } = await blockedActivationHarness(events);

    await expect(harness.manager.deleteAgent("agent-1")).resolves.toBe(
      "deleted",
    );

    expect(events.filter((event) => event.startsWith("runtime:"))).toEqual([
      "runtime:start",
      "runtime:aborted",
      "runtime:stop",
    ]);
    await expect(turn).resolves.toBeInstanceOf(Error);
    await delay(20);
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);
  });

  it("aborts a blocked activation before stopContext queues its permanent stop", async () => {
    const events: string[] = [];
    const { harness, ref, turn } = await blockedActivationHarness(events);

    await harness.manager.stopContext(ref);

    expect(events.filter((event) => event.startsWith("runtime:"))).toEqual([
      "runtime:start",
      "runtime:aborted",
      "runtime:stop",
    ]);
    await expect(turn).resolves.toBeInstanceOf(Error);
  });

  it("removes orphaned Context records when the Ghost is already absent", async () => {
    const contextStore = createInMemoryExecutionContextStore();
    await contextStore.ensure(metaRef(), "suspended");
    await contextStore.ensure(alterEgoRef(), "suspended");
    const harness = createHarness({ contextStore });

    await expect(harness.manager.deleteAgent("agent-1")).resolves.toBe(
      "not_found",
    );

    await expect(contextStore.listByAgent("agent-1")).resolves.toEqual([]);
  });

  it("uses deletion identity after a cold restart", async () => {
    const ref = alterEgoRef();
    const contextStore = createInMemoryExecutionContextStore();
    await contextStore.ensure(ref, "suspended");
    const ghostStore = Object.assign(createInMemoryGhostStore<TestRuntime>(), {
      getDeletionIdentity: vi.fn(async () => ({
        agentId: "agent-1",
        actorId: "actor-1",
        tenantId: "tenant-test",
        runtime: { model: "test-model" },
        contextRefs: [ref],
      })),
    });
    const beforeIdentityRemoval = vi.fn(async () => undefined);
    const harness = createHarness({ ghostStore, contextStore });

    await expect(
      harness.manager.deleteAgent("agent-1", { beforeIdentityRemoval }),
    ).resolves.toBe("deleted");
    expect(beforeIdentityRemoval).toHaveBeenCalledOnce();
    expect(harness.fakes.size).toBe(0);
    await expect(contextStore.get(ref)).resolves.toBeNull();
  });

  it("retains Context records and the Ghost when native deletion fails", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const ref = alterEgoRef();
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.onStop = () => {
          throw new Error("fixture native deletion failed");
        };
        return fake;
      },
    });
    await harness.manager.restore();

    await expect(harness.manager.deleteAgent("agent-1")).rejects.toThrow(
      "failed to stop all Execution Contexts",
    );
    await expect(contextStore.get(ref)).resolves.toEqual({
      ref,
      targetResidency: "suspended",
    });
    await expect(ghostStore.get("agent-1")).resolves.not.toBeNull();
  });

  it("retains Contexts and Ghost without stopping Fakes when cleanup cannot commit", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await seedGhost(ghostStore);
    const ref = alterEgoRef();
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({ ghostStore, contextStore });
    await harness.manager.restore();

    await expect(
      harness.manager.deleteAgent("agent-1", {
        beforeIdentityRemoval: async () => {
          throw new Error("Runner removal was not confirmed");
        },
      }),
    ).rejects.toThrow("Runner removal was not confirmed");

    await expect(contextStore.get(ref)).resolves.toEqual({
      ref,
      targetResidency: "suspended",
    });
    await expect(ghostStore.get("agent-1")).resolves.not.toBeNull();
    expect(
      harness.fakes.get(encodeExecutionContextRef(ref))?.calls,
    ).not.toContain("stop");
  });

  it("close stops Behavior before the Runtime and preserves Context records", async () => {
    const events: string[] = [];
    const ghostStore = new RecordingGhostStore(events);
    const contextStore = new RecordingContextStore(events);
    const sources = new RecordingSourceProbe(events);
    await seedGhost(ghostStore);
    const ref = alterEgoRef();
    await contextStore.ensure(ref, "suspended");
    const harness = createHarness({
      ghostStore,
      contextStore,
      sources,
      createRuntime: (target) => {
        const fake = new FakeRuntime();
        fake.onStop = () => {
          events.push(`fake:stop:${encodeExecutionContextRef(target)}`);
        };
        return fake;
      },
    });
    await harness.manager.restore();

    await harness.manager.close();

    expect(
      events.findIndex((event) => event.startsWith("behavior:stop")),
    ).toBeLessThan(events.findIndex((event) => event.startsWith("fake:stop")));
    expect(events).not.toContain("contexts:remove-agent:agent-1");
  });
});

describe("lazily restored Context idle policy", () => {
  // Local Computer Contexts suspend after LOCAL_COMPUTER_IDLE_TIMEOUT_MS.
  const setup = async (
    options: {
      shouldActivateOnRestore?: () => Promise<boolean>;
    } = {},
  ) => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const releaseIfIdle = vi.fn(async () => true);
    Object.assign(contextStore, { releaseIfIdle });
    await seedGhost(ghostStore, "agent-1");
    const ref = metaRef();
    await contextStore.ensure(ref, "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      shouldActivateOnRestore:
        options.shouldActivateOnRestore ?? (async () => false),
    });
    await harness.manager.restore();
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    return { ref, contextStore, releaseIfIdle, harness, fake };
  };

  it("suspends a lazily restored idle Context without activating its Runtime", async () => {
    vi.useFakeTimers();
    const { ref, contextStore, releaseIfIdle, fake } = await setup();

    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS - 1_000);
    expect((await contextStore.get(ref))?.targetResidency).toBe("active");

    await vi.advanceTimersByTimeAsync(2_000);
    expect((await contextStore.get(ref))?.targetResidency).toBe("suspended");
    expect(releaseIfIdle).toHaveBeenCalledOnce();
    expect(fake.calls).toEqual(["create"]);
  });

  it("activates through input before the lazy idle timer and uses the normal idle path afterwards", async () => {
    vi.useFakeTimers();
    const { ref, releaseIfIdle, harness, fake } = await setup();

    await vi.advanceTimersByTimeAsync(10_000);
    await harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("wake")],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toContain("start");
    expect(releaseIfIdle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS);
    expect(fake.calls).toContain("deactivate");
    expect(releaseIfIdle).toHaveBeenCalledOnce();
  });

  it("resumes a lazily suspended Context when a later message arrives", async () => {
    vi.useFakeTimers();
    const { ref, contextStore, harness, fake } = await setup();

    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS);
    expect((await contextStore.get(ref))?.targetResidency).toBe("suspended");

    await harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("wake-later")],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.activations).toHaveLength(1);
    expect((await contextStore.get(ref))?.targetResidency).toBe("active");
  });

  it("arms the normal idle timer for an eagerly restored Context", async () => {
    vi.useFakeTimers();
    const { fake } = await setup({
      shouldActivateOnRestore: async () => true,
    });

    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS);
    expect(fake.calls).toContain("deactivate");
  });

  it("retries the lazy idle check while the executor is busy", async () => {
    vi.useFakeTimers();
    const { ref, contextStore, fake } = await setup();
    fake.busy = true;

    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS);
    expect((await contextStore.get(ref))?.targetResidency).toBe("active");

    fake.busy = false;
    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS);
    expect((await contextStore.get(ref))?.targetResidency).toBe("suspended");
    expect(fake.calls).toEqual(["create"]);
  });
});

describe("Execution Context restart restore", () => {
  const seedRestart = async (room: string) => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const releaseIfIdle = vi.fn(async () => true);
    Object.assign(contextStore, { releaseIfIdle });
    const ref = roomMetaRef(room);
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const claim = () => contextStore.get(ref).then((record) => record ?? null);
    return { ghostStore, contextStore, releaseIfIdle, ref, claim };
  };
  const activations = (calls: readonly string[]) =>
    calls.filter((call) => call === "start" || call === "resume").length;

  it("activates a suspended Context without input or a Run, on the normal idle window", async () => {
    vi.useFakeTimers();
    const { ghostStore, contextStore, ref, claim } =
      await seedRestart("restart-activate");
    const harness = createHarness({ ghostStore, contextStore });

    expect(
      await harness.manager.restoreContextAfterRestart(ref, claim, () => true),
    ).toEqual({ status: "restored" });
    expect(await harness.manager.getContextStatus(ref)).toBe("active");
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(activations(fake.calls)).toBe(1);
    expect(fake.received).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.calls.some((call) => call === "deactivate")).toBe(false);
    await vi.advanceTimersByTimeAsync(LOCAL_COMPUTER_IDLE_TIMEOUT_MS - 30_000);
    expect(fake.calls).toContain("deactivate");
  });

  it("releases the lease without activating when the runtime is not admitted after the claim", async () => {
    const { ghostStore, contextStore, ref, claim, releaseIfIdle } =
      await seedRestart("restart-not-admitted");
    const harness = createHarness({ ghostStore, contextStore });

    expect(
      await harness.manager.restoreContextAfterRestart(ref, claim, () => false),
    ).toEqual({ status: "skipped" });
    expect(harness.fakes.has(encodeExecutionContextRef(ref))).toBe(false);
    expect(releaseIfIdle).toHaveBeenCalledWith(ref);
  });

  it("lets a real message that arrives during the restore join the same activation", async () => {
    const gate = new Deferred();
    const { ghostStore, contextStore, ref, claim } =
      await seedRestart("restart-joined");
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startGate = gate;
        fake.resumeGate = gate;
        return fake;
      },
    });
    const restoring = harness.manager.restoreContextAfterRestart(
      ref,
      claim,
      () => true,
    );
    await vi.waitFor(() =>
      expect(
        activations(
          harness.fakes.get(encodeExecutionContextRef(ref))?.calls ?? [],
        ),
      ).toBe(1),
    );
    const delivery = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message()],
    });
    gate.resolve();
    expect(await restoring).toEqual({ status: "restored" });
    await delivery;
    await vi.waitFor(async () =>
      expect(await harness.manager.getContextStatus(ref)).toBe("active"),
    );
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(activations(fake.calls)).toBe(1);
    expect(fake.received).toHaveLength(1);
  });

  it("skips when a real message already activated the Context", async () => {
    const { ghostStore, contextStore, ref, claim } = await seedRestart(
      "restart-message-first",
    );
    const harness = createHarness({ ghostStore, contextStore });
    await harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message()],
    });
    await vi.waitFor(async () =>
      expect(await harness.manager.getContextStatus(ref)).toBe("active"),
    );

    expect(
      await harness.manager.restoreContextAfterRestart(ref, claim, () => true),
    ).toEqual({ status: "skipped" });
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(activations(fake.calls)).toBe(1);
  });

  it("skips without activating when the claim returns no record", async () => {
    const { ghostStore, contextStore, ref } =
      await seedRestart("restart-claim-null");
    const harness = createHarness({ ghostStore, contextStore });

    expect(
      await harness.manager.restoreContextAfterRestart(
        ref,
        async () => null,
        () => true,
      ),
    ).toEqual({ status: "skipped" });
    expect(harness.fakes.has(encodeExecutionContextRef(ref))).toBe(false);
  });

  it("suspends a failed restore, releases its lease and reports the failure", async () => {
    const { ghostStore, contextStore, releaseIfIdle, ref, claim } =
      await seedRestart("restart-failed");
    const harness = createHarness({
      ghostStore,
      contextStore,
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = new Error("Local Computer runner offline");
        return fake;
      },
    });

    const outcome = await harness.manager.restoreContextAfterRestart(
      ref,
      claim,
      () => true,
    );
    expect(outcome).toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        message: "Local Computer runner offline",
      }),
    });
    expect(releaseIfIdle).toHaveBeenCalledWith(ref);
    expect((await contextStore.get(ref))?.targetResidency).toBe("suspended");
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.received).toEqual([]);
    expect(fake.calls).not.toContain("presence");
  });
});

describe("Execution Context Room presence preparation", () => {
  const presence = (allowed = true) => ({ allows: vi.fn(() => allowed) });
  const seed = async (room: string) => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const releaseIfIdle = vi.fn(async () => true);
    Object.assign(contextStore, { releaseIfIdle });
    const ref = roomMetaRef(room);
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "suspended");
    const claim = () => contextStore.get(ref).then((record) => record ?? null);
    return { ghostStore, contextStore, releaseIfIdle, ref, claim };
  };
  const resumes = (fake: FakeRuntime) => fake.activations;

  it("activates a used Context on every presence hint and reclaims it after 30 seconds", async () => {
    vi.useFakeTimers();
    const { ghostStore, contextStore, ref, claim } =
      await seed("room-presence");
    const harness = createHarness({
      ghostStore,
      contextStore,
      presencePreparation: presence(),
    });

    harness.manager.prepareContextForPresence(ref, claim);
    await vi.advanceTimersByTimeAsync(0);
    expect(await harness.manager.getContextStatus(ref)).toBe("active");
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.calls).toContain("deactivate");
    expect((await contextStore.get(ref))?.targetResidency).toBe("suspended");

    harness.manager.prepareContextForPresence(ref, claim);
    await vi.advanceTimersByTimeAsync(0);
    expect(await harness.manager.getContextStatus(ref)).toBe("active");
    expect(resumes(fake)).toHaveLength(2);
  });

  it("does not activate a warm Runtime again for repeated hints", async () => {
    const { ghostStore, contextStore, ref, claim } =
      await seed("room-presence-warm");
    const harness = createHarness({
      ghostStore,
      contextStore,
      presencePreparation: presence(),
    });
    harness.manager.prepareContextForPresence(ref, claim);
    harness.manager.prepareContextForPresence(ref, claim);
    harness.manager.prepareContextForPresence(ref, claim);
    const fake = await vi.waitFor(() => {
      const current = harness.fakes.get(encodeExecutionContextRef(ref));
      expect(current?.calls.filter((call) => call === "presence")).toHaveLength(
        3,
      );
      return current!;
    });
    expect(resumes(fake)).toHaveLength(1);
  });

  it("activates a Context restored as active but deferred until input", async () => {
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = new PushContextStore();
    const ref = roomMetaRef("room-presence-deferred");
    await seedGhost(ghostStore, "agent-1");
    await contextStore.ensure(ref, "active");
    const harness = createHarness({
      ghostStore,
      contextStore,
      presencePreparation: presence(),
    });
    harness.manager.prepareContextForPresence(ref, () =>
      contextStore.get(ref).then((record) => record ?? null),
    );
    await vi.waitFor(() =>
      expect(
        harness.fakes.get(encodeExecutionContextRef(ref))?.calls,
      ).toContain("start"),
    );
    expect(await harness.manager.getContextStatus(ref)).toBe("active");
  });

  it("drops a hint whose Computer is not ready without claiming or waking it", async () => {
    vi.useFakeTimers();
    const { ghostStore, contextStore, releaseIfIdle, ref, claim } = await seed(
      "room-presence-offline",
    );
    const claimed = vi.fn(claim);
    const gate = presence(false);
    const harness = createHarness({
      ghostStore,
      contextStore,
      presencePreparation: gate,
    });
    harness.manager.prepareContextForPresence(ref, claimed);
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.allows).toHaveBeenCalledOnce();
    expect(claimed).not.toHaveBeenCalled();
    expect(releaseIfIdle).not.toHaveBeenCalled();
    expect(harness.fakes.has(encodeExecutionContextRef(ref))).toBe(false);
  });

  it("never holds a claimed lease for a terminal Context", async () => {
    const { ghostStore, contextStore, releaseIfIdle, ref } = await seed(
      "room-presence-terminal",
    );
    // The claim sees the terminal row before the Manager does.
    const terminal = {
      ref,
      targetResidency: "suspended" as const,
      terminalReason: "room_deleted" as const,
    };
    Object.assign(contextStore, { get: async () => terminal });
    const harness = createHarness({
      ghostStore,
      contextStore,
      presencePreparation: presence(),
    });
    harness.manager.prepareContextForPresence(ref, async () => terminal);
    await vi.waitFor(() => expect(releaseIfIdle).toHaveBeenCalledWith(ref));
    expect(harness.fakes.has(encodeExecutionContextRef(ref))).toBe(false);
  });

  it("rolls back a failed activation and releases its lease without prestarting", async () => {
    vi.useFakeTimers();
    const { ghostStore, contextStore, releaseIfIdle, ref, claim } = await seed(
      "room-presence-failed",
    );
    const harness = createHarness({
      ghostStore,
      contextStore,
      presencePreparation: presence(),
      createRuntime: () => {
        const fake = new FakeRuntime();
        fake.startError = new Error("Local Computer runner offline");
        return fake;
      },
    });
    harness.manager.prepareContextForPresence(ref, claim);
    await vi.advanceTimersByTimeAsync(0);
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(releaseIfIdle).toHaveBeenCalledWith(ref);
    expect((await contextStore.get(ref))?.targetResidency).toBe("suspended");
    expect(await harness.manager.getContextStatus(ref)).toBe("suspended");
    expect(fake.calls).not.toContain("presence");
  });

  // Like a real Agent runtime: busy while its activation is pending, which only
  // abortActivation (or the test) settles.
  const blockedActivationFake = (events: string[]) => {
    const fake = new FakeRuntime(events);
    const activation = new Deferred();
    fake.startGate = activation;
    fake.resumeGate = activation;
    return { fake, activation };
  };
  const modelUpdate = {
    expectedRevision: "revision-1",
    revision: "revision-2",
    agent: registration.agent,
    runtime: { model: "updated-model" },
    resources: { skills: [], mcpServers: [] },
  };

  it("aborts a blocked presence preparation so a configuration update does not wait for it", async () => {
    const { ghostStore, contextStore, ref, claim } = await seed(
      "room-presence-update",
    );
    const events: string[] = [];
    let blocked: FakeRuntime | undefined;
    const harness = createHarness({
      ghostStore,
      contextStore,
      presencePreparation: presence(),
      createRuntime: () => {
        if (blocked) return new FakeRuntime();
        blocked = blockedActivationFake(events).fake;
        return blocked;
      },
    });
    harness.manager.prepareContextForPresence(ref, claim);
    await vi.waitFor(() => expect(blocked?.activations).toHaveLength(1));

    await expect(
      harness.manager.updateAgent("agent-1", modelUpdate),
    ).resolves.toEqual({ agentId: "agent-1", revision: "revision-2" });

    expect(events.filter((event) => event === "runtime:aborted")).toHaveLength(
      1,
    );
    const replacement = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(replacement).not.toBe(blocked);
    expect(replacement.configurationRevision).toBe("revision-2");
  });

  it("does not abort an activation that carries real input", async () => {
    const { ghostStore, contextStore, ref } = await seed(
      "room-presence-update-input",
    );
    const events: string[] = [];
    let activation: Deferred | undefined;
    const harness = createHarness({
      ghostStore,
      contextStore,
      presencePreparation: presence(),
      createRuntime: () => {
        const blocked = blockedActivationFake(events);
        activation ??= blocked.activation;
        return blocked.fake;
      },
    });
    const turn = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message("message-1")],
    });
    await vi.waitFor(() =>
      expect(
        harness.fakes.get(encodeExecutionContextRef(ref))?.activations,
      ).toHaveLength(1),
    );

    await expect(
      harness.manager.updateAgent("agent-1", modelUpdate),
    ).rejects.toMatchObject({ code: "agent_busy" });

    expect(events).not.toContain("runtime:aborted");
    activation!.resolve();
    await expect(turn).resolves.toBeDefined();
  });

  it("prestarts the Provider after a presence activation and again on a warm hint", async () => {
    vi.useFakeTimers();
    const { ghostStore, contextStore, ref, claim } = await seed(
      "room-presence-prestart",
    );
    const harness = createHarness({
      ghostStore,
      contextStore,
      presencePreparation: presence(),
    });
    harness.manager.prepareContextForPresence(ref, claim);
    await vi.advanceTimersByTimeAsync(0);
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    const prestarts = () => fake.calls.filter((call) => call === "presence");
    expect(prestarts()).toHaveLength(1);

    harness.manager.prepareContextForPresence(ref, claim);
    await vi.advanceTimersByTimeAsync(0);
    expect(prestarts()).toHaveLength(2);
  });

  it("never prestarts for Room preparation", async () => {
    const room = await seed("room-preparation-no-prestart");
    const harness = createHarness({
      ghostStore: room.ghostStore,
      contextStore: room.contextStore,
      shouldPrepareContext: shouldPrepareRoomMetaContext,
    });
    harness.manager.scheduleContextPreparation(room.ref);
    await vi.waitFor(async () =>
      expect(await harness.manager.getContextStatus(room.ref)).toBe("active"),
    );
    expect(
      harness.fakes.get(encodeExecutionContextRef(room.ref))?.calls,
    ).not.toContain("presence");
  });

  it("renews an unused activation when another hint arrives", async () => {
    vi.useFakeTimers();
    const { ghostStore, contextStore, ref, claim } = await seed(
      "room-presence-renew",
    );
    const harness = createHarness({
      ghostStore,
      contextStore,
      presencePreparation: presence(),
    });
    harness.manager.prepareContextForPresence(ref, claim);
    await vi.advanceTimersByTimeAsync(20_000);
    harness.manager.prepareContextForPresence(ref, claim);
    await vi.advanceTimersByTimeAsync(20_000);
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    expect(fake.calls.some((call) => call === "deactivate")).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.calls).toContain("deactivate");
  });

  it("gives foreground input an ordinary activation when its shared presence activation fails", async () => {
    const { ghostStore, contextStore, releaseIfIdle, ref, claim } = await seed(
      "room-presence-input-race",
    );
    const gate = new Deferred();
    const harness = createHarness({
      ghostStore,
      contextStore,
      presencePreparation: presence(),
      createRuntime: () => {
        const fake = new FakeRuntime();
        let first = true;
        fake.onActivate = async () => {
          if (first) {
            first = false;
            await gate.promise;
            throw new Error("Local Computer runner refused");
          }
        };
        return fake;
      },
    });
    harness.manager.prepareContextForPresence(ref, claim);
    await vi.waitFor(() =>
      expect(
        harness.fakes.get(encodeExecutionContextRef(ref))?.activations,
      ).toHaveLength(1),
    );
    const submitted = harness.manager.submitTrustedTurn({
      target: ref,
      messages: [message()],
    });
    await vi.waitFor(() =>
      expect(
        harness.fakes.get(encodeExecutionContextRef(ref))?.received,
      ).toHaveLength(1),
    );
    gate.resolve();
    // The submission joined the failed activation and reports it; its
    // accepted input still drives a fresh activation.
    await expect(submitted).rejects.toThrow("Local Computer runner refused");
    await vi.waitFor(async () =>
      expect(await harness.manager.getContextStatus(ref)).toBe("active"),
    );
    const fake = harness.fakes.get(encodeExecutionContextRef(ref))!;
    await vi.waitFor(() => expect(resumes(fake)).toHaveLength(2));
    expect(releaseIfIdle).not.toHaveBeenCalled();
  });
});
