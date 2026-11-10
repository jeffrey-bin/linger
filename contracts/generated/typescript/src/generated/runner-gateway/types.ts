/** Generated from contracts/runner-gateway/envelope.schema.json. Do not edit. */

export type RunnerGatewayEnvelope =
  | AgentToDaemonEnvelope
  | DaemonToAgentEnvelope;
export type AgentToDaemonEnvelope =
  | RunnerWelcome
  | RunnerReconciled
  | RuntimeRegistrationSnapshot
  | AgentRunnerEnsure
  | AgentRunnerRemove
  | AgentCliCredentialPut
  | DebugInspect
  | CapabilitySkillsScan
  | CapabilityBrowserConnect
  | CapabilityComputerPermission
  | OperationPrepare
  | ProviderPrepare
  | SessionCompact
  | ModelInvoke
  | OperationStart
  | OperationInput
  | OperationCancel
  | OperationAck
  | ComputerToolCall;
export type ProtocolVersion = "2";
export type Id = string;
export type PositiveInteger = number;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [k: string]: JsonValue;
    };
export type AgentRunnerEnsure = AgentRunnerWireIdentity & {
  type: "agent_runner.ensure";
  runtime: RuntimeConfig;
  workspace_grant_id: Id;
  registration_id: Id;
  assignment_revision: PositiveInteger;
};
export type AgentRunnerRemove = AgentRunnerWireIdentity & {
  type: "agent_runner.remove";
};
export type AgentCliCredentialPut = AgentRunnerWireIdentity & {
  type: "execute";
  profile: AgentCliProfile;
  access_token: string;
  registration_id: Id;
  assignment_revision: PositiveInteger;
  kind: "cli_credential";
};
export type ExecutionContextKey = string;
export type Sha256 = string;
export type CapabilitySkillsScan = LocalSkillCommandIdentity & {
  type: "execute";
  scan_id: Id;
  runtime_type: "codex" | "claude" | "pi";
  kind: "skills_scan";
};
export type Timestamp = string;
export type CapabilityBrowserConnect = LocalSkillCommandIdentity & {
  type: "execute";
  action: "status" | "configure" | "disconnect";
  profile?: BrowserProfile;
  /**
   * Playwright Extension token, only with configure. The daemon stores it privately and never returns it.
   */
  extension_token?: string;
  kind: "browser_connect";
};
/**
 * A Chrome profile directory name inside the user's Chrome data directory.
 */
export type BrowserProfile = string;
export type CapabilityComputerPermission = LocalSkillCommandIdentity & {
  type: "execute";
  action: "status" | "prompt" | "open_settings" | "relaunch";
  /**
   * Required for every action except status.
   */
  subject?: "linger" | "computer_use";
  /**
   * Required for prompt and open_settings.
   */
  permission?: "screen_recording" | "accessibility";
  kind: "computer_permission";
};
export type OperationPrepare = OperationIdentity & {
  type: "prepare";
  command_id: Id;
  host_access?: "trusted";
  runtime: RuntimeConfig;
  session_options: SessionOptions;
  session: OpaqueObject;
  permission_review?: true;
  /**
   * @maxItems 64
   */
  mcp_relays: LocalMcpRelayDescriptor[];
  target: "operation";
};
export type OperationIdentity = OperationScope & {
  protocol_version: ProtocolVersion;
  tenant_id: Id;
  registration_id: Id;
  assignment_revision: PositiveInteger;
  runner_id: Id;
  execution_context_key?: ExecutionContextKey;
  runtime_instance_id?: ExecutionContextKey;
  context_view_ref?: ContextViewRef;
  agent_id: Id;
  operation_id: Id;
  connection_epoch: PositiveInteger;
  runner_revision: PositiveInteger;
  generation: PositiveInteger;
  execution_lease_id: Id;
  workspace_grant_id: Id;
  runtime_type: "codex" | "claude" | "pi";
};
export type OperationStart = OperationScope & {
  type: "operation.start";
  protocol_version: ProtocolVersion;
  command_id: Id;
  tenant_id: Id;
  registration_id: Id;
  assignment_revision: PositiveInteger;
  runner_id: Id;
  execution_context_key?: ExecutionContextKey;
  runtime_instance_id?: ExecutionContextKey;
  context_view_ref?: ContextViewRef;
  agent_id: Id;
  operation_id: Id;
  connection_epoch: PositiveInteger;
  runner_revision: PositiveInteger;
  generation: PositiveInteger;
  execution_lease_id: Id;
  workspace_grant_id: Id;
  runtime_type: "codex" | "claude" | "pi";
  host_access?: "trusted";
  request: RuntimeOperationRequest;
};
export type RuntimeOperationRequest = ContextRunStartRequest;
export type OperationInput = OperationIdentity & {
  type: "operation.input";
  command_id: Id;
  expected_turn_id: Id;
  input_context_view_ref: ContextViewRef;
  input: AgentInput;
};
export type OperationCancel = OperationIdentity & {
  type: "cancel";
  command_id: Id;
  reason: string;
  target: "operation";
};
export type OperationAck = OperationIdentity & {
  type: "operation.ack";
  command_id: Id;
  through_seq: PositiveInteger;
};
/**
 * TeamHub identifier used as a single directory segment on every platform.
 */
