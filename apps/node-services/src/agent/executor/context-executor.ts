import { randomUUID } from "node:crypto";
import {
  isLocalComputerOfflineError,
  LocalComputerModelError,
} from "../runner-gateway/local-computer-management.js";
import { LOCAL_COMPUTER_IDLE_TIMEOUT_MS } from "../runner-gateway/local-computer-management.js";
import {
  claimAgentFailureAlert,
  createAgentLogger,
  type AgentLogger,
} from "../observability/agent-log.js";
import type { ComposedContextFeatures } from "../agent-features/compose.js";
import type { BuiltinAgentFeatures } from "../agent-features/builtin.js";
import type { RunWakeKind } from "../agent-features/inbox-source/types.js";
import { TOOL_APPROVAL_FEATURE_ID } from "../agent-features/tool-approval/index.js";
import { inboxInputFact } from "../agent-features/inbox-source/accepted-fact.js";
import type {
  ContextBootstrap,
  FeatureSubmitOptions,
  FeatureSubmitResult,
  MaintenanceAction,
  MaintenanceOutcome,
  MaintenanceSkipReason,
  MaintenanceTrigger,
} from "../agent-features/contracts.js";
import { renderAcceptedNotification } from "../prompt/accepted-notification.js";
import {
  type ActivatedContextRuntime,
  type ContextRuntimeActivator,
  ContextRuntimeCleanupError,
  isUnconfirmedContextRuntimeCleanup,
} from "./activation.js";
import {
  AgentManagerError,
  isActivationPending,
  type ExecutionContextMessageDelivery,
} from "./agent-manager-api.js";
import {
  composeExecutorFeatures,
  instructedAgent,
} from "./context-features.js";
import {
  encodeExecutionContextRef,
  type ContextTargetResidency,
  type ExecutionContextRecord,
  type ExecutionContextRef,
} from "./context-ref.js";
import type {
  ContextRuntimeStatePort,
  MessageSteer,
} from "./context-runtime-state.js";
import type { ExecutorHost } from "./executor-host.js";
import type { Ghost } from "./ghost.js";
import {
  type RuntimeHistoryInspection,
  type RuntimeHistoryOptions,
  unavailableRuntimeHistory,
} from "./history.js";
import { ContextAdmission } from "./lifecycle-coordinator.js";
import {
  ProviderSessionInspectionError,
  runtimeSessionAwaitsFirstRun,
  type RuntimeExecutionFailure,
  type RuntimeSession,
} from "./provider.js";
import {
  RunLoop,
  type CompactSessionOptions,
  type CompactSessionResult,
} from "./run-loop.js";
import type { RuntimeStatusPublisher } from "./runtime-status.js";
import type {
  ActorId,
  AgentDefinition,
  AgentManagerStatus,
  ContextActivity,
  IdleSuspendResult,
  LocalTurnObservation,
  LocalTurnTerminal,
  Message,
  NonEmptyReadonlyArray,
  ResolvedAgentIdentity,
  RunCancellationStatus,
} from "./types.js";

export type ContextRuntimeStateFactory<TRuntimeSettings> = (input: {
  readonly ref: ExecutionContextRef;
  readonly configurationRevision: string;
  readonly runtime: TRuntimeSettings;
}) => Promise<ContextRuntimeStatePort>;

/** A read of a Context's persisted native History without its Runtime. */
export interface RuntimeHistoryInspectionRequest<TRuntimeSettings> {
  readonly ref: ExecutionContextRef;
  readonly runtime: TRuntimeSettings;
  readonly session: RuntimeSession;
  readonly options: RuntimeHistoryOptions;
}

/** Process-wide services every Context executor runs its Runtime with. */
export interface ExecutorServices<TRuntimeSettings> {
  readonly activator: ContextRuntimeActivator<TRuntimeSettings>;
  readonly stateFactory: ContextRuntimeStateFactory<TRuntimeSettings>;
  readonly statusPublisher?: RuntimeStatusPublisher;
  /** Reads persisted Runtime History while no Runtime is active. */
  readonly inspectPersistedHistory?: (
    request: RuntimeHistoryInspectionRequest<TRuntimeSettings>,
  ) => Promise<RuntimeHistoryInspection>;
}

export type PreparationSource =
  | "room_preparation"
  | "room_presence"
  | "restart_restore";

export interface ContextExecutorOptions<TRuntimeSettings> {
  readonly host: ExecutorHost<
    ContextExecutor<TRuntimeSettings>,
    TRuntimeSettings
  >;
  readonly services: ExecutorServices<TRuntimeSettings>;
  readonly features: Pick<BuiltinAgentFeatures, "composeContext">;
  readonly record: ExecutionContextRecord;
  readonly bootstrap: ContextBootstrap;
  readonly ghost: Readonly<Ghost<TRuntimeSettings>> & {
    readonly actorId: ActorId;
  };
  readonly identity: ResolvedAgentIdentity;
  /** The registry's logger of this Context. */
  readonly logger: AgentLogger;
}

const UNUSED_CONTEXT_PREPARATION_IDLE_MS = 30_000;
// Native compaction normally takes seconds; this only bounds a stuck Runtime.
const SESSION_COMPACTION_TIMEOUT_MS = 10 * 60_000;

/**
 * One Context instance: its residency and lifecycle transitions, its
 * serialized input admission, its composed features, and the Runtime it
 * activates with its Run loop. A configuration or Runtime change replaces
 * the whole instance; state that outlives an instance stays in the registry
 * behind {@link ExecutorHost}.
 */
export class ContextExecutor<TRuntimeSettings> {
  readonly ref: Readonly<ExecutionContextRef>;
  readonly key: string;
  /** The record this instance was created from. */
  readonly record: ExecutionContextRecord;
  readonly configurationRevision: string;
  /** The Ghost's Runtime revision this instance's Runtime was created for. */
  readonly runtimeRevision: string;
  readonly identity: ResolvedAgentIdentity;
  readonly runtime: Readonly<TRuntimeSettings>;

  readonly #host: ExecutorHost<
    ContextExecutor<TRuntimeSettings>,
    TRuntimeSettings
  >;
  readonly #services: ExecutorServices<TRuntimeSettings>;
  readonly #ghost: ContextExecutorOptions<TRuntimeSettings>["ghost"];
  readonly #bootstrap: ContextBootstrap;
  readonly #contextLogger: AgentLogger;
  readonly #featureLogger: AgentLogger;
  readonly #composeFeatures: Pick<BuiltinAgentFeatures, "composeContext">;

  // Residency and lifecycle transitions.
  #status: AgentManagerStatus;
  #targetResidency: ContextTargetResidency;
  #transitionTail: Promise<void> = Promise.resolve();
  readonly #activeTransitions = new Map<"activate", Promise<void>>();
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Set while the Context was activated without input and no input used it yet.
  #preparation: { source: PreparationSource; atMs: number } | null = null;
  #idleSuspendFailure: { attempts: number; retryAtMs: number | null } | null =
    null;
  // Store revisions may classify this failure, but must not repeat activation.
  #automaticActivationFailure: { readonly error: unknown } | null = null;

  // Features and admission. The admission boundary exists before the sources
  // bind, so a source delivery during binding already linearizes; before
  // publication the instance is valid only while it is bound. `#ready`
  // resolves at publication and rejects on a failed bind, so a delivery
  // admitted during binding defers its activation kick without blocking the
  // source's delivery return.
  readonly #featureScope = new AbortController();
  readonly #admission = new ContextAdmission();
  #features: ComposedContextFeatures | null = null;
  #bound = false;
  #published = false;
  readonly #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: unknown) => void;
  #forwardTurnTerminals = true;

  // The Runtime.
  #runtimeLogger: AgentLogger = createAgentLogger({ component: "shell" });
  #runtimeAgent: AgentDefinition | null = null;
  #state: ContextRuntimeStatePort | null = null;
  #activatedRuntime: ActivatedContextRuntime | null = null;
  #execution: RunLoop | null = null;
  #activationPromise: Promise<void> | null = null;
  #activationCleanupFailure: ContextRuntimeCleanupError | null = null;
  #activationAbortController: AbortController | null = null;
  #activationAborted = false;
  #deactivationPromise: Promise<boolean> | null = null;
  #runtimeRecoveryPromise: Promise<void> | null = null;
  #desiredRuntimeState: "active" | "suspended" | "stopped" = "suspended";
  #providerReady = false;
  #activationFinishedAtMs: number | undefined;
  #idleSince: number | null = null;
  #reportedActivity: ContextActivity | null = null;
  #stopped = false;
  readonly #lifecycleController = new AbortController();
  #stopCompleted = false;
  #stopPromise: Promise<void> | null = null;
  #permanentDeletionPromise: Promise<void> | null = null;
  #steerRead: Promise<void> | null = null;
  #steerReadAgain = false;

  constructor(options: ContextExecutorOptions<TRuntimeSettings>) {
    const { record, ghost } = options;
    this.ref = Object.freeze({ ...record.ref });
    this.key = encodeExecutionContextRef(record.ref);
    this.record = record;
    this.configurationRevision = ghost.revision;
    this.runtimeRevision = ghost.runtimeRevision ?? ghost.revision;
    this.identity = options.identity;
    this.runtime = ghost.runtime;
    this.#host = options.host;
    this.#services = options.services;
    this.#ghost = ghost;
    this.#bootstrap = options.bootstrap;
    this.#contextLogger = options.logger;
    this.#featureLogger = options.logger.child({ tenantId: ghost.tenantId });
    this.#composeFeatures = options.features;
    this.#targetResidency = record.targetResidency;
    this.#status =
      record.targetResidency === "suspended" && options.bootstrap !== "new"
        ? "suspended"
        : "created";
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // A failed bind rejects every queued activation intent; with no delivery
    // the rejection must still not surface as an unhandled rejection.
    void this.#ready.catch(() => undefined);
  }

