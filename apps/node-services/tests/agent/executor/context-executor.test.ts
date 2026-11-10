import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  LocalComputerModelError,
  LocalComputerOfflineError,
} from "../../../src/agent/runner-gateway/local-computer-management.js";
import { RunnerOperationError } from "../../../src/agent/runner-gateway/runner-operation.js";
import {
  createTeamHubContextRuntimeState,
  type ExecutionResources,
} from "../../../src/agent/executor/context-runtime-state.js";
import { createTeamHubRuntimeStateClientFake } from "../test-support/teamhub-runtime-state-client.js";
import type { RuntimeHistoryPage } from "../../../src/agent/executor/history.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimAgentFailureAlert,
  type AgentLogger,
} from "../../../src/agent/observability/agent-log.js";
import { ExecutorRegistry } from "../../../src/agent/executor/registry.js";
import { createInMemoryGhostStore } from "../test-support/in-memory-ghost-store.js";
import { closeAgentManagerResources } from "../../../src/agent/bootstrap/agent-manager-shutdown.js";
import {
  ContextRuntimeCleanupError,
  type ActivatedContextRuntime,
  type ContextRuntimeActivationRequest,
  type ContextRuntimeActivator,
} from "../../../src/agent/executor/activation.js";
import type { ExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import { createInMemoryExecutionContextStore } from "../test-support/in-memory-execution-context-store.js";
import { TeamHubRuntimeStateError } from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import {
  createBuiltinAgentFeatures,
  type BuiltinAgentFeatures,
} from "../../../src/agent/agent-features/builtin.js";
import { composeContextFeatures } from "../../../src/agent/agent-features/compose.js";
import {
  defineFeature,
  type RunTerminalEvent,
} from "../../../src/agent/agent-features/contracts.js";
import { mergePromptInputContribution } from "../../../src/agent/prompt/input-contribution-merger.js";
import type {
  RunWakeTarget,
  RunWakeTargetRegistrar,
} from "../../../src/agent/agent-features/inbox-source/types.js";
import type {
  ContextRuntimeStateFactory,
  RuntimeHistoryInspectionRequest,
} from "../../../src/agent/executor/context-executor.js";
import type {
  AgentInput,
  AgentProvider,
  AgentRun,
  ExecutionSpec,
  ProviderSessionOptions,
  ProviderSteerOptions,
  RunResult,
  RuntimeSession,
} from "../../../src/agent/executor/provider.js";
import type { Message } from "../../../src/agent/executor/types.js";
import { TestContextRuntimeState as ContextRuntimeState } from "../test-support/context-runtime-state.js";
import { createTestFeatureAssembly } from "../test-support/executor-features.js";
import {
  createExecutorHandle,
  createStandaloneExecutor,
  type StandaloneExecutorOptions,
} from "../test-support/standalone-executor.js";

interface TestRuntime {
  readonly type: "local";
  readonly placement: {
    readonly runtimeType: "codex";
    readonly computerId: string;
  };
}

const localRuntime: TestRuntime = {
  type: "local",
  placement: { runtimeType: "codex", computerId: "computer-1" },
};

// Shells created over the same root share their Runtime state, as a restarted
// process reads the same TeamHub rows.
const testRuntimeState =
  (root: string): ContextRuntimeStateFactory<TestRuntime> =>
  async (input) =>
    new ContextRuntimeState({
      databasePath: path.join(root, "runtime.sqlite"),
      ref: input.ref,
    });

const testFeatureLogger = (): AgentLogger => {
  const logger: AgentLogger = {
    log: () => undefined,
    child: () => logger,
  };
  return logger;
};

const testManagerFeatures = (
  runWakes?: RunWakeTargetRegistrar,
  onRunTerminal?: (event: RunTerminalEvent) => void,
): Pick<BuiltinAgentFeatures, "composeContext"> => {
  const builtin = createBuiltinAgentFeatures({
    services: {
      logger: testFeatureLogger(),
      ...(runWakes ? { runWakes } : {}),
    },
  });
  if (!onRunTerminal) return builtin;
  const terminalRecorder = defineFeature({
    id: "test-terminal-recorder",
    context: {
      ports: { onRunTerminal: {} },
      create: () => ({
        onRunTerminal: (_context, event) => onRunTerminal(event),
      }),
    },
  });
  return {
    composeContext: (input) =>
      composeContextFeatures({
        context: input.context,
        features: [
          ...builtin.contextDeclarations(input.host),
          terminalRecorder,
        ],
        mergeInputContribution: mergePromptInputContribution,
      }),
  };
};

// A harness whose Runtime state the test seeds as TeamHub would.
const createSeededHarness = async (
  provider: RecordingProvider,
  existingRoot?: string,
) => {
  let state: ContextRuntimeState | undefined;
  const harness = await createHarness(
    provider,
    existingRoot,
    undefined,
    (root) => async (input) => {
      state = (await testRuntimeState(root)(input)) as ContextRuntimeState;
      return state;
    },
  );
  // Keep the harness getters live.
  return Object.assign(harness, {
    state: () => {
      if (!state) throw new Error("Shell state was not created");
      return state;
    },
  });
};

const testFeaturePorts = (ref: ExecutionContextRef) =>
  createTestFeatureAssembly({ ref, actorId: "actor-agent-1" }).ports;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ContextExecutor Runtime", () => {
  it.each([
    "notification",
    "refresh failure",
    "concurrent notification",
    "drain",
  ])(
    "refreshes remotely queued work in an already active Shell: %s",
    async (scenario) => {
      let queued = false;
      const claimRun = vi.fn(async () => {
        queued = false;
        return { claimed: false };
      });
      const ref = {
        kind: "document",
        agentId: "agent-1",
        documentId: "document-1",
      } as const;
      const client = createTeamHubRuntimeStateClientFake({
        getContext: async () => ({
          context_key: JSON.stringify(["document", "agent-1", "document-1"]),
          ref: {
            kind: "document",
            agent_id: "agent-1",
            document_id: "document-1",
          },
          tenant_id: "tenant-test",
          agent_actor_id: "actor-agent-1",
          target_residency: "active",
          state_revision: "1",
          next_input_sequence: "1",
        }),
        getWorkState: async () => ({
          has_pending_work: queued,
          has_queued_runs: queued,
        }),
        getSession: async () => ({ available: false }),
        checkpointSession: async (body) => ({
          ...body.checkpoint,
          revision: "1",
          updated_at: "2026-09-20T00:00:00Z",
        }),
        claimRun,
      });
      const getWorkState = vi.spyOn(client, "getWorkState");
      const provider = new RecordingProvider();
      const harness = await createHarness(
        provider,
        undefined,
        undefined,
        () => async () =>
          createTeamHubContextRuntimeState({
            client,
            ref,
            configurationRevision: "1",
            providerKind: "codex",
          }),
      );
      try {
        await harness.create({
          ...harness.createOptions,
          ref,
          features: testFeaturePorts(ref),
        });
        await harness.executor.start();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(harness.executor.isRuntimeReady()).toBe(true);
        expect(harness.activations[0]?.executionEpoch).toBe(client.epoch);
        queued = true;
        if (scenario === "refresh failure") {
          getWorkState.mockRejectedValueOnce(
            new Error("temporary unavailable"),
          );
          const calls = getWorkState.mock.calls.length;
          harness.executor.notifyWorkAvailable();
          await vi.waitFor(() =>
            expect(getWorkState.mock.calls.length).toBe(calls + 1),
          );
          expect(claimRun).not.toHaveBeenCalled();
        }
        if (scenario === "concurrent notification" || scenario === "drain") {
          let finishRefresh!: (
            value: Awaited<ReturnType<typeof client.getWorkState>>,
          ) => void;
          getWorkState.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finishRefresh = resolve;
              }),
          );
          harness.executor.notifyWorkAvailable();
          await vi.waitFor(() => expect(finishRefresh).toBeDefined());
          if (scenario === "drain") {
            const stopped = harness.executor.stop();
            finishRefresh({
              has_pending_work: true,
              has_queued_runs: true,
            });
            await stopped;
            expect(claimRun).not.toHaveBeenCalled();
            return;
          }
          harness.executor.notifyWorkAvailable();
          finishRefresh({
            has_pending_work: false,
            has_queued_runs: false,
          });
        } else {
          harness.executor.notifyWorkAvailable();
        }
        await vi.waitFor(() => expect(claimRun).toHaveBeenCalledOnce(), {
          timeout: 1000,
        });
      } finally {
        await harness.executor.stop();
      }
    },
  );

  it.each([
    ["offline", new LocalComputerOfflineError(), false, false],
    ["real failure", new Error("provider failed"), true, false],
    [
      "failure already alerted by Context Runtime",
      new Error("provider failed after inner alert"),
      false,
      true,
    ],
    [
      "offline with cleanup failure",
      new AggregateError([
        new LocalComputerOfflineError(),
        new Error("cleanup failed"),
      ]),
      true,
      false,
    ],
  ] as const)(
    "preserves the Shell alert boundary for %s",
    async (_label, failure, alerts, alreadyAlerted) => {
      if (alreadyAlerted) expect(claimAgentFailureAlert(failure)).toBe(true);
      vi.stubEnv("AGENT_LOG_LEVEL", "debug");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const infos = vi.spyOn(console, "log").mockImplementation(() => {});
      const root = await mkdtemp(
        path.join(os.tmpdir(), "context-shell-offline-"),
      );
      temporaryDirectories.push(root);
      const shell = await createStandaloneExecutor<TestRuntime>({
        activator: {
          async activate() {
            throw failure;
          },
        },
        stateFactory: testRuntimeState(root),
        options: {
          ref: metaRef,
          actorId: "actor-agent-1",
          tenantId: "tenant-test",
          agent: { name: "Agent", instructions: "test" },
          runtime: localRuntime,
          resources: { skills: [], mcpServers: [] },
          features: testFeaturePorts(metaRef),
        },
      });
      try {
        await expect(shell.start()).rejects.toBe(failure);
        expect(
          errors.mock.calls.some((args) =>
            String(args[0]).includes("runtime.activation.failed"),
          ),
        ).toBe(alerts);
        expect(
          infos.mock.calls.some((args) =>
            String(args[0]).includes("runtime.activation.waiting_for_computer"),
          ),
        ).toBe(failure instanceof LocalComputerOfflineError);
      } finally {
        await shell.stop();
        errors.mockRestore();
        infos.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("waits for cancellation authority before releasing Context resources", async () => {
    const provider = new GracefulRecycleProvider();
    const authority = deferred<{ type: "canceled" }>();
    const reconciliationStarted = deferred<void>();
    const harness = await createHarness(
      provider,
      undefined,
      undefined,
      (root) => async (input) => {
        const state = await testRuntimeState(root)(input);
        vi.spyOn(state, "finishLocalRun").mockImplementation(() => {
          throw new TeamHubRuntimeStateError(
            409,
            "epoch replaced",
            "CONTEXT_FENCED",
          );
        });
        return Object.assign(state, {
          reconcileRevokedLocalRun: async (_runId: string, error: unknown) => {
            if (!(error instanceof TeamHubRuntimeStateError)) return null;
            reconciliationStarted.resolve();
            return authority.promise;
          },
        });
      },
    );
    await harness.create(harness.createOptions);
    const terminal = vi.fn();
    harness.onTerminal(terminal);
    const active = await harness.executor.submitTrustedTurn([
      message("active", "work"),
    ]);
    await harness.executor.start();
    await provider.started.promise;
    const stopping = harness.executor.stop();
    await reconciliationStarted.promise;
    expect(provider.run.cancelCalls).toBe(1);
    expect(harness.deactivations).toBe(0);
    expect(terminal).not.toHaveBeenCalled();
    authority.resolve({ type: "canceled" });
    await stopping;
    expect(harness.deactivations).toBe(1);
    expect(provider.closedAfterRun).toBe(true);
    expect(terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: active.runId,
        terminal: { type: "canceled" },
      }),
    );
  });

  it("retains failed native cleanup instead of claiming a later stop succeeded", async () => {
    const provider = new RecordingProvider();
    const close = vi
      .spyOn(provider, "close")
      .mockRejectedValueOnce(new Error("native cleanup unconfirmed"))
      .mockResolvedValueOnce(undefined);
    const harness = await createHarness(provider);
    await harness.create(harness.createOptions);
    await harness.executor.start();
    await expect(harness.executor.stop()).rejects.toThrow(
      "native cleanup unconfirmed",
    );
    await expect(harness.executor.stop()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    expect(harness.deactivations).toBe(2);
  });

  it.each([true, false])(
    "gives an active Run a bounded completion window before cancellation (finishes=%s)",
    async (finishes) => {
      const provider = new GracefulRecycleProvider();
      const harness = await createHarness(provider);
      await harness.create(harness.createOptions);
      const terminal = vi.fn();
      harness.onTerminal(terminal);
      const active = await harness.executor.submitTrustedTurn([
        message("active", "work"),
      ]);
      await harness.executor.start();
      await provider.started.promise;
      const queued = await harness.executor.submitTrustedTurn([
        message("queued", "later"),
      ]);
      const stopping = harness.executor.stop({ gracePeriodMs: 100 });
      expect(provider.run.cancelCalls).toBe(0);
      expect(harness.deactivations).toBe(0);
      await expect(
        harness.executor.submitTrustedTurn([message("late", "rejected")]),
      ).rejects.toThrow();
      if (finishes) provider.run.succeed();
      await stopping;
      expect(provider.run.cancelCalls).toBe(finishes ? 0 : 1);
      expect(provider.closedAfterRun).toBe(true);
      expect(terminal).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: active.runId,
          terminal: expect.objectContaining({
            type: finishes ? "succeeded" : "canceled",
          }),
        }),
      );
      expect(provider.starts).toHaveLength(1);
      const restored = await createHarness(
        new RecordingProvider(),
        harness.root,
      );
      await restored.create(harness.createOptions);
      expect(await restored.executor.observeTurn(queued.runId)).toMatchObject({
        status: "queued",
      });
      await restored.executor.stop();
    },
  );

  it("deactivates the runtime when its first durable session write fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-shell-test-"));
    temporaryDirectories.push(root);
    const events: string[] = [];
    const provider = new RecordingProvider();
    const activator: ContextRuntimeActivator<TestRuntime> = {
      async activate(request) {
        return {
          ref: request.ref,
          provider,
          runtimeName: "test",
          runtimeSession: {
            threadId: "thread-uncheckpointed",
            invalidJson: 1n,
          },
          sessionSpec: {
            workingDirectory: "/workspace",
            threadName: request.agent.name,
            sandboxMode: "workspace-write",
            resources: { mcpServers: [] },
          },
          setActiveRunContext() {},
          async deactivate() {
            events.push("runtime.deactivate");
          },
        };
      },
    };
    const shell = await createStandaloneExecutor<TestRuntime>({
      activator: activator,
      stateFactory: testRuntimeState(root),
      options: {
        ref: metaRef,
        actorId: "actor-agent-1",
        tenantId: "tenant-test",
        agent: { name: "Agent One", instructions: "test" },
        runtime: localRuntime,
        resources: { skills: [], mcpServers: [] },
        features: testFeaturePorts(metaRef),
      },
    });

    await expect(shell.start()).rejects.toThrow(
      "RuntimeSession must be JSON-serializable",
    );
    expect(events).toEqual(["runtime.deactivate"]);

    await shell.stop();
  });

  it("activates with the process epoch and the last checkpointed resources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-shell-test-"));
    temporaryDirectories.push(root);
    const activationFailure = new Error("activation stopped after reads");
    const activate = vi.fn(async (_request: unknown) => {
      throw activationFailure;
    });
    const savedResources: ExecutionResources = {
      version: 1,
      effectiveSha256: "sha-1",
      skills: [],
    };
    const createState: ContextRuntimeStateFactory<TestRuntime> = async (
      input,
    ) =>
      Object.assign(
        new ContextRuntimeState({
          databasePath: path.join(root, "runtime.sqlite"),
          ref: input.ref,
        }),
        {
          executionEpoch: () => "agent-epoch-test",
          getExecutionResources: () => savedResources,
        },
      );
    const shell = await createStandaloneExecutor<TestRuntime>({
      activator: { activate },
      stateFactory: createState,
      options: {
        ref: metaRef,
        actorId: "actor-agent-1",
        tenantId: "tenant-test",
        agent: { name: "Agent One", instructions: "test" },
        runtime: localRuntime,
        resources: { skills: [], mcpServers: [] },
        features: testFeaturePorts(metaRef),
      },
    });

    await expect(shell.start()).rejects.toBe(activationFailure);
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({ executionEpoch: "agent-epoch-test" }),
    );

    await shell.stop();
  });

  it("fails activation with a rejected activation read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-shell-test-"));
    temporaryDirectories.push(root);
    const readFailure = new Error("execution resources unavailable");
    const activate = vi.fn(async () => {
      throw new Error("activation must not run after a failed read");
    });
    const createState: ContextRuntimeStateFactory<TestRuntime> = async (
      input,
    ) =>
      Object.assign(
        new ContextRuntimeState({
          databasePath: path.join(root, "runtime.sqlite"),
          ref: input.ref,
        }),
        {
          getExecutionResources: async () => {
            throw readFailure;
          },
        },
      );
    const shell = await createStandaloneExecutor<TestRuntime>({
      activator: { activate },
      stateFactory: createState,
      options: {
        ref: metaRef,
        actorId: "actor-agent-1",
        tenantId: "tenant-test",
        agent: { name: "Agent One", instructions: "test" },
        runtime: localRuntime,
        resources: { skills: [], mcpServers: [] },
        features: testFeaturePorts(metaRef),
      },
    });

    await expect(shell.start()).rejects.toBe(readFailure);
    expect(activate).not.toHaveBeenCalled();

    await shell.stop();
  });

  it("executes a trusted turn and publishes its terminal only after persistence", async () => {
    const provider = new RecordingProvider();
    const harness = await createHarness(provider);
    const terminals: Array<{ runId: string; type: string }> = [];

    await harness.create(harness.createOptions);
    harness.onTerminal((signal) => {
      terminals.push({ runId: signal.runId, type: signal.terminal.type });
    });
    const { runId } = await harness.executor.submitTrustedTurn([
      message("workflow-turn-1", "execute the workflow node"),
    ]);
    await expect(harness.executor.observeTurn(runId)).resolves.toMatchObject({
      runId,
      status: "queued",
    });

    await harness.executor.start();
    await eventually(() =>
      expect(terminals).toEqual([{ runId, type: "succeeded" }]),
    );
    await expect(harness.executor.observeTurn(runId)).resolves.toEqual({
      runId,
      status: "succeeded",
      terminal: { type: "succeeded", finalResponse: "internal result only" },
    });
    await harness.executor.stop();
  });

  it("applies a revision-only Skill update through a new Shell generation without interrupting a busy turn", async () => {
    const provider = new GracefulRecycleProvider();
    const first = await createHarness(provider);
    const restored = await createHarness(new RecordingProvider(), first.root);
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    await ghostStore.insert({
      agentId: "agent-1",
      actorId: "actor-agent-1",
      tenantId: "tenant-test",
      revision: "1",
      agent: first.createOptions.agent,
      runtime: first.createOptions.runtime,
      resources: first.createOptions.resources,
    });
    await contextStore.ensure(metaRef, "active");
    let executors = 0;
    let activator = first.services.activator;
    const manager = new ExecutorRegistry<TestRuntime>({
      ghostStore,
      contextStore,
      identityResolver: {
        resolveIdentity: async () => ({
          actorId: "actor-agent-1",
          agentType: "general",
          sponsor: { actorId: "human-1", displayName: "Test Owner" },
        }),
      },
      executorServices: {
        activator: { activate: (request) => activator.activate(request) },
        stateFactory: (input) => {
          executors += 1;
          return first.services.stateFactory(input);
        },
      },
      features: testManagerFeatures(),
    });
    const update = {
      expectedRevision: "1",
      revision: "2",
      agent: first.createOptions.agent,
      runtime: first.createOptions.runtime,
      resources: first.createOptions.resources,
    };
    try {
      await manager.restore();
      await manager.submitTrustedTurn({
        target: metaRef,
        messages: [message("busy-skill-update", "finish existing work")],
      });
      await provider.started.promise;
      await expect(
        manager.updateAgent("agent-1", update),
      ).rejects.toMatchObject({ code: "agent_busy" });
      expect(provider.run.cancelCalls).toBe(0);
      expect(first.deactivations).toBe(0);
      expect(executors).toBe(1);
      activator = restored.services.activator;
      provider.run.succeed();
      await eventually(async () => {
        await manager.updateAgent("agent-1", update);
      });
      expect(executors).toBe(2);
      await eventually(() => expect(restored.activations).toHaveLength(1));
      expect(restored.activations[0]).toMatchObject({
        ref: metaRef,
        mode: "resume",
        previousSession: { threadId: "thread-1" },
      });
      expect(first.deactivations).toBe(1);
      expect(provider.run.cancelCalls).toBe(0);
      await expect(contextStore.get(metaRef)).resolves.toMatchObject({
        targetResidency: "active",
      });
    } finally {
      await manager.close();
    }
  });

  it("cancels a response-lost trusted submission by immutable Message identity", async () => {
    const provider = new RecordingProvider();
    const harness = await createHarness(provider);
    const trustedMessage = message(
      "response-lost-turn",
      "must not run after Task termination",
    );

    await harness.create(harness.createOptions);
    const submitted = await harness.executor.submitTrustedTurn([
      trustedMessage,
    ]);
    const canceled = await harness.executor.cancelTrustedTurn([trustedMessage]);
    const replay = await harness.executor.submitTrustedTurn([trustedMessage]);

    expect(canceled).toEqual({
      runId: submitted.runId,
      status: "canceled",
    });
    expect(replay.runId).toBe(submitted.runId);
    await expect(
      harness.executor.observeTurn(submitted.runId),
    ).resolves.toEqual({
      runId: submitted.runId,
      status: "canceled",
      terminal: { type: "canceled" },
    });

    await harness.executor.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(provider.inputs).toHaveLength(0);
    await harness.executor.stop();
  });

  it("executes durable Context messages as Local Runs without an output callback", async () => {
    const provider = new RecordingProvider();
    const harness = await createHarness(provider);

    await harness.create(harness.createOptions);
    await harness.executor.start();
    await harness.executor.submitTrustedTurn([
      message("message-1", "do the work"),
    ]);
    await eventually(() => expect(provider.inputs).toHaveLength(1));

    expect(provider.inputs[0]).toEqual({ type: "text", text: "do the work" });
    expect(harness.activations).toMatchObject([
      {
        ref: metaRef,
        mode: "start",
        resources: { skills: [], mcpServers: [] },
      },
    ]);
    expect(harness.createOptions).not.toHaveProperty("callbacks");

    await harness.executor.stop();
  });

  it("keeps a superseded Runtime Session readable for Debug History", async () => {
    const clearSession = vi.fn(async () => ({ cleared: true }));
    const client = createTeamHubRuntimeStateClientFake({
      getContext: async () => ({
        context_key: JSON.stringify(["meta", "agent-1", "room", "room-1"]),
        ref: { kind: "meta", agent_id: "agent-1", room_id: "room-1" },
        tenant_id: "tenant-test",
        agent_actor_id: "actor-agent-1",
        target_residency: "suspended",
        state_revision: "1",
        next_input_sequence: "1",
      }),
      getWorkState: async () => ({
        has_pending_work: false,
        has_queued_runs: false,
      }),
      getSession: async () => ({
        available: true,
        session: {
          expected_revision: "0",
          provider_kind: "test",
          schema_version: "1",
          session: { threadId: "thread-old" },
          configuration_revision: "1",
          revision: "1",
          updated_at: "2026-09-04T00:00:00.000Z",
        },
      }),
      clearSession,
    });
    const stateFactory: ContextRuntimeStateFactory<TestRuntime> = (input) =>
      createTeamHubContextRuntimeState({
        client,
        ref: input.ref,
        configurationRevision: input.configurationRevision,
        providerKind: "test",
      });
    const inspectPersistedRuntimeHistory = vi.fn(
      async (request: RuntimeHistoryInspectionRequest<TestRuntime>) => {
        expect(request.session).toEqual({ threadId: "thread-old" });
        return availableHistory("thread-old");
      },
    );
    const harness = await createHarness(
      new RecordingProvider(),
      undefined,
      inspectPersistedRuntimeHistory,
      () => stateFactory,
    );
    // The Agent profile moved to revision 2 after the last checkpoint.
    await harness.create({
      ...harness.createOptions,
      configurationRevision: "2",
    });

    await expect(harness.executor.inspectRuntimeHistory({})).resolves.toEqual(
      availableHistory("thread-old"),
    );
    expect(inspectPersistedRuntimeHistory).toHaveBeenCalledOnce();
    expect(clearSession).not.toHaveBeenCalled();
    expect(harness.activations).toEqual([]);
    await harness.executor.stop();
  });

  it("preserves queued canonical Message IDs across a Shell restart", async () => {
    const first = await createSeededHarness(new RecordingProvider());
    await first.create(first.createOptions);
    first.state().queueInboxRun([
      {
        ...inboxMessage("notification-wrapper", "inbox-a"),
        invocationMessageIds: [
          "message-canonical-attachment",
          "message-canonical-follow-up",
        ],
      },
    ]);
    await first.executor.stop();

    const restoredProvider = new RecordingProvider();
    const restored = await createHarness(restoredProvider, first.root);
    await restored.create(restored.createOptions);
    await restored.executor.start();
    await eventually(() => expect(restoredProvider.startSpecs).toHaveLength(1));

    expect(restoredProvider.startSpecs[0]?.runContext?.messageIds).toEqual([
      "message-canonical-attachment",
      "message-canonical-follow-up",
    ]);
    expect(
      restoredProvider.startSpecs[0]?.runContext?.messageIds,
    ).not.toContain("notification-wrapper");
    await restored.executor.stop();
  });

  it("executes queued Inbox inputs once after activation", async () => {
    const provider = new RecordingProvider();
    const harness = await createSeededHarness(provider);
    await harness.create(harness.createOptions);
    // TeamHub queued one Run per Message in their transactions.
    for (const [messageId, inboxId] of [
      ["first", "inbox-a"],
      ["second", "inbox-a"],
      ["other", "inbox-b"],
    ] as const)
      harness.state().queueInboxRun([inboxMessage(messageId, inboxId)]);

    await harness.executor.start();
    await eventually(() => expect(provider.inputs).toHaveLength(3));
    expect(
      provider.startSpecs.map((spec) => spec.runContext?.messageIds),
    ).toEqual([["first"], ["second"], ["other"]]);
    await harness.executor.stop();
  });

  it("does not execute a canceled queued Run", async () => {
    const provider = new RecordingProvider();
    const harness = await createHarness(provider);
    await harness.create(harness.createOptions);
    const { runId } = await harness.executor.submitTrustedTurn([
      message("canceled", "do not run"),
    ]);
    await expect(harness.executor.cancelRun(runId)).resolves.toBe("canceled");
    await harness.executor.start();
    await expect(harness.executor.observeTurn(runId)).resolves.toMatchObject({
      status: "canceled",
      terminal: { type: "canceled" },
    });
    await harness.executor.stop();
    expect(provider.inputs).toEqual([]);
  });

  it("executes queued input once after an activation retry", async () => {
    const provider = new RecordingProvider();
    const harness = await createLifecycleHarness({
      providers: [provider],
      failActivationAt: new Set([0]),
      initialThreadId: "thread-activation-retry",
    });
    await harness.create(harness.createOptions);
    const { runId } = await harness.executor.submitTrustedTurn([
      message("retry", "run after activation retry"),
    ]);
    await expect(harness.executor.start()).rejects.toThrow(
      "replacement activation failed",
    );
    await harness.executor.start();
    await eventually(() => expect(provider.inputs).toHaveLength(1));
    await eventually(async () =>
      expect(await harness.executor.observeTurn(runId)).toMatchObject({
        status: "succeeded",
      }),
    );
    await harness.executor.stop();
    expect(provider.inputs).toHaveLength(1);
  });

  it("preserves queued cancellation while activation is in flight", async () => {
    const activationStarted = deferred<void>();
    const releaseActivation = deferred<void>();
    const provider = new RecordingProvider();
    const harness = await createLifecycleHarness({
      providers: [provider],
      initialThreadId: "thread-canceled-activation",
      beforeActivationReturn: async () => {
        activationStarted.resolve();
        await releaseActivation.promise;
      },
    });
    await harness.create(harness.createOptions);
    const { runId } = await harness.executor.submitTrustedTurn([
      message("cancel-in-flight", "cancel during activation"),
    ]);
    const starting = harness.executor.start();
    await activationStarted.promise;
    await expect(harness.executor.cancelRun(runId)).resolves.toBe("canceled");
    releaseActivation.resolve();
    await starting;
    await expect(harness.executor.observeTurn(runId)).resolves.toMatchObject({
      status: "canceled",
    });
    await harness.executor.stop();
    expect(provider.inputs).toEqual([]);
  });

  it("does not replay input accepted during activation after suspension", async () => {
    const activationStarted = deferred<void>();
    const releaseActivation = deferred<void>();
    const harness = await createLifecycleHarness({
      providers: [new RecordingProvider(), new RecordingProvider()],
      initialThreadId: "thread-success-window",
      beforeActivationReturn: async (index) => {
        if (index !== 0) return;
        activationStarted.resolve();
        await releaseActivation.promise;
      },
    });
    await harness.create(harness.createOptions);
    const starting = harness.executor.start();
    await activationStarted.promise;
    await harness.executor.submitTrustedTurn([
      message("during-success", "arrives before ready"),
    ]);
    releaseActivation.resolve();
    await starting;
    await eventually(() =>
      expect(harness.providers[0]?.inputs).toHaveLength(1),
    );
    await eventually(() => expect(harness.executor.isBusy()).toBe(false));
    await harness.executor.suspend();
    await harness.executor.start();
    await harness.executor.stop();
    expect(harness.providers[0]?.inputs).toHaveLength(1);
    expect(harness.providers[1]?.inputs).toEqual([]);
  });

  it("prestarts the Provider only for a ready Runtime", async () => {
    const provider = new RecordingProvider();
    const harness = await createHarness(provider);
    await harness.create(harness.createOptions);

    harness.executor.prestartProviderForPresence?.();
    expect(provider.presenceSessions).toEqual([]);

    await harness.executor.start();
    harness.executor.prestartProviderForPresence?.();
    expect(provider.presenceSessions).toHaveLength(1);
    await harness.executor.stop();
  });

  it("keeps a started Local Runtime ready with one recorded activation", async () => {
    const harness = await createHarness(new RecordingProvider());
    await harness.create(harness.createOptions);
    await harness.executor.start();

    expect(harness.activations).toMatchObject([{ mode: "start" }]);
    expect(harness.deactivations).toBe(0);
    expect(harness.executor.isRuntimeReady?.()).toBe(true);

    await harness.executor.start();

    expect(harness.activations).toHaveLength(1);
    expect(harness.executor.isRuntimeReady?.()).toBe(true);
    await harness.executor.stop();
  });

  it("persists credential-free Runtime Session checkpoints from an active Context", async () => {
    const first = await createHarness(new RecordingProvider());
    await first.create(first.createOptions);
    await first.executor.start();

    await first.activations[0]?.checkpointRuntimeSession?.({
      threadId: "thread-refreshed",
      mcpServerTransports: [
        {
          name: "linger_teamhub_collaboration",
          url: "http://127.0.0.1:8090/mcp/teamhub-collaboration",
        },
      ],
    });
    await first.executor.stop();

    const restored = await createHarness(new RecordingProvider(), first.root);
    await restored.create(restored.createOptions);
    await restored.executor.start();

    expect(restored.activations[0]).toMatchObject({
      mode: "resume",
      previousSession: {
        threadId: "thread-refreshed",
        mcpServerTransports: [
          {
            name: "linger_teamhub_collaboration",
            url: "http://127.0.0.1:8090/mcp/teamhub-collaboration",
          },
        ],
      },
    });
    await restored.executor.stop();
  });

  it("reports aggregate busyness and only suspends after the configured idle duration", async () => {
    const provider = new RecordingProvider();
    const harness = await createHarness(provider);
    await harness.create();
    await harness.executor.start();

    expect(harness.executor.isBusy()).toBe(false);
    const waiting = await harness.executor.trySuspendAfterIdle(60_000);
    expect(waiting).toMatchObject({ status: "not_idle" });
    expect(
      waiting.status === "not_idle" ? waiting.retryAfterMs : undefined,
    ).toBeGreaterThan(0);

    await harness.executor.submitTrustedTurn([message("message-1", "busy")]);
    expect(harness.executor.isBusy()).toBe(true);
    await eventually(() => expect(provider.inputs).toHaveLength(1));
    await eventually(() => expect(harness.executor.isBusy()).toBe(false));
    await expect(harness.executor.trySuspendAfterIdle(0)).resolves.toEqual({
      status: "suspended",
    });
    await harness.executor.stop();
  });

  it("retains the failed cleanup handle and retries it before creating another writer", async () => {
    const provider = new RecordingProvider();
    const close = vi
      .spyOn(provider, "close")
      .mockRejectedValueOnce(new Error("writer stop unconfirmed"));
    const harness = await createHarness(provider);
    await harness.create(harness.createOptions);
    await harness.executor.start();
    await expect(harness.executor.trySuspendAfterIdle(0)).rejects.toThrow(
      "writer stop unconfirmed",
    );
    await harness.executor.start();
    expect(harness.activations).toHaveLength(1);
    expect(harness.deactivations).toBe(1);
    await expect(harness.executor.trySuspendAfterIdle(0)).resolves.toEqual({
      status: "suspended",
    });
    expect(close).toHaveBeenCalledTimes(2);
    await harness.executor.start();
    expect(harness.activations).toHaveLength(2);
    await harness.executor.stop();
  });

  it("retries Manager idle cleanup through the real Shell after 1s and 5s", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const provider = new RecordingProvider();
    const cleanupFailure = new RunnerOperationError(
      "CONTEXT_VIEW_FAILED",
      "cleanup blocked",
      false,
    );
    const close = vi
      .spyOn(provider, "close")
      .mockRejectedValueOnce(cleanupFailure)
      .mockRejectedValueOnce(cleanupFailure);
    const harness = await createHarness(provider);
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    const contextStore = createInMemoryExecutionContextStore();
    const releaseIfIdle = vi.fn(async () => true);
    Object.assign(contextStore, { releaseIfIdle });
    await ghostStore.insert({
      agentId: "agent-1",
      actorId: "actor-agent-1",
      tenantId: "tenant-test",
      revision: "1",
      agent: harness.createOptions.agent,
      runtime: harness.createOptions.runtime,
      resources: harness.createOptions.resources,
    });
    const manager = new ExecutorRegistry<TestRuntime>({
      ghostStore,
      contextStore,
      identityResolver: {
        resolveIdentity: async () => ({
          actorId: "actor-agent-1",
          agentType: "general",
          sponsor: { actorId: "human-1", displayName: "Test Owner" },
        }),
      },
      executorServices: harness.services,
      features: testManagerFeatures(),
    });
    try {
      await manager.startContext(metaRef);
      await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect((await contextStore.get(metaRef))?.targetResidency).toBe("active");
      expect(releaseIfIdle).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(close).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledTimes(2);
      expect((await contextStore.get(metaRef))?.targetResidency).toBe("active");
      expect(releaseIfIdle).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4_999);
      expect(close).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledTimes(3);
      expect(await manager.getContextStatus(metaRef)).toBe("suspended");
      expect((await contextStore.get(metaRef))?.targetResidency).toBe(
        "suspended",
      );
      expect(releaseIfIdle).toHaveBeenCalledOnce();
      expect(harness.activations).toHaveLength(1);
    } finally {
      close.mockReset().mockResolvedValue(undefined);
      await manager.close();
      vi.useRealTimers();
    }
  });

  it("durably accepts messages while suspended and processes them after resume", async () => {
    const provider = new RecordingProvider();
    const harness = await createHarness(provider);
    await harness.create(harness.createOptions);
    await harness.executor.start();
    await harness.executor.trySuspendAfterIdle(0);

    await harness.executor.submitTrustedTurn([
      message("message-suspended", "wake later"),
    ]);
    expect(provider.inputs).toHaveLength(0);
    await harness.executor.start();
    await eventually(() => expect(provider.inputs).toHaveLength(1));
    expect(provider.inputs[0]?.text).toBe("wake later");
    await harness.executor.stop();
  });

  it.each(["prepared", "prepared after slow materialization", "used"] as const)(
    "executes an Inbox input queued while a %s Context is deactivating",
    async (preparation) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const provider = new RecordingProvider();
      const deactivating = deferred<void>();
      const releaseDeactivation = deferred<void>();
      vi.spyOn(provider, "close").mockImplementationOnce(async () => {
        deactivating.resolve(undefined);
        await releaseDeactivation.promise;
      });
      const harness = await createSeededHarness(provider);
      const ghostStore = createInMemoryGhostStore<TestRuntime>();
      const contextStore = createInMemoryExecutionContextStore();
      const ref = {
        kind: "meta",
        agentId: "agent-1",
        roomId: "room-race",
      } as const;
      await ghostStore.insert({
        agentId: "agent-1",
        actorId: "actor-agent-1",
        tenantId: "tenant-test",
        revision: "1",
        agent: harness.createOptions.agent,
        runtime: harness.createOptions.runtime,
        resources: harness.createOptions.resources,
      });
      await contextStore.ensure(ref, "suspended");
      const targets: RunWakeTarget[] = [];
      const terminals: string[] = [];
      const manager = new ExecutorRegistry<TestRuntime>({
        ghostStore,
        contextStore,
        identityResolver: {
          resolveIdentity: async () => ({
            actorId: "actor-agent-1",
            agentType: "general",
            sponsor: { actorId: "human-1", displayName: "Test Owner" },
          }),
        },
        executorServices: {
          ...harness.services,
          stateFactory: async (input) => {
            // Model filesystem latency without advancing the idle clock.
            if (preparation === "prepared after slow materialization") {
              await delay(50);
            }
            return harness.services.stateFactory(input);
          },
        },
        shouldPrepareContext: () => true,
        features: testManagerFeatures(
          {
            registerTarget(target) {
              targets.push(target);
              return { stop() {} };
            },
          },
          ({ terminal }) => terminals.push(terminal.type),
        ),
      });
      try {
        if (preparation !== "used") {
          manager.scheduleContextPreparation(ref);
          await eventually(async () =>
            expect(await manager.getContextStatus(ref)).toBe("active"),
          );
        } else {
          await manager.startContext(ref);
        }
        // Unused preparation expires after 30s; a used Context after 20 min.
        await vi.advanceTimersByTimeAsync(
          preparation === "used" ? 20 * 60_000 : 30_000,
        );
        await deactivating.promise;
        // TeamHub queued the Run with the Message and hinted it.
        harness.state().queueInboxRun([
          {
            messageId: "suspend-race-input",
            rawMessage: "run after idle teardown",
            segments: [{ type: "text", content: "run after idle teardown" }],
          },
        ]);
        targets[0]!.wake("queued");
        expect(provider.inputs).toHaveLength(0);
        releaseDeactivation.resolve(undefined);
        await eventually(() => expect(terminals).toEqual(["succeeded"]));
        expect(provider.inputs).toHaveLength(1);
        expect(provider.inputs[0]?.text).toContain("run after idle teardown");
        expect(await manager.getContextStatus(ref)).toBe("active");
        await expect(contextStore.get(ref)).resolves.toMatchObject({
          targetResidency: "active",
        });
        await eventually(() =>
          expect(harness.state().hasPendingWork()).toBe(false),
        );
        // Let the Run loop settle so the Context reports idle again.
        await delay(10);
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        await eventually(() => expect(harness.deactivations).toBe(2));
        expect(await manager.getContextStatus(ref)).toBe("suspended");
        await expect(contextStore.get(ref)).resolves.toMatchObject({
          targetResidency: "suspended",
        });
      } finally {
        releaseDeactivation.resolve(undefined);
        await manager.close();
        vi.useRealTimers();
      }
    },
  );

  it("hands a queued Message steer to the running Run that reads its Inbox, and runs the others next", async () => {
    const provider = new SteerRecordingProvider();
    const harness = await createSeededHarness(provider);
    await harness.create(harness.createOptions);
    await harness.executor.submitTrustedTurn([
      { ...message("initial", "start"), sourceInboxIds: ["inbox-a"] },
    ]);
    await harness.executor.start();
    await eventually(() => expect(provider.inputs).toHaveLength(1));

    harness.state().queueMessageSteer(inboxMessage("steer-a", "inbox-a"), {
      inboxId: "inbox-a",
    });
    harness.executor.notifyQueuedInput("steered");
    await eventually(() => expect(provider.steers).toHaveLength(1));
    expect(provider.steers[0]?.text).toBe("same Inbox mention");

    // A steer whose Inbox the running Run does not read becomes the next Run.
    harness.state().queueMessageSteer(inboxMessage("steer-b", "inbox-b"), {
      inboxId: "inbox-b",
    });
    harness.executor.notifyQueuedInput("steered");
    await eventually(() => expect(harness.state().hasQueuedRuns()).toBe(true));
    expect(provider.steers).toHaveLength(1);

    provider.run.cancel();
    await eventually(() => expect(provider.inputs).toHaveLength(2));
    expect(provider.inputs[1]?.text).toBe("different Inbox mention");
    await harness.executor.stop();
  });

  it("answers the running Run's native question from a queued response steer and settles it", async () => {
    const provider = new SteerRecordingProvider();
    const respond = vi.fn(async () => undefined);
    Object.assign(provider.run, { respond });
    const harness = await createSeededHarness(provider);
    await harness.create(harness.createOptions);
    const { runId } = await harness.executor.submitTrustedTurn([
      message("asking", "ask the Human"),
    ]);
    await harness.executor.start();
    await eventually(() => expect(provider.inputs).toHaveLength(1));

    const response = {
      operation_id: "operation-1",
      execution_run_ref: runId,
      request_id: "request-1",
      interaction_id: "interaction-1",
      payload: { answer: "yes" },
    };
    const steer = harness.state().queueMessageSteer(
      {
        messageId: "runtime-response-1",
        rawMessage: "",
        segments: [{ type: "text", content: "" }],
        runtimeResponses: [response],
      },
      { runId },
    );
    harness.executor.notifyQueuedInput("steered");
    await eventually(() =>
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        "operation-1",
        "request-1",
        { answer: "yes" },
      ),
    );
    await eventually(() =>
      expect(harness.state().getSteerOutcome("runtime-response-1")).toBe(
        "applied",
      ),
    );
    // The answer is no Runtime input of its own.
    expect(provider.steers).toEqual([]);
    expect(steer.groupId).toBeTruthy();
    provider.run.cancel();
    await harness.executor.stop();
  });

  it("claims a hinted queued Run without waiting for another hint", async () => {
    const provider = new RecordingProvider();
    const harness = await createSeededHarness(provider);
    await harness.create(harness.createOptions);
    await harness.executor.start();
    harness.state().queueInboxRun([inboxMessage("hinted", "inbox-a")]);
    harness.executor.notifyQueuedInput("queued");
    await eventually(() => expect(provider.inputs).toHaveLength(1));
    expect(provider.startSpecs[0]?.runContext?.messageIds).toEqual(["hinted"]);
    await harness.executor.stop();
  });

  it("checks updated resources for a queued Run and resumes the existing model history", async () => {
    let changed = false;
    const first = new GracefulRecycleProvider();
    const replacement = new RecordingProvider();
    const prepare = vi.fn(async (index: number) => index > 0 || !changed);
    const harness = await createLifecycleHarness({
      providers: [first, replacement],
      initialThreadId: "thread-resource-history",
      prepareNextRun: prepare,
    });
    await harness.create(harness.createOptions);
    await harness.executor.submitTrustedTurn([
      message("resource-old", "first"),
    ]);
    await harness.executor.start();
    await first.started.promise;
    changed = true;
    const next = await harness.executor.submitTrustedTurn([
      message("resource-new", "second"),
    ]);
    expect(harness.activations).toHaveLength(1);
    expect(first.run.cancelCalls).toBe(0);
    first.run.succeed();
    await eventually(() => expect(harness.activations).toHaveLength(2));
    expect(harness.activations[1]).toMatchObject({
      mode: "resume",
      previousSession: { threadId: "thread-resource-history" },
    });
    await eventually(async () =>
      expect(await harness.executor.observeTurn(next.runId)).toMatchObject({
        status: "succeeded",
      }),
    );
    expect(first.inputs).toHaveLength(1);
    expect(replacement.inputs).toHaveLength(1);
    await harness.executor.stop();
  });

  it("reports a failed replacement Skill load on the queued Run and keeps history for retry", async () => {
    let changed = false;
    const provider = new RecordingProvider();
    const failedActivations = new Set([1, 2]);
    const harness = await createLifecycleHarness({
      providers: [provider],
      initialThreadId: "thread-bad-skill",
      prepareNextRun: async (index) => index > 0 || !changed,
      failActivationAt: failedActivations,
    });
    await harness.create(harness.createOptions);
    const initial = await harness.executor.submitTrustedTurn([
      message("old-good-skill", "first"),
    ]);
    await harness.executor.start();
    await eventually(async () =>
      expect(await harness.executor.observeTurn(initial.runId)).toMatchObject({
        status: "succeeded",
      }),
    );
    changed = true;
    const next = await harness.executor.submitTrustedTurn([
      message("bad-skill", "second"),
    ]);
    await eventually(async () =>
      expect(await harness.executor.observeTurn(next.runId)).toMatchObject({
        status: "failed",
        terminal: { type: "failed", error: "replacement activation failed" },
      }),
    );
    expect(provider.inputs).toHaveLength(1);
    failedActivations.clear();
    await harness.executor.start();
    expect(harness.activations.at(-1)).toMatchObject({
      mode: "resume",
      previousSession: { threadId: "thread-bad-skill" },
    });
    await harness.executor.stop();
  });

  it("blocks automatic and explicit activation after unconfirmed activation cleanup", async () => {
    const failure = new ContextRuntimeCleanupError([
      new Error("Pod termination unconfirmed"),
    ]);
    const harness = await createLifecycleHarness({
      providers: [new RecordingProvider(), new RecordingProvider()],
      initialThreadId: "thread-cleanup-failed",
      // The changed resources replace the Runtime before the queued Run.
      prepareNextRun: async (index) => index > 0,
      beforeActivationReturn: async (index) => {
        if (index === 1) throw failure;
      },
    });
    await harness.create(harness.createOptions);
    await harness.executor.start();
    await harness.executor.submitTrustedTurn([
      message("cleanup-failed", "after a resource change"),
    ]);
    await eventually(() => expect(harness.activations).toHaveLength(2));

    expect(harness.activations).toHaveLength(2);
    expect(harness.executor.isRuntimeReady()).toBe(false);
    await expect(harness.executor.start()).rejects.toBe(failure);
    expect(harness.activations).toHaveLength(2);
    expect(
      harness.providers.every((provider) => provider.inputs.length === 0),
    ).toBe(true);
    // The failed activation promise has already settled. Stop must retain the
    // cleanup failure rather than falsely report successful process shutdown.
    await expect(harness.executor.stop()).rejects.toBe(failure);
    await expect(harness.executor.stop()).rejects.toBe(failure);
  });

  it.each([false, true])(
    "reports canceled replacement cleanup through controller shutdown: cleanupFails=%s",
    async (cleanupFails) => {
      const pending = deferred<void>();
      const failure = new ContextRuntimeCleanupError([
        new Error("Pod retirement failed"),
      ]);
      const harness = await createLifecycleHarness({
        providers: [new RecordingProvider(), new RecordingProvider()],
        initialThreadId: "thread-controller-stop",
        prepareNextRun: async (index) => index > 0,
        beforeActivationReturn: async (index, request) => {
          if (index !== 1) return;
          pending.resolve();
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve();
            else
              request.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          if (cleanupFails) throw failure;
          throw new Error("activation aborted after confirmed cleanup");
        },
      });
      const ghostStore = createInMemoryGhostStore<TestRuntime>();
      const contextStore = createInMemoryExecutionContextStore();
      await ghostStore.insert({
        agentId: "agent-1",
        actorId: "actor-agent-1",
        tenantId: "tenant-test",
        revision: "1",
        agent: harness.createOptions.agent,
        runtime: harness.createOptions.runtime,
        resources: harness.createOptions.resources,
      });
      await contextStore.ensure(metaRef, "active");
      const manager = new ExecutorRegistry<TestRuntime>({
        ghostStore,
        contextStore,
        identityResolver: {
          resolveIdentity: async () => ({
            actorId: "actor-agent-1",
            agentType: "general",
            sponsor: { actorId: "human-1", displayName: "Test Owner" },
          }),
        },
        executorServices: harness.services,
        features: testManagerFeatures(),
      });
      await manager.restore();
      // The submission waits for the replacement activation shutdown aborts.
      void manager
        .submitTrustedTurn({
          target: metaRef,
          messages: [message("controller-stop", "after a resource change")],
        })
        .catch(() => undefined);
      await pending.promise;
      const stages: string[] = [];
      const close = vi.fn(async () => undefined);
      let shutdownError: unknown;
      try {
        await closeAgentManagerResources(
          {
            server: { drain: close, close },
            taskWorker: { close },
            agentManager: manager,
            runtimeHosts: { close },
            runtimeStatusPublisher: { close },
            contextViewSessions: { close: () => undefined },
            wakeStream: { close },
          },
          (phase, state) => stages.push(`${phase}:${state}`),
        );
      } catch (error) {
        shutdownError = error;
      }

      if (cleanupFails) {
        expect(shutdownError).toBeInstanceOf(AggregateError);
        expect((shutdownError as AggregateError).errors).toContain(failure);
        expect(stages).toContain("manager:failed");
        expect(stages).not.toContain("manager:completed");
      } else {
        expect(shutdownError).toBeUndefined();
        expect(stages).toContain("manager:completed");
      }
      expect(stages).toContain("wake-stream:completed");
      expect(harness.activations).toHaveLength(2);
      expect(
        harness.providers.every((provider) => provider.inputs.length === 0),
      ).toBe(true);
    },
  );
});

