import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPUTER_OFFLINE_MESSAGE,
  createRuntimeModelCall,
  isComputerOffline,
  ModelCallError,
  type ModelPlacement,
  type ModelChainLease,
  type RuntimeModelGateway,
  type RuntimeModelInfo,
} from "../src/runtime-model-call.js";
import { runtimeModelGateway } from "../src/agent/runner-gateway/runtime-model-gateway.js";
import { LocalComputerOfflineError } from "../src/agent/runner-gateway/local-computer-management.js";
import { RunnerModelInvokeUnavailableError } from "../src/agent/runner-gateway/runner-model-invocation.js";
import type { ModelCallLog } from "../src/model-call-log.js";

type Invoke = RuntimeModelGateway["invokeModel"];
type Outcome = Awaited<ReturnType<Invoke>>;

const alice: ModelPlacement = {
  tenantId: "tenant_1",
  ownerActorId: "alice",
  agentId: "agent_alice",
  computerId: "computer_alice",
  runtimeType: "codex",
  agentActorId: "another_me_alice",
};
const bob: ModelPlacement = {
  ...alice,
  ownerActorId: "bob",
  agentId: "agent_bob",
  computerId: "computer_bob",
  runtimeType: "claude",
  agentActorId: "another_me_bob",
};

const completed = (text: string, model?: string): Outcome => ({
  outcome: "completed",
  text,
  ...(model ? { model } : {}),
  duration_ms: 10,
});

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } },
};

