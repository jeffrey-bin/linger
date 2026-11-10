import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinAgentFeatures } from "../../../src/agent/agent-features/builtin.js";
import { ExecutorRegistry } from "../../../src/agent/executor/registry.js";
import { createInMemoryGhostStore } from "../test-support/in-memory-ghost-store.js";
import {
  isRecoverableContextRestoreFailure,
  shouldSuspendContextRestoreFailure,
  resolveContextRestoreRetryDelayMs,
  resolveContextRestoreMaxRetryAttempts,
} from "../../../src/agent/executor/application.js";
import { TeamHubExecutionContextStore } from "../../../src/agent/executor/context-store.js";
import { createTeamHubContextRuntimeState } from "../../../src/agent/executor/context-runtime-state.js";
import {
  createTeamHubMcpContextResolverClient,
  TeamHubMcpContextResolverError,
} from "../../../src/agent/executor/teamhub-context-resolvers.js";
import {
  ContextRuntimeCleanupError,
  type ContextRuntimeActivator,
} from "../../../src/agent/executor/activation.js";
import { LocalComputerOfflineError } from "../../../src/agent/runner-gateway/local-computer-management.js";
import type { AgentLogger } from "../../../src/agent/observability/agent-log.js";
import type { LocalRuntimeSettings } from "../../../src/agent/runtime-settings.js";
import type { AgentProvider } from "../../../src/agent/executor/provider.js";
import { createInMemoryTeamHubRuntimeState } from "../test-support/teamhub-runtime-state-client.js";

const ref = {
  kind: "meta",
  agentId: "retry-agent",
  roomId: "retry-room",
} as const;
const wireRef = {
  kind: "meta",
  agent_id: ref.agentId,
  room_id: ref.roomId,
} as const;
const runtime = {
  type: "local",
  model: "test-model",
  placement: {
    type: "local",
    tenantId: "retry-tenant",
    ownerActorId: "retry-owner",
    computerId: "retry-computer",
    runtimeType: "codex",
    workspaceGrantId: "retry-grant",
    assignmentRevision: 1,
  },
} as const;
const wireRuntime = {
  type: "local",
  model: "test-model",
  placement: {
    tenant_id: "retry-tenant",
    owner_actor_id: "retry-owner",
    computer_id: "retry-computer",
    runtime_type: "codex",
    workspace_grant_id: "retry-grant",
    assignment_revision: "1",
  },
} as const;
const cleanups: Array<() => Promise<void>> = [];

const testFeatureLogger = (): AgentLogger => {
  const logger: AgentLogger = {
    log: () => undefined,
    child: () => logger,
  };
  return logger;
};