const metaRef: ExecutionContextRef = {
  kind: "meta",
  agentId: "agent-1",
  roomId: "room-1",
};

const createHarness = async (
  provider: RecordingProvider,
  existingRoot?: string,
  inspectPersistedRuntimeHistory?: (
    request: RuntimeHistoryInspectionRequest<TestRuntime>,
  ) => Promise<RuntimeHistoryPage>,
  stateFactory: (
    root: string,
  ) => ContextRuntimeStateFactory<TestRuntime> = testRuntimeState,
) => {
  const root =
    existingRoot ??
    (await mkdtemp(path.join(os.tmpdir(), "context-shell-test-")));
  if (!existingRoot) temporaryDirectories.push(root);
  const activations: ContextRuntimeActivationRequest<TestRuntime>[] = [];
  let deactivations = 0;
  let nextThread = 1;
  const activator: ContextRuntimeActivator<TestRuntime> = {
    async activate(request) {
      activations.push(request);
      const runtimeSession = {
        threadId: `thread-${nextThread++}`,
      } satisfies RuntimeSession;
      return {
        ref: request.ref,
        provider,
        runtimeName: "test",
        runtimeSession,
        sessionSpec: {
          workingDirectory: "/workspace",
          threadName: request.agent.name,
          sandboxMode: "workspace-write",
          resources: { mcpServers: [] },
        },
        setActiveRunContext() {},
        async deactivate() {
          deactivations += 1;
          await provider.close();
        },
      } satisfies ActivatedContextRuntime;
    },
  };
  const handle = createExecutorHandle<TestRuntime>({
    activator,
    stateFactory: stateFactory(root),
    ...(inspectPersistedRuntimeHistory
      ? { inspectPersistedHistory: inspectPersistedRuntimeHistory }
      : {}),
  });
  const createOptions: StandaloneExecutorOptions<TestRuntime> = {
    ref: metaRef,
    actorId: "actor-agent-1",
    tenantId: "tenant-test",
    agent: { name: "Agent One", instructions: "test" },
    runtime: localRuntime,
    resources: { skills: [], mcpServers: [] },
    features: testFeaturePorts(metaRef),
  };
  return {
    root,
    services: handle.services,
    create: (options = createOptions) => handle.create(options),
    onTerminal: handle.onTerminal,
    get executor() {
      return handle.executor;
    },
    createOptions,
    activations,
    get deactivations() {
      return deactivations;
    },
  };
};

