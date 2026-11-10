import type { RunKind } from "../../model-tasks.js";
import { EventEmitter, once } from "node:events";
import { isDeepStrictEqual } from "node:util";

import { logAgentEvent } from "../observability/agent-log.js";
import {
  RuntimeExecutionError,
  runtimeSessionAwaitsFirstRun,
} from "../executor/provider.js";
import type { ProviderSteerAck } from "../executor/provider.js";
import type {
  ActiveOperation,
  AgentToDaemonEnvelope,
  ContextViewRef,
  DaemonToAgentEnvelope,
  OperationAck,
  OperationCancel,
  OperationInput,
  OperationInputClosed,
  OperationPrepare,
  OperationPrepared,
  NativeResumeMeasurement,
  OperationResult,
  OperationStart,
  OpaqueObject,
  ProviderPrepareRunContext,
  RuntimeConfig,
  RuntimeOperationRequest,
  RunEvent,
  SessionCompact,
  SessionCompacted,
  SessionOptions,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RUNNER_GATEWAY_PROTOCOL_VERSION,
  parseAgentToDaemonEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";

interface RunnerOperationTargetBase {
  /** The Agent Service epoch whose Run this Operation executes. */
  readonly executionEpoch?: string;
  /** What queued the Run; only logged. Absent, chat. */
  readonly runKind?: RunKind;
  /** Stops the Run waiting for its turn in the model queue. */
  readonly signal?: AbortSignal;
  readonly tenantId: string;
  readonly ownerActorId?: string;
  readonly runnerId: string;
  readonly agentId: string;
  readonly workspaceGrantId: string;
  readonly request: RuntimeOperationRequest;
  readonly capacityPermit?: RunnerCapacityPermit;
}

export interface RunnerOperationScope {
  readonly executionContextKey: string;
  readonly runtimeInstanceId: string;
  readonly contextViewRef: ContextViewRef;
}

export type RunnerOperationTarget = RunnerOperationTargetBase &
  RunnerOperationScope;

export interface RunnerOperationInput {
  readonly expectedTurnId: string;
  readonly input: OperationInput["input"];
  readonly contextViewRef?: ContextViewRef;
}

export interface RunnerOperation {
  readonly operationId: string;
  readonly events: AsyncIterable<RunEvent>;
  readonly result: Promise<OperationResult>;
  input(options: RunnerOperationInput): Promise<ProviderSteerAck>;
  cancel(reason: string): Promise<void>;
}

export type RunnerCapacityTarget = Pick<
  RunnerOperationTarget,
  "runnerId" | "tenantId" | "agentId" | "executionContextKey"
>;

export interface RunnerCapacityPermit {
  readonly id: string;
  release(): void;
}

/** Context identity for a Provider prepare. It never names an Operation. */
export interface RunnerProviderPrepareTarget {
  readonly tenantId: string;
  readonly ownerActorId?: string;
  readonly runnerId: string;
  readonly agentId: string;
  readonly workspaceGrantId: string;
  readonly executionContextKey: string;
  readonly runtimeInstanceId: string;
}

/** The exact run.start inputs the Daemon resolves for a prepared resume. */
export interface RunnerProviderPrepareOptions {
  readonly runtime: RuntimeConfig;
  readonly sessionOptions: SessionOptions;
  readonly session: OpaqueObject;
  readonly contextViewRef: ContextViewRef;
  /** The reviewed run's authorization flags, so the pre-start argv matches the run's. */
  readonly runContext?: ProviderPrepareRunContext;
}

/** The Context whose parked native process a session compaction compacts. */
export type RunnerSessionCompactTarget = Pick<
  RunnerProviderPrepareTarget,
  "runnerId" | "agentId" | "executionContextKey"
>;

export interface RunnerSessionCompactOptions {
  readonly runtimeType: SessionCompact["runtime_type"];
  readonly instructions?: string;
  /** Aborting only stops waiting; the Daemon interrupts on the Context's next work. */
  readonly signal: AbortSignal;
}

export type RunnerSessionCompactOutcome = Pick<
  SessionCompacted,
  "outcome" | "pre_tokens" | "reason"
>;

export interface RunnerOperationDispatcher {
  /**
   * Fire-and-forget Codex resume ahead of run.start. Returns undefined when the
   * Computer cannot take it; never acquires capacity or creates an Operation.
   */
  prepareProvider?(
    target: RunnerProviderPrepareTarget,
    options: RunnerProviderPrepareOptions,
  ): { readonly prepareId: string } | undefined;
  /**
   * Compacts the session of the native process the Computer keeps parked for
   * this Context. Answers no_process locally when the Computer cannot take it.
   */
  compactParkedSession?(
    target: RunnerSessionCompactTarget,
    options: RunnerSessionCompactOptions,
  ): Promise<RunnerSessionCompactOutcome>;
  acquireOperationCapacity?(
    target: RunnerCapacityTarget,
    signal: AbortSignal,
  ): Promise<RunnerCapacityPermit>;
  supportsDurableCodexSession?(runnerId: string): boolean;
  startOperation(target: RunnerOperationTarget): Promise<RunnerOperation>;
}

export class RunnerGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerGatewayError";
  }
}

