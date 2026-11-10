import { displayText } from "@linger/service-kit";
import {
  RunnerOperationInputError,
  RunnerGatewayError,
  type RunnerCapacityPermit,
} from "./runner-operation.js";
import { codexAgentInstructions } from "../codex-agent-instructions.js";
import { randomUUID } from "node:crypto";
import { setTimeout as waitForAdmission } from "node:timers/promises";
import { LocalComputerOfflineError } from "./local-computer-management.js";
import { mapLocalRuntimeHistory } from "./local-runtime-history.js";
import type {
  AgentInput,
  AgentProvider,
  AgentRun,
  ExecutionSpec,
  ProviderRunContext,
  ProviderSessionOptions,
  ProviderSteerAck,
  RunEvent,
  RunResult,
  RuntimeExecutionFailure,
  RuntimeSession,
} from "../executor/provider.js";
import {
  RuntimeExecutionError,
  StreamingAgentRun,
  ProviderRunCleanupError,
  ProviderRunInterruptedError,
  ProviderRunStartError,
  runtimeSessionStartsFresh,
  type ProviderCompactOptions,
  type ProviderCompactResult,
  type ProviderSteerOptions,
} from "../executor/provider.js";
import type {
  RuntimeHistoryOptions,
  RuntimeHistoryPage,
} from "../executor/history.js";
import type {
  ContextRunContext,
  ContextViewRef,
  JsonValue,
  LocalRunResources,
  OpaqueObject,
  ProviderPrepareRunContext,
  RuntimeConfig,
  RunEvent as WireRunEvent,
  SessionOptions,
} from "@linger/wire-contracts/runner-gateway/types";

import type {
  RunnerOperation,
  RunnerOperationInput,
  RunnerOperationDispatcher,
  RunnerContextDebugInspector,
  RunnerOperationScope,
  RunnerOperationTarget,
} from "./runner-gateway.js";
import { RunnerOperationError } from "./runner-gateway.js";
import type { RunnerSessionCompactOutcome } from "./runner-operation.js";
import type { AgentLogger } from "../observability/agent-log.js";

// Keep byte-identical with TeamHub permissionreview unavailableMessage and
// the daemon permission.UnavailableMessage (both Go); the tool-approval protocol quotes it.
export const PERMISSION_REVIEW_UNAVAILABLE =
  "The permission review service is temporarily unavailable, so this operation did not run. Retry later; do not reach the same effect another way.";
const BUSY_RETRY_BASE_DELAY_MS = 50;
const BUSY_RETRY_MAX_DELAY_MS = 1_000;

/** Correlates a sent provider.prepare with its log lines. */
interface SentProviderPrepare {
  readonly prepareId: string;
  readonly executionContextKey: string;
}

type RemoteRuntimeTarget = Pick<
  RunnerOperationTarget,
  "tenantId" | "ownerActorId" | "runnerId" | "agentId" | "workspaceGrantId"
> &
  RunnerOperationScope;

export interface RemoteRuntimeProviderOptions {
  readonly onHumanInteraction?: (
    input: {
      request: OpaqueObject;
      executionRunRef: string;
      operationId: string;
    },
    signal: AbortSignal,
  ) => Promise<OpaqueObject>;
  /**
   * Judges one Runtime tool call the Runtime would otherwise ask a human
   * about. The answer goes back to the Daemon as the request's runtime
   * response; the event stream never waits for it.
   */
  readonly onPermissionReview?: (
    input: {
      request: OpaqueObject;
      executionRunRef: string;
      operationId: string;
    },
    signal: AbortSignal,
  ) => Promise<OpaqueObject>;
  readonly dispatcher: RunnerOperationDispatcher;
  readonly logger?: AgentLogger;
  readonly target: RemoteRuntimeTarget;
  readonly runtime: RuntimeConfig;
  /** Codex wraps the compact developer instructions in its compact rules. */
  readonly compactInstructions?: true;
  readonly contextRunResources: RemoteContextRunResourceResolver;
  readonly debugInspector?: RunnerContextDebugInspector;
  readonly debugRunnerRevision?: number | (() => number);
  /**
   * Presence prepare waits for this so the prestarted process sees the same
   * environment as the first Run, such as the Agent CLI credential on the
   * Computer; otherwise the Daemon recycles it on an environment mismatch.
   */
  readonly beforePresencePrepare?: (signal: AbortSignal) => Promise<void>;
}

export interface RemoteContextRunResourceResolver {
  /** Keep offered file snapshots alive until input admission and its receipt settle. */
  withContextView?<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  currentContextViewRef(): ContextViewRef;
  resolve(
    context: ProviderRunContext,
    signal?: AbortSignal,
  ): Promise<LocalRunResources>;
}

