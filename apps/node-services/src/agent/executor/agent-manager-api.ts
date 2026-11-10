import type { ExecutionContextRef } from "./context-ref.js";
import type {
  RuntimeHistoryInspection,
  RuntimeHistoryOptions,
} from "./history.js";
import type {
  LocalTurnObservation,
  AgentId,
  Message,
  NonEmptyReadonlyArray,
  RunCancellationStatus,
  AgentManagerStatus,
  AgentUpdateOptions,
  RegisteredAgent,
} from "./types.js";
import type { AgentUpdate, Ghost, GhostRegistration } from "./ghost.js";

export interface ExecutionContextMessageDelivery {
  readonly target: ExecutionContextRef;
  readonly messages: NonEmptyReadonlyArray<Message>;
}

export interface AgentRegistrationIdentityReservation {
  readonly agentId: AgentId;
}

export interface AgentDeletionOptions {
  readonly beforeIdentityRemoval?: () => Promise<void>;
}

export interface AgentManagerApi<TRuntimeSettings> {
  cancelLocalRun(
    ref: ExecutionContextRef,
    runId: string,
  ): Promise<RunCancellationStatus>;

  getGhost(agentId: AgentId): Promise<Readonly<Ghost<TRuntimeSettings>> | null>;

  /**
   * Reads the Agent's registration from TeamHub again after TeamHub committed
   * a change to it. Returns null when the Agent is no longer active. Loaded
   * Contexts adopt a new revision at their next input.
   */
  refreshAgent(
    agentId: AgentId,
  ): Promise<Readonly<Ghost<TRuntimeSettings>> | null>;

  deleteAgent(
    agentId: AgentId,
    options?: AgentDeletionOptions,
  ): Promise<"deleted" | "not_found">;
}

export interface AgentDebugInspectionApi {
  inspectDebugContextHistory(
    ref: ExecutionContextRef,
    options: RuntimeHistoryOptions,
  ): Promise<RuntimeHistoryInspection>;
}

export type AgentIdentityResolutionErrorKind =
  | "transient"
  | "not_found"
  | "permanent";

export class AgentIdentityResolutionError extends Error {
  constructor(
    readonly kind: AgentIdentityResolutionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "AgentIdentityResolutionError";
  }
}

export type AgentManagerErrorCode =
  | "agent_registration_conflict"
  | "agent_deleting"
  | "agent_not_registered"
  | "agent_busy"
  | "agent_activation_pending"
  | "agent_activation_rejected"
  | "agent_revision_conflict"
  | "binding_not_found"
  | "identity_resolution_failed"
  | "identity_unavailable"
  | "invalid_runtime"
  | "invalid_state"
  | "message_conflict"
  | "manager_closed";

export class AgentManagerError extends Error {
  constructor(
    readonly code: AgentManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentManagerError";
  }
}

/** The Agent registration is not yet active at the Context's revision. */
export function isActivationPending(error: unknown): boolean {
  return (
    error instanceof AgentManagerError &&
    error.code === "agent_activation_pending"
  );
}

export interface AgentManager<TRuntimeSettings>
  extends AgentManagerApi<TRuntimeSettings>, AgentDebugInspectionApi {
  /** Writes a Ghost into a process-local store; TeamHub-backed stores only check it. */
  registerAgent(
    ghost: GhostRegistration<TRuntimeSettings>,
    identity: AgentRegistrationIdentityReservation,
  ): Promise<RegisteredAgent>;

  updateAgent?(
    agentId: AgentId,
    update: AgentUpdate<TRuntimeSettings>,
    options?: AgentUpdateOptions,
  ): Promise<RegisteredAgent>;

  restore(options?: { readonly onlyUnmaterialized?: boolean }): Promise<void>;

  ensureBinding(ref: ExecutionContextRef): Promise<void>;

  ensureAgentIdentity(agentId: AgentId): Promise<void>;

  submitTrustedTurn(
    delivery: ExecutionContextMessageDelivery,
  ): Promise<{ readonly agentRunRef: string }>;

  cancelTrustedTurn(delivery: ExecutionContextMessageDelivery): Promise<{
    readonly agentRunRef: string;
    readonly cancelStatus: RunCancellationStatus;
  }>;

  /**
   * Puts one trusted message into the Context's running turn. Returns the
   * steered Run, or null when no turn is running in this process; the caller
   * then submits the message as the next turn instead.
   */
  steerActiveTurn(delivery: {
    readonly target: ExecutionContextRef;
    readonly message: Message;
  }): Promise<{ readonly agentRunRef: string } | null>;

  observeTurn(
    ref: ExecutionContextRef,
    agentRunRef: string,
  ): Promise<LocalTurnObservation | null>;

  getContextStatus(
    ref: ExecutionContextRef,
  ): Promise<AgentManagerStatus | null>;

  startContext(ref: ExecutionContextRef): Promise<void>;
  resumeContext(ref: ExecutionContextRef): Promise<void>;
  suspendContext(ref: ExecutionContextRef): Promise<void>;
  stopContext(ref: ExecutionContextRef): Promise<void>;

  close(options?: { readonly runGracePeriodMs?: number }): Promise<void>;
}