export type SharedTaskScopeId = string;
export type DaemonToAgentEnvelope =
  | RunnerHello
  | RunnerHeartbeat
  | RunnerRuntimeDiagnostics
  | RuntimeRegistrationObserved
  | AgentRunnerReady
  | AgentRunnerRemoved
  | AgentRunnerFailed
  | AgentCliCredentialStored
  | AgentCliCredentialFailed
  | DebugInspected
  | CapabilitySkillsScanned
  | CapabilitySkillsFailed
  | CapabilityBrowserConnected
  | CapabilityBrowserFailed
  | CapabilityComputerPermissionSucceeded
  | CapabilityComputerPermissionFailed
  | OperationPrepared
  | ProviderPrepared
  | SessionCompacted
  | ModelInvoked
  | OperationAccepted
  | OperationEvent
  | OperationInputAck
  | OperationInputRejected
  | OperationInputClosed
  | OperationCompleted
  | OperationFailed
  | OperationCancelled
  | ComputerToolResult;
/**
 * @minItems 1
 * @maxItems 3
 */
export type RuntimeDiagnostics =
  | [RuntimeDiagnostic]
  | [RuntimeDiagnostic, RuntimeDiagnostic]
  | [RuntimeDiagnostic, RuntimeDiagnostic, RuntimeDiagnostic];
/**
 * @maxItems 100
 */
export type ManagedServices = ManagedService[];
/**
 * A host feature the Computer has. Every other v2 behavior is part of protocol 2 itself.
 */
export type RunnerCapability = "browser_connection" | "computer_permissions";
export type AgentRunnerSnapshot =
  | {
      runner_id: Id;
      tenant_id: Id;
      registration_id: Id;
      assignment_revision: PositiveInteger;
      agent_id: Id;
      runner_revision: PositiveInteger;
      state: "ready";
      runtime: RuntimeConfig;
      workspace_grant_id: Id;
      runner_pid: PositiveInteger;
    }
  | {
      runner_id: Id;
      tenant_id: Id;
      registration_id?: Id;
      assignment_revision?: PositiveInteger;
      agent_id: Id;
      runner_revision: PositiveInteger;
      state: "removed";
    }
  | {
      runner_id: Id;
      tenant_id: Id;
      registration_id?: Id;
      assignment_revision?: PositiveInteger;
      agent_id: Id;
      runner_revision: PositiveInteger;
      state: "failed";
      runtime?: RuntimeConfig;
      workspace_grant_id?: Id;
      error: AgentRunnerError;
    };
export type ActiveOperation = OperationScope & {
  protocol_version?: ProtocolVersion;
  host_access?: "trusted";
  tenant_id: Id;
  registration_id: Id;
  assignment_revision: PositiveInteger;
  runner_id: Id;
  execution_context_key?: ExecutionContextKey;
  runtime_instance_id?: ExecutionContextKey;
  context_view_ref?: ContextViewRef;
  agent_id: Id;
  operation_id: Id;
  connection_epoch: PositiveInteger;
  runner_revision: PositiveInteger;
  generation: PositiveInteger;
  execution_lease_id: Id;
  workspace_grant_id: Id;
  runtime_type: "codex" | "claude" | "pi";
  kind: "run.start";
  last_emitted_seq: NonNegativeInteger;
  last_acked_seq: NonNegativeInteger;
};
export type NonNegativeInteger = number;
export type AgentRunnerReady = AgentRunnerWireIdentity & {
  type: "agent_runner.state";
  runner_pid: PositiveInteger;
  cli_credential?: AgentCliCredentialReport;
  registration_id: Id;
  assignment_revision: PositiveInteger;
  state: "ready";
};
export type AgentRunnerRemoved = AgentRunnerWireIdentity & {
  type: "agent_runner.state";
  state: "removed";
};
export type AgentRunnerFailed = AgentRunnerWireIdentity & {
  type: "agent_runner.state";
  error: AgentRunnerError;
  state: "failed";
};
export type AgentCliCredentialStored = AgentRunnerWireIdentity & {
  type: "executed";
  /**
   * SHA-256 of the stored token itself.
   */
  sha256: string;
  registration_id: Id;
  assignment_revision: PositiveInteger;
  kind: "cli_credential";
  outcome: "succeeded";
};
export type AgentCliCredentialFailed = AgentRunnerWireIdentity & {
  type: "executed";
  error: AgentRunnerError;
  registration_id: Id;
  assignment_revision: PositiveInteger;
  kind: "cli_credential";
  outcome: "failed";
};
export type DebugInspectionStatus = "available" | "unsupported" | "unavailable";
export type CapabilitySkillsScanned = LocalSkillCommandIdentity & {
  type: "executed";
  scan_id: Id;
  runtime_type: "codex" | "claude" | "pi";
  /**
   * @maxItems 256
   */
  items: LocalSkillCandidate[];
  kind: "skills_scan";
  outcome: "succeeded";
};
export type CapabilitySkillsFailed = LocalSkillCommandIdentity & {
  type: "executed";
  stage: "scan";
  scan_id?: Id;
  error: AgentRunnerError;
  kind: "skills_scan";
  outcome: "failed";
};
export type CapabilityBrowserConnected = LocalSkillCommandIdentity & {
  type: "executed";
  action: "status" | "configure" | "disconnect";
  status: BrowserConnectionStatus;
  kind: "browser_connect";
  outcome: "succeeded";
};
export type CapabilityBrowserFailed = LocalSkillCommandIdentity & {
  type: "executed";
  action: "status" | "configure" | "disconnect";
  error: AgentRunnerError;
  kind: "browser_connect";
  outcome: "failed";
};
export type CapabilityComputerPermissionSucceeded =
  LocalSkillCommandIdentity & {
    type: "executed";
    action: "status" | "prompt" | "open_settings" | "relaunch";
    status: ComputerPermissionStatus;
    kind: "computer_permission";
    outcome: "succeeded";
  };