export class RemoteRuntimeProvider implements AgentProvider {
  readonly #onHumanInteraction: RemoteRuntimeProviderOptions["onHumanInteraction"];
  readonly #onPermissionReview: RemoteRuntimeProviderOptions["onPermissionReview"];
  readonly #dispatcher: RunnerOperationDispatcher;
  readonly #logger?: AgentLogger;
  readonly #target: RemoteRuntimeTarget;
  readonly #runtime: RuntimeConfig;
  readonly #compactInstructions: boolean;
  readonly #contextRunResources: RemoteContextRunResourceResolver;
  readonly #debugInspector?: RunnerContextDebugInspector;
  readonly #debugRunnerRevision?: number | (() => number);
  readonly #beforePresencePrepare?: RemoteRuntimeProviderOptions["beforePresencePrepare"];
  readonly #activeOperations = new Map<RunnerOperation, ActiveOperation>();
  readonly #runs = new WeakSet<RemoteAgentRun>();
  readonly inspectHistory?: NonNullable<AgentProvider["inspectHistory"]>;
  readonly compactSession?: (
    session: RuntimeSession,
    options: ProviderCompactOptions,
  ) => Promise<ProviderCompactResult>;
  #sessionOptions?: SessionOptions;
  #capacityPermit?: RunnerCapacityPermit;
  readonly #closed = new AbortController();

  async acquireRunCapacity(signal: AbortSignal): Promise<() => void> {
    let permit: RunnerCapacityPermit | undefined;
    try {
      permit = await this.#dispatcher.acquireOperationCapacity?.(
        this.#target,
        AbortSignal.any([signal, this.#closed.signal]),
      );
    } catch (error) {
      // Capacity waits only for capacity. An offline or retiring Computer is
      // not a queue condition: proceed without a reservation so the Run is
      // claimed and startRun reports the same Local error as its own failure.
      if (
        !signal.aborted &&
        !this.#closed.signal.aborted &&
        (error instanceof LocalComputerOfflineError ||
          error instanceof RunnerGatewayError)
      ) {
        return () => undefined;
      }
      throw error;
    }
    this.#capacityPermit = permit;
    return () => {
      if (this.#capacityPermit === permit) this.#capacityPermit = undefined;
      permit?.release();
    };
  }

  #closePromise?: Promise<void>;

  constructor(options: RemoteRuntimeProviderOptions) {
    this.#onHumanInteraction = options.onHumanInteraction;
    this.#onPermissionReview = options.onPermissionReview;
    this.#dispatcher = options.dispatcher;
    this.#logger = options.logger;
    this.#target = options.target;
    this.#runtime = options.runtime;
    this.#compactInstructions = options.compactInstructions === true;
    this.#contextRunResources = options.contextRunResources;
    this.#debugInspector = options.debugInspector;
    this.#debugRunnerRevision = options.debugRunnerRevision;
    this.#beforePresencePrepare = options.beforePresencePrepare;
    if (options.debugInspector && options.debugRunnerRevision !== undefined) {
      this.inspectHistory = (session, historyOptions) =>
        this.#inspectHistory(session, historyOptions);
    }
    const runtimeType = options.runtime.type;
    if (
      (runtimeType === "codex" || runtimeType === "claude") &&
      options.dispatcher.compactParkedSession
    ) {
      this.compactSession = (session, compactOptions) =>
        this.#compactSession(runtimeType, session, compactOptions);
    }
  }

  /**
   * Compacts the native process the Daemon keeps parked for this Context. The
   * session identity and value are unchanged, so nothing is written back. A
   * Context without a parked process cannot be compacted now.
   */
  async #compactSession(
    runtimeType: "codex" | "claude",
    session: RuntimeSession,
    options: ProviderCompactOptions,
  ): Promise<ProviderCompactResult> {
    const startedAt = Date.now();
    let compacted: RunnerSessionCompactOutcome;
    if (this.#closePromise !== undefined) {
      compacted = { outcome: "no_process", reason: "provider_closed" };
    } else if (runtimeSessionStartsFresh(session)) {
      compacted = {
        outcome: "nothing_to_compact",
        reason: "session_not_started",
      };
    } else {
      compacted = await this.#dispatcher.compactParkedSession!(
        {
          runnerId: this.#target.runnerId,
          agentId: this.#target.agentId,
          executionContextKey: this.#target.executionContextKey,
        },
        {
          runtimeType,
          ...(options.instructions
            ? { instructions: options.instructions }
            : {}),
          // close() stops the wait; the Daemon interrupts the compaction
          // itself when the Context's work arrives.
          signal: AbortSignal.any([options.signal, this.#closed.signal]),
        },
      );
    }
    this.#logger?.log(
      compacted.outcome === "failed" ? "warn" : "info",
      "runner.session.compact",
      {
        executionContextKey: this.#target.executionContextKey,
        outcome: compacted.outcome,
        ...(compacted.reason === undefined ? {} : { reason: compacted.reason }),
        ...(compacted.pre_tokens === undefined
          ? {}
          : { preTokens: compacted.pre_tokens }),
        durationMs: Date.now() - startedAt,
      },
    );
    switch (compacted.outcome) {
      case "compacted":
        return {
          status: "compacted",
          ...(compacted.pre_tokens === undefined
            ? {}
            : { preTokens: compacted.pre_tokens }),
        };
      case "nothing_to_compact":
        return { status: "nothing_to_compact" };
      case "no_process":
        return { status: "unavailable" };
      case "canceled":
        throw new ProviderRunInterruptedError(
          "Session compaction was canceled",
        );
      case "failed":
        throw new Error(
          `Session compaction failed: ${compacted.reason ?? "unknown reason"}`,
        );
    }
  }

  async #inspectHistory(
    session: RuntimeSession,
    options: RuntimeHistoryOptions,
  ): Promise<RuntimeHistoryPage> {
    const inspector = this.#debugInspector;
    const resources = this.#contextRunResources;
    const runnerRevision =
      typeof this.#debugRunnerRevision === "function"
        ? this.#debugRunnerRevision()
        : this.#debugRunnerRevision;
    const executionContextKey = this.#target.executionContextKey;
    const runtimeInstanceId = this.#target.runtimeInstanceId;
    if (!inspector || runnerRevision === undefined) {
      throw new Error(
        "Local Runtime does not expose rollout history inspection",
      );
    }
    if (
      this.#runtime.type === "codex" &&
      requireOpaqueObject(session, "session").threadId === ""
    ) {
      // The first run has not created the Codex thread, so there is no
      // rollout to read yet.
      return {
        status: "unavailable",
        providerKind: "codex",
        reason: "Codex thread has not started yet",
        instructions: {
          status: "unavailable",
          source: "codex_rollout",
          reason: "Codex thread has not started yet",
          blocks: [],
        },
        records: [],
      };
    }
    options.signal?.throwIfAborted();
    const view = structuredClone(resources.currentContextViewRef());
    const result = await inspector.inspectLocalContext({
      context: {
        computerId: this.#target.runnerId,
        tenantId: this.#target.tenantId,
        agentId: this.#target.agentId,
        runnerRevision,
        workspaceGrantId: this.#target.workspaceGrantId,
        executionContextKey,
        runtimeInstanceId,
        viewDigest: view.view_digest,
      },
      request: {
        runtime: this.#runtime,
        session: requireOpaqueObject(session, "session"),
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      },
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    return mapLocalRuntimeHistory(result);
  }

  async createSession(
    options: ProviderSessionOptions,
  ): Promise<RuntimeSession> {
    const startedAt = Date.now();
    this.#logger?.log("info", "runtime.remote_session.create.started", {});
    const sessionOptions = toSessionOptions(
      this.#runtime.type === "codex"
        ? {
            ...options,
            ...codexAgentInstructions({
              ...options,
              compactInstructions: this.#compactInstructions,
            }),
          }
        : options,
    );
    // Every Runtime defers its native session to the first run.start. Codex's
    // "" threadId, and Claude's and Pi's UUID, are the first-run markers, so
    // activation needs no Daemon round trip. A retry after a failed first
    // run.start reuses the same pending or UUID identity. CLI installation is
    // awaited by run.start (#start), off the activation path.
    this.#sessionOptions = sessionOptions;
    const session: RuntimeSession =
      this.#runtime.type === "codex"
        ? { threadId: "" }
        : {
            provider: this.#runtime.type,
            sessionId: randomUUID(),
            lingerMaterialized: false,
          };
    const durationMs = Date.now() - startedAt;
    this.#logger?.log("info", "runtime.remote_session.create.completed", {
      durationMs,
      deferred: true,
    });
    return session;
  }

