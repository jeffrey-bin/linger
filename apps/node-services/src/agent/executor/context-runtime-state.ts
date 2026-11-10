import { logAgentEvent } from "../observability/agent-log.js";
import { acceptedNotificationInput } from "../prompt/accepted-notification.js";
import {
  encodeExecutionContextRef,
  type ExecutionContextRef,
} from "./context-ref.js";
import { materializeGhostResources, type SkillDescriptor } from "./ghost.js";
import type {
  RuntimeExecutionFailure,
  RuntimeSession as ProviderRuntimeSession,
} from "./provider.js";
import type {
  LocalTurnStatus,
  LocalTurnTerminal,
  Message,
  NonEmptyReadonlyArray,
  RunCancellationStatus,
} from "./types.js";
import {
  TeamHubRuntimeStateError,
  runtimeClaimId,
  type AcceptedContextState,
  type RuntimeInput,
  type RuntimeSession as TeamHubRuntimeSession,
  type RuntimeSessionCheckpoint,
  type TeamHubRuntimeStateClient,
  isTeamHubNotFound,
} from "./teamhub-runtime-state-client.js";
import { isRecord } from "@linger/service-kit";

export type RuntimeStateAwaitable<T> = T | PromiseLike<T>;

export interface ClaimedLocalRun {
  /** The Context received input before this Run's first input. */
  readonly continuesContext?: boolean;
  /** Process-local only; absent for Runs queued before this process. */
  readonly acceptedAtMonotonicMs?: number;
  /** Earliest TeamHub input `created_at` as epoch ms; absent on old TeamHub. */
  readonly inputReceivedAtMs?: number;
  readonly cancellationRequested?: boolean;
  /**
   * The Agent's current profile when this Context's Session started under an
   * older one; it precedes this Run's input once.
   */
  readonly profileUpdate?: ProfileUpdate;
  runId: string;
  attemptCount: number;
  messages: NonEmptyReadonlyArray<Message>;
}

export interface ProfileUpdate {
  readonly configurationRevision: number;
  readonly name: string;
  readonly instructions: string;
}

/**
 * A steer a Message transaction queued for this Context: a targeted Message
 * for the running Run that reads its Inbox, or a native question's answer for
 * the Run that asked it (runId set, message.runtimeResponses present).
 */
export interface MessageSteer {
  readonly groupId: string;
  readonly inputId: string;
  readonly inboxId?: string;
  readonly runId?: string;
  readonly message: Message;
}

export type TrustedNotificationAcceptance =
  | { readonly status: "already_accepted" }
  | { readonly status: "committed"; readonly groupId: string };

export type LocalRunStatus = LocalTurnStatus;

/** The observed Turn terminal, plus the failure detail Runtime State keeps. */
export type LocalRunTerminal =
  | Exclude<LocalTurnTerminal, { readonly type: "failed" }>
  | (Extract<LocalTurnTerminal, { readonly type: "failed" }> & {
      readonly failure?: RuntimeExecutionFailure;
    });

export interface LocalRun {
  cancellationRequested?: boolean;
  runId: string;
  initialMessageIds: NonEmptyReadonlyArray<string>;
  steerMessageIds: readonly string[];
  status: LocalRunStatus;
  attemptCount: number;
  terminal?: LocalRunTerminal;
}