export type CapabilityComputerPermissionFailed = LocalSkillCommandIdentity & {
  type: "executed";
  action: "status" | "prompt" | "open_settings" | "relaunch";
  error: AgentRunnerError;
  kind: "computer_permission";
  outcome: "failed";
};
export type OperationPrepared = OperationIdentity & {
  type: "prepared";
  command_id: Id;
  prepare_command_id: Id;
  prepared: boolean;
  prepare_native_resume?: NativeResumeMeasurement;
  outcome: "ready" | "fallback";
  duration_ms: NonNegativeInteger;
  error?: AgentRunnerError;
  reason?: string;
  target: "operation";
};
export type OperationAccepted = OperationIdentity & {
  type: "operation.accepted";
  seq: PositiveInteger;
  command_id: Id;
  runner_pid: PositiveInteger;
  runtime_pid?: PositiveInteger;
  session?: OpaqueObject;
};
export type OperationEvent = OperationIdentity & {
  type: "operation.event";
  seq: PositiveInteger;
  event: RunEvent;
};
export type RunEvent =
  | {
      type: "human_interaction.requested";
      request: OpaqueObject;
    }
  | {
      type: "run.started";
      turn_id: Id;
      session?: OpaqueObject;
      process_reused?: boolean;
      dispatched_at_unix_ms?: NonNegativeInteger;
    }
  | {
      type: "status.changed";
      status: "working";
    }
  | {
      type: "status.changed";
      status: "thinking";
      title?: string;
    }
  | {
      type: "plan.updated";
      explanation?: string;
      /**
       * @maxItems 1024
       */
      steps: RunPlanStep[];
    }
  | {
      type: "activity.started";
      activity_id: Id;
      kind:
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
      title: string;
      /**
       * @maxItems 6
       */
      content?:
        | []
        | [RunActivityContentBlock]
        | [RunActivityContentBlock, RunActivityContentBlock]
        | [
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
          ]
        | [
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
          ]
        | [
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
          ]
        | [
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
          ];
    }
  | {
      type: "activity.updated";
      activity_id: Id;
      detail: string;
    }
  | {
      type: "activity.finished";
      activity_id: Id;
      outcome: "succeeded" | "failed" | "canceled" | "declined";
      /**
       * @maxItems 6
       */
      content?:
        | []
        | [RunActivityContentBlock]
        | [RunActivityContentBlock, RunActivityContentBlock]
        | [
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
          ]
        | [
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
          ]
        | [
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
          ]
        | [
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
            RunActivityContentBlock,
          ];
    }
  | {
      type: "message.delta";
      message_id: Id;
      delta: string;
      observed_at_unix_ms?: NonNegativeInteger;
    }
  | {
      type: "tool.called";
      call_id: Id;
      tool_name: string;
      input: JsonValue;
      observed_at_unix_ms?: NonNegativeInteger;
    }
  | {
      type: "tool.returned";
      call_id: Id;
      tool_name: string;
      output: string | JsonValue;
      is_error: boolean;
      observed_at_unix_ms?: NonNegativeInteger;
    }
  | {
      type: "model.responded";
      responded_at_unix_ms: NonNegativeInteger;
      started_at_unix_ms: NonNegativeInteger;
      first_item_at_unix_ms?: NonNegativeInteger;
      granularity: "item" | "block" | "delta";
      model?: string;
      message_id?: Id;
      usage: RunTokenCounts;
      /**
       * Present for a sub-agent's request; absent for the Run's own agent.
       */
      agent?: {
        id: Id;
        parent_call_id?: Id;
      };
    }
  | {
      type: "file.created" | "file.updated" | "file.deleted";
      path: string;
    }
  | {
      type: "run.completed";
    }
  | {
      type: "run.failed";
      message: string;
    };
export type OperationInputAck = OperationIdentity & {
  type: "operation.input_result";
  seq: PositiveInteger;
  command_id: Id;
  turn_id: Id;
  outcome: "accepted";
};
export type OperationInputRejected = OperationIdentity & {
  type: "operation.input_result";
  seq: PositiveInteger;
  command_id: Id;
  expected_turn_id: Id;
  actual_turn_id?: Id;
  effect: "definitely_not_applied" | "uncertain";
  reason:
    | "target_mismatch"
    | "no_active_turn"
    | "rejected"
    | "ack_mismatch"
    | "transport";
  message: string;
  outcome: "rejected";
};
/**
 * Durable command receipt for an input targeting a terminal Operation. Does not belong to or advance the immutable Operation event sequence.
 */
