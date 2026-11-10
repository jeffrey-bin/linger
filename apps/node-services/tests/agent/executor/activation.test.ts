import {
  createContextRuntimeActivator,
  createContextViewSessions,
  type ContextViewSessions,
  type ContextRuntimeBackend,
  type ContextRuntimeBackendActivation,
  type ContextRuntimeBackendRequest,
  ContextRuntimeCleanupError,
} from "../../../src/agent/executor/activation.js";
import {
  LocalComputerOfflineError,
  LocalRuntimeAdmissionUnavailableError,
} from "../../../src/agent/runner-gateway/local-computer-management.js";

import { describe, expect, it, vi } from "vitest";

import {
  createBuiltinAgentFeatures,
  type BuiltinAgentFeatures,
  type BuiltinFeatureServices,
} from "../../../src/agent/agent-features/builtin.js";
import { createUserMemoryTracker } from "../../../src/agent/agent-features/user-memory/index.js";
import {
  composeActivationFeatures,
  composeRunFeatures,
} from "../../../src/agent/agent-features/compose.js";
import {
  type ActivationFeatureView,
  defineFeature,
  type FeatureDeclaration,
} from "../../../src/agent/agent-features/contracts.js";
import { createTaskInputFeature } from "../../../src/agent/agent-features/task-input/feature.js";
import type { RuntimeViewPlan } from "../../../src/agent/executor/workspace.js";
import type { GhostResources } from "../../../src/agent/executor/ghost.js";
import type {
  AgentEffectiveResources,
  AgentResourcesResolver,
  McpContextResolution,
  McpContextResolver,
} from "../../../src/agent/executor/teamhub-context-resolvers.js";
import {
  encodeExecutionContextRef,
  type ExecutionContextRef,
} from "../../../src/agent/executor/context-ref.js";
import type {
  AgentLogFields,
  AgentLogger,
} from "../../../src/agent/observability/agent-log.js";
import type {
  AgentInput,
  AgentProvider,
  AgentRun,
} from "../../../src/agent/executor/provider.js";
import { ProviderRunStartError } from "../../../src/agent/executor/provider.js";

