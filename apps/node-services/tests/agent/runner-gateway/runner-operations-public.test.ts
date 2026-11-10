import { describe, expect, it, vi } from "vitest";
import type {
  AgentToDaemonEnvelope,
  DaemonToAgentEnvelope,
  OperationStart,
} from "@linger/wire-contracts/runner-gateway/types";
import { LocalComputerOfflineError } from "../../../src/agent/runner-gateway/local-computer-management.js";
import {
  RunnerGatewayProtocolError,
  type RunnerGatewayConnection,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import { readyContextScope } from "../test-support/ready-context-view.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";

import {
  hello,
  contextHello,
  authenticatedPrincipal,
  RecordingPeer,
  placeAgent,
  defaultAgentPlacement,
  localContextViewIdentity,
  acknowledgeEnsuredAgent,
  acceptReadyConnection,
  FailingStartPeer,
  FailingTerminalAckPeer,
  sessionTarget,
  runTarget,
  contextRunTarget,
  event,
  sequenceIds,
  settlesWithin,
  deferred,
} from "./runner-gateway-fixtures.js";

describe("RunnerGateway", () => {
  it("starts a trusted Context Turn naming its Context View", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const placement = defaultAgentPlacement({
      workspaceGrantId: "grant-owner",
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      contextHello(),
      placement,
    );
    const context = localContextViewIdentity();
    const operation = await gateway.startOperation(contextRunTarget(context));
    const start = peer.sent
      .filter((command) => command.type === "operation.start")
      .at(-1);
    if (start?.type !== "operation.start") {
      throw new Error("Expected operation.start");
    }
    expect(start).toMatchObject({
      protocol_version: "2",
      host_access: "trusted",
    });
    expect(start).toMatchObject({
      protocol_version: "2",
      host_access: "trusted",
      workspace_grant_id: "grant-owner",
      context_view_ref: { view_digest: context.viewDigest },
      request: {
        kind: "run.start",
        run_context: {
          execution_run_ref: "local-run-context-1",
        },
      },
    });
    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    await connection.receive(
      event(start, 2, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "done",
          session: { thread_id: "thread-1" },
        },
      }),
    );
    await expect(operation.result).resolves.toMatchObject({ type: "run" });
  });

  it("reserves capacity atomically and cancels waiters", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    await gateway.acceptConnection(
      authenticatedPrincipal(),
      hello([], 1),
      new RecordingPeer(),
    );
    const target = {
      runnerId: "runner-local",
      tenantId: "tenant-acme",
      agentId: "agent-a",
      executionContextKey: "context-a",
    };
    const first = await gateway.acquireOperationCapacity(
      target,
      new AbortController().signal,
    );
    const waiting = new AbortController();
    const second = gateway.acquireOperationCapacity(
      { ...target, executionContextKey: "context-b" },
      waiting.signal,
    );
    const rejected = expect(second).rejects.toThrow();
    waiting.abort(new Error("cancel waiting Run"));
    await rejected;
    first.release();
    const next = await gateway.acquireOperationCapacity(
      target,
      new AbortController().signal,
    );
    next.release();
  });

  it("rejects a capacity reservation for an offline Computer instead of waiting", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    await expect(
      gateway.acquireOperationCapacity(
        {
          runnerId: "runner-local",
          tenantId: "tenant-acme",
          agentId: "agent-a",
          executionContextKey: "context-a",
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });

  it("allows separate Context reservations on upgraded Computers and waits for global capacity", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    const greeting = hello([], 2);
    await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...greeting,
      },
      new RecordingPeer(),
    );
    const target = {
      runnerId: "runner-local",
      tenantId: "tenant-acme",
      agentId: "agent-a",
      executionContextKey: "context-a",
    };
    const first = await gateway.acquireOperationCapacity(
      target,
      new AbortController().signal,
    );
    const second = await gateway.acquireOperationCapacity(
      { ...target, executionContextKey: "context-b" },
      new AbortController().signal,
    );
    let acquired = false;
    const third = gateway
      .acquireOperationCapacity(
        { ...target, executionContextKey: "context-c" },
        new AbortController().signal,
      )
      .then((permit) => {
        acquired = true;
        return permit;
      });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(acquired).toBe(false);
    first.release();
    (await third).release();
    second.release();
  });

  it("does not count bound Agent Runners against active Operation capacity", async () => {
    const gateway = createTestRunnerGateway();
    for (const agentId of ["agent-reviewer", "agent-second", "agent-third"])
      placeAgent(gateway, defaultAgentPlacement({ agentId }));
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello([], 1),
        workspace_grants: [
          {
            grant_id: "grant-repo",
            tenant_id: "tenant-acme",
            label: "Linger workspace",
            mode: "workspace-write",
            scope: "owner",
          },
        ],
      },
      peer,
    );
    for (let ensured = 0; ensured < 3; ensured++)
      await acknowledgeEnsuredAgent(connection, peer, true);

    const permit = await gateway.acquireOperationCapacity(
      {
        runnerId: "runner-local",
        tenantId: "tenant-acme",
        agentId: "agent-third",
        executionContextKey: "context-third",
      },
      new AbortController().signal,
    );
    permit.release();
    connection.disconnect();
  });

  it("admits more than two active Operations when the Computer has no global limit", async () => {
    const agentIds = ["agent-a", "agent-b", "agent-c"];
    const gateway = createTestRunnerGateway({
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    for (const agentId of agentIds) {
      placeAgent(gateway, defaultAgentPlacement({ agentId }));
    }
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello([], null),
        workspace_grants: [
          {
            grant_id: "grant-repo",
            tenant_id: "tenant-acme",
            label: "Linger workspace",
            mode: "workspace-write",
            scope: "owner",
          },
        ],
      },
      peer,
    );
    for (const _agentId of agentIds) {
      await acknowledgeEnsuredAgent(connection, peer, true);
    }

    await expect(
      Promise.all(
        agentIds.map((agentId) =>
          gateway.startOperation({
            ...sessionTarget(),
            ...readyContextScope(agentId),
            agentId,
            ownerActorId: "actor-alice",
          }),
        ),
      ),
    ).resolves.toHaveLength(3);
  });

  it("queues a Run's whole Operation as one unit of its endpoint", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer, {
      ...hello(),
      runtime_diagnostics: runtimeDiagnostics({ link: "api" }),
    });
    const codex = { computerId: "runner-local", runtimeType: "codex" as const };
    try {
      const wiki = await gateway.acquireModelChain(
        codex,
        { priority: 70, kind: "wiki", key: "wiki:test" },
        new AbortController().signal,
      );
      // A running unit is never interrupted: the Run waits for it.
      let sent = false;
      const started = gateway.startOperation(sessionTarget()).then((value) => {
        sent = true;
        return value;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent).toBe(false);
      expect(
        peer.sent.some((command) => command.type === "operation.start"),
      ).toBe(false);
      const memory = gateway.acquireModelChain(
        codex,
        { priority: 40, kind: "memory", key: "memory:test" },
        new AbortController().signal,
      );
      wiki.release({ outcome: "completed" });
      const operation = await started;
      const start = peer.sent.find(
        (command) => command.type === "operation.start",
      );
      if (start?.type !== "operation.start")
        throw new Error("Expected operation.start");
      let admitted = false;
      void memory.then(() => (admitted = true));
      await connection.receive(
        event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      );
      expect(admitted).toBe(false);
      await connection.receive(
        event(start, 2, {
          type: "operation.completed",
          result: {
            type: "run",
            final_response: "done",
            session: { thread_id: "thread-1" },
          },
        }),
      );
      await operation.result;
      (await memory).release({ outcome: "completed" });
      expect(admitted).toBe(true);
    } finally {
      connection.disconnect();
    }
  });

  it.each(["disconnect", "replacement", "removal"] as const)(
    "rejects a start whose capacity permit predates a %s",
    async (change) => {
      const gateway = createTestRunnerGateway({
        heartbeatIntervalMs: 60_000,
        createId: sequenceIds(),
      });
      const peer = new RecordingPeer();
      const connection = await acceptReadyConnection(gateway, peer);
      const permit = await gateway.acquireOperationCapacity(
        sessionTarget(),
        new AbortController().signal,
      );
      let replacement: RunnerGatewayConnection | undefined;
      let removal: Promise<unknown> | undefined;
      try {
        if (change === "disconnect") connection.disconnect();
        if (change === "replacement")
          replacement = await acceptReadyConnection(
            gateway,
            new RecordingPeer(),
          );
        if (change === "removal") {
          removal = gateway.finalizeDeletedLocalAgentRunner("agent-reviewer");
          await vi.waitFor(() =>
            expect(peer.sent.at(-1)?.type).toBe("agent_runner.remove"),
          );
        }
        await expect(
          gateway.startOperation({
            ...sessionTarget(),
            capacityPermit: permit,
          }),
        ).rejects.toThrow();
        expect(
          peer.sent.some((command) => command.type === "operation.start"),
        ).toBe(false);
      } finally {
        replacement?.disconnect();
        connection.disconnect();
        await removal;
      }
    },
  );

  it("routes one operation to the exact Runner and deduplicates replayed events", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);

    const operation = await gateway.startOperation({
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      runnerId: "runner-local",
      ...readyContextScope(),
      agentId: "agent-reviewer",
      workspaceGrantId: "grant-repo",
      request: {
        kind: "run.start",
        runtime: { type: "codex", model: "codex-default" },
        session_options: {
          thread_name: "Reviewer",
        },
        session: { threadId: "" },
        input: { type: "text", text: "hello" },
        run_context: { execution_run_ref: "run-1", source_inbox_ids: [] },
        run_resources: { mcp_servers: [] },
      },
    });

    expect(peer.sent[0]).toMatchObject({
      type: "runner.welcome",
      runner_id: "runner-local",
      reconcile_operation_ids: [],
    });
    const start = peer.sent[1] as OperationStart;
    expect(start).toMatchObject({
      type: "operation.start",
      tenant_id: "tenant-acme",
      runner_id: "runner-local",
      execution_context_key: readyContextScope().executionContextKey,
      context_view_ref: readyContextScope().contextViewRef,
      agent_id: "agent-reviewer",
      workspace_grant_id: "grant-repo",
      generation: 1,
    });

    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    await connection.receive(
      event(start, 2, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "",
          session: { thread_id: "thread-1" },
        },
      }),
    );

    await expect(operation.result).resolves.toEqual({
      type: "run",
      final_response: "",
      session: { thread_id: "thread-1" },
    });
    const acks = peer.sent.filter(
      (envelope) => envelope.type === "operation.ack",
    );
    expect(acks.map((ack) => ack.through_seq)).toEqual([1, 1, 2]);
  });

  it("reconciles and resends the same command after reconnect", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const firstPeer = new RecordingPeer();
    const first = await acceptReadyConnection(gateway, firstPeer);
    const operation = await gateway.startOperation({
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      runnerId: "runner-local",
      ...readyContextScope(),
      agentId: "agent-reviewer",
      workspaceGrantId: "grant-repo",
      request: {
        kind: "run.start",
        runtime: { type: "codex" },
        session_options: {
          thread_name: "Reviewer",
        },
        session: { threadId: "" },
        input: { type: "text", text: "hello" },
        run_context: { execution_run_ref: "run-1", source_inbox_ids: [] },
        run_resources: { mcp_servers: [] },
      },
    });
    const start = firstPeer.sent[1] as OperationStart;
    first.disconnect();

    const secondPeer = new RecordingPeer();
    const second = await acceptReadyConnection(
      gateway,
      secondPeer,
      hello([
        {
          tenant_id: start.tenant_id,
          runner_id: start.runner_id,
          protocol_version: start.protocol_version,
          host_access: start.host_access,
          registration_id: start.registration_id,
          assignment_revision: start.assignment_revision,
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
          kind: start.request.kind,
          last_emitted_seq: 0,
          last_acked_seq: 0,
        },
      ]),
    );

    expect(secondPeer.sent[0]).toMatchObject({
      type: "runner.welcome",
      reconcile_operation_ids: [start.operation_id],
    });
    expect(secondPeer.sent[1]).toEqual(start);
    await second.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 101,
      }),
    );
    await second.receive(
      event(start, 2, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "",
          session: { thread_id: "thread-1" },
        },
      }),
    );
    await expect(operation.result).resolves.toMatchObject({ type: "run" });

    second.disconnect();
    const thirdPeer = new RecordingPeer();
    const third = await acceptReadyConnection(gateway, thirdPeer);
    // The ended Operation is gone; its replayed terminal is acknowledged and
    // dropped.
    expect(thirdPeer.sent[0]).toMatchObject({
      type: "runner.welcome",
      reconcile_operation_ids: [],
    });
    expect(thirdPeer.sent.map((frame) => frame.type)).toEqual([
      "runner.welcome",
    ]);
    await third.receive(
      event(start, 2, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "",
          session: { thread_id: "thread-1" },
        },
      }),
    );
    expect(thirdPeer.sent.at(-1)).toMatchObject({
      type: "operation.ack",
      through_seq: 2,
    });
  });

  it("ends an Operation with the terminal a restarted Daemon numbers from 1", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const firstPeer = new RecordingPeer();
    const first = await acceptReadyConnection(gateway, firstPeer);
    const operation = await gateway.startOperation(sessionTarget());
    void operation.result.catch(() => undefined);
    const start = firstPeer.sent[1] as OperationStart;
    for (const seq of [1, 2])
      await first.receive(
        seq === 1
          ? event(start, 1, {
              type: "operation.accepted",
              command_id: start.command_id,
              runner_pid: 100,
            })
          : event(start, 2, {
              type: "operation.event",
              event: { type: "message.delta", message_id: "m-1", delta: "x" },
            }),
      );
    first.disconnect();

    // The restarted Daemon reports nothing active; the resent start is
    // answered with an interruption it numbers from 1.
    const secondPeer = new RecordingPeer();
    const second = await acceptReadyConnection(gateway, secondPeer);
    expect(secondPeer.sent).toContainEqual(start);
    const interrupted = event(start, 1, {
      type: "operation.failed",
      stage: "runtime_execution",
      error: {
        code: "DAEMON_RESTARTED",
        message: "Local Computer Daemon restarted",
        retryable: false,
      },
    });
    await second.receive(interrupted);
    await expect(operation.result).rejects.toMatchObject({
      code: "DAEMON_RESTARTED",
      retryable: false,
    });
    expect(secondPeer.sent.at(-1)).toMatchObject({
      type: "operation.ack",
      through_seq: 1,
    });
    // Its replay is acknowledged at the same sequence.
    await second.receive(interrupted);
    expect(secondPeer.sent.at(-1)).toMatchObject({
      type: "operation.ack",
      through_seq: 1,
    });
  });

  it("rebases an unaccepted start that the daemon never received", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const firstPeer = new RecordingPeer();
    const first = await acceptReadyConnection(gateway, firstPeer);
    const operation = await gateway.startOperation(sessionTarget());
    const original = firstPeer.sent[1] as OperationStart;
    expect(original.connection_epoch).toBe(1);
    first.disconnect();

    const secondPeer = new RecordingPeer();
    const second = await acceptReadyConnection(gateway, secondPeer);
    const replay = secondPeer.sent[1];
    expect(replay).toMatchObject({
      type: "operation.start",
      operation_id: original.operation_id,
      command_id: original.command_id,
      connection_epoch: 2,
    });
    if (replay?.type !== "operation.start") {
      throw new Error("Expected rebased operation.start");
    }
    await second.receive(
      event(replay, 1, {
        type: "operation.accepted",
        command_id: replay.command_id,
        runner_pid: 101,
      }),
    );
    await second.receive(
      event(replay, 2, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "",
          session: { thread_id: "thread-rebased" },
        },
      }),
    );
    await expect(operation.result).resolves.toMatchObject({
      type: "run",
      final_response: "",
      session: { thread_id: "thread-rebased" },
    });
    second.disconnect();
  });

  it("retires terminal state when acknowledgement delivery is indeterminate", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const firstPeer = new FailingTerminalAckPeer();
    const first = await acceptReadyConnection(gateway, firstPeer);
    const operation = await gateway.startOperation(sessionTarget());
    const start = firstPeer.sent[1] as OperationStart;
    await first.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );

    await expect(
      first.receive(
        event(start, 2, {
          type: "operation.completed",
          result: {
            type: "run",
            final_response: "",
            session: { thread_id: "thread-1" },
          },
        }),
      ),
    ).rejects.toThrow("terminal acknowledgement send failed");
    await expect(operation.result).resolves.toMatchObject({ type: "run" });

    const recoveryPeer = new RecordingPeer();
    const recovery = await acceptReadyConnection(gateway, recoveryPeer);
    // The terminal ended the Operation here; a replay of it is only
    // acknowledged.
    expect(recoveryPeer.sent).toEqual([
      expect.objectContaining({
        type: "runner.welcome",
        reconcile_operation_ids: [],
      }),
    ]);
    await recovery.receive(
      event(start, 2, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "",
          session: { thread_id: "thread-1" },
        },
      }),
    );
    expect(recoveryPeer.sent.at(-1)).toMatchObject({
      type: "operation.ack",
      through_seq: 2,
    });
  });

  it.each([false, true])(
    "resends an unconfirmed input after reconnect (submitted offline: %s)",
    async (submittedOffline) => {
      const gateway = createTestRunnerGateway({
        heartbeatIntervalMs: 1_000,
        createId: sequenceIds(),
      });
      const firstPeer = new RecordingPeer();
      const first = await acceptReadyConnection(gateway, firstPeer);
      const operation = await gateway.startOperation({
        tenantId: "tenant-acme",
        ownerActorId: "actor-alice",
        runnerId: "runner-local",
        ...readyContextScope(),
        agentId: "agent-reviewer",
        workspaceGrantId: "grant-repo",
        request: {
          kind: "run.start",
          runtime: { type: "codex" },
          session_options: {
            thread_name: "Reviewer",
          },
          session: { thread_id: "thread-1" },
          input: { type: "text", text: "Review" },
          run_context: {
            execution_run_ref: "run-1",
            source_inbox_ids: ["room:room-main"],
          },
          run_resources: { mcp_servers: [] },
        },
      });
      const start = firstPeer.sent[1] as OperationStart;
      await first.receive(
        event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      );
      if (submittedOffline) first.disconnect();
      const inputOutcome = operation.input({
        expectedTurnId: "turn-1",
        input: { type: "text", text: "Inspect the tests" },
      });
      if (!submittedOffline) {
        await vi.waitFor(() =>
          expect(firstPeer.sent.at(-1)).toMatchObject({
            type: "operation.input",
          }),
        );
        first.disconnect();
      }
      const originalInput = submittedOffline
        ? undefined
        : firstPeer.sent.at(-1);

      const secondPeer = new RecordingPeer();
      const second = await acceptReadyConnection(
        gateway,
        secondPeer,
        hello([
          {
            tenant_id: start.tenant_id,
            runner_id: start.runner_id,
            protocol_version: start.protocol_version,
            host_access: start.host_access,
            registration_id: start.registration_id,
            assignment_revision: start.assignment_revision,
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
            kind: start.request.kind,
            last_emitted_seq: 1,
            last_acked_seq: 1,
          },
        ]),
      );

      const input = secondPeer.sent.at(-1);
      expect(input).toMatchObject({
        type: "operation.input",
        input: { type: "text", text: "Inspect the tests" },
      });
      expect(secondPeer.sent.slice(1)).toEqual([start, originalInput ?? input]);
      await second.receive(
        event(start, 2, {
          type: "operation.input_result",
          outcome: "accepted",
          command_id:
            input?.type === "operation.input" ? input.command_id : "invalid",
          turn_id: "turn-1",
        }),
      );
      await expect(inputOutcome).resolves.toEqual({ turnId: "turn-1" });
    },
  );

  it("settles late input without disconnecting or extending the completed Run sequence", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    const operation = await gateway.startOperation(runTarget());
    const start = peer.sent[1] as OperationStart;
    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    const outcome = operation
      .input({
        expectedTurnId: "turn-1",
        input: { type: "text", text: "follow-up" },
      })
      .catch((error) => error);
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "operation.input",
      }),
    );
    const command = peer.sent.at(-1)!;
    if (command.type !== "operation.input") throw new Error("missing input");
    const {
      type: _type,
      input: _input,
      input_context_view_ref: _view,
      ...identity
    } = command;
    const receipt = {
      ...identity,
      type: "operation.input_result" as const,
      outcome: "closed" as const,
      effect: "definitely_not_applied" as const,
    };
    await connection.receive(receipt);
    expect(await outcome).toMatchObject({ effect: "definitely_not_applied" });
    await connection.receive(
      event(start, 2, {
        type: "operation.completed",
        result: { type: "run", final_response: "done", session: {} },
      }),
    );
    await expect(operation.result).resolves.toMatchObject({
      final_response: "done",
    });
    await connection.receive(receipt);
    expect(peer.closed).toEqual([]);
    expect(peer.sent.at(-1)).toMatchObject({
      type: "operation.ack",
      through_seq: 2,
    });
  });

  it("rejects an input acknowledgement for another turn", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    const operation = await gateway.startOperation(runTarget());
    const start = peer.sent[1] as OperationStart;
    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    const inputOutcome = operation.input({
      expectedTurnId: "turn-expected",
      input: { type: "text", text: "Inspect the tests" },
    });
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({ type: "operation.input" }),
    );
    const input = peer.sent.at(-1);
    if (input?.type !== "operation.input") {
      throw new Error("Expected an operation.input command");
    }

    await expect(
      connection.receive(
        event(start, 2, {
          type: "operation.input_result",
          outcome: "accepted",
          command_id: input.command_id,
          turn_id: "turn-other",
        }),
      ),
    ).rejects.toBeInstanceOf(RunnerGatewayProtocolError);
    expect(peer.closed).toEqual([
      { code: 1002, reason: "Runner protocol violation" },
    ]);

    const recoveryPeer = new RecordingPeer();
    const recovery = await acceptReadyConnection(gateway, recoveryPeer);
    await recovery.receive(
      event(start, 2, {
        type: "operation.input_result",
        outcome: "accepted",
        command_id: input.command_id,
        turn_id: "turn-expected",
      }),
    );
    await expect(inputOutcome).resolves.toEqual({ turnId: "turn-expected" });
  });

  it("serializes concurrent events before committing their sequence", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    const operation = await gateway.startOperation(sessionTarget());
    const start = peer.sent[1] as OperationStart;

    await Promise.all([
      connection.receive(
        event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      ),
      connection.receive(
        event(start, 2, {
          type: "operation.completed",
          result: {
            type: "run",
            final_response: "",
            session: { thread_id: "thread-1" },
          },
        }),
      ),
    ]);

    await expect(operation.result).resolves.toMatchObject({ type: "run" });
    expect(
      peer.sent
        .filter((frame) => frame.type === "operation.ack")
        .map((frame) => frame.through_seq),
    ).toEqual([1, 2]);
  });

  it("cancels an Operation whose start send was indeterminate when the Computer reports it", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const failingPeer = new FailingStartPeer();
    await acceptReadyConnection(gateway, failingPeer);

    await expect(gateway.startOperation(sessionTarget())).rejects.toThrow(
      "start send failed",
    );
    const start = failingPeer.sent.find(
      (frame) => frame.type === "operation.start",
    );
    if (start?.type !== "operation.start")
      throw new Error("Expected operation.start");

    const recoveryPeer = new RecordingPeer();
    await acceptReadyConnection(
      gateway,
      recoveryPeer,
      hello([
        {
          tenant_id: start.tenant_id,
          runner_id: start.runner_id,
          protocol_version: start.protocol_version,
          host_access: start.host_access,
          registration_id: start.registration_id,
          assignment_revision: start.assignment_revision,
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
          kind: start.request.kind,
          last_emitted_seq: 0,
          last_acked_seq: 0,
        },
      ]),
    );
    expect(recoveryPeer.sent.map((frame) => frame.type)).toEqual([
      "runner.welcome",
      "cancel",
    ]);
    expect(recoveryPeer.sent[1]).toMatchObject({
      target: "operation",
      operation_id: start.operation_id,
    });
  });

  it("rejects stale generations without publishing them", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    await gateway.startOperation({
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      runnerId: "runner-local",
      ...readyContextScope(),
      agentId: "agent-reviewer",
      workspaceGrantId: "grant-repo",
      request: {
        kind: "run.start",
        runtime: { type: "codex" },
        session_options: {
          thread_name: "Reviewer",
        },
        session: { threadId: "" },
        input: { type: "text", text: "hello" },
        run_context: { execution_run_ref: "run-1", source_inbox_ids: [] },
        run_resources: { mcp_servers: [] },
      },
    });
    const start = peer.sent[1] as OperationStart;

    await expect(
      connection.receive({
        ...event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
        generation: 2,
      } as DaemonToAgentEnvelope),
    ).rejects.toBeInstanceOf(RunnerGatewayProtocolError);
    expect(peer.closed).toEqual([
      { code: 1002, reason: "Runner protocol violation" },
    ]);
  });

  it("does not acknowledge beyond its bounded event consumer", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    const operation = await gateway.startOperation({
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      runnerId: "runner-local",
      ...readyContextScope(),
      agentId: "agent-reviewer",
      workspaceGrantId: "grant-repo",
      request: {
        kind: "run.start",
        runtime: { type: "codex" },
        session_options: {
          thread_name: "Reviewer",
        },
        session: { thread_id: "thread-1" },
        input: { type: "text", text: "Review" },
        run_context: {
          execution_run_ref: "run-1",
          source_inbox_ids: ["room:room-main"],
        },
        run_resources: { mcp_servers: [] },
      },
    });
    const start = peer.sent[1] as OperationStart;
    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    for (let index = 0; index < 64; index += 1) {
      await connection.receive(
        event(start, index + 2, {
          type: "operation.event",
          event: {
            type: "message.delta",
            message_id: "message-1",
            delta: "x",
          },
        }),
      );
    }
    const blocked = connection.receive(
      event(start, 66, {
        type: "operation.event",
        event: {
          type: "message.delta",
          message_id: "message-1",
          delta: "y",
        },
      }),
    );

    await expect(settlesWithin(blocked, 20)).resolves.toBe(false);
    const iterator = operation.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(blocked).resolves.toBeUndefined();
    expect(
      peer.sent.filter((frame) => frame.type === "operation.ack").at(-1),
    ).toMatchObject({ through_seq: 66 });
    await iterator.return?.();
  });

  it("locally terminates an unconfirmed cancellation so reconnect does not replay it", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      operationCancelTimeoutMs: 20,
      createId: sequenceIds(),
    });
    const firstPeer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, firstPeer);
    const operation = await gateway.startOperation({
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      runnerId: "runner-local",
      ...readyContextScope(),
      agentId: "agent-reviewer",
      workspaceGrantId: "grant-repo",
      request: {
        kind: "run.start",
        runtime: { type: "codex" },
        session_options: {
          thread_name: "Reviewer",
        },
        session: { thread_id: "thread-1" },
        input: { type: "text", text: "Review" },
        run_context: {
          execution_run_ref: "run-1",
          source_inbox_ids: ["room:room-main"],
        },
        run_resources: { mcp_servers: [] },
      },
    });
    connection.disconnect();

    await expect(operation.cancel("stop requested")).resolves.toBeUndefined();
    await expect(operation.result).rejects.toMatchObject({
      name: "RunnerOperationError",
      code: "cancelled",
    });

    const secondPeer = new RecordingPeer();
    await acceptReadyConnection(gateway, secondPeer);
    expect(secondPeer.sent.map((frame) => frame.type)).toEqual([
      "runner.welcome",
    ]);
  });
});