const availableHistory = (threadId: string): RuntimeHistoryPage => ({
  status: "available",
  providerKind: "codex",
  source: "codex_rollout",
  snapshot: {
    id: `snapshot-${threadId}`,
    threadId,
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

const createLifecycleHarness = async (options: {
  readonly providers: readonly RecordingProvider[];
  readonly failActivationAt?: ReadonlySet<number>;
  readonly beforeActivationReturn?: (
    index: number,
    request: ContextRuntimeActivationRequest<TestRuntime>,
  ) => Promise<void>;
  readonly initialThreadId: string;
  readonly prepareNextRun?: (
    index: number,
    signal: AbortSignal,
  ) => Promise<boolean>;
}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-shell-test-"));
  temporaryDirectories.push(root);
  const activations: ContextRuntimeActivationRequest<TestRuntime>[] = [];
  let deactivations = 0;
  const activator: ContextRuntimeActivator<TestRuntime> = {
    async activate(request) {
      const activationIndex = activations.length;
      activations.push(request);
      if (options.failActivationAt?.has(activationIndex)) {
        throw new Error("replacement activation failed");
      }
      await options.beforeActivationReturn?.(activationIndex, request);
      const provider =
        options.providers[activationIndex] ?? options.providers.at(-1);
      if (!provider) {
        throw new Error("Lifecycle test activation is not configured");
      }
      const runtimeSession =
        request.mode === "resume"
          ? request.previousSession!
          : ({ threadId: options.initialThreadId } satisfies RuntimeSession);
      let deactivated = false;
      return {
        ref: request.ref,
        provider,
        runtimeName: "test",
        runtimeSession,
        ...(options.prepareNextRun
          ? {
              prepareNextRun: (signal: AbortSignal) =>
                options.prepareNextRun!(activationIndex, signal),
            }
          : {}),
        sessionSpec: {
          workingDirectory: "/workspace",
          threadName: request.agent.name,
          sandboxMode: "workspace-write",
          resources: { mcpServers: [] },
        },
        setActiveRunContext() {},
        async deactivate() {
          if (deactivated) return;
          deactivated = true;
          deactivations += 1;
          await provider.close();
        },
      } satisfies ActivatedContextRuntime;
    },
  };
  const handle = createExecutorHandle<TestRuntime>({
    activator,
    stateFactory: testRuntimeState(root),
  });
  const createOptions: StandaloneExecutorOptions<TestRuntime> = {
    ref: metaRef,
    actorId: "actor-agent-1",
    tenantId: "tenant-test",
    agent: { name: "Agent One", instructions: "test" },
    runtime: localRuntime,
    resources: { skills: [], mcpServers: [] },
    features: testFeaturePorts(metaRef),
  };
  return {
    services: handle.services,
    create: (options = createOptions) => handle.create(options),
    onTerminal: handle.onTerminal,
    get executor() {
      return handle.executor;
    },
    createOptions,
    activations,
    providers: options.providers,
    get deactivations() {
      return deactivations;
    },
  };
};

class RecordingProvider implements AgentProvider {
  readonly inputs: AgentInput[] = [];
  readonly startSpecs: ExecutionSpec[] = [];
  readonly presenceSessions: RuntimeSession[] = [];

  prepareForPresence(session: RuntimeSession): void {
    this.presenceSessions.push(session);
  }

  async createSession(_options: ProviderSessionOptions) {
    return { threadId: "unused" };
  }

  async resumeSession(
    _session: RuntimeSession,
    _options: ProviderSessionOptions,
  ) {
    return { threadId: "unused" };
  }

  async startRun(
    _session: RuntimeSession,
    input: AgentInput,
    spec: ExecutionSpec,
  ): Promise<AgentRun> {
    this.inputs.push(input);
    this.startSpecs.push(spec);
    return {
      events: emptyEvents(),
      async wait() {
        return { finalResponse: "internal result only" };
      },
      cancel() {},
    };
  }

  async steer(_run: AgentRun, _options: ProviderSteerOptions) {
    return { turnId: "turn-1" };
  }

  async close() {}
}

class SteerRecordingProvider extends RecordingProvider {
  readonly run = new PendingRun();
  readonly steers: AgentInput[] = [];

  override async startRun(
    _session: RuntimeSession,
    input: AgentInput,
    _spec: ExecutionSpec,
  ): Promise<AgentRun> {
    this.inputs.push(input);
    return this.run;
  }

  override async steer(_run: AgentRun, options: ProviderSteerOptions) {
    this.steers.push(options.input);
    return { turnId: "turn-steered" };
  }
}

class PendingRun implements AgentRun {
  readonly events = emptyEvents();
  readonly #result = deferred<RunResult>();
  cancelCalls = 0;

  wait(): Promise<RunResult> {
    return this.#result.promise;
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.#result.resolve({ finalResponse: "canceled" });
  }
}

class GracefulRecycleProvider extends RecordingProvider {
  readonly run = new SuccessfulPendingRun();
  readonly started = deferred<void>();
  readonly starts: ExecutionSpec[] = [];
  closedAfterRun = false;

  override async startRun(
    _session: RuntimeSession,
    input: AgentInput,
    spec: ExecutionSpec,
  ): Promise<AgentRun> {
    this.inputs.push(input);
    this.starts.push(spec);
    this.started.resolve(undefined);
    return this.run;
  }

  override async close(): Promise<void> {
    this.closedAfterRun = this.run.settled;
  }
}

class SuccessfulPendingRun implements AgentRun {
  readonly events = emptyEvents();
  readonly #result = deferred<RunResult>();
  cancelCalls = 0;
  settled = false;

  wait(): Promise<RunResult> {
    return this.#result.promise;
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.settled = true;
    this.#result.resolve({ finalResponse: "canceled" });
  }

  succeed(): void {
    this.settled = true;
    this.#result.resolve({ finalResponse: "completed normally" });
  }
}

const message = (messageId: string, rawMessage: string): Message => ({
  messageId,
  rawMessage,
  segments: [
    { type: "text", content: rawMessage },
    {
      type: "reference",
      content: "@Agent One",
      target: "actor-agent-1",
      target_type: "agent",
    },
  ],
});

const inboxMessage = (messageId: string, inboxId: string): Message => ({
  ...message(
    messageId,
    inboxId === "inbox-a" ? "same Inbox mention" : "different Inbox mention",
  ),
  sourceInboxIds: [inboxId],
});

const emptyEvents = (): AsyncIterable<never> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => ({ done: true, value: undefined }),
  }),
});

