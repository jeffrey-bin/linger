import { afterEach, expect, it, vi } from "vitest";

import {
  RunnerOperationState,
  type OperationEnvelope,
} from "../../../src/agent/runner-gateway/runner-operation.js";
import { setAgentLogOptions } from "../../../src/agent/observability/agent-log.js";

afterEach(() => {
  vi.unstubAllEnvs();
  setAgentLogOptions();
  vi.restoreAllMocks();
});

it("bridges a run.start operation log to its execution Run", () => {
  vi.stubEnv("AGENT_LOG_LEVEL", "info");
  setAgentLogOptions({ format: "json" });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  let nextId = 0;

  new RunnerOperationState({
    target: {
      tenantId: "tenant-test",
      runnerId: "computer-test",
      agentId: "agent-test",
      workspaceGrantId: "grant-test",
      executionContextKey: "context-test",
      runtimeInstanceId: "runtime-test",
      contextViewRef: { view_digest: "a".repeat(64) },
      request: {
        kind: "run.start",
        runtime: { type: "codex" },
        session_options: {
          thread_name: "Observable",
        },
        session: { threadId: "thread-1" },
        input: { type: "text", text: "must not be logged" },
        run_resources: { mcp_servers: [] },
        run_context: {
          execution_run_ref: "run-observable",
          source_inbox_ids: ["room:room-1"],
        },
      },
    },
    connectionEpoch: 1,
    runnerRevision: 1,
    createId: () => `operation-log-${++nextId}`,
    send: vi.fn(),
    cancelTimeoutMs: 1_000,

    runtimeAssignment: {
      registrationId: "registration-test",
      assignmentRevision: 1,
    },
  });

  const entries = output.mock.calls
    .map(([line]) => JSON.parse(String(line)))
    .filter((entry) => entry.event === "runner.operation.created");
  expect(entries).toEqual([
    expect.objectContaining({
      executionRunRef: "run-observable",
      kind: "run.start",
      createdAtUnixMs: expect.any(Number),
    }),
  ]);
  expect(JSON.stringify(entries)).not.toContain("must not be logged");
});

it("logs each run.start send and its first acceptance with monotonic durations", async () => {
  vi.stubEnv("AGENT_LOG_LEVEL", "info");
  setAgentLogOptions({ format: "json" });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  let nextId = 0;
  const operation = new RunnerOperationState({
    target: {
      tenantId: "tenant-test",
      runnerId: "computer-test",
      agentId: "agent-test",
      workspaceGrantId: "grant-test",
      executionContextKey: "context-test",
      runtimeInstanceId: "runtime-test",
      contextViewRef: { view_digest: "a".repeat(64) },
      request: {
        kind: "run.start",
        runtime: { type: "codex" },
        session_options: {
          thread_name: "Observable",
        },
        session: { threadId: "thread-1" },
        input: { type: "text", text: "hello" },
        run_resources: { mcp_servers: [] },
        run_context: {
          execution_run_ref: "run-observable",
          source_inbox_ids: ["room:room-1"],
        },
      },
    },
    connectionEpoch: 1,
    runnerRevision: 1,
    createId: () => `operation-timing-${++nextId}`,
    send: vi.fn(),
    cancelTimeoutMs: 1_000,

    runtimeAssignment: {
      registrationId: "registration-test",
      assignmentRevision: 1,
    },
  });
  const events = () =>
    output.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((entry) => entry.event.startsWith("runner.operation."));

  operation.noteStartSent();
  operation.noteStartSent();
  const accepted = {
    ...operation.start,
    type: "operation.accepted",
    seq: 1,
  } as unknown as OperationEnvelope;
  await operation.receive(accepted);
  await operation.receive(accepted);

  const sent = events().filter(
    (entry) => entry.event === "runner.operation.sent",
  );
  expect(sent).toEqual([
    expect.objectContaining({
      operationId: operation.start.operation_id,
      computerId: "computer-test",
      kind: "run.start",
      connectionEpoch: 1,
      sinceCreatedMs: expect.any(Number),
      replay: false,
    }),
    expect.objectContaining({
      operationId: operation.start.operation_id,
      sinceCreatedMs: expect.any(Number),
      replay: true,
    }),
  ]);
  const acceptedEntries = events().filter(
    (entry) => entry.event === "runner.operation.accepted_received",
  );
  expect(acceptedEntries).toEqual([
    expect.objectContaining({
      operationId: operation.start.operation_id,
      computerId: "computer-test",
      kind: "run.start",
      sinceCreatedMs: expect.any(Number),
      sinceSentMs: expect.any(Number),
    }),
  ]);
});