it("accepts duplicate closed-input after definitive result and 512-entry cache eviction", async () => {
  const gateway = createTestRunnerGateway({
    heartbeatIntervalMs: 60_000,
    createId: sequenceIds(),
  });
  const peer = new RecordingPeer();
  const connection = await acceptReadyConnection(gateway, peer);
  const operation = await gateway.startOperation(runTarget());
  const start = peer.sent.at(-1)!;
  if (start.type !== "operation.start") throw new Error("missing start");
  await connection.receive(
    event(start, 1, {
      type: "operation.accepted",
      command_id: start.command_id,
      runner_pid: 100,
    }),
  );
  const inputOutcome = operation
    .input({
      expectedTurnId: "turn-1",
      input: { type: "text", text: "late" },
    })
    .catch((error) => error);
  await vi.waitFor(() =>
    expect(peer.sent.at(-1)?.type).toBe("operation.input"),
  );
  const input = peer.sent.at(-1)!;
  if (input.type !== "operation.input") throw new Error("missing input");
  const {
    type: _type,
    input: _input,
    input_context_view_ref: _view,
    ...identity
  } = input;
  const closed = {
    ...identity,
    type: "operation.input_result" as const,
    outcome: "closed" as const,
    effect: "definitely_not_applied" as const,
  };
  await connection.receive(closed);
  expect(await inputOutcome).toMatchObject({
    effect: "definitely_not_applied",
  });
  await connection.receive(
    event(start, 2, {
      type: "operation.completed",
      result: { type: "run", final_response: "done", session: {} },
    }),
  );
  await operation.result;

  // Exceed the 512-entry cache of retired Operations.
  for (let completed = 0; completed < 513; completed++) {
    const later = await gateway.startOperation(runTarget());
    const laterStart = peer.sent.at(-1)!;
    if (laterStart.type !== "operation.start")
      throw new Error("missing later start");
    await connection.receive(
      event(laterStart, 1, {
        type: "operation.accepted",
        command_id: laterStart.command_id,
        runner_pid: 100,
      }),
    );
    await connection.receive(
      event(laterStart, 2, {
        type: "operation.completed",
        result: { type: "run", final_response: "done", session: {} },
      }),
    );
    await later.result;
  }
  expect(peer.closed).toEqual([]);

  await expect(connection.receive(closed)).resolves.toBeUndefined();
  expect(peer.closed).toEqual([]);
  connection.disconnect();
});