  get status(): AgentManagerStatus {
    return this.#status;
  }

  get targetResidency(): ContextTargetResidency {
    return this.#targetResidency;
  }

  get preparation(): {
    readonly source: PreparationSource;
    readonly atMs: number;
  } | null {
    return this.#preparation;
  }

  get hasActiveTransitions(): boolean {
    return this.#activeTransitions.size > 0;
  }

  get activationInFlight(): boolean {
    return this.#activeTransitions.has("activate");
  }

  get automaticActivationFailure(): { readonly error: unknown } | null {
    return this.#automaticActivationFailure;
  }

  clearAutomaticActivationFailure(): void {
    this.#automaticActivationFailure = null;
  }

  /** Resolves at publication; rejects when the bind failed. */
  get ready(): Promise<void> {
    return this.#ready;
  }

  get features(): ComposedContextFeatures {
    if (!this.#features) throw new Error("Context features are not composed");
    return this.#features;
  }

  /**
   * Composes the features and opens the Runtime state. On failure the
   * caller abandons the instance.
   */
  async open(): Promise<void> {
    const composed = composeExecutorFeatures({
      record: this.record,
      ghost: this.#ghost,
      identity: this.identity,
      binding: {
        signal: this.#featureScope.signal,
        isBound: () => this.#bound,
        activeRunId: () => this.activeRunId() ?? undefined,
        steer: (runId, message, options) =>
          this.#featureSteer(runId, message, options),
        followUp: (message, options) => this.#featureFollowUp(message, options),
        // Bound, not wrapped: the wake reaches the claim with no forwarding
        // frame between the feature host and the executor.
        takeUpQueuedInput: this.takeUpQueuedInput.bind(this),
        onTimer: (name) => {
          this.features.onTimer(name);
          this.#host.trackBackground(
            this.runMaintenance({ kind: "timer", name }),
            this.ref,
            "maintenance.timer_failed",
          );
        },
        trackBackground: (operation, ref, event, fields) =>
          this.#host.trackBackground(operation, ref, event, fields),
      },
      features: this.#composeFeatures,
      logger: this.#featureLogger,
    });
    this.#features = composed;
    // Each activation renders the instructions again with the facts it
    // reads; until one does, they are the full version with the connected
    // app commands.
    this.#runtimeAgent = Object.freeze(
      snapshotConfiguration(
        instructedAgent(composed, this.#ghost.agent, this.record, {
          connectedApps: true,
          compactInstructions: false,
        }),
      ),
    );
    this.#runtimeLogger = this.#runtimeLogger.child({
      agentId: this.ref.agentId,
      agentName: this.#runtimeAgent.name,
      contextKey: this.key,
      contextKind: this.ref.kind,
    });
    this.#state = await this.#services.stateFactory({
      ref: this.ref,
      configurationRevision: this.configurationRevision,
      runtime: this.runtime,
    });
    // Logging must not add a remote authorization read.
    this.#log("info", "shell.created");
  }

  /**
   * Binds the feature sources while the instance is still unpublished:
   * immediate host callbacks resolve through this bound instance, and the
   * registry publishes it only after binding completes, so a half-wired
   * Context is never observable as ready. A source delivery during binding
   * still commits durably through the already-live admission boundary.
   */
  async bindSources(): Promise<void> {
    this.#bound = true;
    await this.features.bindSources({ bootstrap: this.#bootstrap });
  }

  /**
   * Publication completes the boundary: queued activation intents may now
   * run, and later admissions validate through registry ownership only.
   */
  publish(): void {
    this.#published = true;
    this.#resolveReady();
  }

  /**
   * Cleans up a creation that failed before publication. Serialized
   * invalidation converges an in-flight bind-time delivery's durable commit
   * first; only then may the instance lose its binding and cleanup start.
   * Returns the cleanup failures.
   */
  async abandon(error: unknown): Promise<unknown[]> {
    const cleanupErrors: unknown[] = [];
    try {
      await this.#admission.run(() => {
        this.#bound = false;
        this.#featureScope.abort();
        this.#rejectReady(error);
      });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await this.#features?.release();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await this.stop();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    // Terminal forwarding stays live while the Runtime drains; stop it last.
    this.stopForwardingTurnTerminals();
    return cleanupErrors;
  }

  /** Later Run terminals no longer reach the features. */
  stopForwardingTurnTerminals(): void {
    this.#forwardTurnTerminals = false;
  }

  // ---------------------------------------------------------------------
  // Input admission

  /**
   * Final instance check inside the serialized admission boundary. Before
   * publication the instance counts only while bound; afterwards only
   * registry ownership counts. A superseded or stopped instance reports
   * "context_replaced"; an invalidated still-owned one reports
   * "context_released".
   */
  admissionFailure(): "context_released" | "context_replaced" | null {
    const owned = this.#host.owns(this) || (!this.#published && this.#bound);
    if (!owned || this.#status === "stopped") return "context_replaced";
    if (this.#featureScope.signal.aborted) return "context_released";
    return null;
  }

  /** Accepts a trusted turn; the caller requests activation afterwards. */
  async acceptTrustedTurn(
    messages: ExecutionContextMessageDelivery["messages"],
  ): Promise<string> {
    const { runId } = await this.#acceptCurrentInput(async () => {
      const accepted = await this.submitTrustedTurn(snapshotMessages(messages));
      this.usePreparedContext();
      return accepted;
    });
    return runId;
  }

  /** Steers a trusted message into the active Run; null when there is none. */
  steerActiveTurn(message: Message): Promise<string | null> {
    return this.#admission.run(async () => {
      if (this.#host.isTerminal(this.ref) || this.admissionFailure() !== null)
        return null;
      const runId = this.activeRunId();
      if (!runId) return null;
      try {
        await this.acceptTrustedNotification(runId, snapshotMessage(message));
      } catch (error) {
        // The turn ended or was fenced while steering; the caller queues.
        this.#contextLogger.log("info", "trusted_steer.not_steerable", {
          error,
          runId,
        });
        return null;
      }
      return runId;
    });
  }

  async #acceptCurrentInput<T>(
    accept: () => Promise<T>,
    gate?: () => boolean,
  ): Promise<T> {
    // Cold and unused prepared Contexts may have a superseded profile.
    // Once input adopts a Runtime, retain its accepted configuration and work.
    // Readiness preparation may await remote authority, so it stays outside
    // the admission boundary; everything after it is serialized.
    if (this.#status !== "active" || this.#preparation !== null) {
      await this.#host.withConfigTiming(this.ref, "preaccept", () =>
        this.#host.assertActivationReady(
          this.ref.agentId,
          this.configurationRevision,
        ),
      );
    }
    this.#host.assertAgentAvailable(this.ref.agentId);
    return this.#admission.run(() => {
      if (this.#host.isTerminal(this.ref))
        throw new TerminalExecutionContextError(this.ref);
      // Ownership rechecked at the durable-acceptance fence: an admission
      // already inside linearizes before a later-queued invalidation, so a
      // replaced, released, or stopped instance can never accept after the
      // fact.
      if (this.admissionFailure() !== null) {
        throw new AgentManagerError(
          "agent_revision_conflict",
          "Execution Context was replaced before input acceptance; retry with its current configuration",
        );
      }
      // Feature submissions evaluate their validity check at this same final
      // boundary so nothing accepted during the wait can slip through.
      if (gate && !gate()) throw new FeatureSubmissionSkippedError();
      return accept();
    });
  }

  /**
   * Feature-owned steer into the Run of this instance. The final boundary
   * rechecks the instance, its active Run, and the feature's canSubmit after
   * all waits; a replaced or invalidated instance resolves as skipped
   * instead of reaching a same-ref successor.
   */
  #featureSteer(
    runId: string,
    message: Message,
    options?: FeatureSubmitOptions,
  ): Promise<FeatureSubmitResult> {
    return this.#host.duringOpen(async () => {
      if (!this.#bound || this.#featureScope.signal.aborted)
        return { status: "skipped", reason: "context_released" };
      return this.#admission.run(async () => {
        // Terminal tombstone checked before instance/run/canSubmit, matching
        // the durable-acceptance fence in #acceptCurrentInput.
        if (this.#host.isTerminal(this.ref))
          return { status: "skipped" as const, reason: "context_terminal" };
        const failure = this.admissionFailure();
        if (failure) return { status: "skipped" as const, reason: failure };
        if (this.activeRunId() !== runId)
          return { status: "skipped" as const, reason: "run_inactive" };
        if (options?.canSubmit && !options.canSubmit())
          return { status: "skipped" as const, reason: "stale" };
        const result = await this.acceptTrustedNotification(runId, message);
        return {
          status:
            result === "already_accepted" ? "already_accepted" : "accepted",
        } as const;
      });
    });
  }

  /**
   * Feature-owned trusted follow-up turn on this instance. The instance
   * check and canSubmit gate run at the final durable-acceptance boundary.
   */
  #featureFollowUp(
    message: Message,
    options?: FeatureSubmitOptions,
  ): Promise<FeatureSubmitResult> {
    return this.#host.duringOpen(async () => {
      if (!this.#bound || this.#featureScope.signal.aborted)
        return { status: "skipped", reason: "context_released" };
      try {
        await this.#acceptCurrentInput(async () => {
          const accepted = await this.submitTrustedTurn([message]);
          this.usePreparedContext();
          return accepted;
        }, options?.canSubmit);
      } catch (error) {
        if (error instanceof FeatureSubmissionSkippedError)
          return { status: "skipped", reason: "stale" };
        if (
          error instanceof AgentManagerError &&
          error.code === "agent_revision_conflict"
        )
          return {
            status: "skipped",
            reason: this.admissionFailure() ?? "context_replaced",
          };
        if (error instanceof TerminalExecutionContextError)
          return { status: "skipped", reason: "context_terminal" };
        throw error;
      }
      this.trackTransition(
        this.#ready.then(() => this.requestActive("trusted_turn")),
        "activation.after_trusted_turn_failed",
      );
      return { status: "accepted" };
    });
  }

  /**
   * Serialized invalidation of this instance's admission boundary: it
   * linearizes after every already-queued admission's durable commit, so a
   * stop path can never abort a committed fact mid-flight, and every
   * later-queued submission resolves skipped instead of accepting.
   */
  invalidateAdmission(): Promise<void> {
    return this.#admission.run(() => {
      this.#featureScope.abort();
    });
  }

  /**
   * Invalidates the admission when the check still holds inside the
   * boundary; resolves whether it did.
   */
  invalidateAdmissionIf(check: () => boolean): Promise<boolean> {
    return this.#admission.run(() => {
      if (!check()) return false;
      this.#featureScope.abort();
      return true;
    });
  }

  /**
   * Context disposal: invalidate the FeatureContext first so in-flight
   * feature submissions resolve as skipped, then stop bound sources in
   * reverse order.
   */
  async releaseFeatures(): Promise<void> {
    await this.invalidateAdmission();
    await this.features.release();
  }

  /**
   * Stop-path teardown shared by every owner: the serialized invalidation
   * must converge before any Runtime stop starts; afterwards source release
   * and the Runtime stop clean disjoint resources, so a failure in one never
   * skips the other.
   */
  async invalidateAndStop(stop: () => Promise<void>): Promise<unknown[]> {
    const failures: unknown[] = [];
    try {
      await this.invalidateAdmission();
    } catch (error) {
      failures.push(error);
    }
    const cleanup = await Promise.allSettled([
      invokeClose(() => this.features.release()),
      invokeClose(stop),
    ]);
    for (const result of cleanup) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    return failures;
  }

  // ---------------------------------------------------------------------
  // Queued input

  /**
   * TeamHub queued Inbox input for this Context. A ready Runtime claims it
   * at once; otherwise activation goes through the registry's lifecycle
   * queue, and the activated Runtime reads its work.
   */
  async takeUpQueuedInput(kind: RunWakeKind): Promise<void> {
    // An unused preparation takes the slow path, which re-reads the Agent's
    // configuration once: a profile edit does not notify Agent Service, and
    // TeamHub accepts the first Session only at the revision its Run was
    // claimed under, so the first Run must not adopt an older preparation.
    if (
      this.#isReadyForQueuedInput() &&
      this.#preparation === null &&
      !(await this.#host.isSuperseded(this))
    ) {
      this.notifyQueuedInput(kind);
      return;
    }
    await this.#ready;
    await this.#host.takeUpQueuedInputSlow(this, kind);
  }

  #isReadyForQueuedInput(): boolean {
    return (
      this.#status === "active" &&
      this.isRuntimeReady() &&
      this.#targetResidency === "active"
    );
  }

  // ---------------------------------------------------------------------
  // Residency transitions

  /** Marks an activation without input; real input adopts it. */
  markPreparation(source: PreparationSource): void {
    this.#preparation = { source, atMs: Date.now() };
  }

  /** Whether a configuration refresh may replace this instance now. */
  canRefreshConfiguration(): boolean {
    return (
      this.#status === "suspended" ||
      this.#status === "created" ||
      (this.#status === "active" &&
        this.#preparation !== null &&
        !this.isBusy())
    );
  }

  requestActive(reason: string, persistTarget = true): Promise<void> {
    const requestedAt = performance.now();
    if (
      reason === "trusted_turn" ||
      reason === "start" ||
      reason === "resume" ||
      reason === "queued_input"
    ) {
      this.usePreparedContext();
    }
    this.#host.clearLazyRestore(this.ref);
    // Management refresh and recovery are not input. Preserve an unused
    // preparation's existing expiry instead of restarting its 30-second clock.
    if (this.#preparation === null) this.clearIdleTimer();
    this.#targetResidency = "active";
    const activationKey = "activate";
    const current = this.#activeTransitions.get(activationKey);
    if (current) return current;
    const operation = this.#appendTransition(async () => {
      const transitionStartedAt = performance.now();
      if (persistTarget) {
        await this.#host.persistTargetResidency(this.ref, "active");
      }
      if (this.#status === "active" && this.isRuntimeReady()) {
        this.#automaticActivationFailure = null;
        this.scheduleIdleTimer();
        return;
      }
      if (this.#status === "stopped") {
        throw new AgentManagerError(
          "invalid_state",
          `Execution Context ${this.key} has been stopped`,
        );
      }

      const activationCheckStartedAt = performance.now();
      await this.#host.checkActivationOrDefer(this);
      const activationCheckedAt = performance.now();
      const fallback = this.#status;
      this.#status = "starting";
      const logger = this.#contextLogger;
      logger.log("info", "activation.started", {
        reason,
        fallback,
        transitionWaitMs: Math.round(transitionStartedAt - requestedAt),
        activationCheckMs: Math.round(
          activationCheckedAt - activationCheckStartedAt,
        ),
      });
      try {
        await this.start();
        this.#status = "active";
        this.#idleSuspendFailure = null;
        this.#automaticActivationFailure = null;
        logger.log("info", "activation.completed", { reason });
        this.notifyWorkAvailable();
        this.scheduleIdleTimer();
      } catch (error) {
        this.#automaticActivationFailure = { error };
        this.#status = fallback;
        if (isActivationPending(error)) {
          // Runtime activation already released its resources. Retry via
          // the lifecycle queue after this shared Context operation exits.
          // This rethrows after restore_deferred; a temporary configuration
          // fence intentionally skips activation.failed and its failure alert.
          await this.#host.checkActivationOrDefer(this, error);
        }
        if (
          this.#host.shouldSuspendRestoreFailure(this.ref, this.runtime, error)
        ) {
          await this.#host.checkActivationOrDefer(this);
        }
        if (
          ["trusted_turn", "start", "resume", "queued_input"].includes(
            reason,
          ) &&
          this.#host.isRecoverableRestoreFailure(this.ref, this.runtime, error)
        ) {
          await this.#host.retryActivationLater(this, error);
        }
        const computerOffline = isLocalComputerOfflineError(error);
        const ownsFailureAlert = computerOffline
          ? false
          : claimAgentFailureAlert(error);
        logger.log(
          computerOffline ? "info" : ownsFailureAlert ? "error" : "warn",
          computerOffline
            ? "activation.waiting_for_computer"
            : "activation.failed",
          {
            reason,
            error,
            ...(computerOffline
              ? {}
              : ownsFailureAlert
                ? {}
                : { alertAggregated: true }),
          },
        );
        throw error;
      }
    });
    const promise = operation.finally(() => {
      if (this.#activeTransitions.get(activationKey) === promise) {
        this.#activeTransitions.delete(activationKey);
      }
    });
    this.#activeTransitions.set(activationKey, promise);
    return promise;
  }

  requestSuspend(persistTarget = true): Promise<void> {
    this.#preparation = null;
    this.clearIdleTimer();
    this.#targetResidency = "suspended";
    return this.#appendTransition(async () => {
      if (persistTarget) {
        await this.#host.persistTargetResidency(this.ref, "suspended");
      }
      if (this.#status === "suspended") {
        this.#automaticActivationFailure = null;
        return;
      }
      if (this.#status === "stopped") {
        throw new AgentManagerError(
          "invalid_state",
          `Execution Context ${this.key} has been stopped`,
        );
      }
      await this.suspend();
      this.#status = "suspended";
      this.#idleSuspendFailure = null;
      this.#automaticActivationFailure = null;
    });
  }

  requestStop(): Promise<void> {
    this.clearIdleTimer();
    return this.#appendTransition(async () => {
      if (this.#status === "stopped") return;
      await this.stop();
      this.#status = "stopped";
    });
  }

  requestPermanentStop(): Promise<void> {
    this.clearIdleTimer();
    // Abort a blocked activation first so the queued permanent stop is not
    // held behind it for the full activation deadline.
    this.abortActivation(
      new Error("Execution Context is being permanently stopped"),
    );
    return this.#appendTransition(async () => {
      await this.#deletePermanent();
      this.#status = "stopped";
    });
  }

  /**
   * Shutdown stop: waits for the queued transitions and stops the Runtime
   * within the remaining Run grace period. The process restarts, so a Run
   * still active then goes back to the queue and resumes in the next
   * process instead of ending canceled.
   */
  async stopForShutdown(
    stop: (operation: () => Promise<void>) => Promise<void>,
    gracePeriodMs: () => number,
  ): Promise<void> {
    await Promise.all([
      this.#transitionTail.catch(() => undefined),
      stop(() =>
        this.stop({ gracePeriodMs: gracePeriodMs(), resumeActiveRun: true }),
      ),
    ]);
    this.#status = "stopped";
  }

  #appendTransition(operation: () => Promise<void>): Promise<void> {
    const transition = this.#transitionTail
      .catch(() => undefined)
      .then(operation);
    this.#transitionTail = transition;
    return transition;
  }

  trackTransition(
    transition: Promise<void>,
    event: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    this.#host.trackBackground(transition, this.ref, event, fields);
  }

  // ---------------------------------------------------------------------
  // Maintenance

  /**
   * Feature timer entry: ask the Context's features for a maintenance action
   * and run it. A suspended Context is activated without persisting an
   * active target and suspended again afterwards; an offline Computer is
   * skipped rather than waited for.
   */
  runMaintenance(trigger: MaintenanceTrigger): Promise<void> {
    return this.#host.runContext(this.ref, async () => {
      if (
        this.#host.isClosing() ||
        !this.#host.holds(this) ||
        this.#featureScope.signal.aborted
      )
        return;
      const action = this.features.decideMaintenance(trigger);
      if (!action) return;
      const wasActive =
        this.#targetResidency === "active" && this.#status === "active";
      if (!wasActive) {
        if (!this.#host.canRunMaintenance(this.runtime)) {
          this.#finishSkippedMaintenance(trigger, action, "unavailable");
          return;
        }
        try {
          await this.requestActive("maintenance", false);
        } catch (error) {
          // The in-memory target must not stay active for a failed wake.
          if (this.#status !== "active")
            await this.requestSuspend().catch(() => undefined);
          throw error;
        }
      }
      await this.#appendTransition(async () => {
        await this.#executeMaintenance(trigger, action);
      });
      // A Context woken only for maintenance goes back to sleep; input that
      // arrived meanwhile keeps it active through its own activation request.
      if (
        !wasActive &&
        this.#host.owns(this) &&
        !this.isBusy() &&
        !this.#activeTransitions.has("activate")
      )
        await this.requestSuspend();
    });
  }

  /**
   * Runs one maintenance action on the active Runtime. Never throws: every
   * outcome, including a skip, is reported to the features' onMaintenance.
   */
  async #executeMaintenance(
    trigger: MaintenanceTrigger,
    action: MaintenanceAction,
  ): Promise<MaintenanceOutcome> {
    const features = this.features;
    const finish = (outcome: MaintenanceOutcome): MaintenanceOutcome => {
      features.onMaintenance({
        phase: "finished",
        trigger,
        action,
        outcome,
      });
      this.#contextLogger.log(
        outcome.status === "failed" ? "warn" : "info",
        "maintenance.finished",
        {
          trigger: trigger.kind,
          action: action.kind,
          reason: action.reason,
          status: outcome.status,
          ...(outcome.status === "skipped" ? { skipped: outcome.reason } : {}),
          ...(outcome.status === "failed" ? { error: outcome.error } : {}),
        },
      );
      return outcome;
    };
    if (this.#status !== "active" || this.isBusy())
      return finish({ status: "skipped", reason: "busy" });
    features.onMaintenance({ phase: "started", trigger, action });
    try {
      const result = await this.compactSession({
        ...(action.instructions ? { instructions: action.instructions } : {}),
        signal: AbortSignal.any([
          this.#featureScope.signal,
          AbortSignal.timeout(SESSION_COMPACTION_TIMEOUT_MS),
        ]),
      });
      return finish(
        result.status === "compacted"
          ? { status: "completed" }
          : {
              status: "skipped",
              reason:
                result.status === "unsupported" ? "unavailable" : result.status,
            },
      );
    } catch (error) {
      return finish({ status: "failed", error });
    }
  }

  #finishSkippedMaintenance(
    trigger: MaintenanceTrigger,
    action: MaintenanceAction,
    reason: MaintenanceSkipReason,
  ): void {
    this.features.onMaintenance({
      phase: "finished",
      trigger,
      action,
      outcome: { status: "skipped", reason },
    });
    this.#contextLogger.log("info", "maintenance.finished", {
      trigger: trigger.kind,
      action: action.kind,
      reason: action.reason,
      status: "skipped",
      skipped: reason,
    });
  }

  // ---------------------------------------------------------------------
  // Idle suspend

  #onActivityChanged(activity: ContextActivity): void {
    if (!this.#host.owns(this) || this.#status === "stopped") return;
    if (this.activeRunId()) this.usePreparedContext();
    if (activity === "busy") {
      this.clearIdleTimer();
      return;
    }
    this.scheduleIdleTimer();
  }

  #isLazyRestoreIdle(): boolean {
    // A lazily restored active Context has no Runtime yet but follows the same idle policy.
    return (
      this.#host.hasLazyRestore(this.ref) &&
      this.#status === "created" &&
      this.#targetResidency === "active"
    );
  }

  scheduleIdleTimer(delayMs = this.#idleTimeout()): void {
    if (
      this.#host.isClosing() ||
      this.#host.isDeletingAgent(this.ref.agentId) ||
      this.#idleTimer ||
      this.#idleSuspendFailure?.retryAtMs === null ||
      this.#targetResidency !== "active" ||
      (this.#status !== "active" && !this.#isLazyRestoreIdle())
    ) {
      return;
    }
    const timer = setTimeout(
      () => {
        if (this.#idleTimer === timer) {
          this.#idleTimer = null;
        }
        this.#host.trackBackground(
          this.#attemptIdleSuspend(),
          this.ref,
          "idle_suspend.failed",
        );
      },
      Math.max(
        0,
        this.#idleSuspendFailure?.retryAtMs !== undefined
          ? this.#idleSuspendFailure.retryAtMs - Date.now()
          : delayMs,
      ),
    );
    this.#idleTimer = timer;
  }

  clearIdleTimer(): void {
    if (!this.#idleTimer) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  /**
   * A presence hint keeps an idle Runtime warm for another idle window, so a
   * person still in the Room does not wait for a cold start.
   */
  renewIdleWindow(): void {
    if (!this.#idleTimer) return;
    this.clearIdleTimer();
    this.scheduleIdleTimer();
  }

  #attemptIdleSuspend(): Promise<void> {
    return this.#appendTransition(async () => {
      const idleTimeoutMs = this.#idleTimeout();
      if (this.#isLazyRestoreIdle()) {
        if (!this.#host.holds(this)) return;
        if (this.isBusy()) {
          this.scheduleIdleTimer();
          return;
        }
        // No Runtime was started, so the Runtime is not called; a later
        // activation sees the fallback "suspended" status and resumes.
        this.#host.clearLazyRestore(this.ref);
        this.#status = "suspended";
        this.#contextLogger.log("info", "idle_suspend.lazy_restore_suspended");
        await this.#commitIdleSuspend();
        return;
      }
      if (
        !this.#host.holds(this) ||
        this.#targetResidency !== "active" ||
        this.#status !== "active" ||
        this.isBusy()
      ) {
        return;
      }
      const previousFailure = this.#idleSuspendFailure;
      if (previousFailure?.retryAtMs === null) return;
      // Maintenance runs once per idle window, before the first suspend
      // attempt; a cleanup retry is not a new window.
      if (!previousFailure) {
        const trigger = { kind: "idle_suspend" } as const;
        const action = this.features.decideMaintenance(trigger);
        if (action) {
          await this.#executeMaintenance(trigger, action);
          if (
            !this.#host.holds(this) ||
            this.#status !== "active" ||
            this.isBusy()
          )
            return;
        }
      }
      const attempt = (previousFailure?.attempts ?? 0) + 1;
      this.#contextLogger.log("info", "idle_suspend.attempt_started", {
        attempt,
        previousFailurePending: previousFailure !== null,
      });
      const wasUnusedPreparation = this.#preparation !== null;
      let result: IdleSuspendResult;
      try {
        // Failed cleanup already passed idle admission. Continue it after the
        // retry backoff; the Runtime still checks busy and pending work with zero.
        result = await this.trySuspendAfterIdle(
          previousFailure ? 0 : idleTimeoutMs,
        );
      } catch (error) {
        // Old Daemons report unavailable Registration as non-retryable generic
        // CONTEXT_VIEW_FAILED. Give that ambiguous failure a bounded new attempt;
        // explicit identity/recovery failures cannot be repaired automatically.
        const blocked = idleCleanupRequiresIntervention(error) || attempt >= 3;
        this.#idleSuspendFailure = {
          attempts: attempt,
          retryAtMs: blocked
            ? null
            : Date.now() + (attempt === 1 ? 1_000 : 5_000),
        };
        this.clearIdleTimer();
        this.#contextLogger.log("warn", "idle_suspend.attempt_failed", {
          attempt,
          error,
        });
        if (blocked) {
          this.#contextLogger.log("warn", "idle_suspend.blocked", {
            attempt,
            reason: attempt >= 3 ? "retry_exhausted" : "intervention_required",
            previousFailurePending: true,
            error,
          });
        } else {
          this.scheduleIdleTimer();
        }
        return;
      }
      // The Provider can finish an old idle transition after the Context was
      // bound again. Only its original binding may change durable residency.
      if (!this.#host.holds(this)) return;
      if (result.status === "suspended") {
        this.#idleSuspendFailure = null;
        this.#status = "suspended";
        // Input can queue activation while idle teardown awaits the Provider.
        // Preserve that intention, including a later explicit suspend, instead
        // of letting this older idle transition overwrite it.
        if (
          this.#activeTransitions.has("activate") ||
          (wasUnusedPreparation && this.#preparation === null)
        ) {
          return;
        }
        await this.#commitIdleSuspend();
        return;
      }
      if (result.retryAfterMs !== undefined) {
        if (this.#idleSuspendFailure) {
          this.#idleSuspendFailure.retryAtMs = Date.now() + result.retryAfterMs;
        }
        this.scheduleIdleTimer(result.retryAfterMs);
      }
    });
  }

  async #commitIdleSuspend(): Promise<void> {
    this.#preparation = null;
    this.#targetResidency = "suspended";
    await this.#host.persistTargetResidency(this.ref, "suspended");
    if (this.#host.holds(this)) {
      await this.#host.releaseIdleContext(this.ref);
    }
  }

  #idleTimeout(): number {
    // A restart-restored Context keeps the normal idle window.
    const preparation = this.#preparation;
    return preparation && preparation.source !== "restart_restore"
      ? UNUSED_CONTEXT_PREPARATION_IDLE_MS
      : LOCAL_COMPUTER_IDLE_TIMEOUT_MS;
  }

  usePreparedContext(): void {
    const preparation = this.#preparation;
    if (!preparation) return;
    this.#preparation = null;
    this.#contextLogger.log("info", "binding.prepared_context_adopted", {
      source: preparation.source,
      preparedForMs: Date.now() - preparation.atMs,
      activationInFlight: this.#activeTransitions.has("activate"),
    });
    this.clearIdleTimer();
    this.scheduleIdleTimer();
  }

  // ---------------------------------------------------------------------
  // Runtime

  /** Activates the Runtime, or resumes its persisted session. */
  async start(): Promise<void> {
    this.#assertNotStopped();
    this.#requireState();
    this.#desiredRuntimeState = "active";
    for (;;) {
      if (this.#runtimeRecoveryPromise) {
        await this.#runtimeRecoveryPromise;
      }
      if (this.#providerReady) return;
      if (this.#deactivationPromise) await this.#deactivationPromise;
      if (this.#activationPromise) {
        await this.#activationPromise;
        if (this.#providerReady) return;
        continue;
      }
      await this.#discardStaleRuntimeSession();
      const mode =
        (await this.#requireState().getRuntimeSession()) === null
          ? "start"
          : "resume";
      await this.#beginActivation(mode);
      return;
    }
  }

  async suspend(): Promise<void> {
    this.#assertNotStopped();
    if (!this.#providerReady) {
      this.#desiredRuntimeState = "suspended";
      this.#activationAbortController?.abort(
        new Error("Context Runtime suspension requested"),
      );
      return;
    }
    if (!this.#isIdle()) {
      throw runtimeError("busy", "Context Runtime is busy");
    }
    this.#desiredRuntimeState = "suspended";
    const suspended = await this.#deactivate({
      cancelActive: false,
      requireIdle: true,
    });
    if (!suspended) {
      this.#desiredRuntimeState = "active";
      throw runtimeError("busy", "Context Runtime became busy");
    }
  }

  async trySuspendAfterIdle(idleForMs: number): Promise<IdleSuspendResult> {
    this.#assertNotStopped();
    if (!Number.isSafeInteger(idleForMs) || idleForMs < 0) {
      throw new TypeError("idleForMs must be a non-negative safe integer");
    }
    if (!this.#providerReady || !this.#isIdle()) {
      return { status: "not_idle" };
    }
    const now = Date.now();
    this.#idleSince ??= now;
    const remaining = idleForMs - (now - this.#idleSince);
    if (remaining > 0) {
      return { status: "not_idle", retryAfterMs: remaining };
    }
    this.#desiredRuntimeState = "suspended";
    const suspended = await this.#deactivate({
      cancelActive: false,
      requireIdle: true,
    });
    if (!suspended) this.#desiredRuntimeState = "active";
    return suspended ? { status: "suspended" } : { status: "not_idle" };
  }

  isBusy(): boolean {
    return Boolean(
      this.#activationPromise ||
      this.#deactivationPromise ||
      this.#runtimeRecoveryPromise ||
      (this.#execution?.activeOperations ?? 0) > 0 ||
      this.#state?.hasPendingWork(),
    );
  }

  isRuntimeReady(): boolean {
    // Once teardown starts, committed input needs a serialized reactivation
    // even while the Provider's native cleanup has not finished yet.
    return this.#providerReady && this.#deactivationPromise === null;
  }

  activeRunId(): string | null {
    return this.#execution?.activeRunId() ?? null;
  }

  /**
   * Advisory, never throws: after a Room-presence activation, start the
   * Provider early for an active, idle Runtime with no accepted input.
   */
  prestartProviderForPresence(): void {
    const runtime = this.#activatedRuntime;
    if (
      !this.isRuntimeReady() ||
      runtime === null ||
      this.activeRunId() !== null ||
      this.#state?.acceptedInputPending?.() === true
    ) {
      return;
    }
    runtime.provider.prepareForPresence?.(runtime.runtimeSession);
  }

  /** Wakes an active Runtime after durable work arrives outside it. */
  notifyWorkAvailable(): void {
    this.#assertNotStopped();
    this.#execution?.notifyWorkAvailable();
    this.#notifyActivityChanged();
  }

  /**
   * A Message transaction queued a Run (queued) or a steer for the running
   * Run (steered) of this Context. Claims the Run without another work-state
   * read, or reads the steers and hands them to the running Run.
   */
  notifyQueuedInput(kind: RunWakeKind): void {
    this.#assertNotStopped();
    const execution = this.#execution;
    if (!execution) return;
    if (kind === "queued" && this.#state?.noteQueuedRun) {
      this.#state.noteQueuedRun();
      execution.notifyWorkAvailable({ workStateAlreadyFresh: true });
    } else if (kind === "steered") {
      // The execution loop may be busy running the Run this steer joins, so
      // read the steers now instead of waiting for its next refresh.
      this.#readMessageSteers();
    } else {
      execution.notifyWorkAvailable();
    }
    this.#notifyActivityChanged();
  }

  /**
   * Native compaction of the idle active session. No Run is claimed while it
   * runs, and durable work arriving meanwhile aborts it (history unchanged),
   * so the Context keeps reporting idle and input is never deferred for it.
   */
  async compactSession(
    options: CompactSessionOptions,
  ): Promise<CompactSessionResult> {
    this.#assertNotStopped();
    const execution = this.#execution;
    if (!execution || !this.#isIdle()) return { status: "busy" };
    const startedAt = Date.now();
    const result = await execution.compactSession(options);
    this.#log("info", "runtime.session_compaction.finished", {
      status: result.status,
      durationMs: Date.now() - startedAt,
      ...(result.status === "compacted" && result.preTokens !== undefined
        ? { preTokens: result.preTokens }
        : {}),
    });
    return result;
  }

  async inspectRuntimeHistory(
    options: RuntimeHistoryOptions,
  ): Promise<RuntimeHistoryInspection> {
    this.#assertNotStopped();
    options.signal?.throwIfAborted();
    const runtime = this.#activatedRuntime;
    const runtimeName =
      runtime?.runtimeName ?? configuredRuntimeName(this.runtime);
    const persistedInspector = this.#services.inspectPersistedHistory;
    if (!runtime?.provider.inspectHistory && !persistedInspector) {
      const reason = runtime
        ? "Runtime provider does not expose history inspection"
        : "Persisted Runtime history inspection is unavailable";
      return unavailableRuntimeHistory(
        runtimeName,
        reason,
        runtime ? "unsupported" : "unavailable",
      );
    }
    try {
      if (runtime?.provider.inspectHistory) {
        return await runtime.provider.inspectHistory(
          runtime.runtimeSession,
          options,
        );
      }
      const session = await this.#requireState().getRuntimeSession();
      if (!session) {
        return unavailableRuntimeHistory(
          runtimeName,
          "Runtime session is unavailable",
        );
      }
      return await persistedInspector!({
        ref: this.ref,
        runtime: this.runtime,
        session,
        options,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof ProviderSessionInspectionError) {
        return unavailableRuntimeHistory(
          runtimeName,
          error.message,
          error.status,
        );
      }
      // The reason the Activity log shows is deliberately generic. Without
      // this log the only record of why History failed is lost, which is how
      // a Runner-state condition ends up looking like a broken Activity log.
      this.#log("warn", "runtime.history_inspection.failed", {
        runtimeName,
        error,
      });
      return unavailableRuntimeHistory(
        runtimeName,
        "Runtime provider history inspection failed",
      );
    }
  }

  async stop(
    options: {
      readonly gracePeriodMs?: number;
      readonly resumeActiveRun?: boolean;
    } = {},
  ): Promise<void> {
    if (this.#stopCompleted) return;
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    this.#desiredRuntimeState = "stopped";
    this.#activationAbortController?.abort();
    const gracePeriodMs = options.gracePeriodMs ?? 0;
    const resumable = options.resumeActiveRun === true;
    this.#execution?.requestDrain({
      cancelActive: gracePeriodMs <= 0,
      resumable,
    });
    const stopping = (async () => {
      const failures: unknown[] = [];
      if (gracePeriodMs > 0 && this.#execution) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        this.#log("info", "runtime.shutdown.waiting", { gracePeriodMs });
        try {
          await Promise.race([
            this.#execution
              .drain({ cancelActive: false })
              .catch(() => undefined),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, gracePeriodMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      this.#lifecycleController.abort(new Error("Context Runtime stopped"));
      this.#execution?.requestDrain({ cancelActive: true, resumable });
      this.#log("info", "runtime.shutdown.cancel_remaining");
      if (this.#activationPromise) {
        await this.#activationPromise.catch((error: unknown) => {
          if (!(error instanceof ActivationCancelledError))
            failures.push(error);
        });
      }
      try {
        await this.#deactivate({ cancelActive: true, requireIdle: false });
      } catch (error) {
        failures.push(error);
      }
      if (this.#runtimeRecoveryPromise) {
        await this.#runtimeRecoveryPromise.catch((error: unknown) =>
          failures.push(error),
        );
      }
      if (
        this.#activationCleanupFailure &&
        !failures.includes(this.#activationCleanupFailure)
      )
        failures.push(this.#activationCleanupFailure);
      try {
        await this.#state?.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Context Runtime stop failed");
      }
      this.#stopCompleted = true;
      this.#log("info", "runtime.lifecycle.stopped");
    })();
    this.#stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (!this.#stopCompleted && this.#stopPromise === stopping) {
        this.#stopPromise = null;
      }
    }
  }

  // Activation owns the configuration-revision refresh. Read-only Debug
  // inspection materializes the same Context without it, so History still
  // reads the last checkpointed session after an Agent profile edit.
  async #discardStaleRuntimeSession(): Promise<void> {
    const state = this.#requireState();
    if (!state.discardStaleRuntimeSession) return;
    await state.discardStaleRuntimeSession();
  }

  /** Cancels an in-flight or later activation; a permanent stop follows. */
  abortActivation(reason: Error): void {
    // Sticky: a permanent stop follows, so an activation queued behind this
    // call must not start either.
    this.#activationAborted = true;
    this.#activationAbortController?.abort(reason);
  }

  #deletePermanent(): Promise<void> {
    if (this.#permanentDeletionPromise) return this.#permanentDeletionPromise;
    // Native Provider state lives on the owning Computer. Agent Service only
    // stops the Runtime; the Computer retires its own native files.
    const deletion = this.stop();
    this.#permanentDeletionPromise = deletion;
    void deletion.catch(() => {
      if (this.#permanentDeletionPromise === deletion) {
        this.#permanentDeletionPromise = null;
      }
    });
    return deletion;
  }

  async submitTrustedTurn(
    messages: NonEmptyReadonlyArray<Message>,
  ): Promise<{ readonly runId: string }> {
    this.#assertNotStopped();
    const runId = await this.#requireState().enqueueTrustedTurn(messages);
    this.#log("debug", "trusted_turn.persisted", {
      runId,
      messageCount: messages.length,
      messageIds: messages.map(({ messageId }) => messageId),
    });
    this.#execution?.notifyWorkAvailable();
    this.#notifyActivityChanged();
    return { runId };
  }

  async acceptTrustedNotification(
    executionRunRef: string,
    message: Message,
  ): Promise<"accepted" | "already_accepted"> {
    this.#assertNotStopped();
    const execution = this.#execution;
    if (!execution || execution.activeRunId() !== executionRunRef) {
      throw new Error(
        "Trusted notification target is not the active Local Run",
      );
    }
    const notification: Message = Object.freeze({
      ...message,
      trustedNotification: true,
    });
    const accepted = await this.#requireState().acceptTrustedNotification(
      executionRunRef,
      notification,
    );
    if (accepted.status === "already_accepted") return "already_accepted";
    // "accepted" reports the durable commit, never model consumption. The steer
    // dispatch is tracked by the execution loop's steerOperations and converges
    // through drain/stop exactly like the Inbox steer dispatch above.
    void execution
      .steer(accepted.groupId, [notification], this.#lifecycleController.signal)
      .catch((error: unknown) => {
        this.#log("warn", "trusted_notification.dispatch_failed", {
          error,
          executionRunRef,
        });
      });
    return "accepted";
  }

  async cancelTrustedTurn(
    messages: ExecutionContextMessageDelivery["messages"],
  ): Promise<{
    readonly runId: string;
    readonly status: RunCancellationStatus;
  }> {
    this.#assertNotStopped();
    const canceled = await this.#requireState().cancelTrustedTurn(
      snapshotMessages(messages),
    );
    const status =
      canceled.status === "cancel_requested" && this.#execution
        ? await this.#execution.requestCancellation(canceled.runId)
        : canceled.status;
    this.#notifyActivityChanged();
    if (status === "canceled") {
      const terminal = (await this.#requireState().getLocalRun(canceled.runId))
        ?.terminal;
      if (terminal) this.#emitTurnTerminal(canceled.runId, terminal);
    }
    return { runId: canceled.runId, status };
  }

  async observeTurn(runId: string): Promise<LocalTurnObservation | null> {
    this.#assertNotStopped();
    if (!runId.trim()) throw new TypeError("Local Run ID must not be empty");
    const run = await this.#requireState().getLocalRun(runId);
    if (!run) return null;
    return {
      runId: run.runId,
      status: run.status,
      ...(run.terminal ? { terminal: snapshotTerminal(run.terminal) } : {}),
    };
  }

  async cancelRun(runId: string): Promise<RunCancellationStatus> {
    this.#assertNotStopped();
    if (!runId.trim()) throw new TypeError("Local Run ID must not be empty");
    const status = this.#execution
      ? await this.#execution.requestCancellation(runId)
      : await this.#requireState().cancelLocalRun(runId);
    this.#notifyActivityChanged();
    if (status === "canceled") {
      const terminal = (await this.#requireState().getLocalRun(runId))
        ?.terminal;
      if (terminal) this.#emitTurnTerminal(runId, terminal);
    }
    return status;
  }

  #beginActivation(mode: "start" | "resume"): Promise<void> {
    if (this.#activationCleanupFailure)
      return Promise.reject(this.#activationCleanupFailure);
    if (this.#activationPromise) return this.#activationPromise;
    if (this.#activationAborted)
      return Promise.reject(new ActivationCancelledError());
    const abortController = new AbortController();
    this.#activationAbortController = abortController;
    const task = this.#activate(mode, abortController.signal).finally(() => {
      if (this.#activationPromise === task) this.#activationPromise = null;
      if (this.#activationAbortController === abortController) {
        this.#activationAbortController = null;
      }
      this.#notifyActivityChanged();
    });
    this.#activationPromise = task;
    this.#notifyActivityChanged();
    return task;
  }

  async #activate(
    mode: "start" | "resume",
    signal: AbortSignal,
  ): Promise<void> {
    const state = this.#requireState();
    const agent = this.#runtimeAgent!;
    const features = this.features;
    const previousSession =
      mode === "resume" ? await requirePersistedSession(state) : undefined;
    const startedAt = Date.now();
    const activationId = randomUUID();
    this.#log("info", "runtime.activation.started", {
      activationId,
      mode,
    });
    let activated: ActivatedContextRuntime | null = null;
    let initialSessionCheckpointed = false;
    try {
      // Preflight may wait for a Local Computer to reconnect.
      await this.#services.activator.preflight?.({
        ref: this.ref,
        runtime: this.runtime,
        signal,
        activationId,
      });
      if (signal.aborted || this.#stopped) throw new ActivationCancelledError();
      const executionEpoch = state.executionEpoch?.();
      const savedResources = await state.getExecutionResources?.();
      activated = await this.#services.activator.activate({
        ref: this.ref,
        ...(this.record.sharedTaskScope
          ? { sharedTaskScope: this.record.sharedTaskScope }
          : {}),
        tenantId: this.#ghost.tenantId,
        actorId: this.#ghost.actorId,
        agentType: this.identity.agentType,
        // The tool approval feature matches only where Runs review Runtime
        // permission prompts.
        ...(features.matched.includes(TOOL_APPROVAL_FEATURE_ID)
          ? { permissionReview: true as const }
          : {}),
        renderDeveloperInstructions: (facts) =>
          instructedAgent(features, this.#ghost.agent, this.record, facts)
            .developerInstructions,
        activationId,
        mode,
        ...(previousSession ? { previousSession } : {}),
        acceptedInputSinceMs: () =>
          state.acceptedInputPending?.()
            ? state.earliestAcceptedInputMs?.()
            : undefined,
        ...(executionEpoch ? { executionEpoch } : {}),
        agent,
        runtime: this.runtime,
        resources: this.#ghost.resources,
        checkpointRuntimeSession: async (session) => {
          if (runtimeSessionAwaitsFirstRun(session)) return;
          const checkpointStartedAt = Date.now();
          await state.setRuntimeSession(session);
          this.#log("info", "runtime.activation.session_checkpointed", {
            activationId,
            durationMs: Date.now() - checkpointStartedAt,
          });
        },
        signal,
      });
      if (signal.aborted || this.#stopped) throw new ActivationCancelledError();
      const activeRuntime = activated;
      if (!runtimeSessionAwaitsFirstRun(activated.runtimeSession)) {
        const checkpointStartedAt = Date.now();
        await state.setRuntimeSession(
          activated.runtimeSession,
          activated.executionResources ?? null,
        );
        this.#log("info", "runtime.activation.session_checkpointed", {
          activationId,
          durationMs: Date.now() - checkpointStartedAt,
        });
        initialSessionCheckpointed = true;
      }
      if (
        !initialSessionCheckpointed &&
        !activated.executionResources &&
        savedResources
      ) {
        await state.clearRuntimeSession();
      }
      // A retried Run keeps the resources its first attempt started with.
      let retainedExecutionRunId: string | undefined;
      const execution = new RunLoop({
        executionContextRef: this.ref,
        activationFinishedAtMs: () => this.#activationFinishedAtMs,
        logger: this.#runtimeLogger,
        provider: activated.provider,
        runtimeName: activated.runtimeName,
        runtimeSession: activated.runtimeSession,
        newSession: mode === "start",
        ...(activeRuntime.prepareNextRun
          ? {
              prepareNextRun: async (nextSignal: AbortSignal) => {
                // The terminal callback clears the common case locally; only
                // a retry needs to recheck that its Run is still unsettled.
                const run = retainedExecutionRunId
                  ? await state.getLocalRun(retainedExecutionRunId)
                  : null;
                if (
                  run &&
                  (run.status === "queued" || run.status === "running")
                )
                  return true;
                retainedExecutionRunId = undefined;
                if (await activeRuntime.prepareNextRun!(nextSignal))
                  return true;
                this.#replaceChangedRuntime(activeRuntime);
                return false;
              },
            }
          : {}),
        ...(activeRuntime.executionResources
          ? {
              beforeStartRun: async (runId: string) => {
                if (!state.setExecutionResources)
                  throw new Error(
                    "Agent resources require execution checkpoints",
                  );
                // Checkpointed with the Run's Session, not before it starts.
                await state.setExecutionResources(
                  activeRuntime.executionResources!,
                );
                retainedExecutionRunId = runId;
              },
            }
          : {}),
        ...(this.#services.statusPublisher
          ? { runtimeStatusPublisher: this.#services.statusPublisher }
          : {}),
        state,
        onActiveRunContextChanged: (context) =>
          activeRuntime.setActiveRunContext(context),
        onActivityChanged: () => this.#notifyActivityChanged(),
        onRunTerminal: (runId, terminal) => {
          if (retainedExecutionRunId === runId)
            retainedExecutionRunId = undefined;
          this.#emitTurnTerminal(runId, terminal);
        },
        // Feature-aware canonical rebuild plus ordered input contributions run
        // here — inside the loop's try/requeue/terminal boundary — so a
        // throwing contribution fails or requeues execution AFTER the durable
        // acceptance fact was already returned. Plain canonical Messages keep
        // their acceptedNotification payload and are re-rendered with the
        // contributor; other Messages pass through unchanged. There is no
        // silent fallback and nothing transient is persisted.
        prepareInput: (message) =>
          features.prepareInput(
            renderAcceptedNotification(
              message as unknown as Record<string, unknown>,
              (input) => features.notificationContext(input),
              // Coordination reminders cover the Agent's own initiations.
              this.#ghost.actorId,
            ),
          ),
        onRunEvent: (event) => features.onRunEvent(event),
        onRunClaimed: (runId, messages) => {
          for (const message of messages)
            this.#observeInboxInput(message, { kind: "enqueue", runId });
        },
        onWorkStateRefreshed: () => this.#takeUpMessageSteers(),
      });
      this.#activatedRuntime = activated;
      this.#execution = execution;
      this.#providerReady = true;
      await state.refreshWorkState?.();
      if (!this.#providerReady) {
        throw new Error("Context Runtime was fenced during activation");
      }
      this.#activationFinishedAtMs = Date.now();
      execution.start({ workStateAlreadyFresh: true });
      // Steers listed by the activation read wait for this execution.
      this.#takeUpMessageSteers();
      this.#notifyActivityChanged();
      const durationMs = Date.now() - startedAt;
      this.#log("info", "runtime.activation.completed", {
        activationId,
        mode,
        runtimeName: activated.runtimeName,
        durationMs,
      });
    } catch (error) {
      if (error instanceof ContextRuntimeCleanupError)
        this.#activationCleanupFailure = error;
      if (activated) {
        if (this.#activatedRuntime === activated) {
          this.#providerReady = false;
          this.#execution = null;
          this.#activatedRuntime = null;
        }
        try {
          await activated.deactivate();
        } catch (cleanupError) {
          this.#activationCleanupFailure = new ContextRuntimeCleanupError([
            error,
            cleanupError,
          ]);
          throw this.#activationCleanupFailure;
        }
      }
      this.#providerReady = false;
      const waitingForComputer = isLocalComputerOfflineError(error);
      // A cancelled activation is expected, not a failure to alert on.
      const quiet = waitingForComputer || signal.aborted;
      const ownsFailureAlert = quiet ? false : claimAgentFailureAlert(error);
      this.#log(
        quiet ? "info" : ownsFailureAlert ? "error" : "warn",
        waitingForComputer
          ? "runtime.activation.waiting_for_computer"
          : "runtime.activation.failed",
        {
          activationId,
          mode,
          durationMs: Date.now() - startedAt,
          error,
          ...(quiet || ownsFailureAlert ? {} : { alertAggregated: true }),
        },
      );
      if (
        error instanceof LocalComputerModelError &&
        !signal.aborted &&
        !this.#stopped
      ) {
        await this.#failQueuedRuns(error.failure, activationId);
      }
      throw signal.aborted &&
        !(error instanceof ActivationCancelledError) &&
        !(error instanceof ContextRuntimeCleanupError)
        ? new ActivationCancelledError()
        : error;
    }
  }

  /**
   * Activation cannot succeed until the Agent's configuration changes, so
   * every queued Run would wait silently. Finish each one as failed with the
   * public cause, so the Room shows it on the Human's message. A later input
   * activates again and meets the current configuration.
   */
  async #failQueuedRuns(
    failure: RuntimeExecutionFailure,
    activationId: string,
  ): Promise<void> {
    const state = this.#requireState();
    const epoch = state.executionEpoch?.();
    const terminal = {
      type: "failed",
      error: "Runtime activation failed",
      failure,
    } as const;
    try {
      for (;;) {
        const claimed = await state.claimLocalRun();
        if (!claimed) return;
        // Opening the Run status lets TeamHub show the terminal in the Room.
        if (this.#services.statusPublisher && epoch) {
          await this.#services.statusPublisher
            .open({
              executionId: claimed.runId,
              ref: this.ref,
              epoch,
              sourceInboxIds: [
                ...new Set(
                  claimed.messages.flatMap(
                    ({ sourceInboxIds }) => sourceInboxIds ?? [],
                  ),
                ),
              ],
            })
            .catch((error: unknown) => {
              this.#log("warn", "runtime_status.open_failed", {
                runId: claimed.runId,
                error,
              });
            });
        }
        const settled = await state.finishLocalRun(claimed.runId, terminal);
        this.#log("info", "runtime.activation.queued_run_failed", {
          activationId,
          runId: claimed.runId,
          failureCode: failure.code,
        });
        if (settled !== "upstream_canceled")
          this.#emitTurnTerminal(claimed.runId, terminal);
      }
    } catch (error) {
      // The activation error stays the outcome; unsettled Runs stay queued.
      this.#log("warn", "runtime.activation.queued_run_fail_failed", {
        activationId,
        error,
      });
    }
  }

  // The Agent's effective resources changed before the next Run: drain the
  // current Runtime and activate it again with the new resources.
  #replaceChangedRuntime(runtime: ActivatedContextRuntime): void {
    if (this.#activatedRuntime !== runtime || this.#stopped) return;
    this.#providerReady = false;
    this.#execution?.requestDrain({ cancelActive: false });
    this.#notifyActivityChanged();
    this.#log("info", "runtime.lifecycle.interrupted", {
      error: new AgentResourceConfigurationChangedError(),
    });
    if (
      this.#desiredRuntimeState !== "active" ||
      this.#runtimeRecoveryPromise
    ) {
      return;
    }
    const recovery = this.#recoverRuntime(runtime)
      .catch((error: unknown) => {
        this.#log("error", "runtime.recovery.failed", { error });
      })
      .finally(() => {
        if (this.#runtimeRecoveryPromise === recovery) {
          this.#runtimeRecoveryPromise = null;
        }
        this.#notifyActivityChanged();
      });
    this.#runtimeRecoveryPromise = recovery;
  }

  async #recoverRuntime(runtime: ActivatedContextRuntime): Promise<void> {
    const startedAt = Date.now();
    const preparationExecution = this.#execution;
    let cleanupFailure: unknown;
    if (this.#activatedRuntime === runtime) {
      try {
        await this.#deactivate({ cancelActive: false, requireIdle: false });
      } catch (error) {
        cleanupFailure = error;
      }
    }
    if (cleanupFailure) {
      throw new Error("Runtime recovery cleanup failed", {
        cause: cleanupFailure,
      });
    }
    if (this.#desiredRuntimeState !== "active" || this.#stopped) return;

    // A Context whose Runtime Session awaits its first Run has nothing to resume.
    const mode =
      (await this.#requireState().getRuntimeSession()) === null
        ? "start"
        : "resume";
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.#beginActivation(mode);
        this.#log("info", "runtime.recovery.completed", {
          attempt,
          durationMs: Date.now() - startedAt,
        });
        return;
      } catch (error) {
        if (
          this.#desiredRuntimeState !== "active" ||
          this.#stopped ||
          error instanceof ActivationCancelledError ||
          error instanceof ContextRuntimeCleanupError
        ) {
          return;
        }
        this.#log(
          attempt < maxAttempts ? "warn" : "error",
          "runtime.recovery.activation_failed",
          { attempt, maxAttempts, error },
        );
        if (attempt === maxAttempts && preparationExecution) {
          await preparationExecution.failNextRunPreparation(
            error,
            this.#lifecycleController.signal,
          );
        }
      }
    }
  }

  #deactivate(options: {
    readonly cancelActive: boolean;
    readonly requireIdle: boolean;
  }): Promise<boolean> {
    if (this.#deactivationPromise) return this.#deactivationPromise;
    const task = this.#performDeactivation(options).finally(() => {
      if (this.#deactivationPromise === task) this.#deactivationPromise = null;
      this.#notifyActivityChanged();
    });
    this.#deactivationPromise = task;
    this.#notifyActivityChanged();
    return task;
  }

  async #performDeactivation(options: {
    readonly cancelActive: boolean;
    readonly requireIdle: boolean;
  }): Promise<boolean> {
    if (this.#activationPromise) {
      await this.#activationPromise;
    }
    if (!this.#activatedRuntime) return true;
    const execution = this.#execution;
    const activated = this.#activatedRuntime;
    const failures: unknown[] = [];

    try {
      await execution?.drain({ cancelActive: options.cancelActive });
    } catch (error) {
      failures.push(error);
    }
    if (
      failures.length === 0 &&
      options.requireIdle &&
      this.#providerReady &&
      this.#requireState().hasPendingWork()
    ) {
      execution?.start();
      this.#notifyActivityChanged();
      return false;
    }

    try {
      await activated.deactivate();
      this.#providerReady = false;
      this.#execution = null;
      this.#activatedRuntime = null;
      this.#idleSince = null;
    } catch (error) {
      // A failed cleanup is not proof that the native writer stopped. Retain
      // the handle so another stop cannot falsely report success and permit
      // a replacement Context to start alongside it.
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Context Runtime cleanup failed");
    }
    this.#log("info", "runtime.lifecycle.suspended");
    return true;
  }

  #isIdle(): boolean {
    if (
      !this.#providerReady ||
      this.#activationPromise !== null ||
      this.#deactivationPromise !== null ||
      (this.#execution?.activeOperations ?? 0) > 0
    ) {
      return false;
    }
    return !this.#requireState().hasPendingWork();
  }

  // One work-state read at a time; a hint during a read reads once more.
  #readMessageSteers(): void {
    if (this.#steerRead) {
      this.#steerReadAgain = true;
      return;
    }
    const state = this.#state;
    if (!state?.refreshWorkState) {
      this.#takeUpMessageSteers();
      return;
    }
    this.#steerRead = (async () => {
      do {
        this.#steerReadAgain = false;
        await state.refreshWorkState!();
        this.#takeUpMessageSteers();
        // A queued Run the read found still needs the loop.
        if (state.hasQueuedRuns()) this.#execution?.notifyWorkAvailable();
      } while (this.#steerReadAgain && !this.#stopped);
    })()
      .catch((error: unknown) => {
        // The fallback scan or the next hint reads them again.
        this.#log("warn", "message_steer.read_failed", { error });
      })
      .finally(() => {
        this.#steerRead = null;
      });
  }

  // Hands each new Message steer to the running Run. Without an execution it
  // stays listed, so activation reads it again.
  #takeUpMessageSteers(): void {
    const execution = this.#execution;
    const state = this.#state;
    if (!execution || !state?.takeMessageSteers || this.#stopped) return;
    for (const steer of state.takeMessageSteers()) {
      if (steer.message.runtimeResponses?.length) {
        void this.#answerRuntimeQuestion(steer);
        continue;
      }
      this.#observeInboxInput(steer.message, {
        kind: "steer",
        groupId: steer.groupId,
      });
      void execution
        .steer(
          steer.groupId,
          [steer.message],
          this.#lifecycleController.signal,
          steer.inboxId,
        )
        .catch((error: unknown) => {
          this.#log("warn", "message_steer.dispatch_failed", {
            groupId: steer.groupId,
            inputId: steer.inputId,
            error,
          });
        });
    }
  }

  // A Human's answer reaches the Run that asked; once that Run is gone the
  // answer is settled as uncertain so the Context no longer waits on it.
  async #answerRuntimeQuestion(steer: MessageSteer): Promise<void> {
    const state = this.#requireState();
    const runId = steer.runId;
    let outcome: "applied" | "uncertain" = "uncertain";
    try {
      const execution = this.#execution;
      if (execution && runId && execution.activeRunId() === runId) {
        for (const response of steer.message.runtimeResponses ?? [])
          await execution.respondToHumanInteraction(response);
        outcome = "applied";
      }
    } catch (error) {
      this.#log("warn", "message_steer.runtime_response_failed", {
        groupId: steer.groupId,
        error,
      });
    }
    if (!runId) return;
    try {
      await state.completeSteer(steer.groupId, runId, outcome);
    } catch (error) {
      this.#log("warn", "message_steer.settle_failed", {
        groupId: steer.groupId,
        error,
      });
    }
  }

  #observeInboxInput(
    message: Message,
    dispatch:
      | { readonly kind: "enqueue"; readonly runId: string }
      | { readonly kind: "steer"; readonly groupId: string },
  ): void {
    try {
      const fact = inboxInputFact(message, dispatch);
      if (fact) this.#features?.afterInboxInputAccepted(fact);
    } catch (error) {
      this.#log("warn", "inbox_input.observation_failed", {
        messageId: message.messageId,
        error,
      });
    }
  }

  #notifyActivityChanged(): void {
    if (!this.#state || this.#stopCompleted) return;
    let activity: ContextActivity;
    try {
      activity = this.#isIdle() ? "idle" : "busy";
    } catch {
      return;
    }
    if (activity === "idle") {
      this.#idleSince ??= Date.now();
    } else {
      this.#idleSince = null;
    }
    if (activity === this.#reportedActivity) return;
    this.#reportedActivity = activity;
    try {
      this.#onActivityChanged(activity);
    } catch (error) {
      this.#log("warn", "shell.activity_callback_failed", { error });
    }
  }

  #emitTurnTerminal(runId: string, terminal: LocalTurnTerminal): void {
    if (!this.#forwardTurnTerminals) return;
    try {
      if (this.#host.owns(this)) this.usePreparedContext();
      this.#features?.onRunTerminal({
        runId,
        terminal: snapshotTerminal(terminal),
      });
    } catch (error) {
      this.#log("warn", "trusted_turn.listener_failed", { runId, error });
    }
  }

  #requireState(): ContextRuntimeStatePort {
    if (!this.#state) throw new Error("Context Runtime state is unavailable");
    return this.#state;
  }

  #assertNotStopped(): void {
    if (this.#stopped)
      throw runtimeError("stopped", "Context Runtime has been stopped");
  }

  #log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.#runtimeLogger.log(level, event, fields);
  }
}

