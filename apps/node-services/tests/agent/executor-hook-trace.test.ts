import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDeclaration } from "../../src/agent/agent-features/contracts.js";
import type { BuiltinFeatureHost } from "../../src/agent/agent-features/host-ports.js";
import { createAgentContextHost } from "../../src/agent/executor/workspace.js";
import type { AgentManager } from "../../src/agent/executor/agent-manager-api.js";
import { createAgentManagerApplication } from "../../src/agent/executor/application.js";
import { createInMemoryGhostStore } from "./test-support/in-memory-ghost-store.js";
import {
  type ContextRuntimeBackendActivation,
  createContextViewSessions,
} from "../../src/agent/executor/activation.js";
import { createLocalContextRuntimeBackend } from "../../src/agent/executor/local-backend.js";
import { createInMemoryExecutionContextStore } from "./test-support/in-memory-execution-context-store.js";
import type { ExecutionContextRef } from "../../src/agent/executor/context-ref.js";
import type { LocalRuntimeSettings } from "../../src/agent/runtime-settings.js";
import type {
  AgentInput,
  AgentProvider,
  AgentRun,
  ProviderCompactResult,
  RunEvent,
  RunResult,
  RuntimeSession,
} from "../../src/agent/executor/provider.js";
import type { LocalRunTerminal } from "../../src/agent/executor/context-runtime-state.js";
import type {
  Message,
  NonEmptyReadonlyArray,
} from "../../src/agent/executor/types.js";
import { TestContextRuntimeState } from "./test-support/context-runtime-state.js";

/**
 * Golden hook traces of the Agent executor. Each scenario drives the process
 * assembly through the public AgentManager surface and records, in one list,
 * every lifecycle hook call of a test-only feature registered in all three
 * scopes together with the executor's own observable steps (Runtime state
 * writes, backend activation, Provider calls). Restructuring the executor
 * must reproduce these traces exactly; rerun with `-u` only for an intended
 * behavior change.
 */

type TraceEntry = Readonly<Record<string, unknown>>;
type TimerContext = Parameters<BuiltinFeatureHost["timers"]["set"]>[0];

const recorder = vi.hoisted(() => ({
  entries: [] as Record<string, unknown>[],
  /** Ports of the throwing feature that throw in the current scenario. */
  throwingPorts: new Set<string>(),
  host: undefined as BuiltinFeatureHost | undefined,
  boundContext: undefined as TimerContext | undefined,
  record(entry: Record<string, unknown>) {
    this.entries.push(entry);
  },
}));