export type OperationInputClosed = OperationIdentity & {
  type: "operation.input_result";
  command_id: Id;
  expected_turn_id: Id;
  effect: "definitely_not_applied" | "uncertain";
  outcome: "closed";
};
export type OperationCompleted = OperationIdentity & {
  type: "operation.completed";
  seq: PositiveInteger;
  result: OperationResult;
};
export type OperationResult = RunResult;
/**
 * @minItems 1
 * @maxItems 32
 */
export type RunUsage = [
  {
    input: NonNegativeInteger;
    cache_read: NonNegativeInteger;
    cache_write: NonNegativeInteger;
    output: NonNegativeInteger;
    reasoning?: NonNegativeInteger;
    model: string;
    provider: "openai" | "anthropic" | "unknown";
    last?: RunTokenCounts;
    compaction_count?: NonNegativeInteger;
  },
  ...{
    input: NonNegativeInteger;
    cache_read: NonNegativeInteger;
    cache_write: NonNegativeInteger;
    output: NonNegativeInteger;
    reasoning?: NonNegativeInteger;
    model: string;
    provider: "openai" | "anthropic" | "unknown";
    last?: RunTokenCounts;
    compaction_count?: NonNegativeInteger;
  }[],
];
export type OperationFailed = OperationIdentity & {
  native_resume?: NativeResumeMeasurement;
  prepare_native_resume?: NativeResumeMeasurement;
  usage?: RunUsage;
  type: "operation.failed";
  seq: PositiveInteger;
  stage?:
    | "operation_admission"
    | "workspace_preparation"
    | "runtime_execution"
    | "runtime_cleanup";
  error: {
    code: Id;
    message: string;
    retryable: boolean;
    failure?: RuntimeExecutionFailure;
    diagnostics?: RuntimeFailureDiagnostics;
  };
};
export type OperationCancelled = OperationIdentity & {
  native_resume?: NativeResumeMeasurement;
  prepare_native_resume?: NativeResumeMeasurement;
  usage?: RunUsage;
  type: "operation.cancelled";
  seq: PositiveInteger;
  reason: string;
};

export interface RunnerWelcome {
  type: "runner.welcome";
  protocol_version: ProtocolVersion;
  runner_id: Id;
  connection_id: Id;
  connection_epoch: PositiveInteger;
  heartbeat_interval_ms: number;
  reconcile_operation_ids: Id[];
  target_release?: ComputerTargetRelease;
  /**
   * Base URL the Computer fetches Context View manifests (views/<view_digest>) and files (files/<sha256>) from while this connection is current.
   */
  context_content_url?: string;
}
export interface ComputerTargetRelease {
  targets: {
    [k: string]: {
      app: ComputerReleaseArchive;
      deps: ComputerReleaseArchive;
    };
  };
}
export interface ComputerReleaseArchive {
  sha256: string;
  size: number;
}
export interface RunnerReconciled {
  type: "runner.reconciled";
  protocol_version: ProtocolVersion;
  runner_id: Id;
  connection_epoch: PositiveInteger;
}
export interface RuntimeRegistrationSnapshot {
  type: "runtime.registration.snapshot";
  protocol_version: ProtocolVersion;
  command_id: Id;
  runner_id: Id;
  connection_epoch: PositiveInteger;
  /**
   * @maxItems 256
   */
  registrations: RuntimeRegistration[];
}
export interface RuntimeRegistration {
  registration_id: Id;
  observation: RuntimeRegistrationObservation;
}
export interface RuntimeRegistrationObservation {
  tenant_id: Id;
  owner_actor_id: Id;
  provider_type: "codex" | "claude" | "pi";
  status: "online" | "offline" | "unavailable";
  revision: PositiveInteger;
  capabilities: Id[];
  runtime_diagnostics: {
    [k: string]: JsonValue;
  };
}
export interface AgentRunnerWireIdentity {
  protocol_version: ProtocolVersion;
  command_id: Id;
  runner_id: Id;
  tenant_id: Id;
  registration_id?: Id;
  assignment_revision?: PositiveInteger;
  agent_id: Id;
  connection_epoch: PositiveInteger;
  runner_revision: PositiveInteger;
}
export interface RuntimeConfig {
  type: "codex" | "claude" | "pi";
  model?: string;
  reasoning_effort?:
    | "none"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "ultra";
}
export interface AgentCliProfile {
  url: string;
  tenant_id: Id;
  agent_id: Id;
}
export interface DebugInspect {
  protocol_version: ProtocolVersion;
  command_id: Id;
  tenant_id: Id;
  registration_id?: Id;
  assignment_revision?: PositiveInteger;
  runner_id: Id;
  agent_id: Id;
  connection_epoch: PositiveInteger;
  runner_revision?: PositiveInteger;
  workspace_grant_id: Id;
  execution_context_key: ExecutionContextKey;
  runtime_instance_id: ExecutionContextKey;
  view_digest?: Sha256;
  type: "execute";
  request: DebugHistoryInspectionRequest;
  detached_history?: true;
  kind: "debug_history";
}
export interface DebugHistoryInspectionRequest {
  runtime: RuntimeConfig;
  session: OpaqueObject;
  cursor?: string;
  limit?: number;
}
export interface OpaqueObject {
  [k: string]: JsonValue;
}
export interface LocalSkillCommandIdentity {
  protocol_version: ProtocolVersion;
  command_id: Id;
  runner_id: Id;
  tenant_id: Id;
  owner_actor_id: Id;
  connection_epoch: PositiveInteger;
  expires_at: Timestamp;
}
export interface OperationScope {
  protocol_version: ProtocolVersion;
  host_access: "trusted";
  execution_context_key: ExecutionContextKey;
  runtime_instance_id: ExecutionContextKey;
  context_view_ref: ContextViewRef;
}
/**
 * Names a Context View by the SHA-256 digest of its content manifest. A receiver that lacks this View fetches the manifest and the files it does not hold from the context_content_url of the current connection's runner.welcome.
 */