/** Internal control-flow marker: the submission gate declined at the fence. */
class FeatureSubmissionSkippedError extends Error {
  constructor() {
    super("Feature submission skipped at the final boundary");
    this.name = "FeatureSubmissionSkippedError";
  }
}

export class TerminalExecutionContextError extends AgentManagerError {
  constructor(ref: ExecutionContextRef) {
    super(
      "binding_not_found",
      `Execution Context ${encodeExecutionContextRef(ref)} is terminal`,
    );
    this.name = "TerminalExecutionContextError";
  }
}

class ActivationCancelledError extends Error {
  constructor() {
    super("Context Runtime activation was cancelled");
    this.name = "ActivationCancelledError";
  }
}

class AgentResourceConfigurationChangedError extends Error {
  constructor() {
    super("Agent resource configuration changed");
  }
}

const invokeClose = (operation: () => void | Promise<void>): Promise<void> => {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
};

const snapshotMessages = (
  messages: ExecutionContextMessageDelivery["messages"],
): NonEmptyReadonlyArray<Message> => {
  const first = snapshotMessage(messages[0]);
  return [first, ...messages.slice(1).map(snapshotMessage)];
};

const snapshotMessage = (
  message: ExecutionContextMessageDelivery["messages"][number],
): Message => ({
  messageId: message.messageId,
  ...(message.notificationRender
    ? { notificationRender: { ...message.notificationRender } }
    : {}),
  ...(message.invocationMessageIds
    ? { invocationMessageIds: [...message.invocationMessageIds] }
    : {}),
  ...(message.runtimeResponses
    ? { runtimeResponses: structuredClone(message.runtimeResponses) }
    : {}),
  rawMessage: message.rawMessage,
  segments: [
    { ...message.segments[0] },
    ...message.segments.slice(1).map((segment) => ({ ...segment })),
  ],
  ...(message.sourceInboxIds
    ? { sourceInboxIds: [...message.sourceInboxIds] }
    : {}),
});

