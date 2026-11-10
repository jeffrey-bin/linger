import {
  RunnerOperationInputError,
  type RunnerSessionCompactOptions,
  type RunnerSessionCompactOutcome,
  type RunnerSessionCompactTarget,
} from "../../../src/agent/runner-gateway/runner-operation.js";
import { codexAgentInstructions } from "../../../src/agent/codex-agent-instructions.js";
import { describe, expect, it, vi } from "vitest";

import type {
  ProviderSessionOptions,
  RunEvent,
} from "../../../src/agent/executor/provider.js";
import {
  RuntimeExecutionError,
  STREAMING_AGENT_RUN_MAX_RESPONSE_BYTES,
  ProviderRunCleanupError,
  ProviderRunInterruptedError,
  ProviderRunStartError,
} from "../../../src/agent/executor/provider.js";
import type {
  OperationResult,
  RuntimeOperationRequest,
  RunEvent as WireRunEvent,
} from "@linger/wire-contracts/runner-gateway/types";

import { RemoteCodexProvider } from "../../../src/agent/runner-gateway/remote-codex-provider.js";
import { RunnerOperationError } from "../../../src/agent/runner-gateway/runner-gateway.js";
import { LocalComputerOfflineError } from "../../../src/agent/runner-gateway/local-computer-management.js";
import type {
  RunnerOperation,
  RunnerOperationInput,
  RunnerOperationDispatcher,
  RunnerOperationTarget,
} from "../../../src/agent/runner-gateway/runner-gateway.js";

const contextScope = {
  executionContextKey: "context-reviewer",
  runtimeInstanceId: "runtime-reviewer",
  contextViewRef: { view_digest: "a".repeat(64) },
};

const contextRunResources = () => ({
  async resolve() {
    return { mcp_servers: [] };
  },
  currentContextViewRef: () => contextScope.contextViewRef,
});

const runSpec = {
  runContext: {
    executionRunRef: "run-1",
    sourceInboxIds: ["room:room-main"],
  },
};

const wirePlanSteps: Extract<WireRunEvent, { type: "plan.updated" }>["steps"] =
  [
    { content: "Inspect", status: "completed" },
    { content: "Implement", status: "in_progress" },
    { content: "Verify", status: "pending" },
    { content: "Discarded option", status: "canceled" },
  ];