export interface ContextViewRef {
  view_digest: Sha256;
}
export interface SessionOptions {
  thread_name: string;
  base_instructions?: string;
  developer_instructions?: string;
}
export interface LocalMcpRelayDescriptor {
  name: Id;
  relay_url: string;
  relay_token: string;
  /**
   * @maxItems 1024
   */
  tool_names: string[];
  expires_at: Timestamp;
}
export interface ProviderPrepare {
  type: "prepare";
  command_id: Id;
  prepare_id: Id;
  protocol_version: ProtocolVersion;
  host_access: "trusted";
  tenant_id: Id;
  registration_id: Id;
  assignment_revision: PositiveInteger;
  runner_id: Id;
  runner_revision: PositiveInteger;
  connection_epoch: PositiveInteger;
  agent_id: Id;
  workspace_grant_id: Id;
  runtime_type: "codex" | "claude" | "pi";
  execution_context_key: ExecutionContextKey;
  runtime_instance_id: ExecutionContextKey;
  context_view_ref: ContextViewRef;
  runtime: RuntimeConfig;
  session_options: SessionOptions;
  session: OpaqueObject;
  run_context?: ProviderPrepareRunContext;
  target: "provider";
}
export interface ProviderPrepareRunContext {
  human_interactions?: boolean;
  permission_review?: boolean;
}
/**
 * Compacts the native session of the process parked for this Context with the Runtime's own compaction. It never starts a process; without a parked process the answer is no_process.
 */
export interface SessionCompact {
  type: "execute";
  command_id: Id;
  compact_id: Id;
  protocol_version: ProtocolVersion;
  runner_id: Id;
  connection_epoch: PositiveInteger;
  agent_id: Id;
  runtime_type: "codex" | "claude";
  execution_context_key: ExecutionContextKey;
  instructions?: string;
  kind: "session_compact";
}
/**
 * Runs one model call on the Computer's signed-in Codex or Claude CLI in a fresh temporary directory, outside the Operation ledger and without a Context. Only structured carries output_schema, which it requires; only workspace carries workspace_files, the input files of the temporary directory, and gets its tree back. A workspace file may not be AGENTS.md, AGENTS.override.md or CLAUDE.md at the root or lie under a .codex or .claude directory. Codex cannot read files in workspace mode, so the Daemon also inlines the workspace files into the prompt and Codex writes only through apply_patch. The Daemon answers failed for a request that breaks these rules, and for a reply whose encoded model.invoked would exceed the frame limit.
 */
export interface ModelInvoke {
  type: "execute";
  command_id: Id;
  invoke_id: Id;
  protocol_version: ProtocolVersion;
  runner_id: Id;
  connection_epoch: PositiveInteger;
  tenant_id: Id;
  owner_actor_id: Id;
  agent_id: Id;
  runtime_type: "codex" | "claude";
  mode: "structured" | "text" | "workspace";
  reasoning_effort: "low" | "medium" | "high";
  instructions?: string;
  input: string;
  output_schema?: OpaqueObject;
  /**
   * @maxItems 256
   */
  workspace_files?: ModelInvokeFile[];
  timeout_ms: number;
  kind: "model_invoke";
  /**
   * Caps the characters the model may stream in its reply. A Daemon interrupts a session call that streams more and answers output_limited with what it streamed. Calls that run on their own are bounded by timeout_ms only.
   */
  max_output_chars?: number;
  /**
   * Names the session a structured call belongs to. A Daemon answers the Codex calls of one session in one resident thread whose base instructions are the call's instructions, so only the input is new to the provider; while that thread answers another call, and for Claude, the call runs on its own. Either way the result is the same.
   */
  session_key?: string;
}
export interface ModelInvokeFile {
  path: string;
  content_base64: string;
}
export interface ContextRunStartRequest {
  kind: "run.start";
  runtime: RuntimeConfig;
  session_options: SessionOptions;
  session: OpaqueObject;
  input: AgentInput;
  run_context: ContextRunContext;
  cli_run_context?: CliRunContext;
  run_resources: LocalRunResources;
}
export interface AgentInput {
  type: "text";
  text: string;
  runtime_response?: {
    request_id: Id;
    payload: OpaqueObject;
  };
}
export interface ContextRunContext {
  human_interactions?: boolean;
  /**
   * The Daemon sends Runtime permission prompts as human_interaction.requested with kind permission_review; Agent Service answers each with an operation.input runtime_response.
   */
  permission_review?: boolean;
  execution_run_ref: Id;
  /**
   * @maxItems 1024
   */
  source_inbox_ids: Id[];
}
export interface CliRunContext {
  run_id?: Id;
  scope?: {
    kind: "room" | "task" | "document";
    id: Id;
  };
}
export interface LocalRunResources {
  /**
   * @maxItems 128
   */
  mcp_servers: LocalMcpRelayDescriptor[];
}
export interface ComputerToolCall {
  type: "execute";
  protocol_version: ProtocolVersion;
  command_id: Id;
  runner_id: Id;
  connection_epoch: PositiveInteger;
  tenant_id: Id;
  owner_actor_id: Id;
  agent_id: Id;
  tool_session_id: Id;
  server: "browser" | "task_files";
  tool_name: string;
  arguments: OpaqueObject;
  task_scope?: SharedTaskScope;
  deadline_ms: number;
  kind: "computer_tool";
}
/**
 * TeamHub-trusted shared Task directory identity. The receiver resolves it under its own configured shared root; no host path crosses the protocol. A meta scope has no task_id; an alter_ego scope requires one.
 */
