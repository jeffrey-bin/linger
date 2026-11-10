import type {
  AgentCliCredentialFailed,
  AgentCliCredentialPut,
  AgentCliCredentialStored,
  AgentToDaemonEnvelope,
  CapabilitySkillsFailed,
  CapabilitySkillsScanned,
  DaemonToAgentEnvelope,
  DebugInspect,
  DebugInspected,
  DebugHistoryInspectionRequest,
  DebugHistoryInspectionResult,
  RunnerCapability,
  RunnerHello,
} from "@linger/wire-contracts/runner-gateway/types";
import { randomUUID } from "node:crypto";
import type {
  AgentCliCredentialIssuer,
  AgentCliProfile,
} from "./agent-cli-credential-issuer.js";
import type { AgentRunnerLifecycle } from "./agent-runner-lifecycle.js";
import { AgentRunnerConnectionReconciliation } from "./agent-runner-reconciliation.js";
import type { ComputerRelease } from "./computer-release.js";
import type { ContextViewContent } from "./context-view-content.js";
import type { ComputerDaemonIdentityVerifier } from "./daemon-identity-verifier.js";
import {
  DEFAULT_LOCAL_RUNTIME_MODELS,
  validateRuntimeModelCatalog,
  type LocalPlacementRequirement,
  type LocalReasoningEffort,
  type LocalRuntimeModelCatalog,
} from "./local-computer-management.js";
import type { LocalComputerRegistry } from "./local-computer-registry.js";
import type { RunnerCliCredentials } from "./runner-cli-credentials.js";
import type { RunnerConnections } from "./runner-connections.js";
import type { RunnerDebugInspection } from "./runner-debug-inspection.js";
import type { RunnerLocalCapabilities } from "./runner-local-capabilities.js";
import type { RunnerOperationPreparation } from "./runner-operation-preparation.js";
import {
  RunnerOperationState,
  type OperationEnvelope,
} from "./runner-operation.js";
import type { RunnerOperations } from "./runner-operations.js";
import { operationMCPPrepareIdentity } from "./runner-operations.js";
import type { RunnerComputerTools } from "./runner-computer-tools.js";
import type { ModelQueue } from "./model-queue.js";
import type { RunnerModelInvocation } from "./runner-model-invocation.js";
import type { RunnerSessionCompaction } from "./runner-session-compaction.js";

export type AgentCliCredentialOutcome =
  | AgentCliCredentialStored
  | AgentCliCredentialFailed;

export type LocalSkillOutcome =
  | CapabilitySkillsScanned
  | CapabilitySkillsFailed;

export interface LocalContextRunIdentity {
  readonly computerId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly runnerRevision: number;
  readonly workspaceGrantId: string;
  readonly executionRunRef: string;
  readonly executionContextKey: string;
  readonly runtimeInstanceId: string;
  readonly viewDigest: string;
}

export type LocalMcpRelayRunIdentity = LocalContextRunIdentity;

export interface LocalContextViewIdentity {
  readonly computerId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly runnerRevision: number;
  readonly workspaceGrantId: string;
  readonly executionContextKey: string;
  readonly runtimeInstanceId: string;
  readonly viewDigest: string;
}

/** The Agent Runner whose Computer must hold a usable TeamHub CLI credential. */
export interface AgentCliCredentialEnsure {
  readonly computerId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly runnerRevision: number;
  readonly workspaceGrantId: string;
  readonly signal?: AbortSignal;
}

export interface RunnerAgentCliCredentialController {
  ensureAgentCliCredential(options: AgentCliCredentialEnsure): Promise<void>;
}

export interface DetachedLocalHistoryRequest {
  readonly placement: import("./local-computer-management.js").LocalPlacementRequirement;
  readonly agentId: string;
  readonly executionContextKey: string;
  readonly runtimeInstanceId: string;
  readonly request: DebugHistoryInspectionRequest;
  readonly signal?: AbortSignal;
}

export interface RunnerContextDebugInspector {
  inspectDetachedLocalHistory?(
    options: DetachedLocalHistoryRequest,
  ): Promise<DebugHistoryInspectionResult>;
  inspectLocalContext(options: {
    readonly context: LocalContextViewIdentity;
    readonly request: DebugHistoryInspectionRequest;
    readonly signal?: AbortSignal;
  }): Promise<DebugHistoryInspectionResult>;
}

// The peer runs this after asynchronous preparation. The guard must call write
// synchronously inside its coordination boundary; transport completion is outside.
export type RunnerGatewayWriteGuard = (write: () => void) => Promise<void>;

export interface RunnerGatewayPeer {
  send(
    envelope: AgentToDaemonEnvelope,
    guardWrite?: RunnerGatewayWriteGuard,
  ): Promise<void>;
  close(code: number, reason: string): void;
}