  async resumeSession(
    session: RuntimeSession,
    options: ProviderSessionOptions,
  ): Promise<RuntimeSession> {
    if (
      this.#runtime.type === "codex" &&
      requireOpaqueObject(session, "session").threadId === ""
    ) {
      return this.createSession(options);
    }
    const sessionOptions = toSessionOptions(
      this.#runtime.type === "codex"
        ? {
            ...options,
            ...codexAgentInstructions({
              ...options,
              compactInstructions: this.#compactInstructions,
            }),
          }
        : options,
    );
    if (this.#runtime.type === "claude" || this.#runtime.type === "pi") {
      const retained = requireOpaqueObject(session, "session");
      if (typeof retained.sessionId !== "string" || !retained.sessionId) {
        throw new TypeError("Retained native session identity is invalid");
      }
      // Restore errors belong to the durable Run, not activation. run.start
      // resumes the native session with current instructions in one process.
      this.#sessionOptions = sessionOptions;
      return retained;
    }
    if (this.#runtime.type === "codex") {
      const retained = requireOpaqueObject(session, "session");
      if (typeof retained.threadId !== "string") {
        throw new TypeError("Retained native session identity is invalid");
      }
      // Every Local Run already resumes inside its Operation. run.start's
      // native thread/resume strictly resumes the same thread with the current
      // instructions, so an instruction change is applied there. Defer that
      // work so restore errors belong to the durable Run, not Context activation.
      this.#sessionOptions = sessionOptions;
      return retained;
    }
    // Every Runtime returned above; activation sends no Daemon session.resume.
    const unhandled: never = this.#runtime.type;
    throw new TypeError(`Unsupported Runtime type: ${String(unhandled)}`);
  }

  async startRun(
    session: RuntimeSession,
    input: AgentInput,
    spec: ExecutionSpec = {},
  ): Promise<AgentRun> {
    const start = () => this.#startRun(session, input, spec);
    return await (this.#contextRunResources.withContextView
      ? this.#contextRunResources.withContextView(start, spec.signal)
      : start());
  }