export interface SharedTaskScope {
  version: 1;
  tenant_id: SharedTaskScopeId;
  agent_id: SharedTaskScopeId;
  origin_room_id: SharedTaskScopeId;
  role: "meta" | "alter_ego";
  task_id?: SharedTaskScopeId;
}
export interface RunnerHello {
  type: "runner.hello";
  protocol_version: ProtocolVersion;
  daemon_version: string;
  platform: "darwin" | "linux" | "win32";
  runner_id: Id;
  display_name?: string;
  connection_nonce: Id;
  daemon_identity: {
    daemon_id: string;
    public_key: string;
    identity_version: number;
    proof: string;
  };
  /**
   * @maxItems 256
   */
  runtime_registrations: RuntimeRegistrationObservation[];
  sent_at: Timestamp;
  /**
   * Optional Computer-wide active Operation limit. Omission means unlimited.
   */
  capacity?: number;
  /**
   * @minItems 0
   */
  runtimes: ("codex" | "claude" | "pi")[];
  runtime_diagnostics: RuntimeDiagnostics;
  capabilities: RunnerCapability[];
  workspace_grants: WorkspaceGrant[];
  agent_runners: AgentRunnerSnapshot[];
  active_operations: ActiveOperation[];
}
export interface RuntimeDiagnostic {
  type: "codex" | "claude" | "pi";
  status:
    | "not_installed"
    | "authentication_required"
    | "ready"
    | "incompatible"
    | "error";
  protocol: "app-server" | "stream-json" | "rpc";
  checked_at: Timestamp;
  version?: string;
  /**
   * @maxItems 100
   */
  models: RuntimeModel[];
  model_catalog_error?: string;
  error?: {
    code:
      | "RUNTIME_NOT_INSTALLED"
      | "RUNTIME_AUTHENTICATION_REQUIRED"
      | "RUNTIME_INCOMPATIBLE"
      | "RUNTIME_DIAGNOSTIC_FAILED";
    message: string;
  };
  managed_services?: ManagedServices;
}
export interface RuntimeModel {
  id: string;
  label: string;
  allowed_reasoning_effort: (
    | "none"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "ultra"
  )[];
  default_reasoning_effort?:
    | "none"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "ultra";
  /**
   * Context length in tokens, from the gateway on the Runtime's API link, the window declared to Claude on its API link, or the Runtime's own catalog; absent when unknown.
   */
  context_window?: number;
  /**
   * How the Runtime reaches the model: api through a gateway and key configured in the Runtime, subscription through the vendor account it signed in to; absent when the Computer does not report it.
   */
  link?: "api" | "subscription";
  /**
   * True for the model the Runtime runs when none is selected.
   */
  is_default?: boolean;
}
export interface ManagedService {
  name: string;
  command: string;
  cwd: string;
  log_path: string;
  pid: number;
  state: "running" | "lost" | "stopped";
  observed_at: Timestamp;
  lost_at?: Timestamp;
  stopped_at?: Timestamp;
  url?: string;
  port?: number;
  health?: {
    status: "healthy" | "unhealthy" | "unreachable";
    http_status?: number;
    checked_at: Timestamp;
  };
}
export interface WorkspaceGrant {
  grant_id: Id;
  tenant_id: Id;
  label?: string;
  mode: "read-only" | "workspace-write";
  scope?: "owner" | "bindings";
}
export interface AgentRunnerError {
  code: Id;
  message: string;
  retryable: boolean;
}
export interface RunnerHeartbeat {
  type: "runner.heartbeat";
  protocol_version: ProtocolVersion;
  runner_id: Id;
  sent_at: Timestamp;
  active_operation_ids: Id[];
  managed_services?: ManagedServices;
}
export interface RunnerRuntimeDiagnostics {
  type: "runner.runtime_diagnostics";
  protocol_version: ProtocolVersion;
  runner_id: Id;
  sent_at: Timestamp;
  revision: PositiveInteger;
  runtime_diagnostics: RuntimeDiagnostics;
}
export interface RuntimeRegistrationObserved {
  type: "runtime.registration.observed";
  protocol_version: ProtocolVersion;
  command_id: Id;
  runner_id: Id;
  connection_epoch: PositiveInteger;
  observed_count: number;
}
/**
 * The CLI credential the Daemon stores for the Agent, without its token, and the Runtime Assignment it was installed for.
 */