it.each(["release", "disconnect"] as const)(
  "wakes a capacity waiter at once on a %s",
  async (change) => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      createId: sequenceIds(),
    });
    const connection = await acceptReadyConnection(
      gateway,
      new RecordingPeer(),
      { ...hello(), capacity: 1 },
    );
    const permit = await gateway.acquireOperationCapacity(
      runTarget(),
      new AbortController().signal,
    );
    const waiting = gateway
      .acquireOperationCapacity(runTarget(), new AbortController().signal)
      .then(
        (acquired) => ({ acquired, error: undefined }),
        (error: unknown) => ({ acquired: undefined, error }),
      );
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const changedAt = Date.now();
      if (change === "release") permit.release();
      else connection.disconnect();
      const outcome = await waiting;
      expect(Date.now() - changedAt).toBeLessThan(500);
      if (change === "release") expect(outcome.acquired).toBeDefined();
      else expect(outcome.error).toBeInstanceOf(LocalComputerOfflineError);
      outcome.acquired?.release();
    } finally {
      permit.release();
      connection.disconnect();
    }
  },
);

it("loses no capacity wake while many waiters acquire, release and leave", async () => {
  const gateway = createTestRunnerGateway({
    heartbeatIntervalMs: 60_000,
    createId: sequenceIds(),
  });
  const greeting = hello([], 2);
  const connection = await acceptReadyConnection(gateway, new RecordingPeer(), {
    ...greeting,
  });
  const startedAt = Date.now();
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, async (_, index) => {
        const controller = new AbortController();
        // Every fifth waiter leaves the queue before it is served.
        if (index % 5 === 4) setTimeout(() => controller.abort(), 1);
        const permit = await gateway.acquireOperationCapacity(
          { ...runTarget(), executionContextKey: `context-${index % 3}` },
          controller.signal,
        );
        await new Promise((resolve) => setTimeout(resolve, 1 + (index % 3)));
        permit.release();
      }),
    );
    expect(
      outcomes.filter(({ status }) => status === "fulfilled").length,
    ).toBeGreaterThanOrEqual(24);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  } finally {
    connection.disconnect();
  }
});