describe("Context Runtime Activator", () => {
  it.each(["ordinary", "cleanup", "credential-cleanup"] as const)(
    "preserves cleanup classification through the activation boundary and credential sanitization: %s",
    async (kind) => {
      const logs: CapturedLogEntry[] = [];
      const ref = metaRef(),
        secret = `mcp_ctx_${"A".repeat(43)}`;
      const original = new Error(
        kind === "credential-cleanup" ? secret : "activation failed",
      );
      const failure =
        kind === "ordinary"
          ? original
          : new ContextRuntimeCleanupError([original]);
      const activator = createContextRuntimeActivator({
        features: testFeatures(),
        viewSessions: createContextViewSessions(),
        contextHost: {
          prepareRuntimeView: async () => viewPlan(ref),
          releaseRuntimeView: vi.fn(async () => undefined),
        },
        resolveBackend: () => ({
          activate: async () => {
            throw failure;
          },
        }),
        mcpContextResolver: { resolve: vi.fn(async () => mcpResolution()) },
        logger: capturingLogger(logs),
      });
      const error = await activator
        .activate({
          ref,
          tenantId: "tenant-test",
          actorId: "actor-test",
          mode: "start",
          checkpointRuntimeSession: async () => undefined,
          agent: { name: "Test", instructions: "test" },
          runtime: { type: "fake" },
          resources: ghostResources(),
        })
        .catch((error: unknown) => error);
      expect(error instanceof ContextRuntimeCleanupError).toBe(
        kind !== "ordinary",
      );
      if (kind === "ordinary") expect(error).toBe(original);
      const exposed = JSON.stringify({ error, logs }, [
        "error",
        "logs",
        "message",
        "stack",
        "cause",
        "errors",
        "fields",
      ]);
      expect(exposed).not.toContain(secret);
    },
  );

  it("checks backend availability before resolving MCP and preparing projections", async () => {
    const events: string[] = [];
    const ref = metaRef();
    const availabilityError = new LocalComputerOfflineError();
    const logEntries: CapturedLogEntry[] = [];
    const resolveMcpContext = vi.fn(async () => {
      throw new Error("unexpected MCP Context resolution");
    });
    const stageDocumentProjection = vi.fn(async () => {
      throw new Error("unexpected Document projection staging");
    });
    const prepareRuntimeView = vi.fn(async () => viewPlan(ref));
    const activateBackend = vi.fn(async () => {
      throw new Error("unexpected backend activation");
    });
    const backend = {
      async preflight() {
        events.push("backend.preflight");
        throw availabilityError;
      },
      activate: activateBackend,
    } satisfies ContextRuntimeBackend<{ type: string }>;
    const activator = createContextRuntimeActivator({
      features: testFeatures(),
      viewSessions: createContextViewSessions(),
      contextHost: {
        prepareRuntimeView,
        stageDocumentProjection,
        async releaseRuntimeView() {
          events.push("view.release");
        },
      },
      resolveBackend: () => backend,
      mcpContextResolver: { resolve: resolveMcpContext },
      logger: capturingLogger(logEntries),
    });

    await expect(
      activator.activate({
        ref,
        tenantId: "tenant-test",
        actorId: "actor-test",
        mode: "start",
        agent: { name: "Test Agent", instructions: "base" },
        runtime: { type: "local" },
        resources: ghostResources(),
        checkpointRuntimeSession: vi.fn(),
      }),
    ).rejects.toBe(availabilityError);
    expect(logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          event: "context_activation.waiting_for_computer",
        }),
      ]),
    );
    expect(JSON.stringify(logEntries)).not.toContain("CONTEXT_ACTIVATION_");
    expect(events).toEqual(["backend.preflight"]);
    expect(resolveMcpContext).not.toHaveBeenCalled();
    expect(stageDocumentProjection).not.toHaveBeenCalled();
    expect(prepareRuntimeView).not.toHaveBeenCalled();
    expect(activateBackend).not.toHaveBeenCalled();
  });

  it("stages the Document comment projection on activation and before each Run", async () => {
    const events: string[] = [];
    const ref = {
      kind: "document" as const,
      agentId: "agent-1",
      documentId: "document-1",
    };
    const projection = (commentsMarkdown: string): McpContextResolution =>
      Object.freeze({
        documentCommentRuntime: {
          commentsMarkdown,
          currentDocument: {
            bytes: new Uint8Array([35]),
            documentId: "document-1",
            filename: "Current.md",
            mediaType: "text/markdown",
            sha256: "0".repeat(64),
          },
        },
      });
    const resolve = vi
      .fn<McpContextResolver["resolve"]>()
      .mockResolvedValueOnce(projection("# first"))
      .mockResolvedValueOnce(projection("# second"));
    const stageDocumentProjection = vi.fn(
      async (input: {
        readonly documentComment: { readonly commentsMarkdown: string };
      }) => {
        const label = input.documentComment.commentsMarkdown;
        const mapping = {
          kind: "inbox_view" as const,
          sourcePath: "/projection",
          targetPath: "/workspace/documents/document-1",
          access: "read_only" as const,
        };
        return {
          mapping,
          async activate() {
            events.push(`projection.activate ${label}`);
            return mapping;
          },
          async discard() {
            events.push(`projection.discard ${label}`);
          },
          async release() {
            events.push(`projection.release ${label}`);
          },
        };
      },
    );
    const activator = createContextRuntimeActivator({
      features: testFeatures(),
      viewSessions: createContextViewSessions(),
      contextHost: {
        prepareRuntimeView: async () => viewPlan(ref),
        stageDocumentProjection,
        async releaseRuntimeView() {},
      },
      resolveBackend: () => ({
        async activate() {
          return fakeBackendActivation(fakeProvider(events));
        },
      }),
      mcpContextResolver: { resolve },
      logger: silentLogger(),
    });
    const active = await activator.activate({
      ref,
      tenantId: "tenant-test",
      actorId: "actor-test",
      mode: "start",
      agent: { name: "Test Agent", instructions: "base" },
      runtime: { type: "local" },
      resources: ghostResources(),
      checkpointRuntimeSession: vi.fn(),
    });
    expect(resolve).toHaveBeenCalledWith({ ref, signal: expect.anything() });
    expect(stageDocumentProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        documentComment: expect.objectContaining({
          commentsMarkdown: "# first",
        }),
      }),
    );
    expect(stageDocumentProjection.mock.calls[0]?.[0]).not.toHaveProperty(
      "contextGenerationId",
    );

    events.length = 0;
    await active.provider.startRun(
      active.runtimeSession,
      { type: "text", text: "start" },
      { runContext: { executionRunRef: "run-1", sourceInboxIds: [] } },
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "projection.activate # second",
      "projection.release # first",
    ]);
    await active.deactivate();
    expect(events).toContain("projection.release # second");
  });

  it("starts memory and memory.md preparation before agent resources resolve", async () => {
    const ref = metaRef();
    const pendingResources = deferred<never>();
    const resolveResources = vi.fn(() => pendingResources.promise);
    const prepare = vi.fn(async () => ({ summary: "published memory" }));
    const resolveUserMemory = vi.fn(async () => undefined);
    const failure = new Error("agent resources failed");
    const activator = createContextRuntimeActivator({
      viewSessions: createContextViewSessions(),
      contextHost: {
        prepareRuntimeView: async () => viewPlan(ref),
        releaseRuntimeView: async () => {},
      },
      resolveBackend: () => ({
        activate: vi.fn(async () => {
          throw new Error("unexpected backend activation");
        }),
      }),
      agentResourcesResolver: { resolve: resolveResources },
      features: testFeatures({
        resolveUserMemory,
        agentMemory: {
          agentMemory: {
            recordRun: vi.fn(async () => undefined),
            wake: vi.fn(async () => undefined),
          },
          agentMemoryProjection: { prepare },
        },
      }),
      logger: capturingLogger([]),
    });
    const activation = activator.activate({
      agentType: "anotherme",
      ref,
      tenantId: "tenant-test",
      actorId: "actor-test",
      mode: "start",
      agent: { name: "Test Agent", instructions: "base" },
      runtime: { type: "local" },
      resources: ghostResources(),
      checkpointRuntimeSession: vi.fn(),
    });
    await vi.waitFor(() => {
      expect(resolveResources).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledOnce();
      expect(resolveUserMemory).toHaveBeenCalledOnce();
    });
    pendingResources.reject(failure);
    await expect(activation).rejects.toBe(failure);
  });

  it("settles early memory and memory.md failures when a later step fails", async () => {
    const ref = metaRef();
    const failure = new Error("agent resources failed");
    const activator = createContextRuntimeActivator({
      viewSessions: createContextViewSessions(),
      contextHost: {
        prepareRuntimeView: async () => viewPlan(ref),
        releaseRuntimeView: async () => {},
      },
      resolveBackend: () => ({
        activate: vi.fn(async () => {
          throw new Error("unexpected backend activation");
        }),
      }),
      agentResourcesResolver: {
        resolve: vi.fn(async () => {
          throw failure;
        }),
      },
      features: testFeatures({
        resolveUserMemory: vi.fn(async () => {
          throw new Error("memory.md read failed");
        }),
        agentMemory: {
          agentMemory: {
            recordRun: vi.fn(async () => undefined),
            wake: vi.fn(async () => undefined),
          },
          agentMemoryProjection: {
            prepare: vi.fn(async () => {
              throw new Error("memory failed");
            }),
          },
        },
      }),
      logger: capturingLogger([]),
    });
    await expect(
      activator.activate({
        agentType: "anotherme",
        ref,
        tenantId: "tenant-test",
        actorId: "actor-test",
        mode: "start",
        agent: { name: "Test Agent", instructions: "base" },
        runtime: { type: "local" },
        resources: ghostResources(),
        checkpointRuntimeSession: vi.fn(),
      }),
    ).rejects.toBe(failure);
    // Give any unobserved rejection a turn to surface before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("aborts early memory and memory.md work when activation fails", async () => {
    const ref = metaRef();
    const failure = new Error("agent resources failed");
    const earlySignals: AbortSignal[] = [];
    // Pending until aborted, so the early work only ends through its signal.
    const waitForAbort = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    const activator = createContextRuntimeActivator({
      viewSessions: createContextViewSessions(),
      contextHost: {
        prepareRuntimeView: async () => viewPlan(ref),
        releaseRuntimeView: async () => {},
      },
      resolveBackend: () => ({
        activate: vi.fn(async () => {
          throw new Error("unexpected backend activation");
        }),
      }),
      agentResourcesResolver: {
        resolve: vi.fn(async () => {
          throw failure;
        }),
      },
      features: testFeatures({
        resolveUserMemory: vi.fn((_agentId: string, signal: AbortSignal) => {
          earlySignals.push(signal);
          return waitForAbort(signal);
        }),
        agentMemory: {
          agentMemory: {
            recordRun: vi.fn(async () => undefined),
            wake: vi.fn(async () => undefined),
          },
          agentMemoryProjection: {
            prepare: vi.fn((_agentId: string, signal: AbortSignal) => {
              earlySignals.push(signal);
              return waitForAbort(signal);
            }),
          },
        },
      }),
      logger: capturingLogger([]),
    });
    await expect(
      activator.activate({
        agentType: "anotherme",
        ref,
        tenantId: "tenant-test",
        actorId: "actor-test",
        mode: "start",
        agent: { name: "Test Agent", instructions: "base" },
        runtime: { type: "local" },
        resources: ghostResources(),
        checkpointRuntimeSession: vi.fn(),
      }),
    ).rejects.toBe(failure);
    expect(earlySignals).toHaveLength(2);
    expect(earlySignals.every((signal) => signal.aborted)).toBe(true);
    // Give any unobserved rejection a turn to surface before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("deactivates the backend when activation is canceled after creating a session", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const ref = metaRef();
    const provider = fakeProvider(events, {
      async createSession() {
        events.push("provider.createSession");
        controller.abort(new Error("activation canceled"));
        return { threadId: "thread-uncheckpointed" };
      },
    });
    const activator = createContextRuntimeActivator({
      features: testFeatures(),
      viewSessions: createContextViewSessions(),
      contextHost: {
        async prepareRuntimeView() {
          return viewPlan(ref);
        },
        async releaseRuntimeView() {},
      },
      resolveBackend: () => ({
        async activate() {
          return {
            provider,
            runtimeName: "fake-runtime",
            sessionSpec: {
              workingDirectory: "/runtime/workspace",
              threadName: "Test Agent",
              sandboxMode: "workspace-write",
              resources: { mcpServers: [] },
            },
            setActiveRunContext() {},
            async synchronize() {},
            async deactivate() {
              events.push("backend.deactivate");
            },
          };
        },
      }),
      logger: silentLogger(),
    });

    await expect(
      activator.activate({
        ref,
        tenantId: "tenant-test",
        actorId: "actor-test",
        mode: "start",
        agent: { name: "Test Agent", instructions: "base" },
        runtime: { type: "fake" },
        resources: ghostResources(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("activation canceled");
    expect(events).toEqual(["provider.createSession", "backend.deactivate"]);
  });

  it("continues failed backend and View cleanup without repeating successful steps", async () => {
    const events: string[] = [];
    let backendAttempts = 0;
    let viewAttempts = 0;
    const ref = metaRef();
    const plan = viewPlan(ref);
    const provider = fakeProvider(events);
    const activator = createContextRuntimeActivator({
      features: testFeatures(),
      viewSessions: eventingViewSessions(events),
      contextHost: {
        async prepareRuntimeView() {
          events.push("view.prepare");
          return plan;
        },
        async releaseRuntimeView(receivedRef) {
          expect(receivedRef).toEqual(ref);
          events.push("view.release");
          if (++viewAttempts === 1) throw new Error("view cleanup unavailable");
        },
      },
      resolveBackend() {
        return {
          async activate() {
            events.push("backend.activate");
            return {
              provider,
              runtimeName: "fake-runtime",
              sessionSpec: {
                workingDirectory: "/runtime/workspace",
                threadName: "Test Agent",
                sandboxMode: "workspace-write",
                resources: { mcpServers: [] },
              },
              setActiveRunContext() {},
              async synchronize() {},
              async deactivate() {
                events.push("backend.deactivate");
                if (++backendAttempts === 1)
                  throw new Error("backend cleanup unavailable");
              },
            };
          },
        };
      },
      logger: silentLogger(),
    });
    const activated = await activator.activate({
      ref,
      tenantId: "tenant-test",
      actorId: "actor-test",
      mode: "start",
      agent: { name: "Test Agent", instructions: "base" },
      runtime: { type: "fake" },
      resources: ghostResources(),
    });

    expect(events).toEqual([
      "view.prepare",
      "backend.activate",
      "provider.createSession",
    ]);
    const first = activated.deactivate();
    expect(activated.deactivate()).toBe(first);
    await expect(first).rejects.toThrow("deactivation failed");
    const retry = activated.deactivate();
    expect(activated.deactivate()).toBe(retry);
    await expect(retry).resolves.toBeUndefined();
    await activated.deactivate();
    expect(backendAttempts).toBe(2);
    expect(viewAttempts).toBe(2);
    expect(
      events.filter((event) => event === "view-session.release"),
    ).toHaveLength(1);
  });

  it("binds one immutable Runtime View to Context activation before session creation", async () => {
    const events: string[] = [];
    const executionEpoch = "agent-epoch-9";
    const ref = metaRef();
    const plan = viewPlan(ref);
    const provider = fakeProvider(events, {
      async clearRunResources() {
        events.push("provider.clear");
      },
    });
    const activator = createContextRuntimeActivator({
      features: testFeatures(),
      viewSessions: eventingViewSessions(events),
      contextHost: {
        async prepareRuntimeView() {
          events.push("view.prepare");
          return plan;
        },
        async releaseRuntimeView(receivedRef) {
          expect(receivedRef).toEqual(ref);
          events.push("view.release");
        },
      },
      resolveBackend() {
        return {
          async activate(request) {
            events.push("backend.activate");
            expect(request.executionEpoch).toBe(executionEpoch);
            expect(request.viewPlan).toBe(plan);
            return {
              provider,
              runtimeName: "fake-runtime",
              sessionSpec: {
                workingDirectory: "/runtime/workspace",
                threadName: "Test Agent",
                sandboxMode: "workspace-write",
                resources: { mcpServers: [] },
              },
              setActiveRunContext() {},
              async synchronize() {},
              async deactivate() {
                events.push("backend.deactivate");
              },
            };
          },
        };
      },
      logger: silentLogger(),
    });
    const activated = await activator.activate({
      ref,
      tenantId: "tenant-test",
      actorId: "actor-test",
      mode: "start",
      executionEpoch,
      agent: { name: "Test Agent", instructions: "base" },
      runtime: { type: "fake" },
      resources: ghostResources(),
    });

    expect(events).toEqual([
      "view.prepare",
      "backend.activate",
      "provider.createSession",
    ]);
    await activated.deactivate();
    await activated.deactivate();
    expect(events.slice(-3)).toEqual([
      "backend.deactivate",
      "view-session.release",
      "view.release",
    ]);
    expect(events.filter((event) => event === "view.release")).toHaveLength(1);
  });

  it("synchronizes the active backend exactly once before each Run and steer", async () => {
    const events: string[] = [];
    const ref = metaRef();
    const plan = viewPlan(ref);
    let synchronizeAttempts = 0;
    const run = emptyRun();
    const steerController = new AbortController();
    const provider = fakeProvider(events, {
      async startRun(_session, input) {
        expect(input.text).toBe("frozen Task input\nretry");
        events.push("provider.startRun");
        return run;
      },
      async steer(receivedRun, options) {
        expect(receivedRun).toBe(run);
        expect(options.signal).toBe(steerController.signal);
        events.push("provider.steer");
        return { turnId: "turn-1" };
      },
    });
    const activator = createContextRuntimeActivator({
      features: testFeatures(),
      viewSessions: createContextViewSessions(),
      contextHost: {
        async prepareRuntimeView() {
          return plan;
        },
        async releaseRuntimeView() {},
      },
      resolveBackend() {
        return {
          async activate() {
            return {
              provider,
              runtimeName: "fake-runtime",
              sessionSpec: {
                workingDirectory: "/runtime/workspace",
                threadName: "Test Agent",
                sandboxMode: "workspace-write",
                resources: { mcpServers: [] },
              },
              setActiveRunContext() {},
              async prepareRunInput(input) {
                events.push("backend.prepareRunInput");
                return { ...input, text: `frozen Task input\n${input.text}` };
              },
              async synchronize() {
                synchronizeAttempts += 1;
                events.push("backend.synchronize");
                if (synchronizeAttempts === 1) {
                  throw new Error("refresh failed");
                }
              },
              async deactivate() {},
            };
          },
        };
      },
      logger: silentLogger(),
    });
    const activated = await activator.activate({
      ref,
      tenantId: "tenant-test",
      actorId: "actor-test",
      mode: "start",
      agent: { name: "Test Agent", instructions: "base" },
      runtime: { type: "fake" },
      resources: ghostResources(),
    });
    const spec = {
      signal: new AbortController().signal,
      runContext: {
        executionRunRef: "run-1",
        sourceInboxIds: [],
      },
    };

    await expect(
      activated.provider.startRun(
        activated.runtimeSession,
        {
          type: "text",
          text: "first attempt",
        },
        spec,
      ),
    ).rejects.toThrow("refresh failed");
    const activeRun = await activated.provider.startRun(
      activated.runtimeSession,
      { type: "text", text: "retry" },
      spec,
    );
    await activated.provider.steer(activeRun, {
      input: { type: "text", text: "steer" },
      signal: steerController.signal,
    });

    expect(events).toEqual([
      "provider.createSession",
      "backend.synchronize",
      "backend.synchronize",
      "backend.prepareRunInput",
      "provider.startRun",
      "backend.synchronize",
      "provider.steer",
    ]);
    await activated.deactivate();
  });

  it("forwards the presence prestart and the source Run's process fields through the synchronized Provider", async () => {
    const ref = metaRef();
    const sourceRun: AgentRun = {
      ...emptyRun(),
      processReused: true,
      dispatchedAtUnixMs: 1_700_000_000_100,
    };
    const prepareForPresence = vi.fn();
    const provider = fakeProvider([], {
      async startRun() {
        return sourceRun;
      },
      prepareForPresence,
    });
    const activator = createContextRuntimeActivator({
      viewSessions: createContextViewSessions(),
      contextHost: {
        async prepareRuntimeView() {
          return viewPlan(ref);
        },
        async releaseRuntimeView() {},
      },
      resolveBackend() {
        return {
          async activate() {
            return {
              provider,
              runtimeName: "fake-runtime",
              sessionSpec: {
                workingDirectory: "/runtime/workspace",
                threadName: "Test Agent",
                sandboxMode: "workspace-write" as const,
                resources: { mcpServers: [] },
              },
              setActiveRunContext() {},
              async synchronize() {},
              async deactivate() {},
            };
          },
        };
      },
      features: testFeatures(),
      logger: silentLogger(),
    });
    const activated = await activator.activate({
      ref,
      tenantId: "tenant-test",
      actorId: "actor-test",
      mode: "start",
      agent: { name: "Test Agent", instructions: "base" },
      runtime: { type: "fake" },
      resources: ghostResources(),
    });
    activated.provider.prepareForPresence?.(activated.runtimeSession);
    expect(prepareForPresence).toHaveBeenCalledWith(activated.runtimeSession);
    const run = await activated.provider.startRun(
      activated.runtimeSession,
      { type: "text", text: "hello" },
      { runContext: { executionRunRef: "run-1", sourceInboxIds: [] } },
    );
    expect(run).not.toBe(sourceRun);
    expect(run.processReused).toBe(true);
    expect(run.dispatchedAtUnixMs).toBe(1_700_000_000_100);
    await activated.deactivate();
  });

  describe("activation feature wiring", () => {
    const wired = (input?: {
      readonly features?: Pick<
        BuiltinAgentFeatures,
        "composeActivation" | "composeRun"
      >;
      readonly services?: Omit<BuiltinFeatureServices, "logger">;
      readonly agentResourcesResolver?: AgentResourcesResolver;
      readonly logger?: AgentLogger;
      readonly provider?: AgentProvider;
      readonly activate?: (
        request: ContextRuntimeBackendRequest<{ type: string }>,
      ) => Promise<ContextRuntimeBackendActivation>;
      readonly compactInstructions?: boolean;
    }) => {
      const events: string[] = [];
      const ref = metaRef();
      const requests: ContextRuntimeBackendRequest<{ type: string }>[] = [];
      const provider = input?.provider ?? fakeProvider(events);
      const activator = createContextRuntimeActivator<{ type: string }>({
        features: input?.features ?? testFeatures(input?.services),
        viewSessions: createContextViewSessions(),
        contextHost: {
          prepareRuntimeView: async () => viewPlan(ref),
          async releaseRuntimeView() {},
        },
        resolveBackend: () => ({
          ...(input?.compactInstructions === undefined
            ? {}
            : {
                preflight: () => ({
                  compactInstructions: input.compactInstructions!,
                }),
              }),
          async activate(request) {
            requests.push(request);
            return (
              input?.activate?.(request) ?? fakeBackendActivation(provider)
            );
          },
        }),
        ...(input?.agentResourcesResolver
          ? { agentResourcesResolver: input.agentResourcesResolver }
          : {}),
        logger: input?.logger ?? silentLogger(),
      });
      const activate = (
        overrides: Partial<Parameters<typeof activator.activate>[0]> = {},
      ) =>
        activator.activate({
          ref,
          tenantId: "tenant-test",
          actorId: "actor-test",
          mode: "start",
          agent: {
            name: "Test Agent",
            instructions: "base",
            developerInstructions: "base policy",
          },
          runtime: { type: "fake" },
          resources: ghostResources(),
          // The user-memory feature applies to AnotherMe only.
          agentType: "anotherme",
          ...overrides,
        });
      return { activate, events, provider, ref, requests };
    };

    it("writes the current memory.md into the Runtime instructions", async () => {
      const resolveUserMemory = vi.fn(async () => ({
        version: 7,
        markdown: "# Memory\n- Keeps orchards [2026-11-01]",
      }));
      const harness = wired({ services: { resolveUserMemory } });
      const active = await harness.activate();
      try {
        expect(resolveUserMemory).toHaveBeenCalledOnce();
        expect(resolveUserMemory).toHaveBeenCalledWith(
          "agent-1",
          expect.any(AbortSignal),
        );
        const instructions = harness.requests[0]!.agent.developerInstructions;
        expect(instructions).toContain("base policy");
        expect(instructions).toContain('<user-memory version="7">');
        expect(instructions).toContain("orchards");
      } finally {
        await active.deactivate();
      }
    });

    it("never reads memory.md for an Agent other than AnotherMe", async () => {
      const resolveUserMemory = vi.fn(async () => undefined);
      const harness = wired({ services: { resolveUserMemory } });
      const active = await harness.activate({ agentType: "general" });
      try {
        // Reading it fetches Agent identity from TeamHub before every Run.
        expect(resolveUserMemory).not.toHaveBeenCalled();
        expect(harness.requests[0]!.agent.developerInstructions).not.toContain(
          "<user-memory",
        );
      } finally {
        await active.deactivate();
      }
    });

    it("logs the agent resource resolution duration and each feature preparation", async () => {
      const logs: CapturedLogEntry[] = [];
      const agentResourcesResolver: AgentResourcesResolver = {
        resolve: vi.fn(async () => ({
          effectiveSha256: "e".repeat(64),
          skills: [],
          connectedApps: true,
        })),
      };
      const harness = wired({
        services: { resolveUserMemory: vi.fn(async () => undefined) },
        agentResourcesResolver,
        logger: capturingLogger(logs),
      });
      const active = await harness.activate();
      try {
        expect(agentResourcesResolver.resolve).toHaveBeenCalledOnce();
        expect(logs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              level: "info",
              event: "context_activation.agent_resources_resolved",
              fields: expect.objectContaining({
                durationMs: expect.any(Number),
              }),
            }),
          ]),
        );
        expect(
          logs.filter(
            ({ event }) =>
              event === "context_activation.runtime_feature_prepared",
          ),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              fields: expect.objectContaining({
                feature: "user-memory",
                durationMs: expect.any(Number),
                outcome: "fulfilled",
              }),
            }),
          ]),
        );
      } finally {
        await active.deactivate();
      }
    });

    it.each([
      { connectedApps: true, recovered: false },
      { connectedApps: false, recovered: false },
      { connectedApps: false, recovered: true },
    ])(
      "renders the instructions with the current connected apps fact (%o)",
      async ({ connectedApps, recovered }) => {
        const agentResourcesResolver: AgentResourcesResolver = {
          resolve: vi.fn(async () => ({
            effectiveSha256: "e".repeat(64),
            skills: [],
            connectedApps,
          })),
        };
        const harness = wired({ agentResourcesResolver });
        const active = await harness.activate({
          renderDeveloperInstructions: (facts) =>
            `apps:${String(facts.connectedApps)}`,
          ...(recovered
            ? {
                recoveryResources: {
                  version: 1 as const,
                  executionRunRef: "run-recovered",
                  effectiveSha256: "e".repeat(64),
                  skills: [],
                },
              }
            : {}),
        });
        try {
          expect(harness.requests[0]!.agent.developerInstructions).toBe(
            `apps:${String(connectedApps)}`,
          );
        } finally {
          await active.deactivate();
        }
      },
    );

    it.each([true, false])(
      "renders compact instructions when preflight asks for them (%s)",
      async (compactInstructions) => {
        const harness = wired({
          compactInstructions,
          agentResourcesResolver: {
            resolve: vi.fn(async () => ({
              effectiveSha256: "e".repeat(64),
              skills: [],
              connectedApps: true,
            })),
          },
        });
        const active = await harness.activate({
          renderDeveloperInstructions: (facts) =>
            `compact:${String(facts.compactInstructions)}`,
        });
        try {
          expect(harness.requests[0]!.agent.developerInstructions).toBe(
            `compact:${String(compactInstructions)}`,
          );
          expect(harness.requests[0]!.compactInstructions).toBe(
            compactInstructions ? true : undefined,
          );
        } finally {
          await active.deactivate();
        }
      },
    );

    it("keeps Agent Memory out of the instructions and maps its files", async () => {
      const prepare = vi.fn(async () => ({
        summary: "memory summary",
        mapping: {
          kind: "memory" as const,
          sourcePath: "/memory/rev-1",
          targetPath: "/workspace/agent-memory",
          access: "read_only" as const,
        },
      }));
      const harness = wired({
        services: {
          agentMemory: {
            agentMemory: {
              recordRun: vi.fn(async () => undefined),
              wake: vi.fn(async () => undefined),
            },
            agentMemoryProjection: { prepare },
          },
        },
      });
      const active = await harness.activate();
      try {
        expect(prepare).toHaveBeenCalledWith(
          "agent-1",
          expect.any(AbortSignal),
        );
        const instructions = harness.requests[0]!.agent.developerInstructions;
        expect(instructions).toContain("base policy");
        expect(instructions).not.toContain("memory summary");
        expect(instructions).not.toContain("agent-memory");
        expect(harness.requests[0]!.viewPlan.mappings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "memory",
              targetPath: "/workspace/agent-memory",
              access: "read_only",
            }),
          ]),
        );
      } finally {
        await active.deactivate();
      }
    });

    it("tells activation features whether the next Run starts the native conversation", async () => {
      const newSessions: (boolean | undefined)[] = [];
      const harness = wired({
        features: declarationFeatures([
          defineFeature({
            id: "session-probe",
            activation: {
              ports: { prepareRuntime: {} },
              create: () => ({
                prepareRuntime: async (_view, input) => {
                  newSessions.push(input.newSession);
                  return {};
                },
              }),
            },
          }),
        ]),
      });
      for (const overrides of [
        {},
        {
          mode: "resume" as const,
          previousSession: {
            provider: "claude",
            sessionId: "reserved",
            lingerMaterialized: false,
          },
        },
        {
          mode: "resume" as const,
          previousSession: { provider: "claude", sessionId: "materialized" },
        },
      ]) {
        const active = await harness.activate(overrides);
        await active.deactivate();
      }
      expect(newSessions).toEqual([true, true, false]);
    });

    it("releases acquired activation state when a feature preparation fails", async () => {
      const release = vi.fn(async () => undefined);
      const harness = wired({
        features: declarationFeatures([
          defineFeature({
            id: "a-acquired",
            activation: {
              ports: { prepareRuntime: {} },
              create: () => ({
                prepareRuntime: async () => ({ release }),
              }),
            },
          }),
          defineFeature({
            id: "z-projection-failure",
            activation: {
              ports: { prepareRuntime: {} },
              create: () => ({
                prepareRuntime: async () => {
                  throw new Error("memory projection failed");
                },
              }),
            },
          }),
        ]),
      });
      await expect(harness.activate()).rejects.toThrow(
        "memory projection failed",
      );
      expect(release).toHaveBeenCalledOnce();
      expect(harness.requests).toHaveLength(0);
    });

    it("releases activation state on deactivate", async () => {
      const release = vi.fn(async () => undefined);
      const harness = wired({
        features: declarationFeatures([
          defineFeature({
            id: "activation-state",
            activation: {
              ports: { prepareRuntime: {} },
              create: () => ({
                prepareRuntime: async () => ({ release }),
              }),
            },
          }),
        ]),
      });
      const active = await harness.activate();
      await active.deactivate();
      expect(release).toHaveBeenCalledOnce();
    });

    it("propagates an activation release failure during deactivation", async () => {
      const release = vi.fn(async () => {
        throw new Error("activation release failed");
      });
      const harness = wired({
        features: declarationFeatures([
          defineFeature({
            id: "activation-state",
            activation: {
              ports: { prepareRuntime: {} },
              create: () => ({
                prepareRuntime: async () => ({ release }),
              }),
            },
          }),
        ]),
      });
      const active = await harness.activate();
      const error: unknown = await active
        .deactivate()
        .catch((failure: unknown) => failure);
      expect(release).toHaveBeenCalledOnce();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("activation release failed");
    });

    it("freezes each new Run input through this activation's Task port only", async () => {
      const events: string[] = [];
      const inputs: string[] = [];
      const run = emptyRun();
      const provider = fakeProvider(events, {
        async startRun(_session, input) {
          inputs.push(input.text);
          events.push("provider.startRun");
          return run;
        },
        async steer(_run, options) {
          inputs.push(options.input.text);
          events.push("provider.steer");
          return { turnId: "turn-1" };
        },
      });
      const prepareRunInput = vi.fn(async (input: AgentInput) => {
        events.push("backend.prepareRunInput");
        return { ...input, text: `frozen:${input.text}` };
      });
      const harness = wired({
        provider,
        activate: async () =>
          fakeBackendActivation(provider, { prepareRunInput }),
      });
      const active = await harness.activate();
      try {
        const started = await active.provider.startRun(
          active.runtimeSession,
          { type: "text", text: "x" },
          {},
        );
        expect(prepareRunInput).toHaveBeenCalledOnce();
        expect(inputs).toEqual(["frozen:x"]);
        await active.provider.steer(started, {
          input: { type: "text", text: "y" },
        });
        // Steer synchronizes within the Run; it never re-freezes Task input.
        expect(prepareRunInput).toHaveBeenCalledOnce();
        expect(inputs).toEqual(["frozen:x", "y"]);
        expect(events).toEqual([
          "provider.createSession",
          "backend.prepareRunInput",
          "provider.startRun",
          "provider.steer",
        ]);
      } finally {
        await active.deactivate();
      }
    });

    it("rejects a new Run when the bound Task input freeze fails", async () => {
      const provider = fakeProvider([]);
      const harness = wired({
        provider,
        activate: async () =>
          fakeBackendActivation(provider, {
            prepareRunInput: async () => {
              throw new Error("freeze failed");
            },
          }),
      });
      const active = await harness.activate();
      try {
        await expect(
          active.provider.startRun(
            active.runtimeSession,
            { type: "text", text: "x" },
            {},
          ),
        ).rejects.toMatchObject({ effect: "definitely_not_started" });
      } finally {
        await active.deactivate();
      }
    });

    it("binds a fresh activation state and its own backend on re-activation", async () => {
      const resolveUserMemory = vi.fn(async () => undefined);
      const events: string[] = [];
      const inputs: string[] = [];
      const provider = fakeProvider(events, {
        async startRun(_session, input) {
          inputs.push(input.text);
          return emptyRun();
        },
      });
      let activationIndex = 0;
      const harness = wired({
        provider,
        services: { resolveUserMemory },
        activate: async () => {
          const tag = ++activationIndex === 1 ? "A" : "B";
          return fakeBackendActivation(provider, {
            prepareRunInput: async (input) => ({
              ...input,
              text: `${tag}:${input.text}`,
            }),
          });
        },
      });
      const first = await harness.activate();
      await first.provider.startRun(
        first.runtimeSession,
        { type: "text", text: "x" },
        {},
      );
      await first.deactivate();
      const second = await harness.activate();
      try {
        await second.provider.startRun(
          second.runtimeSession,
          { type: "text", text: "x" },
          {},
        );
        // The suspended Runtime's backend closure is never reused.
        expect(inputs).toEqual(["A:x", "B:x"]);
        // A re-activation is a fresh activation state: Profile re-resolved.
        expect(resolveUserMemory).toHaveBeenCalledTimes(2);
      } finally {
        await second.deactivate();
      }
    });

    describe("trusted agentType matching", () => {
      const anothermeFeatures = (
        seen: ActivationFeatureView["agentType"][],
      ): FeatureDeclaration[] => [
        defineFeature({
          id: "typed-activation",
          match: { agentTypes: ["anotherme"] },
          activation: {
            ports: { prepareRuntime: {} },
            create: (view) => {
              seen.push(view.agentType);
              return {
                prepareRuntime: async () => ({
                  runtimeViewMappings: [
                    {
                      kind: "memory" as const,
                      sourcePath: "/typed",
                      targetPath: "/workspace/typed",
                      access: "read_only" as const,
                    },
                  ],
                }),
              };
            },
          },
        }),
        defineFeature({
          id: "typed-run",
          match: { agentTypes: ["anotherme"] },
          run: {
            ports: { prepareRunInput: {} },
            create: (view) => {
              seen.push(view.agentType);
              return {
                prepareRunInput: async (_view, input) => ({
                  ...input,
                  text: `typed:${input.text}`,
                }),
              };
            },
          },
        }),
      ];
      const recordingProvider = (inputs: string[]) =>
        fakeProvider([], {
          async startRun(_session, input) {
            inputs.push(input.text);
            return emptyRun();
          },
        });

      it("supplies the trusted request agentType to activation and run matching", async () => {
        const seen: ActivationFeatureView["agentType"][] = [];
        const inputs: string[] = [];
        const harness = wired({
          provider: recordingProvider(inputs),
          features: declarationFeatures(anothermeFeatures(seen)),
        });
        const active = await harness.activate({ agentType: "anotherme" });
        try {
          expect(seen).toEqual(["anotherme", "anotherme"]);
          expect(harness.requests[0]!.viewPlan.mappings).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ targetPath: "/workspace/typed" }),
            ]),
          );
          await active.provider.startRun(
            active.runtimeSession,
            { type: "text", text: "x" },
            {},
          );
          expect(inputs).toEqual(["typed:x"]);
        } finally {
          await active.deactivate();
        }
      });

      it("excludes activation and run declarations whose agentTypes do not match the trusted type", async () => {
        const seen: ActivationFeatureView["agentType"][] = [];
        const inputs: string[] = [];
        const harness = wired({
          provider: recordingProvider(inputs),
          features: declarationFeatures(anothermeFeatures(seen)),
        });
        const active = await harness.activate({ agentType: "general" });
        try {
          expect(seen).toEqual([]);
          expect(harness.requests[0]!.viewPlan.mappings).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ targetPath: "/workspace/typed" }),
            ]),
          );
          await active.provider.startRun(
            active.runtimeSession,
            { type: "text", text: "x" },
            {},
          );
          expect(inputs).toEqual(["x"]);
        } finally {
          await active.deactivate();
        }
      });

      it("fails activation when a declaration requires agentTypes matching but no agentType was supplied", async () => {
        const harness = wired({
          features: declarationFeatures(anothermeFeatures([])),
        });
        await expect(
          harness.activate({ agentType: undefined }),
        ).rejects.toThrow(
          "declares an agentTypes match but no agentType was supplied",
        );
        expect(harness.requests).toHaveLength(0);
      });
    });
  });

  it("defers a steer on a new-Run diagnostic failure without interrupting the active Run", async () => {
    const events: string[] = [];
    const ref = metaRef();
    let finishRun!: (result: { finalResponse: string }) => void;
    const runResult = new Promise<{ finalResponse: string }>((resolve) => {
      finishRun = resolve;
    });
    const respond = vi.fn(
      async (
        _operationId: string,
        _requestId: string,
        _payload: Record<string, unknown>,
      ) => undefined,
    );
    const sourceRun: AgentRun = {
      respond,
      events: emptyRun().events,
      wait: () => runResult,
      cancel: vi.fn(),
    };
    let refreshCount = 0;
    const provider = fakeProvider(events, {
      async startRun() {
        return sourceRun;
      },
      async steer() {
        events.push("provider.steer");
        return { turnId: "turn-next" };
      },
    });
    const activator = createContextRuntimeActivator({
      features: testFeatures(),
      viewSessions: createContextViewSessions(),
      contextHost: {
        async prepareRuntimeView() {
          return viewPlan(ref);
        },
        async releaseRuntimeView() {},
      },
      resolveBackend() {
        return {
          async activate() {
            return {
              provider,
              runtimeName: "fake-runtime",
              sessionSpec: {
                workingDirectory: "/runtime/workspace",
                threadName: "Test Agent",
                sandboxMode: "workspace-write" as const,
                resources: { mcpServers: [] },
              },
              setActiveRunContext() {},
              async synchronize() {
                if (++refreshCount === 2) {
                  throw new LocalRuntimeAdmissionUnavailableError();
                }
              },
              async deactivate() {},
            };
          },
        };
      },
      logger: silentLogger(),
    });
    const active = await activator.activate({
      ref,
      tenantId: "tenant-test",
      actorId: "actor-test",
      mode: "start",
      agent: { name: "Test Agent", instructions: "base" },
      runtime: { type: "fake" },
      resources: ghostResources(),
    });
    const run = await active.provider.startRun(
      active.runtimeSession,
      { type: "text", text: "initial" },
      {},
    );
    await run.respond!("operation-1", "request-1", { decision: "deny" });
    expect(respond).toHaveBeenCalledWith("operation-1", "request-1", {
      decision: "deny",
    });
    expect(refreshCount).toBe(1);
    await expect(
      active.provider.steer(run, {
        input: { type: "text", text: "follow-up" },
      }),
    ).rejects.toMatchObject({ effect: "definitely_not_applied" });
    expect(sourceRun.cancel).not.toHaveBeenCalled();
    expect(events).not.toContain("provider.steer");
    await expect(
      active.provider.steer(run, {
        input: { type: "text", text: "another follow-up" },
      }),
    ).resolves.toEqual({ turnId: "turn-next" });
    finishRun({ finalResponse: "completed" });
    await expect(run.wait()).resolves.toEqual({ finalResponse: "completed" });
    expect(sourceRun.cancel).not.toHaveBeenCalled();
    await active.deactivate();
  });

  it("serializes refresh and delivery across concurrent steers", async () => {
    const events: string[] = [];
    const ref = metaRef();
    const plan = viewPlan(ref);
    const run = emptyRun();
    let releaseFirstSteer: (() => void) | undefined;
    let markFirstSteerEntered: (() => void) | undefined;
    const firstSteerBlocked = new Promise<void>((resolve) => {
      releaseFirstSteer = resolve;
    });
    const firstSteerEntered = new Promise<void>((resolve) => {
      markFirstSteerEntered = resolve;
    });
    let steerCount = 0;
    const provider = fakeProvider(events, {
      async startRun() {
        return run;
      },
      async steer() {
        steerCount += 1;
        events.push(`provider.steer.${steerCount}`);
        if (steerCount === 1) {
          markFirstSteerEntered?.();
          await firstSteerBlocked;
        }
        return { turnId: "turn-1" };
      },
    });
    const activator = createContextRuntimeActivator({
      features: testFeatures(),
      viewSessions: createContextViewSessions(),
      contextHost: {
        async prepareRuntimeView() {
          return plan;
        },
        async releaseRuntimeView() {},
      },
      resolveBackend() {
        return {
          async activate() {
            return {
              provider,
              runtimeName: "fake-runtime",
              sessionSpec: {
                workingDirectory: "/runtime/workspace",
                threadName: "Test Agent",
                sandboxMode: "workspace-write",
                resources: { mcpServers: [] },
              },
              setActiveRunContext() {},
              async synchronize() {
                events.push("backend.synchronize");
              },
              async deactivate() {},
            };
          },
        };
      },
      logger: silentLogger(),
    });
    const activated = await activator.activate({
      ref,
      tenantId: "tenant-test",
      actorId: "actor-test",
      mode: "start",
      agent: { name: "Test Agent", instructions: "base" },
      runtime: { type: "fake" },
      resources: ghostResources(),
    });
    const activeRun = await activated.provider.startRun(
      activated.runtimeSession,
      { type: "text", text: "start" },
      {},
    );
    events.length = 0;

    const first = activated.provider.steer(activeRun, {
      input: { type: "text", text: "first" },
    });
    await firstSteerEntered;
    const second = activated.provider.steer(activeRun, {
      input: { type: "text", text: "second" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["backend.synchronize", "provider.steer.1"]);

    releaseFirstSteer?.();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "backend.synchronize",
      "provider.steer.1",
      "backend.synchronize",
      "provider.steer.2",
    ]);
    await activated.deactivate();
  });

  it("re-resolves the Context before a Run but not during steer", async () => {
    const events: string[] = [];
    const ref = metaRef();
    const resolver = {
      resolve: vi
        .fn<McpContextResolver["resolve"]>()
        .mockResolvedValue(mcpResolution()),
    };
    const sourceRun = { ...emptyRun(), cancel: vi.fn() };
    const provider: AgentProvider = {
      async createSession() {
        events.push("provider.createSession");
        return { threadId: "thread-local" };
      },
      async resumeSession() {
        throw new Error("unexpected resume");
      },
      async startRun() {
        events.push("provider.startRun");
        return sourceRun;
      },
      async steer(receivedRun) {
        expect(receivedRun).toBe(sourceRun);
        events.push("provider.steer");
        return { turnId: "turn-2" };
      },
      async close() {
        events.push("provider.close");
      },
    };
    let synchronizeAttempt = 0;
    const synchronize = vi.fn(async () => {
      synchronizeAttempt += 1;
      events.push("backend.synchronize");
      if (synchronizeAttempt === 1) {
        throw new Error("transient Context synchronization failure");
      }
    });
    const checkpointRuntimeSession = vi.fn();
    const logger = silentLogger();
    const activator = createContextRuntimeActivator({
      features: testFeatures(),
      viewSessions: createContextViewSessions(),
      contextHost: {
        async prepareRuntimeView() {
          events.push("view.prepare");
          return viewPlan(ref);
        },
        async releaseRuntimeView() {},
      },
      resolveBackend() {
        return {
          async activate(request) {
            expect(request.runtime).toMatchObject({ type: "local" });
            return {
              provider,
              runtimeName: "codex",
              sessionSpec: {
                workingDirectory: "/workspace",
                threadName: "Test Agent",
                model: "codex-default",
                sandboxMode: "workspace-write",
                resources: { mcpServers: [] },
              },
              setActiveRunContext() {},
              synchronize,
              async deactivate() {
                await provider.close();
              },
            };
          },
        };
      },
      mcpContextResolver: resolver,
      logger,
    });

    const active = await activator.activate({
      ref,
      tenantId: "tenant-test",
      actorId: "actor-test",
      mode: "start",
      agent: { name: "Test Agent", instructions: "base" },
      runtime: {
        type: "local",
        model: "codex-default",
        placement: {
          type: "local",
          tenantId: "tenant-test",
          ownerActorId: "actor-test",
          computerId: "computer-1",
          runtimeType: "codex",
          workspaceGrantId: "workspace-1",
        },
      },
      resources: ghostResources(),
      checkpointRuntimeSession,
    });
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ ref }),
    );
    expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(synchronize).not.toHaveBeenCalled();

    active.setActiveRunContext({
      runId: "run-1",
      sourceInboxIds: ["room:room-1"],
    });
    events.length = 0;
    const failedStart = active.provider.startRun(
      active.runtimeSession,
      { type: "text", text: "first attempt" },
      {
        runContext: {
          executionRunRef: "run-1",
          sourceInboxIds: ["room:room-1"],
        },
      },
    );
    await expect(failedStart).rejects.toMatchObject({
      effect: "definitely_not_started",
      message: "transient Context synchronization failure",
      name: "ProviderRunStartError",
    } satisfies Partial<ProviderRunStartError>);
    expect(events).toEqual(["backend.synchronize"]);

    events.length = 0;
    const run = await active.provider.startRun(
      active.runtimeSession,
      { type: "text", text: "start" },
      {
        runContext: {
          executionRunRef: "run-1",
          sourceInboxIds: ["room:room-1"],
        },
      },
    );

    expect(events).toEqual(["backend.synchronize", "provider.startRun"]);
    expect(resolver.resolve).toHaveBeenCalledTimes(3);
    expect(checkpointRuntimeSession).not.toHaveBeenCalled();

    events.length = 0;
    await active.provider.steer(run, {
      input: { type: "text", text: "continue" },
      runContext: {
        executionRunRef: "run-1",
        sourceInboxIds: ["room:room-1"],
      },
    });
    expect(events).toEqual(["backend.synchronize", "provider.steer"]);
    expect(resolver.resolve).toHaveBeenCalledTimes(3);

    active.setActiveRunContext(null);
    await active.deactivate();
  });
});