function setup(
  options: {
    placements?: readonly ModelPlacement[];
    ready?: (computerId: string, runtime: string) => boolean;
    outcomes?: (Outcome | Error)[];
    /** Answers every invocation instead of the outcome list. */
    invoke?: Invoke;
    lease?: ModelChainLease;
    callLog?: ModelCallLog;
    runtimeModels?: RuntimeModelGateway["runtimeModels"];
  } = {},
) {
  const outcomes = [...(options.outcomes ?? [completed('{"answer":"yes"}')])];
  const invokeModel = vi.fn<Invoke>(
    options.invoke ??
      (async () => {
        const next = outcomes.shift() ?? completed('{"answer":"yes"}');
        if (next instanceof Error) throw next;
        return next;
      }),
  );
  const supportsModelInvoke = vi.fn(options.ready ?? (() => true));
  const acquireModelChain = vi.fn<RuntimeModelGateway["acquireModelChain"]>(
    async () => options.lease ?? { release: () => {} },
  );
  const placements = vi.fn(async () => options.placements ?? [alice, bob]);
  let time = 0;
  const logger = { log: vi.fn() };
  const modelCall = createRuntimeModelCall({
    gateway: {
      invokeModel,
      supportsModelInvoke,
      runtimeModels: options.runtimeModels ?? (() => []),
      acquireModelChain,
    },
    placements,
    logger,
    ...(options.callLog ? { callLog: options.callLog } : {}),
    now: () => time,
  });
  return {
    modelCall,
    logger,
    invokeModel,
    acquireModelChain,
    supportsModelInvoke,
    placements,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const work = { kind: "memory", key: "test" } as const;
const ask = {
  ...work,
  schemaName: "answer",
  outputSchema: schema,
  timeoutMs: 60_000,
};

describe("Runtime model call", () => {
  it("runs on the owner's Another Me Computer with its Runtime and low effort", async () => {
    const { modelCall, invokeModel } = setup();
    await expect(
      modelCall.call({
        ...ask,
        owner: { tenantId: "tenant_1", ownerActorId: "bob" },
        instructions: "Answer.",
        input: "Question?",
      }),
    ).resolves.toEqual({ output: { answer: "yes" }, model: "claude" });
    expect(invokeModel).toHaveBeenCalledWith(
      "computer_bob",
      expect.objectContaining({
        tenantId: "tenant_1",
        ownerActorId: "bob",
        agentId: "agent_bob",
        runtimeType: "claude",
        mode: "structured",
        reasoningEffort: "low",
        instructions: "Answer.",
        input: "Question?",
        outputSchema: schema,
        timeoutMs: 60_000,
        queue: { priority: 40, kind: "memory", key: "test" },
      }),
    );
    await modelCall.text({
      kind: "approval",
      key: "test",
      owner: { tenantId: "tenant_1", ownerActorId: "bob" },
      input: "Now?",
      timeoutMs: 1_000,
      runOperationId: "operation_1",
    });
    expect(invokeModel).toHaveBeenLastCalledWith(
      "computer_bob",
      expect.objectContaining({
        timeoutMs: 1_000,
        queue: {
          priority: 0,
          kind: "approval",
          key: "test",
          runOperationId: "operation_1",
        },
      }),
    );
    // A voice ask never queues.
    await modelCall.text({
      kind: "voice_ask",
      key: "ask",
      owner: { tenantId: "tenant_1", ownerActorId: "bob" },
      input: "What did they say?",
    });
    expect(invokeModel.mock.lastCall![1]).not.toHaveProperty("queue");
  });

  it("runs a workspace call on a named Another Me and returns its files", async () => {
    const { modelCall, invokeModel, placements } = setup({
      outcomes: [
        {
          outcome: "completed",
          workspace_files: [
            {
              path: "topics/a.json",
              content_base64: Buffer.from("{}").toString("base64"),
            },
          ],
          duration_ms: 10,
        },
      ],
    });
    const result = await modelCall.workspace({
      ...work,
      anotherMe: { tenantId: "tenant_1", agentActorId: "another_me_bob" },
      input: "Write the page.",
      files: [{ path: "inputs/a.md", content: Buffer.from("# A") }],
      timeoutMs: 1_000,
    });
    expect(placements).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    expect(invokeModel).toHaveBeenCalledWith(
      "computer_bob",
      expect.objectContaining({
        mode: "workspace",
        agentId: "agent_bob",
        workspaceFiles: [
          {
            path: "inputs/a.md",
            content_base64: Buffer.from("# A").toString("base64"),
          },
        ],
      }),
    );
    expect(result.model).toBe("claude");
    expect(
      result.output.map((file) => [
        file.path,
        Buffer.from(file.content).toString(),
      ]),
    ).toEqual([["topics/a.json", "{}"]]);
    await expect(
      modelCall.workspace({
        ...work,
        anotherMe: { tenantId: "tenant_1", agentActorId: "another_me_carol" },
        input: "x",
        files: [],
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ kind: "owner_unresolved" });
  });

  it("reports the model the Runtime named", async () => {
    const { modelCall, invokeModel } = setup({
      outcomes: [completed("Hello.", "gpt-5-codex")],
    });
    await expect(
      modelCall.text({
        ...work,
        owner: { tenantId: "tenant_1", ownerActorId: "alice" },
        effort: "medium",
        input: "Say hello.",
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ output: "Hello.", model: "gpt-5-codex" });
    expect(invokeModel.mock.calls[0]![1]).toMatchObject({
      mode: "text",
      reasoningEffort: "medium",
    });
  });

  it("resolves an ownerless call only in a deployment with exactly one Another Me", async () => {
    const single = setup({ placements: [alice] });
    await single.modelCall.call({ ...ask, input: "x" });
    expect(single.invokeModel.mock.calls[0]![0]).toBe("computer_alice");

    const shared = setup();
    await expect(
      shared.modelCall.call({ ...ask, input: "x" }),
    ).rejects.toMatchObject({ kind: "owner_unresolved" });
    await expect(
      shared.modelCall.call({
        ...ask,
        owner: { tenantId: "tenant_1", ownerActorId: "carol" },
        input: "x",
      }),
    ).rejects.toMatchObject({ kind: "owner_unresolved" });
    expect(shared.invokeModel).not.toHaveBeenCalled();
  });

  it("runs a placed call where the Agent runs without resolving an owner", async () => {
    const { modelCall, invokeModel, placements } = setup();
    await modelCall.call({ ...ask, placement: bob, input: "x" });
    expect(placements).not.toHaveBeenCalled();
    expect(invokeModel.mock.calls[0]![0]).toBe("computer_bob");
  });

  it("falls back to the other ready Runtime, and tries its own when none is ready", async () => {
    const pi = { ...alice, runtimeType: "pi" as const };
    const fallback = setup({
      placements: [pi],
      ready: (_computer, runtime) => runtime === "claude",
    });
    await fallback.modelCall.call({ ...ask, input: "x" });
    expect(fallback.invokeModel.mock.calls[0]![1].runtimeType).toBe("claude");

    const ownPreferred = setup({
      placements: [bob],
      ready: () => true,
    });
    await ownPreferred.modelCall.call({ ...ask, input: "x" });
    expect(ownPreferred.invokeModel.mock.calls[0]![1].runtimeType).toBe(
      "claude",
    );

    const none = setup({
      placements: [alice],
      ready: () => false,
      outcomes: [
        new ModelCallError("runtime_unavailable", "Runtime codex is not ready"),
      ],
    });
    await expect(
      none.modelCall.call({ ...ask, input: "x" }),
    ).rejects.toMatchObject({ kind: "runtime_unavailable" });
    expect(none.invokeModel.mock.calls[0]![1].runtimeType).toBe("codex");
  });

  it("caches an owner's placement for 30 seconds and drops it when the Computer is offline", async () => {
    const { modelCall, placements, advance } = setup({
      placements: [alice],
      outcomes: [
        completed('{"answer":"yes"}'),
        completed('{"answer":"yes"}'),
        { outcome: "unavailable", reason: "updating", duration_ms: 0 },
        completed('{"answer":"yes"}'),
      ],
    });
    const owner = { tenantId: "tenant_1", ownerActorId: "alice" };
    await modelCall.call({ ...ask, owner, input: "x" });
    await modelCall.call({ ...ask, owner, input: "x" });
    expect(placements).toHaveBeenCalledTimes(1);
    const offline = await modelCall
      .call({ ...ask, owner, input: "x" })
      .catch((error: unknown) => error);
    expect(offline).toMatchObject({ kind: "computer_offline" });
    expect(isComputerOffline(offline)).toBe(true);
    await modelCall.call({ ...ask, owner, input: "x" });
    expect(placements).toHaveBeenCalledTimes(2);
    advance(30_001);
    await modelCall.call({ ...ask, owner, input: "x" });
    expect(placements).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["unavailable", "computer_offline"],
    ["runtime_unavailable", "runtime_unavailable"],
    ["auth_required", "runtime_unavailable"],
    ["runtime_incompatible", "runtime_unavailable"],
    ["timed_out", "timed_out"],
    ["output_limited", "output_limited"],
    ["failed", "failed"],
  ] as const)("maps a %s outcome to %s", async (outcome, kind) => {
    const { modelCall } = setup({
      placements: [alice],
      outcomes: [{ outcome, duration_ms: 0 }],
    });
    await expect(
      modelCall.text({ ...work, kind: "approval", input: "x" }),
    ).rejects.toMatchObject({ name: "ModelCallError", kind });
  });

  it("corrects an answer that breaks the schema within the kind's attempts", async () => {
    const corrected = setup({
      placements: [alice],
      outcomes: [
        completed('{"answer":1}'),
        completed('```json\n{"answer":"ok"}\n```'),
      ],
    });
    await expect(
      corrected.modelCall.call({ ...ask, input: "Question?" }),
    ).resolves.toMatchObject({ output: { answer: "ok" } });
    const retry = corrected.invokeModel.mock.calls[1]![1].input;
    expect(retry).toMatch(/^Question\?\n\n## Required Correction/u);
    expect(retry).toContain("must be string");
    expect(retry).toContain('{\\"answer\\":1}');

    const invalid = setup({
      placements: [alice],
      outcomes: [completed("not json"), completed('{"answer":"ok","extra":1}')],
    });
    const error = await invalid.modelCall
      .call({ ...ask, kind: "profile", input: "Question?" })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      kind: "invalid_output",
      output: '{"answer":"ok","extra":1}',
    });
    expect(invalid.invokeModel).toHaveBeenCalledTimes(2);
  });

  it("rejects an answer its check refuses and corrects it with the reason", async () => {
    const validate = vi.fn(({ answer }: Record<string, unknown>) =>
      answer === "yes" ? undefined : "the answer must be yes",
    );
    const corrected = setup({
      placements: [alice],
      outcomes: [completed('{"answer":"no"}'), completed('{"answer":"yes"}')],
    });
    await expect(
      corrected.modelCall.call({ ...ask, validate, input: "Question?" }),
    ).resolves.toMatchObject({ output: { answer: "yes" } });
    expect(validate).toHaveBeenCalledTimes(2);
    const retry = corrected.invokeModel.mock.calls[1]![1].input;
    expect(retry).toMatch(/^Question\?\n\n## Required Correction/u);
    expect(retry).toContain("rejected: the answer must be yes.");

    const refused = setup({
      placements: [alice],
      outcomes: [completed('{"answer":"no"}'), completed('{"answer":"no"}')],
    });
    await expect(
      refused.modelCall.call({
        ...ask,
        kind: "profile",
        validate,
        input: "Question?",
      }),
    ).rejects.toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("the answer must be yes"),
    });
    expect(refused.invokeModel).toHaveBeenCalledTimes(2);
  });

  it("sends a session's call to its session and each retry to a fresh one", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [
        completed('{"answer":1}'),
        completed('{"answer":2}'),
        completed('{"answer":"ok"}'),
      ],
    });
    await expect(
      modelCall.call({ ...ask, sessionKey: "review:1", input: "Question?" }),
    ).resolves.toMatchObject({ output: { answer: "ok" } });
    const sessions = invokeModel.mock.calls.map(
      ([, request]) => request.sessionKey,
    );
    expect(sessions[0]).toBe("review:1");
    expect(sessions.slice(1)).toEqual([
      expect.stringMatching(/^retry:[0-9a-f]{64}$/u),
      expect.stringMatching(/^retry:[0-9a-f]{64}$/u),
    ]);
    expect(new Set(sessions).size).toBe(3);
  });

  it("does not correct a kind with one attempt", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [completed('{"answer":1}'), completed('{"answer":"ok"}')],
    });
    await expect(
      modelCall.call({ ...ask, kind: "approval", input: "Question?" }),
    ).rejects.toMatchObject({ kind: "invalid_output" });
    expect(invokeModel).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty answer as invalid output", async () => {
    const { modelCall } = setup({
      placements: [alice],
      outcomes: [completed("   ")],
    });
    await expect(
      modelCall.text({ ...work, kind: "approval", input: "x" }),
    ).rejects.toMatchObject({ kind: "invalid_output" });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** An invocation that runs until its execution is stopped. */