export class RunnerGatewayProtocolError extends RunnerGatewayError {
  constructor(message: string) {
    super(message);
    this.name = "RunnerGatewayProtocolError";
  }
}

export class RunnerUpgradeRequiredError extends RunnerGatewayError {
  readonly code = "upgrade_required";

  constructor(
    message = "This Local Computer must be upgraded before it can connect to Agent Service",
  ) {
    super(message);
    this.name = "RunnerUpgradeRequiredError";
  }
}

export class RunnerOperationError extends RunnerGatewayError {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RunnerOperationError";
  }
}

export class RunnerOperationInputError extends RunnerGatewayError {
  constructor(
    message: string,
    readonly effect: "definitely_not_applied" | "uncertain",
    readonly reason: string,
  ) {
    super(message);
    this.name = "RunnerOperationInputError";
  }
}

type CommandSender = (command: AgentToDaemonEnvelope) => Promise<void>;
const MAX_OPERATION_PREPARE_MCP_RELAYS = 64;

export type OperationEnvelope = Extract<
  DaemonToAgentEnvelope,
  { readonly operation_id: string; readonly seq: number }
>;

interface PendingInput {
  readonly command: OperationInput;
  readonly outcome: Deferred<ProviderSteerAck>;
  settled: boolean;
}

/**
 * One Runner Operation as this Agent Service process sees it. It lives only
 * in memory: a Computer that reconnects resumes it by operation_id, and a new
 * Agent Service process interrupts its Run instead of adopting it. Each event
 * is acknowledged once it is applied.
 */
export class RunnerOperationState {
  start: OperationStart;
  readonly #events = new AsyncValueQueue<RunEvent>();
  readonly #outcome = deferred<OperationResult>();
  readonly #pendingInputs = new Map<string, PendingInput>();
  readonly #createId: () => string;
  readonly #send: CommandSender;
  readonly #cancelTimeoutMs: number;
  readonly #epoch: string | undefined;
  #lastSequence = 0;
  #outcomeEnvelope:
    | Extract<
        OperationEnvelope,
        {
          type:
            | "operation.completed"
            | "operation.failed"
            | "operation.cancelled";
        }
      >
    | undefined;
  readonly #acceptance = new EventEmitter();
  #accepted = false;
  #terminal = false;
  #cancelCommand?: OperationCancel;
  #prepareCommand?: OperationPrepare;
  #prepareResumeObserved = false;
  #currentContextViewRef: ContextViewRef;
  #receiveTail: Promise<void> = Promise.resolve();
  readonly #createdAt: number;
  #lastStartSentAt: number | undefined;
  #startSentCount = 0;
  #inputReceiptTimer: ReturnType<typeof setTimeout> | undefined;
  #inputReceipts: Deferred<void> | undefined;

  // Called after the operation.start frame is written to the Computer peer.
  // Replays on reconnect are later writes of the same frame.
  noteStartSent(): void {
    const now = performance.now();
    const replay = this.#startSentCount > 0;
    this.#startSentCount++;
    this.#lastStartSentAt = now;
    logAgentEvent("info", "runner.operation.sent", {
      operationId: this.start.operation_id,
      computerId: this.start.runner_id,
      agentId: this.start.agent_id,
      executionContextKey: this.start.execution_context_key,
      kind: this.start.request.kind,
      connectionEpoch: this.start.connection_epoch,
      sinceCreatedMs: now - this.#createdAt,
      replay,
    });
  }

