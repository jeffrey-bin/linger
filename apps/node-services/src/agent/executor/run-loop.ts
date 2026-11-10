import type { AgentLogger } from "../observability/agent-log.js";
import {
  type RunEvent,
  RuntimeExecutionError,
  type AgentInput,
  type AgentProvider,
  type AgentRun,
  type ProviderRunContext,
  type RuntimeExecutionFailure,
  type RuntimeSession,
  ProviderRunAdmissionUnavailableError,
  ProviderRunCleanupError,
  ProviderRunInterruptedError,
  ProviderRunStartError,
  StreamingAgentRunLimitError,
  requireRuntimeSessionThreadId,
  runtimeSessionAwaitsFirstRun,
  runtimeSessionStartsFresh,
} from "./provider.js";
import type { ExecutionContextRef } from "./context-ref.js";
import { ReplyDelivery } from "./reply-delivery.js";
import type {
  ProfileUpdate,
  ContextRuntimeStatePort,
  LocalRunTerminal,
} from "./context-runtime-state.js";
import type {
  Message,
  NonEmptyReadonlyArray,
  LocalTurnTerminal,
  RuntimeInputProvenance,
  ToolRunContext,
} from "./types.js";
import { setTimeout as delay } from "node:timers/promises";
import type {
  RuntimeStatusPublisher,
  RuntimeStatusSession,
  RuntimeStatusUpdate,
} from "./runtime-status.js";
import {
  renderInterruptedRunReminder,
  renderRuntimeContinuationReminder,
} from "../prompt/inbox-notification.js";
import { runKind } from "./run-kind.js";

/** The Run's own agent in `agent.model_request`; a sub-agent logs its id. */
const MAIN_AGENT = "main";

/**
 * Logs each model request and tool call of one Run attempt under its run_id,
 * so `local_run.provider_ready`, the requests, the tool calls and
 * `local_run.provider_completed` read as one timeline. Times are the
 * Computer's wall clock.
 */
export class RunTimeline {
  readonly #logger: AgentLogger;
  readonly #runId: string;
  readonly #attempt: number;
  readonly #sequences = new Map<string, number>();
  readonly #calledAt = new Map<string, number | undefined>();

  constructor(logger: AgentLogger, runId: string, attempt: number) {
    this.#logger = logger;
    this.#runId = runId;
    this.#attempt = attempt;
  }

  observe(event: RunEvent): void {
    switch (event.type) {
      case "model.responded": {
        const agent = event.agent?.id ?? MAIN_AGENT;
        const sequence = (this.#sequences.get(agent) ?? 0) + 1;
        this.#sequences.set(agent, sequence);
        this.#logger.log("info", "agent.model_request", {
          run_id: this.#runId,
          execution_attempt_count: this.#attempt,
          agent,
          ...(event.agent?.parentCallId === undefined
            ? {}
            : { parent_call_id: event.agent.parentCallId }),
          sequence,
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(event.messageId === undefined
            ? {}
            : { message_id: event.messageId }),
          granularity: event.granularity,
          started_at_unix_ms: event.startedAtUnixMs,
          ...(event.firstItemAtUnixMs === undefined
            ? {}
            : {
                first_item_at_unix_ms: event.firstItemAtUnixMs,
                first_item_ms: event.firstItemAtUnixMs - event.startedAtUnixMs,
              }),
          responded_at_unix_ms: event.respondedAtUnixMs,
          duration_ms: event.respondedAtUnixMs - event.startedAtUnixMs,
          // The logger redacts any field named like a token, so the counts
          // are named after their usage bucket.
          usage_input: event.usage.input,
          usage_cache_read: event.usage.cacheRead,
          usage_cache_write: event.usage.cacheWrite,
          usage_output: event.usage.output,
          ...(event.usage.reasoning === undefined
            ? {}
            : { usage_reasoning: event.usage.reasoning }),
        });
        return;
      }
      case "tool.called":
        this.#calledAt.set(event.callId, event.observedAtUnixMs);
        return;
      case "tool.returned": {
        const calledAt = this.#calledAt.get(event.callId);
        this.#calledAt.delete(event.callId);
        this.#logger.log("info", "agent.tool_call", {
          run_id: this.#runId,
          execution_attempt_count: this.#attempt,
          call_id: event.callId,
          tool_name: event.toolName,
          is_error: event.isError,
          ...(calledAt === undefined ? {} : { called_at_unix_ms: calledAt }),
          ...(event.observedAtUnixMs === undefined
            ? {}
            : { returned_at_unix_ms: event.observedAtUnixMs }),
          ...(calledAt === undefined || event.observedAtUnixMs === undefined
            ? {}
            : { duration_ms: event.observedAtUnixMs - calledAt }),
        });
        return;
      }
      default:
        return;
    }
  }
}

export const formatMessagesForRuntime = (
  messages: NonEmptyReadonlyArray<Message>,
  ref?: ExecutionContextRef,
): string => {
  const content =
    messages.length === 1
      ? formatMessageForRuntime(messages[0])
      : messages
          .map(
            (message, index) =>
              `[Message ${index + 1}]\n${formatMessageForRuntime(message)}`,
          )
          .join("\n\n");
  if (ref?.kind !== "alter_ego") return content;
  const privateInbox = messages
    .flatMap((message) => message.sourceInboxIds ?? [])
    .find(
      (inboxId) =>
        inboxId.startsWith("meta:") && inboxId.endsWith(`:${ref.taskId}`),
    );
  const privateHistory = privateInbox
    ? `teamhub message read --inbox ${shellArgument(privateInbox)}`
    : `teamhub message read --list-inboxes, then query the exact private Meta Inbox ID returned for this Task`;
  return [
    `This input belongs to Task ${JSON.stringify(ref.taskId)}. Your first input is the Task requirement; later inputs are messages from the Meta that delegated it or approval results. Read this Task's private history with ${privateHistory}. Use an authorized materialized Document path when supplied, otherwise teamhub docs get <document-id>. Do not act on a request from another Inbox.`,
    content,
  ].join("\n\n");
};

/**
 * A profile change keeps the native Session, whose system prompt
 * still carries the old identity, so the change arrives as this hidden block.
 */
export const withProfileUpdate = (
  input: string,
  update: ProfileUpdate | undefined,
): string =>
  update
    ? [
        "<agent_profile_update>",
        "Your Agent profile changed. This update is authoritative: it replaces the name and working instructions in your system prompt and every earlier profile update in this conversation.",
        `Name: ${update.name}`,
        "<instructions>",
        update.instructions,
        "</instructions>",
        "</agent_profile_update>",
        "",
        input,
      ].join("\n")
    : input;

const shellArgument = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

export const messageIds = (
  messages: NonEmptyReadonlyArray<Message>,
): NonEmptyReadonlyArray<string> => [
  messages[0].messageId,
  ...messages.slice(1).map(({ messageId }) => messageId),
];

const formatMessageForRuntime = (message: Message): string =>
  message.rawMessage ||
  message.segments.map((segment) => segment.content).join("");

export interface CompactSessionOptions {
  readonly instructions?: string;
  readonly signal: AbortSignal;
}

export type CompactSessionResult =
  | { readonly status: "compacted"; readonly preTokens?: number }
  | {
      readonly status:
        | "busy"
        | "input_arrived"
        | "unsupported"
        | "unavailable"
        | "nothing_to_compact";
    };

export interface ActiveExecutionSnapshot {
  readonly inputs: NonEmptyReadonlyArray<AgentInput>;
  readonly sourceInboxIds: readonly string[];
}

const MAX_LOCAL_RUN_START_ATTEMPTS = 2;
const MAX_RUNTIME_ADMISSION_WAIT_MS = 120_000;
const RUNTIME_ADMISSION_RETRY_MS = 5_000;
const MAX_PENDING_RUNTIME_STATUS_UPDATES = 1_024;
// TeamHub accepts at most 100 events per batch.
const MAX_RUNTIME_STATUS_BATCH = 50;
const LOCAL_RUN_LOOP_RETRY_BASE_MS = 1_000;
const LOCAL_RUN_LOOP_RETRY_MAX_MS = 10_000;