export interface AgentCliCredentialReport {
  /**
   * SHA-256 of the token itself, the hash TeamHub records for it.
   */
  sha256: string;
  assignment_revision: PositiveInteger;
  profile: AgentCliProfile;
}
export interface DebugInspected {
  protocol_version: ProtocolVersion;
  command_id: Id;
  tenant_id: Id;
  registration_id?: Id;
  assignment_revision?: PositiveInteger;
  runner_id: Id;
  agent_id: Id;
  connection_epoch: PositiveInteger;
  runner_revision?: PositiveInteger;
  workspace_grant_id: Id;
  execution_context_key: ExecutionContextKey;
  runtime_instance_id: ExecutionContextKey;
  view_digest?: Sha256;
  type: "executed";
  result: DebugHistoryInspectionResult;
  detached_history?: true;
  kind: "debug_history";
}
export interface DebugHistoryInspectionResult {
  status: DebugInspectionStatus;
  provider_kind: string;
  reason?: string;
  source?: "codex_rollout" | "claude_transcript" | "pi_session";
  snapshot?: DebugHistorySnapshot;
  instructions: DebugHistoryInstructions;
  /**
   * @maxItems 500
   */
  records: DebugHistoryRecord[];
  previous_cursor?: string;
}
export interface DebugHistorySnapshot {
  id: string;
  thread_id: string;
  captured_at: Timestamp;
  record_count: number;
  tail_state: "clean" | "incomplete" | "corrupt";
}
export interface DebugHistoryInstructions {
  status: "available" | "unavailable";
  source: "codex_rollout" | "claude_transcript" | "pi_session";
  reason?: string;
  /**
   * @maxItems 512
   */
  blocks: DebugHistoryInstructionBlock[];
}
export interface DebugHistoryInstructionBlock {
  record_ordinal: number;
  record_type: string;
  field: string;
  content_ordinal?: number;
  timestamp?: Timestamp;
  text: string;
}
export interface DebugHistoryRecord {
  ordinal: number;
  timestamp?: Timestamp;
  turn_id?: string;
  category:
    | "message"
    | "tool_call"
    | "tool_result"
    | "lifecycle"
    | "reasoning"
    | "usage"
    | "provider_event"
    | "compaction";
  native_type: string;
  tool_call_id?: string;
  tool_name?: string;
  role?: string;
  phase?: string;
  native_record: OpaqueObject;
  /**
   * @maxItems 1024
   */
  redacted_fields: DebugHistoryRedactedField[];
}
export interface DebugHistoryRedactedField {
  path: string;
  reason:
    | "secret"
    | "encrypted_content"
    | "reasoning_content"
    | "physical_path"
    | "omitted_too_large";
  byte_count?: number;
}
export interface LocalSkillCandidate {
  native_source?: string;
  native_enabled?: boolean;
  candidate_ref: Id;
  name: string;
  description: string;
  package_sha256: Sha256;
  file_count: number;
  size_bytes: number;
  /**
   * @maxItems 8
   */
  normalizations:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  /**
   * @maxItems 16
   */
  risk_flags:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
  importability: "ready" | "unsupported";
  error_code?: string;
  error_detail?: string;
  manifest_excerpt?: string;
}
/**
 * The browser that browser tools of this owner's Agents drive on this Computer. It never contains the extension token.
 */
export interface BrowserConnectionStatus {
  mode: "isolated" | "user_chrome";
  state:
    | "isolated"
    | "not_connected"
    | "connected"
    | "token_invalid"
    | "browser_unavailable"
    | "extension_unavailable"
    | "unsupported";
  platform: "darwin" | "windows" | "linux";
  browser?: "chrome";
  profile?: BrowserProfile;
  configured_at?: Timestamp;
  verified_at?: Timestamp;
  message?: string;
}
/**
 * The macOS privacy permissions of this Computer. Other platforms report no subjects.
 */
