import type { RunKind } from "../../model-tasks.js";
import type { RuntimeHistoryOptions, RuntimeHistoryPage } from "./history.js";

export interface McpServerResource {
  name: string;
  url: string;
  toolNames: readonly string[];
  httpHeaders?: Readonly<Record<string, string>>;
}

export interface ProviderResourceBundle {
  mcpServers: readonly McpServerResource[];
  /** Exact package names of the Skills loaded for this activation. */
  skillNames?: readonly string[];
}

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export interface SessionFilesystemAccess {
  readonly readOnlyRoots: readonly string[];
  readonly readWriteRoots: readonly string[];
}

export interface SessionCommandEnvironment {
  readonly homeDirectory: string;
  readonly temporaryDirectory: string;
  readonly additionalPathEntries?: readonly string[];
  readonly mambaRootPrefix?: string;
  readonly condaPrefix?: string;
  readonly teamhubCli?: {
    readonly configPath: string;
    readonly profile?: string;
    readonly binDirectory?: string;
    readonly nodeDirectory?: string;
  };
}

export interface SessionSpec {
  workingDirectory: string;
  threadName: string;
  model?: string;
  reasoningEffort?: string;
  sandboxMode: SandboxMode;
  additionalWritableRoots?: readonly string[];
  filesystemAccess?: SessionFilesystemAccess;
  commandEnvironment?: SessionCommandEnvironment;
  networkAccess?: boolean;
  /** Exact destinations permitted for commands when general network access is denied. */
  networkAllowedDomains?: readonly string[];
  ephemeral?: boolean;
  baseInstructions?: string;
  developerInstructions?: string;
}

export type RuntimeSession = unknown;

/** A pending native identity must never be written to Runtime State. */
export const runtimeSessionAwaitsFirstRun = (
  session: RuntimeSession,
): boolean =>
  typeof session === "object" &&
  session !== null &&
  Object.hasOwn(session, "threadId") &&
  (session as { readonly threadId?: unknown }).threadId === "";

/**
 * The next Run on this session starts its native conversation. Claude/Pi can
 * checkpoint a reserved identity during warmup; its materialization flag
 * survives restart, so no separate handoff state is needed.
 */
export const runtimeSessionStartsFresh = (session: RuntimeSession): boolean =>
  runtimeSessionAwaitsFirstRun(session) ||
  (typeof session === "object" &&
    session !== null &&
    "lingerMaterialized" in session &&
    session.lingerMaterialized === false);

export const requireRuntimeSessionThreadId = (
  session: RuntimeSession,
): string => {
  if (
    typeof session !== "object" ||
    session === null ||
    !("threadId" in session) ||
    typeof (session as { readonly threadId?: unknown }).threadId !== "string" ||
    !(session as { readonly threadId: string }).threadId.trim()
  ) {
    throw new TypeError("RuntimeSession.threadId must be a non-empty string");
  }
  return (session as { readonly threadId: string }).threadId;
};

/** Per-run Agent CLI fields the Computer writes to `.teamhub/cli/run.json`. */
export interface CliRunContext {
  readonly run_id?: string;
  /** The Context the CLI acts for; the Computer writes it to config.json. */
  readonly scope: {
    readonly kind: "room" | "task" | "document";
    readonly id: string;
  };
}

export interface AgentInput {
  type: "text";
  text: string;
  /** Per-run CLI fields for the Computer's `run.json`; never sent inside the wire input. */
  cliRunContext?: CliRunContext;
}

export interface ProviderRunContext {
  readonly cancellationRequested?: boolean;
  /** The durable claim attempt; old attempts cannot acquire a new execution binding. */
  readonly executionAttemptCount?: number;
  /** The Agent Service epoch that claimed the Run. */
  readonly executionEpoch?: string;
  readonly executionRunRef: string;
  readonly messageIds?: readonly string[];
  readonly documentReferences?: readonly {
    readonly documentId: string;
    readonly documentVersionId?: string;
  }[];
  readonly sourceInboxIds: readonly string[];
}

export interface ExecutionSpec {
  /** Process-local monotonic acceptance time; never persisted or sent over the wire. */
  acceptedAtMonotonicMs?: number;
  /** What queued the Run, for model scheduling; never sent over the wire. */
  runKind?: RunKind;
  signal?: AbortSignal;
  resources?: ProviderResourceBundle;
  runContext?: ProviderRunContext;
}

export type RunPlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "canceled";