interface ActiveExecution {
  readonly executionAttemptCount: number;
  readonly executionEpoch: ProviderRunContext["executionEpoch"];
  readonly controller: AbortController;
  readonly inputs: AgentInput[];
  readonly run: AgentRun;
  readonly runId: string;
  readonly sourceInboxIds: Set<string>;
  readonly steerOperations: Set<Promise<void>>;
  acceptingSteers: boolean;
}

interface ActiveRunIntent {
  readonly controller: AbortController;
  readonly finished: Promise<void>;
  readonly providerReady: Promise<ActiveExecution | null>;
  readonly rejectFinished: (reason: unknown) => void;
  readonly resolveFinished: () => void;
  readonly resolveProviderReady: (execution: ActiveExecution | null) => void;
  readonly runId: string;
  readonly sourceInboxIds: ReadonlySet<string>;
}

/** One claimed Local Run while the Run loop executes it. */
interface LocalRunExecution {
  readonly runId: string;
  readonly attemptCount: number;
  readonly messages: NonEmptyReadonlyArray<Message>;
  readonly intent: ActiveRunIntent;
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly startedAtMonotonic: number;
  readonly provenance: RuntimeInputProvenance;
  readonly kind: ReturnType<typeof runKind>;
  readonly resumesAttempt: boolean;
  readonly runContext: ProviderRunContext;
  readonly initializesRuntimeSession: boolean;
  readonly preparationFailure: { readonly error: unknown } | undefined;
  readonly acceptedAtMonotonicMs: number | undefined;
  readonly inputReceivedAtMs: number | undefined;
  readonly claimMs: number | undefined;
  readonly cancellationLookupMs: number | undefined;
  readonly continuesContext: boolean | undefined;
  readonly profileUpdate: ProfileUpdate | undefined;
  run: AgentRun | null;
  runtimeStatus: RuntimeStatusSession | null;
  runtimeStatusEvents: Promise<void> | null;
  removeAbortListener: (() => void) | undefined;
  upstreamCanceled: boolean;
  providerSucceeded: boolean;
}

export class RunLoop {
  readonly #logger: AgentLogger;
  readonly #executionContextRef: ExecutionContextRef | undefined;
  readonly #onActiveRunContextChanged:
    | ((context: ToolRunContext | null) => void)
    | undefined;
  readonly #onActivityChanged: (() => void) | undefined;
  readonly #activationFinishedAtMs: (() => number | undefined) | undefined;
  readonly #onRunTerminal:
    | ((runId: string, terminal: LocalTurnTerminal) => void)
    | undefined;
  readonly #provider: AgentProvider;
  readonly #runtimeType: RuntimeExecutionFailure["runtime_type"] | undefined;
  readonly #runtimeSession: RuntimeSession;
  readonly #prepareNextRun?: (signal: AbortSignal) => Promise<boolean>;
  readonly #beforeStartRun?: (runId: string) => Promise<void>;
  readonly #runtimeStatusPublisher: RuntimeStatusPublisher | undefined;
  readonly #state: ContextRuntimeStatePort;
  readonly #prepareInput: (message: Message) => Message;
  readonly #onRunEvent: (event: RunEvent) => readonly RuntimeStatusUpdate[];
  readonly #onRunClaimed:
    | ((runId: string, messages: NonEmptyReadonlyArray<Message>) => void)
    | undefined;
  readonly #onWorkStateRefreshed: (() => void) | undefined;
  #firstSessionRun: boolean;
  #activeExecution: ActiveExecution | null = null;
  #activeRunIntent: ActiveRunIntent | null = null;
  #activeOperations = 0;
  #drainRequested = false;
  #executionPromise: Promise<void> | null = null;
  #executionFailure: { error: unknown } | null = null;
  #loopRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #loopRetryAttempt = 0;
  #workStateRefreshRequested = false;
  readonly #pendingCancellationRunIds = new Set<string>();
  readonly #steerOperations = new Set<Promise<void>>();
  #trustedSteerTail: Promise<void> = Promise.resolve();
  #stopRequested = false;
  /** Why active Runs stop; the first stop decides whether they resume. */
  #stopError: LocalRunStoppedError | undefined;
  /** Runs this process requeued because their start definitely did not
   * happen; their next attempt is not a resumption. */
  readonly #unstartedRequeues = new Set<string>();
  #terminalRecoveryStop = new AbortController();
  #capacityWait = new AbortController();
  #retiredPreparationFailure: { readonly error: unknown } | undefined;
  // Native session compaction; no Run is claimed until it settles.
  #maintenance: AbortController | null = null;