export interface ContextRuntimeStatePort {
  /** The Agent Service epoch a Runner execution checkpoint names. */
  executionEpoch?(): string;
  acceptTrustedNotification(
    executionRunRef: string,
    message: Message,
  ): RuntimeStateAwaitable<TrustedNotificationAcceptance>;
  enqueueTrustedTurn(
    messages: NonEmptyReadonlyArray<Message>,
  ): RuntimeStateAwaitable<string>;
  cancelTrustedTurn(
    messages: NonEmptyReadonlyArray<Message>,
  ): RuntimeStateAwaitable<{
    readonly runId: string;
    readonly status: RunCancellationStatus;
  }>;
  claimLocalRun(): RuntimeStateAwaitable<ClaimedLocalRun | null>;
  requeueLocalRun(runId: string): RuntimeStateAwaitable<void>;
  /**
   * Resolves to "upstream_canceled" when TeamHub had already canceled the Run
   * for a reason and kept that terminal instead of this one.
   */
  finishLocalRun(
    runId: string,
    terminal: LocalRunTerminal,
    session?: ProviderRuntimeSession,
    stopSignal?: AbortSignal,
  ): RuntimeStateAwaitable<"upstream_canceled" | void>;
  /** Resolve only a confirmed upstream cancellation of this revoked execution. */
  reconcileRevokedLocalRun?(
    runId: string,
    error: unknown,
  ): RuntimeStateAwaitable<Extract<
    LocalRunTerminal,
    { type: "canceled" }
  > | null>;
  /** Re-read queued Local Runs after MCP resolve can make a Document Run claimable. */
  refreshWorkState?(): RuntimeStateAwaitable<void>;
  /** Message steers the last work-state read listed, each handed out once. */
  takeMessageSteers?(): readonly MessageSteer[];
  /** A run.queued hint proves queued work without another read. */
  noteQueuedRun?(): void;
  cancelLocalRun(runId: string): RuntimeStateAwaitable<RunCancellationStatus>;
  getLocalRun(runId: string): RuntimeStateAwaitable<LocalRun | null>;
  enqueueSteer(
    groupId: string,
    messages: NonEmptyReadonlyArray<Message>,
  ): RuntimeStateAwaitable<string>;
  assignSteerRun(groupId: string, runId: string): RuntimeStateAwaitable<void>;
  completeSteer(
    groupId: string,
    runId: string,
    outcome: "applied" | "uncertain",
  ): RuntimeStateAwaitable<void>;
  hasQueuedRuns(): boolean;
  hasPendingWork(): boolean;
  /** Inputs accepted by this process that are not yet claimed or settled. */
  acceptedInputPending?(): boolean;
  earliestAcceptedInputMs?(): number | undefined;
  getRuntimeSession(): RuntimeStateAwaitable<ProviderRuntimeSession>;
  setRuntimeSession(
    session: ProviderRuntimeSession,
    executionResources?: ExecutionResources | null,
  ): RuntimeStateAwaitable<void>;
  getExecutionResources(): RuntimeStateAwaitable<ExecutionResources | null>;
  setExecutionResources(
    resources: ExecutionResources,
  ): RuntimeStateAwaitable<void>;
  clearRuntimeSession(): RuntimeStateAwaitable<boolean>;
  /**
   * Drop a RuntimeSession checkpointed under an older configuration revision.
   * Runtime activation calls this; read-only inspection must not, so Debug
   * History keeps reading the last session until the Context runs again.
   */
  discardStaleRuntimeSession?(): RuntimeStateAwaitable<boolean>;
  close(): RuntimeStateAwaitable<void>;
}

/** Exact loaded versions, never a permission grant or a package credential. */
export interface ExecutionSkillDescriptor extends SkillDescriptor {
  readonly manifestId: string;
  readonly source: "default" | "explicit";
}

export interface ExecutionResources {
  readonly version: 1;
  readonly effectiveSha256: string;
  readonly skills: readonly ExecutionSkillDescriptor[];
}

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/u;
const CREDENTIAL = /(?:mcp_ctx_|cli_ctx_)[A-Za-z0-9_-]{43}/u;

export const parseExecutionResources = (value: unknown): ExecutionResources => {
  if (!isRecord(value)) throw new TypeError("Invalid execution resources");
  assertKeys(value, ["version", "effectiveSha256", "skills"]);
  if (
    value.version !== 1 ||
    typeof value.effectiveSha256 !== "string" ||
    !SHA256.test(value.effectiveSha256) ||
    !Array.isArray(value.skills) ||
    value.skills.length > 100
  )
    throw new TypeError("Invalid execution resources");
  const skillIds = new Set<string>();
  const manifestIds = new Set<string>();
  const packageNames = new Set<string>();
  const skills = value.skills.map((item) => {
    if (!isRecord(item)) throw new TypeError("Invalid execution Skill");
    assertKeys(item, [
      "skillId",
      "manifestId",
      "manifestVersion",
      "name",
      "packageName",
      "packageSha256",
      "config",
      "source",
    ]);
    if (
      typeof item.manifestId !== "string" ||
      !IDENTIFIER.test(item.manifestId) ||
      (item.source !== "default" && item.source !== "explicit")
    )
      throw new TypeError("Invalid execution Skill version");
    const { manifestId, source, ...descriptor } = item;
    const skill = materializeGhostResources({
      skills: [descriptor as unknown as SkillDescriptor],
    }).skills[0]!;
    if (
      skillIds.has(skill.skillId) ||
      manifestIds.has(manifestId) ||
      packageNames.has(skill.packageName)
    )
      throw new TypeError("Duplicate execution Skill");
    skillIds.add(skill.skillId);
    manifestIds.add(manifestId);
    packageNames.add(skill.packageName);
    return Object.freeze({ ...skill, manifestId, source });
  });
  const resources: ExecutionResources = {
    version: 1,
    effectiveSha256: value.effectiveSha256,
    skills: Object.freeze(skills),
  };
  assertNoCredentials(resources);
  return Object.freeze(resources);
};