const eventually = async (
  assertion: () => void | Promise<void>,
): Promise<void> => {
  // Poll on real timers so I/O can settle without advancing the fake idle clock.
  await expect
    .poll(async () => {
      await assertion();
      return true;
    })
    .toBe(true);
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

interface PreflightHarnessOptions {
  readonly preflight?: (signal: AbortSignal) => Promise<void>;
}

const createPreflightHarness = async (
  provider: RecordingProvider,
  options: PreflightHarnessOptions = {},
) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "context-shell-preflight-"),
  );
  temporaryDirectories.push(root);
  const activations: ContextRuntimeActivationRequest<TestRuntime>[] = [];
  const preflights: AbortSignal[] = [];
  const activator: ContextRuntimeActivator<TestRuntime> = {
    async preflight(request) {
      preflights.push(request.signal);
      await options.preflight?.(request.signal);
    },
    async activate(request) {
      activations.push(request);
      const activated: ActivatedContextRuntime = {
        ref: request.ref,
        provider,
        runtimeName: "test",
        runtimeSession: { threadId: `thread-${activations.length}` },
        sessionSpec: {
          workingDirectory: "/workspace",
          threadName: request.agent.name,
          sandboxMode: "workspace-write",
          resources: { mcpServers: [] },
        },
        setActiveRunContext() {},
        async deactivate() {
          await provider.close();
        },
      };
      return activated;
    },
  };
  let state: ContextRuntimeState | undefined;
  const handle = createExecutorHandle<TestRuntime>({
    activator,
    stateFactory: async (input) =>
      (state = new ContextRuntimeState({
        databasePath: path.join(root, "runtime.sqlite"),
        ref: input.ref,
      })),
  });
  const createOptions: StandaloneExecutorOptions<TestRuntime> = {
    ref: metaRef,
    actorId: "actor-agent-1",
    tenantId: "tenant-test",
    agent: { name: "Agent One", instructions: "test" },
    runtime: localRuntime,
    resources: { skills: [], mcpServers: [] },
    features: testFeaturePorts(metaRef),
  };
  return {
    create: (options = createOptions) => handle.create(options),
    get executor() {
      return handle.executor;
    },
    createOptions,
    activations,
    preflights,
    state: () => state!,
  };
};