describe("Skills of Contexts resolved by TeamHub", () => {
  const effectiveSkill = Object.freeze({
    skillId: "skill-1",
    manifestId: "skill_manifest_1",
    manifestVersion: "1.0.0",
    name: "Test Skill",
    packageName: "test-skill",
    packageSha256: "0".repeat(64),
    config: Object.freeze({}),
    source: "explicit" as const,
  });
  const sessionContexts: ReadonlyArray<{
    readonly name: string;
    readonly ref: ExecutionContextRef;
  }> = [
    {
      name: "Task",
      ref: { kind: "alter_ego", agentId: "agent-1", taskId: "task-1" },
    },
    {
      name: "Document",
      ref: { kind: "document", agentId: "agent-1", documentId: "document-1" },
    },
  ];
  const sessionHarness = (input: {
    readonly ref: ExecutionContextRef;
    readonly resolveResources: AgentResourcesResolver["resolve"];
    readonly resolveMcpContext: McpContextResolver["resolve"];
  }) => {
    const requests: ContextRuntimeBackendRequest<{ type: string }>[] = [];
    const provider = fakeProvider([]);
    return {
      requests,
      activator: createContextRuntimeActivator<{ type: string }>({
        features: testFeatures(),
        viewSessions: createContextViewSessions(),
        contextHost: {
          prepareRuntimeView: async () => viewPlan(input.ref),
          async releaseRuntimeView() {},
        },
        resolveBackend: () => ({
          async activate(request) {
            requests.push(request);
            return fakeBackendActivation(provider);
          },
        }),
        agentResourcesResolver: { resolve: input.resolveResources },
        mcpContextResolver: { resolve: input.resolveMcpContext },
        logger: silentLogger(),
      }),
    };
  };

  it.each(sessionContexts)(
    "reads the $name Skills while TeamHub resolves the Context",
    async ({ ref }) => {
      const resources = deferred<AgentEffectiveResources>();
      const resolution = deferred<McpContextResolution>();
      const resolveResources = vi.fn(() => resources.promise);
      const resolveMcpContext = vi.fn(() => resolution.promise);
      const harness = sessionHarness({
        ref,
        resolveResources,
        resolveMcpContext,
      });
      const activation = harness.activator.activate({
        ref,
        tenantId: "tenant-test",
        actorId: "actor-test",
        mode: "start",
        agent: { name: "Test Agent", instructions: "base" },
        runtime: { type: "local" },
        resources: ghostResources(),
        checkpointRuntimeSession: vi.fn(),
      });
      await vi.waitFor(() => {
        expect(resolveResources).toHaveBeenCalledOnce();
        expect(resolveMcpContext).toHaveBeenCalledOnce();
      });
      resources.resolve({
        effectiveSha256: "a".repeat(64),
        skills: [effectiveSkill],
        connectedApps: true,
      });
      resolution.resolve(mcpResolution());
      const active = await activation;
      try {
        expect(harness.requests[0]!.resources.skills).toEqual([effectiveSkill]);
        expect(active.executionResources).toEqual({
          version: 1,
          effectiveSha256: "a".repeat(64),
          skills: [effectiveSkill],
        });
        // Skills stay fixed for the activation; only ordinary Meta rechecks them.
        expect(active.prepareNextRun).toBeUndefined();
      } finally {
        await active.deactivate();
      }
    },
  );
});