  async #startRun(
    session: RuntimeSession,
    agentInput: AgentInput,
    spec: ExecutionSpec,
  ): Promise<AgentRun> {
    const { cliRunContext, ...input } = agentInput;
    const mutableSession = requireOpaqueObject(session, "session");
    let operation: RunnerOperation;
    let iterator: AsyncIterator<WireRunEvent>;
    let first: IteratorResult<WireRunEvent>;
    const signal = AbortSignal.any([
      this.#closed.signal,
      ...(spec.signal ? [spec.signal] : []),
    ]);
    let busyRetries = 0;
    for (;;) {
      signal.throwIfAborted();
      if (!spec.runContext)
        throw new TypeError("Local Run requires a Context run context");
      const runStartContext = await this.#contextRunStart(spec.runContext, {
        ...spec,
        signal,
      });
      operation = await this.#start(
        {
          kind: "run.start",
          runtime: this.#runtime,
          session_options: this.#requireSessionOptions(),
          session: mutableSession,
          input,
          ...runStartContext,
          ...(cliRunContext ? { cli_run_context: cliRunContext } : {}),
        },
        signal,
        spec.runContext.executionEpoch,
        spec.runKind,
      );
      if (spec.runContext.cancellationRequested) {
        await this.#cancel(operation, "Durable user cancellation");
        throw new ProviderRunInterruptedError(
          "Local Run cancellation requested",
        );
      }
      iterator = operation.events[Symbol.asyncIterator]();
      try {
        first = await this.#firstRunEvent(operation, iterator, signal);
        if (first.done || first.value.type !== "run.started") {
          await operation.result;
          throw new Error("Local Runtime did not start a steerable run");
        }
        break;
      } catch (error) {
        if (
          error instanceof RunnerOperationError &&
          error.code === "OPERATION_CAPACITY_BUSY" &&
          error.retryable
        ) {
          // The Daemon atomically rejected admission: no model or side effect ran.
          // Retry inside this attempt; capacity contention is not a startup failure.
          // Each attempt is a ledger round-trip, so back off with jitter.
          const delay =
            Math.min(
              BUSY_RETRY_MAX_DELAY_MS,
              BUSY_RETRY_BASE_DELAY_MS * 2 ** Math.min(busyRetries, 5),
            ) *
            (0.5 + Math.random() / 2);
          busyRetries += 1;
          await waitForAdmission(delay, undefined, { signal });
          continue;
        }
        throw localRunFailure(error, false, this.#runtime.type);
      }
    }
    if (mutableSession.threadId === "") {
      const checkpoint = first.value.session;
      if (
        !checkpoint ||
        typeof checkpoint.threadId !== "string" ||
        !checkpoint.threadId.trim()
      ) {
        await this.#cancel(
          operation,
          "missing initial RuntimeSession checkpoint",
        );
        throw new RuntimeExecutionError({
          code: "protocol_incompatible",
          runtime_type: this.#runtime.type,
        });
      }
      replaceOpaqueObject(mutableSession, checkpoint);
    }
    const reviewPermission = this.#onPermissionReview;
    const executionRunRef = spec.runContext?.executionRunRef;
    const run: RemoteAgentRun = new RemoteAgentRun({
      onPermissionReview:
        reviewPermission && executionRunRef
          ? (request) => {
              // A failed review answers unavailable: the Daemon then refuses
              // the call instead of waiting out its own deadline.
              void reviewPermission(
                {
                  request,
                  executionRunRef,
                  operationId: operation.operationId,
                },
                signal ?? this.#closed.signal,
              )
                .catch(
                  (): OpaqueObject => ({
                    decision: "unavailable",
                    message: PERMISSION_REVIEW_UNAVAILABLE,
                    policy_version: "",
                  }),
                )
                .then((result) =>
                  run.respond(
                    operation.operationId,
                    displayText(request.request_id),
                    result,
                  ),
                )
                .catch((error: unknown) => {
                  this.#logger?.log(
                    "warn",
                    "permission_review.response_failed",
                    {
                      execution_run_ref: executionRunRef,
                      operation_id: operation.operationId,
                      request_id: displayText(request.request_id),
                      error:
                        error instanceof Error ? error.message : String(error),
                      ...(error instanceof RunnerOperationInputError
                        ? { effect: error.effect, reason: error.reason }
                        : {}),
                    },
                  );
                });
            }
          : undefined,
      onHumanInteraction:
        this.#onHumanInteraction && spec.runContext?.executionRunRef
          ? async (request) => {
              await this.#onHumanInteraction!(
                {
                  request,
                  executionRunRef: spec.runContext!.executionRunRef,
                  operationId: operation.operationId,
                },
                signal ?? this.#closed.signal,
              );
            }
          : undefined,
      operation,
      iterator,
      turnId: first.value.turn_id,
      ...(first.value.process_reused === undefined
        ? {}
        : { processReused: first.value.process_reused }),
      ...(first.value.dispatched_at_unix_ms === undefined
        ? {}
        : { dispatchedAtUnixMs: first.value.dispatched_at_unix_ms }),
      session: mutableSession,
      cancel: (reason) => this.#cancel(operation, reason),
      inputContextViewRef: () =>
        this.#contextRunResources.currentContextViewRef(),
      withContextView: this.#contextRunResources.withContextView?.bind(
        this.#contextRunResources,
      ),
    });
    this.#runs.add(run);
    return run;
  }

  async steer(
    run: AgentRun,
    options: ProviderSteerOptions,
  ): Promise<ProviderSteerAck> {
    if (!(run instanceof RemoteAgentRun) || !this.#runs.has(run)) {
      throw new Error(
        "AgentRun was not created by this Remote Runtime provider",
      );
    }
    return run.input(options.input, options.signal);
  }

  close(): Promise<void> {
    this.#closed.abort();
    this.#closePromise ??= (async () => {
      const operations = [...this.#activeOperations.keys()];
      const outcomes = await Promise.allSettled(
        operations.map((operation) =>
          this.#cancel(operation, "provider closed"),
        ),
      );
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Remote Runtime provider failed to stop every active operation",
        );
      }
    })();
    return this.#closePromise;
  }

  async #firstRunEvent(
    operation: RunnerOperation,
    iterator: AsyncIterator<WireRunEvent>,
    signal: AbortSignal,
  ): Promise<IteratorResult<WireRunEvent>> {
    let onAbort: (() => void) | undefined;
    const canceled = new Promise<never>((_, reject) => {
      onAbort = () => {
        this.#cancel(operation, "Run canceled before Provider readiness").then(
          () =>
            reject(
              new ProviderRunInterruptedError(
                "Run canceled before Provider readiness",
              ),
            ),
          (error) => reject(new ProviderRunCleanupError({ cause: error })),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([iterator.next(), canceled]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async #start(
    request: RunnerOperationTarget["request"],
    signal: AbortSignal = this.#closed.signal,
    executionEpoch?: string,
    runKind?: RunnerOperationTarget["runKind"],
  ): Promise<RunnerOperation> {
    if (this.#closePromise) {
      throw new Error("Remote Codex provider is closed");
    }
    const permit =
      this.#capacityPermit ??
      (await this.#dispatcher.acquireOperationCapacity?.(this.#target, signal));
    try {
      const operation = await this.#dispatcher.startOperation({
        ...this.#target,
        executionEpoch,
        ...(runKind ? { runKind } : {}),
        signal,
        contextViewRef: this.#contextRunResources.currentContextViewRef(),
        request,
        ...(permit ? { capacityPermit: permit } : {}),
      });
      this.#track(operation);
      return operation;
    } finally {
      permit?.release();
      if (this.#capacityPermit === permit) this.#capacityPermit = undefined;
    }
  }

  /**
   * Advisory and never throws: after a real input was accepted, ask the Daemon
   * to resume this Codex thread in parallel with the Run claim and run.start.
   * Without an accepted input, or without a thread, nothing is sent.
   */
  prepareForAcceptedInput(
    session: RuntimeSession,
    options: { readonly acceptedInputSinceMs: number },
  ): void {
    this.#prepare(session, "accepted_input", options.acceptedInputSinceMs);
  }

  /**
   * Advisory and never throws: after a Room-presence activation without input,
   * start the Codex process or Claude CLI early so the first Run adopts it.
   * Every call sends a fresh prepare; the Daemon answers already_ready while a
   * compatible process stays parked, and keeps a prepared process parked like
   * a Run's, so nothing is ever renewed or canceled. When a pre-prepare hook is
   * configured, the prepare is sent only after it resolves, so the prestarted
   * process matches the first Run's environment; a Run that started meanwhile
   * owns the process, so nothing is sent then.
   */
  prepareForPresence(session: RuntimeSession): void {
    const beforePrepare = this.#beforePresencePrepare;
    if (!beforePrepare) {
      this.#prepare(session, "room_presence");
      return;
    }
    const skip = (reason: string) =>
      this.#logger?.log("info", "runner.provider.prepare_skipped", {
        source: "room_presence",
        reason,
      });
    beforePrepare(this.#closed.signal).then(
      () => {
        if (this.#activeOperations.size > 0) {
          skip("run_active");
          return;
        }
        this.#prepare(session, "room_presence");
      },
      // The error is not logged: it may carry credential data.
      () => {
        if (!this.#closed.signal.aborted) skip("cli_credential_unavailable");
      },
    );
  }

  #prepare(
    session: RuntimeSession,
    source: "accepted_input" | "room_presence",
    acceptedInputSinceMs?: number,
  ): void {
    let prepared: SentProviderPrepare | string;
    try {
      // Claude is prepared only for Room presence, where no input is waiting.
      prepared =
        source === "accepted_input" && this.#runtime.type !== "codex"
          ? "runtime_unsupported"
          : this.#sendProviderPrepare(session);
    } catch (error) {
      prepared = error instanceof Error ? error.message : String(error);
    }
    if (typeof prepared === "string") {
      this.#logger?.log("info", "runner.provider.prepare_skipped", {
        source,
        reason: prepared,
      });
      return;
    }
    this.#logger?.log("info", "runner.provider.prepare_sent", {
      prepareId: prepared.prepareId,
      executionContextKey: prepared.executionContextKey,
      source,
      ...(acceptedInputSinceMs !== undefined
        ? {
            acceptToPrepareMs: Math.max(
              0,
              Math.round(performance.now() - acceptedInputSinceMs),
            ),
          }
        : {}),
    });
  }

  /**
   * Sends one provider prepare for the session's Codex thread or Claude
   * conversation, or returns why it was not sent. For a Context that has no
   * Codex thread yet the Daemon starts one, and the Context's first Run adopts
   * it. A Claude conversation id always exists, so the Daemon creates the
   * conversation it names when it is not materialized.
   */
  #sendProviderPrepare(session: RuntimeSession): SentProviderPrepare | string {
    const target = this.#target;
    const executionContextKey = target.executionContextKey;
    const runtime = this.#runtime.type;
    if (runtime !== "codex" && runtime !== "claude")
      return "runtime_unsupported";
    if (this.#closePromise !== undefined) return "closed";
    if (!this.#sessionOptions) return "session_unavailable";
    const retained = requireOpaqueObject(session, "session");
    if (
      runtime === "claude" &&
      (typeof retained.sessionId !== "string" || retained.sessionId === "")
    ) {
      return "session_not_started";
    }
    const prepared = this.#dispatcher.prepareProvider?.(
      {
        tenantId: target.tenantId,
        ownerActorId: target.ownerActorId,
        runnerId: target.runnerId,
        agentId: target.agentId,
        workspaceGrantId: target.workspaceGrantId,
        executionContextKey,
        runtimeInstanceId: target.runtimeInstanceId,
      },
      {
        runtime: this.#runtime,
        sessionOptions: this.#sessionOptions,
        session: structuredClone(retained),
        contextViewRef: this.#contextRunResources.currentContextViewRef(),
        runContext: this.#runAuthorization(),
      },
    );
    if (!prepared) return "computer_unavailable";
    return { prepareId: prepared.prepareId, executionContextKey };
  }

  #track(operation: RunnerOperation): void {
    this.#activeOperations.set(operation, {});
    void operation.result.then(
      () => this.#activeOperations.delete(operation),
      () => this.#activeOperations.delete(operation),
    );
  }

  #cancel(operation: RunnerOperation, reason: string): Promise<void> {
    const active = this.#activeOperations.get(operation);
    if (!active) {
      return Promise.resolve();
    }
    active.cancelPromise ??= operation
      .cancel(reason)
      .catch((error: unknown) => {
        active.cancelPromise = undefined;
        throw error;
      });
    return active.cancelPromise;
  }

  #requireSessionOptions(): SessionOptions {
    if (!this.#sessionOptions) {
      throw new Error("Remote Runtime session options are unavailable");
    }
    return this.#sessionOptions;
  }

  async #contextRunStart(
    context: ProviderRunContext,
    spec: ExecutionSpec,
  ): Promise<{
    readonly run_context: ContextRunContext;
    readonly run_resources: LocalRunResources;
  }> {
    spec.signal?.throwIfAborted();
    const runResources = await this.#contextRunResources.resolve(
      context,
      spec.signal,
    );
    spec.signal?.throwIfAborted();
    return {
      run_context: {
        ...toContextRunContext(context),
        ...this.#runAuthorization(),
      },
      run_resources: runResources,
    };
  }

  /** The authorization flags a reviewed run carries; its provider prepare carries the same. */
  #runAuthorization(): ProviderPrepareRunContext {
    return {
      ...(this.#onHumanInteraction ? { human_interactions: true } : {}),
      ...(this.#onPermissionReview ? { permission_review: true } : {}),
    };
  }
}

