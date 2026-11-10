import {
  RuntimeExecutionError,
  type AgentInput,
  type AgentProvider,
  type AgentRun,
  type ExecutionSpec,
  type ProviderSessionOptions,
  type ProviderSteerOptions,
  type RunEvent,
  type RunResult,
  type RuntimeSession,
  ProviderRunAdmissionUnavailableError,
  ProviderRunCleanupError,
  ProviderRunInterruptedError,
  ProviderRunStartError,
  StreamingAgentRunLimitError,
} from "../../../src/agent/executor/provider.js";
import { describe, expect, it, vi } from "vitest";
import { createAgentManagerHttpServer } from "../../../src/agent/executor/http/agent-manager-http-server.js";
import {
  createTeamHubContextRuntimeState,
  type ContextRuntimeStatePort,
} from "../../../src/agent/executor/context-runtime-state.js";
import {
  TeamHubRuntimeStateError,
  type RuntimeContext,
} from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import { createTeamHubRuntimeStateClientFake } from "../test-support/teamhub-runtime-state-client.js";
import {
  encodeExecutionContextRef,
  type ExecutionContextRef,
} from "../../../src/agent/executor/context-ref.js";
import {
  createAgentLogger,
  isSensitiveField,
} from "../../../src/agent/observability/agent-log.js";
import { RunnerOperationError } from "../../../src/agent/runner-gateway/runner-gateway.js";
import { RunnerOperationInputError } from "../../../src/agent/runner-gateway/runner-operation.js";
import type {
  RuntimeStatusPublisher,
  RuntimeStatusSession,
  RuntimeStatusUpdate,
} from "../../../src/agent/executor/runtime-status.js";
import {
  defineFeature,
  type FeatureDeclaration,
} from "../../../src/agent/agent-features/contracts.js";
import type { ReplyRhythmSettings } from "../../../src/agent/agent-features/reply-rhythm/types.js";
import { renderAcceptedNotification } from "../../../src/agent/prompt/accepted-notification.js";
import { RunLoop } from "../../../src/agent/executor/run-loop.js";
import type {
  ToolRunContext,
  Message,
} from "../../../src/agent/executor/types.js";
import type { ExecutorFeaturePorts } from "../test-support/standalone-executor.js";
import { TestContextRuntimeState as ContextRuntimeState } from "../test-support/context-runtime-state.js";
import { createTestFeatureAssembly } from "../test-support/executor-features.js";

// Native Promise timers do not follow Vitest's global fake clock.
vi.mock("node:timers/promises", async (importOriginal) => {
  const timers = await importOriginal<typeof import("node:timers/promises")>();
  const { fakeTimerDelay } =
    await import("../test-support/fake-timer-delay.js");
  return {
    ...timers,
    setTimeout: fakeTimerDelay,
  };
});

