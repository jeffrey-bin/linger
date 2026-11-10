import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineFeature,
  type FeatureDeclaration,
} from "../../../src/agent/agent-features/contracts.js";
import type {
  ActivatedContextRuntime,
  ContextRuntimeActivator,
} from "../../../src/agent/executor/activation.js";
import type { ExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import type { ContextRuntimeStateFactory } from "../../../src/agent/executor/context-executor.js";
import type {
  AgentInput,
  AgentProvider,
  AgentRun,
  ExecutionSpec,
  ProviderSessionOptions,
  ProviderSteerAck,
  ProviderSteerOptions,
  RunResult,
  RuntimeSession,
} from "../../../src/agent/executor/provider.js";
import type { Message } from "../../../src/agent/executor/types.js";
import { TestContextRuntimeState } from "../test-support/context-runtime-state.js";
import { createTestFeatureAssembly } from "../test-support/executor-features.js";
import {
  createStandaloneExecutor,
  type ExecutorFeaturePorts,
  type StandaloneExecutorOptions,
} from "../test-support/standalone-executor.js";

interface TestRuntime {
  readonly type: "test";
}

const ref: ExecutionContextRef = {
  kind: "meta",
  agentId: "agent-1",
  roomId: "room-1",
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const testPorts = (declarations: readonly FeatureDeclaration[] = []) =>
  createTestFeatureAssembly({
    ref,
    actorId: "actor-agent-1",
    declarations,
  }).ports;

const createHarness = async (
  provider: AgentProvider,
  features: ExecutorFeaturePorts = testPorts(),
) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "committed-input-boundary-"),
  );
  temporaryDirectories.push(root);
  const activator: ContextRuntimeActivator<TestRuntime> = {
    async activate(request) {
      return {
        ref: request.ref,
        provider,
        runtimeName: "test",
        runtimeSession: { threadId: "thread-1" },
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
      } satisfies ActivatedContextRuntime;
    },
  };
  let state: TestContextRuntimeState | undefined;
  const stateFactory: ContextRuntimeStateFactory<TestRuntime> = async (
    input,
  ) => {
    state = new TestContextRuntimeState({
      databasePath: path.join(root, "runtime.sqlite"),
      ref: input.ref,
    });
    return state;
  };
  const createOptions: StandaloneExecutorOptions<TestRuntime> = {
    ref,
    actorId: "actor-agent-1",
    tenantId: "tenant-test",
    agent: { name: "Agent One", instructions: "test" },
    runtime: { type: "test" },
    resources: { skills: [], mcpServers: [] },
    features,
  };
  return {
    create: () =>
      createStandaloneExecutor({
        activator,
        stateFactory,
        options: createOptions,
      }),
    createOptions,
    get state() {
      if (!state) throw new Error("Runtime state was not created");
      return state;
    },
  };
};