export interface RunPlanStep {
  content: string;
  status: RunPlanStepStatus;
}

/** Token counts of one model request, in the Run usage buckets. */
export interface ModelRequestUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning?: number;
}

/**
 * One completed model request. `startedAtUnixMs` is when the Runtime had the
 * request's inputs; `firstItemAtUnixMs` is its first observable output at
 * `granularity`, which is not a time to first token.
 */
export interface ModelRespondedEvent {
  type: "model.responded";
  respondedAtUnixMs: number;
  startedAtUnixMs: number;
  firstItemAtUnixMs?: number;
  granularity: "item" | "block" | "delta";
  model?: string;
  messageId?: string;
  usage: ModelRequestUsage;
  /** Present for a sub-agent's request. */
  agent?: { id: string; parentCallId?: string };
}

export type RunActivityStatus = "working" | "thinking";
export type RunActivityKind =
  | "command"
  | "tool"
  | "file_change"
  | "search"
  | "read"
  | "browse"
  | "message"
  | "message_read"
  | "image"
  | "delegation"
  | "response"
  | "interaction"
  | "recovery"
  | "review";
export type RunActivityOutcome =
  | "succeeded"
  | "failed"
  | "canceled"
  | "declined";

export interface RunActivityContentBlock {
  content: string;
  format: "text" | "code" | "json";
  label?: string;
}

export type RunEvent =
  | { type: "run.started" }
  | {
      type: "status.changed";
      status: RunActivityStatus;
      title?: string;
    }
  | {
      type: "plan.updated";
      explanation?: string;
      steps: readonly RunPlanStep[];
    }
  | {
      type: "activity.started";
      activityId: string;
      kind: RunActivityKind;
      title: string;
      content?: readonly RunActivityContentBlock[];
    }
  | {
      type: "activity.updated";
      activityId: string;
      detail: string;
    }
  | {
      type: "activity.finished";
      activityId: string;
      outcome: RunActivityOutcome;
      content?: readonly RunActivityContentBlock[];
    }
  | {
      type: "message.delta";
      messageId: string;
      delta: string;
      /** Unix ms the Computer observed the native output; absent when unreported. */
      observedAtUnixMs?: number;
    }
  | {
      type: "tool.called";
      callId: string;
      toolName: string;
      input: unknown;
      /** Unix ms the Computer observed the native output; absent when unreported. */
      observedAtUnixMs?: number;
    }
  | {
      type: "tool.returned";
      callId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
      /** Unix ms the Computer observed the native result; absent when unreported. */
      observedAtUnixMs?: number;
    }
  | ModelRespondedEvent
  | { type: "file.created"; path: string }
  | { type: "file.updated"; path: string }
  | { type: "file.deleted"; path: string }
  | { type: "run.completed" }
  | { type: "run.failed"; message: string };

export interface RunResult {
  finalResponse: string;
}

export class ProviderRunCleanupError extends Error {
  constructor(options?: ErrorOptions) {
    super("Provider cancellation cleanup is unconfirmed", options);
    this.name = "ProviderRunCleanupError";
  }
}

export class ProviderRunInterruptedError extends Error {
  constructor(
    message = "Provider run was interrupted",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderRunInterruptedError";
  }
}

export class ProviderRunStartError extends Error {
  constructor(
    readonly effect: "definitely_not_started",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderRunStartError";
  }
}

/** No provider input was sent; a transient local diagnostic can be rechecked. */
export class ProviderRunAdmissionUnavailableError extends ProviderRunStartError {
  override readonly name = "ProviderRunAdmissionUnavailableError";

  constructor(options?: ErrorOptions) {
    super(
      "definitely_not_started",
      "Local Runtime admission diagnostic is unavailable",
      options,
    );
  }
}

export class ProviderSessionInspectionError extends Error {
  override readonly name = "ProviderSessionInspectionError";