const hanging: Invoke = (_computerId, request) =>
  new Promise((_resolve, reject) =>
    request.signal.addEventListener("abort", () =>
      reject(request.signal.reason),
    ),
  );

const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("Model call executions", () => {
  afterEach(() => vi.useRealTimers());

  it("joins callers asking the same and runs other content as a new call", async () => {
    const answer = deferred<Outcome>();
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      invoke: () => answer.promise,
    });
    const calls = [
      modelCall.text({ ...work, input: "x" }),
      modelCall.text({ ...work, input: "x" }),
      modelCall.text({ ...work, input: "y" }),
    ];
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(2));
    answer.resolve(completed("done"));
    await expect(Promise.all(calls)).resolves.toMatchObject([
      { output: "done" },
      { output: "done" },
      { output: "done" },
    ]);
  });

  it("keeps a background answer for the caller that comes back", async () => {
    const answer = deferred<Outcome>();
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      invoke: () => answer.promise,
    });
    const leave = new AbortController();
    const first = modelCall.text({ ...work, input: "x", signal: leave.signal });
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(1));
    leave.abort(new Error("caller left"));
    await expect(first).rejects.toThrow("caller left");
    expect(invokeModel.mock.calls[0]![1].signal.aborted).toBe(false);

    answer.resolve(completed("kept"));
    await settled();
    await expect(
      modelCall.text({ ...work, input: "x" }),
    ).resolves.toMatchObject({ output: "kept" });
    expect(invokeModel).toHaveBeenCalledTimes(1);
  });

  it("stops an interactive call once nobody waits", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      invoke: hanging,
    });
    const leave = new AbortController();
    const review = modelCall.text({
      kind: "approval",
      key: "review",
      input: "x",
      signal: leave.signal,
    });
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(1));
    leave.abort(new Error("caller left"));
    await expect(review).rejects.toThrow("caller left");
    expect(invokeModel.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it("retries a timed out attempt after a pause within the kind's attempts", async () => {
    vi.useFakeTimers();
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [
        { outcome: "timed_out", duration_ms: 0 },
        { outcome: "failed", duration_ms: 0 },
        completed("third"),
      ],
    });
    const call = modelCall.text({ ...work, input: "x" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(invokeModel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(call).resolves.toMatchObject({ output: "third" });
    expect(invokeModel).toHaveBeenCalledTimes(3);
  });

  it("fails an offline call at once", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [{ outcome: "unavailable", duration_ms: 0 }],
    });
    await expect(modelCall.text({ ...work, input: "x" })).rejects.toMatchObject(
      { kind: "computer_offline" },
    );
    expect(invokeModel).toHaveBeenCalledTimes(1);
  });

  it("stops on close and drops every unfinished call", async () => {
    const { modelCall, invokeModel, logger } = setup({
      placements: [alice],
      invoke: hanging,
    });
    const memory = modelCall
      .text({ ...work, input: "x" })
      .catch((error: unknown) => error);
    const review = modelCall
      .text({ kind: "approval", key: "r", input: "y" })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(2));

    modelCall.close();
    expect(logger.log).toHaveBeenCalledWith(
      "info",
      "model_call.shutdown_dropped",
      {
        calls: [
          { kind: "memory", key: "test" },
          { kind: "approval", key: "r" },
        ],
      },
    );
    expect(await memory).toMatchObject({ kind: "computer_offline" });
    expect(await review).toMatchObject({ kind: "computer_offline" });
    expect(
      invokeModel.mock.calls.every(([, request]) => request.signal.aborted),
    ).toBe(true);
    await expect(modelCall.text({ ...work, input: "z" })).rejects.toMatchObject(
      { kind: "computer_offline" },
    );
  });
});