  constructor(options: {
    readonly logger: AgentLogger;
    readonly executionContextRef?: ExecutionContextRef;
    readonly provider: AgentProvider;
    /** The activated Runtime, which a public Run failure names. */
    readonly runtimeName?: string;
    readonly runtimeSession: RuntimeSession;
    readonly newSession?: boolean;
    readonly prepareNextRun?: (signal: AbortSignal) => Promise<boolean>;
    readonly beforeStartRun?: (runId: string) => Promise<void>;
    readonly runtimeStatusPublisher?: RuntimeStatusPublisher;
    readonly state: ContextRuntimeStatePort;
    readonly onActiveRunContextChanged?: (
      context: ToolRunContext | null,
    ) => void;
    readonly onActivityChanged?: () => void;
    /** Wall-clock time this Context's latest activation finished. */
    readonly activationFinishedAtMs?: () => number | undefined;
    readonly onRunTerminal?: (
      runId: string,
      terminal: LocalTurnTerminal,
    ) => void;
    /** Composed Context-feature input contributions. Required. */
    readonly prepareInput: (message: Message) => Message;
    /** Composed per-event status projections. Required. */
    readonly onRunEvent: (event: RunEvent) => readonly RuntimeStatusUpdate[];
    /** Observes the inputs of each claimed Run, before it executes. */
    readonly onRunClaimed?: (
      runId: string,
      messages: NonEmptyReadonlyArray<Message>,
    ) => void;
    /** Runs after each work-state read, for example to take up steers. */
    readonly onWorkStateRefreshed?: () => void;
  }) {
    this.#logger = options.logger;
    this.#executionContextRef = options.executionContextRef;
    this.#onActiveRunContextChanged = options.onActiveRunContextChanged;
    this.#onActivityChanged = options.onActivityChanged;
    this.#activationFinishedAtMs = options.activationFinishedAtMs;
    this.#onRunTerminal = options.onRunTerminal;
    this.#provider = options.provider;
    this.#runtimeType =
      options.runtimeName === "codex" ||
      options.runtimeName === "claude" ||
      options.runtimeName === "pi"
        ? options.runtimeName
        : undefined;
    this.#runtimeSession = options.runtimeSession;
    this.#firstSessionRun = Boolean(
      options.newSession || runtimeSessionStartsFresh(options.runtimeSession),
    );
    this.#prepareNextRun = options.prepareNextRun;
    this.#beforeStartRun = options.beforeStartRun;
    this.#runtimeStatusPublisher = options.runtimeStatusPublisher;
    this.#state = options.state;
    this.#prepareInput = options.prepareInput;
    this.#onRunEvent = options.onRunEvent;
    this.#onRunClaimed = options.onRunClaimed;
    this.#onWorkStateRefreshed = options.onWorkStateRefreshed;
  }

  get activeOperations(): number {
    return this.#activeOperations;
  }

  /**
   * Compacts the idle native session. Run claiming waits until it settles,
   * and new work aborts it: interrupted native compaction leaves history
   * unchanged, so the user's input never waits for maintenance. It is not an
   * active operation, so the executor keeps reporting idle and Inbox reception
   * admits input immediately. Like a Run it holds Computer capacity.
   */
  async compactSession(
    options: CompactSessionOptions,
  ): Promise<CompactSessionResult> {
    if (!this.#provider.compactSession) return { status: "unsupported" };
    if (runtimeSessionAwaitsFirstRun(this.#runtimeSession))
      return { status: "nothing_to_compact" };
    if (
      this.#maintenance ||
      this.#drainRequested ||
      this.#activeOperations > 0 ||
      this.#state.hasPendingWork()
    )
      return { status: "busy" };
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    this.#maintenance = controller;
    let releaseCapacity: (() => void) | undefined;
    try {
      // A work-state refresh may still be running; with maintenance set it
      // returns before claiming anything.
      await this.#executionPromise?.catch(() => undefined);
      if (controller.signal.aborted) return { status: "input_arrived" };
      releaseCapacity = await this.#provider.acquireRunCapacity?.(signal);
      const result = await this.#provider.compactSession(this.#runtimeSession, {
        ...(options.instructions ? { instructions: options.instructions } : {}),
        signal,
      });
      if (result.status !== "compacted") return result;
      await this.#commitDurably(() =>
        this.#state.setRuntimeSession(this.#runtimeSession),
      );
      return result;
    } catch (error) {
      if (controller.signal.aborted) return { status: "input_arrived" };
      throw error;
    } finally {
      releaseCapacity?.();
      this.#maintenance = null;
      if (this.#workStateRefreshRequested || this.#state.hasQueuedRuns())
        this.#ensureRunning();
    }
  }

  async respondToHumanInteraction(
    response: NonNullable<Message["runtimeResponses"]>[number],
  ): Promise<void> {
    const intent = this.#activeRunIntent;
    const active =
      this.#activeExecution ??
      (intent?.runId === response.execution_run_ref
        ? await intent.providerReady
        : null);
    if (!active || active.runId !== response.execution_run_ref) return;
    if (!active.run.respond)
      throw new Error(
        "Active Runtime cannot receive its native interaction response",
      );
    await active.run.respond(
      response.operation_id,
      response.request_id,
      response.payload,
    );
  }

  activeExecutionSnapshot(): ActiveExecutionSnapshot | null {
    const execution = this.#activeExecution;
    if (!execution) return null;
    return {
      inputs: cloneInputs(execution.inputs),
      sourceInboxIds: Object.freeze([...execution.sourceInboxIds]),
    };
  }

  activeSourceInboxIds(): readonly string[] | null {
    const sourceInboxIds =
      this.#activeExecution?.sourceInboxIds ??
      this.#activeRunIntent?.sourceInboxIds;
    return sourceInboxIds ? Object.freeze([...sourceInboxIds]) : null;
  }

  activeRunId(): string | null {
    return this.#activeExecution?.runId ?? this.#activeRunIntent?.runId ?? null;
  }

  start(options: { readonly workStateAlreadyFresh?: boolean } = {}): void {
    if (
      this.#drainRequested &&
      (this.#executionPromise || this.#steerOperations.size > 0)
    ) {
      throw new Error(
        "Local Run execution cannot start while drain is pending",
      );
    }
    this.#drainRequested = false;
    this.#cancelLoopRetry();
    this.#capacityWait = new AbortController();
    this.#stopRequested = false;
    this.#stopError = undefined;
    if (this.#terminalRecoveryStop.signal.aborted)
      this.#terminalRecoveryStop = new AbortController();
    // Activation has just refreshed durable work state. Preserve a refresh
    // already requested by a notification racing with that read, but do not
    // immediately repeat the same TeamHub request on the normal cold path.
    if (!options.workStateAlreadyFresh) this.#workStateRefreshRequested = true;
    this.#ensureRunning();
    this.#notifyActivityChanged();
  }

  /**
   * Wakes the loop for new durable work. A caller whose committed command
   * already recorded the queued Run in Runtime State passes
   * `workStateAlreadyFresh`, so the loop claims without another read.
   */
  notifyWorkAvailable(
    options: { readonly workStateAlreadyFresh?: boolean } = {},
  ): void {
    if (!options.workStateAlreadyFresh) this.#workStateRefreshRequested = true;
    this.#maintenance?.abort();
    this.#cancelLoopRetry();
    this.#ensureRunning();
    this.#notifyActivityChanged();
  }

  async requestCancellation(
    runId: string,
  ): Promise<
    "cancel_requested" | "canceled" | "already_terminal" | "not_found"
  > {
    const status = await this.#state.cancelLocalRun(runId);
    const active = this.#activeRunIntent;
    if (
      status === "cancel_requested" ||
      (status === "already_terminal" && active?.runId === runId)
    ) {
      this.#pendingCancellationRunIds.add(runId);
      if (active?.runId === runId && !active.controller.signal.aborted) {
        active.controller.abort(new LocalRunCancellationRequestedError());
      }
    }
    if (status === "canceled" && !this.#state.hasQueuedRuns())
      this.#capacityWait.abort();
    this.#notifyActivityChanged();
    return status;
  }

  async steer(
    groupId: string,
    messages: NonEmptyReadonlyArray<Message>,
    stopSignal: AbortSignal,
    expectedSourceInboxId?: string,
  ): Promise<void> {
    const apply = () =>
      this.#applySteer(groupId, messages, stopSignal, expectedSourceInboxId);
    const operation =
      expectedSourceInboxId === undefined
        ? apply()
        : this.#trustedSteerTail.catch(() => undefined).then(apply);
    if (expectedSourceInboxId !== undefined) {
      this.#trustedSteerTail = operation;
    }
    this.#steerOperations.add(operation);
    this.#activeOperations += 1;
    this.#notifyActivityChanged();
    try {
      await operation;
    } finally {
      this.#activeOperations -= 1;
      this.#steerOperations.delete(operation);
      this.#notifyActivityChanged();
    }
  }

  /** resumable: an active Run goes back to the queue and resumes in the
   * next process instead of ending canceled. */
  requestDrain(options: {
    readonly cancelActive: boolean;
    readonly resumable?: boolean;
  }): void {
    this.#drainRequested = true;
    this.#cancelLoopRetry();
    this.#capacityWait.abort();
    this.#stopRequested ||= options.cancelActive;
    this.#notifyActivityChanged();
    if (options.cancelActive) {
      const stop = (this.#stopError ??= new LocalRunStoppedError(
        options.resumable === true,
      ));
      this.#terminalRecoveryStop.abort(stop);
      const active = this.#activeRunIntent;
      if (active && !active.controller.signal.aborted) {
        active.controller.abort(stop);
      }
    }
  }

  async drain(options: { readonly cancelActive: boolean }): Promise<void> {
    this.requestDrain(options);
    for (;;) {
      const pending = [
        ...(this.#executionPromise ? [this.#executionPromise] : []),
        ...this.#steerOperations,
      ];
      if (pending.length === 0) {
        this.#notifyActivityChanged();
        if (this.#executionFailure) throw this.#executionFailure.error;
        return;
      }
      await Promise.allSettled(pending);
    }
  }

  /** Settle one still-queued input after a confirmed Runtime replacement failed. */
  async failNextRunPreparation(
    error: unknown,
    stopSignal?: AbortSignal,
  ): Promise<void> {
    await this.drain({ cancelActive: false });
    stopSignal?.throwIfAborted();
    this.#retiredPreparationFailure = { error };
    this.#drainRequested = false;
    this.#capacityWait = new AbortController();
    const stop = () => this.requestDrain({ cancelActive: true });
    stopSignal?.addEventListener("abort", stop, { once: true });
    const task = (async () => {
      let retryAttempt = 0;
      while (!this.#drainRequested) {
        this.#workStateRefreshRequested = true;
        try {
          await this.#runLoop();
          return;
        } catch (failure) {
          if (
            !(failure instanceof LocalRunLoopRetryableError) ||
            this.#drainRequested
          )
            throw failure;
          await delay(
            Math.min(
              LOCAL_RUN_LOOP_RETRY_MAX_MS,
              LOCAL_RUN_LOOP_RETRY_BASE_MS * 2 ** retryAttempt++,
            ),
            undefined,
            { signal: stopSignal },
          );
        }
      }
    })();
    this.#executionPromise = task;
    try {
      await task;
    } finally {
      stopSignal?.removeEventListener("abort", stop);
      if (this.#executionPromise === task) this.#executionPromise = null;
      this.#drainRequested = true;
      this.#retiredPreparationFailure = undefined;
    }
  }

  #ensureRunning(): void {
    if (this.#executionPromise || this.#drainRequested || this.#maintenance)
      return;
    if (this.#capacityWait.signal.aborted)
      this.#capacityWait = new AbortController();
    let failed = false;
    let retryableFailure = false;
    const task = this.#runLoop()
      .then(() => {
        this.#executionFailure = null;
        this.#loopRetryAttempt = 0;
      })
      .catch((error: unknown) => {
        failed = true;
        retryableFailure = error instanceof LocalRunLoopRetryableError;
        if (retryableFailure) this.#workStateRefreshRequested = true;
        throw error;
      })
      .finally(() => {
        if (this.#executionPromise === task) this.#executionPromise = null;
        if (!this.#drainRequested) {
          if (retryableFailure) {
            this.#scheduleLoopRetry();
          } else if (
            this.#workStateRefreshRequested ||
            (!failed && this.#state.hasQueuedRuns())
          ) {
            setImmediate(() => this.#ensureRunning());
          }
        }
      });
    this.#executionPromise = task;
    void task.catch((error: unknown) => {
      this.#logger.log("error", "local_run.loop_failed", { error });
    });
  }

  async #runLoop(): Promise<void> {
    while (!this.#drainRequested) {
      if (this.#workStateRefreshRequested) {
        this.#workStateRefreshRequested = false;
        if (this.#state.refreshWorkState) {
          try {
            await this.#state.refreshWorkState();
          } catch (error) {
            if (!isRetryableLoopFailure(error)) throw error;
            throw new LocalRunLoopRetryableError(error);
          }
          this.#onWorkStateRefreshed?.();
        }
        if (this.#drainRequested) return;
      }
      if (!this.#state.hasQueuedRuns()) {
        // A notification arriving during refresh must not be consumed by an older snapshot.
        if (this.#workStateRefreshRequested) continue;
        return;
      }
      // Session compaction owns the native session; it restarts the loop.
      if (this.#maintenance) return;
      let releaseCapacity: (() => void) | undefined;
      try {
        if (
          !this.#retiredPreparationFailure &&
          this.#provider.acquireRunCapacity
        ) {
          releaseCapacity = await this.#provider.acquireRunCapacity(
            this.#capacityWait.signal,
          );
        }
      } catch (error) {
        if (
          this.#drainRequested ||
          this.#capacityWait.signal.aborted ||
          !this.#state.hasQueuedRuns()
        )
          return;
        if (!isRetryableLoopFailure(error)) throw error;
        throw new LocalRunLoopRetryableError(error);
      }
      try {
        if (this.#drainRequested) return;
        let preparationFailure = this.#retiredPreparationFailure;
        try {
          if (
            !preparationFailure &&
            this.#prepareNextRun &&
            !(await this.#prepareNextRun(this.#capacityWait.signal))
          ) {
            this.requestDrain({ cancelActive: false });
            return;
          }
        } catch (error) {
          if (this.#drainRequested || this.#capacityWait.signal.aborted) return;
          // Report failed configuration preparation on the durable Run, so it is
          // visible and retryable instead of leaving an unexplained queued input.
          preparationFailure = { error };
        }
        if (this.#drainRequested) return;
        let intent: ActiveRunIntent | null = null;
        let claimed: Awaited<
          ReturnType<ContextRuntimeStatePort["claimLocalRun"]>
        >;
        const claimStartedAt = performance.now();
        try {
          claimed = await this.#commit(async () => {
            const next = await this.#state.claimLocalRun();
            if (next) {
              intent = this.#createRunIntent(
                next.runId,
                provenanceOf(next.messages).sourceInboxIds,
              );
              this.#activeRunIntent = intent;
            }
            return next;
          });
        } catch (error) {
          if (!isRetryableLoopFailure(error)) throw error;
          throw new LocalRunLoopRetryableError(error);
        }
        const claimMs = Math.round(performance.now() - claimStartedAt);
        if (!claimed) return;
        if (!intent)
          throw new Error("Claimed Local Run has no execution intent");
        if (this.#retiredPreparationFailure) this.#drainRequested = true;
        const executionIntent = intent as ActiveRunIntent;
        try {
          this.#onRunClaimed?.(claimed.runId, claimed.messages);
        } catch (error) {
          this.#logger.log("warn", "local_run.claim_observer_failed", {
            runId: claimed.runId,
            error,
          });
        }
        this.#activeOperations += 1;
        this.#notifyActivityChanged();
        try {
          await this.#execute(
            claimed.runId,
            claimed.attemptCount,
            claimed.messages,
            executionIntent,
            claimed.cancellationRequested,
            preparationFailure,
            claimed.acceptedAtMonotonicMs,
            claimed.inputReceivedAtMs,
            claimMs,
            claimed.continuesContext,
            claimed.profileUpdate,
          );
        } catch (error) {
          this.#executionFailure = { error };
          executionIntent.rejectFinished(error);
          throw error;
        } finally {
          this.#activeOperations -= 1;
          this.#notifyActivityChanged();
        }
      } finally {
        releaseCapacity?.();
      }
    }
  }

  async #execute(
    runId: string,
    attemptCount: number,
    messages: NonEmptyReadonlyArray<Message>,
    intent: ActiveRunIntent,
    claimedCancellationRequested?: boolean,
    preparationFailure?: { readonly error: unknown },
    acceptedAtMonotonicMs?: number,
    inputReceivedAtMs?: number,
    claimMs?: number,
    continuesContext?: boolean,
    profileUpdate?: ProfileUpdate,
  ): Promise<void> {
    const { controller } = intent;
    if (claimedCancellationRequested) {
      controller.abort(new LocalRunCancellationRequestedError());
    }
    const startedAt = Date.now();
    const startedAtMonotonic = performance.now();
    const provenance = provenanceOf(messages);
    const kind = runKind(this.#executionContextRef, messages);
    // An earlier attempt may have started and done work before it stopped.
    const resumesAttempt =
      attemptCount > 1 && !this.#unstartedRequeues.delete(runId);
    const executionEpoch = this.#state.executionEpoch?.();
    // In-memory adapters may omit this claim field.
    let cancellationRequested = claimedCancellationRequested;
    let cancellationLookupMs: number | undefined;
    if (cancellationRequested === undefined) {
      const lookupStartedAt = performance.now();
      cancellationRequested = (await this.#state.getLocalRun(runId))
        ?.cancellationRequested;
      cancellationLookupMs = Math.round(performance.now() - lookupStartedAt);
    }
    const runContext: ProviderRunContext = Object.freeze({
      executionRunRef: runId,
      executionAttemptCount: attemptCount,
      ...(executionEpoch ? { executionEpoch } : {}),
      cancellationRequested,
      messageIds: invocationMessageIds(messages),
      ...documentReferenceContext(messages),
      sourceInboxIds: Object.freeze([...provenance.sourceInboxIds]),
    });
    this.#reportActiveRunContext(toolRunContext(runId, provenance));
    const execution: LocalRunExecution = {
      runId,
      attemptCount,
      messages,
      intent,
      controller,
      startedAt,
      startedAtMonotonic,
      provenance,
      kind,
      resumesAttempt,
      runContext,
      initializesRuntimeSession: runtimeSessionAwaitsFirstRun(
        this.#runtimeSession,
      ),
      preparationFailure,
      acceptedAtMonotonicMs,
      inputReceivedAtMs,
      claimMs,
      cancellationLookupMs,
      continuesContext,
      profileUpdate,
      run: null,
      runtimeStatus: null,
      runtimeStatusEvents: null,
      removeAbortListener: undefined,
      upstreamCanceled: false,
      providerSucceeded: false,
    };
    try {
      await this.#runExecution(execution);
    } catch (error) {
      await this.#failExecution(execution, error);
    } finally {
      intent.resolveProviderReady(null);
      execution.removeAbortListener?.();
      this.#pendingCancellationRunIds.delete(runId);
      if (this.#activeExecution?.runId === runId) {
        this.#activeExecution = null;
      }
      if (this.#activeRunIntent?.runId === runId) {
        this.#activeRunIntent = null;
      }
      this.#reportActiveRunContext(null);
    }
  }

  async #settleRuntimeStatusEvents(
    execution: LocalRunExecution,
  ): Promise<void> {
    if (!execution.runtimeStatusEvents) return;
    try {
      await execution.runtimeStatusEvents;
    } catch (error) {
      // Runtime status is advisory. It must never turn a durable terminal
      // transition into an execution failure.
      this.#logger.log("warn", "runtime_status.drain_failed", {
        runId: execution.runId,
        error,
      });
    }
  }

  async #reconcileRevocation(
    execution: LocalRunExecution,
    error: unknown,
  ): Promise<boolean> {
    if (!execution.upstreamCanceled) {
      const terminal = await this.#state.reconcileRevokedLocalRun?.(
        execution.runId,
        error,
      );
      if (terminal) {
        execution.upstreamCanceled = true;
        this.requestDrain({ cancelActive: true });
      }
    }
    return execution.upstreamCanceled;
  }

  #finishRevokedExecution(execution: LocalRunExecution): void {
    this.#reportTerminal(execution.runId, { type: "canceled" });
    execution.intent.resolveFinished();
    this.#logger.log("info", "local_run.upstream_canceled", {
      runId: execution.runId,
    });
  }

  /** Prepares, starts, observes and durably finishes one claimed Run. */
  async #runExecution(execution: LocalRunExecution): Promise<void> {
    const { runId, attemptCount, controller } = execution;
    controller.signal.throwIfAborted();
    if (execution.preparationFailure) throw execution.preparationFailure.error;
    const input = this.#prepareRunInput(execution);
    try {
      await this.#beforeStartRun?.(runId);
    } catch (error) {
      throw new ProviderRunStartError(
        "definitely_not_started",
        "Agent resource preparation failed",
        { cause: error },
      );
    }
    controller.signal.throwIfAborted();
    const providerStartAt = performance.now();
    const run = await this.#startProviderRun(execution, input);
    execution.run = run;
    const providerReadyAt = performance.now();
    this.#logProviderReady(execution, run, providerStartAt, providerReadyAt);
    const active = await this.#activateExecution(execution, run, input);

    execution.runtimeStatus = await this.#openRuntimeStatus(
      runId,
      execution.provenance,
      execution.runContext.executionEpoch,
    );
    controller.signal.throwIfAborted();

    const replyDelivery = new ReplyDelivery();
    execution.runtimeStatusEvents = this.#consumeRuntimeStatusEvents(
      runId,
      run.events,
      execution.runtimeStatus,
      (error) => this.#reconcileRevocation(execution, error),
      new RunTimeline(this.#logger, runId, attemptCount),
      replyDelivery,
    );
    const result = await run.wait();
    const providerCompletedAt = performance.now();
    this.#logger.log("info", "local_run.provider_completed", {
      runId,
      executionAttemptCount: attemptCount,
      observedAtUnixMs: Date.now(),
      providerDurationMs: providerCompletedAt - providerReadyAt,
    });
    active.acceptingSteers = false;
    await this.#settleProviderSteers(active);
    controller.signal.throwIfAborted();
    execution.providerSucceeded = true;
    await this.#finishSucceededExecution(
      execution,
      result.finalResponse,
      replyDelivery,
      providerCompletedAt,
    );
  }

  /**
   * Canonical rebuild + injected contributions + the single formatter run
   * inside the failure boundary so a throwing contribution terminates or
   * requeues the claimed Run instead of leaving it suspended.
   */
  #prepareRunInput(execution: LocalRunExecution): AgentInput {
    const { runId, messages, provenance, resumesAttempt } = execution;
    const prepareMessagesStartedAt = performance.now();
    const preparedMessages = this.#prepareMessages(messages);
    const prepareMessagesMs = Math.round(
      performance.now() - prepareMessagesStartedAt,
    );
    const input: AgentInput = {
      type: "text",
      text: withProfileUpdate(
        [
          this.#firstSessionRun
            ? execution.continuesContext || resumesAttempt
              ? renderRuntimeContinuationReminder(provenance.sourceInboxIds)
              : ""
            : resumesAttempt
              ? renderInterruptedRunReminder()
              : "",
          formatMessagesForRuntime(preparedMessages, this.#executionContextRef),
        ]
          .filter(Boolean)
          .join("\n\n"),
        execution.profileUpdate,
      ),
    };
    const preparationActivationFinishedAtMs = this.#activationFinishedAtMs?.();
    this.#logger.log("info", "local_run.preparation_timing", {
      runId,
      ...(preparationActivationFinishedAtMs !== undefined
        ? {
            sinceActivationCompletedMs: Math.round(
              Date.now() - preparationActivationFinishedAtMs,
            ),
          }
        : {}),
      ...(execution.claimMs !== undefined
        ? { claimMs: execution.claimMs }
        : {}),
      ...(execution.cancellationLookupMs !== undefined
        ? { cancellationLookupMs: execution.cancellationLookupMs }
        : {}),
      prepareMessagesMs,
    });
    this.#logger.log("info", "local_run.started", {
      runId,
      startedAtUnixMs: execution.startedAt,
      executionAttemptCount: execution.attemptCount,
      runKind: execution.kind,
      currentInputUtf8Bytes: Buffer.byteLength(input.text, "utf8"),
      initialMessageCount: messages.length,
      initialMessageIds: messages.map(({ messageId }) => messageId),
    });
    return input;
  }

  /**
   * This is admission for a *new* Run, not permission to keep an old
   * provider alive. Each retry revalidates current placement and grants.
   * Do not burn the two generic start attempts while diagnostics recover.
   */
  async #startProviderRun(
    execution: LocalRunExecution,
    input: AgentInput,
  ): Promise<AgentRun> {
    const { controller } = execution;
    const admissionWaitStartedAt = Date.now();
    for (;;) {
      try {
        const run = await this.#provider.startRun(this.#runtimeSession, input, {
          signal: controller.signal,
          runContext: execution.runContext,
          acceptedAtMonotonicMs: execution.acceptedAtMonotonicMs,
          runKind: execution.kind,
        });
        this.#firstSessionRun = false;
        return run;
      } catch (error) {
        const remaining =
          MAX_RUNTIME_ADMISSION_WAIT_MS - (Date.now() - admissionWaitStartedAt);
        if (
          !(error instanceof ProviderRunAdmissionUnavailableError) ||
          controller.signal.aborted ||
          remaining <= 0
        )
          throw error;
        this.#logger.log("warn", "local_run.admission_wait", {
          runId: execution.runId,
        });
        await delay(
          Math.min(RUNTIME_ADMISSION_RETRY_MS, remaining),
          undefined,
          {
            signal: controller.signal,
          },
        );
      }
    }
  }

  #logProviderReady(
    execution: LocalRunExecution,
    run: AgentRun,
    providerStartAt: number,
    providerReadyAt: number,
  ): void {
    const { runId } = execution;
    // Recovered Runs have no acceptance baseline, like TTFT.
    const endToEndBaselineMs =
      execution.acceptedAtMonotonicMs === undefined
        ? undefined
        : execution.inputReceivedAtMs;
    const activationFinishedAtMs = this.#activationFinishedAtMs?.();
    const activation =
      endToEndBaselineMs !== undefined &&
      activationFinishedAtMs !== undefined &&
      activationFinishedAtMs >= endToEndBaselineMs
        ? "cold"
        : "warm";
    const processLabel =
      run.processReused === undefined
        ? "unknown"
        : run.processReused
          ? "reused"
          : "spawned";
    // The Computer's report of when provider_ready really happened replaces the
    // later receipt time unless it falls outside [baseline, receipt].
    const observeEndToEnd = (
      receivedAtUnixMs: number,
      reportedAtUnixMs?: number,
    ): number | undefined => {
      if (endToEndBaselineMs === undefined) return undefined;
      let atUnixMs = receivedAtUnixMs;
      if (reportedAtUnixMs !== undefined) {
        if (
          reportedAtUnixMs >= endToEndBaselineMs &&
          reportedAtUnixMs <= receivedAtUnixMs
        ) {
          atUnixMs = reportedAtUnixMs;
        } else {
          this.#logger.log(
            "warn",
            "local_run.end_to_end_reported_time_out_of_range",
            {
              runId,
              stage: "provider_ready",
              baselineUnixMs: endToEndBaselineMs,
              reportedAtUnixMs,
              receivedAtUnixMs,
            },
          );
        }
      }
      return Math.max(0, atUnixMs - endToEndBaselineMs);
    };
    const providerReadyAtUnixMs = Date.now();
    const endToEndMs = observeEndToEnd(
      providerReadyAtUnixMs,
      run.dispatchedAtUnixMs,
    );
    this.#logger.log("info", "local_run.provider_ready", {
      runId,
      executionAttemptCount: execution.attemptCount,
      observedAtUnixMs: providerReadyAtUnixMs,
      receivedAtUnixMs: providerReadyAtUnixMs,
      ...(run.dispatchedAtUnixMs === undefined
        ? {}
        : { dispatchedAtUnixMs: run.dispatchedAtUnixMs }),
      ...(endToEndMs === undefined
        ? {}
        : { end_to_end_ms: endToEndMs, activation, process: processLabel }),
      preparationDurationMs: providerStartAt - execution.startedAtMonotonic,
      providerStartDurationMs: providerReadyAt - providerStartAt,
    });
  }

  /**
   * Publishes the started Run as the active execution, after the durable
   * cancellation check and the first-Run session checkpoint.
   */
  async #activateExecution(
    execution: LocalRunExecution,
    run: AgentRun,
    input: AgentInput,
  ): Promise<ActiveExecution> {
    const { runId, controller } = execution;
    if ((await this.#state.getLocalRun(runId))?.cancellationRequested) {
      run.cancel();
      controller.abort(new LocalRunCancellationRequestedError());
    }
    if (execution.initializesRuntimeSession) {
      try {
        requireRuntimeSessionThreadId(this.#runtimeSession);
        await this.#commitDurably(() =>
          this.#state.setRuntimeSession(this.#runtimeSession),
        );
      } catch (error) {
        // The native turn may already have side effects and nothing can
        // roll it back, so the Run fails rather than being prepared again.
        run.cancel();
        throw error;
      }
    }
    const active: ActiveExecution = {
      executionAttemptCount: execution.attemptCount,
      executionEpoch: execution.runContext.executionEpoch,
      acceptingSteers: true,
      controller,
      inputs: [input],
      run,
      runId,
      sourceInboxIds: new Set(execution.provenance.sourceInboxIds),
      steerOperations: new Set(),
    };
    this.#activeExecution = active;
    execution.intent.resolveProviderReady(active);
    const cancel = () => {
      try {
        execution.run?.cancel();
      } catch (error) {
        this.#logger.log("warn", "local_run.cancel_failed", {
          runId,
          error,
        });
      }
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    execution.removeAbortListener = () =>
      controller.signal.removeEventListener("abort", cancel);
    if (controller.signal.aborted) {
      cancel();
      controller.signal.throwIfAborted();
    }
    return active;
  }

  async #finishSucceededExecution(
    execution: LocalRunExecution,
    finalResponse: string,
    replyDelivery: ReplyDelivery,
    providerCompletedAt: number,
  ): Promise<void> {
    const { runId, attemptCount } = execution;
    // Finishing closes TeamHub's status window, so the queued tail of the
    // Run's status events is offered first. The drained stream also
    // completes the Run's message delivery record.
    const statusDrainStartedAt = performance.now();
    await this.#settleRuntimeStatusEvents(execution);
    const runtimeStatusDrainMs = performance.now() - statusDrainStartedAt;
    const terminal = this.#completedTerminal(
      runId,
      finalResponse,
      replyDelivery,
    );
    this.#logger.log("info", "local_run.finish_started", {
      runId,
      resultCode: terminal.type,
      observedAtUnixMs: Date.now(),
    });
    const settled = await this.#commitDurably(() =>
      this.#state.finishLocalRun(
        runId,
        terminal,
        this.#runtimeSession,
        this.#terminalRecoveryStop.signal,
      ),
    );
    if (settled === "upstream_canceled") {
      execution.upstreamCanceled = true;
      this.#finishRevokedExecution(execution);
      return;
    }
    const terminalPersistedAt = performance.now();
    this.#logger.log("info", "local_run.terminal_persisted", {
      runId,
      executionAttemptCount: attemptCount,
      observedAtUnixMs: Date.now(),
      resultCode: terminal.type,
      providerCompletionToTerminalMs: terminalPersistedAt - providerCompletedAt,
    });
    this.#reportTerminal(runId, terminal);
    execution.intent.resolveFinished();
    const finishedAtUnixMs = Date.now();
    this.#logger.log("info", "local_run.completed", {
      runId,
      durationMs: performance.now() - execution.startedAtMonotonic,
      executionAttemptCount: attemptCount,
      runtimeStatusDrainMs,
      finishedAtUnixMs,
    });
  }

  /** Requeues, revokes or durably fails a Run whose execution threw. */
  async #failExecution(
    execution: LocalRunExecution,
    error: unknown,
  ): Promise<void> {
    const { runId, attemptCount, controller, intent } = execution;
    if (this.#activeExecution?.runId === runId) {
      this.#activeExecution.acceptingSteers = false;
      await this.#settleProviderSteers(this.#activeExecution);
    } else {
      intent.resolveProviderReady(null);
    }
    // A durable cancellation cannot confirm native resource cleanup.
    const providerCleanupFailed = error instanceof ProviderRunCleanupError;
    if (
      !providerCleanupFailed &&
      (await this.#reconcileRevocation(execution, error))
    ) {
      await this.#settleRuntimeStatusEvents(execution);
      this.#finishRevokedExecution(execution);
      return;
    }
    if (execution.providerSucceeded) {
      throw new Error(`Local Run "${runId}" terminal persistence failed`, {
        cause: error,
      });
    }
    if (
      error instanceof ProviderRunStartError &&
      !(error instanceof ProviderRunAdmissionUnavailableError) &&
      error.effect === "definitely_not_started" &&
      attemptCount < MAX_LOCAL_RUN_START_ATTEMPTS &&
      !controller.signal.aborted
    ) {
      await this.#settleRuntimeStatusEvents(execution);
      await this.#commitDurably(() => this.#state.requeueLocalRun(runId));
      this.#unstartedRequeues.add(runId);
      intent.resolveFinished();
      this.#logger.log("warn", "local_run.start_retry_queued", {
        runId,
        attemptCount,
        maxAttempts: MAX_LOCAL_RUN_START_ATTEMPTS,
        error,
      });
      return;
    }
    // A Run the process stops for a restart goes back to the queue; the
    // next process resumes it in the same native session. When the
    // requeue fails the Run stays running, and the next epoch ends it as
    // process_interrupted.
    if (
      !providerCleanupFailed &&
      controller.signal.reason instanceof LocalRunStoppedError &&
      controller.signal.reason.resumable
    ) {
      await this.#settleRuntimeStatusEvents(execution);
      try {
        await this.#state.requeueLocalRun(runId);
        this.#logger.log("info", "local_run.requeued_for_restart", {
          runId,
          attemptCount,
        });
      } catch (requeueError) {
        this.#logger.log("warn", "local_run.restart_requeue_failed", {
          runId,
          error: requeueError,
        });
      }
      intent.resolveFinished();
      return;
    }
    // Opening the Run status lets TeamHub persist and show the failure
    // even when the Run failed before its stream was opened.
    if (execution.runtimeStatus === null) {
      await this.#openRuntimeStatus(
        runId,
        execution.provenance,
        execution.runContext.executionEpoch,
      );
    }
    const terminal = failedRunTerminal(
      error,
      controller.signal,
      this.#runtimeType,
    );
    try {
      await this.#settleRuntimeStatusEvents(execution);
      this.#logger.log("info", "local_run.finish_started", {
        runId,
        resultCode: terminal.type,
        observedAtUnixMs: Date.now(),
      });
      const settled = await this.#commitDurably(() =>
        this.#state.finishLocalRun(
          runId,
          terminal,
          runtimeSessionAwaitsFirstRun(this.#runtimeSession)
            ? undefined
            : this.#runtimeSession,
          this.#terminalRecoveryStop.signal,
        ),
      );
      if (settled === "upstream_canceled") {
        execution.upstreamCanceled = true;
        this.#finishRevokedExecution(execution);
        return;
      }
      this.#logger.log("info", "local_run.terminal_persisted", {
        runId,
        executionAttemptCount: attemptCount,
        observedAtUnixMs: Date.now(),
        resultCode: terminal.type,
      });
      this.#reportTerminal(runId, terminal);
      intent.resolveFinished();
    } catch (terminalError) {
      if (
        !providerCleanupFailed &&
        (await this.#reconcileRevocation(execution, terminalError))
      ) {
        this.#finishRevokedExecution(execution);
        return;
      }
      throw new AggregateError(
        [error, terminalError],
        `Local Run "${runId}" execution and terminal persistence failed`,
        { cause: terminalError },
      );
    }
    const finishedAtUnixMs = Date.now();
    this.#logger.log(
      terminal.type === "canceled" ? "info" : "error",
      terminal.type === "canceled" ? "local_run.canceled" : "local_run.failed",
      {
        runId,
        durationMs: finishedAtUnixMs - execution.startedAt,
        finishedAtUnixMs,
        error,
        ...(error instanceof RuntimeExecutionError
          ? {
              errorType: error.name,
              ...error.diagnostics,
              failureCode: error.failure.code,
              runtimeType: error.failure.runtime_type,
              runtimeVersion: error.failure.runtime_version,
            }
          : {}),
      },
    );
  }

  async #openRuntimeStatus(
    runId: string,
    provenance: Omit<ToolRunContext, "runId">,
    epoch: ProviderRunContext["executionEpoch"],
  ): Promise<RuntimeStatusSession | null> {
    if (!this.#runtimeStatusPublisher || !this.#executionContextRef || !epoch) {
      return null;
    }
    try {
      return await this.#runtimeStatusPublisher.open({
        executionId: runId,
        ref: this.#executionContextRef,
        epoch,
        sourceInboxIds: provenance.sourceInboxIds,
      });
    } catch (error) {
      this.#logger.log("warn", "runtime_status.open_failed", {
        runId,
        error,
      });
      return null;
    }
  }

  // A Runtime status update is advisory: it drives the Room activity indicator
  // and the Run's status events. Publishing inside the Run event loop would let
  // a slow TeamHub write backpressure the Run event stream, the provider event
  // mapper and finally the provider transport, whose overflow aborts the Turn.
  // The event loop therefore only enqueues, and a separate drain publishes
  // batches serially, so status latency stops at this boundary. The method
  // settles after the drain, so a resolved status drain still means TeamHub
  // saw the whole Run. The injected Run-event projection is a mandatory port,
  // not advisory: the single provider stream is always consumed and projected
  // once per event even when the status session is absent or failed to open.
  // Only publication is conditional on a session.
  async #consumeRuntimeStatusEvents(
    runId: string,
    events: AsyncIterable<RunEvent>,
    session: RuntimeStatusSession | null,
    reconcileRevocation: (error: unknown) => Promise<boolean>,
    timeline: RunTimeline,
    replyDelivery: ReplyDelivery,
  ): Promise<void> {
    const statusSession = session;
    const pending: RuntimeStatusUpdate[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let revoked = false;
    let shed = 0;
    let firstOutputObserved = false;
    const notify = (): void => {
      const resume = wake;
      wake = null;
      resume?.();
    };
    const enqueue = (update: RuntimeStatusUpdate): void => {
      if (!statusSession) return;
      if (pending.length >= MAX_PENDING_RUNTIME_STATUS_UPDATES) {
        // Shedding beats blocking here, and the oldest pure state update is the
        // one a later status.changed already supersedes. Structural updates stay
        // queued so the activity history a Room renders remains readable.
        const superseded = pending.findIndex(
          (queued) => queued.type === "status.changed",
        );
        pending.splice(superseded === -1 ? 0 : superseded, 1);
        shed += 1;
      }
      pending.push(update);
      notify();
    };
    const drain = statusSession
      ? (async (): Promise<void> => {
          for (;;) {
            // Everything queued while the previous batch was in flight goes
            // out together, so a burst of updates costs one TeamHub write.
            const batch = pending.splice(0, MAX_RUNTIME_STATUS_BATCH);
            if (batch.length === 0) {
              if (closed) return;
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              continue;
            }
            if (revoked) continue;
            try {
              await statusSession.publish(batch);
            } catch (error) {
              if (await reconcileRevocation(error)) {
                revoked = true;
                continue;
              }
              this.#logger.log("warn", "runtime_status.event_offer_failed", {
                runId,
                eventTypes: batch.map((update) => update.type),
                error,
              });
            }
          }
        })()
      : null;
    try {
      for await (const event of events) {
        if (revoked) break;
        // First substantive output observed by the executor, not browser paint or TTFT.
        if (
          !firstOutputObserved &&
          ((event.type === "message.delta" && event.delta.length > 0) ||
            event.type === "tool.called")
        ) {
          firstOutputObserved = true;
          const receivedAtUnixMs = Date.now();
          this.#logger.log("info", "local_run.first_output", {
            runId,
            observedAtUnixMs: receivedAtUnixMs,
            ...(event.observedAtUnixMs === undefined
              ? {}
              : { providerObservedAtUnixMs: event.observedAtUnixMs }),
            eventType: event.type,
          });
        }
        timeline.observe(event);
        replyDelivery.observe(event);
        for (const update of this.#onRunEvent(event)) enqueue(update);
      }
    } catch (error) {
      this.#logger.log("warn", "runtime_status.event_stream_failed", {
        runId,
        error,
      });
    } finally {
      closed = true;
      notify();
      await drain;
      if (shed > 0) {
        this.#logger.log("warn", "runtime_status.updates_shed", {
          runId,
          shed,
        });
      }
    }
  }

  /** Ordered input contributions right before Runtime formatting. */
  #prepareMessages(
    messages: NonEmptyReadonlyArray<Message>,
  ): NonEmptyReadonlyArray<Message> {
    return [
      this.#prepareInput(messages[0]),
      ...messages.slice(1).map((message) => this.#prepareInput(message)),
    ];
  }

  #reportActiveRunContext(context: ToolRunContext | null): void {
    try {
      this.#onActiveRunContextChanged?.(context);
    } catch (error) {
      this.#logger.log("warn", "local_run.log_context_failed", {
        ...(context ? { runId: context.runId } : {}),
        error,
      });
    }
  }

  /**
   * A Room Agent speaks only through TeamHub message writes. When it tried to
   * post and none landed, the Room has nothing to show, so a finished Provider
   * turn is not a succeeded Run. Task Runs report through their final
   * response and keep it.
   */
  #completedTerminal(
    runId: string,
    finalResponse: string,
    replyDelivery: ReplyDelivery,
  ): LocalRunTerminal {
    const undelivered =
      this.#executionContextRef?.kind === "meta" &&
      replyDelivery.replyUndelivered;
    if (replyDelivery.hasFailures) {
      this.#logger.log("warn", "local_run.teamhub_messages_failed", {
        runId,
        ...replyDelivery.counts(),
        replyUndelivered: undelivered,
        finalResponseLength: finalResponse.length,
      });
    }
    if (!undelivered) {
      return { type: "succeeded", finalResponse };
    }
    return {
      type: "failed",
      error: "Agent reply was not delivered to the Room",
      failure: runFailure("reply_undelivered", this.#runtimeType),
    };
  }

  #reportTerminal(runId: string, terminal: LocalTurnTerminal): void {
    try {
      this.#onRunTerminal?.(runId, terminal);
    } catch (error) {
      this.#logger.log("warn", "local_run.terminal_callback_failed", {
        runId,
        error,
      });
    }
  }

  async #applySteer(
    groupId: string,
    messages: NonEmptyReadonlyArray<Message>,
    stopSignal: AbortSignal,
    expectedSourceInboxId?: string,
  ): Promise<void> {
    const intent = this.#activeRunIntent;
    if (!intent) {
      await this.#enqueueSteer(groupId, messages);
      return;
    }

    const target = await intent.providerReady;
    if (
      !target ||
      !target.acceptingSteers ||
      stopSignal.aborted ||
      (expectedSourceInboxId !== undefined &&
        !target.sourceInboxIds.has(expectedSourceInboxId))
    ) {
      if (expectedSourceInboxId === undefined) await intent.finished;
      await this.#enqueueSteer(groupId, messages);
      return;
    }

    const operation = this.#applyProviderSteer(
      target,
      groupId,
      messages,
      stopSignal,
    );
    target.steerOperations.add(operation);
    try {
      await operation;
    } finally {
      target.steerOperations.delete(operation);
    }
  }

  async #applyProviderSteer(
    target: ActiveExecution,
    groupId: string,
    messages: NonEmptyReadonlyArray<Message>,
    stopSignal: AbortSignal,
  ): Promise<void> {
    await this.#commit(() => this.#state.assignSteerRun(groupId, target.runId));
    const provenance = provenanceOf(messages);
    const signal = AbortSignal.any([stopSignal, target.controller.signal]);
    let attempted = false;
    try {
      signal.throwIfAborted();
      // Input contribution/format failures land on the definitely-not-applied
      // boundary below: the committed steer assignment is folded back into a
      // queued Run instead of hanging.
      const input: AgentInput = {
        type: "text",
        text: formatMessagesForRuntime(
          this.#prepareMessages(messages),
          this.#executionContextRef,
        ),
      };
      attempted = true;
      await this.#provider.steer(target.run, {
        input,
        signal,
        runContext: Object.freeze({
          executionRunRef: target.runId,
          executionAttemptCount: target.executionAttemptCount,
          ...(target.executionEpoch
            ? { executionEpoch: target.executionEpoch }
            : {}),
          messageIds: invocationMessageIds(messages),
          ...documentReferenceContext(messages),
          sourceInboxIds: Object.freeze([...target.sourceInboxIds]),
        }),
      });
      for (const inboxId of provenance.sourceInboxIds) {
        target.sourceInboxIds.add(inboxId);
      }
      target.inputs.push(input);
      this.#reportActiveRunContext({
        runId: target.runId,
        sourceInboxIds: Object.freeze([...target.sourceInboxIds]),
      });
    } catch (error) {
      if (
        !attempted ||
        (error instanceof Error &&
          "effect" in error &&
          error.effect === "definitely_not_applied")
      ) {
        await this.#enqueueSteer(groupId, messages);
        this.#logger.log("warn", "local_run.trusted_steer_enqueued", {
          groupId,
          runId: target.runId,
          error,
        });
        return;
      }
      await this.#commit(() =>
        this.#state.completeSteer(groupId, target.runId, "uncertain"),
      );
      this.#logger.log("warn", "local_run.steer_uncertain", {
        groupId,
        runId: target.runId,
        error,
      });
      return;
    }
    await this.#commit(() =>
      this.#state.completeSteer(groupId, target.runId, "applied"),
    );
  }

  async #enqueueSteer(
    groupId: string,
    messages: NonEmptyReadonlyArray<Message>,
  ): Promise<void> {
    await this.#commit(() => this.#state.enqueueSteer(groupId, messages));
    this.notifyWorkAvailable();
  }

  async #settleProviderSteers(target: ActiveExecution): Promise<void> {
    if (target.steerOperations.size === 0) return;
    await Promise.allSettled([...target.steerOperations]);
  }

  #scheduleLoopRetry(): void {
    if (this.#loopRetryTimer || this.#drainRequested) return;
    const delayMs = Math.min(
      LOCAL_RUN_LOOP_RETRY_MAX_MS,
      LOCAL_RUN_LOOP_RETRY_BASE_MS * 2 ** this.#loopRetryAttempt,
    );
    this.#loopRetryAttempt += 1;
    this.#logger.log("warn", "local_run.loop_retry_scheduled", {
      delayMs,
      attempt: this.#loopRetryAttempt,
    });
    this.#loopRetryTimer = setTimeout(() => {
      this.#loopRetryTimer = null;
      this.#ensureRunning();
    }, delayMs);
    this.#loopRetryTimer.unref?.();
  }

  #cancelLoopRetry(): void {
    if (!this.#loopRetryTimer) return;
    clearTimeout(this.#loopRetryTimer);
    this.#loopRetryTimer = null;
  }

  async #commit<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    return await operation();
  }

  async #commitDurably<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    return await operation();
  }

  #notifyActivityChanged(): void {
    try {
      this.#onActivityChanged?.();
    } catch {
      // Activity observation must not change Local Run semantics.
    }
  }

  #createRunIntent(
    runId: string,
    sourceInboxIds: readonly string[],
  ): ActiveRunIntent {
    const controller = new AbortController();
    const providerReady = deferred<ActiveExecution | null>();
    const finished = deferred<void>();
    // A failed durable terminal transition is observed only by a concurrent steer.
    void finished.promise.catch(() => undefined);
    const intent: ActiveRunIntent = {
      controller,
      finished: finished.promise,
      providerReady: providerReady.promise,
      rejectFinished: finished.reject,
      resolveFinished: () => finished.resolve(undefined),
      resolveProviderReady: providerReady.resolve,
      runId,
      sourceInboxIds: new Set(sourceInboxIds),
    };
    if (this.#stopRequested || this.#pendingCancellationRunIds.has(runId)) {
      controller.abort(
        this.#stopRequested
          ? (this.#stopError ?? new LocalRunStoppedError(false))
          : new LocalRunCancellationRequestedError(),
      );
    }
    return intent;
  }
}

