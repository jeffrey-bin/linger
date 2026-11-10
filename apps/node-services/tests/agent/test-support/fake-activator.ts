import type {
  ActivatedContextRuntime,
  ContextRuntimeActivationRequest,
} from "../../../src/agent/executor/activation.js";
import type { ExecutorServices } from "../../../src/agent/executor/context-executor.js";
import type { ExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import type {
  ContextRuntimeStatePort,
  ExecutionResources,
  LocalRunTerminal,
  MessageSteer,
} from "../../../src/agent/executor/context-runtime-state.js";
import type { RuntimeHistoryPage } from "../../../src/agent/executor/history.js";
import type {
  AgentInput,
  AgentProvider,
  AgentRun,
  ProviderCompactResult,
  RunResult,
  RuntimeSession,
} from "../../../src/agent/executor/provider.js";
import type {
  Message,
  NonEmptyReadonlyArray,
  RunCancellationStatus,
} from "../../../src/agent/executor/types.js";
import { TestContextRuntimeState } from "./context-runtime-state.js";

export class Deferred<T = void> {
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;
  readonly promise = new Promise<T>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
}

/** One Provider Run the test holds open until it settles it. */
export class HeldRun implements AgentRun {
  readonly events: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true, value: undefined }),
    }),
  };
  readonly #result = new Deferred<RunResult>();
  cancelCalls = 0;

  wait(): Promise<RunResult> {
    return this.#result.promise;
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.#result.resolve({ finalResponse: "canceled" });
  }

  succeed(): void {
    this.#result.resolve({ finalResponse: "done" });
  }
}

/**
 * The Runtime of one Context executor, faked below the executor: the
 * activation, the Provider and the durable Runtime state. Each executor the
 * registry creates gets its own FakeRuntime. `calls` records, in order, what
 * the executor did to it:
 *
 * - `create`: the executor opened its Runtime state.
 * - `start` / `resume`: an activation without / with a persisted session.
 * - `deactivate`: the activated Runtime was released (suspend or stop).
 * - `stop`: the executor stopped and closed its Runtime state.
 * - `submitTrustedTurn`, `queued:queued`, `cancelRun:<id>`,
 *   `steer:<messageId>`, `compactSession:<instructions>`,
 *   `inspectRuntimeHistory`, `presence`.
 */
export class FakeRuntime {
  readonly calls: string[] = [];
  readonly events: string[];
  readonly received: Message[][] = [];
  /** Trusted notifications steered into a running Run. */
  readonly steered: Message[] = [];
  readonly inputs: AgentInput[] = [];
  /** Inputs the Provider steered into a running Run. */
  readonly providerSteers: AgentInput[] = [];
  readonly runs: HeldRun[] = [];
  readonly activations: ContextRuntimeActivationRequest<unknown>[] = [];
  createGate: Deferred | null = null;
  startGate: Deferred | null = null;
  resumeGate: Deferred | null = null;
  /** Held while a deactivation runs, after `deactivate` is recorded. */
  suspendGate: Deferred | null = null;
  /** Held inside a durable trusted-turn acceptance. */
  receiveGate: Deferred | null = null;
  /** Held inside a durable trusted-notification (steer) acceptance. */
  steerGate: Deferred | null = null;
  compactGate: Deferred | null = null;
  startError: Error | null = null;
  /** Called as the executor opens its state, after its gate; a throw fails it. */
  onOpen: (() => void | Promise<void>) | null = null;
  /** Called as the executor closes its state on stop; a throw fails the stop. */
  onStop: (() => void | Promise<void>) | null = null;
  /** Called as each deactivation runs, after its gate; a throw fails it. */
  onDeactivate: (() => void | Promise<void>) | null = null;
  /** Called as each activation begins, before its gate. */
  onActivate:
    | ((
        request: ContextRuntimeActivationRequest<unknown>,
      ) => void | Promise<void>)
    | null = null;
  stopError: Error | null = null;
  /** The Runtime state reports pending work, so the executor is busy. */
  busy = false;
  /** Runs stay running until the test settles them. */
  holdRuns = false;
  /** Checked before each new Run; false means the Agent's resources changed. */
  prepareNextRun: ((signal: AbortSignal) => Promise<boolean>) | null = null;
  compactResult: ProviderCompactResult = { status: "compacted" };
  history: RuntimeHistoryPage | null = null;
  /** A Runtime session persisted before this executor; activation resumes it. */
  persistedSession: RuntimeSession = null;
  /**
   * Executors of one Context whose FakeRuntimes name the same path share
   * durable Runtime state, as a replacement reads the same TeamHub rows.
   */
  databasePath = ":memory:";
  /** The configuration revision the executor opened its state with. */
  configurationRevision: string | undefined;
  /** The Runtime settings the executor opened its state with. */
  runtimeSettings: unknown;
  #state: TestContextRuntimeState | null = null;