vi.mock("../../src/agent/agent-features/builtin.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/agent/agent-features/builtin.js")
    >();
  const compose = await import("../../src/agent/agent-features/compose.js");
  const { mergePromptInputContribution } =
    await import("../../src/agent/prompt/input-contribution-merger.js");
  const record = (entry: Record<string, unknown>) => recorder.record(entry);
  const thrower = (port: string) => {
    if (!recorder.throwingPorts.has(port)) return;
    record({ hook: port, feature: "trace-failing", threw: true });
    throw new Error(`trace-failing ${port}`);
  };
  // Handlers of one port run in feature-id order when no feature orders
  // itself after another, so this id sorts before the recorder: each throw
  // precedes the recorder's call of the same port, and a throwing
  // maintenance decision still lets the recorder decide.
  const throwingFeature: FeatureDeclaration = {
    id: "trace-failing",
    context: {
      ports: {
        prepareInput: {},
        onRunEvent: {},
        onRunTerminal: {},
        onTimer: {},
        decideMaintenance: {},
        onMaintenance: {},
      },
      create: () => ({
        prepareInput: () => {
          thrower("prepareInput");
          return null;
        },
        onRunEvent: () => {
          thrower("onRunEvent");
          return null;
        },
        onRunTerminal: () => thrower("onRunTerminal"),
        onTimer: () => thrower("onTimer"),
        decideMaintenance: () => {
          thrower("decideMaintenance");
          return null;
        },
        onMaintenance: () => thrower("onMaintenance"),
      }),
    },
  };
  const recordingFeature: FeatureDeclaration = {
    id: "trace-recorder",
    context: {
      ports: {
        onContextBound: {},
        contributeContextInstructions: {},
        contributeNotificationContext: {},
        prepareInput: {},
        afterInboxInputAccepted: {},
        onTimer: {},
        onRunTerminal: {},
        onRunEvent: {},
        decideMaintenance: {},
        onMaintenance: {},
      },
      create: () => ({
        onContextBound: (context, input) => {
          recorder.boundContext = context;
          record({
            hook: "context.onContextBound",
            context: context.ref,
            bootstrap: input.bootstrap,
          });
          return {
            stop: async () => record({ hook: "context.source.stop" }),
          };
        },
        contributeContextInstructions: (_view, facts) => {
          record({ hook: "context.contributeContextInstructions", facts });
          return undefined;
        },
        contributeNotificationContext: (_view, input) => {
          record({
            hook: "context.contributeNotificationContext",
            inboxId: input.inboxId,
          });
          return [];
        },
        prepareInput: (_view, message) => {
          record({
            hook: "context.prepareInput",
            messageId: message.messageId,
          });
          return null;
        },
        afterInboxInputAccepted: (_context, fact) =>
          record({
            hook: "context.afterInboxInputAccepted",
            inputId: fact.inputId,
          }),
        onTimer: (_context, name) => record({ hook: "context.onTimer", name }),
        onRunTerminal: (_context, event) =>
          record({
            hook: "context.onRunTerminal",
            runId: event.runId,
            terminal: event.terminal.type,
          }),
        onRunEvent: (_view, event) => {
          record({ hook: "context.onRunEvent", event: event.type });
          return null;
        },
        decideMaintenance: (_view, trigger) => {
          record({ hook: "context.decideMaintenance", trigger });
          return trigger.kind === "timer" && trigger.name === MAINTENANCE_TIMER
            ? { kind: "compact", reason: "trace" }
            : null;
        },
        onMaintenance: (_context, event) =>
          record({
            hook: "context.onMaintenance",
            phase: event.phase,
            trigger: event.trigger,
            ...(event.phase === "finished"
              ? { outcome: event.outcome.status }
              : {}),
          }),
      }),
    },
    activation: {
      ports: { prepareRuntime: {} },
      create: () => ({
        prepareRuntime: async (view, input) => {
          record({
            hook: "activation.prepareRuntime",
            context: view.ref,
            newSession: input.newSession ?? false,
          });
          return {
            checkNextRun: async () => {
              record({ hook: "activation.checkNextRun" });
              return true;
            },
            release: async () => record({ hook: "activation.release" }),
          };
        },
      }),
    },
    run: {
      ports: { prepareRunInput: {} },
      create: () => ({
        prepareRunInput: async (_view, input) => {
          record({ hook: "run.prepareRunInput", text: input.text });
          return input;
        },
      }),
    },
  };
  const MAINTENANCE_TIMER = "trace-recorder.maintain";
  return {
    ...actual,
    createBuiltinAgentFeatures: (
      input: Parameters<typeof actual.createBuiltinAgentFeatures>[0],
    ) => {
      const builtin = actual.createBuiltinAgentFeatures(input);
      return {
        ...builtin,
        composeContext: ({
          context,
          host,
          logger,
        }: Parameters<typeof builtin.composeContext>[0]) => {
          recorder.host = host;
          return compose.composeContextFeatures({
            context,
            features: [
              ...builtin.contextDeclarations(host),
              throwingFeature,
              recordingFeature,
            ],
            mergeInputContribution: mergePromptInputContribution,
            ...(logger ? { logger } : {}),
          });
        },
        composeActivation: ({
          view,
          logger,
        }: Parameters<typeof builtin.composeActivation>[0]) =>
          compose.composeActivationFeatures({
            view,
            features: [...builtin.activationDeclarations, recordingFeature],
            ...(logger ? { logger } : {}),
          }),
        composeRun: ({
          view,
          backend,
          logger,
        }: Parameters<typeof builtin.composeRun>[0]) =>
          compose.composeRunFeatures({
            view,
            features: [...builtin.runDeclarations(backend), recordingFeature],
            ...(logger ? { logger } : {}),
          }),
      };
    },
  };
});

vi.mock("../../src/agent/executor/local-backend.js", () => ({
  createLocalContextRuntimeBackend: vi.fn(),
}));

const MAINTENANCE_TIMER = "trace-recorder.maintain";

const ref: ExecutionContextRef = {
  kind: "meta",
  agentId: "agent-trace",
  roomId: "room-trace",
};