  constructor(
    readonly status: "unsupported" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface AgentRun {
  respond?(
    operationId: string,
    requestId: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
  /** Single-consumer stream with bounded buffering. */
  readonly events: AsyncIterable<RunEvent>;
  /** The turn an accepted steer joins, when the Runtime reports it. */
  readonly steerTarget?: ProviderSteerAck;
  /** Whether the Computer reused a warm native process; absent when unreported. */
  readonly processReused?: boolean;
  /** Unix ms the Computer handed the turn to the model; absent when unreported. */
  readonly dispatchedAtUnixMs?: number;
  wait(): Promise<RunResult>;
  cancel(): void;
}

export interface ProviderSessionOptions extends SessionSpec {
  resources: ProviderResourceBundle;
}

export interface AgentProvider {
  /** Reserve execution capacity before claiming a durable Run. Always release. */
  acquireRunCapacity?(signal: AbortSignal): Promise<() => void>;

  createSession(options: ProviderSessionOptions): Promise<RuntimeSession>;

  resumeSession(
    session: RuntimeSession,
    options: ProviderSessionOptions,
  ): Promise<RuntimeSession>;

  /**
   * Advisory: starts Runtime-side preparation for a resumed session after a
   * real input was accepted. Never throws, waits, or fails activation.
   */
  prepareForAcceptedInput?(
    session: RuntimeSession,
    options: { readonly acceptedInputSinceMs: number },
  ): void;
  /**
   * Advisory and never throws: after a Room-presence activation without input,
   * start the Provider process early so the first Run adopts it. Every call is
   * an independent hint; the Runtime keeps a prepared process like a parked one.
   */
  prepareForPresence?(session: RuntimeSession): void;

  /** Replaces the exact filesystem roots authorized for the next Run. */
  replaceSessionFilesystemAccess?(
    session: RuntimeSession,
    filesystemAccess: SessionFilesystemAccess,
  ): Promise<void>;

  /** Reads a sanitized page from the provider's persisted history source. */
  inspectHistory?(
    session: RuntimeSession,
    options: RuntimeHistoryOptions,
  ): Promise<RuntimeHistoryPage>;

  /**
   * Compacts an idle session with the Runtime's native compaction. The session
   * identity is unchanged; a provider whose session value changes updates it
   * in place, as after a Run, and the caller then checkpoints it. Aborting the
   * signal interrupts compaction and leaves history unchanged.
   */
  compactSession?(
    session: RuntimeSession,
    options: ProviderCompactOptions,
  ): Promise<ProviderCompactResult>;

  startRun(
    session: RuntimeSession,
    input: AgentInput,
    spec: ExecutionSpec,
  ): Promise<AgentRun>;

  clearRunResources?(session: RuntimeSession): Promise<void>;

  steer(
    run: AgentRun,
    options: ProviderSteerOptions,
  ): Promise<ProviderSteerAck>;

  close(): Promise<void>;
}

export interface ProviderCompactOptions {
  /** Extra keep-requirements; Runtimes without a custom prompt ignore them. */
  readonly instructions?: string;
  readonly signal: AbortSignal;
}

export type ProviderCompactResult =
  | {
      readonly status: "compacted";
      /** Context size before compaction, when the Runtime reports it. */
      readonly preTokens?: number;
    }
  | { readonly status: "nothing_to_compact" }
  /** The Runtime cannot compact this session right now, e.g. no parked process. */
  | { readonly status: "unavailable" };

export interface ProviderSteerOptions {
  input: AgentInput;
  runContext?: ProviderRunContext;
  signal?: AbortSignal;
}

export interface ProviderSteerAck {
  turnId: string;
}

/** Public diagnostic metadata only; native error text never belongs here. */
export interface RuntimeExecutionFailure {
  code:
    | "session_not_found"
    | "protocol_incompatible"
    | "authentication_required"
    | "network_error"
    | "rate_limited"
    | "model_unavailable"
    | "model_not_offered"
    | "context_too_long"
    | "model_service_error"
    | "timeout"
    | "execution_failed"
    | "execution_outcome_unknown"
    | "reply_undelivered"
    | "interrupted"
    | "computer_unavailable"
    | "cleanup_unconfirmed"
    | "response_too_large"
    | "unclassified";
  /** Absent when the failure was observed without a selected Runtime. */
  runtime_type?: "codex" | "claude" | "pi";
  runtime_version?: string;
}

/** Logging-only metadata; never include this object in public failure state. */
export interface RuntimeFailureDiagnostics {
  code?: string;
  statusCode?: number;
  exitCode?: number;
  signal?: string;
}

export class RuntimeExecutionError extends Error {
  readonly diagnostics?: RuntimeFailureDiagnostics;

  constructor(
    readonly failure: RuntimeExecutionFailure,
    options?: ErrorOptions & { diagnostics?: RuntimeFailureDiagnostics },
  ) {
    super(
      `${failure.runtime_type ?? "runtime"} execution failed (${failure.code})`,
      options,
    );
    this.name = "RuntimeExecutionError";
    this.diagnostics = options?.diagnostics;
  }
}

export const STREAMING_AGENT_RUN_EVENT_BUFFER_LIMIT = 64;
export const STREAMING_AGENT_RUN_EVENT_BUFFER_BYTES = 4 * 1024 * 1024;
export const STREAMING_AGENT_RUN_MAX_RESPONSE_BYTES = 1_000_000;
export const STREAMING_AGENT_RUN_MAX_RESPONSE_MESSAGES = 1_024;
export const STREAMING_AGENT_RUN_FAILURE_MESSAGE = "Agent run failed";

export class StreamingAgentRun implements AgentRun {
  readonly events: AsyncIterable<RunEvent>;
  readonly steerTarget: ProviderSteerAck | undefined;

  readonly #abortController: AbortController;
  readonly #eventStream: BoundedRunEventStream;
  readonly #source: AsyncIterable<RunEvent>;
  #result: Promise<RunResult> | undefined;

  constructor(
    source: AsyncIterable<RunEvent>,
    abortController: AbortController,
    steerTarget?: ProviderSteerAck,
  ) {
    this.#abortController = abortController;
    this.#source = source;
    this.steerTarget = steerTarget;
    this.#eventStream = new BoundedRunEventStream(() => {
      void this.#start().catch(() => undefined);
    }, abortController.signal);
    this.events = this.#eventStream;
  }

  wait(): Promise<RunResult> {
    return this.#start();
  }

  cancel(): void {
    this.#abortController.abort();
  }

  #start(): Promise<RunResult> {
    this.#result ??= this.#consume(this.#source);
    void this.#result.catch(() => undefined);
    return this.#result;
  }