describe("RunLoop", () => {
  it.each([
    { continuesContext: false, materialized: false, expected: false },
    { continuesContext: true, materialized: false, expected: true },
    { continuesContext: true, materialized: true, expected: false },
  ])(
    "recovers only an existing Context's new session: %j",
    async ({ continuesContext, materialized, expected }) => {
      const harness = createHarness(undefined, undefined, undefined, {
        provider: "pi",
        sessionId: "pi-session",
        lingerMaterialized: materialized,
      });
      const claim = harness.state.claimLocalRun.bind(harness.state);
      vi.spyOn(harness.state, "claimLocalRun").mockImplementation(() => {
        const run = claim();
        return run ? { ...run, continuesContext } : null;
      });
      const run = new FakeRun();
      harness.provider.runs.push(run);
      enqueue(harness.state, message("new-question", "room:room-1"));
      harness.execution.start();
      await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
      const input = harness.provider.starts[0]!.input;
      expect(input.type).toBe("text");
      if (input.type === "text") {
        expect(input.text.includes("new native session")).toBe(expected);
        if (expected) {
          expect(input.text).toContain("teamhub message read without a target");
          expect(input.text).toContain("teamhub message read --thread <id>");
          expect(input.text).toContain("task:, meta: and taskmeta:");
          expect(input.text).toContain("--inbox <exact-inbox-id>");
          expect(input.text).not.toContain("--room");
          expect(input.text).toContain("latest relevant human decision");
          expect(input.text).toContain("room:room-1");
          expect(input.text).toContain("Do not replay");
        }
      }
      run.complete("done");
      await harness.execution.drain({ cancelActive: false });
      harness.state.close();
    },
  );

  it("delivers a native reply that races Provider readiness without starting another Run", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    const respond = vi.fn(async () => undefined);
    Object.assign(run, { respond });
    harness.provider.startGate = deferred<AgentRun>();
    const runId = enqueue(harness.state, message("native-question"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const response = {
      operation_id: "operation-1",
      execution_run_ref: runId,
      request_id: "request-1",
      interaction_id: "interaction-1",
      payload: { decision: "deny" },
    };
    await harness.execution.respondToHumanInteraction({
      ...response,
      execution_run_ref: "stale-run",
    });
    const delivering = harness.execution.respondToHumanInteraction(response);
    expect(respond).not.toHaveBeenCalled();
    harness.provider.startGate.resolve(run);
    await delivering;
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      "operation-1",
      "request-1",
      { decision: "deny" },
    );
    expect(harness.provider.starts).toHaveLength(1);
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("does not consume a native reply when its active Provider lost the response capability", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("native-question"));
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    await expect(
      harness.execution.respondToHumanInteraction({
        operation_id: "operation-1",
        execution_run_ref: runId,
        request_id: "request-1",
        interaction_id: "interaction-1",
        payload: { decision: "deny" },
      }),
    ).rejects.toThrow("cannot receive its native interaction response");
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("leaves the Run unclaimed when resource preparation requests a runtime replacement", async () => {
    const harness = createHarness();
    const runId = enqueue(harness.state, message("new-config"));
    const prepareNextRun = vi.fn(async () => false);
    const execution = new RunLoop({
      logger: createAgentLogger({ component: "resource-boundary-test" }),
      provider: harness.provider,
      runtimeSession: { threadId: "thread-1" },
      state: harness.state,
      prepareNextRun,
      ...harness.executionPorts,
    });
    execution.start();
    await vi.waitFor(() => expect(prepareNextRun).toHaveBeenCalledOnce());
    expect(harness.state.getLocalRun(runId)?.status).toBe("queued");
    expect(harness.provider.starts).toHaveLength(0);
    await execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("waits for the execution's resource checkpoint before starting the Provider", async () => {
    const harness = createHarness();
    const runId = enqueue(harness.state, message("resource-checkpoint"));
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const checkpoint = deferred<void>();
    const beforeStartRun = vi.fn(async () => checkpoint.promise);
    const execution = new RunLoop({
      logger: createAgentLogger({ component: "resource-boundary-test" }),
      provider: harness.provider,
      runtimeSession: { threadId: "thread-1" },
      state: harness.state,
      beforeStartRun,
      ...harness.executionPorts,
    });
    execution.start();
    await vi.waitFor(() => expect(beforeStartRun).toHaveBeenCalledWith(runId));
    expect(harness.provider.starts).toHaveLength(0);
    checkpoint.resolve();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    run.complete("done");
    await execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("does not start a Provider for a canceled atomic claim", async () => {
    const harness = createHarness();
    const runId = enqueue(harness.state, message("already-canceled-claim"));
    const claim = harness.state.claimLocalRun.bind(harness.state);
    vi.spyOn(harness.state, "claimLocalRun").mockImplementation(() => {
      const claimed = claim();
      harness.state.cancelLocalRun(runId);
      return claimed ? { ...claimed, cancellationRequested: true } : null;
    });
    harness.execution.start();
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.status).toBe("canceled"),
    );
    expect(harness.provider.starts).toHaveLength(0);
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("keeps a cancellation that wins after the durable claim but before its response", async () => {
    const harness = createHarness();
    const runId = enqueue(harness.state, message("cancel-paused-claim"));
    const claim = harness.state.claimLocalRun.bind(harness.state);
    const claimedSignal = deferred<void>();
    const resumeClaim = deferred<void>();
    Object.assign(harness.state, {
      claimLocalRun: async () => {
        const claimed = claim();
        claimedSignal.resolve();
        await resumeClaim.promise;
        return claimed ? { ...claimed, cancellationRequested: false } : null;
      },
    });
    harness.execution.start();
    await claimedSignal.promise;
    await expect(harness.execution.requestCancellation(runId)).resolves.toBe(
      "cancel_requested",
    );
    resumeClaim.resolve();
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.status).toBe("canceled"),
    );
    expect(harness.provider.starts).toHaveLength(0);
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it.each(["claude", "codex"] as const)(
    "persists the classified cloud outcome for %s without replay",
    async (runtime_type) => {
      const harness = createHarness();
      const run = new FakeRun();
      harness.provider.runs.push(run);
      const failure = {
        code: "execution_outcome_unknown",
        runtime_type,
      } as const;
      const runId = enqueue(
        harness.state,
        message("synthetic command already dispatched"),
      );
      const finish = vi.spyOn(harness.state, "finishLocalRun");
      try {
        harness.execution.start();
        await vi.waitFor(() => expect(run.waitCalls).toBe(1));
        run.fail(
          new RuntimeExecutionError(failure, {
            cause: new Error("private transport cause"),
          }),
        );
        await vi.waitFor(() =>
          expect(harness.state.getLocalRun(runId)).toMatchObject({
            status: "failed",
            attemptCount: 1,
            terminal: { type: "failed", failure },
          }),
        );
        expect(finish).toHaveBeenCalledWith(
          runId,
          expect.objectContaining({ failure }),
          { threadId: "thread-1" },
          expect.any(AbortSignal),
        );
        expect(harness.provider.starts).toHaveLength(1);
        expect(harness.state.hasQueuedRuns()).toBe(false);
        expect(
          JSON.stringify(harness.state.getLocalRun(runId)?.terminal),
        ).not.toContain("private transport cause");
      } finally {
        await harness.execution.drain({ cancelActive: true });
        harness.state.close();
      }
    },
  );

  describe("Room reply delivery", () => {
    const messageWrite = (
      id: string,
      outcome: "succeeded" | "failed",
    ): RunEvent[] => [
      {
        type: "activity.started",
        activityId: id,
        kind: "message",
        title: "bash",
      },
      { type: "activity.finished", activityId: id, outcome },
    ];
    const failedRead: RunEvent[] = [
      {
        type: "activity.started",
        activityId: "read-1",
        kind: "message_read",
        title: "bash",
      },
      { type: "activity.finished", activityId: "read-1", outcome: "failed" },
    ];
    const finishRun = async (
      events: readonly RunEvent[],
      executionContextRef?: ExecutionContextRef,
    ) => {
      const harness = createHarness(
        undefined,
        undefined,
        undefined,
        undefined,
        executionContextRef,
      );
      const run = new FakeRun(events);
      harness.provider.runs.push(run);
      const runId = enqueue(harness.state, message("introduce yourself"));
      try {
        harness.execution.start();
        await vi.waitFor(() => expect(run.waitCalls).toBe(1));
        run.complete("I could not deliver the reply: TeamHub returned 404.");
        await vi.waitFor(() =>
          expect(harness.state.getLocalRun(runId)?.status).not.toBe("running"),
        );
        return {
          log: harness.log,
          run: harness.state.getLocalRun(runId),
        };
      } finally {
        await harness.execution.drain({ cancelActive: true });
        harness.state.close();
      }
    };

    it("fails a Room Run whose every message write failed as reply_undelivered", async () => {
      const { log, run } = await finishRun([
        ...messageWrite("send-1", "failed"),
        ...failedRead,
        ...messageWrite("send-2", "failed"),
      ]);

      expect(run).toMatchObject({
        status: "failed",
        terminal: {
          type: "failed",
          failure: { code: "reply_undelivered", runtime_type: "pi" },
        },
      });
      expect(JSON.stringify(run?.terminal)).not.toContain("404");
      expect(log).toHaveBeenCalledWith(
        "warn",
        "local_run.teamhub_messages_failed",
        expect.objectContaining({
          runId: run?.runId,
          failedMessageWrites: 2,
          deliveredMessageWrites: 0,
          failedMessageReads: 1,
          replyUndelivered: true,
        }),
      );
    });

    it("keeps a Room Run succeeded when a later message write was delivered", async () => {
      const { log, run } = await finishRun([
        ...messageWrite("send-1", "failed"),
        ...messageWrite("send-2", "succeeded"),
      ]);

      expect(run).toMatchObject({
        status: "succeeded",
        terminal: { type: "succeeded" },
      });
      expect(log).toHaveBeenCalledWith(
        "warn",
        "local_run.teamhub_messages_failed",
        expect.objectContaining({
          failedMessageWrites: 1,
          deliveredMessageWrites: 1,
          replyUndelivered: false,
        }),
      );
    });

    it("keeps a Room Run succeeded when the Agent chose not to reply", async () => {
      const { log, run } = await finishRun(failedRead);

      expect(run?.terminal).toMatchObject({ type: "succeeded" });
      expect(log).toHaveBeenCalledWith(
        "warn",
        "local_run.teamhub_messages_failed",
        expect.objectContaining({
          failedMessageWrites: 0,
          failedMessageReads: 1,
          replyUndelivered: false,
        }),
      );
    });

    it("leaves a Task Run, which reports through its final response, succeeded", async () => {
      const { run } = await finishRun(messageWrite("send-1", "failed"), {
        kind: "alter_ego",
        agentId: "agent-1",
        taskId: "task-1",
      });

      expect(run?.terminal).toMatchObject({
        type: "succeeded",
        finalResponse: "I could not deliver the reply: TeamHub returned 404.",
      });
    });
  });

  it("keeps a wake received before fresh-state startup", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const refreshWorkState = vi.fn(async () => undefined);
    Object.assign(harness.state, { refreshWorkState });
    const runId = enqueue(harness.state, message("wake-before-start"));

    harness.execution.notifyWorkAvailable();
    harness.execution.start({ workStateAlreadyFresh: true });
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));

    expect(refreshWorkState).toHaveBeenCalledOnce();
    run.complete("done");
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded"),
    );
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("claims a committed enqueue without reading work state again", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const refreshWorkState = vi.fn(async () => undefined);
    Object.assign(harness.state, { refreshWorkState });
    harness.execution.start({ workStateAlreadyFresh: true });
    const runId = enqueue(harness.state, message("committed-enqueue"));

    // The acceptance result already recorded the queued Run in Runtime State.
    harness.execution.notifyWorkAvailable({ workStateAlreadyFresh: true });
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));

    expect(refreshWorkState).not.toHaveBeenCalled();
    run.complete("done");
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded"),
    );
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("logs Local Run start with an explicit wall-clock timestamp", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("observable-run-start"));

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));

    expect(harness.log).toHaveBeenCalledWith(
      "info",
      "local_run.started",
      expect.objectContaining({
        runId,
        startedAtUnixMs: expect.any(Number),
      }),
    );
    const timing = harness.log.mock.calls.find(
      (call) => call[1] === "local_run.preparation_timing",
    )?.[2];
    expect(timing).toMatchObject({
      runId,
      claimMs: expect.any(Number),
      prepareMessagesMs: expect.any(Number),
    });
    for (const value of Object.values(timing ?? {}))
      if (typeof value === "number") expect(value).toBeGreaterThanOrEqual(0);

    run.complete("done");
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded"),
    );
    expect(harness.log).toHaveBeenCalledWith(
      "info",
      "local_run.completed",
      expect.objectContaining({
        runId,
        finishedAtUnixMs: expect.any(Number),
      }),
    );
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("distinguishes provider completion, status drain and durable terminal without logging input", async () => {
    const statusGate = deferred<void>();
    const offered = vi.fn(async () => statusGate.promise);
    const publisher: RuntimeStatusPublisher = {
      open: async () => ({ publish: offered }),
      close: async () => undefined,
    };
    const harness = createHarness(undefined, undefined, publisher);
    const run = new FakeRun([
      { type: "status.changed", status: "thinking" },
      { type: "message.delta", messageId: "native-message", delta: "" },
      {
        type: "tool.called",
        callId: "tool-1",
        toolName: "Bash",
        input: "private arguments",
      },
      {
        type: "message.delta",
        messageId: "native-message",
        delta: "private output",
      },
    ]);
    harness.provider.startGate = deferred<AgentRun>();
    const terminalGate = deferred<void>();
    const finish = harness.state.finishLocalRun.bind(harness.state);
    Object.assign(harness.state, {
      finishLocalRun: async (...args: Parameters<typeof finish>) => {
        await terminalGate.promise;
        return finish(...args);
      },
    });
    const value = message("measured-run");
    const privateText = "Corps privé🙂";
    const runId = enqueue(harness.state, {
      ...value,
      rawMessage: privateText,
      segments: [{ type: "text", content: privateText }],
    });
    const eventFields = (event: string) =>
      harness.log.mock.calls.find((call) => call[1] === event)?.[2];

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const input = harness.provider.starts[0]!.input;
    expect(eventFields("local_run.started")).toMatchObject({
      runId,
      executionAttemptCount: 1,
      currentInputUtf8Bytes: Buffer.byteLength(input.text, "utf8"),
      initialMessageCount: 1,
    });
    expect(eventFields("local_run.provider_ready")).toBeUndefined();
    harness.provider.startGate.resolve(run);
    await vi.waitFor(() => expect(offered).toHaveBeenCalled());
    expect(eventFields("local_run.provider_ready")).toMatchObject({
      runId,
      providerStartDurationMs: expect.any(Number),
      preparationDurationMs: expect.any(Number),
    });

    expect(eventFields("local_run.first_output")).toEqual({
      runId,
      eventType: "tool.called",
      observedAtUnixMs: expect.any(Number),
    });
    expect(
      harness.log.mock.calls.filter(
        (call) => call[1] === "local_run.first_output",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(harness.log.mock.calls)).not.toContain(
      "private arguments",
    );
    expect(JSON.stringify(harness.log.mock.calls)).not.toContain(
      "private output",
    );
    run.complete("private result");
    await vi.waitFor(() =>
      expect(eventFields("local_run.provider_completed")).toMatchObject({
        runId,
        providerDurationMs: expect.any(Number),
        observedAtUnixMs: expect.any(Number),
      }),
    );
    // Finishing closes TeamHub's status window, so the queued tail goes first.
    expect(eventFields("local_run.finish_started")).toBeUndefined();
    statusGate.resolve();
    await vi.waitFor(() =>
      expect(eventFields("local_run.finish_started")).toEqual({
        runId,
        resultCode: "succeeded",
        observedAtUnixMs: expect.any(Number),
      }),
    );
    expect(harness.state.getLocalRun(runId)?.status).toBe("running");
    expect(eventFields("local_run.terminal_persisted")).toBeUndefined();
    terminalGate.resolve();
    await vi.waitFor(() =>
      expect(eventFields("local_run.terminal_persisted")).toMatchObject({
        runId,
        resultCode: "succeeded",
        providerCompletionToTerminalMs: expect.any(Number),
      }),
    );
    expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded");
    await harness.execution.drain({ cancelActive: false });
    expect(eventFields("local_run.completed")).toMatchObject({
      runId,
      runtimeStatusDrainMs: expect.any(Number),
    });
    expect(JSON.stringify(harness.log.mock.calls)).not.toContain(privateText);
    expect(JSON.stringify(harness.log.mock.calls)).not.toContain(
      "private result",
    );
    harness.state.close();
  });

  it("logs every model request and tool call on the Run's timeline", async () => {
    const harness = createHarness();
    const usage = { input: 9, cacheRead: 4, cacheWrite: 0, output: 2 };
    const run = new FakeRun([
      {
        type: "model.responded",
        startedAtUnixMs: 1_000,
        firstItemAtUnixMs: 1_400,
        respondedAtUnixMs: 3_000,
        granularity: "item",
        model: "main-model",
        usage,
      },
      {
        type: "tool.called",
        callId: "spawn",
        toolName: "Task",
        input: "private arguments",
        observedAtUnixMs: 2_900,
      },
      {
        type: "model.responded",
        startedAtUnixMs: 3_100,
        respondedAtUnixMs: 9_000,
        granularity: "item",
        usage: { ...usage, reasoning: 1 },
        agent: { id: "sub-1", parentCallId: "spawn" },
      },
      {
        type: "tool.returned",
        callId: "spawn",
        toolName: "Task",
        output: "private output",
        isError: false,
        observedAtUnixMs: 9_100,
      },
      {
        type: "model.responded",
        startedAtUnixMs: 9_100,
        firstItemAtUnixMs: 9_900,
        respondedAtUnixMs: 11_000,
        granularity: "item",
        model: "main-model",
        usage,
      },
    ]);
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("timeline-run"));
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    const logged = (event: string) =>
      harness.log.mock.calls
        .filter((call) => call[1] === event)
        .map((call) => call[2]);
    await vi.waitFor(() =>
      expect(logged("agent.model_request")).toHaveLength(3),
    );
    expect(logged("agent.model_request")).toEqual([
      {
        run_id: runId,
        execution_attempt_count: 1,
        agent: "main",
        sequence: 1,
        model: "main-model",
        granularity: "item",
        started_at_unix_ms: 1_000,
        first_item_at_unix_ms: 1_400,
        first_item_ms: 400,
        responded_at_unix_ms: 3_000,
        duration_ms: 2_000,
        usage_input: 9,
        usage_cache_read: 4,
        usage_cache_write: 0,
        usage_output: 2,
      },
      expect.objectContaining({
        run_id: runId,
        agent: "sub-1",
        parent_call_id: "spawn",
        sequence: 1,
        duration_ms: 5_900,
        usage_reasoning: 1,
      }),
      expect.objectContaining({
        run_id: runId,
        agent: "main",
        sequence: 2,
        first_item_ms: 800,
        duration_ms: 1_900,
      }),
    ]);
    expect(logged("agent.tool_call")).toEqual([
      {
        run_id: runId,
        execution_attempt_count: 1,
        call_id: "spawn",
        tool_name: "Task",
        is_error: false,
        called_at_unix_ms: 2_900,
        returned_at_unix_ms: 9_100,
        duration_ms: 6_200,
      },
    ]);
    expect(JSON.stringify(harness.log.mock.calls)).not.toContain("private");
    // The production logger redacts fields named like secrets or tokens.
    for (const fields of [
      ...logged("agent.model_request"),
      ...logged("agent.tool_call"),
    ])
      for (const key of Object.keys(fields ?? {}))
        expect(isSensitiveField(key)).toBe(false);
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("does not report successful provider or terminal boundaries for a failed Run", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("failed-measurement"));
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    run.fail(new Error("provider failed"));
    await harness.execution.drain({ cancelActive: false });
    expect(harness.state.getLocalRun(runId)?.status).toBe("failed");
    const events = harness.log.mock.calls.map((call) => call[1]);
    expect(events).toContain("local_run.provider_ready");
    expect(events).not.toContain("local_run.provider_completed");
    expect(harness.log).toHaveBeenCalledWith(
      "info",
      "local_run.terminal_persisted",
      {
        runId,
        executionAttemptCount: 1,
        resultCode: "failed",
        observedAtUnixMs: expect.any(Number),
      },
    );
    expect(events).not.toContain("local_run.first_output");
    expect(events).not.toContain("local_run.completed");
    harness.state.close();
  });

  it("restarts after a transient work-state failure without new input", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const refreshWorkState = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new TeamHubRuntimeStateError(null, "temporary TeamHub timeout"),
      )
      .mockResolvedValue(undefined);
    Object.assign(harness.state, { refreshWorkState });
    const runId = enqueue(harness.state, message("retry-work-state"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      harness.execution.start();

      await vi.waitFor(() =>
        expect(harness.log).toHaveBeenCalledWith(
          "warn",
          "local_run.loop_retry_scheduled",
          expect.objectContaining({ attempt: 1, delayMs: 1_000 }),
        ),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
      run.complete("recovered");
      await vi.waitFor(() =>
        expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded"),
      );
      await expect(
        harness.execution.drain({ cancelActive: false }),
      ).resolves.toBeUndefined();
      expect(harness.log).toHaveBeenCalledWith(
        "warn",
        "local_run.loop_retry_scheduled",
        expect.objectContaining({ attempt: 1 }),
      );
    } finally {
      await harness.execution.drain({ cancelActive: true });
      harness.state.close();
      vi.useRealTimers();
    }
  });

  it("surfaces a permanent claim conflict without retrying", async () => {
    const harness = createHarness();
    enqueue(harness.state, message("claim-conflict"));
    const conflict = new TeamHubRuntimeStateError(
      409,
      "Agent Service epoch was replaced",
      "CONTEXT_FENCED",
      false,
    );
    const claim = vi
      .spyOn(harness.state, "claimLocalRun")
      .mockRejectedValue(conflict);

    harness.execution.start();
    await vi.waitFor(() =>
      expect(harness.log).toHaveBeenCalledWith(
        "error",
        "local_run.loop_failed",
        { error: conflict },
      ),
    );
    await expect(
      harness.execution.drain({ cancelActive: false }),
    ).resolves.toBeUndefined();
    expect(claim).toHaveBeenCalledOnce();
    harness.state.close();
  });

  it("cancels a pending retry on drain and recovers after restart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const refreshWorkState = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new TeamHubRuntimeStateError(503, "unavailable"))
      .mockResolvedValue(undefined);
    Object.assign(harness.state, { refreshWorkState });
    const runId = enqueue(harness.state, message("restart-after-backoff"));
    try {
      harness.execution.start();
      await settleAsyncWork();
      await harness.execution.drain({ cancelActive: false });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(refreshWorkState).toHaveBeenCalledOnce();
      expect(harness.provider.starts).toHaveLength(0);
      expect(harness.state.getLocalRun(runId)?.status).toBe("queued");

      harness.execution.start();
      await settleAsyncWork();
      run.complete("recovered after restart");
      await harness.execution.drain({ cancelActive: false });
      expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded");
      expect(harness.provider.starts).toHaveLength(1);
    } finally {
      await harness.execution.drain({ cancelActive: true });
      harness.state.close();
      vi.useRealTimers();
    }
  });

  it("clears an old execution error after a later Run completes", async () => {
    const harness = createHarness();
    const first = new FakeRun();
    const second = new FakeRun();
    harness.provider.runs.push(first, second);
    const firstId = enqueue(harness.state, message("lost-finish-ack"));
    const finish = harness.state.finishLocalRun.bind(harness.state);
    vi.spyOn(harness.state, "finishLocalRun").mockImplementationOnce(
      (...args) => {
        finish(...args);
        throw new Error("terminal acknowledgement lost");
      },
    );
    harness.execution.start();
    await vi.waitFor(() => expect(first.waitCalls).toBe(1));
    first.complete("first completed");
    await expect(
      harness.execution.drain({ cancelActive: false }),
    ).rejects.toThrow("terminal persistence failed");
    expect(harness.state.getLocalRun(firstId)?.status).toBe("succeeded");

    const secondId = enqueue(harness.state, message("fresh-input"));
    harness.execution.start();
    await vi.waitFor(() => expect(second.waitCalls).toBe(1));
    second.complete("second completed");
    await expect(
      harness.execution.drain({ cancelActive: false }),
    ).resolves.toBeUndefined();
    expect(harness.state.getLocalRun(secondId)?.status).toBe("succeeded");
    expect(harness.provider.starts).toHaveLength(2);
    harness.state.close();
  });

  it("keeps capacity waiting Runs queued and cancellation never starts a provider", async () => {
    const harness = createHarness();
    const capacity = deferred<() => void>();
    const release = vi.fn();
    harness.provider.acquireRunCapacity = vi.fn(() => capacity.promise);
    const claim = vi.spyOn(harness.state, "claimLocalRun");
    const queued = enqueue(harness.state, message("waiting", "room:room-1"));
    harness.execution.start();
    await vi.waitFor(() =>
      expect(harness.provider.acquireRunCapacity).toHaveBeenCalledOnce(),
    );
    expect(claim).not.toHaveBeenCalled();
    expect(harness.state.hasQueuedRuns()).toBe(true);
    expect(await harness.execution.requestCancellation(queued)).toBe(
      "canceled",
    );
    capacity.resolve(release);
    await harness.execution.drain({ cancelActive: false });
    expect(harness.provider.starts).toHaveLength(0);
    expect(release).toHaveBeenCalledOnce();
    harness.state.close();
  });

  it("aborts a capacity wait when draining even without cancelActive", async () => {
    const harness = createHarness();
    harness.provider.acquireRunCapacity = vi.fn(
      (signal: AbortSignal) =>
        new Promise<() => void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    enqueue(harness.state, message("waiting", "room:room-1"));
    harness.execution.start();
    await vi.waitFor(() =>
      expect(harness.provider.acquireRunCapacity).toHaveBeenCalledOnce(),
    );
    await harness.execution.drain({ cancelActive: false });
    expect(harness.state.hasQueuedRuns()).toBe(true);
    expect(harness.provider.starts).toHaveLength(0);
    harness.state.close();
  });

  it.each(["room_deleted", "task_terminal"] as const)(
    "settles %s through the TeamHub adapter before draining without an error log",
    async (reason) => {
      const ref: ExecutionContextRef =
        reason === "task_terminal"
          ? { kind: "alter_ego", agentId: "agent-1", taskId: "task-1" }
          : { kind: "meta", agentId: "agent-1", roomId: "room-1" };
      const harness = createHarness(
        undefined,
        undefined,
        undefined,
        undefined,
        ref,
      );
      const run = new FakeRun();
      harness.provider.runs.push(run);
      const runId = enqueue(harness.state, message("initial"));
      const contextKey = encodeExecutionContextRef(ref);
      const client = createTeamHubRuntimeStateClientFake({
        getContext: async () =>
          ({
            context_key: contextKey,
            ref:
              reason === "task_terminal"
                ? { kind: "alter_ego", agent_id: "agent-1", task_id: "task-1" }
                : { kind: "meta", agent_id: "agent-1", room_id: "room-1" },
            tenant_id: "tenant-1",
            agent_actor_id: "actor-1",
            target_residency: "suspended",
            state_revision: "2",
            next_input_sequence: "1",
            ...(reason === "room_deleted" ? { terminal_reason: reason } : {}),
          }) satisfies RuntimeContext,
        getRun: async () => ({
          run_id: runId,
          context_key: contextKey,
          status: "canceled",
          terminal: { type: "canceled", reason },
          attempt_count: 1,
          initial_input_ids: ["initial"],
          steer_input_ids: [],
        }),
        getWorkState: async () => ({
          has_pending_work: false,
          has_queued_runs: false,
        }),
        getSession: async () => ({ available: false }),
        finishRun: async () => {
          throw new TeamHubRuntimeStateError(
            409,
            "conflict",
            "AGENT_RUNTIME_CONFLICT",
          );
        },
      });
      const authority = await createTeamHubContextRuntimeState({
        client,
        ref,
        configurationRevision: "1",
        providerKind: "codex",
      });
      const statePort: ContextRuntimeStatePort = harness.state;
      const finish = vi
        .spyOn(statePort, "finishLocalRun")
        .mockImplementation(authority.finishLocalRun.bind(authority));
      Object.assign(harness.state, {
        reconcileRevokedLocalRun:
          authority.reconcileRevokedLocalRun?.bind(authority),
      });
      const claim = vi.spyOn(harness.state, "claimLocalRun");
      harness.execution.start();
      await vi.waitFor(() => expect(run.waitCalls).toBe(1));
      if (reason === "room_deleted")
        run.fail(new Error("Codex turn was interrupted"));
      else run.complete("task done");
      await vi.waitFor(() =>
        expect(harness.execution.activeOperations).toBe(0),
      );
      await expect(
        harness.execution.drain({ cancelActive: true }),
      ).resolves.toBeUndefined();
      expect(finish).toHaveBeenCalledOnce();
      expect(claim).toHaveBeenCalledOnce();
      expect(harness.log).toHaveBeenCalledWith(
        "info",
        "local_run.upstream_canceled",
        { runId },
      );
      expect(harness.log.mock.calls.some(([level]) => level === "error")).toBe(
        false,
      );
      await authority.close();
      harness.state.close();
    },
  );

  it("settles a cancellation that finish returns without reading the Run again", async () => {
    const ref: ExecutionContextRef = {
      kind: "alter_ego",
      agentId: "agent-1",
      taskId: "task-1",
    };
    const harness = createHarness(
      undefined,
      undefined,
      undefined,
      undefined,
      ref,
    );
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("initial"));
    const contextKey = encodeExecutionContextRef(ref);
    const getRun = vi.fn();
    const client = createTeamHubRuntimeStateClientFake({
      getContext: async () =>
        ({
          context_key: contextKey,
          ref: { kind: "alter_ego", agent_id: "agent-1", task_id: "task-1" },
          tenant_id: "tenant-1",
          agent_actor_id: "actor-1",
          target_residency: "suspended",
          state_revision: "2",
          next_input_sequence: "1",
        }) satisfies RuntimeContext,
      getRun,
      getWorkState: async () => ({
        has_pending_work: false,
        has_queued_runs: false,
      }),
      getSession: async () => ({ available: false }),
      // TeamHub canceled the Run for the Task and keeps that terminal.
      finishRun: async () => ({
        run: {
          run_id: runId,
          context_key: contextKey,
          status: "canceled",
          terminal: { type: "canceled", reason: "task_terminal" },
          attempt_count: 1,
          initial_input_ids: ["initial"],
          steer_input_ids: [],
        },
      }),
    });
    const authority = await createTeamHubContextRuntimeState({
      client,
      ref,
      configurationRevision: "1",
      providerKind: "codex",
    });
    const statePort: ContextRuntimeStatePort = harness.state;
    vi.spyOn(statePort, "finishLocalRun").mockImplementation(
      authority.finishLocalRun.bind(authority),
    );
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    run.complete("task done");
    await vi.waitFor(() => expect(harness.execution.activeOperations).toBe(0));
    await expect(
      harness.execution.drain({ cancelActive: true }),
    ).resolves.toBeUndefined();
    expect(getRun).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledWith(
      "info",
      "local_run.upstream_canceled",
      { runId },
    );
    expect(harness.log.mock.calls.some(([level]) => level === "error")).toBe(
      false,
    );
    await authority.close();
    harness.state.close();
  });

  it("keeps native cleanup failure visible after TeamHub already canceled the Run", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    run.cancel = () => run.fail(new ProviderRunCleanupError());
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("cleanup-failure"));
    const conflict = new TeamHubRuntimeStateError(
      409,
      "conflict",
      "AGENT_RUNTIME_CONFLICT",
    );
    vi.spyOn(harness.state, "finishLocalRun").mockImplementation(() => {
      throw conflict;
    });
    Object.assign(harness.state, {
      reconcileRevokedLocalRun: async (_runId: string, error: unknown) =>
        error === conflict ? { type: "canceled" } : null,
    });
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    await harness.execution.requestCancellation(runId);
    await expect(
      harness.execution.drain({ cancelActive: true }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(harness.log).not.toHaveBeenCalledWith(
      "info",
      "local_run.upstream_canceled",
      expect.anything(),
    );
    harness.state.close();
  });

  it("does not confirm cancellation when native cleanup fails", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    run.cancel = () => {
      run.cancelCalls += 1;
      run.fail(new ProviderRunCleanupError());
    };
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("cleanup-failure"));
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    await harness.execution.requestCancellation(runId);
    await harness.execution.drain({ cancelActive: false });
    expect(harness.state.getLocalRun(runId)?.terminal).toEqual({
      type: "failed",
      error: "Provider cancellation cleanup is unconfirmed",
      failure: { code: "cleanup_unconfirmed", runtime_type: "pi" },
    });
    harness.state.close();
  });

  it.each([
    {
      name: "keeps the Runtime's own classification",
      error: new RuntimeExecutionError({
        code: "context_too_long",
        runtime_type: "claude",
      }),
      failure: { code: "context_too_long", runtime_type: "claude" },
    },
    {
      name: "names an oversized reply",
      error: new StreamingAgentRunLimitError("limit"),
      failure: { code: "response_too_large", runtime_type: "pi" },
    },
    {
      name: "admits an unknown cause",
      error: new Error("unexpected"),
      failure: { code: "unclassified", runtime_type: "pi" },
    },
  ])("classifies every failed Run: $name", async ({ error, failure }) => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("classified-failure"));
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    run.fail(error);
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.terminal).toMatchObject({
        type: "failed",
        failure,
      }),
    );
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("cancels a queued Run through HTTP before releasing execution, then executes only a new input", async () => {
    const harness = createHarness();
    const queuedId = enqueue(harness.state, message("queued-http-input"));
    const unsupported = async (): Promise<never> => {
      throw new Error("Unexpected API call");
    };
    const server = createAgentManagerHttpServer({
      api: {
        getGhost: unsupported,
        refreshAgent: unsupported,
        deleteAgent: unsupported,
        cancelLocalRun: async (ref, runId) => {
          expect(ref).toEqual({
            kind: "meta",
            agentId: "agent-1",
            roomId: "room-1",
          });
          return harness.execution.requestCancellation(runId);
        },
      },
      serviceToken: "queued-cancel-test",

      port: 0,
    });
    try {
      const address = await server.start();
      const cancel = () =>
        fetch(`${address.url}/v1/agent-runs/${queuedId}/cancel`, {
          method: "POST",
          headers: {
            authorization: "Bearer queued-cancel-test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            request_id: "queued-cancel-command",
            run_id: queuedId,
            context_ref: {
              kind: "meta",
              agent_id: "agent-1",
              room_id: "room-1",
            },
          }),
        });
      expect(harness.state.getLocalRun(queuedId)?.status).toBe("queued");
      expect(await (await cancel()).json()).toEqual({
        run_id: queuedId,
        status: "canceled",
      });
      expect(await (await cancel()).json()).toEqual({
        run_id: queuedId,
        status: "already_terminal",
      });
      harness.execution.start();
      await harness.execution.drain({ cancelActive: false });
      expect(harness.provider.starts).toHaveLength(0);
      expect(harness.state.getLocalRun(queuedId)?.status).toBe("canceled");
      const next = new FakeRun();
      harness.provider.runs.push(next);
      const nextId = enqueue(harness.state, message("new-http-input"));
      harness.execution.start();
      await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
      expect(harness.provider.starts[0]?.input).toEqual({
        type: "text",
        text: "new-http-input",
      });
      next.complete("new input completed");
      await harness.execution.drain({ cancelActive: false });
      expect(harness.state.getLocalRun(nextId)?.status).toBe("succeeded");
    } finally {
      await harness.execution.drain({ cancelActive: true });
      await server.close();
      harness.state.close();
    }
  });

  it("never rewrites a successful outcome when terminal acknowledgement is lost", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("initial"));
    const finish = vi
      .spyOn(harness.state, "finishLocalRun")
      .mockImplementation(() => {
        throw new Error("terminal acknowledgement lost");
      });
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    run.complete("done");
    await vi.waitFor(() => expect(harness.execution.activeOperations).toBe(0));
    await expect(
      harness.execution.drain({ cancelActive: false }),
    ).rejects.toThrow("terminal persistence failed");
    expect(finish).toHaveBeenCalledOnce();
    expect(finish.mock.calls[0]?.slice(0, 2)).toEqual([
      runId,
      { type: "succeeded", finalResponse: "done" },
    ]);
    expect(harness.provider.starts).toHaveLength(1);
    harness.state.close();
  });

  it("keeps terminal recovery active until stop and never restarts the provider", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    enqueue(harness.state, message("initial"));
    let recoverySignal: AbortSignal | undefined;
    const finish = vi.fn(
      (
        _runId: string,
        _terminal: unknown,
        _session: unknown,
        signal: AbortSignal,
      ) => {
        recoverySignal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("recovery stopped")),
            { once: true },
          );
        });
      },
    );
    Object.assign(harness.state, { finishLocalRun: finish });
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    run.complete("done");
    await vi.waitFor(() => expect(recoverySignal).toBeDefined());
    expect(harness.execution.activeOperations).toBe(1);
    expect(harness.provider.starts).toHaveLength(1);
    const draining = harness.execution.drain({ cancelActive: true });
    await expect(draining).rejects.toThrow("terminal persistence failed");
    expect(recoverySignal?.aborted).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
    expect(harness.provider.starts).toHaveLength(1);
    harness.state.close();
  });

  it.each(["success", "failure"])(
    "rejects a waiting steer and drains when %s revocation lookup fails",
    async (outcome) => {
      const harness = createHarness();
      const run = new FakeRun();
      harness.provider.runs.push(run);
      enqueue(harness.state, message("initial"));
      const conflict = new Error("finish conflict");
      vi.spyOn(harness.state, "finishLocalRun").mockImplementation(() => {
        throw conflict;
      });
      const lookup = deferred<null>();
      const reconcile = vi.fn((_runId: string, error: unknown) =>
        error === conflict ? lookup.promise : null,
      );
      Object.assign(harness.state, { reconcileRevokedLocalRun: reconcile });
      harness.execution.start();
      await vi.waitFor(() => expect(run.waitCalls).toBe(1));
      if (outcome === "success") run.complete("done");
      else run.fail(new Error("provider failed"));
      await vi.waitFor(() => expect(reconcile).toHaveBeenCalled());
      let steerError: unknown;
      const steer = harness.execution
        .steer("late-steer", [message("late")], new AbortController().signal)
        .catch((error: unknown) => {
          steerError = error;
        });
      const lookupError = new Error("TeamHub lookup unavailable");
      lookup.reject(lookupError);
      await vi.waitFor(() => expect(steerError).toBe(lookupError));
      await steer;
      await expect(
        harness.execution.drain({ cancelActive: false }),
      ).rejects.toBe(lookupError);
      expect(harness.execution.activeOperations).toBe(0);
      expect(harness.log).toHaveBeenCalledWith(
        "error",
        "local_run.loop_failed",
        {
          error: lookupError,
        },
      );
      harness.state.close();
    },
  );

  it("keeps unconfirmed finish conflicts visible", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    enqueue(harness.state, message("initial"));
    vi.spyOn(harness.state, "finishLocalRun").mockImplementation(() => {
      throw new Error("unknown conflict");
    });
    Object.assign(harness.state, {
      reconcileRevokedLocalRun: async () => null,
    });
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    run.complete("done");
    await vi.waitFor(() =>
      expect(harness.log).toHaveBeenCalledWith(
        "error",
        "local_run.loop_failed",
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining("terminal persistence failed"),
          }),
        }),
      ),
    );
    await expect(
      harness.execution.drain({ cancelActive: false }),
    ).rejects.toThrow("terminal persistence failed");
    harness.state.close();
  });

  it("stops status publication and cancels the provider when TeamHub has revoked the Context", async () => {
    const offer = vi.fn(async () => {
      throw new Error("offer conflict");
    });
    const publisher = new RecordingRuntimeStatusPublisher();
    vi.spyOn(publisher, "open").mockResolvedValue({ publish: offer });
    const harness = createHarness(undefined, undefined, publisher);
    Object.assign(harness.state, {
      reconcileRevokedLocalRun: vi.fn(async () => ({
        type: "canceled" as const,
      })),
    });
    const finish = vi.spyOn(harness.state, "finishLocalRun");
    const run = new FakeRun([
      { type: "status.changed", status: "thinking" },
      { type: "status.changed", status: "working" },
    ]);
    harness.provider.runs.push(run);
    enqueue(harness.state, message("initial"));
    harness.execution.start();
    await vi.waitFor(() => expect(offer).toHaveBeenCalled());
    // Resolve even on the defective implementation so the assertion cannot hang.
    run.complete("done");
    await vi.waitFor(() => expect(harness.execution.activeRunId()).toBeNull());
    await harness.execution.drain({ cancelActive: false });
    expect(offer).toHaveBeenCalledTimes(1);
    expect(run.cancelCalls).toBe(1);
    expect(finish).not.toHaveBeenCalled();
    harness.state.close();
  });

  it("keeps draining Run events while a status batch is still in flight", async () => {
    const offers: RuntimeStatusUpdate[] = [];
    const held = deferred<void>();
    const publisher = new RecordingRuntimeStatusPublisher();
    vi.spyOn(publisher, "open").mockResolvedValue({
      publish: (updates: readonly RuntimeStatusUpdate[]) => {
        offers.push(...updates);
        return held.promise;
      },
    });
    const harness = createHarness(undefined, undefined, publisher);
    let yielded = 0;
    const run = new FakeRun();
    Object.defineProperty(run, "events", {
      value: (async function* () {
        for (let index = 0; index < 8; index += 1) {
          yielded += 1;
          yield { type: "status.changed", status: "working" } as RunEvent;
        }
      })(),
    });
    harness.provider.runs.push(run);
    enqueue(harness.state, message("initial"));
    harness.execution.start();
    // Publishing is serialized behind the held batch, so a chain that awaited it
    // inside the event loop would stall after the first update.
    await vi.waitFor(() => expect(yielded).toBe(8));
    expect(offers).toHaveLength(1);
    held.resolve();
    run.complete("done");
    await vi.waitFor(() => expect(harness.execution.activeRunId()).toBeNull());
    await harness.execution.drain({ cancelActive: false });
    expect(offers).toHaveLength(8);
    harness.state.close();
  });

  it("publishes the queued status tail before persisting the terminal", async () => {
    const held = deferred<void>();
    const publisher = new RecordingRuntimeStatusPublisher();
    const offer = vi.fn(() => held.promise);
    vi.spyOn(publisher, "open").mockResolvedValue({ publish: offer });
    const harness = createHarness(undefined, undefined, publisher);
    const run = new FakeRun([{ type: "status.changed", status: "thinking" }]);
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("status-terminal"));

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    await vi.waitFor(() => expect(offer).toHaveBeenCalledOnce());
    run.complete("done");
    await vi.waitFor(() =>
      expect(harness.log).toHaveBeenCalledWith(
        "info",
        "local_run.provider_completed",
        expect.objectContaining({ runId }),
      ),
    );
    expect(harness.state.getLocalRun(runId)?.status).toBe("running");
    held.resolve();
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded"),
    );
    await harness.execution.drain({ cancelActive: false });
    expect(offer).toHaveBeenCalledOnce();
    harness.state.close();
  });

  it.each(["success", "failure"])(
    "adopts upstream cancellation after %s finish conflict without retrying or claiming another Run",
    async (outcome) => {
      const harness = createHarness();
      const run = new FakeRun();
      harness.provider.runs.push(run);
      const runId = enqueue(harness.state, message("initial"));
      const conflict = new Error("finish conflict");
      const finish = vi
        .spyOn(harness.state, "finishLocalRun")
        .mockImplementation(() => {
          throw conflict;
        });
      Object.assign(harness.state, {
        reconcileRevokedLocalRun: vi.fn(
          async (_runId: string, error: unknown) =>
            error === conflict ? { type: "canceled" as const } : null,
        ),
      });
      const claim = vi.spyOn(harness.state, "claimLocalRun");
      harness.execution.start();
      await vi.waitFor(() => expect(run.waitCalls).toBe(1));
      if (outcome === "success") run.complete("done");
      else run.fail(new Error("provider failed"));
      await vi.waitFor(() =>
        expect(harness.execution.activeRunId()).toBeNull(),
      );
      await harness.execution.drain({ cancelActive: false });
      expect(finish).toHaveBeenCalledTimes(1);
      expect(finish).toHaveBeenCalledWith(
        runId,
        outcome === "success"
          ? { type: "succeeded", finalResponse: "done" }
          : {
              type: "failed",
              error: "provider failed",
              failure: { code: "unclassified", runtime_type: "pi" },
            },
        expect.anything(),
        expect.any(AbortSignal),
      );
      expect(claim).toHaveBeenCalledTimes(1);
      expect(harness.log).toHaveBeenCalledWith(
        "info",
        "local_run.upstream_canceled",
        { runId },
      );
      expect(harness.log.mock.calls.some(([level]) => level === "error")).toBe(
        false,
      );
      harness.state.close();
    },
  );

  it("checkpoints a provider-generated thread before consuming its first Run", async () => {
    const runtimeSession = { threadId: "" };
    const harness = createHarness(
      undefined,
      undefined,
      undefined,
      runtimeSession,
    );
    const run = new FakeRun();
    harness.provider.runs.push(run);
    harness.provider.initializeThreadId =
      "018f47a2-0e9b-7c65-9a61-5f47853d748f";
    const runId = enqueue(harness.state, message("initial"));

    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));

    expect(await harness.state.getRuntimeSession()).toEqual({
      threadId: harness.provider.initializeThreadId,
    });

    run.complete("done");
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded"),
    );
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });
  it("includes the post-retirement native boundary in the existing terminal transaction", async () => {
    const runtimeSession: { threadId: string; nativeCheckpoint: unknown } = {
      threadId: "",
      nativeCheckpoint: null,
    };
    const harness = createHarness(
      undefined,
      undefined,
      undefined,
      runtimeSession,
    );
    const run = new FakeRun();
    harness.provider.runs.push(run);
    harness.provider.initializeThreadId =
      "018f47a2-0e9b-7c65-9a61-5f47853d748f";
    const finish = vi.spyOn(harness.state, "finishLocalRun");
    const runId = enqueue(harness.state, message("native boundary"));
    try {
      harness.execution.start();
      await vi.waitFor(() => expect(run.waitCalls).toBe(1));
      expect(await harness.state.getRuntimeSession()).toEqual({
        threadId: runtimeSession.threadId,
        nativeCheckpoint: null,
      });
      expect(finish).not.toHaveBeenCalled();
      runtimeSession.nativeCheckpoint = {
        version: 1,
        threadId: runtimeSession.threadId,
        inputUuid: "d0cd50e0-c3d3-4c2e-866e-8278660170d0",
        assistantUuid: "b9629f90-ef86-442b-b0ed-444dbb42110a",
        lastEntryUuid: "b9629f90-ef86-442b-b0ed-444dbb42110a",
        sizeBytes: 200,
        recordCount: 2,
      };
      run.complete("done");
      await vi.waitFor(() =>
        expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded"),
      );
      expect(finish).toHaveBeenCalledWith(
        runId,
        { type: "succeeded", finalResponse: "done" },
        runtimeSession,
        expect.any(AbortSignal),
      );
      expect(harness.provider.starts).toHaveLength(1);
    } finally {
      await harness.execution.drain({ cancelActive: true });
      harness.state.close();
    }
  });

  it("fails a first turn without replaying it when its Session checkpoint fails", async () => {
    const harness = createHarness(undefined, undefined, undefined, {
      threadId: "",
    });
    const run = new FakeRun();
    void run.wait().catch(() => undefined);
    harness.provider.runs.push(run);
    harness.provider.initializeThreadId = "native-local-thread";
    vi.spyOn(harness.state, "setRuntimeSession").mockImplementationOnce(() => {
      throw new Error("checkpoint failed");
    });
    const runId = enqueue(harness.state, message("initial"));
    harness.execution.start();
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)).toMatchObject({
        status: "failed",
        terminal: { error: "checkpoint failed" },
      }),
    );
    expect(harness.provider.starts).toHaveLength(1);
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("passes only durable Run provenance to the activated Provider", async () => {
    const harness = createHarness();
    Object.assign(harness.state, { executionEpoch: () => "agent-epoch-1" });
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("initial", "room:room-1"));

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const runContext = harness.provider.starts[0]?.spec.runContext;
    expect(runContext).toEqual({
      executionRunRef: runId,
      executionAttemptCount: 1,
      executionEpoch: "agent-epoch-1",
      messageIds: ["initial"],
      sourceInboxIds: ["room:room-1"],
      cancellationRequested: undefined,
    });
    const steer = selectSteer(
      harness.state,
      message("follow-up", "room:room-1"),
    );
    await harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
    );
    expect(harness.provider.steers[0]?.options.runContext).toMatchObject({
      executionRunRef: runId,
      executionAttemptCount: 1,
      executionEpoch: "agent-epoch-1",
    });
    run.complete("done");
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded"),
    );
    harness.state.close();
  });

  it("routes an alterEgo wake to the exact current Task Inbox", async () => {
    const ref = {
      kind: "alter_ego",
      agentId: "agent-1",
      taskId: "task-live",
    } as const;
    const activeContexts: Array<ToolRunContext | null> = [];
    const harness = createHarness(
      activeContexts,
      undefined,
      undefined,
      undefined,
      ref,
    );
    const run = new FakeRun();
    harness.provider.runs.push(run);
    harness.state.enqueueTrustedTurn([
      message("ordinary-room-notice", "task:task-live"),
      message("wake-task", "meta:agent-1:task-live"),
    ]);

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    expect(activeContexts[0]?.sourceInboxIds).toEqual([
      "task:task-live",
      "meta:agent-1:task-live",
    ]);
    const initial = harness.provider.starts[0]!.input;
    expect(initial.type).toBe("text");
    if (initial.type !== "text") throw new Error("Expected Task text input");
    expect(initial.text).toContain(
      "Your first input is the Task requirement; later inputs are messages from the Meta that delegated it or approval results.",
    );
    expect(initial.text).toContain(
      `teamhub message read --inbox 'meta:agent-1:task-live'`,
    );
    expect(initial.text).toContain("wake-task");
    const steer = selectSteer(
      harness.state,
      message("steer-task", "meta:agent-1:task-live"),
    );
    await harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
    );
    const steered = harness.provider.steers[0]!.options.input;
    expect(steered.type).toBe("text");
    if (steered.type !== "text")
      throw new Error("Expected Task steer text input");
    expect(steered.text).toContain(
      "Your first input is the Task requirement; later inputs are messages from the Meta that delegated it or approval results.",
    );
    expect(steered.text).toContain(
      `teamhub message read --inbox 'meta:agent-1:task-live'`,
    );
    expect(steered.text).toContain("steer-task");
    expect(harness.provider.steers[0]?.run).toBe(run);
    expect(harness.state.getSteerOutcome("steer-task")).toBe("applied");
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("uses canonical Inbox Message IDs instead of a notification wrapper ID", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const notification = {
      ...message("notification-wrapper", "room:room-1"),
      invocationMessageIds: ["message-canonical-1", "message-canonical-2"],
    } as Message;
    harness.state.enqueueTrustedTurn([notification]);

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    expect(harness.provider.starts[0]?.spec.runContext?.messageIds).toEqual([
      "message-canonical-1",
      "message-canonical-2",
    ]);
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("publishes trusted active Run provenance for fixed Tools", async () => {
    const activeContexts: Array<ToolRunContext | null> = [];
    const harness = createHarness(activeContexts);
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("initial", "room:room-1"));

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    expect(activeContexts).toEqual([
      {
        runId,
        sourceInboxIds: ["room:room-1"],
      },
    ]);
    run.complete("done");
    await vi.waitFor(() => expect(activeContexts.at(-1)).toBeNull());

    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("projects provider status events without waiting for TeamHub delivery", async () => {
    const statusPublisher = new RecordingRuntimeStatusPublisher();
    const harness = createHarness(undefined, undefined, statusPublisher);
    const run = new FakeRun([
      {
        type: "status.changed",
        status: "thinking",
        title: "Inspecting runtime status",
      },
      {
        type: "plan.updated",
        explanation: "Inspect before editing",
        steps: [
          { content: "Inspect implementation", status: "completed" },
          { content: "Apply change", status: "in_progress" },
        ],
      },
      { type: "status.changed", status: "working" },
    ]);
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("initial", "room:room-1"));

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    run.complete("done");
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded"),
    );

    expect(statusPublisher.opened).toEqual([
      {
        executionId: runId,
        ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
        epoch: "agent-epoch-1",
        sourceInboxIds: ["room:room-1"],
      },
    ]);
    expect(statusPublisher.sessions[0]?.updates).toEqual([
      {
        type: "status.changed",
        status: "thinking",
        title: "Inspecting runtime status",
      },
      {
        type: "plan.updated",
        explanation: "Inspect before editing",
        steps: [
          { content: "Inspect implementation", status: "completed" },
          { content: "Apply change", status: "in_progress" },
        ],
      },
      { type: "status.changed", status: "working" },
    ]);
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("continues projecting status events after one TeamHub delivery fails", async () => {
    const statusPublisher = new FailingOnceRuntimeStatusPublisher();
    const harness = createHarness(undefined, undefined, statusPublisher);
    const run = new FakeRun();
    const failed = statusPublisher.session.failed;
    Object.defineProperty(run, "events", {
      value: (async function* () {
        yield {
          type: "status.changed",
          status: "thinking",
          title: "Inspecting runtime status",
        } as RunEvent;
        // The next update goes out only after the first batch failed.
        await failed.promise;
        yield { type: "status.changed", status: "working" } as RunEvent;
      })(),
    });
    harness.provider.runs.push(run);
    const runId = enqueue(
      harness.state,
      message("initial", "room:room-1", "message-human"),
    );

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    run.complete("done");
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded"),
    );
    await harness.execution.drain({ cancelActive: false });

    expect(statusPublisher.session.updates).toEqual([
      { type: "status.changed", status: "working" },
    ]);
    harness.state.close();
  });

  it("freezes runtime status provenance before later steer messages", async () => {
    const statusPublisher = new RecordingRuntimeStatusPublisher();
    const harness = createHarness(undefined, undefined, statusPublisher);
    const run = new FakeRun();
    harness.provider.runs.push(run);
    enqueue(harness.state, message("initial", "room:room-1"));

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const steer = selectSteer(harness.state, message("steer", "room:room-2"));
    await harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
    );
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });

    expect(statusPublisher.opened[0]?.sourceInboxIds).toEqual(["room:room-1"]);
    harness.state.close();
  });

  it("cancels queued and running Local Runs without re-enqueueing input", async () => {
    const harness = createHarness();
    const queuedRunId = enqueue(harness.state, message("queued"));
    await expect(
      harness.execution.requestCancellation(queuedRunId),
    ).resolves.toBe("canceled");

    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runningRunId = enqueue(harness.state, message("running"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));

    await expect(
      harness.execution.requestCancellation(runningRunId),
    ).resolves.toBe("cancel_requested");
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runningRunId)).toMatchObject({
        status: "canceled",
        terminal: { type: "canceled" },
      }),
    );
    expect(harness.state.getLocalRun(queuedRunId)).toMatchObject({
      status: "canceled",
      initialMessageIds: ["queued"],
    });
    expect(run.cancelCalls).toBe(1);
    expect(harness.state.hasQueuedRuns()).toBe(false);
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("aborts an active provider after Task cleanup already made its Run terminal", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("task cleanup"));
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    harness.state.finishLocalRun(runId, { type: "canceled" });
    await expect(harness.execution.requestCancellation(runId)).resolves.toBe(
      "already_terminal",
    );
    await vi.waitFor(() => expect(run.cancelCalls).toBe(1));
    await harness.execution.drain({ cancelActive: false });
    expect(harness.state.getLocalRun(runId)?.status).toBe("canceled");
    harness.state.close();
  });

  it("honors cancellation while provider start is still pending", async () => {
    const harness = createHarness();
    const providerStart = deferred<AgentRun>();
    harness.provider.startGate = providerStart;
    const run = new FakeRun();
    const runId = enqueue(harness.state, message("initial"));

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    await expect(harness.execution.requestCancellation(runId)).resolves.toBe(
      "cancel_requested",
    );
    providerStart.resolve(run);

    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)).toMatchObject({
        status: "canceled",
        terminal: { type: "canceled" },
      }),
    );
    expect(run.cancelCalls).toBe(1);
    expect(run.waitCalls).toBe(0);
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("does not call the provider when cancellation wins before start", async () => {
    const harness = createHarness();
    const runId = enqueue(harness.state, message("initial"));

    harness.execution.start();
    await expect(harness.execution.requestCancellation(runId)).resolves.toBe(
      "cancel_requested",
    );

    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)).toMatchObject({
        status: "canceled",
        terminal: { type: "canceled" },
      }),
    );
    expect(harness.provider.starts).toHaveLength(0);
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("does not record success when an aborted provider resolves normally", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    run.rejectWaitOnCancel = false;
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("initial"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));

    await expect(harness.execution.requestCancellation(runId)).resolves.toBe(
      "cancel_requested",
    );
    run.complete("must not become success");

    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)).toMatchObject({
        status: "canceled",
        terminal: { type: "canceled" },
      }),
    );
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("records an externally interrupted Provider Run without treating it as user cancellation", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("initial"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));

    run.fail(new ProviderRunInterruptedError("Runner process stopped"));

    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)).toMatchObject({
        status: "failed",
        terminal: {
          type: "failed",
          error: "process_interrupted",
          failure: { code: "interrupted", runtime_type: "pi" },
        },
      }),
    );
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("retries one Run after a definitely-not-started Provider failure", async () => {
    const statusPublisher = new RecordingRuntimeStatusPublisher();
    const harness = createHarness(undefined, undefined, statusPublisher);
    const run = new FakeRun();
    harness.provider.startErrors.push(
      new ProviderRunStartError(
        "definitely_not_started",
        "MCP synchronization failed",
      ),
    );
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("initial"));

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(2));
    expect(
      harness.provider.starts.map(
        ({ spec }) => spec.runContext?.executionAttemptCount,
      ),
    ).toEqual([1, 2]);
    expect(harness.state.getLocalRun(runId)?.status).toBe("running");
    expect(statusPublisher.opened).toHaveLength(1);

    run.complete("done after retry");
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded"),
    );
    harness.state.close();
  });

  it("waits for Runtime admission recovery without consuming generic start attempts", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.startErrors.push(
      new ProviderRunAdmissionUnavailableError(),
      new ProviderRunAdmissionUnavailableError(),
    );
    harness.provider.runs.push(run);
    const runId = enqueue(
      harness.state,
      message("queued after deferred steer"),
    );
    const claim = vi.spyOn(harness.state, "claimLocalRun");
    try {
      harness.execution.start();
      await settleAsyncWork();
      expect(harness.provider.starts).toHaveLength(1);
      expect(harness.state.getLocalRun(runId)?.status).toBe("running");
      for (const attempt of [1, 2]) {
        await vi.advanceTimersByTimeAsync(4_999);
        expect(harness.provider.starts).toHaveLength(attempt);
        await vi.advanceTimersByTimeAsync(1);
        expect(harness.provider.starts).toHaveLength(attempt + 1);
        expect(claim).toHaveBeenCalledOnce();
      }
      run.complete("recovered");
      await settleAsyncWork();
      expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded");
    } finally {
      await harness.execution.drain({ cancelActive: true });
      harness.state.close();
      vi.useRealTimers();
    }
  });

  it("cancels an admission wait without starting the provider later", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const harness = createHarness();
    harness.provider.startErrors.push(
      new ProviderRunAdmissionUnavailableError(),
    );
    const runId = enqueue(harness.state, message("cancelled while waiting"));
    try {
      harness.execution.start();
      await settleAsyncWork();
      expect(harness.provider.starts).toHaveLength(1);
      await expect(harness.execution.requestCancellation(runId)).resolves.toBe(
        "cancel_requested",
      );
      await settleAsyncWork();
      expect(harness.state.getLocalRun(runId)?.status).toBe("canceled");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(harness.provider.starts).toHaveLength(1);
    } finally {
      await harness.execution.drain({ cancelActive: true });
      harness.state.close();
      vi.useRealTimers();
    }
  });

  it("fails at the admission deadline without re-claiming or starting later", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const harness = createHarness();
    harness.provider.startErrors.push(
      ...Array.from(
        { length: 25 },
        () => new ProviderRunAdmissionUnavailableError(),
      ),
    );
    const runId = enqueue(harness.state, message("admission never recovers"));
    const claim = vi.spyOn(harness.state, "claimLocalRun");
    try {
      harness.execution.start();
      await settleAsyncWork();
      await vi.advanceTimersByTimeAsync(119_999);
      expect(harness.provider.starts).toHaveLength(24);
      expect(harness.state.getLocalRun(runId)?.status).toBe("running");
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.provider.starts).toHaveLength(25);
      expect(harness.state.getLocalRun(runId)?.terminal).toMatchObject({
        type: "failed",
        failure: { code: "computer_unavailable", runtime_type: "pi" },
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(harness.provider.starts).toHaveLength(25);
      expect(claim).toHaveBeenCalledOnce();
    } finally {
      await harness.execution.drain({ cancelActive: true });
      harness.state.close();
      vi.useRealTimers();
    }
  });

  it("stops waiting when placement is revoked at the next admission check", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const harness = createHarness();
    harness.provider.startErrors.push(
      new ProviderRunAdmissionUnavailableError(),
      new ProviderRunStartError(
        "definitely_not_started",
        "workspace grant revoked",
      ),
      new ProviderRunStartError(
        "definitely_not_started",
        "workspace grant revoked",
      ),
    );
    const runId = enqueue(harness.state, message("revoked while waiting"));
    try {
      harness.execution.start();
      await settleAsyncWork();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(harness.provider.starts).toHaveLength(1);
      // A definite pre-start failure gets one generic retry, not another wait.
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.provider.starts).toHaveLength(3);
      expect(harness.state.getLocalRun(runId)?.status).toBe("failed");
      expect(
        harness.log.mock.calls.filter(
          ([, event]) => event === "local_run.admission_wait",
        ),
      ).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(harness.provider.starts).toHaveLength(3);
    } finally {
      await harness.execution.drain({ cancelActive: true });
      harness.state.close();
      vi.useRealTimers();
    }
  });

  it("fails after the definitely-not-started retry budget is exhausted", async () => {
    const statusPublisher = new RecordingRuntimeStatusPublisher();
    const harness = createHarness(undefined, undefined, statusPublisher);
    harness.provider.startErrors.push(
      new ProviderRunStartError("definitely_not_started", "first failure"),
      new ProviderRunStartError("definitely_not_started", "second failure"),
    );
    const runId = enqueue(harness.state, message("initial"));

    harness.execution.start();
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)).toMatchObject({
        status: "failed",
        terminal: { type: "failed", error: "second failure" },
      }),
    );
    expect(harness.provider.starts).toHaveLength(2);
    expect(statusPublisher.opened).toHaveLength(1);
    harness.state.close();
  });

  it("publishes a classified cold-start failure without checkpointing an empty session or retrying", async () => {
    const publisher = new RecordingRuntimeStatusPublisher();
    const harness = createHarness(undefined, undefined, publisher, {
      threadId: "",
    });
    const failure = {
      code: "protocol_incompatible",
      runtime_type: "codex",
      runtime_version: "0.153.4",
    } as const;
    const diagnostics = {
      code: "httpConnectionFailed",
      statusCode: 429,
      exitCode: 3,
      signal: "SIGSEGV",
    };
    harness.provider.startErrors.push(
      new RuntimeExecutionError(failure, { diagnostics }),
    );
    const finish = vi.spyOn(harness.state, "finishLocalRun");
    const runId = enqueue(harness.state, message("initial"));
    harness.execution.start();
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)).toMatchObject({
        status: "failed",
        terminal: { failure },
      }),
    );
    expect(harness.log).toHaveBeenCalledWith(
      "error",
      "local_run.failed",
      expect.objectContaining({
        runId,
        ...diagnostics,
        errorType: "RuntimeExecutionError",
        failureCode: "protocol_incompatible",
        runtimeType: "codex",
        runtimeVersion: "0.153.4",
      }),
    );
    expect(harness.provider.starts).toHaveLength(1);
    expect(publisher.opened).toHaveLength(1);
    expect(finish).toHaveBeenCalledWith(
      runId,
      {
        type: "failed",
        failure,
        error: "codex execution failed (protocol_incompatible)",
      },
      undefined,
      expect.any(AbortSignal),
    );
    harness.state.close();
  });

  it("does not retry an ambiguous Provider start failure", async () => {
    const harness = createHarness();
    harness.provider.startErrors.push(new Error("start outcome unknown"));
    const runId = enqueue(harness.state, message("initial"));

    harness.execution.start();
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)).toMatchObject({
        status: "failed",
        terminal: { type: "failed", error: "start outcome unknown" },
      }),
    );
    expect(harness.provider.starts).toHaveLength(1);
    harness.state.close();
  });

  it.each([true, false])(
    "does not requeue an uncertain daemon restart with retryable=%s",
    async (retryable) => {
      const harness = createHarness();
      harness.provider.startErrors.push(
        new RunnerOperationError(
          "DAEMON_RESTARTED",
          "Native outcome is unknown",
          retryable,
        ),
      );
      const runId = enqueue(harness.state, message("initial"));
      harness.execution.start();
      await vi.waitFor(() =>
        expect(harness.state.getLocalRun(runId)).toMatchObject({
          status: "failed",
          terminal: { type: "failed", error: "Native outcome is unknown" },
        }),
      );
      expect(harness.provider.starts).toHaveLength(1);
      expect(harness.state.hasQueuedRuns()).toBe(false);
      harness.state.close();
    },
  );

  it("waits for provider start and applies steer to the same Local Run", async () => {
    const activeContexts: Array<ToolRunContext | null> = [];
    const harness = createHarness(activeContexts);
    const providerStart = deferred<AgentRun>();
    harness.provider.startGate = providerStart;
    const run = new FakeRun();
    const runId = enqueue(harness.state, message("initial", "room:room-1"));

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    expect(harness.execution.activeSourceInboxIds()).toEqual(["room:room-1"]);
    const steer = selectSteer(harness.state, message("steer", "room:room-2"));
    const steering = harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
    );
    // A new input cannot synchronize and replace the pending Context delta
    // while operation.start is still downloading its files.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.provider.steers).toHaveLength(0);
    providerStart.resolve(run);
    await steering;

    expect(harness.provider.steers).toHaveLength(1);
    expect(harness.state.getSteerOutcome("steer")).toBe("applied");
    expect(harness.state.getLocalRun(runId)?.steerMessageIds).toEqual([
      "steer",
    ]);
    expect(harness.state.hasQueuedRuns()).toBe(false);
    expect(activeContexts).toEqual([
      {
        runId,
        sourceInboxIds: ["room:room-1"],
      },
      {
        runId,
        sourceInboxIds: ["room:room-1", "room:room-2"],
      },
    ]);
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("parks pre-Provider steer failures for the next Run without stopping the current one", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    harness.provider.steerError = Object.assign(
      new Error("Runtime admission probe unavailable"),
      { effect: "definitely_not_applied" as const },
    );
    const runId = enqueue(harness.state, message("initial", "room:room-1"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const steer = selectSteer(
      harness.state,
      message("follow-up", "room:room-1"),
    );
    await harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
    );
    expect(harness.state.getSteerOutcome("follow-up")).toBeNull();
    expect(harness.state.hasQueuedRuns()).toBe(true);
    expect(run.cancelCalls).toBe(0);
    expect(harness.state.getLocalRun(runId)?.status).toBe("running");
    run.complete("completed initial work");
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded"),
    );
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("enqueues a targeted steer when the active Run has another source Inbox", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    enqueue(harness.state, message("initial", "room:room-1"));

    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const steer = selectSteer(harness.state, message("mention", "room:room-2"));

    await harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
      "room:room-2",
    );

    expect(harness.provider.steers).toHaveLength(0);
    expect(harness.state.getSteerOutcome("mention")).toBeNull();
    expect(harness.state.hasQueuedRuns()).toBe(true);
    await harness.execution.drain({ cancelActive: true });
    harness.state.close();
  });

  it("serializes trusted provider steers in durable Message order", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    const steerGate = deferred<void>();
    harness.provider.runs.push(run);
    harness.provider.steerGate = steerGate;
    enqueue(harness.state, message("initial", "room:room-1"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const first = selectSteer(harness.state, message("steer-1", "room:room-1"));
    const second = selectSteer(
      harness.state,
      message("steer-2", "room:room-1"),
    );

    const firstOperation = harness.execution.steer(
      first.groupId,
      first.messages,
      new AbortController().signal,
      "room:room-1",
    );
    const secondOperation = harness.execution.steer(
      second.groupId,
      second.messages,
      new AbortController().signal,
      "room:room-1",
    );
    await vi.waitFor(() => expect(harness.provider.steers).toHaveLength(1));
    await settleAsyncWork();
    expect(harness.provider.steers).toHaveLength(1);

    steerGate.resolve();
    await Promise.all([firstOperation, secondOperation]);
    expect(harness.provider.steers).toHaveLength(2);
    expect(harness.state.getSteerOutcome("steer-1")).toBe("applied");
    expect(harness.state.getSteerOutcome("steer-2")).toBe("applied");
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("preserves concurrent dispatch for ordinary provider steers", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    const steerGate = deferred<void>();
    harness.provider.runs.push(run);
    harness.provider.steerGate = steerGate;
    enqueue(harness.state, message("initial", "room:room-1"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const first = selectSteer(harness.state, message("steer-1", "room:room-1"));
    const second = selectSteer(
      harness.state,
      message("steer-2", "room:room-1"),
    );

    const firstOperation = harness.execution.steer(
      first.groupId,
      first.messages,
      new AbortController().signal,
    );
    const secondOperation = harness.execution.steer(
      second.groupId,
      second.messages,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(harness.provider.steers).toHaveLength(2));

    steerGate.resolve();
    await Promise.all([firstOperation, secondOperation]);
    expect(harness.state.getSteerOutcome("steer-1")).toBe("applied");
    expect(harness.state.getSteerOutcome("steer-2")).toBe("applied");
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("settles an attempted provider steer as uncertain without fallback", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    harness.provider.steerError = new Error("provider outcome unknown");
    const runId = enqueue(harness.state, message("initial"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const steer = selectSteer(harness.state, message("steer"));

    await harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
    );

    expect(harness.state.getSteerOutcome("steer")).toBe("uncertain");
    expect(harness.state.getLocalRun(runId)?.steerMessageIds).toEqual([
      "steer",
    ]);
    expect(harness.state.hasQueuedRuns()).toBe(false);
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it.each([
    new Error("provider outcome unknown"),
    new RunnerOperationInputError("Local ACK lost", "uncertain", "transport"),
  ])(
    "does not enqueue a trusted steer with uncertain outcome: %s",
    async (error) => {
      const harness = createHarness();
      const run = new FakeRun();
      harness.provider.runs.push(run);
      harness.provider.steerError = error;
      enqueue(harness.state, message("initial", "room:room-1"));
      harness.execution.start();
      await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
      const steer = selectSteer(
        harness.state,
        message("trusted-steer", "room:room-1"),
      );

      await harness.execution.steer(
        steer.groupId,
        steer.messages,
        new AbortController().signal,
        "room:room-1",
      );

      expect(harness.provider.steers).toHaveLength(1);
      expect(harness.state.getSteerOutcome("trusted-steer")).toBe("uncertain");
      expect(harness.state.hasQueuedRuns()).toBe(false);
      await harness.execution.drain({ cancelActive: true });
      harness.state.close();
    },
  );

  it.each(
    [
      new RunnerOperationInputError(
        "Local rejected before submission",
        "definitely_not_applied",
        "no_active_turn",
      ),
    ].flatMap((error) =>
      [undefined, "room:room-1"].map((sourceInboxId) => ({
        error,
        sourceInboxId,
      })),
    ),
  )("enqueues unapplied steer: %s", async ({ error, sourceInboxId }) => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    harness.provider.steerError = error;
    enqueue(harness.state, message("initial", "room:room-1"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const steer = selectSteer(
      harness.state,
      message("trusted-steer", "room:room-1"),
    );
    await harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
      sourceInboxId,
    );
    expect(harness.state.hasQueuedRuns()).toBe(true);
    expect(harness.state.getSteerOutcome("trusted-steer")).toBeNull();
    await harness.execution.drain({ cancelActive: true });
    harness.state.close();
  });

  it("answers a follow-up the ending turn never showed exactly once, in the next Run", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    const next = new FakeRun();
    const steerGate = deferred<void>();
    harness.provider.runs.push(run, next);
    harness.provider.steerGate = steerGate;
    const runId = enqueue(harness.state, message("initial", "room:room-1"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const steer = selectSteer(
      harness.state,
      message("tail-follow-up", "room:room-1"),
    );
    const steering = harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
      "room:room-1",
    );
    await vi.waitFor(() => expect(harness.provider.steers).toHaveLength(1));
    // The Runtime accepted the steer but its turn ended before showing it.
    harness.provider.steerError = new RunnerOperationInputError(
      "Steer was not consumed before the turn ended",
      "definitely_not_applied",
      "no_active_turn",
    );
    run.complete("completed initial work");
    steerGate.resolve();
    await steering;
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(2));
    expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded");
    expect(harness.state.getSteerOutcome("tail-follow-up")).toBeNull();
    expect(JSON.stringify(harness.provider.starts[1]?.input)).toContain(
      "tail-follow-up",
    );
    next.complete("answered the follow-up");
    await harness.execution.drain({ cancelActive: false });
    expect(harness.provider.starts).toHaveLength(2);
    expect(harness.provider.steers).toHaveLength(1);
    expect(harness.state.hasQueuedRuns()).toBe(false);
    harness.state.close();
  });

  it.each([false, true])(
    "does not enqueue or relabel an acknowledged steer when persistence fails (committed=%s)",
    async (committed) => {
      const harness = createHarness();
      const run = new FakeRun();
      harness.provider.runs.push(run);
      enqueue(harness.state, message("initial", "room:room-1"));
      harness.execution.start();
      await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
      const steer = selectSteer(
        harness.state,
        message("trusted-steer", "room:room-1"),
      );
      const completeSteer = harness.state.completeSteer.bind(harness.state);
      const complete = vi
        .spyOn(harness.state, "completeSteer")
        .mockImplementation((...args) => {
          if (committed) completeSteer(...args);
          throw new Error("steer checkpoint unavailable");
        });
      await expect(
        harness.execution.steer(
          steer.groupId,
          steer.messages,
          new AbortController().signal,
          "room:room-1",
        ),
      ).rejects.toThrow("steer checkpoint unavailable");
      expect(harness.provider.steers).toHaveLength(1);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledWith(
        steer.groupId,
        expect.any(String),
        "applied",
      );
      expect(harness.state.hasQueuedRuns()).toBe(false);
      expect(harness.state.getSteerOutcome("trusted-steer")).toBe(
        committed ? "applied" : null,
      );
      expect(harness.execution.activeExecutionSnapshot()?.inputs).toHaveLength(
        2,
      );
      complete.mockRestore();
      await harness.execution.drain({ cancelActive: true });
      harness.state.close();
    },
  );

  it("retains active Tool provenance when the provider rejects a steer", async () => {
    const activeContexts: Array<ToolRunContext | null> = [];
    const harness = createHarness(activeContexts);
    const run = new FakeRun();
    harness.provider.runs.push(run);
    harness.provider.steerError = new Error("provider rejected steer");
    const runId = enqueue(harness.state, message("initial", "room:room-1"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const steer = selectSteer(harness.state, message("steer", "room:room-2"));

    await harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
    );

    expect(harness.state.getSteerOutcome("steer")).toBe("uncertain");
    expect(activeContexts).toEqual([
      {
        runId,
        sourceInboxIds: ["room:room-1"],
      },
    ]);
    expect(harness.execution.activeExecutionSnapshot()?.inputs).toHaveLength(1);
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it.each([false, true])(
    "reports terminal persistence failure during stop without retrying the Run (committed=%s)",
    async (committed) => {
      const harness = createHarness();
      const run = new FakeRun();
      harness.provider.runs.push(run);
      const runId = enqueue(harness.state, message("stopping"));
      harness.execution.start();
      await vi.waitFor(() => expect(run.waitCalls).toBe(1));
      const finish = harness.state.finishLocalRun.bind(harness.state);
      vi.spyOn(harness.state, "finishLocalRun").mockImplementation(
        (...args) => {
          if (committed) finish(...args);
          throw new Error("terminal response unavailable");
        },
      );
      harness.execution.requestDrain({ cancelActive: true });
      // The failure can settle before RuntimeShell reaches its awaited drain.
      await vi.waitFor(() =>
        expect(harness.state.finishLocalRun).toHaveBeenCalledOnce(),
      );
      await expect(
        harness.execution.drain({ cancelActive: true }),
      ).rejects.toThrow("terminal persistence failed");
      expect(harness.state.getLocalRun(runId)?.status).toBe(
        committed ? "canceled" : "running",
      );
      expect(harness.provider.starts).toHaveLength(1);
      harness.state.close();
    },
  );

  it("stop drain cancels the active Run and leaves queued work durable", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runningRunId = enqueue(harness.state, message("running"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const queuedRunId = enqueue(harness.state, message("queued"));

    await harness.execution.drain({ cancelActive: true });

    expect(harness.state.getLocalRun(runningRunId)).toMatchObject({
      status: "canceled",
      terminal: { type: "canceled" },
    });
    expect(harness.state.getLocalRun(queuedRunId)).toMatchObject({
      status: "queued",
      initialMessageIds: ["queued"],
    });
    expect(run.cancelCalls).toBe(1);
    expect(harness.provider.starts).toHaveLength(1);
    expect(harness.execution.activeOperations).toBe(0);
    harness.state.close();
  });
});

describe("RunLoop restart", () => {
  it("returns the active Run to the queue when the process stops for a restart", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("restarting"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));

    harness.execution.requestDrain({ cancelActive: true, resumable: true });
    // A later stop keeps the first stop's decision.
    await harness.execution.drain({ cancelActive: true });

    expect(harness.state.getLocalRun(runId)).toMatchObject({
      status: "queued",
    });
    expect(run.cancelCalls).toBe(1);
    expect(harness.log).toHaveBeenCalledWith(
      "info",
      "local_run.requeued_for_restart",
      { runId, attemptCount: 1 },
    );
    harness.state.close();
  });

  it("leaves the Run running for the next epoch when the requeue fails", async () => {
    const harness = createHarness();
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("restarting"));
    vi.spyOn(harness.state, "requeueLocalRun").mockImplementation(() => {
      throw new Error("TeamHub unavailable");
    });
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    harness.execution.requestDrain({ cancelActive: true, resumable: true });
    await harness.execution.drain({ cancelActive: true });
    expect(harness.state.getLocalRun(runId)?.status).toBe("running");
    harness.state.close();
  });

  it.each([
    { materialized: true, reminder: "was interrupted" },
    { materialized: false, reminder: "new native session" },
  ])(
    "reminds a resumed attempt once: %j",
    async ({ materialized, reminder }) => {
      const harness = createHarness(undefined, undefined, undefined, {
        provider: "pi",
        sessionId: "pi-session",
        lingerMaterialized: materialized,
      });
      const claim = harness.state.claimLocalRun.bind(harness.state);
      vi.spyOn(harness.state, "claimLocalRun").mockImplementation(() => {
        const run = claim();
        return run ? { ...run, attemptCount: 2 } : null;
      });
      const run = new FakeRun();
      harness.provider.runs.push(run);
      enqueue(harness.state, message("resumed", "room:room-1"));
      harness.execution.start();
      await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
      const input = harness.provider.starts[0]!.input;
      const text = input.type === "text" ? input.text : "";
      expect(text).toContain(reminder);
      expect(text.match(/<system-reminder>/gu)).toHaveLength(1);
      run.complete("done");
      await harness.execution.drain({ cancelActive: false });
      harness.state.close();
    },
  );
});

describe("RunLoop session compaction", () => {
  const compactingHarness = () => {
    const harness = createHarness();
    const gate = deferred<void>();
    const calls: Array<{ instructions?: string; signal: AbortSignal }> = [];
    harness.provider.compactSession = async (session, options) => {
      calls.push(options);
      await Promise.race([
        gate.promise,
        new Promise((_, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(new Error("compaction interrupted")),
          ),
        ),
      ]);
      (session as { lastTerminalTurn?: string }).lastTerminalTurn =
        "compaction-turn";
      return { status: "compacted", preTokens: 40_000 };
    };
    return { ...harness, gate, calls };
  };

  it("checkpoints the session updated in place and stays idle while compacting", async () => {
    const harness = compactingHarness();
    harness.state.setRuntimeSession({ threadId: "thread-1" });
    const compacting = harness.execution.compactSession({
      instructions: "keep task ids",
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(harness.calls).toHaveLength(1));
    expect(harness.calls[0]!.instructions).toBe("keep task ids");
    expect(harness.execution.activeOperations).toBe(0);
    harness.gate.resolve();
    await expect(compacting).resolves.toEqual({
      status: "compacted",
      preTokens: 40_000,
    });
    expect(harness.state.getRuntimeSession()).toEqual({
      threadId: "thread-1",
      lastTerminalTurn: "compaction-turn",
    });
    harness.state.close();
  });

  it("aborts compaction for new work and runs the input right after", async () => {
    const harness = compactingHarness();
    harness.state.setRuntimeSession({ threadId: "thread-1" });
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const compacting = harness.execution.compactSession({
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(harness.calls).toHaveLength(1));
    enqueue(harness.state, message("arrived-during-compaction"));
    harness.execution.notifyWorkAvailable();
    // No Run starts on the native session until compaction has settled.
    expect(harness.provider.starts).toHaveLength(0);
    await expect(compacting).resolves.toEqual({ status: "input_arrived" });
    expect(harness.state.getRuntimeSession()).toEqual({
      threadId: "thread-1",
    });
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("refuses to compact with pending work, an unborn session, or no native support", async () => {
    const signal = new AbortController().signal;
    const busy = compactingHarness();
    enqueue(busy.state, message("queued"));
    await expect(busy.execution.compactSession({ signal })).resolves.toEqual({
      status: "busy",
    });
    expect(busy.calls).toHaveLength(0);
    busy.state.close();

    const unborn = createHarness(undefined, undefined, undefined, {
      threadId: "",
    });
    unborn.provider.compactSession = vi.fn();
    await expect(unborn.execution.compactSession({ signal })).resolves.toEqual({
      status: "nothing_to_compact",
    });
    expect(unborn.provider.compactSession).not.toHaveBeenCalled();
    unborn.state.close();

    const unsupported = createHarness();
    await expect(
      unsupported.execution.compactSession({ signal }),
    ).resolves.toEqual({ status: "unsupported" });
    unsupported.state.close();
  });

  it("reports a Runtime that cannot compact now without a checkpoint", async () => {
    const harness = createHarness();
    harness.state.setRuntimeSession({ threadId: "thread-1" });
    const setRuntimeSession = vi.spyOn(harness.state, "setRuntimeSession");
    harness.provider.compactSession = async () => ({ status: "unavailable" });
    await expect(
      harness.execution.compactSession({
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(setRuntimeSession).not.toHaveBeenCalled();
    harness.state.close();
  });

  it("surfaces a compaction failure that was not caused by new work", async () => {
    const harness = createHarness();
    harness.provider.compactSession = async () => {
      throw new Error("Runtime compaction failed");
    };
    await expect(
      harness.execution.compactSession({
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Runtime compaction failed");
    harness.state.close();
  });
});

describe("RunLoop injected feature ports", () => {
  const CONTRIBUTION = "test-context-directive";
  const contributingDeclaration = (
    contribute: (message: Message) => { text: string } | null,
  ): FeatureDeclaration =>
    defineFeature({
      id: "test-input-contribution",
      context: {
        ports: { prepareInput: {} },
        create: () => ({
          prepareInput: (_view, message) => contribute(message),
        }),
      },
    });
  const markerContribution = contributingDeclaration((current) => ({
    text: `${CONTRIBUTION}:${current.messageId}`,
  }));

  it("delivers injected input contributions to the Provider on start and steer", async () => {
    const harness = createHarness(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { declarations: [markerContribution] },
    );
    const run = new FakeRun();
    harness.provider.runs.push(run);
    enqueue(harness.state, message("initial-ok"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    expect(harness.provider.starts[0]!.input.text).toContain("initial-ok");
    expect(harness.provider.starts[0]!.input.text).toContain(
      `${CONTRIBUTION}:initial-ok`,
    );
    const steer = selectSteer(
      harness.state,
      message("steer-ok", "room:room-9"),
    );
    await harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
    );
    expect(harness.provider.steers).toHaveLength(1);
    expect(harness.provider.steers[0]!.options.input.text).toContain(
      "steer-ok",
    );
    expect(harness.provider.steers[0]!.options.input.text).toContain(
      `${CONTRIBUTION}:steer-ok`,
    );
    expect(harness.state.getSteerOutcome("steer-ok")).toBe("applied");
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("replays identical formatted input for the same Message across a start requeue", async () => {
    const harness = createHarness(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { declarations: [markerContribution] },
    );
    const run = new FakeRun();
    harness.provider.runs.push(run);
    harness.provider.startErrors.push(
      new ProviderRunStartError(
        "definitely_not_started",
        "transient start failure",
      ),
    );
    const runId = enqueue(harness.state, message("replay-me"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(2));
    expect(harness.provider.starts[0]!.input).toEqual(
      harness.provider.starts[1]!.input,
    );
    expect(harness.provider.starts[1]!.input.text).toContain("replay-me");
    expect(harness.provider.starts[1]!.input.text).toContain(
      `${CONTRIBUTION}:replay-me`,
    );
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded");
    harness.state.close();
  });

  it("fails the claimed Run instead of suspending it when an input contribution throws", async () => {
    const failure = new Error("contribution exploded");
    const harness = createHarness(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        declarations: [
          contributingDeclaration(() => {
            throw failure;
          }),
        ],
      },
    );
    const runId = enqueue(harness.state, message("boom"));
    harness.execution.start();
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(runId)).toMatchObject({
        status: "failed",
        terminal: { type: "failed", error: "contribution exploded" },
      }),
    );
    expect(harness.provider.starts).toHaveLength(0);
    expect(harness.state.hasQueuedRuns()).toBe(false);
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
  });

  it("folds a committed steer assignment back into the queue when its input contribution throws", async () => {
    const failure = new Error("steer contribution exploded");
    const harness = createHarness(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        declarations: [
          contributingDeclaration((current) => {
            if (current.messageId === "steer-bad") throw failure;
            return null;
          }),
        ],
      },
    );
    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("initial-ok"));
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    const steer = selectSteer(
      harness.state,
      message("steer-bad", "room:room-9"),
    );
    await harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
    );
    expect(harness.provider.steers).toHaveLength(0);
    await vi.waitFor(() => expect(harness.state.hasQueuedRuns()).toBe(true));
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    // drain() stops the loop; the folded steer stays durable queued work.
    const steerRun = [...harness.state.state.runs.values()].find((entry) =>
      entry.initialMessageIds.includes("steer-bad"),
    );
    expect(steerRun?.status).toBe("queued");
    expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded");
    // Restarting lets the loop claim it; the same contribution failure lands
    // on the start boundary as a failed terminal instead of a hung claim.
    harness.execution.start();
    await vi.waitFor(() =>
      expect(harness.state.getLocalRun(steerRun!.runId)).toMatchObject({
        status: "failed",
        terminal: { type: "failed", error: "steer contribution exploded" },
      }),
    );
    await harness.execution.drain({ cancelActive: false });
    expect(harness.state.hasQueuedRuns()).toBe(false);
    expect(harness.execution.activeOperations).toBe(0);
    harness.state.close();
  });

  it("routes each RunEvent through the injected projection once before publishing", async () => {
    const ref: ExecutionContextRef = {
      kind: "meta",
      agentId: "agent-1",
      roomId: "room-1",
    };
    const { composed } = createTestFeatureAssembly({ ref });
    const onRunEvent = vi.fn((event: RunEvent) => composed.onRunEvent(event));
    const publisher = new RecordingRuntimeStatusPublisher();
    const harness = createHarness(
      undefined,
      undefined,
      publisher,
      undefined,
      ref,
      undefined,
      { onRunEvent },
    );
    const events: RunEvent[] = [
      { type: "status.changed", status: "working" },
      { type: "message.delta", messageId: "m-1", delta: "hello" },
      {
        type: "activity.started",
        activityId: "activity-1",
        kind: "tool",
        title: "Bash",
      },
    ];
    const run = new FakeRun(events);
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("events"));
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    expect(onRunEvent.mock.calls.map((call) => call[0])).toEqual(events);
    expect(publisher.sessions).toHaveLength(1);
    expect(publisher.sessions[0]!.updates).toEqual([
      { type: "status.changed", status: "working" },
      {
        type: "activity.started",
        activityId: "activity-1",
        kind: "tool",
        title: "Bash",
      },
    ]);
    expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded");
    harness.state.close();
  });

  it("invokes the Run-event projection when no status publisher is configured", async () => {
    const ref: ExecutionContextRef = {
      kind: "meta",
      agentId: "agent-1",
      roomId: "room-1",
    };
    const { composed } = createTestFeatureAssembly({ ref });
    const onRunEvent = vi.fn((event: RunEvent) => composed.onRunEvent(event));
    const harness = createHarness(
      undefined,
      undefined,
      undefined,
      undefined,
      ref,
      undefined,
      { onRunEvent },
    );
    const events: RunEvent[] = [
      { type: "status.changed", status: "working" },
      { type: "message.delta", messageId: "m-1", delta: "hello" },
    ];
    const run = new FakeRun(events);
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("no-publisher"));
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    expect(onRunEvent.mock.calls.map((call) => call[0])).toEqual(events);
    expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded");
    expect(
      harness.log.mock.calls.some(
        (call) => call[1] === "local_run.first_output",
      ),
    ).toBe(true);
    harness.state.close();
  });

  it("invokes the Run-event projection when the status session fails to open", async () => {
    const ref: ExecutionContextRef = {
      kind: "meta",
      agentId: "agent-1",
      roomId: "room-1",
    };
    const { composed } = createTestFeatureAssembly({ ref });
    const onRunEvent = vi.fn((event: RunEvent) => composed.onRunEvent(event));
    const publisher = new OpenFailureRuntimeStatusPublisher();
    const harness = createHarness(
      undefined,
      undefined,
      publisher,
      undefined,
      ref,
      undefined,
      { onRunEvent },
    );
    const events: RunEvent[] = [
      { type: "status.changed", status: "working" },
      {
        type: "tool.called",
        toolName: "Bash",
        callId: "call-1",
        input: { command: "ls" },
      },
    ];
    const run = new FakeRun(events);
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("open-failure"));
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    expect(publisher.opened).toBe(1);
    expect(onRunEvent.mock.calls.map((call) => call[0])).toEqual(events);
    expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded");
    expect(
      harness.log.mock.calls.some(
        (call) => call[1] === "runtime_status.open_failed",
      ),
    ).toBe(true);
    expect(
      harness.log.mock.calls.some(
        (call) => call[1] === "local_run.first_output",
      ),
    ).toBe(true);
    harness.state.close();
  });

  it("keeps the Run and status publisher behavior unchanged when the injected projection throws", async () => {
    const publisher = new RecordingRuntimeStatusPublisher();
    const harness = createHarness(
      undefined,
      undefined,
      publisher,
      undefined,
      undefined,
      undefined,
      {
        onRunEvent: () => {
          throw new Error("projection exploded");
        },
      },
    );
    const events: RunEvent[] = [
      { type: "status.changed", status: "working" },
      {
        type: "activity.started",
        activityId: "activity-1",
        kind: "tool",
        title: "Bash",
      },
    ];
    const run = new FakeRun(events);
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, message("projection-failure"));
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    expect(harness.state.getLocalRun(runId)).toMatchObject({
      status: "succeeded",
      terminal: { type: "succeeded" },
    });
    expect(publisher.sessions).toHaveLength(1);
    expect(publisher.sessions[0]!.updates).toEqual([]);
    expect(
      harness.log.mock.calls.some(
        (call) => call[1] === "runtime_status.event_stream_failed",
      ),
    ).toBe(true);
    harness.state.close();
  });

  it("preserves canonical Message fields while merging contributions", () => {
    const { ports } = createTestFeatureAssembly({
      ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
      declarations: [markerContribution],
    });
    const original: Message = {
      ...message("rich-message", "room:room-1"),
      documentReferences: [
        { documentId: "doc-1", documentVersionId: "doc-v1" },
      ],
      invocationMessageIds: ["invoked-1", "invoked-2"],
      segments: [
        { type: "text", content: "rich-message" },
        {
          type: "document",
          content: "Doc",
          document_id: "doc-1",
        },
      ],
    };
    const prepared = ports.prepareInput(original);
    expect(prepared.messageId).toBe("rich-message");
    expect(prepared.sourceInboxIds).toEqual(["room:room-1"]);
    expect(prepared.documentReferences).toEqual([
      { documentId: "doc-1", documentVersionId: "doc-v1" },
    ]);
    expect(prepared.invocationMessageIds).toEqual(["invoked-1", "invoked-2"]);
    expect(prepared.rawMessage).toContain("rich-message");
    expect(prepared.rawMessage).toContain(`${CONTRIBUTION}:rich-message`);
    expect(prepared.segments.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps durable canonical notification Messages clean while real reply-rhythm reaches the Provider on start, steer, and requeue", async () => {
    const ref: ExecutionContextRef = {
      kind: "meta",
      agentId: "agent-1",
      roomId: "room-1",
    };
    const rhythmSettings: ReplyRhythmSettings = {
      enabled: true,
      version: "test-v",
      minMessageCount: 2,
      maxMessageCount: 4,
      activationRate: 1,
    };
    const harness = createHarness(
      undefined,
      undefined,
      undefined,
      undefined,
      ref,
      undefined,
      { agentType: "anotherme", replyRhythmSettings: rhythmSettings },
    );
    const { ports } = createTestFeatureAssembly({
      ref,
      agentType: "anotherme",
      replyRhythmSettings: rhythmSettings,
    });
    const canonicalOf = (
      inputId: string,
      through: string,
      acceptedMessages: readonly {
        id: string;
        sequence: string;
        body: string;
        author: string;
        mentioned: boolean;
        resourceReferences?: readonly {
          document_id: string;
          document_version_id?: string;
        }[];
        teamProtocol?: string;
      }[],
    ): Message =>
      renderAcceptedNotification(
        {
          messageId: inputId,
          sourceInboxIds: ["room:room-1"],
          acceptedNotification: {
            inboxId: "room:room-1",
            after: String(Number(through) - acceptedMessages.length),
            through,
            messages: acceptedMessages,
          },
        },
        ports.notificationContext,
      );
    const canonical = canonicalOf("canonical-input", "2", [
      {
        id: "room-message-1",
        sequence: "1",
        body: "canonical first line",
        author: "Leo",
        mentioned: true,
        resourceReferences: [
          { document_id: "doc-1", document_version_id: "doc-v1" },
        ],
        teamProtocol: "round_robin",
      },
      {
        id: "room-message-2",
        sequence: "2",
        body: "canonical second line",
        author: "Leo",
        mentioned: false,
      },
    ]);
    // Canonical rebuild keeps durable IDs/references/provenance and the real
    // notification-context contribution; transient prompt additions stay out.
    expect(canonical.messageId).toBe("canonical-input");
    expect(canonical.documentReferences).toEqual([
      { documentId: "doc-1", documentVersionId: "doc-v1" },
    ]);
    expect(canonical.rawMessage).toContain("canonical first line");
    expect(canonical.rawMessage).toContain("Collaboration protocol published");
    expect(canonical.rawMessage).not.toContain("<reply-rhythm>");

    const run = new FakeRun();
    harness.provider.runs.push(run);
    const runId = enqueue(harness.state, canonical);
    harness.execution.start();
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(1));
    expect(harness.provider.starts[0]!.input.text).toContain(
      "canonical first line",
    );
    expect(harness.provider.starts[0]!.input.text).toContain("<reply-rhythm>");
    expect(harness.provider.starts[0]!.spec.runContext?.messageIds).toEqual([
      "canonical-input",
    ]);
    expect(harness.provider.starts[0]!.spec.runContext?.sourceInboxIds).toEqual(
      ["room:room-1"],
    );
    expect(
      harness.provider.starts[0]!.spec.runContext?.documentReferences,
    ).toEqual([{ documentId: "doc-1", documentVersionId: "doc-v1" }]);

    const steerCanonical = canonicalOf("canonical-steer", "3", [
      {
        id: "room-message-3",
        sequence: "3",
        body: "steer canonical line",
        author: "Leo",
        mentioned: true,
      },
    ]);
    const requeueCanonical = canonicalOf("canonical-requeue", "4", [
      {
        id: "room-message-4",
        sequence: "4",
        body: "requeue canonical line",
        author: "Leo",
        mentioned: true,
      },
    ]);
    const steer = selectSteer(harness.state, steerCanonical);
    const retriedRun = new FakeRun();
    harness.provider.runs.push(retriedRun);
    harness.provider.startErrors.push(
      new ProviderRunStartError(
        "definitely_not_started",
        "transient start failure",
      ),
    );
    const requeueRunId = enqueue(harness.state, requeueCanonical);
    await harness.execution.steer(
      steer.groupId,
      steer.messages,
      new AbortController().signal,
    );
    expect(harness.provider.steers).toHaveLength(1);
    expect(harness.provider.steers[0]!.options.input.text).toContain(
      "steer canonical line",
    );
    expect(harness.provider.steers[0]!.options.input.text).toContain(
      "<reply-rhythm>",
    );
    expect(harness.provider.steers[0]!.options.runContext?.messageIds).toEqual([
      "canonical-steer",
    ]);
    run.complete("done");
    await vi.waitFor(() => expect(harness.provider.starts).toHaveLength(3));
    // The requeue retry replays the same canonical input byte-identically,
    // rhythm included.
    expect(harness.provider.starts[1]!.input).toEqual(
      harness.provider.starts[2]!.input,
    );
    expect(harness.provider.starts[2]!.input.text).toContain(
      "requeue canonical line",
    );
    expect(harness.provider.starts[2]!.input.text).toContain("<reply-rhythm>");
    retriedRun.complete("done");
    await harness.execution.drain({ cancelActive: false });
    expect(harness.state.getLocalRun(runId)?.status).toBe("succeeded");
    expect(harness.state.getLocalRun(requeueRunId)?.status).toBe("succeeded");
    expect(harness.state.getSteerOutcome("canonical-steer")).toBe("applied");
    const storedMessages = [
      "canonical-input",
      "canonical-steer",
      "canonical-requeue",
    ].map((id) => harness.state.state.inputs.get(id)?.message);
    for (const stored of storedMessages) {
      expect(stored?.rawMessage).not.toContain("<reply-rhythm>");
    }
    expect(storedMessages[0]?.rawMessage).toBe(canonical.rawMessage);
    harness.state.close();
  });
});

class FakeRun implements AgentRun {
  readonly events: AsyncIterable<RunEvent>;
  readonly #result = deferred<RunResult>();
  cancelCalls = 0;
  rejectWaitOnCancel = true;
  waitCalls = 0;

  constructor(events: readonly RunEvent[] = []) {
    this.events = (async function* () {
      yield* events;
    })();
  }

  wait(): Promise<RunResult> {
    this.waitCalls += 1;
    return this.#result.promise;
  }

  cancel(): void {
    this.cancelCalls += 1;
    if (this.rejectWaitOnCancel && this.waitCalls > 0) {
      this.#result.reject(new Error("provider run canceled"));
    }
  }

  complete(finalResponse: string): void {
    this.#result.resolve({ finalResponse });
  }

  fail(error: Error): void {
    this.#result.reject(error);
  }
}

class FakeProvider implements AgentProvider {
  acquireRunCapacity?: (signal: AbortSignal) => Promise<() => void>;
  compactSession?: AgentProvider["compactSession"];
  readonly runs: AgentRun[] = [];
  readonly starts: Array<{
    session: RuntimeSession;
    input: AgentInput;
    spec: ExecutionSpec;
  }> = [];
  readonly steers: Array<{ run: AgentRun; options: ProviderSteerOptions }> = [];
  readonly startErrors: Error[] = [];
  startGate: Deferred<AgentRun> | undefined;
  steerGate: Deferred<void> | undefined;
  steerError: Error | undefined;
  clearRunResourcesCalls = 0;
  initializeThreadId: string | undefined;

  async createSession(
    _options: ProviderSessionOptions,
  ): Promise<RuntimeSession> {
    return {};
  }

  async resumeSession(
    session: RuntimeSession,
    _options: ProviderSessionOptions,
  ): Promise<RuntimeSession> {
    return session;
  }

  async startRun(
    session: RuntimeSession,
    input: AgentInput,
    spec: ExecutionSpec,
  ): Promise<AgentRun> {
    this.starts.push({ session, input, spec });
    if (
      this.initializeThreadId &&
      typeof session === "object" &&
      session !== null &&
      "threadId" in session
    ) {
      (session as { threadId: string }).threadId = this.initializeThreadId;
    }
    const startError = this.startErrors.shift();
    if (startError) throw startError;
    if (this.startGate) return await this.startGate.promise;
    const run = this.runs.shift();
    if (!run) throw new Error("Fake provider has no queued Run");
    return run;
  }

  async clearRunResources(_session: RuntimeSession): Promise<void> {
    this.clearRunResourcesCalls += 1;
  }

  async steer(
    run: AgentRun,
    options: ProviderSteerOptions,
  ): Promise<{ turnId: string }> {
    this.steers.push({ run, options });
    if (this.steerGate) await this.steerGate.promise;
    if (this.steerError) throw this.steerError;
    return { turnId: `turn-${this.steers.length}` };
  }

  async close(): Promise<void> {}
}

const createHarness = (
  activeContexts?: Array<ToolRunContext | null>,
  existingState?: ContextRuntimeState,
  runtimeStatusPublisher?: RuntimeStatusPublisher,
  runtimeSession: RuntimeSession = { threadId: "thread-1" },
  executionContextRef: ExecutionContextRef = {
    kind: "meta",
    agentId: "agent-1",
    roomId: "room-1",
  },
  activationFinishedAtMs?: () => number | undefined,
  features?: {
    readonly agentType?: "general" | "anotherme";
    readonly declarations?: readonly FeatureDeclaration[];
    readonly prepareInput?: ExecutorFeaturePorts["prepareInput"];
    readonly onRunEvent?: ExecutorFeaturePorts["onRunEvent"];
    readonly replyRhythmSettings?: ReplyRhythmSettings;
  },
) => {
  const state =
    existingState ??
    new ContextRuntimeState({
      databasePath: ":memory:",
      ref: executionContextRef,
    });
  // A status stream opens under the epoch that claimed the Run.
  if (runtimeStatusPublisher && !("executionEpoch" in state))
    Object.assign(state, { executionEpoch: () => "agent-epoch-1" });
  const provider = new FakeProvider();
  const log = vi.fn();
  const logger = {
    ...createAgentLogger({ component: "local-run-test" }),
    log,
  };
  const { ports } = createTestFeatureAssembly({
    ref: executionContextRef,
    ...(features?.agentType ? { agentType: features.agentType } : {}),
    ...(features?.declarations ? { declarations: features.declarations } : {}),
    ...(features?.replyRhythmSettings
      ? { replyRhythmSettings: features.replyRhythmSettings }
      : {}),
  });
  const executionPorts = {
    prepareInput: features?.prepareInput ?? ports.prepareInput,
    onRunEvent: features?.onRunEvent ?? ports.onRunEvent,
  };
  const execution = new RunLoop({
    executionContextRef,
    logger,
    provider,
    runtimeName: "pi",
    runtimeSession,
    ...(runtimeStatusPublisher ? { runtimeStatusPublisher } : {}),
    ...(activationFinishedAtMs ? { activationFinishedAtMs } : {}),
    state,
    ...(activeContexts
      ? {
          onActiveRunContextChanged: (context) => activeContexts.push(context),
        }
      : {}),
    ...executionPorts,
  });
  return { execution, provider, state, log, executionPorts };
};

class RecordingRuntimeStatusSession implements RuntimeStatusSession {
  readonly updates: RuntimeStatusUpdate[] = [];

  publish(updates: readonly RuntimeStatusUpdate[]): void {
    this.updates.push(...updates);
  }
}

class RecordingRuntimeStatusPublisher implements RuntimeStatusPublisher {
  readonly opened: Array<Parameters<RuntimeStatusPublisher["open"]>[0]> = [];
  readonly sessions: RecordingRuntimeStatusSession[] = [];

  async open(
    input: Parameters<RuntimeStatusPublisher["open"]>[0],
  ): Promise<RuntimeStatusSession> {
    this.opened.push(input);
    const session = new RecordingRuntimeStatusSession();
    this.sessions.push(session);
    return session;
  }

  async close(): Promise<void> {}
}

class OpenFailureRuntimeStatusPublisher implements RuntimeStatusPublisher {
  opened = 0;

  async open(): Promise<RuntimeStatusSession> {
    this.opened += 1;
    throw new Error("status backend unavailable");
  }

  async close(): Promise<void> {}
}

class FailingOnceRuntimeStatusSession implements RuntimeStatusSession {
  readonly updates: RuntimeStatusUpdate[] = [];
  readonly failed = deferred<void>();
  #failed = false;

  publish(updates: readonly RuntimeStatusUpdate[]): void | Promise<void> {
    if (!this.#failed) {
      this.#failed = true;
      this.failed.resolve();
      return Promise.reject(new Error("temporary presentation failure"));
    }
    this.updates.push(...updates);
  }
}

class FailingOnceRuntimeStatusPublisher implements RuntimeStatusPublisher {
  readonly session = new FailingOnceRuntimeStatusSession();

  async open(): Promise<RuntimeStatusSession> {
    return this.session;
  }

  async close(): Promise<void> {}
}
const enqueue = (state: ContextRuntimeState, value: Message): string =>
  state.enqueueTrustedTurn([value]);

const selectSteer = (state: ContextRuntimeState, value: Message) =>
  state.openSteerGroup([value]);

const message = (
  messageId: string,
  sourceInboxId?: string,
  causationMessageId?: string,
): Message => ({
  messageId,
  rawMessage: messageId,
  segments: [{ type: "text", content: messageId }],
  ...(sourceInboxId ? { sourceInboxIds: [sourceInboxId] } : {}),
  ...(causationMessageId ? { causationMessageId } : {}),
});

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

const settleAsyncWork = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("RunLoop end-to-end latency", () => {
  // Runs one Local Run and returns its provider_ready log fields.
  const runOnce = async (options: {
    inputReceivedAtMs: number | undefined;
    activationFinishedAtMs?: number;
    processReused?: boolean;
    dispatchedAtUnixMs?: number;
    events?: RunEvent[];
    ref?: ExecutionContextRef;
  }): Promise<{
    ready: Record<string, unknown> | undefined;
    log: ReturnType<typeof vi.fn>;
  }> => {
    const offered = vi.fn(async () => undefined);
    const publisher: RuntimeStatusPublisher = {
      open: async () => ({ publish: offered }),
      close: async () => undefined,
    };
    const harness = createHarness(
      undefined,
      undefined,
      publisher,
      undefined,
      options.ref,
      () => options.activationFinishedAtMs,
    );
    const claim = harness.state.claimLocalRun.bind(harness.state);
    Object.assign(harness.state, {
      claimLocalRun: () => {
        const claimed = claim();
        return claimed && options.inputReceivedAtMs !== undefined
          ? { ...claimed, inputReceivedAtMs: options.inputReceivedAtMs }
          : claimed;
      },
    });
    const run = new FakeRun(options.events ?? []);
    if (options.processReused !== undefined)
      Object.assign(run, { processReused: options.processReused });
    if (options.dispatchedAtUnixMs !== undefined)
      Object.assign(run, { dispatchedAtUnixMs: options.dispatchedAtUnixMs });
    harness.provider.runs.push(run);
    enqueue(harness.state, message("e2e"));
    harness.execution.start();
    await vi.waitFor(() => expect(run.waitCalls).toBe(1));
    if (options.events?.length)
      await vi.waitFor(() =>
        expect(
          harness.log.mock.calls.some(
            (call) => call[1] === "local_run.first_output",
          ),
        ).toBe(true),
      );
    run.complete("done");
    await harness.execution.drain({ cancelActive: false });
    harness.state.close();
    const ready = harness.log.mock.calls.find(
      (call) => call[1] === "local_run.provider_ready",
    )?.[2] as Record<string, unknown> | undefined;
    return { ready, log: harness.log };
  };
  const output: RunEvent[] = [
    { type: "message.delta", messageId: "m", delta: "a" },
    { type: "message.delta", messageId: "m", delta: "b" },
    { type: "tool.called", callId: "t", toolName: "Bash", input: "{}" },
  ];

  it("labels a warm reused Run", async () => {
    const now = Date.now();
    const { ready } = await runOnce({
      inputReceivedAtMs: now - 500,
      activationFinishedAtMs: now - 1_000,
      processReused: true,
      events: output,
    });
    expect(ready).toMatchObject({
      end_to_end_ms: expect.any(Number),
      activation: "warm",
      process: "reused",
    });
    expect(ready!.end_to_end_ms).toBeGreaterThan(400);
  });

  it("marks a Run cold when its activation finished after the input arrived", async () => {
    const now = Date.now();
    const { ready } = await runOnce({
      inputReceivedAtMs: now - 500,
      activationFinishedAtMs: now - 100,
      processReused: false,
    });
    expect(ready).toMatchObject({ activation: "cold", process: "spawned" });
  });

  it("uses unknown process when the Daemon does not report reuse", async () => {
    const now = Date.now();
    const { ready } = await runOnce({ inputReceivedAtMs: now - 50 });
    expect(ready).toMatchObject({ activation: "warm", process: "unknown" });
  });

  it("clamps clock skew to zero", async () => {
    const { ready } = await runOnce({
      inputReceivedAtMs: Date.now() + 60_000,
      events: output,
    });
    expect(ready).toMatchObject({ end_to_end_ms: 0 });
  });

  it("uses the Computer-reported dispatch time", async () => {
    const baseline = Date.now() - 5_000;
    const { ready, log } = await runOnce({
      inputReceivedAtMs: baseline,
      dispatchedAtUnixMs: baseline + 1_000,
    });
    expect(ready).toMatchObject({
      end_to_end_ms: 1_000,
      dispatchedAtUnixMs: baseline + 1_000,
      receivedAtUnixMs: expect.any(Number),
    });
    expect(
      log.mock.calls.some(
        (call) => call[1] === "local_run.end_to_end_reported_time_out_of_range",
      ),
    ).toBe(false);
  });

  it("falls back to the receipt time when the reported time is out of range", async () => {
    const baseline = Date.now() - 5_000;
    const { ready, log } = await runOnce({
      inputReceivedAtMs: baseline,
      dispatchedAtUnixMs: baseline - 1_000,
    });
    expect(ready!.end_to_end_ms).toBeGreaterThanOrEqual(5_000);
    expect(
      log.mock.calls
        .filter(
          (call) =>
            call[0] === "warn" &&
            call[1] === "local_run.end_to_end_reported_time_out_of_range",
        )
        .map((call) => call[2].stage),
    ).toEqual(["provider_ready"]);
  });

  it("omits end-to-end fields without an input receipt time", async () => {
    const { ready } = await runOnce({
      inputReceivedAtMs: undefined,
      events: output,
    });
    expect(ready).toBeDefined();
    expect(ready).not.toHaveProperty("end_to_end_ms");
  });
});
