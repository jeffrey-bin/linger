import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinAgentFeatures } from "../../../src/agent/agent-features/builtin.js";
import {
  composeContextFeatures,
  type ComposedContextFeatures,
} from "../../../src/agent/agent-features/compose.js";
import {
  defineFeature,
  type AcceptedInboxFact,
  type BoundFeatureContext,
  type FeatureContext,
  type FeatureDeclaration,
} from "../../../src/agent/agent-features/contracts.js";
import type { BuiltinFeatureHost } from "../../../src/agent/agent-features/host-ports.js";
import type {
  RunWakeTarget,
  RunWakeTargetRegistrar,
} from "../../../src/agent/agent-features/inbox-source/types.js";
import { ExecutorRegistry } from "../../../src/agent/executor/registry.js";
import { createInMemoryGhostStore } from "../test-support/in-memory-ghost-store.js";
import type { GhostStore } from "../../../src/agent/executor/ghost.js";
import type {
  ResolvedAgentIdentity,
  Message,
} from "../../../src/agent/executor/types.js";
import type { AgentLogger } from "../../../src/agent/observability/agent-log.js";
import { mergePromptInputContribution } from "../../../src/agent/prompt/input-contribution-merger.js";
import {
  Deferred,
  FakeRuntime,
  fakeActivator,
} from "../test-support/fake-activator.js";
import {
  encodeExecutionContextRef,
  type ExecutionContextRecord,
  type ExecutionContextRef,
  type ExecutionContextStore,
} from "../../../src/agent/executor/context-ref.js";
import { createInMemoryExecutionContextStore } from "../test-support/in-memory-execution-context-store.js";

interface TestRuntime {
  readonly model: string;
}

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
}

/** Ordered admission markers plus the handles features capture at bind. */
interface AdmissionProbe {
  readonly events: string[];
  readonly stops: { readonly id: string; readonly aborted: boolean }[];
  readonly facts: AcceptedInboxFact[];
  readonly bounds: Map<string, BoundFeatureContext>;
  context: FeatureContext | null;
  composed: ComposedContextFeatures | null;
}

const createProbe = (): AdmissionProbe => ({
  events: [],
  stops: [],
  facts: [],
  bounds: new Map(),
  context: null,
  composed: null,
});

const BIND_DELIVER_FEATURE_ID = "probe-bind-deliver";
const RECORDING_SOURCE_FEATURE_ID = "probe-recording-source";
const BIND_GATE_FEATURE_ID = "probe-bind-gate";
const FACT_OBSERVER_FEATURE_ID = "probe-fact-observer";

/**
 * A Context-authorized source that hands a queued-input wake to the host
 * while still inside `onContextBound` — before the instance is published.
 */
const bindDeliveringSource = (
  host: BuiltinFeatureHost,
  probe: AdmissionProbe,
): FeatureDeclaration =>
  defineFeature({
    id: BIND_DELIVER_FEATURE_ID,
    context: {
      ports: { onContextBound: {} },
      create: (bound) => ({
        onContextBound: async () => {
          probe.bounds.set(BIND_DELIVER_FEATURE_ID, bound);
          probe.events.push(`bind:${BIND_DELIVER_FEATURE_ID}`);
          if (!host.inbox) throw new Error("inbox host capability is required");
          host.inbox.takeUpQueuedInput(bound, "queued");
          probe.events.push(`delivered:${BIND_DELIVER_FEATURE_ID}`);
          return {
            stop: async () => {
              probe.stops.push({
                id: BIND_DELIVER_FEATURE_ID,
                aborted: bound.signal.aborted,
              });
              probe.events.push(`stop:${BIND_DELIVER_FEATURE_ID}`);
            },
          };
        },
      }),
    },
  });