const failedRunTerminal = (
  error: unknown,
  signal: AbortSignal,
  runtimeType: RuntimeExecutionFailure["runtime_type"],
) =>
  error instanceof ProviderRunCleanupError
    ? ({
        type: "failed",
        error: "Provider cancellation cleanup is unconfirmed",
        failure: runFailure("cleanup_unconfirmed", runtimeType),
      } as const)
    : signal.reason instanceof LocalRunCancellationRequestedError ||
        signal.reason instanceof LocalRunStoppedError
      ? ({ type: "canceled" } as const)
      : ({
          type: "failed",
          failure: classifiedRunFailure(error, runtimeType),
          error:
            error instanceof ProviderRunInterruptedError
              ? "process_interrupted"
              : errorMessage(error),
        } as const);

/**
 * Every failed Run names its cause for the Room. A Runtime failure keeps the
 * code the Computer derived from structured signals; the Agent Service
 * classifies only what it observed itself, by error type.
 */
const classifiedRunFailure = (
  error: unknown,
  runtimeType: RuntimeExecutionFailure["runtime_type"],
): RuntimeExecutionFailure =>
  error instanceof RuntimeExecutionError
    ? error.failure
    : runFailure(
        error instanceof ProviderRunInterruptedError
          ? "interrupted"
          : error instanceof ProviderRunAdmissionUnavailableError
            ? "computer_unavailable"
            : error instanceof StreamingAgentRunLimitError
              ? "response_too_large"
              : "unclassified",
        runtimeType,
      );