  constructor(events: string[] = []) {
    this.events = events;
  }

  /** The durable Runtime state of this executor. */
  get state(): TestContextRuntimeState {
    if (!this.#state) throw new Error("The Runtime state was not opened");
    return this.#state;
  }

  /** The Run the Provider is executing now. */
  get currentRun(): HeldRun | undefined {
    return this.runs.at(-1);
  }

  /** The latest activation request. */
  get lastActivation(): ContextRuntimeActivationRequest<unknown> | undefined {
    return this.activations.at(-1);
  }

  async openState(input: {
    readonly ref: ExecutionContextRef;
    readonly configurationRevision: string;
    readonly runtime: unknown;
  }): Promise<ContextRuntimeStatePort> {
    const { ref } = input;
    this.configurationRevision = input.configurationRevision;
    this.runtimeSettings = input.runtime;
    this.calls.push("create");
    await this.createGate?.promise;
    await this.onOpen?.();
    const state = new TestContextRuntimeState({
      databasePath: this.databasePath,
      ref,
    });
    if (this.persistedSession !== null)
      state.setRuntimeSession(this.persistedSession);
    this.#state = state;
    return new FakeRuntimeState(this, state);
  }

  async activate(
    request: ContextRuntimeActivationRequest<unknown>,
  ): Promise<ActivatedContextRuntime> {
    this.activations.push(request);
    this.calls.push(request.mode);
    this.events.push(`runtime:${request.mode}`);
    await this.onActivate?.(request);
    const gate = request.mode === "start" ? this.startGate : this.resumeGate;
    if (gate) {
      // An aborted activation stops waiting, as a real one does.
      await Promise.race([
        gate.promise,
        new Promise<never>((_resolve, reject) => {
          const abort = () => {
            this.events.push("runtime:aborted");
            reject(request.signal?.reason);
          };
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
    }
    if (this.startError) throw this.startError;
    const provider: AgentProvider = {
      createSession: async () => ({ threadId: "thread-fake" }),
      resumeSession: async (session) => session,
      prepareForPresence: () => {
        this.calls.push("presence");
      },
      inspectHistory: async () => {
        this.calls.push("inspectRuntimeHistory");
        if (!this.history) throw new Error("No fake history");
        return this.history;
      },
      compactSession: async (_session, options) => {
        this.calls.push(`compactSession:${options.instructions ?? ""}`);
        if (this.compactGate) {
          // Arriving work aborts compaction, as a real Runtime's does.
          await Promise.race([
            this.compactGate.promise,
            new Promise<never>((_resolve, reject) => {
              const abort = () => reject(options.signal.reason);
              if (options.signal.aborted) abort();
              else
                options.signal.addEventListener("abort", abort, {
                  once: true,
                });
            }),
          ]);
        }
        return this.compactResult;
      },
      startRun: async (_session, input) => {
        this.inputs.push(input);
        const run = new HeldRun();
        this.runs.push(run);
        if (!this.holdRuns) run.succeed();
        return run;
      },
      steer: async (_run, options) => {
        this.providerSteers.push(options.input);
        return { turnId: "turn-fake" };
      },
      close: async () => {},
    };
    return {
      ref: request.ref,
      provider,
      runtimeName: "test",
      runtimeSession: request.previousSession ?? { threadId: "thread-fake" },
      sessionSpec: {
        workingDirectory: "/workspace",
        threadName: request.agent.name,
        sandboxMode: "workspace-write",
        resources: { mcpServers: [] },
      },
      prepareNextRun: (signal) =>
        this.prepareNextRun?.(signal) ?? Promise.resolve(true),
      setActiveRunContext() {},
      deactivate: async () => {
        this.calls.push("deactivate");
        this.events.push("runtime:deactivate");
        await this.suspendGate?.promise;
        await this.onDeactivate?.();
      },
    };
  }
}

/**
 * The services of executors whose Runtimes are FakeRuntimes. `runtimeFor`
 * returns the FakeRuntime of each new executor; the activation finds it by
 * the Context the state was opened for.
 */
export function fakeActivator<TRuntimeSettings>(
  runtimeFor: (ref: ExecutionContextRef) => FakeRuntime,
): ExecutorServices<TRuntimeSettings> {
  const runtimes = new Map<string, FakeRuntime>();
  const key = (ref: ExecutionContextRef) => JSON.stringify(ref);
  return {
    stateFactory: async (input) => {
      const runtime = runtimeFor(input.ref);
      runtimes.set(key(input.ref), runtime);
      return runtime.openState(input);
    },
    inspectPersistedHistory: async (request) => {
      const runtime = runtimes.get(key(request.ref));
      runtime?.calls.push("inspectRuntimeHistory");
      if (!runtime?.history) throw new Error("No fake history");
      return runtime.history;
    },
    activator: {
      activate: (request) => {
        const runtime = runtimes.get(key(request.ref));
        if (!runtime) throw new Error("No fake Runtime for this Context");
        return runtime.activate(request);
      },
    },
  };
}

class FakeRuntimeState implements ContextRuntimeStatePort {
  readonly #runtime: FakeRuntime;
  readonly #state: TestContextRuntimeState;

  constructor(runtime: FakeRuntime, state: TestContextRuntimeState) {
    this.#runtime = runtime;
    this.#state = state;
  }

  async acceptTrustedNotification(runId: string, message: Message) {
    this.#runtime.calls.push(`steer:${message.messageId}`);
    this.#runtime.events.push(`steer:${message.messageId}`);
    await this.#runtime.steerGate?.promise;
    this.#runtime.events.push(`steered:${message.messageId}`);
    const accepted = this.#state.acceptTrustedNotification(runId, message);
    if (accepted.status === "committed") this.#runtime.steered.push(message);
    return accepted;
  }

  async enqueueTrustedTurn(
    messages: NonEmptyReadonlyArray<Message>,
  ): Promise<string> {
    this.#runtime.calls.push("submitTrustedTurn");
    this.#runtime.events.push("submit:start");
    await this.#runtime.receiveGate?.promise;
    this.#runtime.received.push(messages.map((message) => ({ ...message })));
    this.#runtime.events.push("submit:end");
    return this.#state.enqueueTrustedTurn(messages);
  }

  cancelTrustedTurn(messages: NonEmptyReadonlyArray<Message>) {
    return this.#state.cancelTrustedTurn(messages);
  }

  claimLocalRun() {
    return this.#state.claimLocalRun();
  }

  requeueLocalRun(runId: string) {
    this.#state.requeueLocalRun(runId);
  }

  finishLocalRun(
    runId: string,
    terminal: LocalRunTerminal,
    session?: RuntimeSession,
  ) {
    this.#state.finishLocalRun(runId, terminal, session);
  }

  takeMessageSteers(): readonly MessageSteer[] {
    return this.#state.takeMessageSteers();
  }

  noteQueuedRun(): void {
    this.#runtime.calls.push("queued:queued");
    this.#runtime.events.push("queued:queued");
  }

  cancelLocalRun(runId: string): RunCancellationStatus {
    this.#runtime.calls.push(`cancelRun:${runId}`);
    return this.#state.cancelLocalRun(runId);
  }

  getLocalRun(runId: string) {
    return this.#state.getLocalRun(runId);
  }

  enqueueSteer(groupId: string, messages: NonEmptyReadonlyArray<Message>) {
    return this.#state.enqueueSteer(groupId, messages);
  }

  assignSteerRun(groupId: string, runId: string) {
    this.#state.assignSteerRun(groupId, runId);
  }

  completeSteer(
    groupId: string,
    runId: string,
    outcome: "applied" | "uncertain",
  ) {
    this.#state.completeSteer(groupId, runId, outcome);
  }

  hasQueuedRuns(): boolean {
    return this.#state.hasQueuedRuns();
  }

  hasPendingWork(): boolean {
    return this.#runtime.busy || this.#state.hasPendingWork();
  }

  acceptedInputPending(): boolean {
    return this.#state.acceptedInputPending();
  }

  earliestAcceptedInputMs(): number | undefined {
    return this.#state.earliestAcceptedInputMs();
  }

  getRuntimeSession(): RuntimeSession {
    return this.#state.getRuntimeSession();
  }

  setRuntimeSession(
    session: RuntimeSession,
    resources?: ExecutionResources | null,
  ) {
    this.#state.setRuntimeSession(session, resources);
  }

  getExecutionResources(): ExecutionResources | null {
    return this.#state.getExecutionResources();
  }

  setExecutionResources(resources: ExecutionResources) {
    this.#state.setExecutionResources(resources);
  }

  clearRuntimeSession(): boolean {
    this.#runtime.calls.push("clearRuntimeSession");
    return this.#state.clearRuntimeSession();
  }

  async close(): Promise<void> {
    this.#runtime.calls.push("stop");
    this.#runtime.events.push("runtime:stop");
    this.#state.close();
    await this.#runtime.onStop?.();
    if (this.#runtime.stopError) throw this.#runtime.stopError;
  }
}