const runtime: LocalRuntimeSettings = {
  type: "local",
  model: "test-model",
  placement: {
    type: "local",
    tenantId: "tenant-trace",
    ownerActorId: "owner-trace",
    computerId: "computer-trace",
    runtimeType: "codex",
    workspaceGrantId: "grant-trace",
    assignmentRevision: 1,
  },
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

type RunScript = "complete" | "fail" | "hold";

/** One Provider Run whose end the test controls. */
class ScriptedRun implements AgentRun {
  readonly #end = deferred<"complete" | "fail" | "cancel">();
  readonly events: AsyncIterable<RunEvent>;

  constructor(script: RunScript) {
    const end = this.#end;
    this.events = (async function* () {
      yield { type: "run.started" } satisfies RunEvent;
      yield {
        type: "message.delta",
        messageId: "reply-1",
        delta: "hello",
      } satisfies RunEvent;
      const outcome = await end.promise;
      if (outcome === "complete")
        yield { type: "run.completed" } satisfies RunEvent;
      if (outcome === "fail")
        yield {
          type: "run.failed",
          message: "model failed",
        } satisfies RunEvent;
    })();
    if (script === "complete") this.#end.resolve("complete");
    if (script === "fail") this.#end.resolve("fail");
  }

  finish(outcome: "complete" | "fail"): void {
    this.#end.resolve(outcome);
  }

  async wait(): Promise<RunResult> {
    const outcome = await this.#end.promise;
    if (outcome === "fail") throw new Error("model failed");
    return { finalResponse: outcome === "cancel" ? "canceled" : "done" };
  }

  cancel(): void {
    recorder.record({ step: "provider.run.cancel" });
    this.#end.resolve("cancel");
  }
}

class ScriptedProvider implements AgentProvider {
  readonly scripts: RunScript[] = [];
  readonly runs: ScriptedRun[] = [];

  async createSession(): Promise<RuntimeSession> {
    recorder.record({ step: "provider.createSession" });
    return { threadId: "thread-trace" };
  }

  async resumeSession(session: RuntimeSession): Promise<RuntimeSession> {
    recorder.record({ step: "provider.resumeSession" });
    return session;
  }

  async startRun(
    _session: RuntimeSession,
    input: AgentInput,
  ): Promise<AgentRun> {
    recorder.record({ step: "provider.startRun", text: input.text });
    const run = new ScriptedRun(this.scripts.shift() ?? "complete");
    this.runs.push(run);
    return run;
  }

  async steer(
    _run: AgentRun,
    options: { readonly input: AgentInput },
  ): Promise<{ turnId: string }> {
    recorder.record({ step: "provider.steer", text: options.input.text });
    return { turnId: "turn-trace" };
  }

  async compactSession(): Promise<ProviderCompactResult> {
    recorder.record({ step: "provider.compactSession" });
    return { status: "compacted" };
  }

  async close(): Promise<void> {
    recorder.record({ step: "provider.close" });
  }
}

/** Runtime state that records every write the executor makes. */
class RecordingRuntimeState extends TestContextRuntimeState {
  override enqueueTrustedTurn(messages: NonEmptyReadonlyArray<Message>) {
    const runId = super.enqueueTrustedTurn(messages);
    recorder.record({
      step: "state.enqueueTrustedTurn",
      messageIds: messages.map((m) => m.messageId),
      runId,
    });
    return runId;
  }

  override cancelTrustedTurn(messages: NonEmptyReadonlyArray<Message>) {
    const result = super.cancelTrustedTurn(messages);
    recorder.record({ step: "state.cancelTrustedTurn", ...result });
    return result;
  }

  override claimLocalRun() {
    const claimed = super.claimLocalRun();
    if (claimed)
      recorder.record({
        step: "state.claimLocalRun",
        runId: claimed.runId,
        messageIds: claimed.messages.map((m) => m.messageId),
      });
    return claimed;
  }

  override finishLocalRun(
    runId: string,
    terminal: LocalRunTerminal,
    session?: RuntimeSession,
  ): void {
    recorder.record({
      step: "state.finishLocalRun",
      runId,
      terminal: terminal.type,
    });
    super.finishLocalRun(runId, terminal, session);
  }

  override cancelLocalRun(runId: string) {
    const status = super.cancelLocalRun(runId);
    recorder.record({ step: "state.cancelLocalRun", runId, status });
    return status;
  }

  override acceptTrustedNotification(runId: string, message: Message) {
    const result = super.acceptTrustedNotification(runId, message);
    recorder.record({
      step: "state.acceptTrustedNotification",
      runId,
      messageId: message.messageId,
      status: result.status,
    });
    return result;
  }

  override completeSteer(
    groupId: string,
    runId: string,
    outcome: "applied" | "uncertain",
  ): void {
    recorder.record({ step: "state.completeSteer", runId, outcome });
    super.completeSteer(groupId, runId, outcome);
  }
}

const message = (messageId: string, text: string): Message => ({
  messageId,
  rawMessage: text,
  segments: [{ type: "text", content: text }],
});

interface Harness {
  readonly agentManager: AgentManager<LocalRuntimeSettings>;
  readonly provider: ScriptedProvider;
  readonly activationGate: { current: Deferred<void> | null };
  close(): Promise<void>;
}

const roots: string[] = [];
const developerInstructions: string[] = [];

const digest = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

const createHarness = async (): Promise<Harness> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "executor-hook-trace-"));
  roots.push(root);
  const provider = new ScriptedProvider();
  const activationGate: { current: Deferred<void> | null } = { current: null };
  vi.mocked(createLocalContextRuntimeBackend).mockReturnValue({
    activate: async (request) => {
      // The rendered instructions are one golden file of their own; the
      // trace keeps a digest so every scenario still pins them.
      const instructions = request.agent.developerInstructions ?? "";
      developerInstructions.push(instructions);
      recorder.record({
        step: "backend.activate",
        developerInstructions: digest(instructions),
        mappings: request.viewPlan.mappings.length,
      });
      await activationGate.current?.promise;
      const activation: ContextRuntimeBackendActivation = {
        provider,
        runtimeName: "trace",
        sessionSpec: {
          workingDirectory: "/workspace",
          threadName: request.agent.name,
          sandboxMode: "workspace-write",
          resources: { mcpServers: [] },
        },
        setActiveRunContext() {},
        async synchronize() {},
        async deactivate() {
          recorder.record({ step: "backend.deactivate" });
        },
      };
      return activation;
    },
  });
  const application = createAgentManagerApplication({
    identityResolver: {
      resolveIdentity: async () => ({
        actorId: "actor-trace",
        agentType: "general",
        sponsor: { actorId: "sponsor-trace", displayName: "Sponsor" },
      }),
    },
    stateBackend: {
      kind: "test",
      ghostStore: createInMemoryGhostStore<LocalRuntimeSettings>(),
      contextStore: createInMemoryExecutionContextStore(),
      runtimeStateFactory: async (input) =>
        new RecordingRuntimeState({ databasePath: ":memory:", ref: input.ref }),
    },
    contextHost: await createAgentContextHost({ rootPath: root }),
    contextViewSessions: createContextViewSessions(),
    runnerGateway: {
      contextViewContent: {},
      isLocalComputerExecutionReady: () => true,
      supportsSessionCompaction: () => true,
    } as never,
    localMcpRelay: {} as never,
  });
  const agentManager = application.agentManager;
  await agentManager.registerAgent(
    {
      tenantId: "tenant-trace",
      revision: "1",
      agent: {
        name: "Trace Agent",
        instructions: "Answer briefly.",
        developerInstructions: "Configured developer policy.",
      },
      runtime,
    },
    { agentId: ref.agentId },
  );
  return {
    agentManager,
    provider,
    activationGate,
    close: async () => {
      await agentManager.close();
      await application.closeRuntimeHosts();
    },
  };
};