describe("ContextExecutor committed input boundary", () => {
  it("resolves a trusted notification after its durable commit while the provider steer is still deferred", async () => {
    const provider = new DeferredSteerProvider();
    const harness = await createHarness(provider);
    const shell = await harness.create();
    const { runId } = await shell.submitTrustedTurn([
      message("initial", "start"),
    ]);
    await shell.start();
    await eventually(() => expect(provider.inputs).toHaveLength(1));

    // A precommit rejection propagates and dispatches nothing.
    vi.spyOn(harness.state, "acceptTrustedNotification").mockRejectedValueOnce(
      new Error("trusted accept rejected"),
    );
    await expect(
      shell.acceptTrustedNotification(
        runId,
        message("rejected", "must not dispatch"),
      ),
    ).rejects.toThrow("trusted accept rejected");
    expect(provider.steers).toHaveLength(0);

    // "accepted" reports the durable commit; it never waits on the provider.
    await expect(
      shell.acceptTrustedNotification(
        runId,
        message("trusted-note", "steer me"),
      ),
    ).resolves.toBe("accepted");
    await eventually(() => expect(provider.steers).toHaveLength(1));
    expect(provider.steers[0]?.input.text).toContain("steer me");

    // stop() drains the tracked steer dispatch instead of abandoning it.
    const stopping = shell.stop();
    await expect(
      Promise.race([
        stopping.then(() => "stopped"),
        delay(100).then(() => "pending"),
      ]),
    ).resolves.toBe("pending");
    provider.steerAck.resolve({ turnId: "turn-steered" });
    await stopping;
    expect(harness.state.getSteerOutcome("trusted-note")).toBe("applied");
  });

  it("marks a trusted notification so turn contributions skip its steer", async () => {
    const provider = new DeferredSteerProvider();
    const prepared: Message[] = [];
    const recording: FeatureDeclaration = defineFeature({
      id: "test-recording-input",
      context: {
        ports: { prepareInput: {} },
        create: () => ({
          prepareInput: (_view, input) => {
            prepared.push(input);
            return null;
          },
        }),
      },
    });
    const harness = await createHarness(provider, testPorts([recording]));
    const shell = await harness.create();
    const { runId } = await shell.submitTrustedTurn([
      message("initial", "start"),
    ]);
    await shell.start();
    await eventually(() => expect(provider.inputs).toHaveLength(1));
    const accept = vi.spyOn(harness.state, "acceptTrustedNotification");

    await expect(
      shell.acceptTrustedNotification(
        runId,
        message("trusted-note", "steer me"),
      ),
    ).resolves.toBe("accepted");
    await eventually(() => expect(provider.steers).toHaveLength(1));

    // The durable payload and the dispatched steer carry the same marker.
    expect(accept.mock.calls[0]?.[1]).toMatchObject({
      messageId: "trusted-note",
      trustedNotification: true,
    });
    expect(prepared.map((input) => input.trustedNotification)).toEqual([
      undefined,
      true,
    ]);
    provider.steerAck.resolve({ turnId: "turn-steered" });
    await shell.stop();
  });

  it("fails a queued Inbox Run instead of sending a raw fallback when a canonical notification contribution throws", async () => {
    const provider = new DeferredSteerProvider();
    const throwing: FeatureDeclaration = defineFeature({
      id: "test-throwing-notification-context",
      context: {
        ports: { contributeNotificationContext: {} },
        create: () => ({
          contributeNotificationContext: () => {
            throw new Error("notification context contribution exploded");
          },
        }),
      },
    });
    const harness = await createHarness(provider, testPorts([throwing]));
    const shell = await harness.create();

    // TeamHub queued the Run in the Message transaction.
    const runId = harness.state.queueInboxRun([
      canonicalInboxMessage("canonical-1", "inbox-a"),
    ]);

    await shell.start();
    await eventually(async () => {
      await expect(shell.observeTurn(runId)).resolves.toMatchObject({
        status: "failed",
        terminal: {
          type: "failed",
          error: expect.stringContaining(
            "notification context contribution exploded",
          ),
        },
      });
    });
    // The committed input never reached the provider as a raw fallback prompt.
    expect(provider.inputs).toEqual([]);
    await shell.stop();
  });
});

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

class DeferredSteerProvider implements AgentProvider {
  readonly inputs: AgentInput[] = [];
  readonly steers: ProviderSteerOptions[] = [];
  readonly run = new PendingRun();
  readonly steerAck = deferred<ProviderSteerAck>();

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
    _spec: ExecutionSpec,
  ): Promise<AgentRun> {
    this.inputs.push(input);
    return this.run;
  }

  async steer(
    _run: AgentRun,
    options: ProviderSteerOptions,
  ): Promise<ProviderSteerAck> {
    this.steers.push(options);
    return this.steerAck.promise;
  }

  async close() {}
}

const message = (messageId: string, rawMessage: string): Message => ({
  messageId,
  rawMessage,
  segments: [{ type: "text", content: rawMessage }],
});

const canonicalInboxMessage = (messageId: string, inboxId: string): Message =>
  ({
    messageId,
    rawMessage: "submitted body",
    segments: [{ type: "text", content: "submitted body" }],
    sourceInboxIds: [inboxId],
    // Durable canonical room content as TeamHub persists it on the queued
    // input; the Run renders from this payload.
    acceptedNotification: {
      inboxId,
      after: "0",
      through: "1",
      cursorEncoding: "room_event_v1",
      messages: [
        {
          id: "canonical-m1",
          body: "canonical body",
          author: "Human",
          authorActorId: "actor-human",
          authorType: "user",
          mentioned: true,
          contextMessageIds: [],
          resourceReferences: [],
        },
      ],
    },
  }) as Message;

const emptyEvents = (): AsyncIterable<never> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => ({ done: true, value: undefined }),
  }),
});

const eventually = async (
  assertion: () => void | Promise<void>,
): Promise<void> => {
  await expect
    .poll(async () => {
      await assertion();
      return true;
    })
    .toBe(true);
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
};
