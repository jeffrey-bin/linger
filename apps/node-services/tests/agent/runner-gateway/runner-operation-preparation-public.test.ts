import { captureRuntimeMeasurements } from "../test-support/runtime-measurement-log.js";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentToDaemonEnvelope,
  OperationStart,
} from "@linger/wire-contracts/runner-gateway/types";
import { parseDaemonToAgentEnvelope } from "@linger/wire-contracts/runner-gateway/validator";
import { LocalMcpRelay } from "../../../src/agent/runner-gateway/local-mcp-relay.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";

import {
  contextHello,
  RecordingPeer,
  defaultAgentPlacement,
  localContextViewIdentity,
  acceptReadyConnection,
  TestDeferred,
  runTarget,
  runIdentity,
  contextRunTarget,
  event,
  preparedEvent,
  sequenceIds,
  settlesWithin,
} from "./runner-gateway-fixtures.js";

describe("RunnerGateway", () => {
  it("holds an MCP initialize request until the dispatched Operation is accepted", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      contextHello(),
      defaultAgentPlacement({ workspaceGrantId: "grant-owner" }),
    );
    const context = localContextViewIdentity();
    let onAuthorization!: () => void;
    const authorizationSeen = new Promise<void>((resolve) => {
      onAuthorization = resolve;
    });
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const relay = new LocalMcpRelay({
      publicOrigin: "https://agent.test",
      authorizer: {
        authorizeLocalMcpRelay(options) {
          onAuthorization();
          return gateway.authorizeLocalMcpRelay(options);
        },
      },
    });
    const [descriptor] = relay.register({
      run: {
        ...context,
        executionRunRef: "local-run-context-1",
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      servers: [
        { name: "teamhub", url: "https://teamhub.test/mcp", toolNames: [] },
      ],
    });
    if (!descriptor) throw new Error("Expected relay descriptor");
    const target = contextRunTarget(context, [descriptor]);
    const operation = await gateway.startOperation(target);
    const start = peer.sent.at(-1);
    if (start?.type !== "operation.start")
      throw new Error("Expected operation.start");
    try {
      // The HTTP request overtakes the accepted frame on the separate WebSocket.
      const response = relay.handle(
        new URL(descriptor.relay_url).pathname.split("/").at(-1)!,
        new Request(descriptor.relay_url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${descriptor.relay_token}`,
            "content-type": "application/json",
            "x-linger-operation-id": start.operation_id,
            "x-linger-execution-lease-id": start.execution_lease_id,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {},
          }),
        }),
      );
      await authorizationSeen;
      expect(upstream).not.toHaveBeenCalled();
      await connection.receive(
        event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      );
      expect((await response).status).toBe(204);
      expect(upstream).toHaveBeenCalledTimes(1);
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
    } finally {
      upstream.mockRestore();
      await relay.close();
    }
  });

  it("prepares exact Context MCP relays before the Operation starts", async () => {
    const measurements = captureRuntimeMeasurements();
    const prepareSent = new TestDeferred();
    const releasePrepare = new TestDeferred();
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new (class extends RecordingPeer {
      override async send(envelope: AgentToDaemonEnvelope): Promise<void> {
        await super.send(envelope);
        if (envelope.type === "prepare" && envelope.target === "operation") {
          prepareSent.resolve(undefined);
          await releasePrepare.promise;
        }
      }
    })();
    const capableHello = contextHello();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      capableHello,
      defaultAgentPlacement({ workspaceGrantId: "grant-owner" }),
    );
    const context = localContextViewIdentity();
    const descriptor = {
      name: "teamhub",
      relay_url: "https://agent.test/v1/local-mcp-relay/relay-prepare",
      relay_token: "r".repeat(32),
      tool_names: ["send_message"],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };

    const admission = gateway.startOperation(
      contextRunTarget(context, [descriptor]),
    );
    await prepareSent.promise;

    const prepare = peer.sent.find(
      (envelope) =>
        envelope.type === "prepare" && envelope.target === "operation",
    );
    expect(prepare).toMatchObject({
      type: "prepare",
      target: "operation",
      tenant_id: context.tenantId,
      runner_id: context.computerId,
      agent_id: context.agentId,
      workspace_grant_id: context.workspaceGrantId,
      runtime_type: "codex",
      context_view_ref: { view_digest: context.viewDigest },
      mcp_relays: [descriptor],
    });
    expect(
      peer.sent.some((envelope) => envelope.type === "operation.start"),
    ).toBe(false);
    if (!prepare) throw new Error("Expected operation.prepare");
    const authorization = {
      run: {
        ...context,
        executionRunRef: "local-run-context-1",
      },
      operationId: prepare.operation_id,
      executionLeaseId: prepare.execution_lease_id,
      descriptor,
    };
    await expect(
      gateway.authorizeLocalMcpRelay({
        ...authorization,
        methodClass: "initialize",
      }),
    ).resolves.toBeUndefined();
    await expect(
      gateway.authorizeLocalMcpRelay({
        ...authorization,
        executionLeaseId: "stale-lease",
        methodClass: "initialize",
      }),
    ).rejects.toThrow("identity mismatch");
    const preparedReceipt = connection.receive({
      ...preparedEvent(prepare),
      prepare_native_resume: { duration_ms: 125, result: "success" },
    });
    const toolAuthorization = gateway.authorizeLocalMcpRelay({
      ...authorization,
      methodClass: "tools_call",
    });
    expect(await settlesWithin(toolAuthorization, 10)).toBe(false);

    releasePrepare.resolve(undefined);
    const operation = await admission;
    await preparedReceipt;
    expect(measurements.calls()).toEqual([
      ["local", "native_resume", "success", 125],
    ]);
    const start = peer.sent.at(-1);
    if (start?.type !== "operation.start")
      throw new Error("Expected operation.start");
    expect(start.operation_id).toBe(prepare?.operation_id);
    expect(start.execution_lease_id).toBe(prepare?.execution_lease_id);
    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    await expect(toolAuthorization).resolves.toBeUndefined();
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
    measurements.restore();
  });

  it.each([
    ["operation.completed", "success", "command_id"],
    ["operation.failed", "error", "execution_lease_id"],
    ["operation.cancelled", "canceled", "connection_epoch"],
  ] as const)(
    "ignores authenticated late prepare receipts after %s retires the Operation",
    async (terminalType, resumeResult, mismatchedField) => {
      const measurements = captureRuntimeMeasurements();
      const gateway = createTestRunnerGateway({
        heartbeatIntervalMs: 1_000,
        createId: sequenceIds(),
      });
      const peer = new RecordingPeer();
      const capableHello = contextHello();
      const connection = await acceptReadyConnection(
        gateway,
        peer,
        capableHello,
        defaultAgentPlacement({ workspaceGrantId: "grant-owner" }),
      );
      try {
        const context = localContextViewIdentity();
        const operation = await gateway.startOperation(
          contextRunTarget(context, [
            {
              name: "teamhub",
              relay_url: "https://agent.test/v1/local-mcp-relay/relay-prepare",
              relay_token: "r".repeat(32),
              tool_names: [],
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ]),
        );
        const prepare = peer.sent.find(
          (envelope) =>
            envelope.type === "prepare" && envelope.target === "operation",
        );
        const start = peer.sent.find(
          (envelope) => envelope.type === "operation.start",
        );
        if (!prepare || !start) throw new Error("Expected prepare and start");
        await connection.receive(
          event(start, 1, {
            type: "operation.accepted",
            command_id: start.command_id,
            runner_pid: 100,
          }),
        );
        const prepareResume = { duration_ms: 125, result: resumeResult };
        const terminal = parseDaemonToAgentEnvelope(
          event(
            start,
            2,
            terminalType === "operation.completed"
              ? {
                  type: terminalType,
                  result: {
                    type: "run",
                    final_response: "done",
                    session: { thread_id: "thread-1" },
                    prepare_native_resume: prepareResume,
                  },
                }
              : {
                  type: terminalType,
                  ...(terminalType === "operation.failed"
                    ? {
                        stage: "runtime_execution",
                        error: {
                          code: "RUNTIME_EXECUTION_FAILED",
                          message: "prepare failed",
                          retryable: false,
                        },
                      }
                    : { reason: "user canceled" }),
                  prepare_native_resume: prepareResume,
                },
          ),
        );
        const result =
          terminalType === "operation.completed"
            ? expect(operation.result).resolves.toMatchObject({ type: "run" })
            : expect(operation.result).rejects.toThrow();
        await connection.receive(terminal);
        await result;
        expect(peer.sent.at(-1)).toMatchObject({
          type: "operation.ack",
          through_seq: 2,
        });
        expect(measurements.calls()).toEqual([
          ["local", "native_resume", resumeResult, 125],
        ]);
        const sentCount = peer.sent.length;
        const latePrepared = parseDaemonToAgentEnvelope({
          ...preparedEvent(
            prepare,
            terminalType === "operation.completed" ? "ready" : "fallback",
          ),
          prepare_native_resume: prepareResume,
        });
        await expect(connection.receive(latePrepared)).resolves.toBeUndefined();
        await expect(connection.receive(latePrepared)).resolves.toBeUndefined();
        // A replayed terminal of the retired Operation is acknowledged and dropped.
        await expect(connection.receive(terminal)).resolves.toBeUndefined();
        expect(peer.sent).toHaveLength(sentCount + 1);
        expect(peer.closed).toEqual([]);
        expect(measurements.calls()).toHaveLength(1);
        await expect(
          connection.receive({
            ...latePrepared,
            [mismatchedField]:
              mismatchedField === "connection_epoch"
                ? prepare.connection_epoch + 1
                : "forged-identity",
          }),
        ).rejects.toThrow("unmatched Operation MCP prepare outcome");
        expect(peer.closed).toEqual([
          { code: 1002, reason: "Runner protocol violation" },
        ]);
      } finally {
        connection.disconnect();
        measurements.restore();
      }
    },
  );

  // The default Agent CI image has no Go toolchain. Match the existing real
  // daemon test opt-in; the ordinary retirement regressions above always run.
  it
    .skipIf(process.env.LINGER_GO_LOCAL_DAEMON_TEST !== "1")
    .each(["operation.completed", "operation.failed", "operation.cancelled"])(
    "authenticates late prepare after %s retirement and deduplicates Go wire replays",
    async (terminalType) => {
      const measurements = captureRuntimeMeasurements();
      const gateway = createTestRunnerGateway({
        heartbeatIntervalMs: 60_000,
        createId: sequenceIds(),
      });
      const peer = new RecordingPeer();
      const capableHello = contextHello();
      capableHello.capabilities = [...capableHello.capabilities];
      const connection = await acceptReadyConnection(
        gateway,
        peer,
        capableHello,
        defaultAgentPlacement({ workspaceGrantId: "grant-owner" }),
      );
      const fixtureRoot = mkdtempSync(
        path.join(os.tmpdir(), "prepare-resume-wire-"),
      );
      try {
        const context = localContextViewIdentity();
        const descriptor = {
          name: "teamhub",
          relay_url: "https://agent.test/v1/local-mcp-relay/relay-prepare",
          relay_token: "r".repeat(32),
          tool_names: [],
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        };
        const operation = await gateway.startOperation(
          contextRunTarget(context, [descriptor]),
        );
        // Observe the result before failed/cancelled terminals reject it.
        const result = operation.result.catch((error: unknown) => error);
        const prepare = peer.sent.find(
          (envelope) =>
            envelope.type === "prepare" && envelope.target === "operation",
        );
        const start = peer.sent.find(
          (envelope) => envelope.type === "operation.start",
        );
        if (!prepare || !start) throw new Error("Expected prepare and start");
        const fixtureFile = path.join(fixtureRoot, "outcomes.json");
        await promisify(execFile)(
          "go",
          [
            "test",
            "./internal/linger/transport",
            "-run",
            "^TestOperationEventForwardsPrepareResumeMeasurement$",
            "-count=1",
          ],
          {
            cwd: fileURLToPath(
              new URL("../../../../computer/local-daemon/", import.meta.url),
            ),
            env: {
              ...process.env,
              LINGER_PREPARE_RESUME_WIRE_IDENTITY: JSON.stringify(prepare),
              LINGER_PREPARE_RESUME_WIRE_FIXTURE: fixtureFile,
            },
            timeout: 120_000,
          },
        );
        const outcomes = (
          JSON.parse(readFileSync(fixtureFile, "utf8")) as unknown[]
        ).map(parseDaemonToAgentEnvelope);
        const prepared = outcomes.find(
          (outcome) =>
            outcome.type === "prepared" && outcome.target === "operation",
        );
        const terminal = outcomes.find(
          (outcome) => outcome.type === terminalType,
        );
        if (!prepared || !terminal) throw new Error("Missing Go wire outcomes");
        await connection.receive(
          event(start, 1, {
            type: "operation.accepted",
            command_id: start.command_id,
            runner_pid: 100,
          }),
        );
        await connection.receive(terminal);
        await result;
        expect(measurements.calls()).toEqual([
          ["local", "native_resume", "error", 50],
          ["local", "native_resume", "success", 123],
        ]);
        // Retirement revokes execution authority even though late receipts
        // retain their original identity for authentication.
        await expect(
          gateway.authorizeLocalMcpRelay({
            run: {
              ...context,
              executionRunRef: "local-run-context-1",
            },
            operationId: prepare.operation_id,
            executionLeaseId: prepare.execution_lease_id,
            descriptor,
            methodClass: "initialize",
          }),
        ).rejects.toThrow("not active");
        await expect(connection.receive(prepared)).resolves.toBeUndefined();
        await connection.receive(prepared);
        await connection.receive(terminal);
        expect(measurements.calls()).toHaveLength(2);
        expect(peer.closed).toEqual([]);
      } finally {
        connection.disconnect();
        measurements.restore();
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    130_000,
  );

  it("does not send MCP prepare for a pending Codex first run", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const capableHello = contextHello();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      capableHello,
      defaultAgentPlacement({ workspaceGrantId: "grant-owner" }),
    );
    const context = localContextViewIdentity();
    const descriptor = {
      name: "teamhub",
      relay_url: "https://agent.test/v1/local-mcp-relay/relay-no-prepare",
      relay_token: "r".repeat(32),
      tool_names: ["send_message"],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const target = contextRunTarget(context, [descriptor]);

    const operation = await gateway.startOperation({
      ...target,
      request: {
        ...target.request,
        session: { threadId: "" },
      },
    });

    expect(
      peer.sent.some(
        (envelope) =>
          envelope.type === "prepare" && envelope.target === "operation",
      ),
    ).toBe(false);
    const start = peer.sent.at(-1);
    if (start?.type !== "operation.start")
      throw new Error("Expected operation.start");
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
    await operation.result;
  });

  it("starts directly when the Run has no MCP server to prepare", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    const operation = await gateway.startOperation(runTarget());
    expect(
      peer.sent.some(
        (envelope) =>
          envelope.type === "prepare" && envelope.target === "operation",
      ),
    ).toBe(false);
    const start = peer.sent.at(-1);
    if (start?.type !== "operation.start")
      throw new Error("Expected operation.start");
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
    await operation.result;
  });

  it("falls back to operation.start when the MCP relay set exceeds the prepare limit", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const capableHello = contextHello();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      capableHello,
      defaultAgentPlacement({ workspaceGrantId: "grant-owner" }),
    );
    const context = localContextViewIdentity();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const descriptors = Array.from({ length: 65 }, (_, index) => ({
      name: `server-${index}`,
      relay_url: `https://agent.test/v1/local-mcp-relay/relay-${index}`,
      relay_token: `${index}`.padEnd(32, "r"),
      tool_names: [],
      expires_at: expiresAt,
    }));

    const operation = await gateway.startOperation(
      contextRunTarget(context, descriptors),
    );

    expect(
      peer.sent.some(
        (envelope) =>
          envelope.type === "prepare" && envelope.target === "operation",
      ),
    ).toBe(false);
    const start = peer.sent.at(-1);
    if (start?.type !== "operation.start")
      throw new Error("Expected operation.start");
    if (start.request.kind !== "run.start")
      throw new Error("Expected run.start request");
    expect(start.request.run_resources.mcp_servers).toHaveLength(65);
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
    await operation.result;
  });

  it.each(["abort", "terminal"])(
    "rejects pending MCP authorization on %s",
    async (outcome) => {
      const gateway = createTestRunnerGateway({
        heartbeatIntervalMs: 1_000,
        createId: sequenceIds(),
      });
      const peer = new RecordingPeer();
      const connection = await acceptReadyConnection(gateway, peer);
      const target = runTarget();
      const descriptor = {
        name: "teamhub",
        relay_url: "https://agent.test/relay",
        relay_token: "r".repeat(32),
        tool_names: [],
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
      target.request.run_resources = { mcp_servers: [descriptor] };
      const operation = await gateway.startOperation(target);
      void operation.result.catch(() => undefined);
      const start = peer.sent.at(-1);
      if (start?.type !== "operation.start")
        throw new Error("Expected operation.start");
      const controller = new AbortController();
      const authorization = {
        run: runIdentity(),
        operationId: start.operation_id,
        executionLeaseId: start.execution_lease_id,
        descriptor,
        signal: controller.signal,
      };
      await expect(
        gateway.authorizeLocalMcpRelay({
          ...authorization,
          executionLeaseId: "wrong-lease",
        }),
      ).rejects.toThrow("identity mismatch");
      const pending = gateway.authorizeLocalMcpRelay(authorization);
      const rejected = expect(pending).rejects.toThrow(
        outcome === "abort" ? "aborted" : "not active",
      );
      if (outcome === "abort") controller.abort();
      await connection.receive(
        event(start, 1, {
          type: "operation.failed",
          stage: "runtime_execution",
          error: {
            code: "RUNTIME_EXECUTION_FAILED",
            message: "failed before acceptance",
            retryable: false,
          },
        }),
      );
      await rejected;
      await expect(operation.result).rejects.toThrow(
        "failed before acceptance",
      );
    },
  );

  it("authorizes Local MCP Relay only for the accepted active Operation and lease", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    const target = runTarget();
    const descriptor = {
      name: "teamhub_run",
      relay_url: "http://agent.test/v1/local-mcp-relay/relay-1",
      relay_token: "r".repeat(32),
      tool_names: ["materialize_artifact"],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    target.request.run_resources = { mcp_servers: [descriptor] };
    const operation = await gateway.startOperation(target);
    const start = peer.sent[1] as OperationStart;
    const authorization = {
      run: runIdentity(),
      operationId: start.operation_id,
      executionLeaseId: start.execution_lease_id,
      descriptor,
    };

    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    await expect(
      gateway.authorizeLocalMcpRelay(authorization),
    ).resolves.toBeUndefined();
    await expect(
      gateway.authorizeLocalMcpRelay({
        ...authorization,
        executionLeaseId: "lease-other",
      }),
    ).rejects.toThrow("identity mismatch");

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
    await expect(gateway.authorizeLocalMcpRelay(authorization)).rejects.toThrow(
      "not active",
    );
  });

  it("authorizes Context MCP Relay only for the exact ready View and active Turn lease", async () => {
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

    const descriptor = {
      name: "teamhub_context",
      relay_url: "http://agent.test/v1/local-mcp-relay/relay-context",
      relay_token: "r".repeat(32),
      tool_names: ["upload_artifacts"],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const target = contextRunTarget(context, [descriptor]);
    const operation = await gateway.startOperation(target);
    const start = peer.sent.at(-1);
    if (start?.type !== "operation.start") {
      throw new Error("Expected operation.start");
    }
    const authorization = {
      run: {
        computerId: context.computerId,
        tenantId: context.tenantId,
        agentId: context.agentId,
        runnerRevision: context.runnerRevision,
        workspaceGrantId: context.workspaceGrantId,
        executionRunRef: "local-run-context-1",
        executionContextKey: context.executionContextKey,
        runtimeInstanceId: context.runtimeInstanceId,
        viewDigest: context.viewDigest,
      },
      operationId: start.operation_id,
      executionLeaseId: start.execution_lease_id,
      descriptor,
    };

    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    await expect(
      gateway.authorizeLocalMcpRelay(authorization),
    ).resolves.toBeUndefined();
    // An input naming another View must invalidate the old MCP view.
    const refreshedView = { view_digest: "d".repeat(64) };
    const inputOutcome = operation.input({
      expectedTurnId: "turn-1",
      input: { type: "text", text: "Read the refreshed Context" },
      contextViewRef: refreshedView,
    });
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "operation.input",
        input_context_view_ref: refreshedView,
      }),
    );
    const input = peer.sent.at(-1);
    if (input?.type !== "operation.input") {
      throw new Error("Expected operation.input");
    }
    await connection.receive(
      event(start, 2, {
        type: "operation.input_result",
        outcome: "accepted",
        command_id: input.command_id,
        turn_id: "turn-1",
      }),
    );
    await inputOutcome;
    await expect(gateway.authorizeLocalMcpRelay(authorization)).rejects.toThrow(
      "identity mismatch",
    );
    await expect(
      gateway.authorizeLocalMcpRelay({
        ...authorization,
        run: {
          ...authorization.run,
          viewDigest: refreshedView.view_digest,
        },
      }),
    ).resolves.toBeUndefined();
    for (const run of [
      { ...authorization.run, contextGeneration: 2 },
      { ...authorization.run, viewReceiptRef: "stale-ready-receipt" },
    ]) {
      await expect(
        gateway.authorizeLocalMcpRelay({ ...authorization, run }),
      ).rejects.toThrow("identity mismatch");
    }
    await expect(
      gateway.authorizeLocalMcpRelay({
        ...authorization,
        executionLeaseId: "lease-other",
      }),
    ).rejects.toThrow("identity mismatch");

    await connection.receive(
      event(start, 3, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "done",
          session: { thread_id: "thread-1" },
        },
      }),
    );
    await operation.result;
    await expect(gateway.authorizeLocalMcpRelay(authorization)).rejects.toThrow(
      "not active",
    );
  });
});