  constructor(options: {
    readonly target: RunnerOperationTarget;
    readonly connectionEpoch: number;
    readonly runnerRevision: number;
    readonly createId: () => string;
    readonly send: CommandSender;
    readonly cancelTimeoutMs: number;
    readonly runtimeAssignment: {
      readonly registrationId: string;
      readonly assignmentRevision: number;
    };
  }) {
    this.#epoch = options.target.executionEpoch;
    this.#createId = options.createId;
    this.#send = options.send;
    this.#cancelTimeoutMs = options.cancelTimeoutMs;
    const start = parseAgentToDaemonEnvelope({
      type: "operation.start",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: this.#createId(),
      tenant_id: options.target.tenantId,
      registration_id: options.runtimeAssignment.registrationId,
      assignment_revision: options.runtimeAssignment.assignmentRevision,
      runner_id: options.target.runnerId,
      execution_context_key: options.target.executionContextKey,
      runtime_instance_id: options.target.runtimeInstanceId,
      context_view_ref: options.target.contextViewRef,
      agent_id: options.target.agentId,
      operation_id: this.#createId(),
      connection_epoch: options.connectionEpoch,
      runner_revision: options.runnerRevision,
      generation: 1,
      execution_lease_id: this.#createId(),
      workspace_grant_id: options.target.workspaceGrantId,
      runtime_type: options.target.request.runtime.type,
      host_access: "trusted",
      request: options.target.request,
    });
    if (start.type !== "operation.start") {
      throw new RunnerGatewayProtocolError("Invalid operation start command");
    }
    this.#createdAt = performance.now();
    logAgentEvent("info", "runner.operation.created", {
      operationId: start.operation_id,
      commandId: start.command_id,
      computerId: start.runner_id,
      agentId: start.agent_id,
      tenantId: start.tenant_id,
      executionContextKey: start.execution_context_key,
      kind: start.request.kind,
      executionRunRef: start.request.run_context.execution_run_ref,
      viewDigest: start.context_view_ref.view_digest,
      createdAtUnixMs: Date.now(),
    });
    // Callers update Session checkpoints in place. Retain the original wire
    // command independently so reconnect never changes an admitted request.
    this.start = structuredClone({ ...start, ...operationIdentity(start) });
    this.#currentContextViewRef = this.start.context_view_ref;
  }

  /** The Agent Service epoch whose Run this Operation executes. */
  get epoch(): string | undefined {
    return this.#epoch;
  }

  /** The terminal envelope type, once the Operation ended. */
  get outcomeType(): string | undefined {
    return this.#outcomeEnvelope?.type;
  }

  /** The usage the Daemon reported with the terminal, when it reported one. */
  get usage(): readonly Record<string, unknown>[] | undefined {
    const outcome = this.#outcomeEnvelope;
    if (!outcome) return undefined;
    const usage =
      outcome.type === "operation.completed"
        ? outcome.result.usage
        : outcome.usage;
    return usage === undefined ? undefined : usage;
  }

  get prepareDispatched(): boolean {
    return this.#prepareCommand !== undefined;
  }

