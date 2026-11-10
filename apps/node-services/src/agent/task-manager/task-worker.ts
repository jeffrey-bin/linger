import { randomUUID } from "node:crypto";
import { asError, isRecord } from "@linger/service-kit";

import type { AgentManager } from "../executor/agent-manager-api.js";
import {
  assertExecutionContextRef,
  type ExecutionContextRef,
} from "../executor/context-ref.js";
import {
  createAgentLogger,
  type AgentLogger,
} from "../observability/agent-log.js";
import type {
  LocalTurnObservation,
  LocalTurnTerminal,
} from "../executor/types.js";
import type { Message, MessageSegment } from "../executor/types.js";
import type {
  TaskEffect,
  TaskExecution,
  TaskWorkerExecution,
  TaskWorkerLease,
  TeamHubTaskWorkerClient,
} from "./teamhub-task-worker-client.js";

const DEFAULT_LEASE_SECONDS = 15;
const DEFAULT_POLL_INTERVAL_MS = 500;
// TeamHub wakes the Worker through the Agent wake stream when a commit may
// make a Task claimable, and reports when a pending Task becomes due; this
// cap only recovers a lost wake.
const IDLE_CLAIM_WAIT_MS = 60_000;
// A due Task whose row another claim transaction has locked at that instant
// is skipped by the locking claim and reported with no delay; this floor
// retries it shortly instead of spinning.
const MIN_CLAIM_DELAY_MS = 100;
const MIN_HEARTBEAT_INTERVAL_MS = 1_000;
// A participant Run finishing makes its running Task due in TeamHub, and the
// Attempt deadline caps the scheduled time; this only recovers a lost update.
const RUNNING_RECONCILE_SAFETY_NET_SECONDS = 60;
// An unclassified submit failure is retried soon.
const SUBMIT_FAILURE_RETRY_SECONDS = 1;

type TaskAgentManager = Pick<
  AgentManager<unknown>,
  | "cancelLocalRun"
  | "cancelTrustedTurn"
  | "observeTurn"
  | "steerActiveTurn"
  | "submitTrustedTurn"
>;

export interface TaskWorkerOptions {
  readonly agentManager: TaskAgentManager;
  readonly client: TeamHubTaskWorkerClient;
  readonly workerId?: string;
  readonly leaseSeconds?: number;
  /** Backoff after a failed claim or drive. */
  readonly pollIntervalMs?: number;
  readonly logger?: AgentLogger;
}

export interface TaskWorker {
  start(): void;
  runOnce(signal?: AbortSignal): Promise<boolean>;
  wake(): void;
  close(): Promise<void>;
}

interface ParticipantRun {
  readonly actor_id: string;
  readonly agent_management_id: string;
  readonly agent_run_ref: string;
}

interface ParticipantTerminal {
  readonly agent_run_ref: string;
  readonly status: "succeeded" | "failed" | "canceled";
  readonly terminal_code?: string;
  readonly terminal_message?: string;
}

interface SubmitAgentTurnPayload {
  readonly taskId: string;
  readonly recipientActorIds: readonly string[];
  readonly inputManifest?: Readonly<Record<string, unknown>>;
  readonly feedbackMessageId?: string;
  readonly message: Message;
  readonly recipientWakes?: ReadonlyMap<string, ParticipantMetaWake>;
  /** A Meta's task send --steer: join the running turn when it can. */
  readonly steer: boolean;
}

interface PublicTurnMessage {
  readonly message: Message;
  readonly author: {
    readonly actorId: string;
    readonly kind: "human" | "agent";
    readonly displayName: string;
  };
}

interface ParticipantMetaWake {
  readonly actorId: string;
  readonly authorActorId: string;
  readonly metaSeq: number;
  readonly publicMessageIds: readonly string[];
  readonly message: Message;
}

interface AgentTurnObservation {
  readonly participantRuns: readonly ParticipantRun[];
  readonly participantTerminals: readonly ParticipantTerminal[];
}

interface RuntimeCleanupPayload {
  readonly actorId: string;
  readonly agentManagementId: string;
  readonly agentRunRef?: string;
  readonly executionContextRef: ExecutionContextRef;
  readonly reconcileSubmit?: {
    readonly sourceEffectId: string;
    readonly rootOperationId: string;
    readonly submit: SubmitAgentTurnPayload;
  };
}