describe("RemoteCodexProvider", () => {
  it.each([
    ["the judge's verdict", false, false],
    ["unavailable when the judge fails", true, false],
    ["a logged delivery rejection", false, true],
  ])(
    "answers a permission review with %s without holding the event stream",
    async (_name, fails, deliveryFails) => {
      const base = new ScriptedDispatcher();
      const logger = {
        log: vi.fn(),
        child() {
          return this;
        },
      };
      let currentView = contextScope.contextViewRef;
      let refreshPending = false;
      let finishRefresh!: () => void;
      const refreshing = new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });
      const enteringContextView = vi.fn();
      async function withContextView<T>(deliver: () => Promise<T>): Promise<T> {
        enteringContextView();
        if (refreshPending) await refreshing;
        return deliver();
      }
      const originalStart = base.startOperation.bind(base);
      const dispatcher = {
        startOperation: async (target: RunnerOperationTarget) => {
          const operation = await originalStart(target);
          if (target.request.kind !== "run.start") return operation;
          return {
            ...operation,
            currentContextViewRef: () => contextScope.contextViewRef,
            async input(input: RunnerOperationInput) {
              const result = await operation.input(input);
              if (deliveryFails)
                throw new RunnerOperationInputError(
                  "Context input was rejected",
                  "definitely_not_applied",
                  "rejected",
                );
              return result;
            },
            events: (async function* () {
              let first = true;
              for await (const event of operation.events) {
                yield event;
                if (first) {
                  first = false;
                  yield {
                    type: "human_interaction.requested" as const,
                    request: {
                      request_id: "review-1",
                      kind: "permission_review",
                      action: {
                        runtime: "codex",
                        surface: "shell",
                        tool: "Bash",
                      },
                    },
                  };
                }
              }
            })(),
          };
        },
      };
      let finishReview!: () => void;
      const reviewed = new Promise<void>((resolve) => {
        finishReview = resolve;
      });
      const onPermissionReview = vi.fn(
        async (_input: unknown, _signal: AbortSignal) => {
          await reviewed;
          if (fails) throw new Error("TeamHub unavailable");
          return {
            decision: "needs_approval",
            message: "wait",
            policy_version: "v",
          };
        },
      );
      const provider = new RemoteCodexProvider({
        dispatcher,
        runtime: { type: "codex" },
        target: {
          tenantId: "tenant-acme",
          runnerId: "runner-local",
          ...contextScope,
          agentId: "agent-reviewer",
          workspaceGrantId: "grant-repo",
        },
        onPermissionReview,
        logger,
        contextRunResources: {
          async resolve() {
            return { mcp_servers: [] };
          },
          currentContextViewRef() {
            return currentView;
          },
          withContextView,
        },
      });
      const session = await provider.createSession(sessionOptions());
      const run = await provider.startRun(
        session,
        { type: "text", text: "work" },
        {
          runContext: {
            executionRunRef: "run-1",
            sourceInboxIds: ["room:room-main"],
          },
        },
      );
      // The Run finishes while the review is still pending.
      await run.wait();
      expect(onPermissionReview).toHaveBeenCalledTimes(1);
      expect(onPermissionReview.mock.calls[0]?.[0]).toMatchObject({
        executionRunRef: "run-1",
        operationId: "operation-1",
        request: { request_id: "review-1", kind: "permission_review" },
      });
      expect(base.runInputs).toHaveLength(0);
      const start = base.requests.find(
        ({ request }) => request.kind === "run.start",
      );
      expect(start?.request).toMatchObject({
        run_context: { permission_review: true },
      });
      expect(start?.request).not.toMatchObject({
        run_context: { human_interactions: true },
      });

      // Refresh can finish after the judge: the reply must wait and name its View.
      refreshPending = true;
      enteringContextView.mockClear();
      finishReview();
      await vi.waitFor(() =>
        expect(enteringContextView).toHaveBeenCalledTimes(1),
      );
      expect(base.runInputs).toHaveLength(0);
      currentView = { view_digest: "b".repeat(64) };
      finishRefresh();
      await vi.waitFor(() => expect(base.runInputs).toHaveLength(1));
      expect(base.runInputs[0]?.contextViewRef).toEqual(currentView);
      expect(base.runInputs[0]?.input).toMatchObject({
        runtime_response: {
          request_id: "review-1",
          payload: { decision: fails ? "unavailable" : "needs_approval" },
        },
      });
      if (deliveryFails) {
        await vi.waitFor(() =>
          expect(logger.log).toHaveBeenCalledWith(
            "warn",
            "permission_review.response_failed",
            expect.objectContaining({
              execution_run_ref: "run-1",
              operation_id: "operation-1",
              request_id: "review-1",
              effect: "definitely_not_applied",
              reason: "rejected",
            }),
          ),
        );
      }
      await provider.close();
    },
  );

  it("routes a native question once and responds through the original Operation", async () => {
    const kind = "native_question";
    const base = new ScriptedDispatcher();
    const originalStart = base.startOperation.bind(base);
    const dispatcher = {
      startOperation: async (target: RunnerOperationTarget) => {
        const operation = await originalStart(target);
        if (target.request.kind !== "run.start") return operation;
        return {
          ...operation,
          events: (async function* () {
            let first = true;
            for await (const event of operation.events) {
              yield event;
              if (first) {
                first = false;
                yield {
                  type: "human_interaction.requested" as const,
                  request: {
                    request_id: "request-1",
                    kind,
                    prompt: "Choose",
                    form: {
                      type: "questions",
                      questions: [{ id: "q", prompt: "Choose", input: "text" }],
                    },
                  },
                };
              }
            }
          })(),
        };
      },
    };
    const onHumanInteraction = vi.fn().mockResolvedValue({
      interaction_id: "interaction-1",
      status: "pending",
    });
    const provider = new RemoteCodexProvider({
      dispatcher,
      runtime: { type: "codex" },
      target: {
        tenantId: "tenant-acme",
        runnerId: "runner-local",
        ...contextScope,
        agentId: "agent-reviewer",
        workspaceGrantId: "grant-repo",
      },
      onHumanInteraction,
      contextRunResources: {
        async resolve() {
          return { mcp_servers: [] };
        },
        currentContextViewRef() {
          return { view_digest: "a".repeat(64) };
        },
      },
    });
    const session = await provider.createSession(sessionOptions());
    const run = await provider.startRun(
      session,
      { type: "text", text: "work" },
      {
        runContext: {
          executionRunRef: "run-1",
          sourceInboxIds: ["room:room-main"],
        },
      },
    );
    await run.wait();
    expect(onHumanInteraction).toHaveBeenCalledTimes(1);
    expect(onHumanInteraction.mock.calls[0]?.[0]).toMatchObject({
      executionRunRef: "run-1",
      operationId: "operation-1",
      request: { request_id: "request-1", kind },
    });
    expect(base.runInputs).toHaveLength(0);
    await run.respond!("stale-operation", "request-1", {
      decision: "submit",
      answers: { q: "stale" },
    });
    expect(base.runInputs).toHaveLength(0);
    await run.respond!("operation-1", "request-1", {
      decision: "submit",
      answers: { q: "now" },
    });
    expect(base.runInputs[0]?.input).toMatchObject({
      runtime_response: {
        request_id: "request-1",
        payload: { decision: "submit", answers: { q: "now" } },
      },
    });
    expect(
      base.requests.filter(({ request }) => request.kind === "run.start"),
    ).toHaveLength(1);
    await provider.close();
  });

  it("fails the Run when its native question card is not created", async () => {
    const kind = "native_question";
    const base = new ScriptedDispatcher();
    const originalStart = base.startOperation.bind(base);
    const dispatcher = {
      startOperation: async (target: RunnerOperationTarget) => {
        const operation = await originalStart(target);
        if (target.request.kind !== "run.start") return operation;
        return {
          ...operation,
          events: (async function* () {
            let first = true;
            for await (const event of operation.events) {
              yield event;
              if (first) {
                first = false;
                yield {
                  type: "human_interaction.requested" as const,
                  request: {
                    request_id: "request-1",
                    kind,
                    prompt: "Choose",
                    form: "not an object",
                  },
                };
              }
            }
          })(),
        };
      },
    };
    const onHumanInteraction = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "The question was not posted (TeamHub answered 400 INVALID_REQUEST: Runtime interaction is invalid). Correct the input and ask again.",
        ),
      );
    const provider = new RemoteCodexProvider({
      dispatcher,
      runtime: { type: "codex" },
      target: {
        tenantId: "tenant-acme",
        runnerId: "runner-local",
        ...contextScope,
        agentId: "agent-reviewer",
        workspaceGrantId: "grant-repo",
      },
      onHumanInteraction,
      contextRunResources: {
        async resolve() {
          return { mcp_servers: [] };
        },
        currentContextViewRef() {
          return { view_digest: "a".repeat(64) };
        },
      },
    });
    const session = await provider.createSession(sessionOptions());
    const run = await provider.startRun(
      session,
      { type: "text", text: "work" },
      {
        runContext: {
          executionRunRef: "run-1",
          sourceInboxIds: ["room:room-main"],
        },
      },
    );
    await expect(run.wait()).rejects.toThrow("Agent run failed");
    expect(base.runInputs).toHaveLength(0);
    await provider.close();
  });

  it.each(["create", "restore cold marker"])(
    "defers native session creation to the first run: %s",
    async (mode) => {
      const dispatcher = new ScriptedDispatcher();
      const provider = createProvider(dispatcher);
      const session =
        mode === "create"
          ? await provider.createSession(sessionOptions())
          : await provider.resumeSession({ threadId: "" }, sessionOptions());
      expect(dispatcher.requests).toEqual([]);
      expect(session).toEqual({
        threadId: "",
      });
      const run = await provider.startRun(
        session,
        { type: "text", text: "Legacy task" },
        runSpec,
      );
      const consuming = (async () => {
        for await (const event of run.events) void event;
      })();
      await run.wait();
      await consuming;
      expect(dispatcher.requests.map(({ request }) => request.kind)).toEqual([
        "run.start",
      ]);
      await provider.close();
    },
  );
  it("defers the Codex thread to the first run without a Daemon round trip", async () => {
    const dispatcher = new ScriptedDispatcher({ holdRun: true });
    // Capture the request as sent; the scripted run later rewrites the session.
    const sent: RuntimeOperationRequest[] = [];
    const startOperation = dispatcher.startOperation.bind(dispatcher);
    dispatcher.startOperation = async (target) => {
      sent.push(structuredClone(target.request));
      return startOperation(target);
    };
    const provider = createProvider(dispatcher);
    const session = await provider.createSession(sessionOptions());
    expect(session).toEqual({
      threadId: "",
    });
    expect(dispatcher.requests).toEqual([]);
    await provider.startRun(
      session,
      { type: "text", text: "First task" },
      runSpec,
    );
    expect(dispatcher.requests.map(({ request }) => request.kind)).toEqual([
      "run.start",
    ]);
    expect(sent[0]).toMatchObject({
      kind: "run.start",
      session: { threadId: "" },
    });
    await provider.close();
  });

  it("adopts the run.started thread for a pending Codex session", async () => {
    const dispatcher = new ScriptedDispatcher();
    // Capture the request as sent; the scripted run later rewrites the session.
    const sent: RuntimeOperationRequest[] = [];
    const startOperation = dispatcher.startOperation.bind(dispatcher);
    dispatcher.startOperation = async (target) => {
      sent.push(structuredClone(target.request));
      return startOperation(target);
    };
    const provider = createProvider(dispatcher);
    const session = await provider.createSession(sessionOptions());
    const run = await provider.startRun(
      session,
      { type: "text", text: "First task" },
      runSpec,
    );
    await run.wait();
    expect(session).toMatchObject({ threadId: "thread-resumed" });
    expect(sent[0]).toMatchObject({
      kind: "run.start",
      session: { threadId: "" },
    });
    await provider.close();
  });

  it("returns an empty unavailable history page for a pending Codex session without a Daemon call", async () => {
    const inspectLocalContext = vi.fn();
    const view = { view_digest: "a".repeat(64) };
    const provider = new RemoteCodexProvider({
      dispatcher: { startOperation: vi.fn() },
      runtime: { type: "codex" },
      target: {
        tenantId: "tenant-acme",
        runnerId: "runner-local",
        agentId: "agent-reviewer",
        workspaceGrantId: "grant-repo",
        executionContextKey: "context-main",
        runtimeInstanceId: "runtime-main",
        contextViewRef: view,
      },
      contextRunResources: {
        currentContextViewRef: () => view,
        async resolve() {
          return { mcp_servers: [] };
        },
      },
      debugRunnerRevision: 1,
      debugInspector: { inspectLocalContext },
    });
    const page = await provider.inspectHistory!({ threadId: "" }, {});
    expect(page).toMatchObject({
      status: "unavailable",
      providerKind: "codex",
      records: [],
      instructions: { status: "unavailable", blocks: [] },
    });
    expect(inspectLocalContext).not.toHaveBeenCalled();
    await provider.close();
  });

  it("creates a Claude session UUID without a Daemon round trip and defers it to run.start", async () => {
    const dispatcher = new ScriptedDispatcher();
    const provider = createProvider(dispatcher, "claude");
    const session = await provider.createSession(sessionOptions());
    expect(dispatcher.requests).toEqual([]);
    expect(session).toEqual({
      provider: "claude",
      sessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      lingerMaterialized: false,
    });
    const other = await createProvider(dispatcher, "claude").createSession(
      sessionOptions(),
    );
    expect(other).not.toEqual(session);
    await provider.startRun(
      session,
      { type: "text", text: "First task" },
      runSpec,
    );
    expect(dispatcher.requests.map(({ request }) => request.kind)).toEqual([
      "run.start",
    ]);
    expect(dispatcher.requests[0]?.request).toMatchObject({
      kind: "run.start",
      runtime: { type: "claude" },
      session,
    });
    await provider.close();
  });

  it("defers the Pi session to the first run without a Daemon round trip", async () => {
    const dispatcher = new ScriptedDispatcher();
    const provider = createProvider(dispatcher, "pi");
    const session = await provider.createSession(sessionOptions());
    expect(dispatcher.requests).toEqual([]);
    expect(session).toEqual({
      provider: "pi",
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      lingerMaterialized: false,
    });
    const other = createProvider(dispatcher, "pi");
    const otherSession = await other.createSession(sessionOptions());
    expect(otherSession).not.toEqual(session);
    expect(dispatcher.requests).toEqual([]);
    await Promise.all([provider.close(), other.close()]);
  });

  it("sends the deferred Pi session on the first run.start and reuses its identity after a failed attempt", async () => {
    const options: { runStartError?: Error } = {
      runStartError: new Error("pi run.start failed"),
    };
    const dispatcher = new ScriptedDispatcher(options);
    // Capture the request as sent; the scripted run later rewrites the session.
    const sent: RuntimeOperationRequest[] = [];
    const startOperation = dispatcher.startOperation.bind(dispatcher);
    dispatcher.startOperation = async (target) => {
      sent.push(structuredClone(target.request));
      return startOperation(target);
    };
    const provider = createProvider(dispatcher, "pi");
    const session = await provider.createSession(sessionOptions());
    const input = { type: "text", text: "First task" } as const;
    await expect(provider.startRun(session, input, runSpec)).rejects.toThrow(
      "pi run.start failed",
    );
    options.runStartError = undefined;
    const run = await provider.startRun(session, input, runSpec);
    await run.wait();
    const starts = sent.filter((request) => request.kind === "run.start");
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({
      kind: "run.start",
      runtime: { type: "pi" },
      session: { provider: "pi", lingerMaterialized: false },
    });
    expect(starts[1]).toMatchObject({ session: starts[0]?.session });
    await provider.close();
  });

  it("starts the first Codex run only after the Runner accepts it", async () => {
    const provider = createProvider({
      async startOperation(target) {
        expect(target.request).toMatchObject({
          kind: "run.start",
          session: { threadId: "" },
        });
        return {
          operationId: "run",
          events: iterate([
            {
              type: "run.started",
              turn_id: "turn-1",
              session: { threadId: "thread-started" },
            },
            { type: "run.completed" },
          ]),
          result: Promise.resolve({
            type: "run",
            status: "succeeded",
            final_response: "",
            session: { threadId: "thread-started" },
          }),
          input: async () => ({ turnId: "turn-1" }),
          cancel: async () => {},
        };
      },
    });
    const session = await provider.createSession(sessionOptions());
    const run = await provider.startRun(
      session,
      { type: "text", text: "First task" },
      runSpec,
    );
    await run.wait();
    expect(session).toMatchObject({ threadId: "thread-started" });
    await provider.close();
  });

  it.each([
    { dispatchedAt: 1_700_000_000_100, observedAt: 1_700_000_000_200 },
    { dispatchedAt: undefined, observedAt: undefined },
  ])(
    "forwards Computer-reported provider times only when present ($dispatchedAt)",
    async ({ dispatchedAt, observedAt }) => {
      const provider = createProvider({
        async startOperation() {
          return {
            operationId: "run",
            events: iterate([
              {
                type: "run.started",
                turn_id: "turn-1",
                session: { threadId: "thread-started" },
                ...(dispatchedAt === undefined
                  ? {}
                  : { dispatched_at_unix_ms: dispatchedAt }),
              },
              {
                type: "message.delta",
                message_id: "message-1",
                delta: "hi",
                ...(observedAt === undefined
                  ? {}
                  : { observed_at_unix_ms: observedAt }),
              },
              {
                type: "tool.called",
                call_id: "call-1",
                tool_name: "exec",
                input: {},
                ...(observedAt === undefined
                  ? {}
                  : { observed_at_unix_ms: observedAt }),
              },
              {
                type: "tool.returned",
                call_id: "call-1",
                tool_name: "exec",
                output: "ok",
                is_error: false,
                ...(observedAt === undefined
                  ? {}
                  : { observed_at_unix_ms: observedAt }),
              },
              {
                type: "model.responded",
                started_at_unix_ms: 10,
                responded_at_unix_ms: 30,
                ...(observedAt === undefined
                  ? {}
                  : { first_item_at_unix_ms: 20 }),
                granularity: "block",
                message_id: "msg-1",
                usage: { input: 1, cache_read: 2, cache_write: 3, output: 4 },
                agent: { id: "sub-1", parent_call_id: "call-1" },
              },
              { type: "run.completed" },
            ]),
            result: Promise.resolve({
              type: "run",
              status: "succeeded",
              final_response: "hi",
              session: { threadId: "thread-started" },
            }),
            input: async () => ({ turnId: "turn-1" }),
            cancel: async () => {},
          };
        },
      });
      const session = await provider.createSession(sessionOptions());
      const run = await provider.startRun(
        session,
        { type: "text", text: "First task" },
        runSpec,
      );
      expect(run.dispatchedAtUnixMs).toBe(dispatchedAt);
      const outputs = [];
      const responses = [];
      for await (const event of run.events) {
        if (
          event.type === "message.delta" ||
          event.type === "tool.called" ||
          event.type === "tool.returned"
        )
          outputs.push(event);
        if (event.type === "model.responded") responses.push(event);
      }
      await run.wait();
      expect(outputs.map((event) => event.observedAtUnixMs)).toEqual([
        observedAt,
        observedAt,
        observedAt,
      ]);
      expect(responses).toEqual([
        {
          type: "model.responded",
          startedAtUnixMs: 10,
          respondedAtUnixMs: 30,
          ...(observedAt === undefined ? {} : { firstItemAtUnixMs: 20 }),
          granularity: "block",
          messageId: "msg-1",
          usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
          agent: { id: "sub-1", parentCallId: "call-1" },
        },
      ]);
      expect(outputs.every((event) => "observedAtUnixMs" in event)).toBe(
        observedAt !== undefined,
      );
      await provider.close();
    },
  );

  it("defers a missing existing session to its Run and never silently creates a replacement", async () => {
    const requests: string[] = [];
    const failure = new RuntimeExecutionError({
      code: "session_not_found",
      runtime_type: "codex",
    });
    const provider = createProvider({
      async startOperation(target) {
        requests.push(target.request.kind);
        return {
          operationId: "failed-restore",
          events: iterate([]),
          result: Promise.reject(failure),
          input: async () => ({ turnId: "unused" }),
          cancel: async () => {},
        };
      },
    });
    const session = await provider.resumeSession(
      {
        ...JSON.parse(
          JSON.stringify(await provider.createSession(sessionOptions())),
        ),
        threadId: "existing-native-thread",
      },
      sessionOptions(),
    );
    expect(requests).toEqual([]);
    await expect(
      provider.startRun(session, { type: "text", text: "Continue" }, runSpec),
    ).rejects.toBe(failure);
    expect(requests).toEqual(["run.start"]);
    expect(session).toEqual({
      threadId: "existing-native-thread",
    });
    await provider.close();
  });

  it("retains the native thread when current instructions change across checkpoints", async () => {
    const dispatcher = new ScriptedDispatcher();
    const provider = createProvider(dispatcher);
    const options = sessionOptions();
    const session = await provider.createSession(options);
    const run = await provider.startRun(
      session,
      { type: "text", text: "First task" },
      runSpec,
    );
    await run.wait();
    const retained = JSON.parse(JSON.stringify(session));
    const restored = createProvider(dispatcher);
    expect(await restored.resumeSession(retained, options)).toEqual(retained);
    const changed = {
      ...options,
      baseInstructions: "Always respond in Chinese.",
    };
    const dispatchedBeforeResume = dispatcher.requests.length;
    const replacement = await restored.resumeSession(retained, changed);
    // The session carries no instruction state; run.start sends the current ones.
    expect(replacement).toEqual(retained);
    expect(dispatcher.requests).toHaveLength(dispatchedBeforeResume);
    const nextRun = await restored.startRun(
      replacement,
      { type: "text", text: "Continue" },
      runSpec,
    );
    await nextRun.wait();
    const lastRequest = dispatcher.requests.at(-1)?.request;
    expect(lastRequest).toMatchObject({
      kind: "run.start",
      session: expect.objectContaining({ threadId: retained.threadId }),
      session_options: {
        base_instructions: expect.stringContaining(
          "Always respond in Chinese.",
        ),
      },
    });
    expect(
      await restored.resumeSession(
        JSON.parse(JSON.stringify(replacement)),
        changed,
      ),
    ).toEqual(replacement);
    await Promise.all([provider.close(), restored.close()]);
  });

  it("stamps current instructions on legacy checkpoints without a digest and dispatches nothing", async () => {
    const dispatcher = new ScriptedDispatcher();
    const provider = createProvider(dispatcher);
    const session = await provider.resumeSession(
      { threadId: "legacy-thread" },
      sessionOptions(),
    );
    expect(session).toMatchObject({
      threadId: "legacy-thread",
    });
    expect(dispatcher.requests).toEqual([]);
    await provider.close();
  });

  it.each([{}, { threadId: 123 }])(
    "rejects invalid retained identity without creating a thread: %j",
    async (session) => {
      const dispatcher = new ScriptedDispatcher();
      const provider = createProvider(dispatcher);
      await expect(
        provider.resumeSession(session, sessionOptions()),
      ).rejects.toThrow("session identity is invalid");
      expect(dispatcher.requests).toEqual([]);
      await provider.close();
    },
  );

  it("surfaces a rejected run.start for an instruction-only change as the Local Run failure", async () => {
    const dispatcher = new ScriptedDispatcher();
    const provider = createProvider(dispatcher);
    const options = sessionOptions();
    const session = await provider.createSession(options);
    const run = await provider.startRun(
      session,
      { type: "text", text: "First task" },
      runSpec,
    );
    await run.wait();
    const retained = JSON.parse(JSON.stringify(session));
    const restored = createProvider(
      new ScriptedDispatcher({
        runStartError: new Error("native strict resume failed"),
      }),
    );
    const replacement = await restored.resumeSession(retained, {
      ...options,
      baseInstructions: "Always respond in Chinese.",
    });
    await expect(
      restored.startRun(
        replacement,
        { type: "text", text: "Continue" },
        runSpec,
      ),
    ).rejects.toThrow("native strict resume failed");
    await Promise.all([provider.close(), restored.close()]);
  });

  it.each(["claude", "pi"] as const)(
    "activates a %s session without a session.resume and resumes it in run.start",
    async (runtimeType) => {
      const dispatcher = new ScriptedDispatcher();
      // Capture the request as sent; the scripted run later rewrites the session.
      const sent: RuntimeOperationRequest[] = [];
      const startOperation = dispatcher.startOperation.bind(dispatcher);
      dispatcher.startOperation = async (target) => {
        sent.push(structuredClone(target.request));
        return startOperation(target);
      };
      const provider = createProvider(dispatcher, runtimeType);
      const retained = {
        provider: runtimeType,
        sessionId: "native-session-retained",
        lingerMaterialized: true,
      };
      const changed = sessionOptions();
      changed.baseInstructions = "Always respond in Chinese.";

      const session = await provider.resumeSession(
        JSON.parse(JSON.stringify(retained)),
        changed,
      );
      expect(session).toEqual(retained);
      expect(dispatcher.requests).toEqual([]);

      const run = await provider.startRun(
        session,
        { type: "text", text: "Continue" },
        runSpec,
      );
      await run.wait();
      expect(sent.map((request) => request.kind)).toEqual(["run.start"]);
      expect(sent[0]).toMatchObject({
        kind: "run.start",
        runtime: { type: runtimeType },
        session: retained,
        session_options: {
          base_instructions: expect.stringContaining(
            "Always respond in Chinese.",
          ),
        },
      });
      await provider.close();
    },
  );

  it.each(
    ["claude", "pi"].flatMap((runtimeType) =>
      [{}, { sessionId: "" }, { sessionId: 123 }].map((session) => ({
        runtimeType,
        session,
      })),
    ),
  )(
    "rejects invalid $runtimeType retained identity without dispatching: $session",
    async ({ runtimeType, session }) => {
      const dispatcher = new ScriptedDispatcher();
      const provider = createProvider(
        dispatcher,
        runtimeType as "claude" | "pi",
      );
      await expect(
        provider.resumeSession(session, sessionOptions()),
      ).rejects.toThrow("Retained native session identity is invalid");
      expect(dispatcher.requests).toEqual([]);
      await provider.close();
    },
  );

  it("maps the complete AgentProvider lifecycle onto semantic Runner operations", async () => {
    const dispatcher = new ScriptedDispatcher();
    const provider = createProvider(dispatcher);
    const options = sessionOptions();

    const created = await provider.createSession(options);
    expect(created).toEqual({
      threadId: "",
    });
    expect(dispatcher.requests).toEqual([]);
    const resumed = await provider.resumeSession(
      { ...JSON.parse(JSON.stringify(created)), threadId: "thread-existing" },
      options,
    );
    expect(resumed).toEqual({
      threadId: "thread-existing",
    });
    expect(dispatcher.requests).toEqual([]);

    const run = await provider.startRun(
      resumed,
      {
        type: "text",
        text: "Review this Room",
      },
      runSpec,
    );
    expect(run.steerTarget).toEqual({ turnId: "turn-1" });
    await expect(
      provider.steer(run, {
        input: { type: "text", text: "Also inspect the tests" },
      }),
    ).resolves.toEqual({ turnId: "turn-1" });
    const [events, result] = await Promise.all([
      collect(run.events),
      run.wait(),
    ]);
    expect(events).toEqual<RunEvent[]>([
      { type: "run.started" },
      { type: "status.changed", status: "working" },
      {
        type: "plan.updated",
        explanation: "Follow the critical path",
        steps: wirePlanSteps,
      },
      {
        type: "status.changed",
        status: "thinking",
        title: "Inspecting runtime status",
      },
      { type: "status.changed", status: "working" },
      {
        type: "activity.started",
        activityId: "activity-7",
        content: [
          {
            content: '{"channel":"room"}',
            format: "json",
            label: "Input",
          },
        ],
        kind: "tool",
        title: "Using Send message",
      },
      {
        type: "activity.updated",
        activityId: "activity-7",
        detail: "Publishing the reply",
      },
      {
        type: "activity.finished",
        activityId: "activity-7",
        content: [{ content: "Message sent", format: "text", label: "Result" }],
        outcome: "succeeded",
      },
      { type: "message.delta", messageId: "message-1", delta: "Done" },
      { type: "run.completed" },
    ]);
    const planEvent = events.find((event) => event.type === "plan.updated");
    expect(planEvent?.steps).not.toBe(wirePlanSteps);
    expect(planEvent?.steps[0]).not.toBe(wirePlanSteps[0]);
    expect(result).toEqual({ finalResponse: "Done" });
    expect(resumed).toEqual({
      threadId: "thread-resumed",
      last_turn_id: "turn-1",
    });

    await provider.close();
    expect(dispatcher.requests.map(({ request }) => request.kind)).toEqual([
      "run.start",
    ]);
    expect(dispatcher.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId: "tenant-acme",
          runnerId: "runner-local",
          ...contextScope,
          agentId: "agent-reviewer",
          workspaceGrantId: "grant-repo",
        }),
      ]),
    );
    expect(dispatcher.requests[0]?.request).toMatchObject({
      kind: "run.start",
      session_options: {
        thread_name: "Reviewer",

        base_instructions: codexAgentInstructions({
          baseInstructions: "Review Room messages.",
          developerInstructions: "Be concise.",
        }).baseInstructions,
      },
    });
    expect(dispatcher.runInputs).toEqual([
      {
        expectedTurnId: "turn-1",
        input: { type: "text", text: "Also inspect the tests" },
        contextViewRef: contextScope.contextViewRef,
      },
    ]);
  });

  it("cancels active Runner operations", async () => {
    const dispatcher = new ScriptedDispatcher({ holdRun: true });
    const provider = createProvider(dispatcher);
    const options = sessionOptions();
    const session = await provider.createSession(options);
    const run = await provider.startRun(
      session,
      {
        type: "text",
        text: "Long task",
      },
      runSpec,
    );

    run.cancel();
    await vi.waitFor(() =>
      expect(dispatcher.cancelReasons).toEqual(["cancelled"]),
    );
    await provider.close();
  });

  it("starts a Context Turn from an opaque view receipt without leaking host paths", async () => {
    const dispatcher = new ScriptedDispatcher();
    const resolvedContexts: unknown[] = [];
    let currentContextViewRef = { view_digest: "b".repeat(64) };
    const provider = new RemoteCodexProvider({
      dispatcher,
      target: {
        tenantId: "tenant-acme",
        runnerId: "runner-local",
        executionContextKey: "meta:agent-reviewer",
        runtimeInstanceId: "meta:agent-reviewer",
        contextViewRef: { view_digest: "b".repeat(64) },
        agentId: "agent-reviewer",
        workspaceGrantId: "grant-repo",
      },
      runtime: { type: "codex", model: "gpt-local" },
      contextRunResources: {
        currentContextViewRef() {
          return currentContextViewRef;
        },
        async resolve(context) {
          resolvedContexts.push(context);
          return { mcp_servers: [] };
        },
      },
    });
    const session = await provider.createSession({
      ...sessionOptions(),
      resources: {
        mcpServers: [
          {
            name: "tools",
            url: "http://agent.internal/mcp",
            toolNames: ["upload_artifacts"],
          },
        ],
      },
    });
    const runContext = {
      executionRunRef: "local-run-1",
      sourceInboxIds: ["room:room-main"],
    } as const;

    const run = await provider.startRun(
      session,
      {
        type: "text",
        text: "Review this Context",
        cliRunContext: {
          run_id: "local-run-1",
          scope: { kind: "room", id: "room-main" },
        },
      },
      { runContext },
    );
    currentContextViewRef = { view_digest: "d".repeat(64) };
    await provider.steer(run, {
      input: { type: "text", text: "Read the changed Inbox" },
    });
    await run.wait();

    expect(resolvedContexts).toEqual([runContext]);
    const request = dispatcher.requests.at(-1)?.request;
    expect(request).toEqual({
      kind: "run.start",
      runtime: { type: "codex", model: "gpt-local" },
      session_options: {
        thread_name: "Reviewer",

        base_instructions: codexAgentInstructions({
          baseInstructions: "Review Room messages.",
          developerInstructions: "Be concise.",
        }).baseInstructions,
      },
      session: {
        threadId: "thread-resumed",
        last_turn_id: "turn-1",
      },
      input: { type: "text", text: "Review this Context" },
      run_context: {
        execution_run_ref: "local-run-1",
        source_inbox_ids: ["room:room-main"],
      },
      cli_run_context: {
        run_id: "local-run-1",
        scope: { kind: "room", id: "room-main" },
      },
      run_resources: { mcp_servers: [] },
    });
    expect(JSON.stringify(request)).not.toContain("/must/not/cross");
    expect(dispatcher.runInputs).toEqual([
      {
        expectedTurnId: "turn-1",
        input: { type: "text", text: "Read the changed Inbox" },
        contextViewRef: currentContextViewRef,
      },
    ]);
  });

  it("does not report provider close success when Runner cancellation fails", async () => {
    const dispatcher = new ScriptedDispatcher({
      holdRun: true,
      cancelError: new Error("Runner cancellation timed out"),
    });
    const provider = createProvider(dispatcher);
    const session = await provider.createSession(sessionOptions());
    await provider.startRun(
      session,
      { type: "text", text: "Long task" },
      runSpec,
    );

    await expect(provider.close()).rejects.toThrow(
      "Remote Runtime provider failed to stop every active operation",
    );
    expect(dispatcher.cancelReasons).toEqual(["provider closed"]);
  });

  it("cancels the Runner when bounded stream consumption aborts", async () => {
    const dispatcher = new ScriptedDispatcher({
      holdRun: true,
      oversizedRun: true,
    });
    const provider = createProvider(dispatcher);
    const session = await provider.createSession(sessionOptions());
    const run = await provider.startRun(
      session,
      {
        type: "text",
        text: "Generate an oversized response",
      },
      runSpec,
    );

    await expect(run.wait()).rejects.toThrow(
      "Agent run response byte limit exceeded",
    );
    await vi.waitFor(() =>
      expect(dispatcher.cancelReasons).toEqual(["run stream aborted"]),
    );
  });

  it("translates an externally cancelled Runner operation into a Provider interruption", async () => {
    const dispatcher = new ScriptedDispatcher({
      runError: new RunnerOperationError(
        "cancelled",
        "Runner process stopped",
        false,
      ),
    });
    const provider = createProvider(dispatcher);
    const session = await provider.createSession(sessionOptions());
    const run = await provider.startRun(
      session,
      { type: "text", text: "Long task" },
      runSpec,
    );

    await expect(run.wait()).rejects.toBeInstanceOf(
      ProviderRunInterruptedError,
    );
  });

  it("cancels an admitted Operation while waiting for its first Provider event", async () => {
    const never = new Promise<never>(() => {});
    const cancel = vi.fn(async () => {});
    const startOperation = vi.fn(async (): Promise<RunnerOperation> => {
      return {
        operationId: "waiting-start",
        result: never,
        events: { [Symbol.asyncIterator]: () => ({ next: () => never }) },
        input: async () => ({ turnId: "unused" }),
        cancel,
      };
    });
    const provider = createProvider({ startOperation });
    const session = await provider.createSession(sessionOptions());
    const controller = new AbortController();
    const starting = provider.startRun(
      session,
      { type: "text", text: "Run" },
      { ...runSpec, signal: controller.signal },
    );
    const rejected = expect(starting).rejects.toBeInstanceOf(
      ProviderRunInterruptedError,
    );
    await vi.waitFor(() => expect(startOperation).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    await provider.close();
  });

  it("proceeds without a reservation when the Computer is offline so the Run fails visibly", async () => {
    const offline = new LocalComputerOfflineError("Local Computer is offline");
    const acquireOperationCapacity = vi.fn<
      NonNullable<RunnerOperationDispatcher["acquireOperationCapacity"]>
    >(async () => {
      throw offline;
    });
    const startOperation = vi.fn(async () => {
      throw offline;
    });
    const provider = createProvider({
      acquireOperationCapacity,
      startOperation,
    });
    const session = await provider.createSession(sessionOptions());
    expect(session).toEqual({
      threadId: "",
    });
    expect(acquireOperationCapacity).not.toHaveBeenCalled();
    await expect(
      provider.startRun(session, { type: "text", text: "Run" }, runSpec),
    ).rejects.toBe(offline);
    expect(acquireOperationCapacity).toHaveBeenCalledOnce();
    acquireOperationCapacity.mockResolvedValueOnce({
      id: "permit-offline",
      release() {},
    });
    const release = await provider.acquireRunCapacity(
      new AbortController().signal,
    );
    release();
    const canceled = new AbortController();
    canceled.abort(new Error("stop waiting"));
    acquireOperationCapacity.mockRejectedValueOnce(canceled.signal.reason);
    await expect(provider.acquireRunCapacity(canceled.signal)).rejects.toThrow(
      "stop waiting",
    );
    await provider.close();
  });

  it("retries atomic capacity rejection without consuming a Shell startup attempt", async () => {
    const options: { runStartError?: Error } = {
      runStartError: new RunnerOperationError(
        "OPERATION_CAPACITY_BUSY",
        "busy before admission",
        true,
      ),
    };
    const dispatcher = new ScriptedDispatcher(options);
    const provider = createProvider(dispatcher);
    const session = await provider.createSession(sessionOptions());
    const started = provider.startRun(
      session,
      { type: "text", text: "Run once" },
      runSpec,
    );
    await vi.waitFor(() =>
      expect(
        dispatcher.requests.some((item) => item.request.kind === "run.start"),
      ).toBe(true),
    );
    options.runStartError = undefined;
    const run = await started;
    await expect(run.wait()).resolves.toBeDefined();
    expect(
      dispatcher.requests.filter((item) => item.request.kind === "run.start")
        .length,
    ).toBeGreaterThan(1);
    await provider.close();
  });

  it.each(["RUNNER_STOPPED", "RUNTIME_NOT_ENABLED"])(
    "reports a %s start refusal as an unavailable Computer",
    async (code) => {
      const dispatcher = new ScriptedDispatcher({
        runStartError: new RunnerOperationError(code, "refused", false),
      });
      const provider = createProvider(dispatcher);
      const session = await provider.createSession(sessionOptions());
      await expect(
        provider.startRun(session, { type: "text", text: "Run once" }, runSpec),
      ).rejects.toMatchObject({
        name: "RuntimeExecutionError",
        failure: { code: "computer_unavailable", runtime_type: "codex" },
      });
    },
  );

  it("allows the bounded Shell retry only for a proven non-admission", async () => {
    const dispatcher = new ScriptedDispatcher({
      runStartError: new RunnerOperationError(
        "EXECUTION_NOT_ADMITTED",
        "Cloud replaced before Local execution admission",
        true,
      ),
    });
    const provider = createProvider(dispatcher);
    const session = await provider.createSession(sessionOptions());
    await expect(
      provider.startRun(session, { type: "text", text: "Run once" }, runSpec),
    ).rejects.toMatchObject({
      name: "ProviderRunStartError",
      effect: "definitely_not_started",
    });
    expect(
      dispatcher.requests.filter(({ request }) => request.kind === "run.start"),
    ).toHaveLength(1);
  });

  it.each([
    ["CONTEXT_VIEW_FAILED", true, true],
    ["CONTEXT_VIEW_FAILED", false, false],
    ["SKILL_PACKAGE_UNAVAILABLE", false, false],
  ] as const)(
    "maps a %s View admission failure (retryable=%s) to a retryable start: %s",
    async (code, retryable, retried) => {
      const dispatcher = new ScriptedDispatcher({
        runStartError: new RunnerOperationError(
          code,
          "a source file changed after the View snapshot",
          retryable,
        ),
      });
      const provider = createProvider(dispatcher);
      const session = await provider.createSession(sessionOptions());
      const started = provider.startRun(
        session,
        { type: "text", text: "Run once" },
        runSpec,
      );
      if (retried) {
        await expect(started).rejects.toMatchObject({
          name: "ProviderRunStartError",
          effect: "definitely_not_started",
        });
      } else {
        await expect(started).rejects.toBeInstanceOf(RunnerOperationError);
      }
    },
  );

  it.each([true, false])(
    "does not retry an admitted restart even when retryable=%s",
    async (retryable) => {
      const dispatcher = new ScriptedDispatcher({
        runStartError: new RunnerOperationError(
          "DAEMON_RESTARTED",
          "Native outcome is unknown",
          retryable,
        ),
      });
      const provider = createProvider(dispatcher);
      const session = await provider.createSession(sessionOptions());
      await expect(
        provider.startRun(session, { type: "text", text: "Run once" }, runSpec),
      ).rejects.toBeInstanceOf(ProviderRunInterruptedError);
      expect(
        dispatcher.requests.filter(
          ({ request }) => request.kind === "run.start",
        ),
      ).toHaveLength(1);
    },
  );

  it("never maps a post-start failure into a retryable Provider start", async () => {
    const dispatcher = new ScriptedDispatcher({
      runError: new RunnerOperationError(
        "DAEMON_RESTARTED",
        "Contradictory retryable restart receipt",
        true,
      ),
    });
    const provider = createProvider(dispatcher);
    const session = await provider.createSession(sessionOptions());
    const run = await provider.startRun(
      session,
      { type: "text", text: "Run once" },
      runSpec,
    );
    await expect(run.wait()).rejects.not.toBeInstanceOf(ProviderRunStartError);
    await expect(run.wait()).rejects.toBeInstanceOf(
      ProviderRunInterruptedError,
    );
    expect(
      dispatcher.requests.filter(({ request }) => request.kind === "run.start"),
    ).toHaveLength(1);
  });

  it("preserves unconfirmed cleanup instead of reporting an interruption", async () => {
    const dispatcher = new ScriptedDispatcher({
      runError: new RunnerOperationError(
        "RUNTIME_CLEANUP_UNCONFIRMED",
        "Provider cancellation cleanup is unconfirmed",
        false,
      ),
    });
    const provider = createProvider(dispatcher);
    const session = await provider.createSession(sessionOptions());
    const run = await provider.startRun(
      session,
      { type: "text", text: "Run once" },
      runSpec,
    );
    run.cancel();
    await expect(run.wait()).rejects.toBeInstanceOf(ProviderRunCleanupError);
    expect(
      dispatcher.requests.filter(({ request }) => request.kind === "run.start"),
    ).toHaveLength(1);
  });
});