async function createFixture(failure: Error, failures: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubEnv("AGENT_LOG_LEVEL", "off");
  const memory = createInMemoryTeamHubRuntimeState();
  memory.putConfig({
    agent_id: ref.agentId,
    tenant_id: "retry-tenant",
    actor_id: "retry-actor",
    configuration_revision: "1",
    runtime_configuration_revision: "1",
    content_hash: "activation-retry-test",
    permission_review: false,
    agent: { name: "Retry", instructions: "Use explicit tools." },
    runtime: wireRuntime,
    resources: { skills: [], mcp_servers: [] },
  });
  await memory.client.ensureContext({
    ref: wireRef,
    target_residency: "active",
  });
  memory.putWorkState(wireRef, {
    has_pending_work: true,
    has_queued_runs: true,
  });
  const claim = vi.fn(async () => {
    memory.putWorkState(wireRef, {
      has_pending_work: false,
      has_queued_runs: false,
    });
    return { claimed: false as const };
  });
  // The existing runtime-state fixture does not implement queue selection.
  memory.client.claimRun = claim;
  const store = new TeamHubExecutionContextStore({ client: memory.client });
  // The application binds each Context the epoch start reports as waiting.
  const startup = await store.start();
  for (const contextKey of startup.waitingContextKeys)
    await store.claimByKey(contextKey);
  const ghostStore = createInMemoryGhostStore<LocalRuntimeSettings>();
  await ghostStore.insert({
    agentId: ref.agentId,
    actorId: "retry-actor",
    tenantId: "retry-tenant",
    revision: "1",
    agent: { name: "Retry", instructions: "Use explicit tools." },
    runtime,
    resources: { skills: [], mcpServers: [] },
  });
  const provider: AgentProvider = {
    async createSession() {
      throw new Error("unexpected session creation");
    },
    async resumeSession() {
      throw new Error("unexpected session resume");
    },
    async startRun() {
      throw new Error("unexpected user execution");
    },
    async steer() {
      throw new Error("unexpected steer");
    },
    async close() {},
  };
  const startRun = vi.spyOn(provider, "startRun");
  let remainingFailures = failures;
  // Activated Runtimes not yet deactivated: the Context's Runtime is ready.
  let liveRuntimes = 0;
  const activator: ContextRuntimeActivator<LocalRuntimeSettings> = {
    async activate(request) {
      if (remainingFailures > 0) {
        remainingFailures--;
        throw failure;
      }
      // Bound the unfixed feedback loop without adding an external wake.
      liveRuntimes += 1;
      return {
        ref: request.ref,
        provider,
        runtimeName: "test",
        runtimeSession: { threadId: "test-thread" },
        sessionSpec: {
          workingDirectory: "/workspace",
          threadName: "Test",
          sandboxMode: "workspace-write",
          resources: { mcpServers: [] },
        },
        setActiveRunContext() {},
        async deactivate() {
          liveRuntimes -= 1;
          await provider.close();
        },
      };
    },
  };
  const activate = vi.spyOn(activator, "activate");
  const manager = new ExecutorRegistry<LocalRuntimeSettings>({
    ghostStore,
    contextStore: store,
    identityResolver: {
      async resolveIdentity() {
        return {
          actorId: "retry-actor",
          agentType: "general",
          sponsor: { actorId: "retry-human", displayName: "Retry" },
        };
      },
    },
    executorServices: {
      activator,
      stateFactory: (input) =>
        createTeamHubContextRuntimeState({
          client: memory.client,
          ref: input.ref,
          configurationRevision: input.configurationRevision,
          providerKind: "codex",
        }),
    },
    features: createBuiltinAgentFeatures({
      services: { logger: testFeatureLogger() },
    }),
    restoreRecovery: {
      isRecoverable: isRecoverableContextRestoreFailure,
      shouldSuspend: shouldSuspendContextRestoreFailure,
      retryDelayMs: resolveContextRestoreRetryDelayMs,
      maxRetryAttempts: resolveContextRestoreMaxRetryAttempts,
    },
  });
  cleanups.push(async () => {
    try {
      if (failure instanceof ContextRuntimeCleanupError) {
        await expect(manager.close()).rejects.toThrow();
      } else {
        await manager.close();
      }
    } finally {
      await store.close();
    }
  });
  return {
    manager,
    store,
    runtimeReady: () => liveRuntimes > 0,
    activate,
    claim,
    startRun,
    failNextActivation() {
      remainingFailures = 1;
    },
  };
}