export interface RunnerGatewayConnection {
  recordActivity(envelope: DaemonToAgentEnvelope): void;
  receive(envelope: DaemonToAgentEnvelope): Promise<void>;
  /**
   * An Operation frame that failed the Runner contract. Only its identity
   * fields were checked; the gateway compares them with a known Operation.
   */
  receiveInvalidOperation(frame: InvalidOperationFrame): Promise<void>;
  /** A executed debug_history frame that failed the Runner contract. */
  receiveInvalidDebugInspection(commandId: string): void;
  disconnect(): void;
}

export interface InvalidOperationFrame {
  /** Unvalidated frame; only identity fields may be read from it. */
  readonly frame: OperationEnvelope;
  readonly details: string;
}

/** A run.start Runner Operation of a Run, and its usage once it ended. */
export interface RunnerRunOperationRecord {
  readonly contextKey: string;
  readonly epoch: string;
  readonly runId: string;
  readonly operationId: string;
  readonly runtimeType: "codex" | "claude" | "pi";
  readonly usage?: readonly Record<string, unknown>[];
}

export interface RunnerGatewayOptions {
  /**
   * Refuses Computers until openConnections: a new process opens its epoch
   * first, and the epoch records every Computer offline.
   */
  readonly openConnectionsLater?: boolean;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly operationCancelTimeoutMs?: number;
  readonly createId?: () => string;
  readonly runtimeModels?: LocalRuntimeModelCatalog;
  /**
   * Turns on Context View content for Computers: the welcome names the URL
   * they fetch manifests and files from while that connection is current.
   */
  readonly contextContent?: {
    readonly publicOrigin: string;
    readonly signingKey: string;
  };
  readonly computerRegistry?: LocalComputerRegistry;
  /** Records each run.start Operation on its Run in TeamHub. */
  readonly recordRunOperation?: (
    record: RunnerRunOperationRecord,
  ) => Promise<void>;
  /** The Computer release this image ships; absent, no Computer updates itself. */
  readonly computerRelease?: ComputerRelease;
  readonly agentRunnerReadyTimeoutMs?: number;
  readonly debugInspectionTimeoutMs?: number;
  readonly computerDaemonIdentityVerifier: ComputerDaemonIdentityVerifier;
  readonly localComputerReconnectWaitMs?: number;
  /** Issues the CLI credentials pushed to Computers. Required for Local Runs. */
  readonly agentCliCredentialIssuer?: AgentCliCredentialIssuer;
}

export interface LocalAgentRunnerOptions {
  readonly placement: LocalPlacementRequirement;
  readonly modelId: string;
  readonly reasoningEffort?: LocalReasoningEffort;
  readonly agentId: string;
  readonly signal?: AbortSignal;
}

export interface ConnectedRunner {
  readonly connectionId: string;
  readonly runnerId: string;
  readonly tenantOwners: ReadonlyMap<string, string>;
  readonly peer: RunnerGatewayPeer;
  readonly hello: RunnerHello;
  readonly capabilities: ReadonlySet<RunnerCapability>;
  readonly connectionEpoch: number;
  readonly pendingOperations: readonly RunnerOperationState[];
  readonly reportedActiveOperations: RunnerHello["active_operations"];
  readonly retiredOperationPreparations: Map<
    string,
    RetiredOperationPreparation
  >;
  readonly agentRunnerReconciliation: AgentRunnerConnectionReconciliation;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  lastActivityAtMs?: number;
  lastSeenWrittenAtMs?: number;
  connected: boolean;
  phase: "reconciling" | "ready";
  operationReconciled: boolean;
  runtimeDiagnosticsRevision: number;
  registrationSnapshotCommandId?: string;
}