/** The provider receives only its native object; schema 1 remains readable. */
export const readRuntimeSessionCheckpoint = (checkpoint: {
  readonly schema_version: string;
  readonly session: Record<string, unknown>;
  readonly thread_id?: string;
}): {
  nativeSession: Record<string, unknown> | null;
  executionResources: ExecutionResources | null;
} => {
  if (checkpoint.schema_version === "1") {
    return { nativeSession: checkpoint.session, executionResources: null };
  }
  if (checkpoint.schema_version !== "2" || !isRecord(checkpoint.session))
    throw new TypeError("Unsupported RuntimeSession schema");
  assertKeys(checkpoint.session, ["nativeSession", "executionResources"]);
  const { nativeSession } = checkpoint.session;
  if (nativeSession !== null && !isRecord(nativeSession))
    throw new TypeError("Invalid native RuntimeSession");
  if (
    nativeSession === null
      ? checkpoint.thread_id !== undefined
      : nativeSession.threadId !== checkpoint.thread_id
  )
    throw new TypeError("RuntimeSession thread identity mismatch");
  return {
    nativeSession,
    executionResources: parseExecutionResources(
      checkpoint.session.executionResources,
    ),
  };
};

const assertKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TypeError("Unexpected execution resource metadata");
};

const assertNoCredentials = (value: unknown): void => {
  if (typeof value === "string" && CREDENTIAL.test(value))
    throw new TypeError("Execution resources must not contain credentials");
  if (Array.isArray(value)) value.forEach(assertNoCredentials);
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) {
      if (
        ["authorization", "httpheaders"].includes(
          key.toLowerCase().replaceAll("_", ""),
        )
      )
        throw new TypeError("Execution resources must not contain credentials");
      assertNoCredentials(item);
    }
};

export interface TeamHubContextRuntimeStateOptions {
  readonly client: TeamHubRuntimeStateClient;
  readonly ref: ExecutionContextRef;
  readonly configurationRevision: string;
  readonly providerKind: string;
  /** The Context state an acceptance committed, for the Context record. */
  readonly onInputCommitted?: (state: AcceptedContextState) => void;
  /**
   * Called before a write that advances the Context revision
   * without returning it; the result runs once that write committed.
   */
  readonly trackOwnRevisionAdvance?: () => () => void;
}

/**
 * TeamHub-backed implementation of the executor's durable state port. The only
 * values retained locally are the last Session read, execution resources not
 * yet checkpointed and bounded work observations; every mutation names this
 * process's Agent Service epoch and goes through a generated TeamHub API.
 */
export const createTeamHubContextRuntimeState = async (
  options: TeamHubContextRuntimeStateOptions,
): Promise<ContextRuntimeStatePort> => {
  const state = new TeamHubContextRuntimeState(options);
  await state.initialize();
  return state;
};

class TeamHubContextRuntimeState implements ContextRuntimeStatePort {
  readonly #client: TeamHubRuntimeStateClient;
  readonly #contextKey: string;
  readonly #configurationRevision: string;
  readonly #providerKind: string;
  readonly #epoch: string;
  readonly #onInputCommitted:
    | ((state: AcceptedContextState) => void)
    | undefined;
  readonly #trackOwnRevisionAdvance: (() => () => void) | undefined;
  #session: TeamHubRuntimeSession | null = null;
  // Resources the Runtime loaded for its next turn; they reach TeamHub with
  // the next Session checkpoint instead of a write of their own.
  #pendingResources: ExecutionResources | undefined;
  #hasQueuedRuns = false;
  #hasPendingWork = false;
  #messageSteers: readonly MessageSteer[] = [];
  // Steers handed to the executor stay here until a later read no longer lists
  // them, so overlapping reads never hand one steer out twice.
  readonly #takenSteerGroups = new Set<string>();
  // Bumped whenever a committed TeamHub command proves queued work. A
  // work-state read that started before the bump may predate that commit.
  #queuedWorkMark = 0;
  readonly #acceptedAt = new Map<string, number>();
  #closed = false;
  readonly #terminalRecoveryStop = new AbortController();

