import WebSocket from "ws";
import { WebSocketPeer } from "../../../src/agent/runner-gateway/runner-gateway-websocket.js";
import { vi } from "vitest";
import type {
  ActiveOperation,
  AgentCliCredentialReport,
  AgentToDaemonEnvelope,
  DaemonToAgentEnvelope,
  LocalMcpRelayDescriptor,
  OperationPrepare,
  OperationPrepared,
  OperationStart,
  RunnerHello,
  RuntimeRegistrationSnapshot,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RunnerGateway,
  type AgentRunnerPlacement,
  type LocalContextRunIdentity,
  type LocalContextViewIdentity,
  type RunnerGatewayConnection,
  type RunnerGatewayPeer,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import {
  testRegistrationId,
  testRegistryOf,
} from "../test-support/runner-gateway.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";
import { readyContextScope } from "../test-support/ready-context-view.js";
import {
  CURRENT_RUNNER_CAPABILITIES,
  currentRunnerIdentity,
} from "../test-support/runner-capabilities.js";

export const hello = (
  activeOperations: RunnerHello["active_operations"] = [],
  capacity: number | null = 2,
): RunnerHello => ({
  type: "runner.hello",
  platform: "darwin",
  protocol_version: "2",
  daemon_version: "dev",
  ...currentRunnerIdentity(),
  capabilities: [...CURRENT_RUNNER_CAPABILITIES],
  runner_id: "runner-local",
  display_name: "Alice's Mac",
  connection_nonce: "nonce-1",
  sent_at: "2026-07-29T00:00:00.000Z",
  ...(capacity === null ? {} : { capacity }),
  runtimes: ["codex"],
  runtime_diagnostics: runtimeDiagnostics(),
  workspace_grants: [
    {
      grant_id: "grant-repo",
      tenant_id: "tenant-acme",
      label: "Linger workspace",
      mode: "workspace-write",
      scope: "bindings",
    },
  ],
  agent_runners: [],
  active_operations: activeOperations,
});

export const contextHello = (
  activeOperations: RunnerHello["active_operations"] = [],
): RunnerHello => ({
  ...hello(activeOperations),
  workspace_grants: [
    {
      grant_id: "grant-owner",
      tenant_id: "tenant-acme",
      label: "Linger managed workspace",
      mode: "workspace-write",
      scope: "owner",
    },
  ],
});

export const authenticatedPrincipal = () => ({
  runnerId: "runner-local",
  credentialGeneration: 0,
  tenantOwners: [{ tenantId: "tenant-acme", ownerActorId: "actor-alice" }],
});

export class RecordingPeer implements RunnerGatewayPeer {
  readonly sent: AgentToDaemonEnvelope[] = [];
  readonly registrationSnapshots: RuntimeRegistrationSnapshot[] = [];
  readonly closed: Array<{ code: number; reason: string }> = [];
  onClose?: () => void;

  async send(envelope: AgentToDaemonEnvelope): Promise<void> {
    // A current Computer gets runner.reconciled after every reconnect and a
    // Registration snapshot after every hello; the WebSocket tests assert
    // them, these tests inspect the commands around them.
    if (envelope.type === "runner.reconciled") return;
    if (envelope.type === "runtime.registration.snapshot") {
      this.registrationSnapshots.push(envelope);
      return;
    }
    this.sent.push(envelope);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
    this.onClose?.();
  }
}

export const recordingWebSocketPeer = (
  credentialStatus: () => Promise<"active">,
  completeWrite: (callback: (error?: Error) => void) => void = (callback) =>
    callback(),
) => {
  const recording = new RecordingPeer();
  return Object.assign(
    new WebSocketPeer(
      {
        readyState: WebSocket.OPEN,
        send: (data: string, callback: (error?: Error) => void) => {
          const envelope = JSON.parse(data) as AgentToDaemonEnvelope;
          if (envelope.type === "runtime.registration.snapshot")
            recording.registrationSnapshots.push(envelope);
          else if (envelope.type !== "runner.reconciled")
            recording.sent.push(envelope);
          completeWrite(callback);
        },
      } as unknown as WebSocket,
      credentialStatus,
      (code, reason) => recording.close(code, reason),
    ),
    {
      sent: recording.sent,
      registrationSnapshots: recording.registrationSnapshots,
      closed: recording.closed,
    },
  );
};

// An Agent Runner outcome echoes its command's Assignment fence.
export const assignmentFence = (command: {
  readonly registration_id?: string;
  readonly assignment_revision?: number;
}) => ({
  registration_id: command.registration_id!,
  assignment_revision: command.assignment_revision!,
});

// Placed on the test owner's Registration, so a reconnect keeps its Runner
// revision.
export const defaultAgentPlacement = (
  overrides: Partial<AgentRunnerPlacement> = {},
): AgentRunnerPlacement => {
  const runtime = overrides.runtime ?? { type: "codex" };
  return {
    computerId: "runner-local",
    tenantId: "tenant-acme",
    agentId: "agent-reviewer",
    runtime,
    workspaceGrantId: "grant-repo",
    registrationId: testRegistrationId(runtime.type),
    assignmentRevision: 1,
    ...overrides,
  };
};

export const localContextViewIdentity = (): LocalContextViewIdentity => ({
  computerId: "runner-local",
  tenantId: "tenant-acme",
  agentId: "agent-reviewer",
  runnerRevision: 1,
  workspaceGrantId: "grant-owner",
  executionContextKey: "context-reviewer",
  runtimeInstanceId: "runtime-instance-reviewer",
  viewDigest: "c".repeat(64),
});

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

export const orphanActiveOperation = (): ActiveOperation => ({
  protocol_version: "2",
  host_access: "trusted",
  execution_context_key: readyContextScope("agent-orphan").executionContextKey,
  runtime_instance_id: readyContextScope("agent-orphan").runtimeInstanceId,
  context_view_ref: readyContextScope("agent-orphan").contextViewRef,
  tenant_id: "tenant-acme",
  runner_id: "runner-local",
  agent_id: "agent-orphan",
  operation_id: "operation-orphan",
  registration_id: testRegistrationId("codex"),
  assignment_revision: 1,
  connection_epoch: 1,
  runner_revision: 1,
  generation: 1,
  execution_lease_id: "lease-orphan",
  workspace_grant_id: "grant-repo",
  runtime_type: "codex",
  kind: "run.start",
  last_emitted_seq: 1,
  last_acked_seq: 1,
});

export const acknowledgeEnsuredAgent = async (
  connection: RunnerGatewayConnection,
  peer: RecordingPeer,
  removeCommand = false,
  cliCredential?: AgentCliCredentialReport,
): Promise<void> => {
  const commandIndex = peer.sent
    .map(({ type }) => type)
    .lastIndexOf("agent_runner.ensure");
  const command = peer.sent[commandIndex];
  if (command?.type !== "agent_runner.ensure") {
    throw new Error("Expected agent_runner.ensure");
  }
  await connection.receive({
    type: "agent_runner.state",
    state: "ready",
    protocol_version: command.protocol_version,
    command_id: command.command_id,
    runner_id: command.runner_id,
    tenant_id: command.tenant_id,
    registration_id: command.registration_id,
    assignment_revision: command.assignment_revision,
    agent_id: command.agent_id,
    connection_epoch: command.connection_epoch,
    runner_revision: command.runner_revision,
    runner_pid: 100,
    ...(cliCredential ? { cli_credential: cliCredential } : {}),
  });
  if (removeCommand) {
    peer.sent.splice(commandIndex, 1);
  }
};

/** TeamHub places the Agent on its Computer, as its registration row would. */
export const placeAgent = (
  gateway: RunnerGateway,
  placement: AgentRunnerPlacement = defaultAgentPlacement(),
): void => {
  testRegistryOf(gateway).place(placement.computerId, {
    agentId: placement.agentId,
    tenantId: placement.tenantId,
    ownerActorId: "actor-alice",
    runtimeType: placement.runtime.type,
    model: placement.runtime.model ?? `${placement.runtime.type}-default`,
    ...(placement.runtime.reasoning_effort
      ? { reasoningEffort: placement.runtime.reasoning_effort }
      : {}),
    workspaceGrantId: placement.workspaceGrantId,
    assignmentRevision: placement.assignmentRevision,
  });
};

export const acceptReadyConnection = async (
  gateway: RunnerGateway,
  peer: RecordingPeer,
  value: RunnerHello = hello(),
  placement: AgentRunnerPlacement = defaultAgentPlacement(),
): Promise<RunnerGatewayConnection> => {
  placeAgent(gateway, placement);
  const connection = await gateway.acceptConnection(
    authenticatedPrincipal(),
    value,
    peer,
  );
  await acknowledgeEnsuredAgent(connection, peer, true);
  return connection;
};

export class FailingStartPeer extends RecordingPeer {
  override async send(envelope: AgentToDaemonEnvelope): Promise<void> {
    await super.send(envelope);
    if (envelope.type === "operation.start") {
      throw new Error("start send failed");
    }
  }
}

export class FailingTerminalAckPeer extends RecordingPeer {
  override async send(envelope: AgentToDaemonEnvelope): Promise<void> {
    await super.send(envelope);
    if (envelope.type === "operation.ack" && envelope.through_seq === 2) {
      throw new Error("terminal acknowledgement send failed");
    }
  }
}

export class TestDeferred {
  readonly promise: Promise<void>;
  resolve!: (value: undefined) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

export class BlockingWelcomePeer extends RecordingPeer {
  readonly welcomeStarted = new TestDeferred();
  readonly releaseWelcome = new TestDeferred();

  override async send(envelope: AgentToDaemonEnvelope): Promise<void> {
    await super.send(envelope);
    if (envelope.type === "runner.welcome") {
      this.welcomeStarted.resolve(undefined);
      await this.releaseWelcome.promise;
    }
  }
}

export const sessionTarget = () => ({
  tenantId: "tenant-acme",
  ownerActorId: "actor-alice",
  runnerId: "runner-local",
  ...readyContextScope(),
  agentId: "agent-reviewer",
  workspaceGrantId: "grant-repo",
  request: {
    kind: "run.start" as const,
    runtime: { type: "codex" as const },
    session_options: {
      thread_name: "Reviewer",
    },
    session: { threadId: "" },
    input: { type: "text" as const, text: "hello" },
    run_context: { execution_run_ref: "run-1", source_inbox_ids: [] },
    run_resources: { mcp_servers: [] },
  },
});

export const runTarget = () => ({
  ...sessionTarget(),
  request: {
    ...sessionTarget().request,
    kind: "run.start" as const,
    session: { thread_id: "thread-1" },
    input: { type: "text" as const, text: "Review" },
    run_context: {
      execution_run_ref: "run-1",
      source_inbox_ids: ["room:room-main"],
    },
    run_resources: { mcp_servers: [] as LocalMcpRelayDescriptor[] },
  },
});

// The Local MCP Relay identity of runTarget() on Runner revision 1.
export const runIdentity = (): LocalContextRunIdentity => {
  const { executionContextKey, runtimeInstanceId, contextViewRef } =
    readyContextScope();
  return {
    computerId: "runner-local",
    tenantId: "tenant-acme",
    agentId: "agent-reviewer",
    runnerRevision: 1,
    workspaceGrantId: "grant-repo",
    executionRunRef: "run-1",
    executionContextKey,
    runtimeInstanceId,
    viewDigest: contextViewRef.view_digest,
  };
};

export const contextRunTarget = (
  context: LocalContextViewIdentity,
  mcpServers: readonly LocalMcpRelayDescriptor[] = [],
) => ({
  tenantId: context.tenantId,
  ownerActorId: "actor-alice",
  runnerId: context.computerId,
  executionContextKey: context.executionContextKey,
  runtimeInstanceId: context.runtimeInstanceId,
  contextViewRef: { view_digest: context.viewDigest },
  agentId: context.agentId,
  workspaceGrantId: context.workspaceGrantId,
  request: {
    kind: "run.start" as const,
    runtime: { type: "codex" as const },
    session_options: {
      thread_name: "Reviewer",
    },
    session: { threadId: "thread-1" },
    input: { type: "text" as const, text: "Review" },
    run_context: {
      execution_run_ref: "local-run-context-1",
      source_inbox_ids: ["room:room-main"],
    },
    run_resources: { mcp_servers: [...mcpServers] },
  },
});

export const event = (
  start: OperationStart,
  seq: number,
  value: object,
): DaemonToAgentEnvelope =>
  ({
    protocol_version: start.protocol_version,
    host_access: start.host_access,
    tenant_id: start.tenant_id,
    registration_id: start.registration_id,
    assignment_revision: start.assignment_revision,
    runner_id: start.runner_id,
    execution_context_key: start.execution_context_key,
    runtime_instance_id: start.runtime_instance_id,
    context_view_ref: start.context_view_ref,
    agent_id: start.agent_id,
    operation_id: start.operation_id,
    connection_epoch: start.connection_epoch,
    runner_revision: start.runner_revision,
    generation: start.generation,
    execution_lease_id: start.execution_lease_id,
    workspace_grant_id: start.workspace_grant_id,
    runtime_type: start.runtime_type,
    seq,
    ...value,
  }) as DaemonToAgentEnvelope;

export const preparedEvent = (
  prepare: OperationPrepare,
  outcome: "ready" | "fallback" = "ready",
): OperationPrepared => ({
  protocol_version: prepare.protocol_version,
  host_access: prepare.host_access,
  tenant_id: prepare.tenant_id,
  registration_id: prepare.registration_id,
  assignment_revision: prepare.assignment_revision,
  runner_id: prepare.runner_id,
  execution_context_key: prepare.execution_context_key,
  runtime_instance_id: prepare.runtime_instance_id,
  context_view_ref: prepare.context_view_ref,
  agent_id: prepare.agent_id,
  operation_id: prepare.operation_id,
  connection_epoch: prepare.connection_epoch,
  runner_revision: prepare.runner_revision,
  generation: prepare.generation,
  execution_lease_id: prepare.execution_lease_id,
  workspace_grant_id: prepare.workspace_grant_id,
  runtime_type: prepare.runtime_type,
  type: "prepared",
  target: "operation",
  command_id: prepare.command_id,
  prepare_command_id: prepare.command_id,
  prepared: outcome === "ready",
  outcome,
  duration_ms: 25,
});

export const sequenceIds = (): (() => string) => {
  let next = 0;
  return () => `id-${++next}`;
};

export const settlesWithin = async (
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), milliseconds),
    ),
  ]);

export const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

export const settledWithTimers = async (promise: Promise<void>) => {
  let done = false;
  void promise.then(() => (done = true));
  await vi.advanceTimersByTimeAsync(0);
  return done;
};