export interface AgentRunnerStateWaiter {
  readonly runnerRevision: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

export interface DebugInspectionWaiter {
  readonly command: DebugInspect;
  readonly signal: AbortSignal | undefined;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onAbort: () => void;
  resolve(outcome: DebugInspected): void;
  reject(error: unknown): void;
}

export type AgentCliCredentialIdentity = Pick<
  AgentCliCredentialPut,
  | "protocol_version"
  | "command_id"
  | "tenant_id"
  | "registration_id"
  | "assignment_revision"
  | "runner_id"
  | "agent_id"
  | "connection_epoch"
  | "runner_revision"
>;

export interface AgentCliCredentialWaiter {
  readonly identity: AgentCliCredentialIdentity;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
  resolve(outcome: AgentCliCredentialOutcome): void;
  reject(error: unknown): void;
}

/**
 * A CLI credential the Computer holds, as it reported it, and the Runtime
 * Assignment TeamHub issued it for; never the token.
 */
export interface StoredAgentCliCredential {
  readonly assignmentRevision: number;
  readonly profile: AgentCliProfile;
  /** SHA-256 of the held token, the hash TeamHub records. */
  readonly sha256: string;
  /**
   * TeamHub confirmed or issued this token on the current connection. A
   * reported token is checked once, because a push may have failed after
   * TeamHub revoked it, or an operator may have revoked it.
   */
  readonly verified: boolean;
}

/** Per connection: what the Computer holds for each Agent, and issuances in flight. */
export interface AgentCliCredentialState {
  readonly stored: Map<string, StoredAgentCliCredential>;
  readonly issuances: Map<
    string,
    {
      readonly assignmentRevision: number | undefined;
      readonly work: Promise<void>;
    }
  >;
}

export interface CapacitySignal {
  readonly changed: Promise<void>;
  readonly notify: () => void;
}

export interface RetiredOperationPreparation {
  readonly commandId: string;
  readonly identity: ReturnType<typeof operationMCPPrepareIdentity>;
}
export interface RunnerGatewayContext {
  readonly options: RunnerGatewayOptions;
  readonly heartbeatIntervalMs: number;
  readonly createId: () => string;
  readonly heartbeatTimeoutMs: number;
  readonly operationCancelTimeoutMs: number;
  readonly agentRunnerReadyTimeoutMs: number;
  readonly debugInspectionTimeoutMs: number;
  readonly localComputerReconnectWaitMs: number;
  readonly runtimeModels: LocalRuntimeModelCatalog;
  readonly agentCliCredentialIssuer: AgentCliCredentialIssuer | undefined;
  readonly computerRegistry: LocalComputerRegistry | undefined;
  readonly computerDaemonIdentityVerifier: ComputerDaemonIdentityVerifier;
}
export interface RunnerGatewayControllers {
  readonly connections: () => RunnerConnections;
  readonly lifecycle: () => AgentRunnerLifecycle;
  readonly operations: () => RunnerOperations;
  readonly debug: () => RunnerDebugInspection;
  readonly capabilities: () => RunnerLocalCapabilities;
  readonly cli: () => RunnerCliCredentials;
  readonly preparation: () => RunnerOperationPreparation;
  readonly compaction: () => RunnerSessionCompaction;
  readonly modelInvocation: () => RunnerModelInvocation;
  readonly queue: () => ModelQueue;
  readonly computerTools: () => RunnerComputerTools;
  readonly contextViewContent: () => ContextViewContent | undefined;
}
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_OPERATION_CANCEL_TIMEOUT_MS = 15_000;
const DEFAULT_AGENT_RUNNER_READY_TIMEOUT_MS = 10_000;
const DEFAULT_DEBUG_INSPECTION_TIMEOUT_MS = 15_000;
const DEFAULT_LOCAL_COMPUTER_RECONNECT_WAIT_MS = 30_000;
export function createRunnerGatewayContext(
  options: RunnerGatewayOptions,
): RunnerGatewayContext {
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const createId = options.createId ?? randomUUID;
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs ?? heartbeatIntervalMs * 3;
  const operationCancelTimeoutMs =
    options.operationCancelTimeoutMs ?? DEFAULT_OPERATION_CANCEL_TIMEOUT_MS;
  const agentRunnerReadyTimeoutMs =
    options.agentRunnerReadyTimeoutMs ?? DEFAULT_AGENT_RUNNER_READY_TIMEOUT_MS;
  const debugInspectionTimeoutMs =
    options.debugInspectionTimeoutMs ?? DEFAULT_DEBUG_INSPECTION_TIMEOUT_MS;
  const localComputerReconnectWaitMs =
    options.localComputerReconnectWaitMs ??
    DEFAULT_LOCAL_COMPUTER_RECONNECT_WAIT_MS;
  const runtimeModels = validateRuntimeModelCatalog(
    options.runtimeModels ?? DEFAULT_LOCAL_RUNTIME_MODELS,
  );
  const computerRegistry = options.computerRegistry;
  const agentCliCredentialIssuer = options.agentCliCredentialIssuer;
  return {
    options,
    heartbeatIntervalMs,
    createId,
    heartbeatTimeoutMs,
    operationCancelTimeoutMs,
    agentRunnerReadyTimeoutMs,
    debugInspectionTimeoutMs,
    localComputerReconnectWaitMs,
    runtimeModels,
    agentCliCredentialIssuer,
    computerRegistry,
    computerDaemonIdentityVerifier: options.computerDaemonIdentityVerifier,
  };
}
export function validateRunnerGatewayContext(
  context: RunnerGatewayContext,
): void {
  if (
    !Number.isSafeInteger(context.heartbeatIntervalMs) ||
    context.heartbeatIntervalMs < 1_000
  ) {
    throw new TypeError(
      "Runner Gateway heartbeat interval must be a safe integer of at least 1000ms",
    );
  }
  if (
    !Number.isSafeInteger(context.heartbeatTimeoutMs) ||
    context.heartbeatTimeoutMs <= 0 ||
    !Number.isSafeInteger(context.operationCancelTimeoutMs) ||
    context.operationCancelTimeoutMs <= 0 ||
    !Number.isSafeInteger(context.agentRunnerReadyTimeoutMs) ||
    context.agentRunnerReadyTimeoutMs <= 0 ||
    !Number.isSafeInteger(context.debugInspectionTimeoutMs) ||
    context.debugInspectionTimeoutMs <= 0 ||
    !Number.isSafeInteger(context.localComputerReconnectWaitMs) ||
    context.localComputerReconnectWaitMs < 0
  ) {
    throw new TypeError(
      "Runner Gateway deadlines must be positive safe integers",
    );
  }
}