export const createTaskWorker = (options: TaskWorkerOptions): TaskWorker => {
  const workerId =
    options.workerId?.trim() || `agent-task-worker-${randomUUID()}`;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 5 ||
    leaseSeconds > 300
  ) {
    throw new TypeError("leaseSeconds must be an integer between 5 and 300");
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError("pollIntervalMs must be a positive safe integer");
  }
  const logger =
    options.logger ?? createAgentLogger({ component: "task-worker", workerId });
  const closeController = new AbortController();
  let loop: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let wakeController = new AbortController();

  const wake = (): void => {
    wakeController.abort();
    wakeController = new AbortController();
  };

  /** Resolves 0 after driving a claimed Task, else the wait before the next claim. */
  const claimAndDrive = async (signal?: AbortSignal): Promise<number> => {
    const operationSignal = combineSignals(closeController.signal, signal);
    operationSignal.throwIfAborted();
    const { claimed, nextClaimDelayMs } = await options.client.claim({
      workerId,
      leaseSeconds,
      signal: operationSignal,
    });
    if (!claimed) {
      return Math.min(
        Math.max(nextClaimDelayMs ?? IDLE_CLAIM_WAIT_MS, MIN_CLAIM_DELAY_MS),
        IDLE_CLAIM_WAIT_MS,
      );
    }
    const lease = requireClaimLease(claimed);
    await driveWithHeartbeat(
      options.client,
      lease,
      leaseSeconds,
      operationSignal,
      (currentLease, driveSignal) =>
        driveClaim(options, currentLease, claimed.execution, driveSignal),
    );
    return 0;
  };

  const runOnce = async (signal?: AbortSignal): Promise<boolean> =>
    (await claimAndDrive(signal)) === 0;

  const start = (): void => {
    if (closePromise) throw new Error("Task Worker is closed");
    if (loop) return;
    loop = (async () => {
      logger.log("info", "task_worker.started");
      while (!closeController.signal.aborted) {
        // Taken before claiming, so a wake during the claim is not lost.
        const wakeSignal = wakeController.signal;
        let waitMs = pollIntervalMs;
        try {
          waitMs = await claimAndDrive(closeController.signal);
          if (waitMs === 0) continue;
        } catch (error) {
          if (closeController.signal.aborted) break;
          logger.log("warn", "task_worker.drive_failed", { error });
        }
        await waitForWake(
          waitMs,
          combineSignals(closeController.signal, wakeSignal),
        );
      }
      logger.log("info", "task_worker.stopped");
    })();
  };

  return Object.freeze({
    start,
    runOnce,
    wake,
    close() {
      closePromise ??= (async () => {
        closeController.abort();
        wake();
        await loop;
      })();
      return closePromise;
    },
  });
};

const driveClaim = async (
  options: Pick<TaskWorkerOptions, "agentManager" | "client">,
  lease: TaskWorkerLease,
  initialExecution: TaskExecution,
  signal: AbortSignal,
): Promise<void> => {
  let execution = initialExecution;
  let acquiredRuntimeCleanupEffectId: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const advanced = await options.client.transition({
      lease,
      execution,
      transition: "advance",
      expectedControlRevision: execution.control_revision,
      signal,
    });
    if (!advanced.lease) return;
    execution = advanced.execution;

    const cleanup = nextRuntimeCleanupEffect(execution.pending_effects);
    if (cleanup) {
      if (cleanup.id !== acquiredRuntimeCleanupEffectId) {
        execution = (
          await options.client.transition({
            lease,
            execution,
            transition: "begin_effect_dispatch",
            payload: { effect_id: cleanup.id },
            signal,
          })
        ).execution;
        acquiredRuntimeCleanupEffectId = cleanup.id;
        continue;
      }
      const completed = await dispatchRuntimeCleanup(
        options,
        lease,
        execution,
        cleanup,
        signal,
      );
      if (!completed.lease) return;
      execution = completed.execution;
      continue;
    }
    // Only a running Task has turns to drive; other states only drain cleanup.
    if (execution.status !== "running") return;

    const terminalTransition = await observeAgentTerminals(
      options.agentManager,
      execution,
      signal,
    );
    if (terminalTransition) {
      execution = (
        await options.client.transition({
          lease,
          execution,
          transition: "record_agent_terminal",
          payload: terminalTransition,
          signal,
        })
      ).execution;
      continue;
    }

    const liveEffect = nextLiveEffect(execution.pending_effects);
    if (liveEffect) {
      if (liveEffect.status === "pending") {
        execution = (
          await options.client.transition({
            lease,
            execution,
            transition: "begin_effect_dispatch",
            payload: { effect_id: liveEffect.id },
            signal,
          })
        ).execution;
        continue;
      }
      if (liveEffect.operation === "submit_agent_turn") {
        const dispatched = await dispatchAgentTurn(
          options,
          lease,
          execution,
          liveEffect,
          signal,
        );
        if (!dispatched.lease) return;
        execution = dispatched.execution;
        continue;
      }
    }

    await options.client.transition({
      lease,
      execution,
      transition: "schedule_reconcile",
      expectedControlRevision: execution.control_revision,
      payload: {
        reconcile_after_seconds: RUNNING_RECONCILE_SAFETY_NET_SECONDS,
      },
      signal,
    });
    return;
  }
};