const runFailure = (
  code: RuntimeExecutionFailure["code"],
  runtimeType: RuntimeExecutionFailure["runtime_type"],
): RuntimeExecutionFailure =>
  runtimeType ? { code, runtime_type: runtimeType } : { code };

const provenanceOf = (
  messages: NonEmptyReadonlyArray<Message>,
): RuntimeInputProvenance => ({
  sourceInboxIds: Object.freeze([
    ...new Set(messages.flatMap(({ sourceInboxIds }) => sourceInboxIds ?? [])),
  ]),
});

const documentReferenceContext = (
  messages: NonEmptyReadonlyArray<Message>,
): Pick<ProviderRunContext, "documentReferences"> => {
  const references = messages.flatMap(
    (message) => message.documentReferences ?? [],
  );
  return references.length ? { documentReferences: references } : {};
};

const invocationMessageIds = (
  messages: NonEmptyReadonlyArray<Message>,
): readonly string[] =>
  Object.freeze([
    ...new Set(
      messages.flatMap((message) =>
        message.invocationMessageIds?.length
          ? message.invocationMessageIds
          : [message.messageId],
      ),
    ),
  ]);

const toolRunContext = (
  runId: string,
  provenance: RuntimeInputProvenance,
): ToolRunContext => ({
  runId,
  sourceInboxIds: provenance.sourceInboxIds,
});

class LocalRunCancellationRequestedError extends Error {
  constructor() {
    super("Local Run cancellation requested");
    this.name = "LocalRunCancellationRequestedError";
  }
}

class LocalRunStoppedError extends Error {
  constructor(readonly resumable: boolean) {
    super("Local Run stopped");
    this.name = "LocalRunStoppedError";
  }
}

class LocalRunLoopRetryableError extends Error {
  constructor(cause: unknown) {
    super("Local Run loop encountered a retryable infrastructure error", {
      cause,
    });
    this.name = "LocalRunLoopRetryableError";
  }
}

const isRetryableLoopFailure = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "retryable" in error &&
  (error as { readonly retryable?: unknown }).retryable === true;

const cloneInputs = (
  values: readonly AgentInput[],
): NonEmptyReadonlyArray<AgentInput> => {
  const first = values[0];
  if (!first) throw new Error("Active execution must contain an input");
  return Object.freeze([
    Object.freeze({ ...first }),
    ...values.slice(1).map((value) => Object.freeze({ ...value })),
  ]);
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