  async #consume(source: AsyncIterable<RunEvent>): Promise<RunResult> {
    const messages = new Map<string, string>();
    let finalMessageId: string | null = null;
    let responseStorageBytes = 0;
    let failurePublished = false;
    try {
      for await (const event of source) {
        if (event.type === "run.failed") {
          failurePublished = await this.#eventStream.publish({
            type: "run.failed",
            message: STREAMING_AGENT_RUN_FAILURE_MESSAGE,
          });
          throw new ReportedAgentRunFailure(
            STREAMING_AGENT_RUN_FAILURE_MESSAGE,
          );
        }
        await this.#eventStream.publish(event);
        if (event.type === "message.delta") {
          const isNewMessage = !messages.has(event.messageId);
          if (
            isNewMessage &&
            messages.size >= STREAMING_AGENT_RUN_MAX_RESPONSE_MESSAGES
          ) {
            throw new StreamingAgentRunLimitError(
              "Agent run response message limit exceeded",
            );
          }
          responseStorageBytes += encodedByteLength(event.delta);
          if (isNewMessage) {
            responseStorageBytes += encodedByteLength(event.messageId);
          }
          if (responseStorageBytes > STREAMING_AGENT_RUN_MAX_RESPONSE_BYTES) {
            throw new StreamingAgentRunLimitError(
              "Agent run response byte limit exceeded",
            );
          }
          messages.set(
            event.messageId,
            `${messages.get(event.messageId) ?? ""}${event.delta}`,
          );
          finalMessageId = event.messageId;
        }
      }
      return {
        finalResponse: finalMessageId
          ? (messages.get(finalMessageId) ?? "")
          : "",
      };
    } catch (error) {
      const sourceFailure = error instanceof Error ? error : new Error();
      const failure =
        sourceFailure instanceof StreamingAgentRunLimitError ||
        sourceFailure instanceof ReportedAgentRunFailure ||
        sourceFailure instanceof RuntimeExecutionError
          ? sourceFailure
          : new Error(STREAMING_AGENT_RUN_FAILURE_MESSAGE, {
              cause: sourceFailure,
            });
      if (sourceFailure instanceof StreamingAgentRunLimitError) {
        this.#abortController.abort(sourceFailure);
      }
      if (!failurePublished) {
        this.#eventStream.publishTerminal({
          type: "run.failed",
          message: STREAMING_AGENT_RUN_FAILURE_MESSAGE,
        });
      }
      throw failure;
    } finally {
      this.#eventStream.close();
    }
  }
}

interface BufferedRunEvent {
  readonly event: RunEvent;
  readonly bytes: number;
}