  constructor(options: TeamHubContextRuntimeStateOptions) {
    this.#client = options.client;
    this.#contextKey = encodeExecutionContextRef(options.ref);
    this.#configurationRevision = parsePositiveInt64(
      options.configurationRevision,
      "configurationRevision",
    );
    if (!options.providerKind.trim()) {
      throw new TypeError("providerKind must not be empty");
    }
    this.#providerKind = options.providerKind;
    this.#epoch = options.client.epoch;
    this.#onInputCommitted = options.onInputCommitted;
    this.#trackOwnRevisionAdvance = options.trackOwnRevisionAdvance;
  }

  async initialize(): Promise<void> {
    this.#assertOpen();
    const [, session] = await Promise.all([
      this.#refreshWorkState(),
      this.#client.getSession(this.#contextKey),
    ]);
    this.#session = session.available ? (session.session ?? null) : null;
  }

  async discardStaleRuntimeSession(): Promise<boolean> {
    this.#assertOpen();
    // Compatibility is a current server observation, never a cached Session or
    // provider claim. Failed reads leave the last checkpoint intact.
    const current = await this.#client.getSession(this.#contextKey);
    this.#session = current.available ? (current.session ?? null) : null;
    if (
      !this.#session ||
      this.#session.configuration_revision === this.#configurationRevision ||
      (this.#session.provider_kind === this.#providerKind &&
        this.#session.compatible_configuration_revision ===
          this.#configurationRevision)
    ) {
      return false;
    }
    const cleared = await this.#clearRuntimeSession(
      this.#configurationRevision,
    );
    if (!cleared) {
      throw new Error("Stale Runtime Session could not be cleared");
    }
    return true;
  }

  async acceptTrustedNotification(
    executionRunRef: string,
    message: Message,
  ): Promise<TrustedNotificationAcceptance> {
    this.#assertOpen();
    const result = await this.#client.acceptTrustedNotification({
      context_key: this.#contextKey,
      epoch: this.#epoch,
      execution_run_ref: executionRunRef,
      input: toRuntimeInput(message, "internal"),
    });
    if (result.status === "already_accepted") {
      return { status: "already_accepted" };
    }
    if (!result.steer_group_id) {
      throw new Error(
        "TeamHub accepted trusted notification without a steer group ID",
      );
    }
    this.#hasPendingWork = true;
    return { status: "committed", groupId: result.steer_group_id };
  }

  async enqueueTrustedTurn(
    messages: NonEmptyReadonlyArray<Message>,
  ): Promise<string> {
    this.#assertOpen();
    const result = await this.#client.submitTrustedTurn({
      context_key: this.#contextKey,
      epoch: this.#epoch,
      inputs: messages.map((message) =>
        toRuntimeInput(message, "trusted_turn"),
      ),
    });
    if (result.created) {
      this.#recordAcceptedRun(result.run_id);
      // A freshly created Run is authoritative queued work. A repeated
      // submission adds no new information: the original commit or the last
      // refresh already set the truthful local pending state.
      this.#recordQueuedWork();
    }
    if (result.context) this.#onInputCommitted?.(result.context);
    return result.run_id;
  }

  async cancelTrustedTurn(messages: NonEmptyReadonlyArray<Message>): Promise<{
    readonly runId: string;
    readonly status: RunCancellationStatus;
  }> {
    this.#assertOpen();
    const submitted = await this.#client.submitTrustedTurn({
      context_key: this.#contextKey,
      epoch: this.#epoch,
      inputs: messages.map((message) =>
        toRuntimeInput(message, "trusted_turn"),
      ),
    });
    const result = await this.#client.cancelRun({
      context_key: this.#contextKey,
      epoch: this.#epoch,
      run_id: submitted.run_id,
    });
    if (result.status === "canceled" || result.status === "already_terminal")
      this.#acceptedAt.delete(submitted.run_id);
    await this.#refreshWorkState();
    return { runId: submitted.run_id, status: result.status };
  }

  executionEpoch(): string {
    return this.#epoch;
  }

  async claimLocalRun(): Promise<ClaimedLocalRun | null> {
    this.#assertOpen();
    const revisionAdvanced = this.#trackOwnRevisionAdvance?.();
    const result = await this.#client.claimRun({
      context_key: this.#contextKey,
      epoch: this.#epoch,
      claim_id: runtimeClaimId(),
    });
    if (!result.claimed || !result.run) {
      await this.#refreshWorkState();
      return null;
    }
    revisionAdvanced?.();
    // The claim response is the durable handoff. Finish/requeue refresh latest
    // work, and racing notifications retain their own refresh request.
    this.#hasQueuedRuns = false;
    this.#hasPendingWork = true;
    return {
      runId: result.run.run_id,
      continuesContext: result.run.continues_context,
      acceptedAtMonotonicMs: this.#acceptedAt.get(result.run.run_id),
      inputReceivedAtMs: earliestInputReceivedAtMs(result.run.inputs),
      attemptCount: result.run.attempt_count,
      cancellationRequested: result.run.cancellation_requested,
      ...(result.run.profile_update
        ? {
            profileUpdate: {
              configurationRevision:
                result.run.profile_update.configuration_revision,
              name: result.run.profile_update.name,
              instructions: result.run.profile_update.instructions,
            },
          }
        : {}),
      messages: asNonEmpty(
        result.run.inputs.map((input) => toMessage(input.payload)),
      ),
    };
  }

  async requeueLocalRun(runId: string): Promise<void> {
    this.#assertOpen();
    await this.#client.requeueRun({
      context_key: this.#contextKey,
      epoch: this.#epoch,
      run_id: runId,
    });
    await this.#refreshWorkState();
  }

  async finishLocalRun(
    runId: string,
    terminal: LocalRunTerminal,
    session?: ProviderRuntimeSession,
    stopSignal?: AbortSignal,
  ): Promise<"upstream_canceled" | void> {
    this.#assertOpen();
    const signal = stopSignal
      ? AbortSignal.any([stopSignal, this.#terminalRecoveryStop.signal])
      : this.#terminalRecoveryStop.signal;
    let body: Parameters<TeamHubRuntimeStateClient["finishRun"]>[0] | undefined;
    let delayMs = 1_000;
    let retry = false;
    let writeAttempt = 0;
    let upstreamCanceled: boolean;
    for (;;) {
      this.#assertOpen();
      try {
        if (!body) {
          const checkpoint =
            session === undefined
              ? undefined
              : await this.#toCheckpoint(session);
          body = {
            context_key: this.#contextKey,
            epoch: this.#epoch,
            run_id: runId,
            terminal: terminal,
            ...(checkpoint ? { session: checkpoint } : {}),
          };
        }
        // Even during stop, allow one bounded attempt to record cancellation.
        // Subsequent attempts are interruptible and repeat the exact request.
        writeAttempt += 1;
        logAgentEvent("info", "local_run.finish_requested", {
          runId,
          writeAttempt,
          resultCode: terminal.type,
          observedAtUnixMs: Date.now(),
        });
        const result = await this.#client.finishRun(
          body,
          retry ? signal : undefined,
        );
        logAgentEvent("info", "local_run.finish_acknowledged", {
          runId,
          writeAttempt,
          resultCode: terminal.type,
          observedAtUnixMs: Date.now(),
        });
        if (result.session) {
          this.#session = result.session;
          this.#pendingResources = undefined;
        }
        this.#acceptedAt.delete(runId);
        // TeamHub keeps a cancellation it wrote for a reason and returns it.
        upstreamCanceled =
          result.run.status === "canceled" && terminal.type !== "canceled";
        break;
      } catch (error) {
        // A rejected Session must not keep the Run running forever: the
        // terminal is what the Human waits on. Finish once more without the
        // Session; the Context then starts its next Run without one.
        if (body?.session !== undefined && isRuntimeStateConflict(error)) {
          logAgentEvent("warn", "local_run.session_checkpoint_rejected", {
            runId,
            writeAttempt,
            error,
          });
          const { session: _rejected, ...withoutSession } = body;
          body = withoutSession;
          continue;
        }
        if (!isTransientTerminalFailure(error) || signal.aborted) throw error;
        try {
          await waitForTerminalRetry(delayMs, signal);
        } catch {
          throw error;
        }
        retry = true;
        delayMs = Math.min(delayMs * 2, 5_000);
      }
    }
    // The terminal is already acknowledged. A failed read cannot undo it or
    // cause the executor to submit a contradictory failed terminal.
    try {
      await this.#refreshWorkState();
    } catch (error) {
      if (!isTransientTerminalFailure(error)) throw error;
    }
    return upstreamCanceled ? "upstream_canceled" : undefined;
  }

  async reconcileRevokedLocalRun(
    runId: string,
    error: unknown,
  ): Promise<Extract<LocalRunTerminal, { type: "canceled" }> | null> {
    this.#assertOpen();
    const runtimeConflict =
      error instanceof TeamHubRuntimeStateError &&
      error.status === 409 &&
      (error.code === "AGENT_RUNTIME_CONFLICT" ||
        error.code === "CONTEXT_FENCED");
    if (!runtimeConflict) return null;
    const context = await this.#client.getContext(this.#contextKey);
    const run = await this.#client.getRun(this.#contextKey, runId);
    // A remote conflict alone cannot settle a Run.
    if (run.status !== "canceled" || run.terminal?.type !== "canceled")
      return null;
    this.#acceptedAt.delete(runId);
    if (context.terminal_reason) return { type: "canceled" };
    // TeamHub records why it canceled a Run (Task archive or completion,
    // membership revocation, Context deletion). The executor's own cancellation
    // never carries a reason.
    if (typeof run.terminal.reason === "string" && run.terminal.reason !== "")
      return { type: "canceled" };
    return null;
  }

  async cancelLocalRun(runId: string): Promise<RunCancellationStatus> {
    this.#assertOpen();
    const result = await this.#client.cancelRun({
      context_key: this.#contextKey,
      epoch: this.#epoch,
      run_id: runId,
    });
    if (result.status === "canceled" || result.status === "already_terminal")
      this.#acceptedAt.delete(runId);
    await this.#refreshWorkState();
    return result.status;
  }

  async getLocalRun(runId: string): Promise<LocalRun | null> {
    this.#assertOpen();
    let result;
    try {
      result = await this.#client.getRun(this.#contextKey, runId);
    } catch (error) {
      if (isTeamHubNotFound(error)) return null;
      throw error;
    }
    if (
      result.status === "succeeded" ||
      result.status === "failed" ||
      result.status === "canceled"
    )
      this.#acceptedAt.delete(runId);
    const terminal = result.terminal as LocalRunTerminal | undefined;
    return {
      runId: result.run_id,
      cancellationRequested: result.cancellation_requested,
      initialMessageIds: asNonEmpty(result.initial_input_ids),
      steerMessageIds: result.steer_input_ids,
      status: result.status,
      attemptCount: result.attempt_count,
      ...(terminal ? { terminal } : {}),
    };
  }

  async enqueueSteer(
    groupId: string,
    _messages: NonEmptyReadonlyArray<Message>,
  ): Promise<string> {
    this.#assertOpen();
    const result = await this.#client.enqueueSteer({
      context_key: this.#contextKey,
      epoch: this.#epoch,
      group_id: groupId,
    });
    this.#recordAcceptedRun(result.run_id);
    await this.#refreshWorkState();
    return result.run_id;
  }

  async assignSteerRun(groupId: string, runId: string): Promise<void> {
    this.#assertOpen();
    await this.#client.assignSteerRun({
      context_key: this.#contextKey,
      epoch: this.#epoch,
      group_id: groupId,
      run_id: runId,
    });
  }

  async completeSteer(
    groupId: string,
    runId: string,
    outcome: "applied" | "uncertain",
  ): Promise<void> {
    this.#assertOpen();
    await this.#client.completeSteer({
      context_key: this.#contextKey,
      epoch: this.#epoch,
      group_id: groupId,
      run_id: runId,
      outcome,
    });
    await this.#refreshWorkState();
  }

  hasQueuedRuns(): boolean {
    return this.#hasQueuedRuns;
  }

  hasPendingWork(): boolean {
    return this.#hasPendingWork;
  }

  /** Whether an input accepted by this process is still unclaimed or unsettled. */
  acceptedInputPending(): boolean {
    return this.#acceptedAt.size > 0;
  }

  /** Earliest monotonic accept time among pending inputs, for latency evidence. */
  earliestAcceptedInputMs(): number | undefined {
    let earliest: number | undefined;
    for (const acceptedAt of this.#acceptedAt.values()) {
      if (earliest === undefined || acceptedAt < earliest)
        earliest = acceptedAt;
    }
    return earliest;
  }

  async getRuntimeSession(): Promise<ProviderRuntimeSession> {
    this.#assertOpen();
    const result = await this.#client.getSession(this.#contextKey);
    this.#session = result.available ? (result.session ?? null) : null;
    return this.#session
      ? readRuntimeSessionCheckpoint(this.#session).nativeSession
      : null;
  }

  getExecutionResources(): ExecutionResources | null {
    this.#assertOpen();
    if (this.#pendingResources) return this.#pendingResources;
    return this.#session
      ? readRuntimeSessionCheckpoint(this.#session).executionResources
      : null;
  }

  /**
   * Records the resources the Runtime loaded for its next turn. They are
   * checkpointed with the next Session, so starting a Run writes nothing.
   */
  setExecutionResources(resources: ExecutionResources): void {
    this.#assertOpen();
    this.#pendingResources = parseExecutionResources(resources);
  }

  async setRuntimeSession(
    session: ProviderRuntimeSession,
    executionResources?: ExecutionResources | null,
  ): Promise<void> {
    this.#assertOpen();
    const checkpoint = await this.#toCheckpoint(session, executionResources);
    const revisionAdvanced = this.#trackOwnRevisionAdvance?.();
    this.#session = await this.#client.checkpointSession({
      context_key: this.#contextKey,
      epoch: this.#epoch,
      checkpoint,
    });
    this.#pendingResources = undefined;
    revisionAdvanced?.();
  }

  async clearRuntimeSession(): Promise<boolean> {
    return this.#clearRuntimeSession();
  }

  async #clearRuntimeSession(
    expectedCurrentConfigurationRevision?: string,
  ): Promise<boolean> {
    this.#assertOpen();
    this.#pendingResources = undefined;
    if (!this.#session) return false;
    const result = await this.#client.clearSession({
      context_key: this.#contextKey,
      epoch: this.#epoch,
      configuration_revision: this.#session.configuration_revision,
      ...(expectedCurrentConfigurationRevision
        ? {
            expected_current_configuration_revision:
              expectedCurrentConfigurationRevision,
          }
        : {}),
    });
    if (result.cleared) this.#session = null;
    return result.cleared;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#acceptedAt.clear();
    this.#terminalRecoveryStop.abort();
  }

  #recordAcceptedRun(runId: string): void {
    if (!this.#closed && !this.#acceptedAt.has(runId))
      this.#acceptedAt.set(runId, performance.now());
  }

  async #toCheckpoint(
    session: ProviderRuntimeSession,
    executionResources?: ExecutionResources | null,
  ): Promise<RuntimeSessionCheckpoint> {
    if (!this.#session) {
      const current = await this.#client.getSession(this.#contextKey);
      this.#session = current.available ? (current.session ?? null) : null;
    }
    return this.#buildCheckpoint(session, executionResources);
  }

  #buildCheckpoint(
    session: ProviderRuntimeSession,
    executionResources?: ExecutionResources | null,
  ): RuntimeSessionCheckpoint {
    const resources =
      executionResources === undefined
        ? (this.#pendingResources ??
          (this.#session
            ? readRuntimeSessionCheckpoint(this.#session).executionResources
            : null))
        : executionResources === null
          ? null
          : parseExecutionResources(executionResources);
    if (!isRecord(session) && !(session === null && resources))
      throw new TypeError("RuntimeSession must be an object");
    const threadId = isRecord(session)
      ? stringValue(session.threadId)
      : undefined;
    if (isRecord(session) && session.threadId === "")
      throw new TypeError(
        "Pending native RuntimeSession must not be checkpointed",
      );
    return {
      expected_revision: this.#session?.revision ?? "0",
      provider_kind: this.#providerKind,
      schema_version: resources ? "2" : "1",
      session: resources
        ? { nativeSession: session, executionResources: resources }
        : (session as Record<string, unknown>),
      ...(threadId ? { thread_id: threadId } : {}),
      configuration_revision: this.#configurationRevision,
    };
  }

  async refreshWorkState(): Promise<void> {
    this.#assertOpen();
    await this.#refreshWorkState();
  }

  async #refreshWorkState(): Promise<void> {
    const mark = this.#queuedWorkMark;
    const state = await this.#client.getWorkState(this.#contextKey);
    // Queued work committed while this read was in flight stays visible; a
    // stale positive only costs one empty claim, which refreshes again.
    const queuedMeanwhile = mark !== this.#queuedWorkMark;
    this.#hasQueuedRuns = state.has_queued_runs || queuedMeanwhile;
    this.#hasPendingWork = state.has_pending_work || queuedMeanwhile;
    const steers = (state.message_steers ?? []).flatMap((input) =>
      input.steer_group_id
        ? [
            Object.freeze({
              groupId: input.steer_group_id,
              ...(input.local_run_id ? { runId: input.local_run_id } : {}),
              ...(input.source_inbox_id
                ? { inboxId: input.source_inbox_id }
                : {}),
              inputId: input.input_id,
              message: toMessage(input.payload),
            }),
          ]
        : [],
    );
    const listed = new Set(steers.map((steer) => steer.groupId));
    for (const groupId of this.#takenSteerGroups)
      if (!listed.has(groupId)) this.#takenSteerGroups.delete(groupId);
    this.#messageSteers = steers;
  }

  takeMessageSteers(): readonly MessageSteer[] {
    const steers = this.#messageSteers.filter(
      (steer) => !this.#takenSteerGroups.has(steer.groupId),
    );
    for (const steer of steers) this.#takenSteerGroups.add(steer.groupId);
    return steers;
  }

  /**
   * A Message transaction queued a Run of this Context; the hint proves it,
   * so the execution loop claims without reading work state first.
   */
  noteQueuedRun(): void {
    this.#recordQueuedWork();
  }

  #recordQueuedWork(): void {
    this.#queuedWorkMark += 1;
    this.#hasQueuedRuns = true;
    this.#hasPendingWork = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("TeamHub Runtime state is closed");
  }
}