/** Lets background continuations of the previous step settle. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

const waitForEntry = async (
  predicate: (entry: Record<string, unknown>) => boolean,
): Promise<void> => {
  await vi.waitFor(
    () => {
      if (!recorder.entries.some(predicate))
        throw new Error("trace entry not recorded yet");
    },
    { timeout: 2_000, interval: 5 },
  );
  await settle();
};

const hasStep =
  (step: string, extra: Record<string, unknown> = {}) =>
  (entry: Record<string, unknown>) =>
    entry.step === step &&
    Object.entries(extra).every(([key, value]) => entry[key] === value);

/** Replaces generated identifiers and temporary paths with stable names. */
const normalizedTrace = (root: string): TraceEntry[] => {
  const runIds = new Map<string, string>();
  const runName = (value: string) => {
    let name = runIds.get(value);
    if (!name) {
      name = `run-${runIds.size + 1}`;
      runIds.set(value, name);
    }
    return name;
  };
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string")
      return value
        .replaceAll(root, "<root>")
        .replace(/local-run-[0-9a-f-]+/g, (id) => runName(id));
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, normalize(entry)]),
      );
    return value;
  };
  return recorder.entries.map((entry) => normalize(entry) as TraceEntry);
};

const expectGolden = async (scenario: string): Promise<void> => {
  const root = roots.at(-1)!;
  // One JSON entry per line keeps a reordered hook a one-line diff.
  const lines = normalizedTrace(root).map((entry) => JSON.stringify(entry));
  await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot(
    `./__golden__/executor-hook-trace/${scenario}.jsonl`,
  );
};

let harness: Harness;

