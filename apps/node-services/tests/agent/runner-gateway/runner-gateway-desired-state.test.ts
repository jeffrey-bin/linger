import { describe, expect, it, vi } from "vitest";

import type {
  AgentRunnerEnsure,
  AgentRunnerRemove,
  AgentRunnerSnapshot,
  AgentToDaemonEnvelope,
  DaemonToAgentEnvelope,
  RunnerHello,
} from "@linger/wire-contracts/runner-gateway/types";

import {
  RunnerGatewayProtocolError,
  type RunnerGatewayConnection,
  type RunnerGatewayPeer,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import { AgentRunnerDesiredState } from "../../../src/agent/runner-gateway/agent-runner-desired-state.js";
import { RemoteCodexProvider } from "../../../src/agent/runner-gateway/remote-codex-provider.js";
import { LocalRuntimeAuthenticationRequiredError } from "../../../src/agent/runner-gateway/local-computer-management.js";
import {
  createTestRunnerGateway,
  testRegistrationId,
  testRegistryOf,
} from "../test-support/runner-gateway.js";
import { placeAgent } from "./runner-gateway-fixtures.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";
import { readyContextScope } from "../test-support/ready-context-view.js";
import {
  CURRENT_RUNNER_CAPABILITIES,
  currentRunnerIdentity,
} from "../test-support/runner-capabilities.js";

type AgentRunnerOutcome = Extract<
  DaemonToAgentEnvelope,
  { readonly connection_epoch: number; readonly runner_revision: number }
>;

class RecordingPeer implements RunnerGatewayPeer {
  readonly sent: AgentToDaemonEnvelope[] = [];
  readonly closed: Array<{ code: number; reason: string }> = [];

  async send(envelope: AgentToDaemonEnvelope): Promise<void> {
    // Every hello gets a Registration snapshot; these tests inspect the
    // desired-state commands around it.
    if (envelope.type === "runtime.registration.snapshot") return;
    this.sent.push(envelope);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }
}

const principal = () => ({
  runnerId: "computer-local",
  credentialGeneration: 0,
  tenantOwners: [{ tenantId: "tenant-acme", ownerActorId: "actor-alice" }],
});

const hello = (
  agentRunners: RunnerHello["agent_runners"] = [],
  activeOperations: RunnerHello["active_operations"] = [],
): RunnerHello => ({
  type: "runner.hello",
  platform: "darwin",
  protocol_version: "2",
  daemon_version: "dev",
  ...currentRunnerIdentity(),
  capabilities: [...CURRENT_RUNNER_CAPABILITIES],
  runner_id: "computer-local",
  connection_nonce: "nonce-1",
  sent_at: "2026-07-30T00:00:00.000Z",
  capacity: 2,
  runtimes: ["codex", "claude"],
  runtime_diagnostics: runtimeDiagnostics({ ready: ["codex", "claude"] }),
  workspace_grants: [
    {
      grant_id: "grant-repo",
      tenant_id: "tenant-acme",
      mode: "workspace-write",
      scope: "owner",
    },
    {
      grant_id: "grant-readonly",
      tenant_id: "tenant-acme",
      mode: "workspace-write",
      scope: "owner",
    },
  ],
  agent_runners: agentRunners,
  active_operations: activeOperations,
});

const placement = (
  overrides: Partial<{
    agentId: string;
    workspaceGrantId: string;
    assignmentRevision: number;
    runtime: { type: "codex" | "claude"; model?: string };
  }> = {},
) => {
  const runtime = overrides.runtime ?? { type: "codex" as const };
  return {
    computerId: "computer-local",
    tenantId: "tenant-acme",
    agentId: "agent-reviewer",
    workspaceGrantId: "grant-repo",
    runtime,
    registrationId: testRegistrationId(runtime.type),
    assignmentRevision: 1,
    ...overrides,
  };
};

const localRequirement = (
  agentId: string,
  overrides: Partial<{
    computerId: string;
    runtimeType: "codex" | "claude";
    assignmentRevision: number;
  }> = {},
) => ({
  placement: {
    type: "local" as const,
    tenantId: "tenant-acme",
    ownerActorId: "actor-alice",
    computerId: overrides.computerId ?? "computer-local",
    runtimeType: overrides.runtimeType ?? ("codex" as const),
    workspaceGrantId: "grant-repo",
    assignmentRevision: overrides.assignmentRevision ?? 1,
  },
  modelId: `${overrides.runtimeType ?? "codex"}-default`,
  agentId,
});

const operationTarget = (
  overrides: Partial<{
    agentId: string;
    workspaceGrantId: string;
    runtime: { type: "codex" | "claude"; model?: string };
  }> = {},
) => ({
  tenantId: "tenant-acme",
  ownerActorId: "actor-alice",
  runnerId: "computer-local",
  ...readyContextScope(overrides.agentId),
  agentId: overrides.agentId ?? "agent-reviewer",
  workspaceGrantId: overrides.workspaceGrantId ?? "grant-repo",
  request: {
    kind: "run.start" as const,
    runtime: overrides.runtime ?? { type: "codex" as const },
    session_options: { thread_name: "Reviewer" },
    session: { threadId: "" },
    input: { type: "text" as const, text: "hello" },
    run_context: { execution_run_ref: "run-1", source_inbox_ids: [] },
    run_resources: { mcp_servers: [] },
  },
});

const runnerOutcome = (
  command: AgentRunnerEnsure | AgentRunnerRemove,
  outcome:
    | { type: "agent_runner.state"; state: "ready"; runner_pid: number }
    | { type: "agent_runner.state"; state: "removed" }
    | {
        type: "agent_runner.state";
        state: "failed";
        error: {
          code: "agent_runner_lifecycle_failed";
          message: string;
          retryable: boolean;
        };
      },
): AgentRunnerOutcome =>
  ({
    protocol_version: command.protocol_version,
    command_id: command.command_id,
    runner_id: command.runner_id,
    tenant_id: command.tenant_id,
    ...(command.registration_id
      ? {
          registration_id: command.registration_id,
          assignment_revision: command.assignment_revision,
        }
      : {}),
    agent_id: command.agent_id,
    connection_epoch: command.connection_epoch,
    runner_revision: command.runner_revision,
    ...outcome,
  }) as AgentRunnerOutcome;

const commands = <T extends "agent_runner.ensure" | "agent_runner.remove">(
  peer: RecordingPeer,
  type: T,
) =>
  peer.sent.filter((frame) => frame.type === type) as Extract<
    AgentToDaemonEnvelope,
    { type: T }
  >[];

const requireCommand = <
  T extends "agent_runner.ensure" | "agent_runner.remove",
>(
  peer: RecordingPeer,
  type: T,
) => {
  const command = commands(peer, type).at(-1);
  if (!command) throw new Error(`Expected ${type}`);
  return command;
};

const acknowledgeReady = (
  connection: RunnerGatewayConnection,
  command: AgentRunnerEnsure,
): Promise<void> =>
  connection.receive(
    runnerOutcome(command, {
      type: "agent_runner.state",
      state: "ready",
      runner_pid: 101,
    }),
  );

const acknowledgeRemoved = (
  connection: RunnerGatewayConnection,
  command: AgentRunnerRemove,
): Promise<void> =>
  connection.receive(
    runnerOutcome(command, { type: "agent_runner.state", state: "removed" }),
  );

const readyRunner = (
  agentId: string,
  runnerRevision: number,
  registrationId = testRegistrationId("codex"),
): AgentRunnerSnapshot => ({
  runner_id: "computer-local",
  tenant_id: "tenant-acme",
  agent_id: agentId,
  runner_revision: runnerRevision,
  state: "ready",
  runtime: { type: "codex" },
  workspace_grant_id: "grant-repo",
  runner_pid: 303,
  registration_id: registrationId,
  assignment_revision: 1,
});

describe("Agent Runner desired state computed at connect", () => {
  it("ensures each Agent TeamHub places on the Computer and removes every other Runner it reports", () => {
    const desired = new AgentRunnerDesiredState();
    desired.reconnect(
      "computer-local",
      [
        placement({ agentId: "agent-held" }),
        placement({ agentId: "agent-new" }),
        placement({ agentId: "agent-changed", assignmentRevision: 2 }),
      ],
      [
        readyRunner("agent-held", 4),
        readyRunner("agent-changed", 2),
        readyRunner("agent-left", 7),
        {
          runner_id: "computer-local",
          tenant_id: "tenant-acme",
          agent_id: "agent-gone",
          runner_revision: 3,
          state: "removed",
        },
      ],
    );
    const sent = desired.snapshotCommands({
      computerId: "computer-local",
      connectionEpoch: 1,
      createId: () => "command",
    });
    // A Runner the Computer already holds as placed is not sent again.
    expect(
      sent.map(({ type, agent_id, runner_revision }) => ({
        type,
        agent_id,
        runner_revision,
      })),
    ).toEqual([
      {
        type: "agent_runner.ensure",
        agent_id: "agent-changed",
        runner_revision: 3,
      },
      {
        type: "agent_runner.remove",
        agent_id: "agent-gone",
        runner_revision: 4,
      },
      {
        type: "agent_runner.remove",
        agent_id: "agent-left",
        runner_revision: 8,
      },
      {
        type: "agent_runner.ensure",
        agent_id: "agent-new",
        runner_revision: 1,
      },
    ]);
    expect(desired.places("computer-local", "tenant-acme", "agent-held")).toBe(
      true,
    );
    expect(desired.places("computer-local", "tenant-acme", "agent-left")).toBe(
      false,
    );
  });

  it("keeps a revision this process sent above what a reconnecting Computer reports", () => {
    const desired = new AgentRunnerDesiredState();
    desired.reconnect("computer-local", [placement()], []);
    desired.ensure(placement({ runtime: { type: "claude" } }));
    desired.reconnect(
      "computer-local",
      [placement()],
      [readyRunner("agent-reviewer", 1)],
    );
    // Revision 2 was sent for Claude and may have reached the Computer.
    expect(
      desired.snapshotCommands({
        computerId: "computer-local",
        connectionEpoch: 2,
        createId: () => "command",
      }),
    ).toEqual([
      expect.objectContaining({
        type: "agent_runner.ensure",
        runner_revision: 3,
        runtime: { type: "codex" },
      }),
    ]);
  });
});

describe("RunnerGateway Agent Runner lifecycle", () => {
  it("notifies readiness only after the connection's Agent Runners are reconciled", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    placeAgent(gateway, placement());
    const readyComputers: string[] = [];
    const unsubscribe = gateway.subscribeLocalComputerReady((computerId) => {
      readyComputers.push(computerId);
    });
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      principal(),
      hello(),
      peer,
    );

    expect(readyComputers).toEqual([]);
    await expect(gateway.startOperation(operationTarget())).rejects.toThrow(
      "not yet reconciled",
    );
    const ensure = requireCommand(peer, "agent_runner.ensure");
    expect(peer.sent.map(({ type }) => type)).toEqual([
      "runner.welcome",
      "agent_runner.ensure",
    ]);
    expect(ensure).toMatchObject({
      connection_epoch: 1,
      runner_revision: 1,
      runtime: { type: "codex" },
      workspace_grant_id: "grant-repo",
      registration_id: testRegistrationId("codex"),
      assignment_revision: 1,
    });
    await acknowledgeReady(connection, ensure);
    expect(readyComputers).toEqual(["computer-local"]);
    await expect(
      gateway.startOperation(operationTarget()),
    ).resolves.toMatchObject({ operationId: expect.any(String) });
    expect(peer.sent.at(-1)).toMatchObject({
      type: "operation.start",
      connection_epoch: 1,
      runner_revision: 1,
    });
    unsubscribe();
  });

  it("completes Local Agent readiness only after the Daemon confirms the Agent Runner", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      principal(),
      hello(),
      peer,
    );
    let settled = false;
    const readiness = gateway
      .ensureReadyLocalAgentRunner(localRequirement("agent-pending"))
      .finally(() => {
        settled = true;
      });
    const ensure = await vi.waitFor(() =>
      requireCommand(peer, "agent_runner.ensure"),
    );
    expect(settled).toBe(false);
    await acknowledgeReady(connection, ensure);
    await expect(readiness).resolves.toBe(1);
  });

  it("cancels a pending readiness waiter without poisoning a retry", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      principal(),
      hello(),
      peer,
    );
    const controller = new AbortController();
    const cancellation = new Error("Context preparation failed");
    const cancelled = gateway.ensureReadyLocalAgentRunner({
      ...localRequirement("agent-cancelled"),
      signal: controller.signal,
    });
    await vi.waitFor(() => requireCommand(peer, "agent_runner.ensure"));
    controller.abort(cancellation);
    await expect(cancelled).rejects.toBe(cancellation);

    const retry = gateway.ensureReadyLocalAgentRunner(
      localRequirement("agent-cancelled"),
    );
    await acknowledgeReady(
      connection,
      requireCommand(peer, "agent_runner.ensure"),
    );
    await expect(retry).resolves.toBe(1);
  });

  it("retries a failed Agent Runner ensure with a higher revision", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      principal(),
      hello(),
      peer,
    );
    const first = gateway.ensureReadyLocalAgentRunner(
      localRequirement("agent-retry"),
    );
    const firstEnsure = await vi.waitFor(() =>
      requireCommand(peer, "agent_runner.ensure"),
    );
    await connection.receive(
      runnerOutcome(firstEnsure, {
        type: "agent_runner.state",
        state: "failed",
        error: {
          code: "agent_runner_lifecycle_failed",
          message: "Runtime failed to start",
          retryable: true,
        },
      }),
    );
    await expect(first).rejects.toThrow("Runtime failed to start");

    const second = gateway.ensureReadyLocalAgentRunner(
      localRequirement("agent-retry"),
    );
    await vi.waitFor(() =>
      expect(commands(peer, "agent_runner.ensure")).toHaveLength(2),
    );
    const secondEnsure = requireCommand(peer, "agent_runner.ensure");
    expect(secondEnsure.runner_revision).toBe(firstEnsure.runner_revision + 1);
    await acknowledgeReady(connection, secondEnsure);
    await expect(second).resolves.toBe(firstEnsure.runner_revision + 1);
  });

  it("sends a change made during reconciliation once the first batch settles", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    placeAgent(gateway, placement());
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      principal(),
      hello(),
      peer,
    );
    const firstEnsure = requireCommand(peer, "agent_runner.ensure");
    const changing = gateway.ensureReadyLocalAgentRunner(
      localRequirement("agent-reviewer", { runtimeType: "claude" }),
    );
    const writer = gateway.ensureReadyLocalAgentRunner(
      localRequirement("agent-writer"),
    );
    // Both changes wait behind the batch the connection sent at hello.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(commands(peer, "agent_runner.ensure")).toHaveLength(1);
    await acknowledgeReady(connection, firstEnsure);
    await vi.waitFor(() =>
      expect(commands(peer, "agent_runner.ensure")).toHaveLength(3),
    );
    const [, reviewer, second] = commands(peer, "agent_runner.ensure");
    expect(reviewer).toMatchObject({
      agent_id: "agent-reviewer",
      runner_revision: 2,
      runtime: { type: "claude" },
    });
    expect(second).toMatchObject({
      agent_id: "agent-writer",
      runner_revision: 1,
    });
    await acknowledgeReady(connection, reviewer!);
    await acknowledgeReady(connection, second!);
    await expect(changing).resolves.toBe(2);
    await expect(writer).resolves.toBe(1);
  });

  it("removes an unplaced Runner before an Agent placed there again is ensured", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      principal(),
      hello([readyRunner("agent-orphan", 3, "registration-deleted")]),
      peer,
    );
    const cleanup = requireCommand(peer, "agent_runner.remove");
    expect(cleanup).toMatchObject({ runner_revision: 4 });
    expect(cleanup).not.toHaveProperty("registration_id");

    const readiness = gateway.ensureReadyLocalAgentRunner(
      localRequirement("agent-orphan"),
    );
    await vi.waitFor(() =>
      expect(commands(peer, "agent_runner.ensure")).toHaveLength(0),
    );
    await acknowledgeRemoved(connection, cleanup);
    const ensure = await vi.waitFor(() =>
      requireCommand(peer, "agent_runner.ensure"),
    );
    expect(ensure).toMatchObject({
      runner_revision: 5,
      registration_id: testRegistrationId("codex"),
    });
    await acknowledgeReady(connection, ensure);
    await expect(readiness).resolves.toBe(5);
    expect(peer.closed).toEqual([]);
  });

  it("fails closed on stale connection epochs and Runner revisions", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    placeAgent(gateway, placement());
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      principal(),
      hello(),
      peer,
    );
    const ensure = requireCommand(peer, "agent_runner.ensure");
    await expect(
      connection.receive({
        ...runnerOutcome(ensure, {
          type: "agent_runner.state",
          state: "ready",
          runner_pid: 101,
        }),
        runner_revision: ensure.runner_revision + 1,
      }),
    ).rejects.toBeInstanceOf(RunnerGatewayProtocolError);
    expect(peer.closed).toEqual([
      { code: 1002, reason: "Runner protocol violation" },
    ]);

    const recoveryPeer = new RecordingPeer();
    const recovery = await gateway.acceptConnection(
      principal(),
      hello(),
      recoveryPeer,
    );
    const recoveryEnsure = requireCommand(recoveryPeer, "agent_runner.ensure");
    await expect(
      recovery.receive({
        ...runnerOutcome(recoveryEnsure, {
          type: "agent_runner.state",
          state: "ready",
          runner_pid: 102,
        }),
        connection_epoch: recoveryEnsure.connection_epoch - 1,
      }),
    ).rejects.toBeInstanceOf(RunnerGatewayProtocolError);
  });

  it("requires the ready Agent Runner placement, Runtime, model and grant to match the Operation", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    placeAgent(
      gateway,
      placement({ runtime: { type: "codex", model: "gpt-fast" } }),
    );
    const greeting = hello();
    for (const diagnostic of greeting.runtime_diagnostics)
      if (diagnostic.type === "codex")
        diagnostic.models = ["gpt-fast", "gpt-deep"].map((id) => ({
          id,
          label: id,
          allowed_reasoning_effort: [],
        }));
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      principal(),
      greeting,
      peer,
    );
    const ensure = requireCommand(peer, "agent_runner.ensure");
    expect(ensure.runtime).toEqual({ type: "codex", model: "gpt-fast" });
    await acknowledgeReady(connection, ensure);

    for (const target of [
      operationTarget({ runtime: { type: "codex", model: "gpt-deep" } }),
      operationTarget({ workspaceGrantId: "grant-readonly" }),
      operationTarget({ runtime: { type: "claude" } }),
    ])
      await expect(gateway.startOperation(target)).rejects.toThrow(
        "Agent Runner placement does not match Operation",
      );
    await expect(
      gateway.startOperation(
        operationTarget({ runtime: { type: "codex", model: "gpt-fast" } }),
      ),
    ).resolves.toBeDefined();
  });

  it.each(["codex", "claude"] as const)(
    "fences a ready %s Agent when authentication is required and admits it after recovery",
    async (runtimeType) => {
      const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
      placeAgent(gateway, placement({ runtime: { type: runtimeType } }));
      const peer = new RecordingPeer();
      const connection = await gateway.acceptConnection(
        principal(),
        {
          ...hello(),
          runtimes: [runtimeType],
          runtime_diagnostics: runtimeDiagnostics({ ready: [runtimeType] }),
        },
        peer,
      );
      await acknowledgeReady(
        connection,
        requireCommand(peer, "agent_runner.ensure"),
      );
      await connection.receive({
        type: "runner.runtime_diagnostics",
        protocol_version: "2",
        runner_id: "computer-local",
        revision: 1,
        sent_at: "2026-07-30T00:00:15.000Z",
        runtime_diagnostics: runtimeDiagnostics({
          authenticationRequired: [runtimeType],
          ready: [],
        }),
      });
      await expect(
        gateway.startOperation(
          operationTarget({ runtime: { type: runtimeType } }),
        ),
      ).rejects.toBeInstanceOf(LocalRuntimeAuthenticationRequiredError);
      await connection.receive({
        type: "runner.runtime_diagnostics",
        protocol_version: "2",
        runner_id: "computer-local",
        revision: 2,
        sent_at: "2026-07-30T00:00:30.000Z",
        runtime_diagnostics: runtimeDiagnostics({ ready: [runtimeType] }),
      });
      await expect(
        gateway.startOperation(
          operationTarget({ runtime: { type: runtimeType } }),
        ),
      ).resolves.toBeDefined();
    },
  );
});