/** A later binder held open by a gate or failed on request. */
const deferredBinderSource = (
  probe: AdmissionProbe,
  input: { readonly gate?: Deferred; readonly failure?: Error },
): FeatureDeclaration =>
  defineFeature({
    id: BIND_GATE_FEATURE_ID,
    context: {
      ports: { onContextBound: { after: [BIND_DELIVER_FEATURE_ID] } },
      create: (bound) => ({
        onContextBound: async () => {
          probe.bounds.set(BIND_GATE_FEATURE_ID, bound);
          probe.events.push(`bind:${BIND_GATE_FEATURE_ID}`);
          if (input.failure) throw input.failure;
          await input.gate?.promise;
          probe.events.push(`bound:${BIND_GATE_FEATURE_ID}`);
          return {
            stop: async () => {
              probe.stops.push({
                id: BIND_GATE_FEATURE_ID,
                aborted: bound.signal.aborted,
              });
              probe.events.push(`stop:${BIND_GATE_FEATURE_ID}`);
            },
          };
        },
      }),
    },
  });

/** A bound source that records bind/stop for lifecycle ordering. */
const recordingSource = (probe: AdmissionProbe): FeatureDeclaration =>
  defineFeature({
    id: RECORDING_SOURCE_FEATURE_ID,
    context: {
      ports: { onContextBound: {} },
      create: (bound) => ({
        onContextBound: () => {
          probe.bounds.set(RECORDING_SOURCE_FEATURE_ID, bound);
          probe.events.push(`bind:${RECORDING_SOURCE_FEATURE_ID}`);
          return {
            stop: async () => {
              probe.stops.push({
                id: RECORDING_SOURCE_FEATURE_ID,
                aborted: bound.signal.aborted,
              });
              probe.events.push(`stop:${RECORDING_SOURCE_FEATURE_ID}`);
            },
          };
        },
      }),
    },
  });

/** Captures the full FeatureContext only `afterInboxInputAccepted` receives. */
const factObserverSource = (probe: AdmissionProbe): FeatureDeclaration =>
  defineFeature({
    id: FACT_OBSERVER_FEATURE_ID,
    context: {
      ports: { afterInboxInputAccepted: {} },
      create: () => ({
        afterInboxInputAccepted: (context, fact) => {
          probe.context = context;
          probe.facts.push(fact);
          probe.events.push(`fact:${fact.inputId}`);
        },
      }),
    },
  });

const registration = {
  tenantId: "tenant-test",
  revision: "revision-1",
  agent: { name: "Admission Agent", instructions: "Use explicit tools." },
  runtime: { model: "test-model" },
  resources: { skills: [], mcpServers: [] },
} as const;

const roomMetaRef = (
  roomId: string,
  agentId = "agent-1",
): ExecutionContextRef => ({ kind: "meta", agentId, roomId });

const message = (messageId: string): Message => ({
  messageId,
  rawMessage: `Input ${messageId}.`,
  segments: [{ type: "text" as const, content: `Input ${messageId}.` }],
});

const resolvedIdentity = (agentId: string): ResolvedAgentIdentity => ({
  actorId: `actor:${agentId}`,
  agentType: "general",
  sponsor: {
    actorId: "actor:test-sponsor",
    displayName: "Test Sponsor",
  },
});

const silentFeatureLogger = (): AgentLogger => {
  const logger: AgentLogger = {
    log: () => undefined,
    child: () => logger,
  };
  return logger;
};

interface HarnessOptions {
  readonly ghostStore?: GhostStore<TestRuntime>;
  readonly contextStore?: ExecutionContextStore;
  readonly probe?: AdmissionProbe;
  readonly features?: (
    host: BuiltinFeatureHost,
  ) => readonly FeatureDeclaration[];
}

const managers: ExecutorRegistry<TestRuntime>[] = [];

const createHarness = (options: HarnessOptions = {}) => {
  vi.stubEnv("AGENT_LOG_LEVEL", "off");
  const probe = options.probe ?? createProbe();
  // Each executor's Runtime, in creation order; it records into the probe.
  const fakes: FakeRuntime[] = [];
  const contextStore =
    options.contextStore ?? createInMemoryExecutionContextStore();
  const ghostStore =
    options.ghostStore ?? createInMemoryGhostStore<TestRuntime>();
  const runWakes = new RecordingRunWakes();
  const builtin = createBuiltinAgentFeatures({
    services: {
      logger: silentFeatureLogger(),
      runWakes,
    },
  });
  const manager = new ExecutorRegistry<TestRuntime>({
    identityResolver: {
      resolveIdentity: async (agentId) => resolvedIdentity(agentId),
    },
    executorServices: fakeActivator(() => {
      const fake = new FakeRuntime(probe.events);
      fakes.push(fake);
      return fake;
    }),
    ghostStore,
    contextStore,
    features: {
      composeContext: (input) => {
        probe.context = input.context;
        return (probe.composed = composeContextFeatures({
          context: input.context,
          features: [
            ...builtin.contextDeclarations(input.host),
            recordingSource(probe),
            factObserverSource(probe),
            ...(options.features?.(input.host) ?? []),
          ],
          mergeInputContribution: mergePromptInputContribution,
          ...(input.logger ? { logger: input.logger } : {}),
        }));
      },
    },
  });
  managers.push(manager);
  return {
    contextStore,
    fakes,
    ghostStore,
    manager,
    runWakes,
    probe,
  };
};