const snapshotTerminal = (terminal: LocalTurnTerminal): LocalTurnTerminal =>
  terminal.type === "succeeded"
    ? Object.freeze({
        type: "succeeded",
        ...(terminal.finalResponse === undefined
          ? {}
          : { finalResponse: terminal.finalResponse }),
      })
    : terminal.type === "failed"
      ? Object.freeze({ type: "failed", error: terminal.error })
      : Object.freeze({ type: "canceled" });

const requirePersistedSession = async (state: ContextRuntimeStatePort) => {
  const session = await state.getRuntimeSession();
  if (session === null || session === undefined) {
    throw new Error(
      "Context Runtime has no persisted Runtime Session to resume",
    );
  }
  return session;
};

const configuredRuntimeName = (runtime: unknown): string => {
  if (typeof runtime !== "object" || runtime === null) return "unknown";
  const settings = runtime as Record<string, unknown>;
  if (settings.type === "local") {
    const placement = settings.placement;
    if (typeof placement === "object" && placement !== null) {
      const runtimeType = (placement as Record<string, unknown>).runtimeType;
      if (typeof runtimeType === "string" && runtimeType.length > 0) {
        return runtimeType;
      }
    }
  }
  return typeof settings.type === "string" && settings.type.length > 0
    ? settings.type
    : "unknown";
};