export interface ComputerPermissionStatus {
  platform: "darwin" | "windows" | "linux";
  host: "desktop" | "standalone";
  /**
   * @maxItems 2
   */
  subjects:
    | []
    | [
        {
          subject: "linger" | "computer_use";
          /**
           * @maxItems 2
           */
          permissions:
            | []
            | [
                {
                  id: "screen_recording" | "accessibility";
                  state: "granted" | "denied" | "not_determined" | "unknown";
                  prompt: "available" | "settings_only";
                  relaunch_required: boolean;
                },
              ]
            | [
                {
                  id: "screen_recording" | "accessibility";
                  state: "granted" | "denied" | "not_determined" | "unknown";
                  prompt: "available" | "settings_only";
                  relaunch_required: boolean;
                },
                {
                  id: "screen_recording" | "accessibility";
                  state: "granted" | "denied" | "not_determined" | "unknown";
                  prompt: "available" | "settings_only";
                  relaunch_required: boolean;
                },
              ];
        },
      ]
    | [
        {
          subject: "linger" | "computer_use";
          /**
           * @maxItems 2
           */
          permissions:
            | []
            | [
                {
                  id: "screen_recording" | "accessibility";
                  state: "granted" | "denied" | "not_determined" | "unknown";
                  prompt: "available" | "settings_only";
                  relaunch_required: boolean;
                },
              ]
            | [
                {
                  id: "screen_recording" | "accessibility";
                  state: "granted" | "denied" | "not_determined" | "unknown";
                  prompt: "available" | "settings_only";
                  relaunch_required: boolean;
                },
                {
                  id: "screen_recording" | "accessibility";
                  state: "granted" | "denied" | "not_determined" | "unknown";
                  prompt: "available" | "settings_only";
                  relaunch_required: boolean;
                },
              ];
        },
        {
          subject: "linger" | "computer_use";
          /**
           * @maxItems 2
           */
          permissions:
            | []
            | [
                {
                  id: "screen_recording" | "accessibility";
                  state: "granted" | "denied" | "not_determined" | "unknown";
                  prompt: "available" | "settings_only";
                  relaunch_required: boolean;
                },
              ]
            | [
                {
                  id: "screen_recording" | "accessibility";
                  state: "granted" | "denied" | "not_determined" | "unknown";
                  prompt: "available" | "settings_only";
                  relaunch_required: boolean;
                },
                {
                  id: "screen_recording" | "accessibility";
                  state: "granted" | "denied" | "not_determined" | "unknown";
                  prompt: "available" | "settings_only";
                  relaunch_required: boolean;
                },
              ];
        },
      ];
}
export interface NativeResumeMeasurement {
  duration_ms: NonNegativeInteger;
  result: "success" | "error" | "canceled";
}
export interface ProviderPrepared {
  type: "prepared";
  command_id: Id;
  runner_id: Id;
  prepare_id: Id;
  execution_context_key: ExecutionContextKey;
  outcome: "ready" | "already_ready" | "not_eligible" | "failed" | "canceled";
  reason?: string;
  duration_ms: NonNegativeInteger;
  target: "provider";
}
export interface SessionCompacted {
  type: "executed";
  command_id: Id;
  runner_id: Id;
  compact_id: Id;
  execution_context_key: ExecutionContextKey;
  outcome:
    | "compacted"
    | "nothing_to_compact"
    | "no_process"
    | "canceled"
    | "failed";
  pre_tokens?: NonNegativeInteger;
  reason?: string;
  duration_ms: NonNegativeInteger;
  kind: "session_compact";
}
/**
 * Advisory outcome of one model.invoke. An outcome nobody waits for is ignored.
 */
export interface ModelInvoked {
  type: "executed";
  command_id: Id;
  runner_id: Id;
  invoke_id: Id;
  outcome:
    | "completed"
    | "timed_out"
    | "output_limited"
    | "canceled"
    | "unavailable"
    | "runtime_unavailable"
    | "auth_required"
    | "runtime_incompatible"
    | "failed";
  /**
   * The reply of a completed call. For a session call that timed_out, was output_limited or canceled, what the model had streamed so far, when anything.
   */
  text?: string;
  /**
   * @maxItems 256
   */
  workspace_files?: ModelInvokeFile[];
  model?: string;
  runtime_version?: string;
  usage?: {
    input_tokens: NonNegativeInteger;
    cached_input_tokens: NonNegativeInteger;
    output_tokens: NonNegativeInteger;
  };
  reason?: string;
  duration_ms: NonNegativeInteger;
  kind: "model_invoke";
}
export interface RunPlanStep {
  content: string;
  status: "pending" | "in_progress" | "completed" | "canceled";
}
export interface RunActivityContentBlock {
  format: "text" | "code" | "json";
  label?: string;
  content: string;
}
export interface RunTokenCounts {
  input: NonNegativeInteger;
  cache_read: NonNegativeInteger;
  cache_write: NonNegativeInteger;
  output: NonNegativeInteger;
  reasoning?: NonNegativeInteger;
}
export interface RunResult {
  type: "run";
  final_response: string;
  session: OpaqueObject;
  native_resume?: NativeResumeMeasurement;
  prepare_native_resume?: NativeResumeMeasurement;
  usage?: RunUsage;
}
export interface RuntimeExecutionFailure {
  code:
    | "session_not_found"
    | "protocol_incompatible"
    | "authentication_required"
    | "network_error"
    | "rate_limited"
    | "model_unavailable"
    | "context_too_long"
    | "model_service_error"
    | "timeout"
    | "execution_failed";
  runtime_type: "codex" | "claude" | "pi";
  runtime_version?: string;
}
export interface RuntimeFailureDiagnostics {
  exitCode?: number;
  signal?: string;
  code?: string;
  statusCode?: number;
}
export interface ComputerToolResult {
  type: "executed";
  protocol_version: ProtocolVersion;
  command_id: Id;
  runner_id: Id;
  connection_epoch: PositiveInteger;
  tenant_id: Id;
  owner_actor_id: Id;
  agent_id: Id;
  result: OpaqueObject;
  kind: "computer_tool";
}