const dispatchAgentTurn = async (
  options: Pick<TaskWorkerOptions, "agentManager" | "client">,
  lease: TaskWorkerLease,
  execution: TaskExecution,
  effect: TaskEffect,
  signal: AbortSignal,
): Promise<TaskWorkerExecution> => {
  const payload = parseSubmitAgentTurnPayload(
    effect.payload,
    execution.task_id,
  );
  const recipients = exactRecipientParticipants(
    execution,
    payload.recipientActorIds,
  );
  requiredString(payload.inputManifest?.room_id, "Task Room ID");

  let participantRuns: ParticipantRun[];
  try {
    participantRuns = await Promise.all(
      recipients.map(async (participant): Promise<ParticipantRun> => {
        signal.throwIfAborted();
        const target = executionContextRef(participant.execution_context_ref);
        if (
          target.kind !== "alter_ego" ||
          target.agentId !== participant.agent_id ||
          target.taskId !== execution.task_id
        ) {
          throw new TaskWorkerProtocolError(
            `Task participant ${participant.actor_id} has a mismatched Execution Context`,
          );
        }
        const trustedMessage = trustedMessageForActor(
          payload,
          participant.actor_id,
        );
        signal.throwIfAborted();
        // A steered message joins the running turn and shares its Run; when
        // no turn can take it, it runs as the next turn.
        const submitted =
          (payload.steer
            ? await options.agentManager.steerActiveTurn({
                target,
                message: trustedMessage,
              })
            : null) ??
          (await options.agentManager.submitTrustedTurn({
            target,
            messages: [trustedMessage],
          }));
        return Object.freeze({
          actor_id: participant.actor_id,
          agent_management_id: participant.agent_id,
          agent_run_ref: requiredString(
            submitted.agentRunRef,
            "Agent Run reference",
          ),
        });
      }),
    );
  } catch (error) {
    signal.throwIfAborted();
    const activationFailure = classifiedContextActivationFailure(error);
    if (activationFailure) {
      return options.client.transition({
        lease,
        execution,
        transition: "record_agent_turn_failure",
        operationId: `${effect.root_operation_id}:activation-failed`,
        payload: {
          effect_id: effect.id,
          failure_code: activationFailure.code,
          retryable: activationFailure.retryable,
        },
        signal,
      });
    }
    return options.client.transition({
      lease,
      execution,
      transition: "schedule_reconcile",
      expectedControlRevision: execution.control_revision,
      payload: { reconcile_after_seconds: SUBMIT_FAILURE_RETRY_SECONDS },
      signal,
    });
  }
  participantRuns.sort((left, right) =>
    left.actor_id.localeCompare(right.actor_id),
  );
  return options.client.transition({
    lease,
    execution,
    transition: "record_agent_turn",
    operationId: effect.root_operation_id,
    payload: {
      effect_id: effect.id,
      participant_runs: participantRuns,
    },
    signal,
  });
};

const classifiedContextActivationFailure = (
  error: unknown,
): { readonly code: string; readonly retryable: boolean } | null => {
  if (
    !(error instanceof Error) ||
    error.name !== "ContextActivationError" ||
    !("code" in error) ||
    typeof error.code !== "string" ||
    !/^CONTEXT_ACTIVATION_[A-Z_]+_FAILED$/.test(error.code) ||
    !("retryable" in error) ||
    typeof error.retryable !== "boolean"
  ) {
    return null;
  }
  return { code: error.code, retryable: error.retryable };
};

const dispatchRuntimeCleanup = async (
  options: Pick<TaskWorkerOptions, "agentManager" | "client">,
  lease: TaskWorkerLease,
  execution: TaskExecution,
  effect: TaskEffect,
  signal: AbortSignal,
): Promise<TaskWorkerExecution> => {
  const payload = parseRuntimeCleanupPayload(effect.payload, execution.task_id);
  const participant = execution.participants.find(
    ({ actor_id }) => actor_id === payload.actorId,
  );
  if (!participant || participant.agent_id !== payload.agentManagementId) {
    throw new TaskWorkerProtocolError(
      `Runtime cleanup actor ${payload.actorId} is not a matching Task participant`,
    );
  }
  signal.throwIfAborted();
  const recovered = payload.agentRunRef
    ? null
    : await reconcileSubmittedLocalRun(options, execution, payload, signal);
  const agentRunRef =
    payload.agentRunRef ??
    requiredString(recovered?.agentRunRef, "Recovered cleanup Local Run ID");
  const cancelStatus =
    recovered?.cancelStatus ??
    (await options.agentManager.cancelLocalRun(
      payload.executionContextRef,
      agentRunRef,
    ));
  let runStatus: "succeeded" | "failed" | "canceled" | undefined;
  if (cancelStatus === "canceled") {
    runStatus = "canceled";
  } else if (
    cancelStatus === "cancel_requested" ||
    cancelStatus === "already_terminal"
  ) {
    for (;;) {
      signal.throwIfAborted();
      const observed = await options.agentManager.observeTurn(
        payload.executionContextRef,
        agentRunRef,
      );
      const terminal = observedTerminal(observed);
      if (terminal) {
        runStatus = localTerminalStatus(terminal);
        break;
      }
      if (cancelStatus === "already_terminal") {
        throw new TaskWorkerProtocolError(
          `Terminal Local Run ${agentRunRef} has no observation`,
        );
      }
      await waitForWake(DEFAULT_POLL_INTERVAL_MS, signal);
    }
  }
  return options.client.transition({
    lease,
    execution,
    transition: "complete_runtime_cleanup",
    expectedControlRevision: execution.control_revision,
    operationId: effect.root_operation_id,
    payload: {
      effect_id: effect.id,
      agent_run_ref: agentRunRef,
      cancel_status: cancelStatus,
      ...(runStatus === undefined ? {} : { run_status: runStatus }),
    },
    signal,
  });
};