export {
  RemoteRuntimeProvider as RemoteCodexProvider,
  type RemoteRuntimeProviderOptions as RemoteCodexProviderOptions,
};

interface ActiveOperation {
  cancelPromise?: Promise<void>;
}

class RemoteAgentRun implements AgentRun {
  readonly events: AsyncIterable<RunEvent>;
  readonly steerTarget: ProviderSteerAck;
  readonly processReused?: boolean;
  readonly dispatchedAtUnixMs?: number;
  readonly #operation: RunnerOperation;
  readonly #stream: StreamingAgentRun;
  readonly #streamAbortController: AbortController;
  readonly #session: OpaqueObject;
  readonly #cancelOperation: (reason: string) => Promise<void>;
  readonly #inputContextViewRef: () => ContextViewRef;
  readonly #withContextView?: RemoteContextRunResourceResolver["withContextView"];
  #result?: Promise<RunResult>;

  constructor(options: {
    operation: RunnerOperation;
    onHumanInteraction?: (request: OpaqueObject) => Promise<void>;
    onPermissionReview?: (request: OpaqueObject) => void;
    iterator: AsyncIterator<WireRunEvent>;
    turnId: string;
    processReused?: boolean;
    dispatchedAtUnixMs?: number;
    session: OpaqueObject;
    cancel(reason: string): Promise<void>;
    inputContextViewRef(): ContextViewRef;
    withContextView?: RemoteContextRunResourceResolver["withContextView"];
  }) {
    this.#operation = options.operation;
    if (options.processReused !== undefined)
      this.processReused = options.processReused;
    if (options.dispatchedAtUnixMs !== undefined)
      this.dispatchedAtUnixMs = options.dispatchedAtUnixMs;
    this.#session = options.session;
    this.#cancelOperation = options.cancel;
    this.#inputContextViewRef = options.inputContextViewRef;
    this.#withContextView = options.withContextView;
    this.steerTarget = { turnId: options.turnId };
    this.#streamAbortController = new AbortController();
    this.#streamAbortController.signal.addEventListener(
      "abort",
      () => {
        const reason =
          this.#streamAbortController.signal.reason === "cancelled"
            ? "cancelled"
            : "run stream aborted";
        void this.#cancelOperation(reason).catch(() => undefined);
      },
      { once: true },
    );
    this.#stream = new StreamingAgentRun(
      mapRunEvents(
        options.iterator,
        options.onHumanInteraction,
        options.onPermissionReview,
      ),
      this.#streamAbortController,
      this.steerTarget,
    );
    this.events = this.#stream.events;
  }

  wait(): Promise<RunResult> {
    this.#result ??= this.#wait();
    return this.#result;
  }

  cancel(): void {
    this.#streamAbortController.abort("cancelled");
  }

  async respond(
    operationId: string,
    requestId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (operationId !== this.#operation.operationId) return;
    try {
      await this.input({
        type: "text",
        text: "",
        runtime_response: {
          request_id: requestId,
          payload: payload as OpaqueObject,
        },
      });
    } catch (error) {
      if (
        error instanceof RunnerOperationInputError &&
        error.effect === "definitely_not_applied" &&
        error.reason === "no_active_turn"
      )
        return;
      throw error;
    }
  }

  async input(
    input: RunnerOperationInput["input"],
    signal?: AbortSignal,
  ): Promise<ProviderSteerAck> {
    const deliver = () => this.#input(input, signal);
    return this.#withContextView
      ? this.#withContextView(deliver, signal)
      : deliver();
  }

  async #input(
    input: RunnerOperationInput["input"],
    signal?: AbortSignal,
  ): Promise<ProviderSteerAck> {
    signal?.throwIfAborted();
    const contextViewRef = this.#inputContextViewRef();
    return this.#operation.input({
      expectedTurnId: this.steerTarget.turnId,
      input,
      contextViewRef,
    });
  }

  async #wait(): Promise<RunResult> {
    try {
      const [streamResult, runResult] = await Promise.all([
        this.#stream.wait(),
        this.#operation.result,
      ]);
      if (streamResult.finalResponse !== runResult.final_response) {
        throw new Error("Local Runtime stream and result response disagree");
      }
      replaceOpaqueObject(this.#session, runResult.session);
      return { finalResponse: runResult.final_response };
    } catch (error) {
      throw localRunFailure(error, true);
    }
  }
}

