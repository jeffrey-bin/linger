import { describe, expect, it, vi } from "vitest";

import { RunnerOperationState } from "../../../src/agent/runner-gateway/runner-operation.js";
import { AgentRunnerDesiredState } from "../../../src/agent/runner-gateway/agent-runner-desired-state.js";

describe("Runner Operation Assignment identity", () => {
  it("carries Registration and Assignment revision in the retained identity", () => {
    let nextId = 0;
    const operation = new RunnerOperationState({
      target: operationTarget(),
      connectionEpoch: 4,
      runnerRevision: 5,
      createId: () => `identity-${++nextId}`,
      send: vi.fn(),
      cancelTimeoutMs: 1_000,

      runtimeAssignment: {
        registrationId: "local-runtime-codex",
        assignmentRevision: 6,
      },
    });

    expect(operation.start).toMatchObject({
      registration_id: "local-runtime-codex",
      assignment_revision: 6,
    });
  });

  it("retains an independent start snapshot when caller session and resources change", () => {
    const target = {
      ...operationTarget(),
      request: {
        ...operationTarget().request,
        kind: "run.start" as const,
        session: { threadId: "" },
        run_context: {
          execution_run_ref: "run-1",
          source_inbox_ids: ["inbox-1"],
        },
        input: { type: "text" as const, text: "original" },
        run_resources: { mcp_servers: [] },
      },
    };
    let nextId = 0;
    const operation = new RunnerOperationState({
      target,
      connectionEpoch: 4,
      runnerRevision: 5,
      createId: () => `snapshot-${++nextId}`,
      send: vi.fn(),
      cancelTimeoutMs: 1_000,

      runtimeAssignment: {
        registrationId: "registration-test",
        assignmentRevision: 1,
      },
    });
    const original = structuredClone(operation.start);
    target.request.session.threadId = "created-thread";
    target.request.input.text = "later message";
    target.request.run_context.source_inbox_ids.push("inbox-later");
    target.request.session_options.thread_name = "renamed";
    target.contextViewRef.view_digest = "b".repeat(64);
    expect(
      operation.reconnectCommands({
        connectionEpoch: 5,
        retainedByDaemon: true,
      }),
    ).toEqual([original]);
  });

  it("carries the same Assignment identity through Agent Runner lifecycle", () => {
    const coordinator = new AgentRunnerDesiredState();
    coordinator.ensure({
      computerId: "computer-local",
      tenantId: "tenant-acme",
      agentId: "agent-reviewer",
      runtime: { type: "codex" },
      workspaceGrantId: "grant-local",
      registrationId: "local-runtime-codex",
      assignmentRevision: 7,
    });
    const [command] = coordinator.snapshotCommands({
      computerId: "computer-local",
      connectionEpoch: 2,
      createId: () => "runner-command-1",
    });

    expect(command).toMatchObject({
      type: "agent_runner.ensure",
      registration_id: "local-runtime-codex",
      assignment_revision: 7,
    });
  });

  it("does not replay a start after an unaccepted recovered terminal", async () => {
    let nextId = 0;
    const operation = new RunnerOperationState({
      target: operationTarget(),
      connectionEpoch: 4,
      runnerRevision: 5,
      createId: () => `terminal-${++nextId}`,
      send: vi.fn(),
      cancelTimeoutMs: 1_000,

      runtimeAssignment: {
        registrationId: "registration-test",
        assignmentRevision: 1,
      },
    });
    void operation.handle().result.catch(() => undefined);
    await operation.receive({
      ...operation.start,
      type: "operation.failed",
      seq: 1,
      error: {
        code: "DAEMON_RESTARTED",
        message: "Daemon restarted before Provider start",
        retryable: true,
      },
    });

    expect(
      operation.reconnectCommands({
        connectionEpoch: 5,
        retainedByDaemon: false,
      }),
    ).toEqual([]);
    expect(operation.start.connection_epoch).toBe(4);
  });

  it("accepts a semantically equal Context View identity with reordered fields", async () => {
    let nextId = 0;
    const operation = new RunnerOperationState({
      target: {
        tenantId: "tenant-acme",
        ownerActorId: "actor-alice",
        runnerId: "computer-local",
        executionContextKey: "context-room-main",
        runtimeInstanceId: "context-room-main",
        contextViewRef: { view_digest: "a".repeat(64) },
        agentId: "agent-reviewer",
        workspaceGrantId: "grant-local",
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
      },
      connectionEpoch: 4,
      runnerRevision: 5,
      createId: () => `identity-${++nextId}`,
      send: vi.fn(),
      cancelTimeoutMs: 1_000,

      runtimeAssignment: {
        registrationId: "registration-test",
        assignmentRevision: 1,
      },
    });

    const accepted = {
      ...operation.start,
      type: "operation.accepted" as const,
      seq: 1,
      sent_at: "2026-09-03T09:48:39.366519Z",
      runner_pid: 100,
      context_view_ref: {
        receipt_ref: "receipt-8",
        resource_digest:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        view_digest:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        view_generation: "view-8",
        context_generation: 8,
      },
    };

    await expect(operation.receive(accepted)).resolves.toMatchObject({
      type: "operation.ack",
      through_seq: 1,
    });
  });
});

const operationTarget = () => ({
  tenantId: "tenant-acme",
  ownerActorId: "actor-alice",
  runnerId: "computer-local",
  executionContextKey: "context-main",
  runtimeInstanceId: "runtime-main",
  contextViewRef: { view_digest: "a".repeat(64) },
  agentId: "agent-reviewer",
  workspaceGrantId: "grant-local",
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