describe("ContextExecutor preflight before activation", () => {
  it("waits for preflight before activating", async () => {
    const preflight = deferred<void>();
    const harness = await createPreflightHarness(new RecordingProvider(), {
      preflight: () => preflight.promise,
    });
    await harness.create(harness.createOptions);
    const starting = harness.executor.start();
    await delay(0);
    expect(harness.preflights).toHaveLength(1);
    expect(harness.activations).toHaveLength(0);

    preflight.resolve();
    await starting;
    expect(harness.activations).toHaveLength(1);
    await harness.executor.stop();
  });

  it("joins a second activation request to the in-flight preflight", async () => {
    const preflight = deferred<void>();
    const harness = await createPreflightHarness(new RecordingProvider(), {
      preflight: () => preflight.promise,
    });
    await harness.create(harness.createOptions);
    const starting = harness.executor.start();
    await delay(0);
    const joined = harness.executor.start();
    await delay(0);
    expect(harness.preflights).toHaveLength(1);

    preflight.resolve();
    await Promise.all([starting, joined]);
    expect(harness.activations).toHaveLength(1);
    await harness.executor.stop();
  });

  it("keeps no activation when preflight is offline and activates after reconnect", async () => {
    let offline = true;
    const harness = await createPreflightHarness(new RecordingProvider(), {
      preflight: async () => {
        if (offline) throw new LocalComputerOfflineError();
      },
    });
    await harness.create(harness.createOptions);
    await expect(harness.executor.start()).rejects.toBeInstanceOf(
      LocalComputerOfflineError,
    );
    expect(harness.activations).toHaveLength(0);

    offline = false;
    await harness.executor.start();
    expect(harness.activations).toHaveLength(1);
    await harness.executor.stop();
  });

  it("fails queued Runs with model_not_offered when the Computer lacks the model", async () => {
    let offered = false;
    const provider = new RecordingProvider();
    const harness = await createPreflightHarness(provider, {
      preflight: async () => {
        if (!offered) throw new LocalComputerModelError("codex");
      },
    });
    await harness.create(harness.createOptions);
    const { runId } = await harness.executor.submitTrustedTurn([
      message("unoffered", "hello"),
    ]);

    await expect(harness.executor.start()).rejects.toBeInstanceOf(
      LocalComputerModelError,
    );
    expect(harness.activations).toHaveLength(0);
    expect(harness.state().getLocalRun(runId)).toMatchObject({
      status: "failed",
      terminal: {
        type: "failed",
        failure: { code: "model_not_offered", runtime_type: "codex" },
      },
    });

    // After the configuration changes, the next input activates and runs.
    offered = true;
    await harness.executor.submitTrustedTurn([message("offered", "again")]);
    await harness.executor.start();
    await eventually(() => expect(provider.inputs).toHaveLength(1));
    await harness.executor.stop();
  });
});