const localRunFailure = (
  error: unknown,
  executionStarted: boolean,
  runtimeType?: RuntimeExecutionFailure["runtime_type"],
): unknown => {
  if (!(error instanceof RunnerOperationError)) return error;
  // The Computer refused the start before any native execution: the Agent
  // cannot run there until its Runner or Runtime is turned back on.
  if (
    !executionStarted &&
    (error.code === "RUNNER_STOPPED" || error.code === "RUNTIME_NOT_ENABLED")
  ) {
    return new RuntimeExecutionError(
      {
        code: "computer_unavailable",
        ...(runtimeType ? { runtime_type: runtimeType } : {}),
      },
      { cause: error },
    );
  }
  if (error.code === "RUNTIME_CLEANUP_UNCONFIRMED") {
    return new ProviderRunCleanupError({ cause: error });
  }
  // These fail run.start at admission, before any native execution; a
  // retryable View fetch failure (a source changed after the snapshot) is
  // retried by a new attempt that snapshots the View again.
  if (
    !executionStarted &&
    (error.code === "EXECUTION_NOT_ADMITTED" ||
      error.code === "CONTEXT_VIEW_FAILED") &&
    error.retryable
  ) {
    return new ProviderRunStartError("definitely_not_started", error.message, {
      cause: error,
    });
  }
  if (error.code === "cancelled" || error.code === "DAEMON_RESTARTED") {
    return new ProviderRunInterruptedError(error.message, { cause: error });
  }
  return error;
};