afterEach(async () => {
  try {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

describe("Context activation with the TeamHub Store and executor", () => {
  it.each(["context_identity_invalid"])(
    "retries HTTP 409 %s without suspending current Context authority",
    async (code) => {
      const resolver = createTeamHubMcpContextResolverClient({
        baseUrl: "https://teamhub.example.test",
        serviceToken: "test-service-token",
        fetch: async () =>
          Response.json(
            {
              error: {
                code,
                message: "Current Context identity must be refreshed",
                request_id: "context-conflict-test",
              },
            },
            { status: 409 },
          ),
      });
      const failure = await resolver
        .resolve({
          ref,
          signal: new AbortController().signal,
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TeamHubMcpContextResolverError);
      expect(shouldSuspendContextRestoreFailure({ error: failure })).toBe(
        false,
      );
      expect(isRecoverableContextRestoreFailure({ error: failure })).toBe(true);
      const f = await createFixture(failure as Error, 1);
      await f.manager.restore();
      await nextTurn();
      expect(f.activate).toHaveBeenCalledOnce();
      expect(await f.store.get(ref)).toMatchObject({
        targetResidency: "active",
      });
      const delay = resolveContextRestoreRetryDelayMs({
        error: failure,
        ref,
      });
      await vi.advanceTimersByTimeAsync(delay);
      await nextTurn();
      expect(f.activate).toHaveBeenCalledTimes(2);
      expect(f.runtimeReady()).toBe(true);
      expect(f.startRun).not.toHaveBeenCalled();
    },
  );

  it("keeps HTTP 403 Context identity denial permanent", () => {
    const failure = new TeamHubMcpContextResolverError(
      "context_identity_invalid",
      {
        code: "context_identity_invalid",
        status: 403,
      },
    );
    expect(shouldSuspendContextRestoreFailure({ error: failure })).toBe(true);
    expect(isRecoverableContextRestoreFailure({ error: failure })).toBe(false);
  });

  it("does not turn generation revisions into immediate retries after one explicit start", async () => {
    const failure = new Error(
      "Local execution authority is unavailable or revoked",
    );
    const f = await createFixture(failure, 6);
    const startedAt = Date.now();
    await expect(f.manager.restore()).rejects.toThrow(AggregateError);
    await nextTurn();
    expect(f.activate).toHaveBeenCalledTimes(1);

    await expect(f.manager.startContext(ref)).rejects.toBe(failure);
    // All service adapters are synchronous promises. One real event-loop turn
    // drains their revision notifications without advancing any retry timer.
    await nextTurn();

    expect(Date.now()).toBe(startedAt);
    expect(f.activate).toHaveBeenCalledTimes(2);
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.startRun).not.toHaveBeenCalled();
    expect(f.runtimeReady()).toBe(false);
  });

  it("allows an explicit classified wake while repeated Store observations remain deferred", async () => {
    const failure = new LocalComputerOfflineError();
    const f = await createFixture(failure, 1);
    await f.manager.restore();
    await f.store.get(ref);
    await nextTurn();
    expect(f.activate).toHaveBeenCalledTimes(1);

    expect(f.manager.wakeDeferredContextRestores(() => true)).toBe(1);
    await nextTurn();

    expect(f.activate).toHaveBeenCalledTimes(2);
    expect(f.runtimeReady()).toBe(true);
    expect(f.startRun).not.toHaveBeenCalled();
  });

  it.each(["start", "resume"] as const)(
    "retains classified recovery after an explicit %s with no existing retry",
    async (operation) => {
      const failure = new LocalComputerOfflineError();
      const f = await createFixture(failure, 0);
      await f.manager.restore();
      await nextTurn();
      expect(f.runtimeReady()).toBe(true);
      await f.manager.suspendContext(ref);
      await nextTurn();
      expect(f.runtimeReady()).toBe(false);
      expect(f.manager.wakeDeferredContextRestores(() => true)).toBe(0);

      f.failNextActivation();
      const activation =
        operation === "start"
          ? f.manager.startContext(ref)
          : f.manager.resumeContext(ref);
      await expect(activation).rejects.toBe(failure);
      await nextTurn();
      expect(f.activate).toHaveBeenCalledTimes(2);
      const claimsBeforeRetry = f.claim.mock.calls.length;
      await f.store.get(ref);
      await f.store.get(ref);
      await nextTurn();
      const delay = resolveContextRestoreRetryDelayMs({
        error: failure,
        ref,
        retryAttempt: 1,
      });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.activate).toHaveBeenCalledTimes(2);
      expect(f.claim).toHaveBeenCalledTimes(claimsBeforeRetry);
      expect(f.runtimeReady()).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await nextTurn();
      expect(f.activate).toHaveBeenCalledTimes(3);
      expect(f.runtimeReady()).toBe(true);
      expect(f.startRun).not.toHaveBeenCalled();
    },
  );

  it("preserves the executor physical-cleanup fence across explicit activation attempts", async () => {
    const failure = new ContextRuntimeCleanupError([
      new Error("physical termination is unknown"),
    ]);
    const f = await createFixture(failure, 6);
    await expect(f.manager.restore()).rejects.toThrow(AggregateError);
    await expect(f.manager.startContext(ref)).rejects.toBe(failure);
    await f.manager.suspendContext(ref);
    await expect(f.manager.resumeContext(ref)).rejects.toBe(failure);
    await nextTurn();

    expect(f.activate).toHaveBeenCalledTimes(1);
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.startRun).not.toHaveBeenCalled();
    await expect(f.manager.close()).rejects.toThrow();
  });
});