it("reserves capacity from fresh occupancy for concurrent waiters", async () => {
  const gateway = createTestRunnerGateway({
    heartbeatIntervalMs: 60_000,
    createId: sequenceIds(),
  });
  const peer = new RecordingPeer();
  const connection = await acceptReadyConnection(gateway, peer, {
    ...hello(),
    capacity: 1,
  });
  let secondAcquired = false;
  const first = gateway.acquireOperationCapacity(
    runTarget(),
    new AbortController().signal,
  );
  const second = gateway
    .acquireOperationCapacity(runTarget(), new AbortController().signal)
    .then((permit) => {
      secondAcquired = true;
      return permit;
    });
  const firstPermit = await first;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(secondAcquired).toBe(false);
  firstPermit.release();
  const secondPermit = await second;
  secondPermit.release();
  connection.disconnect();
});

describe("an input still in flight at the terminal", () => {
  const inFlightInput = async (
    options: { operationCancelTimeoutMs?: number; capacity?: number } = {},
  ) => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      createId: sequenceIds(),
      ...(options.operationCancelTimeoutMs === undefined
        ? {}
        : { operationCancelTimeoutMs: options.operationCancelTimeoutMs }),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      hello([], options.capacity ?? 2),
    );
    const operation = await gateway.startOperation(runTarget());
    const start = peer.sent.at(-1)!;
    if (start.type !== "operation.start") throw new Error("missing start");
    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    const outcome = operation
      .input({
        expectedTurnId: "turn-1",
        input: { type: "text", text: "follow-up" },
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)?.type).toBe("operation.input"),
    );
    const input = peer.sent.at(-1)!;
    if (input.type !== "operation.input") throw new Error("missing input");
    const {
      type: _type,
      input: _input,
      input_context_view_ref: _view,
      ...identity
    } = input;
    const closed = (effect: "definitely_not_applied" | "uncertain") => ({
      ...identity,
      type: "operation.input_result" as const,
      outcome: "closed" as const,
      effect,
    });
    const complete = async () => {
      await connection.receive(
        event(start, 2, {
          type: "operation.completed",
          result: { type: "run", final_response: "done", session: {} },
        }),
      );
      await operation.result;
    };
    return {
      gateway,
      peer,
      connection,
      operation,
      start,
      outcome,
      closed,
      complete,
    };
  };

  it.each(["definitely_not_applied", "uncertain"] as const)(
    "settles from a %s closed receipt that arrives after the terminal",
    async (effect) => {
      const { peer, connection, outcome, closed, complete } =
        await inFlightInput();
      await complete();
      let settled = false;
      void outcome.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);

      await connection.receive(closed(effect));
      expect(await outcome).toMatchObject({
        name: "RunnerOperationInputError",
        effect,
        reason: "no_active_turn",
      });
      // Replays of the receipt after the input settled are ignored.
      await expect(
        connection.receive(closed("definitely_not_applied")),
      ).resolves.toBeUndefined();
      expect(peer.closed).toEqual([]);
      connection.disconnect();
    },
  );

  it("is uncertain when no receipt arrives within the cancel timeout", async () => {
    const { peer, connection, outcome, closed, complete } = await inFlightInput(
      { operationCancelTimeoutMs: 20 },
    );
    await complete();
    expect(await outcome).toMatchObject({
      name: "RunnerOperationInputError",
      effect: "uncertain",
      reason: "transport",
    });
    // A receipt after the timeout neither reopens the input nor fails the
    // connection.
    await expect(
      connection.receive(closed("definitely_not_applied")),
    ).resolves.toBeUndefined();
    expect(peer.closed).toEqual([]);
    connection.disconnect();
  });

  it("is uncertain after the connection is lost and is never resent", async () => {
    const { gateway, connection, outcome, complete } = await inFlightInput();
    await complete();
    connection.disconnect();
    const recoveryPeer = new RecordingPeer();
    await acceptReadyConnection(gateway, recoveryPeer);
    expect(await outcome).toMatchObject({
      name: "RunnerOperationInputError",
      effect: "uncertain",
      reason: "transport",
    });
    expect(
      recoveryPeer.sent.filter((frame) => frame.type === "operation.input"),
    ).toEqual([]);
  });

  it("frees capacity at the terminal while it still routes the receipt", async () => {
    const { gateway, peer, connection, outcome, closed, complete } =
      await inFlightInput({ capacity: 1 });
    const next = gateway.acquireOperationCapacity(
      {
        runnerId: "runner-local",
        tenantId: "tenant-acme",
        agentId: "agent-reviewer",
        executionContextKey: runTarget().executionContextKey,
      },
      new AbortController().signal,
    );
    expect(await settlesWithin(next, 20)).toBe(false);
    await complete();
    expect(await settlesWithin(next, 1_000)).toBe(true);
    (await next).release();

    await connection.receive(closed("definitely_not_applied"));
    expect(await outcome).toMatchObject({ effect: "definitely_not_applied" });
    expect(peer.closed).toEqual([]);
    connection.disconnect();
  });

  it("is uncertain at once when the Gateway ends the Operation itself", async () => {
    const { operation, outcome } = await inFlightInput({
      operationCancelTimeoutMs: 20,
    });
    // The Daemon never confirms the cancellation, so the Gateway ends the
    // Operation locally while the Daemon may still run the input.
    await operation.cancel("stop requested");
    expect(await settlesWithin(outcome, 5)).toBe(true);
    expect(await outcome).toMatchObject({
      effect: "uncertain",
      reason: "transport",
    });
  });

  it("keeps waiting for a receipt of an input resent on the new connection", async () => {
    const { gateway, connection, start, outcome, closed } =
      await inFlightInput();
    connection.disconnect();
    const resent = deferred<void>();
    const release = deferred<void>();
    class GatedPeer extends RecordingPeer {
      override async send(envelope: AgentToDaemonEnvelope): Promise<void> {
        await super.send(envelope);
        if (envelope.type === "operation.input") {
          resent.resolve();
          await release.promise;
        }
      }
    }
    const recoveryPeer = new GatedPeer();
    placeAgent(gateway, defaultAgentPlacement());
    const recovery = await gateway.acceptConnection(
      authenticatedPrincipal(),
      hello([], 2),
      recoveryPeer,
    );
    const reconciled = acknowledgeEnsuredAgent(recovery, recoveryPeer, true);
    await resent.promise;
    // The Daemon replays its terminal while reconciliation is still running.
    await recovery.receive(
      event(start, 2, {
        type: "operation.completed",
        result: { type: "run", final_response: "done", session: {} },
      }),
    );
    release.resolve();
    await reconciled;
    await recovery.receive(closed("definitely_not_applied"));
    expect(await outcome).toMatchObject({ effect: "definitely_not_applied" });
    expect(recoveryPeer.closed).toEqual([]);
    recovery.disconnect();
  });

  it("is uncertain at once when the connection that carried it is replaced", async () => {
    const { gateway, outcome, complete } = await inFlightInput();
    await complete();
    const replacementPeer = new RecordingPeer();
    const replacement = await acceptReadyConnection(gateway, replacementPeer);
    expect(await settlesWithin(outcome, 5)).toBe(true);
    expect(await outcome).toMatchObject({
      effect: "uncertain",
      reason: "transport",
    });
    expect(
      replacementPeer.sent.filter((frame) => frame.type === "operation.input"),
    ).toEqual([]);
    replacement.disconnect();
  });

  it("ignores the late close of a connection replaced before the input was sent", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      createId: sequenceIds(),
    });
    const stalePeer = new RecordingPeer();
    const stale = await acceptReadyConnection(gateway, stalePeer);
    const operation = await gateway.startOperation(runTarget());
    const start = stalePeer.sent.at(-1)!;
    if (start.type !== "operation.start") throw new Error("missing start");
    await stale.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    const currentPeer = new RecordingPeer();
    const current = await acceptReadyConnection(gateway, currentPeer);
    const outcome = operation
      .input({
        expectedTurnId: "turn-1",
        input: { type: "text", text: "follow-up" },
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(currentPeer.sent.at(-1)?.type).toBe("operation.input"),
    );
    const input = currentPeer.sent.at(-1)!;
    if (input.type !== "operation.input") throw new Error("missing input");
    const {
      type: _type,
      input: _input,
      input_context_view_ref: _view,
      ...identity
    } = input;
    await current.receive(
      event(start, 2, {
        type: "operation.completed",
        result: { type: "run", final_response: "done", session: {} },
      }),
    );
    await operation.result;
    stale.disconnect();
    await current.receive({
      ...identity,
      type: "operation.input_result",
      outcome: "closed",
      effect: "definitely_not_applied",
    });
    expect(await outcome).toMatchObject({ effect: "definitely_not_applied" });
    expect(currentPeer.closed).toEqual([]);
    current.disconnect();
  });

  it.each(["receipt", "timeout"] as const)(
    "stops routing receipts to the Operation once its input settles by %s",
    async (settledBy) => {
      const { peer, connection, outcome, closed, complete } =
        await inFlightInput({ operationCancelTimeoutMs: 20 });
      await complete();
      if (settledBy === "receipt")
        await connection.receive(closed("definitely_not_applied"));
      await outcome;
      // A routed receipt is checked against the Operation identity; one that
      // reaches no Operation is dropped without a check.
      await expect(
        connection.receive({
          ...closed("definitely_not_applied"),
          execution_lease_id: "lease-other",
        }),
      ).resolves.toBeUndefined();
      expect(peer.closed).toEqual([]);
      connection.disconnect();
    },
  );
});