const eventingViewSessions = (events: string[]): ContextViewSessions => {
  const sessions = createContextViewSessions();
  return {
    open(signal) {
      const session = sessions.open(signal);
      return {
        healthSignal: session.healthSignal,
        release() {
          events.push("view-session.release");
          session.release();
        },
      };
    },
    close: () => sessions.close(),
  };
};

const fakeProvider = (
  events: string[],
  overrides: Partial<AgentProvider> = {},
): AgentProvider => ({
  async createSession() {
    events.push("provider.createSession");
    return { threadId: "thread-default" };
  },
  async resumeSession() {
    events.push("provider.resumeSession");
    return { threadId: "thread-default" };
  },
  async startRun() {
    return emptyRun();
  },
  async steer() {
    return { turnId: "turn-1" };
  },
  async close() {
    events.push("provider.close");
  },
  ...overrides,
});

const mcpResolution = (): McpContextResolution => Object.freeze({});

const emptyRun = (): AgentRun => ({
  events: {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true, value: undefined }),
    }),
  },
  async wait() {
    return { finalResponse: "" };
  },
  cancel() {},
});

const metaRef = () => ({
  kind: "meta" as const,
  agentId: "agent-1",
  roomId: "room-1",
});

const viewPlan = (ref: ExecutionContextRef): RuntimeViewPlan => ({
  ref,
  contextKey: encodeExecutionContextRef(ref),
  mappings: [],
});