const reconcileSubmittedLocalRun = async (
  options: Pick<TaskWorkerOptions, "agentManager">,
  execution: TaskExecution,
  payload: RuntimeCleanupPayload,
  signal: AbortSignal,
): Promise<{
  readonly agentRunRef: string;
  readonly cancelStatus:
    | "canceled"
    | "cancel_requested"
    | "already_terminal"
    | "not_found";
}> => {
  const reconcile = payload.reconcileSubmit;
  if (!reconcile) {
    throw new TaskWorkerProtocolError(
      "Runtime cleanup has neither a Local Run reference nor submit reconciliation data",
    );
  }
  if (!reconcile.submit.recipientActorIds.includes(payload.actorId)) {
    throw new TaskWorkerProtocolError(
      `Cleanup submit ${reconcile.sourceEffectId} does not address ${payload.actorId}`,
    );
  }
  signal.throwIfAborted();
  const canceled = await options.agentManager.cancelTrustedTurn({
    target: payload.executionContextRef,
    messages: [trustedMessageForActor(reconcile.submit, payload.actorId)],
  });
  return Object.freeze({
    agentRunRef: requiredString(
      canceled.agentRunRef,
      `Cleanup submit ${reconcile.rootOperationId} Local Run reference`,
    ),
    cancelStatus: canceled.cancelStatus,
  });
};