class BoundedRunEventStream implements AsyncIterable<RunEvent> {
  readonly #queue: BufferedRunEvent[] = [];
  readonly #dataWaiters = new Set<() => void>();
  readonly #spaceWaiters = new Set<() => void>();
  #bufferedBytes = 0;
  #claimed = false;
  #consumerActive = false;
  #closed = false;

  readonly #onAbort = (): void => notify(this.#spaceWaiters);

  constructor(
    private readonly onClaim: () => void,
    private readonly signal: AbortSignal,
  ) {
    signal.addEventListener("abort", this.#onAbort, { once: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    if (this.#claimed) {
      return {
        next: () =>
          Promise.reject(
            new Error("Agent run events support exactly one consumer"),
          ),
      };
    }
    this.#claimed = true;
    this.#consumerActive = true;
    this.onClaim();
    const iterator = this.#iterate();
    return {
      next: () => iterator.next(),
      return: () => {
        this.#releaseConsumer();
        return iterator.return(undefined);
      },
    };
  }

  async publish(event: RunEvent): Promise<boolean> {
    if (!this.#consumerActive || this.#closed) {
      return false;
    }
    const bytes = encodedEventBytes(event);
    if (bytes > STREAMING_AGENT_RUN_EVENT_BUFFER_BYTES) {
      throw new StreamingAgentRunLimitError(
        "Agent run event exceeds the buffer byte limit",
      );
    }
    while (
      this.#consumerActive &&
      !this.#closed &&
      !this.signal.aborted &&
      (this.#queue.length >= STREAMING_AGENT_RUN_EVENT_BUFFER_LIMIT ||
        this.#bufferedBytes + bytes > STREAMING_AGENT_RUN_EVENT_BUFFER_BYTES)
    ) {
      await waitForNotification(this.#spaceWaiters);
    }
    if (!this.#consumerActive || this.#closed || this.signal.aborted) {
      return false;
    }
    this.#queue.push({ event, bytes });
    this.#bufferedBytes += bytes;
    notify(this.#dataWaiters);
    return true;
  }

  publishTerminal(event: RunEvent): void {
    if (!this.#consumerActive || this.#closed) {
      return;
    }
    const bytes = encodedEventBytes(event);
    if (bytes > STREAMING_AGENT_RUN_EVENT_BUFFER_BYTES) {
      return;
    }
    while (
      this.#queue.length >= STREAMING_AGENT_RUN_EVENT_BUFFER_LIMIT ||
      this.#bufferedBytes + bytes > STREAMING_AGENT_RUN_EVENT_BUFFER_BYTES
    ) {
      const discarded = this.#queue.shift();
      if (!discarded) break;
      this.#bufferedBytes -= discarded.bytes;
    }
    this.#queue.push({ event, bytes });
    this.#bufferedBytes += bytes;
    notify(this.#dataWaiters);
  }

  close(): void {
    this.#closed = true;
    this.signal.removeEventListener("abort", this.#onAbort);
    notify(this.#dataWaiters);
    notify(this.#spaceWaiters);
  }

  async *#iterate(): AsyncGenerator<RunEvent> {
    try {
      while (
        this.#consumerActive &&
        (this.#queue.length > 0 || !this.#closed)
      ) {
        const next = this.#queue.shift();
        if (!next) {
          await waitForNotification(this.#dataWaiters);
          continue;
        }
        this.#bufferedBytes -= next.bytes;
        notify(this.#spaceWaiters);
        yield next.event;
      }
    } finally {
      this.#releaseConsumer();
    }
  }

  #releaseConsumer(): void {
    if (!this.#consumerActive) return;
    this.#consumerActive = false;
    this.#queue.length = 0;
    this.#bufferedBytes = 0;
    notify(this.#dataWaiters);
    notify(this.#spaceWaiters);
  }
}

/** The Run's reply exceeded what a Room message may hold. */
export class StreamingAgentRunLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamingAgentRunLimitError";
  }
}

class ReportedAgentRunFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportedAgentRunFailure";
  }
}

const waitForNotification = (waiters: Set<() => void>): Promise<void> =>
  new Promise((resolve) => waiters.add(resolve));

const notify = (waiters: Set<() => void>): void => {
  for (const waiter of waiters) {
    waiter();
  }
  waiters.clear();
};

const encodedByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const encodedEventBytes = (event: RunEvent): number => {
  try {
    return encodedByteLength(JSON.stringify(event));
  } catch {
    throw new Error("Agent run event cannot be buffered safely");
  }
};