/**
 * Activates the Context and leaves one Run replying, so feature steers have
 * a Run to join. Resolves the running Run's ID.
 */
const startHeldRun = async (
  harness: ReturnType<typeof createHarness>,
  ref: ExecutionContextRef,
): Promise<string> => {
  await harness.manager.startContext(ref);
  const fake = harness.fakes.at(-1)!;
  fake.holdRuns = true;
  const runId = fake.state.queueInboxRun([message(`running-${randomUUID()}`)]);
  const target = [...harness.runWakes.targets]
    .reverse()
    .find(
      (candidate) =>
        encodeExecutionContextRef(candidate.ref) ===
        encodeExecutionContextRef(ref),
    )!;
  target.wake("queued");
  await vi.waitFor(() => expect(fake.currentRun).toBeDefined());
  return runId;
};

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    managers.splice(0).map((manager) => manager.close().catch(() => undefined)),
  );
});

describe("Context feature admission boundary", () => {
  it("takes up a bind-time queued-input wake only after binding and publication complete", async () => {
    const probe = createProbe();
    const binderGate = new Deferred();
    const harness = createHarness({
      probe,
      features: (host) => [
        bindDeliveringSource(host, probe),
        deferredBinderSource(probe, { gate: binderGate }),
      ],
    });
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    const ref = roomMetaRef("room-bind-delivery");

    const pending = harness.manager.observeTurn(ref, "local-run-bind");
    try {
      await vi.waitFor(() =>
        expect(probe.events).toContain(`bind:${BIND_GATE_FEATURE_ID}`),
      );
      const fake = harness.fakes[0]!;
      expect(probe.events.slice(0, 3)).toEqual([
        `bind:${BIND_DELIVER_FEATURE_ID}`,
        `delivered:${BIND_DELIVER_FEATURE_ID}`,
        `bind:${BIND_GATE_FEATURE_ID}`,
      ]);
      // Publication has not happened, so the ready-gated wake cannot have
      // reached the Runtime.
      await nextTurn();
      await nextTurn();
      expect(fake.calls).toEqual(["create"]);
      expect(probe.events).not.toContain("runtime:start");
    } finally {
      binderGate.resolve();
    }
    await pending;
    const fake = harness.fakes[0]!;
    await vi.waitFor(() => expect(fake.calls).toContain("queued:queued"));

    expect(probe.events.indexOf(`bound:${BIND_GATE_FEATURE_ID}`)).toBeLessThan(
      probe.events.indexOf("runtime:start"),
    );
    expect(probe.events.indexOf("runtime:start")).toBeLessThan(
      probe.events.indexOf("queued:queued"),
    );
    expect(await harness.manager.getContextStatus(ref)).not.toBeNull();
  });

  it("releases bound sources exactly once without starting the Runtime when a later binder fails", async () => {
    const probe = createProbe();
    const failure = new Error("deliberate binder failure");
    const harness = createHarness({
      probe,
      features: (host) => [
        bindDeliveringSource(host, probe),
        deferredBinderSource(probe, { failure }),
      ],
    });
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    const ref = roomMetaRef("room-bind-failure");

    await expect(
      harness.manager.observeTurn(ref, "local-run-bind"),
    ).rejects.toThrow("deliberate binder failure");
    const fake = harness.fakes[0]!;
    await nextTurn();

    // The later binder failed after the first source handed over its wake;
    // cleanup released the bound source exactly once and the Runtime stopped.
    expect(probe.events).toEqual([
      `bind:${BIND_DELIVER_FEATURE_ID}`,
      `delivered:${BIND_DELIVER_FEATURE_ID}`,
      `bind:${BIND_GATE_FEATURE_ID}`,
      `stop:${BIND_DELIVER_FEATURE_ID}`,
      "runtime:stop",
    ]);
    expect(
      probe.stops.filter((stop) => stop.id === BIND_DELIVER_FEATURE_ID),
    ).toHaveLength(1);
    expect(fake.calls).toEqual(["create", "stop"]);
    expect(probe.bounds.get(BIND_DELIVER_FEATURE_ID)?.signal.aborted).toBe(
      true,
    );
  });

  it("replaces a cold Context whose profile was superseded before it takes up queued input", async () => {
    const probe = createProbe();
    const ghostStore = createInMemoryGhostStore<TestRuntime>();
    let sourceHost: BuiltinFeatureHost | undefined;
    const harness = createHarness({
      probe,
      ghostStore,
      features: (host) => {
        sourceHost = host;
        return [];
      },
    });
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    const ref = roomMetaRef("room-superseded-source");
    await harness.manager.observeTurn(ref, "local-run-observe");
    const stale = probe.context!;
    const previous = (await ghostStore.get("agent-1"))!;
    await ghostStore.replace!("agent-1", previous.revision, {
      ...previous,
      revision: "revision-2",
    });

    sourceHost!.inbox!.takeUpQueuedInput(stale, "queued");
    await vi.waitFor(() => expect(harness.fakes).toHaveLength(2));
    const replacement = harness.fakes[1]!;
    await vi.waitFor(() =>
      expect(replacement.calls).toContain("queued:queued"),
    );
    expect(harness.fakes[0]!.calls).not.toContain("queued:queued");
    expect(probe.context).not.toBe(stale);
    expect(probe.context?.configurationRevision).toBe("revision-2");
  });

  it("evaluates a stale submission gate at the serialized boundary after readiness prepared outside it", async () => {
    const probe = createProbe();
    const readinessCalls: string[] = [];
    let deferredReadiness: Deferred<boolean> | null = null;
    const ghostStore = Object.assign(createInMemoryGhostStore<TestRuntime>(), {
      isActivationReady: async (agentId: string, revision: string) => {
        readinessCalls.push(`${agentId}@${revision}`);
        const gate = deferredReadiness;
        deferredReadiness = null;
        if (gate) await gate.promise;
        return true;
      },
    });
    let generation = 0;
    const harness = createHarness({
      probe,
      ghostStore,
      features: () => [
        defineFeature({
          id: "probe-generation",
          context: {
            ports: { afterInboxInputAccepted: {} },
            create: () => ({
              afterInboxInputAccepted: () => {
                generation += 1;
              },
            }),
          },
        }),
      ],
    });
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    const ref = roomMetaRef("room-gate-after-readiness");
    await harness.manager.observeTurn(ref, "local-run-observe");
    const context = probe.context!;
    const fake = harness.fakes[0]!;

    const readinessGate = new Deferred<boolean>();
    deferredReadiness = readinessGate;
    const followUp = context.followUp(message("stale-follow-up"), {
      canSubmit: () => generation === 0,
    });
    try {
      // Creation consumed the first readiness check; the second belongs to
      // this follow-up, which is still waiting outside the boundary.
      await vi.waitFor(() => expect(readinessCalls).toHaveLength(2));
      // The executor takes up a queued Inbox input meanwhile; its observers
      // advance the generation.
      probe.composed!.afterInboxInputAccepted({
        inboxId: "room:room-gate-after-readiness",
        inputId: "inbox-input-1",
        targeted: true,
        dispatch: { kind: "enqueue", runId: "local-run-queued" },
      });
      expect(generation).toBe(1);
      expect(probe.facts.map(({ inputId }) => inputId)).toEqual([
        "inbox-input-1",
      ]);
    } finally {
      readinessGate.resolve(true);
    }
    // The gate is re-evaluated at the final durable-acceptance boundary, so
    // the superseded follow-up skips without a trusted Runtime mutation.
    await expect(followUp).resolves.toEqual({
      status: "skipped",
      reason: "stale",
    });
    expect(fake.calls).not.toContain("submitTrustedTurn");
    expect(probe.events).not.toContain("submit:start");
  });

  it("linearizes a held steer commit and close invalidation in FIFO order", async () => {
    const probe = createProbe();
    const harness = createHarness({ probe });
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    const ref = roomMetaRef("room-commit-ordering");
    const runId = await startHeldRun(harness, ref);
    const context = probe.context!;
    const fake = harness.fakes[0]!;
    const steerGate = new Deferred();
    fake.steerGate = steerGate;
    context.signal.addEventListener(
      "abort",
      () => probe.events.push("invalidated"),
      { once: true },
    );

    const steer = context.steer(runId, message("steer-1"));
    let closing: Promise<void> | undefined;
    try {
      // The steer commit is inside the serialized boundary and held by the
      // gate; the close invalidation queued later may not run until it ends.
      await vi.waitFor(() => expect(probe.events).toContain("steer:steer-1"));
      closing = harness.manager.close();
      await nextTurn();
      expect(context.signal.aborted).toBe(false);
      expect(probe.stops).toEqual([]);
      expect(harness.runWakes.stopped).toEqual([]);
      expect(fake.calls).not.toContain("stop");

      steerGate.resolve();
      // The already-entered steer commit is not canceled by the later close.
      await expect(steer).resolves.toEqual({ status: "accepted" });
      await closing;

      const order = ["steer:steer-1", "steered:steer-1", "invalidated"];
      for (const event of order) expect(probe.events).toContain(event);
      const positions = order.map((event) => probe.events.indexOf(event));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      // Source release and the Runtime stop both wait for the serialized
      // invalidation; their relative order is unconstrained.
      const invalidatedAt = probe.events.indexOf("invalidated");
      expect(
        probe.events.indexOf(`stop:${RECORDING_SOURCE_FEATURE_ID}`),
      ).toBeGreaterThan(invalidatedAt);
      expect(probe.events.indexOf("runtime:stop")).toBeGreaterThan(
        invalidatedAt,
      );
      expect(probe.stops.every(({ aborted }) => aborted)).toBe(true);
      expect(harness.runWakes.stopped).toHaveLength(1);
    } finally {
      steerGate.resolve();
      await Promise.allSettled([steer, closing]);
    }
  });

  it("keeps a bound FeatureContext across suspend and invalidates the old handle on same-ref replacement", async () => {
    const probe = createProbe();
    const harness = createHarness({ probe });
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    const ref = roomMetaRef("room-lifetime");
    await harness.manager.observeTurn(ref, "local-run-observe");
    const context = probe.context!;
    const firstFake = harness.fakes[0]!;

    await harness.manager.suspendContext(ref);
    // Suspend is not release: the bound instance keeps its signal, its
    // composition, and its bound sources.
    expect(firstFake.calls).toEqual(["create"]);
    expect(context.signal.aborted).toBe(false);
    expect(probe.context).toBe(context);
    expect(probe.stops).toEqual([]);
    expect(harness.runWakes.stopped).toEqual([]);
    expect(harness.fakes).toHaveLength(1);

    await harness.manager.updateAgent("agent-1", {
      expectedRevision: "revision-1",
      revision: "revision-2",
      agent: registration.agent,
      runtime: registration.runtime,
      resources: registration.resources,
    });
    const replacement = probe.context!;
    const secondFake = harness.fakes[1]!;
    // The replacement bound a fresh instance: the old signal aborted, its
    // sources stopped exactly once, and a new executor and composition exist.
    expect(replacement).not.toBe(context);
    expect(replacement.signal.aborted).toBe(false);
    expect(replacement.configurationRevision).toBe("revision-2");
    expect(context.signal.aborted).toBe(true);
    expect(harness.fakes).toHaveLength(2);
    expect(secondFake).not.toBe(firstFake);
    expect(firstFake.calls).toEqual(["create", "stop"]);
    expect(probe.stops).toEqual([
      { id: RECORDING_SOURCE_FEATURE_ID, aborted: true },
    ]);
    expect(harness.runWakes.targets).toHaveLength(2);
    expect(harness.runWakes.stopped).toHaveLength(1);

    // The saved handle of the released instance skips both submission forms
    // without mutating either Runtime.
    await expect(context.followUp(message("stale-follow-up"))).resolves.toEqual(
      { status: "skipped", reason: "context_released" },
    );
    await expect(
      context.steer("local-run-current", message("stale-steer")),
    ).resolves.toEqual({ status: "skipped", reason: "context_released" });
    expect(firstFake.calls).toEqual(["create", "stop"]);
    expect(secondFake.calls).toEqual(["create"]);
    expect(probe.events).not.toContain("steer:stale-steer");
    expect(probe.events).not.toContain("submit:start");
  });

  it("skips a steer queued behind a held commit once the store delivers the Context tombstone", async () => {
    const probe = createProbe();
    const storeListeners = new Set<
      (record: Readonly<ExecutionContextRecord>) => void
    >();
    const backing = createInMemoryExecutionContextStore();
    const contextStore: ExecutionContextStore = {
      ensure: (ref, residency) => backing.ensure(ref, residency),
      get: (ref) => backing.get(ref),
      list: () => backing.list(),
      listByAgent: (agentId) => backing.listByAgent(agentId),
      setTargetResidency: (ref, residency) =>
        backing.setTargetResidency(ref, residency),
      remove: (ref) => backing.remove(ref),
      removeByAgent: (agentId) => backing.removeByAgent(agentId),
      subscribe: (listener) => {
        storeListeners.add(listener);
        return () => {
          storeListeners.delete(listener);
        };
      },
      close: () => backing.close(),
    };
    const harness = createHarness({ probe, contextStore });
    await harness.manager.registerAgent(registration, { agentId: "agent-1" });
    // Real startup installs the store subscription through restore().
    await harness.manager.restore();
    const ref = roomMetaRef("room-terminal-steer");
    const runId = await startHeldRun(harness, ref);
    const context = probe.context!;
    const fake = harness.fakes[0]!;
    const steerGate = new Deferred();
    fake.steerGate = steerGate;
    context.signal.addEventListener(
      "abort",
      () => probe.events.push("invalidated"),
      { once: true },
    );

    const first = context.steer(runId, message("steer-1"));
    const second = context.steer(runId, message("steer-2"));
    try {
      await vi.waitFor(() => expect(probe.events).toContain("steer:steer-1"));
      // The terminal record bypasses store.get: the reconcile sets the
      // tombstone synchronously, then its invalidation queues on the
      // admission boundary behind the already-admitted second steer.
      for (const listener of storeListeners) {
        listener({
          ref,
          roomKind: "collaboration",
          targetResidency: "suspended",
          terminalReason: "room_deleted",
        });
      }
      await nextTurn();
      await nextTurn();
      expect(probe.events).not.toContain("invalidated");

      steerGate.resolve();
      // The already-entered first steer commits; the second is fenced by the
      // tombstone inside the boundary, before the queued invalidation runs.
      await expect(first).resolves.toEqual({ status: "accepted" });
      await expect(second).resolves.toEqual({
        status: "skipped",
        reason: "context_terminal",
      });
      // A second durable accept could not hide: the fake Runtime state
      // records every steer marker, so a guard regression surfaces as an accepted result
      // plus steer:steer-2/steered:steer-2 events.
      expect(
        probe.events.filter((event) => event.startsWith("steer:")),
      ).toEqual(["steer:steer-1"]);
      expect(
        probe.events.filter((event) => event.startsWith("steered:")),
      ).toEqual(["steered:steer-1"]);

      // Tombstone cleanup invalidates the signal before source stop and the
      // Runtime stop.
      await vi.waitFor(() => expect(probe.events).toContain("runtime:stop"));
      const invalidatedAt = probe.events.indexOf("invalidated");
      expect(invalidatedAt).toBeGreaterThan(
        probe.events.indexOf("steered:steer-1"),
      );
      expect(
        probe.events.indexOf(`stop:${RECORDING_SOURCE_FEATURE_ID}`),
      ).toBeGreaterThan(invalidatedAt);
      expect(probe.events.indexOf("runtime:stop")).toBeGreaterThan(
        invalidatedAt,
      );
      expect(probe.stops.every(({ aborted }) => aborted)).toBe(true);
      expect(harness.runWakes.stopped).toHaveLength(1);
      await vi.waitFor(async () =>
        expect(await harness.manager.getContextStatus(ref)).toBeNull(),
      );
    } finally {
      steerGate.resolve();
      await Promise.allSettled([first, second]);
    }
  });
});