describe("ContextExecutor activation abort", () => {
  const createBlockedShell = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-shell-abort-"));
    temporaryDirectories.push(root);
    const entered = deferred<void>();
    const preflights: number[] = [];
    const activations: ContextRuntimeActivationRequest<TestRuntime>[] = [];
    const activator: ContextRuntimeActivator<TestRuntime> = {
      async preflight({ signal }) {
        preflights.push(1);
        entered.resolve();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      async activate(request) {
        activations.push(request);
        throw new Error("blocked activation must not reach activate");
      },
    };
    const shell = await createStandaloneExecutor<TestRuntime>({
      activator,
      stateFactory: testRuntimeState(root),
      options: {
        ref: metaRef,
        actorId: "actor-agent-1",
        tenantId: "tenant-test",
        agent: { name: "Agent One", instructions: "test" },
        runtime: localRuntime,
        resources: { skills: [], mcpServers: [] },
        features: testFeaturePorts(metaRef),
      },
    });
    return { shell, entered, activations, preflights };
  };

  it("cancels an in-flight activation without stopping the Shell", async () => {
    vi.stubEnv("AGENT_LOG_LEVEL", "debug");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const infos = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { shell, entered, activations } = await createBlockedShell();
      const starting = shell.start();
      await entered.promise;

      shell.abortActivation(
        new Error("Execution Context is being permanently stopped"),
      );

      await expect(starting).rejects.toMatchObject({
        name: "ActivationCancelledError",
      });
      expect(activations).toEqual([]);
      const failedLog = (calls: unknown[][]) =>
        calls.some((args) =>
          String(args[0]).includes("runtime.activation.failed"),
        );
      expect(failedLog(infos.mock.calls)).toBe(true);
      expect(failedLog(errors.mock.calls)).toBe(false);
      await expect(shell.stop()).resolves.toBeUndefined();
    } finally {
      errors.mockRestore();
      infos.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("rejects a later start as cancelled without preflight once aborted", async () => {
    const { shell, activations, preflights } = await createBlockedShell();

    shell.abortActivation(
      new Error("Execution Context is being permanently stopped"),
    );

    await expect(shell.start()).rejects.toMatchObject({
      name: "ActivationCancelledError",
    });
    expect(preflights).toEqual([]);
    expect(activations).toEqual([]);
    await shell.stop();
  });
});