  prepareCommand(): OperationPrepare | undefined {
    if (this.#prepareCommand) return this.#prepareCommand;
    if (this.#terminal || this.#accepted) return undefined;
    const request = this.start.request;
    if (
      request.run_resources.mcp_servers.length === 0 ||
      request.run_resources.mcp_servers.length >
        MAX_OPERATION_PREPARE_MCP_RELAYS
    ) {
      return undefined;
    }
    // The Daemon accepts prepare only for a Codex Run that resumes a retained
    // thread; a first Run's session is still pending and has no thread yet.
    const threadId = (request.session as { readonly threadId?: unknown })
      .threadId;
    if (
      request.runtime.type !== "codex" ||
      typeof threadId !== "string" ||
      threadId === "" ||
      runtimeSessionAwaitsFirstRun(request.session)
    ) {
      return undefined;
    }
    const command = parseAgentToDaemonEnvelope({
      ...operationIdentity(this.start),
      type: "prepare",
      target: "operation",
      command_id: this.#createId(),
      runtime: request.runtime,
      session_options: request.session_options,
      session: request.session,
      // The Daemon prepares the same MCP config the reviewed Run will use.
      ...(request.run_context.permission_review === true
        ? { permission_review: true as const }
        : {}),
      mcp_relays: request.run_resources.mcp_servers,
    });
    if (command.type !== "prepare" || command.target !== "operation") {
      throw new RunnerGatewayProtocolError(
        "Invalid Operation MCP prepare command",
      );
    }
    this.#prepareCommand = command;
    return command;
  }

  async receivePrepared(envelope: OperationPrepared): Promise<void> {
    assertOperationIdentity(this.start, envelope);
    if (
      !this.#prepareCommand ||
      envelope.prepare_command_id !== this.#prepareCommand.command_id ||
      envelope.command_id !== this.#prepareCommand.command_id
    ) {
      throw new RunnerGatewayProtocolError(
        "Runner emitted an unmatched Operation MCP prepare outcome",
      );
    }
    const measurement = envelope.prepare_native_resume;
    if (measurement) this.#observePrepareResume(measurement);
    logAgentEvent(
      envelope.outcome === "ready" ? "info" : "warn",
      "runner.operation.mcp_prepared",
      {
        operationId: this.start.operation_id,
        commandId: envelope.command_id,
        outcome: envelope.outcome,
        prepared: envelope.prepared,
        durationMs: envelope.duration_ms,
        reason: envelope.reason,
      },
    );
  }

  #observePrepareResume(measurement: NativeResumeMeasurement): void {
    if (this.#prepareResumeObserved) return;
    this.#prepareResumeObserved = true;
    this.#observeNativeResume(measurement);
  }

  #observeNativeResume(measurement: NativeResumeMeasurement): void {
    // The metadata log filter drops `result` as a payload key; the bounded
    // enum is logged as `outcome`.
    const { result, ...timing } = measurement;
    logAgentEvent("info", "agent_runtime_measurement", {
      execution_backend: "local",
      stage: "native_resume",
      ...timing,
      outcome: result,
      operation_id: this.start.operation_id,
    });
  }

  get terminal(): boolean {
    return this.#terminal;
  }

  get accepted(): boolean {
    return this.#accepted;
  }

  async waitForAcceptance(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.#accepted && !this.#terminal) {
      await once(this.#acceptance, "settled", { signal });
    }
    if (!this.#accepted || this.#terminal) {
      throw new RunnerGatewayError("Local MCP Relay Operation is not active");
    }
  }

  get lastSequence(): number {
    return this.#lastSequence;
  }

  get currentContextViewRef(): ContextViewRef | undefined {
    return this.#currentContextViewRef;
  }

  handle(): RunnerOperation {
    return {
      operationId: this.start.operation_id,
      events: this.#events,
      result: this.#outcome.promise,
      input: (options) => this.#input(options),
      cancel: (reason) => this.#cancel(reason),
    };
  }

  reconnectCommands(options?: {
    readonly connectionEpoch: number;
    readonly retainedByDaemon: boolean;
  }): readonly AgentToDaemonEnvelope[] {
    if (this.#terminal) return [];
    if (
      options &&
      !this.#accepted &&
      !options.retainedByDaemon &&
      this.start.connection_epoch !== options.connectionEpoch
    ) {
      this.#rebaseConnectionEpoch(options.connectionEpoch);
    }
    const commands: AgentToDaemonEnvelope[] = [
      this.start,
      ...[...this.#pendingInputs.values()]
        .filter((pending) => !pending.settled && !this.#cancelCommand)
        .map((pending) => pending.command),
    ];
    if (this.#cancelCommand) {
      commands.push(this.#cancelCommand);
    }
    return commands;
  }

  #rebaseConnectionEpoch(connectionEpoch: number): void {
    const start = parseAgentToDaemonEnvelope({
      ...this.start,
      connection_epoch: connectionEpoch,
    });
    if (start.type !== "operation.start") {
      throw new RunnerGatewayProtocolError(
        "Failed to rebase pending Operation start",
      );
    }
    this.start = start;
    for (const [commandId, pending] of this.#pendingInputs) {
      const command = parseAgentToDaemonEnvelope({
        ...pending.command,
        connection_epoch: connectionEpoch,
      });
      if (command.type !== "operation.input") {
        throw new RunnerGatewayProtocolError(
          "Failed to rebase pending Operation input",
        );
      }
      this.#pendingInputs.set(commandId, { ...pending, command });
    }
    if (this.#cancelCommand) {
      const cancel = parseAgentToDaemonEnvelope({
        ...this.#cancelCommand,
        connection_epoch: connectionEpoch,
      });
      if (cancel.type !== "cancel" || cancel.target !== "operation") {
        throw new RunnerGatewayProtocolError(
          "Failed to rebase pending Operation cancellation",
        );
      }
      this.#cancelCommand = cancel;
    }
  }

  retainCancellation(reason: string): void {
    if (this.#terminal) {
      return;
    }
    this.#cancelCommand ??= createCancel(this.start, this.#createId(), reason);
  }

  /**
   * Ends the Operation here without waiting for its Computer: its Agent is no
   * longer placed there, so nothing it reports later is applied. The Computer
   * is asked to cancel it once.
   */
  async abandon(code: string, message: string): Promise<void> {
    await this.#serialize(async () => {
      if (this.#terminal) return;
      this.#complete(() =>
        this.#outcome.reject(new RunnerOperationError(code, message, false)),
      );
      void this.#send(createCancel(this.start, this.#createId(), code)).catch(
        () => undefined,
      );
    });
  }

  // The Daemon sent an event for this Operation that fails the Runner contract.
  // The Operation fails explicitly instead of closing the connection, because
  // the Daemon would replay the same event on every reconnect.
  async failInvalidEvent(sequence: number): Promise<void> {
    await this.#serialize(async () => {
      if (this.#terminal) return;
      this.#lastSequence = Math.max(this.#lastSequence, sequence);
      this.#complete(() =>
        this.#outcome.reject(
          new RunnerOperationError(
            "runner_event_invalid",
            "The Computer sent an Operation event that breaks the Runner protocol",
            false,
          ),
        ),
      );
      void this.#send(
        createCancel(this.start, this.#createId(), "runner_event_invalid"),
      ).catch(() => undefined);
    });
  }

  assertIdentity(
    value: ActiveOperation | OperationEnvelope | OperationInputClosed,
  ): void {
    assertOperationIdentity(this.start, value);
  }

  async receive(
    envelope: OperationEnvelope,
  ): Promise<OperationAck | undefined> {
    return this.#serialize(() => this.#receive(envelope));
  }

  // A display event that fails the Runner contract is consumed in sequence
  // like any other, so the Daemon ledger clears and the Run goes on, but it is
  // never pushed: the presentation keeps its last valid state.
  async receiveUnapplied(envelope: OperationEnvelope): Promise<OperationAck> {
    return this.#serialize(() => this.#receive(envelope, false));
  }

  async receiveClosedInput(envelope: OperationInputClosed): Promise<void> {
    return this.#serialize(async () => {
      assertOperationIdentity(this.start, envelope);
      const pending = this.#pendingInputs.get(envelope.command_id);
      // The Daemon answers each input once from its ledger, and it never
      // commits a terminal while it holds an unanswered input, so a receipt
      // after the terminal is still the input's authoritative outcome. Late
      // duplicates of an input already settled are expected and ignored.
      if (this.#terminal && (!pending || pending.settled)) return;
      if (
        !pending ||
        pending.command.expected_turn_id !== envelope.expected_turn_id
      ) {
        throw new RunnerGatewayProtocolError(
          "Runner emitted an unmatched closed input receipt",
        );
      }
      if (pending.settled) return;
      this.#settleInput(envelope.command_id, envelope.expected_turn_id, () => {
        throw new RunnerOperationInputError(
          "Previous Runtime operation has ended",
          envelope.effect,
          "no_active_turn",
        );
      });
    });
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const received = this.#receiveTail.then(action);
    this.#receiveTail = received.then(
      () => undefined,
      () => undefined,
    );
    return received;
  }

  async #receive(
    envelope: OperationEnvelope,
    apply = true,
  ): Promise<OperationAck> {
    assertOperationIdentity(this.start, envelope);
    // A restarted Daemon keeps no Operation: it numbers the terminal it
    // reports for one it lost from 1. This Operation has seen no terminal, so
    // the frame is not a replay; it ends the Operation.
    const restartedTerminal =
      envelope.seq <= this.#lastSequence &&
      !this.#terminal &&
      isTerminalEnvelope(envelope);
    // A Computer that reconnects replays every event it has not seen
    // acknowledged; the ones already applied only need the acknowledgement.
    if (envelope.seq <= this.#lastSequence && !restartedTerminal)
      return this.#ack(this.#lastSequence);
    if (this.#terminal) {
      // A Gateway-local terminal (cancel timeout, abandoned placement) does
      // not stop the Daemon from finishing the Operation it was asked to
      // cancel. Acknowledge its late in-order frames without applying them;
      // rejecting them closes the connection and the Daemon replays them on
      // every reconnect.
      if (!this.#outcomeEnvelope && envelope.seq === this.#lastSequence + 1) {
        this.#lastSequence = envelope.seq;
        return this.#ack(this.#lastSequence);
      }
      throw new RunnerGatewayProtocolError(
        "Runner emitted after terminal state",
      );
    }
    if (!restartedTerminal && envelope.seq !== this.#lastSequence + 1) {
      throw new RunnerGatewayProtocolError(
        "Runner event sequence contains a gap",
      );
    }
    if (envelope.type === "operation.input_result") {
      const pending = this.#pendingInputs.get(envelope.command_id);
      const turnId =
        envelope.outcome === "accepted"
          ? envelope.turn_id
          : envelope.expected_turn_id;
      if (
        !pending ||
        pending.settled ||
        pending.command.expected_turn_id !== turnId
      )
        throw new RunnerGatewayProtocolError(
          "Runner emitted an unmatched input outcome",
        );
    }
    this.#acceptEnvelope(envelope);
    if (
      envelope.type === "operation.completed" ||
      envelope.type === "operation.failed" ||
      envelope.type === "operation.cancelled"
    )
      this.#outcomeEnvelope = envelope;
    const nativeResume =
      envelope.type === "operation.completed"
        ? envelope.result.native_resume
        : envelope.type === "operation.failed" ||
            envelope.type === "operation.cancelled"
          ? envelope.native_resume
          : undefined;
    if (nativeResume) this.#observeNativeResume(nativeResume);
    const prepareResume =
      envelope.type === "operation.completed"
        ? envelope.result.prepare_native_resume
        : envelope.type === "operation.failed" ||
            envelope.type === "operation.cancelled"
          ? envelope.prepare_native_resume
          : undefined;
    if (prepareResume) this.#observePrepareResume(prepareResume);
    if (apply) await this.#applyEnvelope(envelope);
    // After a restarted Daemon's terminal the sequence is that Daemon's, so
    // its replays of the terminal are acknowledged at the same sequence.
    this.#lastSequence = envelope.seq;
    return this.#ack(this.#lastSequence);
  }

  #acceptEnvelope(envelope: OperationEnvelope): void {
    if (envelope.type === "operation.failed" && !this.#accepted) {
      return;
    }
    if (envelope.type === "operation.accepted") {
      if (this.#accepted || envelope.command_id !== this.start.command_id) {
        throw new RunnerGatewayProtocolError(
          "Runner operation acceptance is invalid",
        );
      }
      this.#accepted = true;
      const now = performance.now();
      logAgentEvent("info", "runner.operation.accepted_received", {
        operationId: this.start.operation_id,
        computerId: this.start.runner_id,
        agentId: this.start.agent_id,
        executionContextKey: this.start.execution_context_key,
        kind: this.start.request.kind,
        sinceCreatedMs: now - this.#createdAt,
        sinceSentMs:
          this.#lastStartSentAt === undefined
            ? undefined
            : now - this.#lastStartSentAt,
      });
      this.#acceptance.emit("settled");
      return;
    }
    if (!this.#accepted) {
      throw new RunnerGatewayProtocolError(
        "Runner emitted before operation acceptance",
      );
    }
  }

  async #applyEnvelope(envelope: OperationEnvelope): Promise<void> {
    switch (envelope.type) {
      case "operation.accepted":
        break;
      case "operation.event":
        await this.#events.push(envelope.event);
        break;
      case "operation.input_result":
        if (envelope.outcome === "accepted") {
          const turnId = envelope.turn_id;
          this.#settleInput(envelope.command_id, turnId, () => ({ turnId }));
          break;
        } else {
          const rejected = envelope;
          this.#settleInput(
            rejected.command_id,
            rejected.expected_turn_id,
            () => {
              throw new RunnerOperationInputError(
                rejected.message,
                rejected.effect,
                rejected.reason,
              );
            },
          );
          break;
        }
      case "operation.completed":
        this.#complete(() => this.#outcome.resolve(envelope.result), true);
        break;
      case "operation.failed":
        logAgentEvent("error", "runner.operation.failed", {
          operationId: this.start.operation_id,
          computerId: this.start.runner_id,
          agentId: this.start.agent_id,
          tenantId: this.start.tenant_id,
          executionContextKey: this.start.execution_context_key,
          kind: this.start.request.kind,
          runId: this.start.request.run_context.execution_run_ref,
          stage: envelope.stage,
          errorCode: envelope.error.code,
          errorMessage: envelope.error.message,
          ...envelope.error.diagnostics,
          failureCode: envelope.error.failure?.code,
          runtimeType: this.start.runtime_type,
          runtimeVersion: envelope.error.failure?.runtime_version,
        });
        this.#complete(
          () =>
            this.#outcome.reject(
              envelope.error.failure
                ? new RuntimeExecutionError(envelope.error.failure, {
                    diagnostics: envelope.error.diagnostics,
                  })
                : new RunnerOperationError(
                    envelope.error.code,
                    envelope.error.message,
                    envelope.error.retryable,
                  ),
            ),
          true,
        );
        break;
      case "operation.cancelled":
        this.#complete(
          () =>
            this.#outcome.reject(
              new RunnerOperationError("cancelled", envelope.reason, false),
            ),
          true,
        );
        break;
      default:
        assertNever(envelope);
    }
  }

  async #input(options: RunnerOperationInput): Promise<ProviderSteerAck> {
    const pending = await this.#serialize(async () => {
      if (!this.#accepted || this.#terminal) {
        throw new RunnerOperationInputError(
          "No active Runtime run",
          "definitely_not_applied",
          "no_active_turn",
        );
      }
      const command = parseAgentToDaemonEnvelope({
        ...operationIdentity(this.start),
        type: "operation.input",
        command_id: this.#createId(),
        expected_turn_id: options.expectedTurnId,
        input_context_view_ref:
          options.contextViewRef ?? this.#currentContextViewRef,
        input: options.input,
      });
      if (command.type !== "operation.input") {
        throw new RunnerGatewayProtocolError("Invalid operation input command");
      }
      const pending: PendingInput = {
        command,
        outcome: deferred<ProviderSteerAck>(),
        settled: false,
      };
      this.#currentContextViewRef = command.input_context_view_ref;
      this.#pendingInputs.set(command.command_id, pending);
      return pending;
    });
    await this.#send(pending.command).catch(() => undefined);
    return pending.outcome.promise;
  }

  async #cancel(reason: string): Promise<void> {
    const message = `Runner operation "${this.start.operation_id}" cancellation was not confirmed`;
    const command = await this.#serialize(async () => {
      if (this.#terminal) return undefined;
      this.retainCancellation(reason);
      return this.#cancelCommand;
    });
    if (!command) return;
    await this.#send(command).catch(() => undefined);
    try {
      await settleWithin(
        this.#outcome.promise.then(
          () => undefined,
          () => undefined,
        ),
        this.#cancelTimeoutMs,
        message,
      );
    } catch {
      if (this.#terminal) return;
      this.#complete(() =>
        this.#outcome.reject(
          new RunnerOperationError("cancelled", message, false),
        ),
      );
    }
  }

  #settleInput(
    commandId: string,
    expectedTurnId: string,
    outcome: () => ProviderSteerAck,
  ): void {
    const pending = this.#pendingInputs.get(commandId);
    if (
      !pending ||
      pending.settled ||
      pending.command.expected_turn_id !== expectedTurnId
    ) {
      throw new RunnerGatewayProtocolError(
        "Runner emitted an unmatched input outcome",
      );
    }
    pending.settled = true;
    try {
      pending.outcome.resolve(outcome());
    } catch (error) {
      pending.outcome.reject(error);
    }
    this.#noteInputSettled();
  }

  /**
   * Resolves once every input still unanswered at the terminal is settled;
   * undefined when none is. The Operation must stay reachable for its
   * closed-input receipts until then.
   */
  inputReceipts(): Promise<void> | undefined {
    return this.#inputReceipts?.promise;
  }

  /**
   * Settles every input still awaiting its receipt after the terminal as
   * uncertain: no receipt can arrive any more. A terminal Operation never
   * resends an input, because a restarted Daemon fails the connection on an
   * input for an Operation it no longer knows.
   */
  expireInputReceipts(): void {
    if (!this.#terminal) return;
    for (const pending of this.#pendingInputs.values()) {
      if (pending.settled) continue;
      pending.settled = true;
      pending.outcome.reject(
        new RunnerOperationInputError(
          "Runtime operation terminated before confirming input",
          "uncertain",
          "transport",
        ),
      );
    }
    this.#noteInputSettled();
  }

  #noteInputSettled(): void {
    if (!this.#terminal || !this.#inputReceipts) return;
    for (const pending of this.#pendingInputs.values())
      if (!pending.settled) return;
    clearTimeout(this.#inputReceiptTimer);
    this.#inputReceiptTimer = undefined;
    this.#inputReceipts.resolve();
  }

  /**
   * Ends the Operation. Only a terminal the Daemon reported awaits the
   * receipts of inputs still in flight: the Daemon never commits a terminal
   * while it holds an unanswered input, so it either never received them or
   * answers each with a closed receipt. A Gateway-local terminal leaves the
   * Daemon possibly still running the input, and its sequenced outcome is no
   * longer applied, so those inputs are uncertain at once.
   */
  #complete(settle: () => void, awaitInputReceipts = false): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#acceptance.emit("settled");
    this.#events.close();
    if (
      awaitInputReceipts &&
      [...this.#pendingInputs.values()].some((pending) => !pending.settled)
    ) {
      this.#inputReceipts = deferred<void>();
      this.#inputReceiptTimer = setTimeout(
        () => this.expireInputReceipts(),
        this.#cancelTimeoutMs,
      );
    } else {
      this.expireInputReceipts();
    }
    settle();
  }

  #ack(throughSequence: number): OperationAck {
    return createOperationAck(this.start, this.#createId(), throughSequence);
  }
}

/**
 * Acknowledges an event of an Operation this process does not hold: one that
 * an earlier Agent Service process started, or that this process ended. The
 * event is dropped; the acknowledgement only clears the Daemon's buffer.
 */
const isTerminalEnvelope = (envelope: OperationEnvelope): boolean =>
  envelope.type === "operation.completed" ||
  envelope.type === "operation.failed" ||
  envelope.type === "operation.cancelled";

export const acknowledgeDroppedOperationEvent = (
  envelope: OperationEnvelope,
  commandId: string,
): OperationAck => createOperationAck(envelope, commandId, envelope.seq);

export const createOrphanCancel = (
  active: ActiveOperation,
  commandId: string,
): OperationCancel =>
  createCancel(
    active,
    commandId,
    "Agent Service no longer owns this operation",
  );

// Provider prepare sends the View ref in the same field order the admitted
// operation identity uses (see operationIdentity).
export const contextViewRefIdentity = (
  value: ContextViewRef,
): ContextViewRef => ({ view_digest: value.view_digest });

const operationIdentity = (
  value:
    | OperationStart
    | ActiveOperation
    | OperationInput
    | OperationPrepared
    | OperationEnvelope
    | OperationInputClosed,
): Omit<OperationAck, "type" | "command_id" | "through_seq"> => ({
  protocol_version: value.protocol_version,
  host_access: value.host_access,
  tenant_id: value.tenant_id,
  registration_id: value.registration_id,
  assignment_revision: value.assignment_revision,
  runner_id: value.runner_id,
  execution_context_key: value.execution_context_key,
  runtime_instance_id: value.runtime_instance_id,
  // Go Computer 0.2.0 retains this object as a JSON string in its identity.
  // Snapshot/jsonb key order differs from LocalContextRuntimeBackend's
  // admitted start. Restore those bytes for ACK, cancel, and input while
  // keeping every authority field and the semantic identity checks.
  context_view_ref: { view_digest: value.context_view_ref.view_digest },
  agent_id: value.agent_id,
  operation_id: value.operation_id,
  connection_epoch: value.connection_epoch,
  runner_revision: value.runner_revision,
  generation: value.generation,
  execution_lease_id: value.execution_lease_id,
  workspace_grant_id: value.workspace_grant_id,
  runtime_type: value.runtime_type,
});

const createCancel = (
  value: OperationStart | ActiveOperation,
  commandId: string,
  reason: string,
): OperationCancel => {
  const command = parseAgentToDaemonEnvelope({
    ...operationIdentity(value),
    type: "cancel",
    target: "operation",
    command_id: commandId,
    reason,
  });
  if (command.type !== "cancel" || command.target !== "operation") {
    throw new RunnerGatewayProtocolError("Invalid operation cancellation");
  }
  return command;
};

const createOperationAck = (
  value: OperationStart | ActiveOperation | OperationEnvelope,
  commandId: string,
  throughSequence: number,
): OperationAck => {
  const ack = parseAgentToDaemonEnvelope({
    ...operationIdentity(value),
    type: "operation.ack",
    command_id: commandId,
    through_seq: throughSequence,
  });
  if (ack.type !== "operation.ack") {
    throw new RunnerGatewayProtocolError("Invalid operation acknowledgement");
  }
  return ack;
};

const assertOperationIdentity = (
  expected: OperationStart | ActiveOperation,
  actual:
    | ActiveOperation
    | OperationEnvelope
    | OperationInputClosed
    | OperationPrepared,
): void => {
  const expectedIdentity = operationIdentity(expected);
  const actualIdentity = operationIdentity(actual);
  for (const key of Object.keys({
    ...expectedIdentity,
    ...actualIdentity,
  }) as Array<keyof typeof expectedIdentity>) {
    if (!isDeepStrictEqual(expectedIdentity[key], actualIdentity[key])) {
      throw new RunnerGatewayProtocolError(
        `Runner operation identity mismatch at ${key}`,
      );
    }
  }
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
};

const MAX_QUEUED_EVENTS = 64;
const MAX_QUEUED_EVENT_BYTES = 4 * 1024 * 1024;

class AsyncValueQueue<T> implements AsyncIterable<T> {
  readonly #values: Array<{ readonly value: T; readonly bytes: number }> = [];
  readonly #waiters: Array<() => void> = [];
  readonly #spaceWaiters: Array<() => void> = [];
  #bytes = 0;
  #closed = false;
  #claimed = false;

  async push(value: T): Promise<void> {
    if (this.#closed) {
      throw new RunnerGatewayProtocolError("Operation event queue is closed");
    }
    const bytes = encodedBytes(value);
    if (bytes > MAX_QUEUED_EVENT_BYTES) {
      throw new RunnerGatewayProtocolError(
        "Operation event exceeds the Agent buffer limit",
      );
    }
    while (
      !this.#closed &&
      (this.#values.length >= MAX_QUEUED_EVENTS ||
        this.#bytes + bytes > MAX_QUEUED_EVENT_BYTES)
    ) {
      await new Promise<void>((resolve) => this.#spaceWaiters.push(resolve));
    }
    if (this.#closed) {
      throw new RunnerGatewayProtocolError("Operation event queue is closed");
    }
    this.#values.push({ value, bytes });
    this.#bytes += bytes;
    this.#notify();
  }

  close(): void {
    this.#closed = true;
    this.#notify();
    this.#notifySpace();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#claimed) {
      throw new RunnerGatewayProtocolError(
        "Operation events support exactly one consumer",
      );
    }
    this.#claimed = true;
    while (this.#values.length > 0 || !this.#closed) {
      const retained = this.#values.shift();
      if (retained !== undefined) {
        this.#bytes -= retained.bytes;
        this.#notifySpace();
        yield retained.value;
        continue;
      }
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  #notify(): void {
    for (const waiter of this.#waiters.splice(0)) {
      waiter();
    }
  }

  #notifySpace(): void {
    for (const waiter of this.#spaceWaiters.splice(0)) {
      waiter();
    }
  }
}

const encodedBytes = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new RunnerGatewayProtocolError(
      "Operation event cannot be buffered safely",
    );
  }
};

const assertNever = (value: never): never => {
  throw new RunnerGatewayProtocolError(
    `Unsupported Runner envelope: ${JSON.stringify(value)}`,
  );
};

const settleWithin = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RunnerGatewayError(message)),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