const mapRunEvents = async function* (
  iterator: AsyncIterator<WireRunEvent>,
  onHumanInteraction?: (request: OpaqueObject) => Promise<void>,
  onPermissionReview?: (request: OpaqueObject) => void,
): AsyncIterable<RunEvent> {
  yield { type: "run.started" };
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return;
    }
    if (
      next.value.type === "human_interaction.requested" &&
      next.value.request.kind === "permission_review"
    ) {
      if (!onPermissionReview)
        throw new Error("Permission review is unavailable in this Context");
      // The judge takes seconds; later Runtime events keep flowing meanwhile.
      onPermissionReview(next.value.request);
      continue;
    }
    if (next.value.type === "human_interaction.requested") {
      if (!onHumanInteraction)
        throw new Error("Runtime interaction is unavailable in this Context");
      await onHumanInteraction(next.value.request);
      continue;
    }
    const event = toRunEvent(next.value);
    if (event) {
      yield event;
    }
  }
};

const toRunEvent = (event: WireRunEvent): RunEvent | null => {
  switch (event.type) {
    case "human_interaction.requested":
      throw new Error(
        "Runtime interaction must be handled before UI projection",
      );
    case "run.started":
      throw new Error("Local Runtime emitted run.started twice");
    case "status.changed":
      if (event.status === "working") {
        return { type: event.type, status: event.status };
      }
      return {
        type: event.type,
        status: event.status,
        ...(event.title === undefined ? {} : { title: event.title }),
      };
    case "plan.updated":
      return {
        type: event.type,
        ...(event.explanation === undefined
          ? {}
          : { explanation: event.explanation }),
        steps: event.steps.map((step) => ({
          content: step.content,
          status: step.status,
        })),
      };
    case "activity.started":
      return {
        type: event.type,
        activityId: event.activity_id,
        kind: event.kind,
        title: event.title,
        ...(event.content === undefined
          ? {}
          : { content: event.content.map((block) => ({ ...block })) }),
      };
    case "activity.updated":
      return {
        type: event.type,
        activityId: event.activity_id,
        detail: event.detail,
      };
    case "activity.finished":
      return {
        type: event.type,
        activityId: event.activity_id,
        outcome: event.outcome,
        ...(event.content === undefined
          ? {}
          : { content: event.content.map((block) => ({ ...block })) }),
      };
    case "message.delta":
      return {
        type: event.type,
        messageId: event.message_id,
        delta: event.delta,
        ...(event.observed_at_unix_ms === undefined
          ? {}
          : { observedAtUnixMs: event.observed_at_unix_ms }),
      };
    case "tool.called":
      return {
        type: event.type,
        callId: event.call_id,
        toolName: event.tool_name,
        input: event.input,
        ...(event.observed_at_unix_ms === undefined
          ? {}
          : { observedAtUnixMs: event.observed_at_unix_ms }),
      };
    case "tool.returned":
      return {
        type: event.type,
        callId: event.call_id,
        toolName: event.tool_name,
        output: event.output,
        isError: event.is_error,
        ...(event.observed_at_unix_ms === undefined
          ? {}
          : { observedAtUnixMs: event.observed_at_unix_ms }),
      };
    case "model.responded":
      return {
        type: event.type,
        respondedAtUnixMs: event.responded_at_unix_ms,
        startedAtUnixMs: event.started_at_unix_ms,
        ...(event.first_item_at_unix_ms === undefined
          ? {}
          : { firstItemAtUnixMs: event.first_item_at_unix_ms }),
        granularity: event.granularity,
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.message_id === undefined
          ? {}
          : { messageId: event.message_id }),
        usage: {
          input: event.usage.input,
          cacheRead: event.usage.cache_read,
          cacheWrite: event.usage.cache_write,
          output: event.usage.output,
          ...(event.usage.reasoning === undefined
            ? {}
            : { reasoning: event.usage.reasoning }),
        },
        ...(event.agent === undefined
          ? {}
          : {
              agent: {
                id: event.agent.id,
                ...(event.agent.parent_call_id === undefined
                  ? {}
                  : { parentCallId: event.agent.parent_call_id }),
              },
            }),
      };
    case "file.created":
    case "file.updated":
    case "file.deleted":
      return { type: event.type, path: event.path };
    case "run.completed":
      return event;
    case "run.failed":
      return event;
  }
};