describe("Model chains", () => {
  afterEach(() => vi.useRealTimers());
  const owner = { tenantId: "tenant_1", ownerActorId: "alice" };
  const lease = () => ({ release: vi.fn() });

  it("runs its calls in the one place it was admitted to", async () => {
    const chainLease = lease();
    const { modelCall, invokeModel, acquireModelChain } = setup({
      placements: [alice],
      lease: chainLease,
      outcomes: [
        { ...completed("one"), usage: { input_tokens: 3 } } as Outcome,
        completed('{"answer":"two"}'),
      ],
    });
    const result = await modelCall.chain(
      { kind: "wiki", key: "wiki:refresh:1", owner },
      async (task) => [
        (await task.text({ step: "a", input: "x" })).output,
        (
          await task.call({
            step: "b",
            input: "y",
            schemaName: "answer",
            outputSchema: schema,
          })
        ).output,
      ],
    );
    expect(result).toEqual(["one", { answer: "two" }]);
    expect(acquireModelChain).toHaveBeenCalledTimes(1);
    expect(acquireModelChain).toHaveBeenCalledWith(
      { computerId: "computer_alice", runtimeType: "codex" },
      { priority: 70, kind: "wiki", key: "wiki:refresh:1" },
      expect.any(AbortSignal),
    );
    expect(
      invokeModel.mock.calls.map(([, request]) => [
        request.runtimeType,
        request.queue,
      ]),
    ).toEqual([
      ["codex", undefined],
      ["codex", undefined],
    ]);
    expect(chainLease.release).toHaveBeenCalledWith({
      outcome: "completed",
      usage: { calls: 2, per_call: [[{ input_tokens: 3 }]] },
    });
  });

  it("runs its calls one at a time in the order they are made", async () => {
    const answers: ((outcome: Outcome) => void)[] = [];
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      invoke: () => new Promise<Outcome>((resolve) => answers.push(resolve)),
    });
    const result = modelCall.chain(
      { kind: "memory", key: "memory:chain", owner },
      (chain) =>
        Promise.all(
          ["a", "b"].map(
            async (step) => (await chain.text({ step, input: step })).output,
          ),
        ),
    );
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(invokeModel).toHaveBeenCalledTimes(1);
    answers[0]!(completed("first"));
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(2));
    expect(invokeModel.mock.calls[1]![1].input).toBe("b");
    answers[1]!(completed("second"));
    await expect(result).resolves.toEqual(["first", "second"]);
  });

  it("sends a chain call's session to the Runtime", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [completed('{"answer":"ok"}')],
    });
    await modelCall.chain(
      { kind: "wiki", key: "wiki:refresh:3", owner },
      (task) =>
        task.call({
          step: "batch:1/1",
          input: "x",
          schemaName: ask.schemaName,
          outputSchema: ask.outputSchema,
          sessionKey: "wiki:refresh:3/batch:1",
        }),
    );
    expect(invokeModel.mock.calls[0]![1]).toMatchObject({
      sessionKey: "wiki:refresh:3/batch:1",
    });
  });

  it("sends the output cap on every attempt and keeps what a stopped call streamed", async () => {
    vi.useFakeTimers();
    const limited = {
      outcome: "output_limited",
      text: '{"actions":[{"p',
      reason: "Model reply exceeded its output limit",
      duration_ms: 0,
    } as const;
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [limited, limited],
    });
    const stopped = modelCall.chain(
      { kind: "wiki", key: "wiki:refresh:4", owner },
      (task) =>
        task
          .call({
            step: "batch:1",
            input: "x",
            schemaName: "answer",
            outputSchema: schema,
            maxOutputChars: 24_000,
          })
          .catch((caught: unknown) => caught as ModelCallError),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await stopped).toMatchObject({
      kind: "output_limited",
      output: '{"actions":[{"p',
    });
    expect(
      invokeModel.mock.calls.map(([, request]) => request.maxOutputChars),
    ).toEqual([24_000, 24_000]);
  });

  it("records each call's prompt and reply", async () => {
    const callLog = { started: vi.fn(), finished: vi.fn() };
    const { modelCall } = setup({
      placements: [alice],
      callLog,
      outcomes: [
        completed('{"answer":"yes"}', "gpt-test"),
        { outcome: "timed_out", text: "{", duration_ms: 0 },
      ],
    });
    await modelCall.call({
      ...ask,
      kind: "wiki",
      key: "wiki:refresh:5/route",
      instructions: "Route.",
      input: "Sources",
    });
    expect(callLog.started).toHaveBeenCalledWith({
      kind: "wiki",
      key: "wiki:refresh:5/route",
      attempt: 1,
      mode: "structured",
      instructions: "Route.",
      input: "Sources",
    });
    expect(callLog.finished).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "wiki:refresh:5/route",
        outcome: "completed",
        model: "gpt-test",
        text: '{"answer":"yes"}',
      }),
    );
    await expect(
      modelCall.text({ ...work, kind: "approval", input: "x" }),
    ).rejects.toMatchObject({ kind: "timed_out" });
    expect(callLog.finished).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "timed_out",
        text: "{",
        error: "The Runtime did not answer in time",
      }),
    );
  });

  it("retries a chain's call in its place within the kind's attempts, then hands the failure to the chain", async () => {
    vi.useFakeTimers();
    const timedOut = { outcome: "timed_out", duration_ms: 0 } as const;
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [timedOut, timedOut, timedOut],
    });
    const kind = modelCall.chain(
      { kind: "memory", key: "memory:task", owner },
      (task) =>
        task
          .text({ step: "round-1", input: "x" })
          .then(() => "answered")
          .catch((error: unknown) => (error as ModelCallError).kind),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await kind).toBe("timed_out");
    expect(invokeModel).toHaveBeenCalledTimes(3);
    expect(
      invokeModel.mock.calls.every(
        ([, request]) => request.queue === undefined,
      ),
    ).toBe(true);
  });

  it("stops its calls and frees its place when the caller stops it", async () => {
    const chainLease = lease();
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      lease: chainLease,
      invoke: hanging,
    });
    const stop = new AbortController();
    const task = modelCall.chain(
      { kind: "wiki", key: "wiki:refresh:2", owner, signal: stop.signal },
      (task) => task.text({ step: "a", input: "x" }),
    );
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(1));
    stop.abort(new Error("refresh canceled"));
    await expect(task).rejects.toThrow("refresh canceled");
    expect(invokeModel.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(chainLease.release).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "aborted" }),
    );
  });

  it("stops on close and drops its running call", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      invoke: hanging,
    });
    let taskSignal: AbortSignal | undefined;
    const task = modelCall
      .chain({ kind: "wiki", key: "wiki:refresh:3", owner }, (task) => {
        taskSignal = task.signal;
        return task.text({ step: "a", input: "x" });
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(1));
    modelCall.close();
    expect(await task).toMatchObject({ kind: "computer_offline" });
    expect(taskSignal?.aborted).toBe(true);
  });
});