const toRuntimeInput = (
  message: Message,
  sourceKind: RuntimeInput["source_kind"],
  sourceInboxId?: string,
): RuntimeInput => ({
  input_id: message.messageId,
  payload: message as unknown as Record<string, unknown>,
  source_kind: sourceKind,
  source_message_id: message.messageId,
  ...(sourceInboxId ? { source_inbox_id: sourceInboxId } : {}),
});

const toMessage = (payload: Record<string, unknown>): Message => {
  if (typeof payload.messageId !== "string") {
    throw new Error("TeamHub Runtime input payload is not a Message");
  }
  // Canonical authority only: body, references, and identities come from the
  // durable payload. The executor's input preparation renders the text with the
  // feature contributions, inside the execution failure boundary.
  return acceptedNotificationInput(payload);
};

const asNonEmpty = <T>(values: readonly T[]): NonEmptyReadonlyArray<T> => {
  const first = values[0];
  if (first === undefined) throw new Error("Expected a non-empty collection");
  return [first, ...values.slice(1)];
};

const parsePositiveInt64 = (value: string, field: string): string => {
  if (!/^[1-9][0-9]*$/.test(value))
    throw new TypeError(`${field} must be a positive decimal string`);
  return value;
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const isTransientTerminalFailure = (error: unknown): boolean =>
  error instanceof TeamHubRuntimeStateError &&
  error.retryable &&
  (error.status === null || error.status >= 500);

const isRuntimeStateConflict = (error: unknown): boolean =>
  error instanceof TeamHubRuntimeStateError &&
  error.status === 409 &&
  error.code === "AGENT_RUNTIME_CONFLICT";

const waitForTerminalRetry = (
  delayMs: number,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });

/** Earliest TeamHub `created_at` (epoch ms) among a claimed Run's inputs. */
export function earliestInputReceivedAtMs(
  inputs: readonly { readonly created_at?: string }[],
): number | undefined {
  let earliest: number | undefined;
  for (const input of inputs) {
    const at =
      input.created_at === undefined
        ? Number.NaN
        : Date.parse(input.created_at);
    if (Number.isFinite(at) && (earliest === undefined || at < earliest))
      earliest = at;
  }
  return earliest;
}