const runtimeError = (
  code: "busy" | "stopped",
  message: string,
): Error & { code: "busy" | "stopped" } =>
  Object.assign(new Error(message), { code });

const idleCleanupRequiresIntervention = (error: unknown): boolean => {
  if (isUnconfirmedContextRuntimeCleanup(error)) return true;
  if (error instanceof AggregateError) {
    return error.errors.some(idleCleanupRequiresIntervention);
  }
  return false;
};

const snapshotConfiguration = <T>(value: T): T =>
  snapshotConfigurationValue(value, new WeakMap<object, object>());

const snapshotConfigurationValue = <T>(
  value: T,
  snapshots: WeakMap<object, object>,
): T => {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }
  if (typeof value === "function") return value;
  const existing = snapshots.get(value);
  if (existing) return existing as T;
  if (Array.isArray(value)) {
    const snapshot: unknown[] = [];
    snapshots.set(value, snapshot);
    snapshot.push(
      ...value.map((entry) => snapshotConfigurationValue(entry, snapshots)),
    );
    return Object.freeze(snapshot) as T;
  }
  const snapshot: Record<string, unknown> = {};
  snapshots.set(value, snapshot);
  for (const [key, entry] of Object.entries(value)) {
    snapshot[key] = snapshotConfigurationValue(entry, snapshots);
  }
  return Object.freeze(snapshot) as T;
};