describe("RemoteCodexProvider session compaction", () => {
  const signal = () => new AbortController().signal;

  it.each([
    [
      { outcome: "compacted", pre_tokens: 90_000 },
      { status: "compacted", preTokens: 90_000 },
    ],
    [{ outcome: "nothing_to_compact" }, { status: "nothing_to_compact" }],
    [
      { outcome: "no_process", reason: "no_process" },
      { status: "unavailable" },
    ],
  ] as const)("maps the Daemon outcome %j", async (outcome, expected) => {
    const dispatcher = new CompactingDispatcher();
    dispatcher.outcome = outcome;
    const provider = createProvider(dispatcher, "claude");
    const session = {
      provider: "claude",
      sessionId: "session-1",
      lingerMaterialized: true,
    };
    await expect(
      provider.compactSession!(session, {
        instructions: "Keep task ids",
        signal: signal(),
      }),
    ).resolves.toEqual(expected);
    expect(dispatcher.compactions).toEqual([
      {
        target: {
          runnerId: "runner-local",
          agentId: "agent-reviewer",
          executionContextKey: contextScope.executionContextKey,
        },
        options: {
          runtimeType: "claude",
          instructions: "Keep task ids",
          signal: expect.any(AbortSignal),
        },
      },
    ]);
    // Identity and value are unchanged: there is nothing to checkpoint.
    expect(session).toEqual({
      provider: "claude",
      sessionId: "session-1",
      lingerMaterialized: true,
    });
  });

  it("surfaces a canceled compaction as an interruption and a failure with its reason", async () => {
    const dispatcher = new CompactingDispatcher();
    const provider = createProvider(dispatcher);
    const session = { threadId: "thread-1" };
    dispatcher.outcome = { outcome: "canceled" };
    await expect(
      provider.compactSession!(session, { signal: signal() }),
    ).rejects.toBeInstanceOf(ProviderRunInterruptedError);
    dispatcher.outcome = { outcome: "failed", reason: "model refused" };
    await expect(
      provider.compactSession!(session, { signal: signal() }),
    ).rejects.toThrow("model refused");
  });

  it("has nothing to compact before the first Run creates the native session", async () => {
    const dispatcher = new CompactingDispatcher();
    await expect(
      createProvider(dispatcher).compactSession!(
        { threadId: "" },
        { signal: signal() },
      ),
    ).resolves.toEqual({ status: "nothing_to_compact" });
    await expect(
      createProvider(dispatcher, "claude").compactSession!(
        { provider: "claude", sessionId: "s", lingerMaterialized: false },
        { signal: signal() },
      ),
    ).resolves.toEqual({ status: "nothing_to_compact" });
    expect(dispatcher.compactions).toEqual([]);
  });

  it("stops waiting when the provider closes", async () => {
    const dispatcher = new CompactingDispatcher();
    dispatcher.hold = true;
    const provider = createProvider(dispatcher);
    const compacting = provider.compactSession!(
      { threadId: "thread-1" },
      { signal: signal() },
    );
    await vi.waitFor(() => expect(dispatcher.compactions).toHaveLength(1));
    await provider.close();
    await expect(compacting).rejects.toThrow();
    await expect(
      provider.compactSession!({ threadId: "thread-1" }, { signal: signal() }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(dispatcher.compactions).toHaveLength(1);
  });

  it("offers compaction only for Codex and Claude on a Gateway that supports it", () => {
    expect(
      createProvider(new CompactingDispatcher(), "pi").compactSession,
    ).toBe(undefined);
    expect(createProvider(new ScriptedDispatcher()).compactSession).toBe(
      undefined,
    );
  });
});

const createProvider = (
  dispatcher: RunnerOperationDispatcher,
  runtimeType: "codex" | "claude" | "pi" = "codex",
) =>
  new RemoteCodexProvider({
    dispatcher,
    target: {
      tenantId: "tenant-acme",
      runnerId: "runner-local",
      ...contextScope,
      agentId: "agent-reviewer",
      workspaceGrantId: "grant-repo",
    },
    runtime: { type: runtimeType, model: "gpt-local" },
    contextRunResources: contextRunResources(),
  });

const sessionOptions = (): ProviderSessionOptions => ({
  workingDirectory: "/must/not/cross/the/gateway",
  threadName: "Reviewer",
  model: "ignored-in-favor-of-runtime-placement",
  sandboxMode: "workspace-write",
  baseInstructions: "Review Room messages.",
  developerInstructions: "Be concise.",
  resources: { mcpServers: [] },
});

class ScriptedDispatcher implements RunnerOperationDispatcher {
  readonly requests: RunnerOperationTarget[] = [];
  readonly runInputs: RunnerOperationInput[] = [];
  readonly cancelReasons: string[] = [];

  constructor(
    private readonly options: {
      holdRun?: boolean;
      cancelError?: Error;
      oversizedRun?: boolean;
      runError?: Error;
      runStartError?: Error;
    } = {},
  ) {}

  async startOperation(
    target: RunnerOperationTarget,
  ): Promise<RunnerOperation> {
    this.requests.push(target);
    const script =
      target.request.kind === "run.start" && this.options.runStartError
        ? { events: [], result: Promise.reject(this.options.runStartError) }
        : operationScript(
            target.request,
            this.options.holdRun === true,
            this.options.oversizedRun === true,
            this.options.runError,
          );
    return {
      operationId: `operation-${this.requests.length}`,
      events: iterate(script.events),
      result: script.result,
      input: async (input) => {
        this.runInputs.push(input);
        return { turnId: input.expectedTurnId };
      },
      cancel: async (reason) => {
        this.cancelReasons.push(reason);
        if (this.options.cancelError) {
          throw this.options.cancelError;
        }
      },
    };
  }
}

class CompactingDispatcher extends ScriptedDispatcher {
  readonly compactions: Array<{
    target: RunnerSessionCompactTarget;
    options: RunnerSessionCompactOptions;
  }> = [];
  outcome: RunnerSessionCompactOutcome = { outcome: "compacted" };
  hold = false;

  async compactParkedSession(
    target: RunnerSessionCompactTarget,
    options: RunnerSessionCompactOptions,
  ): Promise<RunnerSessionCompactOutcome> {
    this.compactions.push({ target, options });
    if (!this.hold) return this.outcome;
    return new Promise((_, reject) =>
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      ),
    );
  }
}

const operationScript = (
  request: RuntimeOperationRequest,
  holdRun: boolean,
  oversizedRun: boolean,
  runError?: Error,
): { events: readonly WireRunEvent[]; result: Promise<OperationResult> } => {
  switch (request.kind) {
    case "run.start":
      return {
        events: [
          {
            type: "run.started",
            turn_id: "turn-1",
            session: { threadId: "thread-resumed" },
          },
          { type: "status.changed", status: "working" },
          {
            type: "plan.updated",
            explanation: "Follow the critical path",
            steps: wirePlanSteps,
          },
          {
            type: "status.changed",
            status: "thinking",
            title: "Inspecting runtime status",
          },
          { type: "status.changed", status: "working" },
          {
            type: "activity.started",
            activity_id: "activity-7",
            content: [
              {
                content: '{"channel":"room"}',
                format: "json",
                label: "Input",
              },
            ],
            kind: "tool",
            title: "Using Send message",
          },
          {
            type: "activity.updated",
            activity_id: "activity-7",
            detail: "Publishing the reply",
          },
          {
            type: "activity.finished",
            activity_id: "activity-7",
            content: [
              { content: "Message sent", format: "text", label: "Result" },
            ],
            outcome: "succeeded",
          },
          {
            type: "message.delta",
            message_id: "message-1",
            delta: oversizedRun
              ? "x".repeat(STREAMING_AGENT_RUN_MAX_RESPONSE_BYTES + 1)
              : "Done",
          },
          { type: "run.completed" },
        ],
        result: runError
          ? Promise.reject(runError)
          : holdRun
            ? new Promise<OperationResult>(() => undefined)
            : Promise.resolve({
                type: "run",
                final_response: "Done",
                session: {
                  threadId: "thread-resumed",
                  last_turn_id: "turn-1",
                },
              }),
      };
  }
};

const iterate = async function* <T>(values: readonly T[]): AsyncIterable<T> {
  yield* values;
};

const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
};