const toSessionOptions = (options: ProviderSessionOptions): SessionOptions => {
  if (options.sandboxMode === "danger-full-access") {
    throw new Error("Local placement requires a bounded workspace grant");
  }
  return {
    thread_name: options.threadName,
    ...(options.baseInstructions === undefined
      ? {}
      : { base_instructions: options.baseInstructions }),
    ...(options.developerInstructions === undefined
      ? {}
      : { developer_instructions: options.developerInstructions }),
  };
};

const toContextRunContext = (
  context: ProviderRunContext,
): ContextRunContext => {
  return {
    execution_run_ref: context.executionRunRef,
    source_inbox_ids: [...context.sourceInboxIds],
  };
};

const requireOpaqueObject = (value: unknown, label: string): OpaqueObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Local Runtime ${label} must be an object`);
  }
  toJsonValue(value, label);
  return value as OpaqueObject;
};

const replaceOpaqueObject = (
  target: OpaqueObject,
  source: OpaqueObject,
): void => {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
};

const toJsonValue = (
  value: unknown,
  label: string,
  ancestors = new Set<object>(),
): JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError(`Local Runtime ${label} must not contain cycles`);
    }
    ancestors.add(value);
    const result = value.map((item) => toJsonValue(item, label, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) {
      throw new TypeError(`Local Runtime ${label} must not contain cycles`);
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Local Runtime ${label} must use plain objects`);
    }
    ancestors.add(value);
    const result = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        toJsonValue(item, label, ancestors),
      ]),
    );
    ancestors.delete(value);
    return result;
  }
  throw new TypeError(`Local Runtime ${label} must be JSON-compatible`);
};