describe("Model context window", () => {
  const catalogs: Record<string, Record<string, RuntimeModelInfo[]>> = {
    computer_alice: {
      codex: [
        { id: "gpt-large", contextWindow: 400_000 },
        { id: "gpt-default", contextWindow: 272_000, isDefault: true },
      ],
      claude: [{ id: "default", contextWindow: 65_536, isDefault: true }],
    },
    computer_bob: {
      claude: [{ id: "opus" }, { id: "default", isDefault: true }],
    },
  };
  const runtimeModels = (computerId: string, runtimeType: string) =>
    catalogs[computerId]?.[runtimeType] ?? [];

  it("is the window of the default model on the Runtime the calls run on", async () => {
    const { modelCall } = setup({ runtimeModels });
    await expect(
      modelCall.contextWindow!({
        anotherMe: {
          tenantId: alice.tenantId,
          agentActorId: "another_me_alice",
        },
      }),
    ).resolves.toBe(272_000);
    // Calls on a Computer whose own Runtime cannot run them move to the other.
    await expect(
      setup({
        runtimeModels,
        ready: (_computer, runtime) => runtime === "claude",
      }).modelCall.contextWindow!({ placement: alice }),
    ).resolves.toBe(65_536);
  });

  it("is unknown without a window or a placement", async () => {
    const { modelCall } = setup({ runtimeModels });
    await expect(
      modelCall.contextWindow!({ placement: bob }),
    ).resolves.toBeUndefined();
    await expect(
      setup({ runtimeModels, placements: [] }).modelCall.contextWindow!({
        owner: { tenantId: alice.tenantId, ownerActorId: "alice" },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails while the Computer is offline", async () => {
    const { modelCall } = setup({ runtimeModels: () => undefined });
    await expect(
      modelCall.contextWindow!({ placement: alice }),
    ).rejects.toMatchObject({ kind: "computer_offline" });
  });
});

describe("Runner Gateway model invocation adapter", () => {
  it.each([
    [
      new LocalComputerOfflineError("Local Computer is updating"),
      "computer_offline",
    ],
    [
      new RunnerModelInvokeUnavailableError("upgrade the Local Computer"),
      "runtime_unavailable",
    ],
    [
      new RangeError("Model invocation prompt exceeds 3 MiB"),
      "invalid_request",
    ],
  ] as const)("maps %s", async (thrown, kind) => {
    const gateway = runtimeModelGateway({
      supportsModelInvoke: () => true,
      runtimeModels: () => [],
      invokeModel: async () => {
        throw thrown;
      },
      acquireModelChain: async () => {
        throw thrown;
      },
    });
    const error = await gateway
      .invokeModel("computer", {
        tenantId: "t",
        ownerActorId: "o",
        agentId: "a",
        runtimeType: "codex",
        mode: "text",
        reasoningEffort: "low",
        queue: { priority: 40, kind: "memory", key: "k" },
        input: "x",
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "ModelCallError", kind });
    if (kind === "computer_offline")
      expect(
        (error as Error).message.startsWith(COMPUTER_OFFLINE_MESSAGE),
      ).toBe(true);
  });
});