describe("RunnerGateway deletion and moves change only registration rows", () => {
  it("removes a deleted Agent's Runner from its connected Computer and retries a failed removal", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    placeAgent(gateway, placement());
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      principal(),
      hello(),
      peer,
    );
    await acknowledgeReady(
      connection,
      requireCommand(peer, "agent_runner.ensure"),
    );

    await gateway.finalizeDeletedLocalAgentRunner("agent-reviewer");
    const remove = requireCommand(peer, "agent_runner.remove");
    expect(remove.runner_revision).toBe(2);
    await connection.receive(
      runnerOutcome(remove, {
        type: "agent_runner.state",
        state: "failed",
        error: {
          code: "agent_runner_lifecycle_failed",
          message: "Runner cleanup failed",
          retryable: true,
        },
      }),
    );
    await gateway.finalizeDeletedLocalAgentRunner("agent-reviewer");
    const retry = requireCommand(peer, "agent_runner.remove");
    expect(retry.runner_revision).toBe(3);
    await acknowledgeRemoved(connection, retry);
    await expect(gateway.startOperation(operationTarget())).rejects.toThrow(
      "Agent Runner desired state is not ready",
    );
  });

  it("removes the Runner from the connected Computer an Agent left", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    placeAgent(gateway, placement());
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      principal(),
      hello(),
      peer,
    );
    await acknowledgeReady(
      connection,
      requireCommand(peer, "agent_runner.ensure"),
    );

    await gateway.noteAgentPlacement("agent-reviewer", "computer-other");
    const remove = requireCommand(peer, "agent_runner.remove");
    expect(remove).toMatchObject({
      agent_id: "agent-reviewer",
      runner_revision: 2,
    });
    await gateway.noteAgentPlacement("agent-reviewer", "computer-other");
    expect(commands(peer, "agent_runner.remove")).toHaveLength(1);
  });

  it("drops the late results of an Operation on a Computer the Agent left while it was offline", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      operationCancelTimeoutMs: 60_000,
    });
    placeAgent(gateway, placement());
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      principal(),
      hello(),
      peer,
    );
    await acknowledgeReady(
      connection,
      requireCommand(peer, "agent_runner.ensure"),
    );
    const operation = await gateway.startOperation(operationTarget());
    const start = peer.sent.at(-1);
    if (start?.type !== "operation.start") throw new Error("Expected start");
    const result = operation.result.catch((error: unknown) => error);
    const events: string[] = [];
    const consuming = (async () => {
      for await (const event of operation.events) events.push(event.type);
    })();
    connection.disconnect();

    // TeamHub moves the Agent while this Computer is offline.
    testRegistryOf(gateway).unplace("agent-reviewer");
    const identity = {
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
    };
    const returning = new RecordingPeer();
    const reconnected = await gateway.acceptConnection(
      principal(),
      hello(
        [readyRunner("agent-reviewer", 1)],
        [
          {
            ...identity,
            kind: "run.start",
            last_emitted_seq: 0,
            last_acked_seq: 0,
          },
        ],
      ),
      returning,
    );
    const remove = requireCommand(returning, "agent_runner.remove");
    expect(remove).toMatchObject({
      agent_id: "agent-reviewer",
      runner_revision: 2,
    });
    await acknowledgeRemoved(reconnected, remove);

    // The Operation ended here and the Computer is asked to cancel it once.
    await expect(result).resolves.toMatchObject({ code: "agent_moved" });
    expect(
      returning.sent.filter(
        (frame) =>
          frame.type === "cancel" &&
          frame.target === "operation" &&
          frame.operation_id === start.operation_id,
      ),
    ).toHaveLength(1);
    expect(
      returning.sent.some(
        (frame) =>
          frame.type === "operation.start" &&
          frame.operation_id === start.operation_id,
      ),
    ).toBe(false);

    // The Computer's late result is acknowledged and never applied.
    await reconnected.receive({
      ...identity,
      type: "operation.accepted",
      command_id: start.command_id,
      runner_pid: 100,
      seq: 1,
    });
    await reconnected.receive({
      ...identity,
      type: "operation.completed",
      seq: 2,
      result: {
        type: "run",
        final_response: "late",
        session: { thread_id: "thread-late" },
      },
    } as unknown as DaemonToAgentEnvelope);
    expect(
      returning.sent
        .filter((frame) => frame.type === "operation.ack")
        .map((frame) =>
          frame.type === "operation.ack" ? frame.through_seq : 0,
        ),
    ).toEqual([1, 2]);
    await consuming;
    expect(events).toEqual([]);
    expect(returning.closed).toEqual([]);
  });
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for Runner command");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("RunnerGateway provider prepare", () => {
  const prepareTarget = {
    tenantId: "tenant-acme",
    ownerActorId: "actor-alice",
    runnerId: "computer-local",
    agentId: "agent-reviewer",
    workspaceGrantId: "grant-repo",
    executionContextKey: "context-1",
    runtimeInstanceId: "runtime-1",
  };
  const providerPrepares = (peer: RecordingPeer) =>
    peer.sent.flatMap((frame) =>
      frame.type === "prepare" && frame.target === "provider" ? [frame] : [],
    );
  const connectReady = async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    placeAgent(gateway, placement());
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      principal(),
      hello(),
      peer,
    );
    await acknowledgeReady(
      connection,
      requireCommand(peer, "agent_runner.ensure"),
    );
    return { gateway, peer, connection };
  };

  it("carries the reviewed run's authorization flags only when the prepare has them", async () => {
    const { gateway, peer, connection } = await connectReady();
    const prepare = (runContext?: {
      human_interactions?: boolean;
      permission_review?: boolean;
    }) =>
      gateway.prepareProvider(prepareTarget, {
        runtime: { type: "codex" },
        sessionOptions: { thread_name: "Reviewer" },
        session: { threadId: "thread-existing" },
        contextViewRef: { view_digest: "a".repeat(64) },
        runContext,
      });

    expect(
      prepare({ human_interactions: true, permission_review: true }),
    ).toBeDefined();
    expect(prepare()).toBeDefined();
    await waitFor(() => providerPrepares(peer).length === 2);
    const [withFlags, withoutFlags] = providerPrepares(peer);
    expect(withFlags).toMatchObject({
      run_context: { human_interactions: true, permission_review: true },
    });
    expect(withoutFlags).not.toHaveProperty("run_context");
    connection.disconnect();
  });

  it("sends a fresh prepare id per presence hint and never cancels on abort or close", async () => {
    const { gateway, peer, connection } = await connectReady();
    let releaseResolve!: () => void;
    const resolveGate = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const provider = new RemoteCodexProvider({
      dispatcher: gateway,
      runtime: { type: "codex" },
      target: { ...prepareTarget, roomId: undefined } as never,
      contextRunResources: {
        async resolve() {
          await resolveGate;
          return { mcp_servers: [] };
        },
        currentContextViewRef: () => ({ view_digest: "a".repeat(64) }),
      },
    });
    const session = await provider.resumeSession(
      { threadId: "thread-existing" },
      {
        workingDirectory: "/workspace",
        threadName: "Reviewer",
        sandboxMode: "workspace-write",
        baseInstructions: "Review Room messages.",
        resources: { mcpServers: [] },
      },
    );

    provider.prepareForPresence(session);
    provider.prepareForPresence(session);
    await waitFor(() => providerPrepares(peer).length === 2);
    const [first, second] = providerPrepares(peer);
    expect(first!.prepare_id).not.toBe(second!.prepare_id);
    const sentBeforeAbort = peer.sent.length;

    const controller = new AbortController();
    const started = provider.startRun(
      session,
      { type: "text", text: "work" },
      {
        runContext: { executionRunRef: "run-1", sourceInboxIds: ["inbox-1"] },
        signal: controller.signal,
      },
    );
    controller.abort();
    releaseResolve();
    await expect(started).rejects.toThrow();
    await provider.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(peer.sent.slice(sentBeforeAbort)).toEqual([]);
    connection.disconnect();
  });
});