beforeEach(async () => {
  recorder.entries.length = 0;
  developerInstructions.length = 0;
  recorder.throwingPorts.clear();
  recorder.host = undefined;
  recorder.boundContext = undefined;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const submit = (messageId: string, text: string) =>
  harness.agentManager.submitTrustedTurn({
    target: ref,
    messages: [message(messageId, text)],
  });

describe("executor hook trace", () => {
  it("cold activation, then a hot message", async () => {
    await submit("m-1", "first");
    await waitForEntry(hasStep("state.finishLocalRun"));
    recorder.record({ mark: "hot message" });
    await submit("m-2", "second");
    await waitForEntry(
      (entry) =>
        entry.step === "state.finishLocalRun" &&
        recorder.entries.filter((e) => e.step === "state.finishLocalRun")
          .length === 2,
    );
    await expectGolden("cold-then-hot");
    expect(developerInstructions).toHaveLength(1);
    await expect(developerInstructions[0]).toMatchFileSnapshot(
      "./__golden__/executor-hook-trace/developer-instructions.txt",
    );
  });

  it("steers a message into the running Run", async () => {
    harness.provider.scripts.push("hold");
    await submit("m-1", "long task");
    await waitForEntry(hasStep("provider.startRun"));
    recorder.record({ mark: "steer" });
    const steered = await harness.agentManager.steerActiveTurn({
      target: ref,
      message: message("m-2", "also this"),
    });
    recorder.record({ mark: "steered", steered: steered !== null });
    await waitForEntry(hasStep("provider.steer"));
    harness.provider.runs[0]!.finish("complete");
    await waitForEntry(hasStep("state.finishLocalRun"));
    await expectGolden("steer");
  });

  it("records a failed Run", async () => {
    harness.provider.scripts.push("fail");
    await submit("m-1", "will fail");
    await waitForEntry(hasStep("state.finishLocalRun"));
    await expectGolden("run-failed");
  });

  it("cancels a running Run", async () => {
    harness.provider.scripts.push("hold");
    const delivery = {
      target: ref,
      messages: [message("m-1", "stop me")],
    } as const;
    await harness.agentManager.submitTrustedTurn(delivery);
    await waitForEntry(hasStep("provider.startRun"));
    recorder.record({ mark: "stop" });
    const canceled = await harness.agentManager.cancelTrustedTurn(delivery);
    recorder.record({ mark: "stop returned", status: canceled.cancelStatus });
    await waitForEntry(hasStep("state.finishLocalRun"));
    await expectGolden("run-canceled");
  });

  it("stops a turn whose submit is still activating", async () => {
    harness.activationGate.current = deferred<void>();
    const delivery = {
      target: ref,
      messages: [message("m-1", "stop before start")],
    } as const;
    const submitted = harness.agentManager.submitTrustedTurn(delivery);
    await waitForEntry(hasStep("backend.activate"));
    recorder.record({ mark: "stop during submit" });
    const canceled = await harness.agentManager.cancelTrustedTurn(delivery);
    recorder.record({ mark: "stop returned", status: canceled.cancelStatus });
    harness.activationGate.current.resolve();
    await submitted;
    recorder.record({ mark: "submit returned" });
    await settle();
    await expectGolden("stop-during-submit");
  });

  it("fires a feature timer that decides and runs maintenance", async () => {
    await submit("m-1", "first");
    await waitForEntry(hasStep("state.finishLocalRun"));
    recorder.record({ mark: "timer" });
    recorder.host!.timers.set(
      recorder.boundContext!,
      MAINTENANCE_TIMER,
      Date.now(),
    );
    await waitForEntry(
      (entry) =>
        entry.hook === "context.onMaintenance" && entry.phase === "finished",
    );
    await expectGolden("timer-maintenance");
  });

  it("releases the Context", async () => {
    await submit("m-1", "first");
    await waitForEntry(hasStep("state.finishLocalRun"));
    recorder.record({ mark: "release" });
    await harness.agentManager.stopContext(ref);
    await settle();
    await expectGolden("release");
  });

  it("fails the Run when an input hook throws", async () => {
    recorder.throwingPorts.add("prepareInput");
    await submit("m-1", "first");
    await waitForEntry(hasStep("state.finishLocalRun"));
    await expectGolden("throwing-input-hook");
  });

  it("isolates observer and maintenance handlers that throw", async () => {
    for (const port of [
      "onRunEvent",
      "onRunTerminal",
      "onTimer",
      "decideMaintenance",
      "onMaintenance",
    ])
      recorder.throwingPorts.add(port);
    await submit("m-1", "first");
    await waitForEntry(hasStep("state.finishLocalRun"));
    recorder.record({ mark: "timer" });
    recorder.host!.timers.set(
      recorder.boundContext!,
      MAINTENANCE_TIMER,
      Date.now(),
    );
    await waitForEntry(
      (entry) =>
        entry.hook === "context.onMaintenance" && entry.phase === "finished",
    );
    await expectGolden("throwing-handlers");
  });
});