const observeAgentTerminals = async (
  agentManager: TaskAgentManager,
  execution: TaskExecution,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>> | null> => {
  for (const effect of execution.pending_effects) {
    if (
      effect.operation !== "submit_agent_turn" ||
      effect.status !== "succeeded"
    ) {
      continue;
    }
    const observation = parseAgentTurnObservation(effect.observation);
    const recorded = new Set(
      observation.participantTerminals.map(
        ({ agent_run_ref }) => agent_run_ref,
      ),
    );
    const byAgent = new Map(
      execution.participants.map((participant) => [
        participant.agent_id,
        participant,
      ]),
    );
    const terminals: ParticipantTerminal[] = [];
    for (const run of observation.participantRuns) {
      if (recorded.has(run.agent_run_ref)) continue;
      const participant = byAgent.get(run.agent_management_id);
      if (!participant || participant.actor_id !== run.actor_id) {
        throw new TaskWorkerProtocolError(
          `Agent Run ${run.agent_run_ref} does not match a Task participant`,
        );
      }
      signal.throwIfAborted();
      const observed = await agentManager.observeTurn(
        executionContextRef(participant.execution_context_ref),
        run.agent_run_ref,
      );
      const terminal = observedTerminal(observed);
      if (terminal)
        terminals.push(toParticipantTerminal(run.agent_run_ref, terminal));
    }
    if (terminals.length > 0) {
      terminals.sort((left, right) =>
        left.agent_run_ref.localeCompare(right.agent_run_ref),
      );
      return {
        effect_id: effect.id,
        participant_terminals: terminals,
      };
    }
  }
  return null;
};

const nextLiveEffect = (effects: readonly TaskEffect[]): TaskEffect | null =>
  effects.find(
    (effect) =>
      (effect.status === "pending" || effect.status === "dispatching") &&
      effect.operation === "submit_agent_turn",
  ) ?? null;

const nextRuntimeCleanupEffect = (
  effects: readonly TaskEffect[],
): TaskEffect | null =>
  effects.find(
    (effect) =>
      effect.operation === "cleanup_runtime" &&
      (effect.status === "pending" || effect.status === "dispatching"),
  ) ?? null;

const parseRuntimeCleanupPayload = (
  value: Readonly<Record<string, unknown>>,
  taskId: string,
): RuntimeCleanupPayload => {
  const actorId = requiredString(value.actor_id, "Cleanup Actor ID");
  const agentManagementId = requiredString(
    value.agent_management_id,
    "Cleanup Agent Management ID",
  );
  const agentRunRef = optionalString(value.agent_run_ref);
  const executionContextRef = executionContextRefForTask(
    value.execution_context_ref,
    taskId,
    agentManagementId,
  );
  const reconcileValue = optionalRecord(value.reconcile_submit);
  const reconcileSubmit = reconcileValue
    ? Object.freeze({
        sourceEffectId: requiredString(
          reconcileValue.source_effect_id,
          "Cleanup source Effect ID",
        ),
        rootOperationId: requiredString(
          reconcileValue.root_operation_id,
          "Cleanup source root operation ID",
        ),
        submit: parseSubmitAgentTurnPayload(
          requiredRecord(
            reconcileValue.submit_payload,
            "Cleanup submit payload",
          ),
          taskId,
        ),
      })
    : undefined;
  if ((agentRunRef === undefined) === (reconcileSubmit === undefined)) {
    throw new TaskWorkerProtocolError(
      "Runtime cleanup must have exactly one Local Run recovery mode",
    );
  }
  return Object.freeze({
    actorId,
    agentManagementId,
    ...(agentRunRef ? { agentRunRef } : {}),
    executionContextRef,
    ...(reconcileSubmit ? { reconcileSubmit } : {}),
  });
};

const executionContextRefForTask = (
  value: unknown,
  taskId: string,
  agentManagementId: string,
): ExecutionContextRef => {
  const ref = executionContextRef(value);
  if (
    ref.kind !== "alter_ego" ||
    ref.taskId !== taskId ||
    ref.agentId !== agentManagementId
  ) {
    throw new TaskWorkerProtocolError(
      "Runtime cleanup has a mismatched Execution Context",
    );
  }
  return ref;
};

const parseSubmitAgentTurnPayload = (
  value: Readonly<Record<string, unknown>>,
  taskId: string,
): SubmitAgentTurnPayload => {
  const recipients = requiredStringArray(
    value.recipient_actor_ids,
    "Agent-turn recipient Actor IDs",
  );
  const inputManifest = optionalRecord(value.input_manifest);
  const feedbackMessageId =
    value.feedback_message_id === undefined
      ? undefined
      : requiredString(
          value.feedback_message_id,
          "Agent-turn feedback Message ID",
        );
  const messageValue = requiredRecord(value.message, "Agent-turn Message");
  const hasPublicContext = value.public_context_message !== undefined;
  const hasRecipientWakes = value.recipient_wakes !== undefined;
  if (hasPublicContext !== hasRecipientWakes) {
    throw new TaskWorkerProtocolError(
      "Agent-turn public context and recipient wakes must be present together",
    );
  }
  const routed = hasPublicContext
    ? parseAndVerifyRoutedTurn(value, inputManifest, recipients, taskId)
    : undefined;
  if (!routed && inputManifestHasRoutedWitness(inputManifest)) {
    throw new TaskWorkerProtocolError(
      "Agent-turn Input Manifest route has no matching effect route",
    );
  }
  const recipientWakes = routed?.recipientWakes;
  if (recipientWakes && feedbackMessageId) {
    throw new TaskWorkerProtocolError(
      "Agent-turn cannot combine public Task routing with private feedback routing",
    );
  }
  if (!recipientWakes && !feedbackMessageId) {
    throw new TaskWorkerProtocolError(
      "Agent-turn has no private Meta Inbox ingress",
    );
  }
  const replayPublicMessage = routed
    ? parsePublicTurnMessage(messageValue, taskId)
    : undefined;
  const message = replayPublicMessage
    ? replayPublicMessage.message
    : parseTurnMessage(messageValue, `meta:${taskId}`);
  if (
    routed &&
    (!replayPublicMessage ||
      !samePublicTurnMessage(replayPublicMessage, routed.publicContextMessage))
  ) {
    throw new TaskWorkerProtocolError(
      "Agent-turn replay Message does not match its frozen public context",
    );
  }
  if (feedbackMessageId && message.messageId !== feedbackMessageId) {
    throw new TaskWorkerProtocolError(
      "Agent-turn feedback Message ID does not match its Meta Inbox correlation",
    );
  }
  return Object.freeze({
    taskId,
    recipientActorIds: recipients,
    ...(inputManifest ? { inputManifest } : {}),
    ...(feedbackMessageId ? { feedbackMessageId } : {}),
    message,
    ...(recipientWakes ? { recipientWakes } : {}),
    steer: value.steer === true,
  });
};

const parseAndVerifyRoutedTurn = (
  effect: Readonly<Record<string, unknown>>,
  inputManifest: Readonly<Record<string, unknown>> | undefined,
  recipients: readonly string[],
  taskId: string,
): {
  readonly publicContextMessage: PublicTurnMessage;
  readonly recipientWakes: ReadonlyMap<string, ParticipantMetaWake>;
} => {
  if (!inputManifest) {
    throw new TaskWorkerProtocolError(
      "Agent-turn routed effect has no frozen Input Manifest",
    );
  }
  const effectPublicMessage = parsePublicTurnMessage(
    requiredRecord(
      effect.public_context_message,
      "Agent-turn public context Message",
    ),
    taskId,
  );
  const manifestPublicMessage = parsePublicTurnMessage(
    requiredRecord(
      inputManifest.public_context_message,
      "Agent-turn Input Manifest public context Message",
    ),
    taskId,
  );
  const manifestPublicMessageIds = requiredStringArray(
    inputManifest.public_message_ids,
    "Agent-turn Input Manifest public Message IDs",
  );
  if (
    manifestPublicMessageIds.length !== 1 ||
    manifestPublicMessageIds[0] !== manifestPublicMessage.message.messageId
  ) {
    throw new TaskWorkerProtocolError(
      "Agent-turn Input Manifest public Message IDs do not match its public context",
    );
  }
  const effectWakes = parseParticipantMetaWakes(
    effect.recipient_wakes,
    effectPublicMessage.message,
    taskId,
    "Agent-turn effect",
  );
  const manifestWakes = parseParticipantMetaWakes(
    inputManifest.recipient_wakes,
    manifestPublicMessage.message,
    taskId,
    "Agent-turn Input Manifest",
  );
  assertExactWakeRecipients(effectWakes, recipients, "Agent-turn recipient");
  assertExactWakeRecipients(
    manifestWakes,
    recipients,
    "Agent-turn Input Manifest recipient",
  );
  const wakeAuthorActorId = requiredString(
    inputManifest.wake_author_actor_id,
    "Agent-turn Input Manifest wake author Actor ID",
  );
  assertWakeAuthor(effectWakes, wakeAuthorActorId, "Agent-turn effect");
  assertWakeAuthor(
    manifestWakes,
    wakeAuthorActorId,
    "Agent-turn Input Manifest",
  );
  if (!samePublicTurnMessage(effectPublicMessage, manifestPublicMessage)) {
    throw new TaskWorkerProtocolError(
      "Agent-turn public context does not match its frozen Input Manifest",
    );
  }
  for (const actorId of recipients) {
    const effectWake = effectWakes.get(actorId);
    const manifestWake = manifestWakes.get(actorId);
    if (
      !effectWake ||
      !manifestWake ||
      !sameParticipantMetaWake(effectWake, manifestWake)
    ) {
      throw new TaskWorkerProtocolError(
        `Agent-turn wake ${actorId} does not match its frozen Input Manifest`,
      );
    }
  }
  return Object.freeze({
    publicContextMessage: effectPublicMessage,
    recipientWakes: effectWakes,
  });
};

const parseParticipantMetaWakes = (
  value: unknown,
  publicContextMessage: Message,
  taskId: string,
  name: string,
): ReadonlyMap<string, ParticipantMetaWake> => {
  const values = requiredArray(value, `${name} recipient wakes`);
  if (values.length === 0) {
    throw new TaskWorkerProtocolError(
      `${name} recipient wakes must not be empty`,
    );
  }
  const wakes = new Map<string, ParticipantMetaWake>();
  for (const item of values) {
    const wake = requiredRecord(item, `${name} recipient wake`);
    const actorId = requiredString(wake.actor_id, `${name} wake Actor ID`);
    const publicMessageIds = requiredStringArray(
      wake.public_message_ids,
      `${name} wake public Message IDs`,
    );
    if (
      publicMessageIds.length !== 1 ||
      publicMessageIds[0] !== publicContextMessage.messageId
    ) {
      throw new TaskWorkerProtocolError(
        `${name} wake ${actorId} does not reference its public Task context`,
      );
    }
    const parsed = Object.freeze({
      actorId,
      authorActorId: requiredString(
        wake.author_actor_id,
        `${name} wake author Actor ID`,
      ),
      metaSeq: positiveSafeInteger(wake.meta_seq, `${name} wake Meta sequence`),
      publicMessageIds,
      message: parseTurnMessage(
        requiredRecord(wake.message, `${name} wake Message`),
        canonicalMetaInboxId(actorId, taskId),
      ),
    });
    if (wakes.has(actorId)) {
      throw new TaskWorkerProtocolError(
        `${name} recipient wakes contain duplicate Actor IDs`,
      );
    }
    wakes.set(actorId, parsed);
  }
  return wakes;
};

const assertExactWakeRecipients = (
  wakes: ReadonlyMap<string, ParticipantMetaWake>,
  recipients: readonly string[],
  name: string,
): void => {
  if (
    wakes.size !== recipients.length ||
    recipients.some((actorId) => !wakes.has(actorId))
  ) {
    throw new TaskWorkerProtocolError(
      `${name} wakes do not exactly match frozen recipients`,
    );
  }
};

const assertWakeAuthor = (
  wakes: ReadonlyMap<string, ParticipantMetaWake>,
  authorActorId: string,
  name: string,
): void => {
  if (
    [...wakes.values()].some((wake) => wake.authorActorId !== authorActorId)
  ) {
    throw new TaskWorkerProtocolError(
      `${name} wake author does not match its frozen Input Manifest`,
    );
  }
};

const inputManifestHasRoutedWitness = (
  inputManifest: Readonly<Record<string, unknown>> | undefined,
): boolean =>
  inputManifest !== undefined &&
  (inputManifest.public_message_ids !== undefined ||
    inputManifest.public_context_message !== undefined ||
    inputManifest.recipient_wakes !== undefined ||
    inputManifest.wake_author_actor_id !== undefined);

const sameParticipantMetaWake = (
  left: ParticipantMetaWake,
  right: ParticipantMetaWake,
): boolean =>
  left.actorId === right.actorId &&
  left.authorActorId === right.authorActorId &&
  left.metaSeq === right.metaSeq &&
  sameStringArray(left.publicMessageIds, right.publicMessageIds) &&
  sameTurnMessage(left.message, right.message);

const sameTurnMessage = (left: Message, right: Message): boolean =>
  left.messageId === right.messageId &&
  left.rawMessage === right.rawMessage &&
  JSON.stringify(left.segments) === JSON.stringify(right.segments);

const samePublicTurnMessage = (
  left: PublicTurnMessage,
  right: PublicTurnMessage,
): boolean =>
  sameTurnMessage(left.message, right.message) &&
  left.author.actorId === right.author.actorId &&
  left.author.kind === right.author.kind &&
  left.author.displayName === right.author.displayName;

const sameStringArray = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const parseTurnMessage = (
  value: Readonly<Record<string, unknown>>,
  sourceInboxId: string,
): Message =>
  Object.freeze({
    messageId: requiredString(value.message_id, "Agent-turn Message ID"),
    rawMessage: requiredString(value.raw_message, "Agent-turn raw Message"),
    segments: parseMessageSegments(value.segments),
    sourceInboxIds: [sourceInboxId],
  });

const parsePublicTurnMessage = (
  value: Readonly<Record<string, unknown>>,
  taskId: string,
): PublicTurnMessage => {
  const author = requiredRecord(
    value.author,
    "Agent-turn public Message author",
  );
  const kind = author.kind;
  if (kind !== "human" && kind !== "agent") {
    throw new TaskWorkerProtocolError(
      "Agent-turn public Message author kind is invalid",
    );
  }
  return Object.freeze({
    message: parseTurnMessage(value, `task:${taskId}`),
    author: Object.freeze({
      actorId: requiredString(
        author.actor_id,
        "Agent-turn public Message author Actor ID",
      ),
      kind,
      displayName: requiredString(
        author.display_name,
        "Agent-turn public Message author display name",
      ),
    }),
  });
};

const exactRecipientParticipants = (
  execution: TaskExecution,
  recipientActorIds: readonly string[],
): readonly TaskExecution["participants"][number][] => {
  const byActor = new Map(
    execution.participants.map((participant) => [
      participant.actor_id,
      participant,
    ]),
  );
  const recipients = recipientActorIds.map((actorId) => {
    const participant = byActor.get(actorId);
    if (!participant) {
      throw new TaskWorkerProtocolError(
        `Agent-turn recipient ${actorId} is not a frozen Task participant`,
      );
    }
    return participant;
  });
  if (new Set(recipientActorIds).size !== recipients.length) {
    throw new TaskWorkerProtocolError(
      "Agent-turn recipients contain duplicates",
    );
  }
  return Object.freeze(recipients);
};

const trustedMessageForActor = (
  payload: SubmitAgentTurnPayload,
  actorId: string,
): Message => {
  const wake = payload.recipientWakes?.get(actorId);
  if (payload.recipientWakes && !wake) {
    throw new TaskWorkerProtocolError(
      `Agent-turn recipient ${actorId} has no private Meta Inbox wake`,
    );
  }
  if (wake) return wake.message;
  if (payload.feedbackMessageId) {
    return Object.freeze({
      ...payload.message,
      sourceInboxIds: [canonicalMetaInboxId(actorId, payload.taskId)],
    });
  }
  throw new TaskWorkerProtocolError(
    `Agent-turn recipient ${actorId} has no private Meta Inbox ingress`,
  );
};

const canonicalMetaInboxId = (actorId: string, taskId: string): string =>
  `meta:${actorId}:${taskId}`;

const parseAgentTurnObservation = (value: unknown): AgentTurnObservation => {
  const record = requiredRecord(value, "Agent-turn observation");
  const runs = requiredArray(
    record.participant_runs,
    "Agent-turn participant runs",
  ).map((item): ParticipantRun => {
    const run = requiredRecord(item, "Agent-turn participant run");
    return Object.freeze({
      actor_id: requiredString(run.actor_id, "Agent-turn Actor ID"),
      agent_management_id: requiredString(
        run.agent_management_id,
        "Agent-turn management ID",
      ),
      agent_run_ref: requiredString(
        run.agent_run_ref,
        "Agent-turn run reference",
      ),
    });
  });
  const terminals = optionalArray(record.participant_terminals).map(
    (item): ParticipantTerminal => {
      const terminal = requiredRecord(item, "Agent-turn participant terminal");
      const status = terminal.status;
      if (
        status !== "succeeded" &&
        status !== "failed" &&
        status !== "canceled"
      ) {
        throw new TaskWorkerProtocolError(
          "Agent-turn terminal status is invalid",
        );
      }
      return Object.freeze({
        agent_run_ref: requiredString(
          terminal.agent_run_ref,
          "Agent-turn terminal run reference",
        ),
        status,
        ...(optionalString(terminal.terminal_code)
          ? { terminal_code: optionalString(terminal.terminal_code) }
          : {}),
        ...(optionalString(terminal.terminal_message)
          ? { terminal_message: optionalString(terminal.terminal_message) }
          : {}),
      });
    },
  );
  return Object.freeze({
    participantRuns: Object.freeze(runs),
    participantTerminals: Object.freeze(terminals),
  });
};

const observedTerminal = (
  observation: LocalTurnObservation | null,
): LocalTurnTerminal | null => {
  if (!observation) return null;
  if (
    observation.status === "succeeded" ||
    observation.status === "failed" ||
    observation.status === "canceled"
  ) {
    if (!observation.terminal) {
      throw new TaskWorkerProtocolError(
        `Local Run ${observation.runId} is terminal without terminal detail`,
      );
    }
    return observation.terminal;
  }
  return null;
};

const toParticipantTerminal = (
  agentRunRef: string,
  terminal: LocalTurnTerminal,
): ParticipantTerminal => {
  switch (terminal.type) {
    case "succeeded":
      return Object.freeze({ agent_run_ref: agentRunRef, status: "succeeded" });
    case "failed":
      return Object.freeze({
        agent_run_ref: agentRunRef,
        status: "failed",
        terminal_message: terminal.error,
      });
    case "canceled":
      return Object.freeze({ agent_run_ref: agentRunRef, status: "canceled" });
  }
};

const localTerminalStatus = (
  terminal: LocalTurnTerminal,
): "succeeded" | "failed" | "canceled" => terminal.type;

const executionContextRef = (value: unknown): ExecutionContextRef => {
  assertExecutionContextRef(value);
  return Object.freeze({ ...value });
};

const parseMessageSegments = (
  value: unknown,
): readonly [MessageSegment, ...MessageSegment[]] => {
  const values = requiredArray(value, "Agent-turn Message segments");
  if (values.length === 0) {
    throw new TaskWorkerProtocolError(
      "Agent-turn Message segments must not be empty",
    );
  }
  const segments = values.map((item): MessageSegment => {
    const segment = requiredRecord(item, "Agent-turn Message segment");
    switch (segment.type) {
      case "text":
        return {
          type: "text",
          content: requiredTextSegmentContent(segment.content),
        };
      case "html_fragment":
        return {
          type: "html_fragment",
          content: requiredTextSegmentContent(segment.content),
        };
      case "reference": {
        const content = requiredString(
          segment.content,
          "Message segment content",
        );
        const targetType = segment.target_type;
        if (targetType !== "agent" && targetType !== "user") {
          throw new TaskWorkerProtocolError(
            "Reference Message segment target type is invalid",
          );
        }
        return {
          type: "reference",
          content,
          target: requiredString(segment.target, "Reference target"),
          target_type: targetType,
        };
      }
      case "file":
        return {
          type: "file",
          content: requiredString(segment.content, "Message segment content"),
          document_id: requiredString(
            segment.document_id,
            "Message Document ID",
          ),
          document_version_id: requiredString(
            segment.document_version_id,
            "Message Document Version ID",
          ),
        };
      case "document":
        if (
          segment.presentation !== undefined &&
          segment.presentation !== "card" &&
          segment.presentation !== "inline"
        ) {
          throw new TaskWorkerProtocolError(
            "Document Message segment presentation is invalid",
          );
        }
        return {
          type: "document",
          content: requiredString(segment.content, "Message segment content"),
          document_id: requiredString(
            segment.document_id,
            "Message Document ID",
          ),
          ...(segment.presentation === undefined
            ? {}
            : { presentation: segment.presentation }),
        };
      case "skill":
        return {
          type: "skill",
          content: requiredString(segment.content, "Message segment content"),
          target: requiredString(segment.target, "Skill target"),
          skill_id: requiredString(segment.skill_id, "Skill ID"),
          manifest_version: requiredString(
            segment.manifest_version,
            "Skill manifest version",
          ),
        };
      default:
        throw new TaskWorkerProtocolError(
          "Agent-turn Message segment type is invalid",
        );
    }
  });
  return Object.freeze([segments[0]!, ...segments.slice(1)]);
};

const driveWithHeartbeat = async (
  client: TeamHubTaskWorkerClient,
  initialLease: TaskWorkerLease,
  leaseSeconds: number,
  signal: AbortSignal,
  operation: (lease: TaskWorkerLease, signal: AbortSignal) => Promise<void>,
): Promise<void> => {
  const heartbeatController = new AbortController();
  const heartbeatSignal = combineSignals(signal, heartbeatController.signal);
  const driveController = new AbortController();
  const driveSignal = combineSignals(signal, driveController.signal);
  let currentLease = initialLease;
  let heartbeatFailure: unknown;
  const intervalMs = Math.max(
    MIN_HEARTBEAT_INTERVAL_MS,
    Math.floor((leaseSeconds * 1_000) / 3),
  );
  const heartbeat = (async () => {
    while (!heartbeatSignal.aborted) {
      await waitForWake(intervalMs, heartbeatSignal);
      if (heartbeatSignal.aborted) return;
      try {
        currentLease = await client.heartbeat({
          lease: currentLease,
          leaseSeconds,
          signal: heartbeatSignal,
        });
      } catch (error) {
        heartbeatFailure = error;
        driveController.abort(error);
        return;
      }
    }
  })();
  try {
    await operation(currentLease, driveSignal);
    if (heartbeatFailure) throw asError(heartbeatFailure);
  } finally {
    heartbeatController.abort();
    driveController.abort();
    await heartbeat;
  }
};

const requireClaimLease = (bundle: TaskWorkerExecution): TaskWorkerLease => {
  if (!bundle.lease) {
    throw new TaskWorkerProtocolError("Claimed Task omitted its Worker lease");
  }
  return bundle.lease;
};

const combineSignals = (
  first: AbortSignal,
  second?: AbortSignal,
): AbortSignal => (second ? AbortSignal.any([first, second]) : first);

const waitForWake = async (
  delayMs: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
  });
};

const requiredStringArray = (value: unknown, name: string): readonly string[] =>
  Object.freeze(
    requiredArray(value, name).map((item) => requiredString(item, name)),
  );

const requiredArray = (value: unknown, name: string): readonly unknown[] => {
  if (!Array.isArray(value))
    throw new TaskWorkerProtocolError(`${name} is invalid`);
  return value;
};

const optionalArray = (value: unknown): readonly unknown[] =>
  value === undefined ? [] : requiredArray(value, "optional array");

const requiredRecord = (
  value: unknown,
  name: string,
): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new TaskWorkerProtocolError(`${name} is invalid`);
  return value;
};

const optionalRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  value === undefined ? undefined : requiredRecord(value, "optional object");

const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TaskWorkerProtocolError(`${name} must be a non-empty string`);
  }
  return value;
};

const requiredTextSegmentContent = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TaskWorkerProtocolError(
      "Message segment content must be a non-empty string",
    );
  }
  return value;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const positiveSafeInteger = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TaskWorkerProtocolError(
      `${name} must be a positive safe integer`,
    );
  }
  return value as number;
};

export class TaskWorkerProtocolError extends Error {
  override readonly name = "TaskWorkerProtocolError";
}