const ghostResources = (): GhostResources => ({
  skills: [],
  mcpServers: [
    {
      mcpId: "mcp-a",
      manifestVersion: "1.0.0",
      name: "MCP A",
      transport: "streamable_http",
      url: "https://mcp.example.test/api",
      allowedTools: ["search", "read"],
    },
  ],
});

const silentLogger = (): AgentLogger => {
  const logger: AgentLogger = {
    log: vi.fn(),
    child: () => logger,
  };
  return logger;
};

/** The real builtin assembly bound to test services. */
const testFeatures = (
  services: Omit<BuiltinFeatureServices, "logger"> = {},
): Pick<BuiltinAgentFeatures, "composeActivation" | "composeRun"> =>
  createBuiltinAgentFeatures({
    services: {
      logger: silentLogger(),
      ...(services.resolveUserMemory
        ? { userMemories: createUserMemoryTracker() }
        : {}),
      ...services,
    },
  });

/**
 * Test assembly over the real compose machinery for declarations the builtin
 * services cannot express (e.g. a failing activation release). Mirrors the
 * builtin run binding: the Task input port binds only THIS backend's
 * capability and contributes nothing when it is absent.
 */
const declarationFeatures = (
  declarations: readonly FeatureDeclaration[],
): Pick<BuiltinAgentFeatures, "composeActivation" | "composeRun"> => ({
  composeActivation: ({ view, logger }) =>
    composeActivationFeatures({ view, features: declarations, logger }),
  composeRun: ({ view, backend, logger }) =>
    composeRunFeatures({
      view,
      features: backend.prepareRunInput
        ? [
            ...declarations,
            createTaskInputFeature({
              prepareRunInput: backend.prepareRunInput.bind(backend),
            }),
          ]
        : [...declarations],
      logger,
    }),
});

const fakeBackendActivation = (
  provider: AgentProvider,
  overrides: Partial<ContextRuntimeBackendActivation> = {},
): ContextRuntimeBackendActivation => ({
  provider,
  runtimeName: "fake-runtime",
  sessionSpec: {
    workingDirectory: "/runtime/workspace",
    threadName: "Test Agent",
    sandboxMode: "workspace-write",
    resources: { mcpServers: [] },
  },
  setActiveRunContext() {},
  async synchronize() {},
  async deactivate() {},
  ...overrides,
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

interface CapturedLogEntry {
  readonly event: string;
  readonly fields: AgentLogFields;
  readonly level: string;
}

const capturingLogger = (
  entries: CapturedLogEntry[],
  context: AgentLogFields = {},
): AgentLogger => ({
  child(additionalContext) {
    return capturingLogger(entries, { ...context, ...additionalContext });
  },
  log(level, event, fields = {}) {
    entries.push({ event, fields: { ...fields, ...context }, level });
  },
});
