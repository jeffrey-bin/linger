import {
  computerTargetRelease,
  type ComputerRelease,
} from "../../../src/agent/runner-gateway/computer-release.js";

import {
  MINIMUM_COMPUTER_VERSION,
  FIRST_PROTOCOL_2_COMPUTER_VERSION,
  MINIMUM_CURRENT_COMPUTER_VERSION,
} from "../../../src/agent/runner-gateway/local-computer-management.js";
import {
  computerDaemonIdentityProofPayload,
  createComputerDaemonIdentityVerifier,
  type ComputerDaemonIdentityVerifier,
} from "../../../src/agent/runner-gateway/daemon-identity-verifier.js";
import {
  createTestLocalComputerRegistry,
  testRunnerPlacement,
} from "../test-support/local-computer-registry.js";
import {
  createRunnerCredentialTestFixture,
  createTestRunnerCredentialAuthority,
} from "../test-support/runner-credential-authority.js";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type {
  RunnerHello,
  ActiveOperation,
  AgentToDaemonEnvelope,
  DaemonToAgentEnvelope,
  OperationStart,
  RunEvent,
} from "@linger/wire-contracts/runner-gateway/types";

import { type RunnerCredentialAuthenticator } from "../../../src/agent/runner-gateway/runner-credential-authority.js";
import {
  attachRunnerGatewayWebSocket,
  RUNNER_UPGRADE_REQUIRED_CLOSE_REASON,
  type AttachRunnerGatewayWebSocketOptions,
} from "../../../src/agent/runner-gateway/runner-gateway-websocket.js";
import {
  RunnerGatewayProtocolError,
  RunnerUpgradeRequiredError,
  type RunnerOperation,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import {
  createTestRunnerGateway,
  testComputerRelease,
} from "../test-support/runner-gateway.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";
import { readyContextScope } from "../test-support/ready-context-view.js";
import { webSocketMessageText } from "../test-support/websocket-message-text.js";
import {
  CURRENT_RUNNER_CAPABILITIES,
  currentRunnerIdentity,
} from "../test-support/runner-capabilities.js";
import { setAgentLogOptions } from "../../../src/agent/observability/agent-log.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
  setAgentLogOptions();
});

describe("Runner Gateway WebSocket", () => {
  it.each(["duplicate hello", "invalid JSON"])(
    "logs one safe accepted hello before %s",
    async (badFrame) => {
      vi.stubEnv("AGENT_LOG_LEVEL", "info");
      setAgentLogOptions({ format: "json" });
      const output = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const fixture = await startFixture();
      const socket = new WebSocket(fixture.url, {
        headers: { Authorization: "Bearer runner-secret" },
      });
      try {
        const incoming = messages(socket);
        await opened(socket);
        socket.send(JSON.stringify(hello()));
        expect((await incoming.next()).value?.type).toBe("runner.welcome");
        const acceptedEntries = () =>
          output.mock.calls
            .map(
              ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
            )
            .filter((entry) => entry.event === "runner.hello.accepted");
        await vi.waitFor(() => expect(acceptedEntries()).toHaveLength(1));
        const accepted = acceptedEntries();
        expect(accepted[0]).toMatchObject({
          computerId: "runner-local",
          daemonVersion: MINIMUM_CURRENT_COMPUTER_VERSION,
          protocolVersion: "2",
        });
        const safeLog = JSON.stringify(accepted);
        for (const secret of [
          "runner-secret",
          "tenant-acme",
          "actor-alice",
          "workspace_grants",
          "daemon_identity",
          "public_key",
          "proof",
          "connection_nonce",
          "runtime_diagnostics",
        ])
          expect(safeLog).not.toContain(secret);
        const closed = onceClosed(socket);
        socket.send(
          badFrame === "duplicate hello" ? JSON.stringify(hello()) : "{",
        );
        expect(await closed).toMatchObject({ code: 1002 });
        expect(acceptedEntries()).toHaveLength(1);
      } finally {
        socket.terminate();
        output.mockRestore();
      }
    },
  );

  it.each([
    ["old version", { ...hello(), daemon_version: "0.21.9", obsolete: true }],
    [
      "missing protocol version",
      Object.fromEntries(
        Object.entries(hello()).filter(([key]) => key !== "protocol_version"),
      ),
    ],
    ["invalid envelope", { ...hello(), unexpected: true }],
    ["invalid version", { ...hello(), daemon_version: "v0.13.0-secret" }],
    ["invalid JSON", "{"],
    ["non-hello", heartbeatFrame()],
  ])("rejects %s before Gateway admission", async (_name, frame) => {
    const fixture = await startFixture();
    const accept = vi.spyOn(fixture.gateway, "acceptConnection");
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    await opened(socket);
    const closed = onceClosed(socket);
    const payload = typeof frame === "string" ? frame : JSON.stringify(frame);
    socket.send(payload);
    socket.send(JSON.stringify({ ...hello(), daemon_version: "9.9.9" }));
    await closed;
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([["service error", hello(), undefined]])(
    "classifies Gateway admission errors: %s",
    async (_name, frame, outcome) => {
      const onSessionError = vi.fn();
      const fixture = await startFixture({ onSessionError });
      const accept = vi.spyOn(fixture.gateway, "acceptConnection");
      if (!outcome)
        accept.mockRejectedValueOnce(new Error("service unavailable"));
      const socket = new WebSocket(fixture.url, {
        headers: { Authorization: "Bearer runner-secret" },
      });
      await opened(socket);
      const closed = onceClosed(socket);
      socket.send(JSON.stringify(frame));
      await closed;
      expect(accept).toHaveBeenCalledOnce();
      if (outcome)
        expect(onSessionError).toHaveBeenCalledWith(
          expect.any(
            outcome === "upgrade_required"
              ? RunnerUpgradeRequiredError
              : RunnerGatewayProtocolError,
          ),
          expect.objectContaining({ phase: "runner.hello" }),
        );
    },
  );

  it.each(["close", "invalid frame"])(
    "cleans up pending admission after %s",
    async (ending) => {
      const fixture = await startFixture();
      const original = fixture.gateway.acceptConnection.bind(fixture.gateway);
      let markAdmitted!: () => void;
      const admitted = new Promise<void>((resolve) => {
        markAdmitted = resolve;
      });
      let releaseAdmission!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      const accept = vi
        .spyOn(fixture.gateway, "acceptConnection")
        .mockImplementationOnce(async (...args) => {
          const handle = await original(...args);
          markAdmitted();
          await release;
          return handle;
        });
      const socket = new WebSocket(fixture.url, {
        headers: { Authorization: "Bearer runner-secret" },
      });
      try {
        await opened(socket);
        socket.send(JSON.stringify(hello()));
        await admitted;
        const closed = onceClosed(socket);
        if (ending === "close") socket.close();
        else
          socket.send(
            JSON.stringify({
              ...hello(),
              daemon_version: "9.9.9",
              unexpected: true,
            }),
          );
        await closed;
      } finally {
        releaseAdmission();
        socket.terminate();
      }
      await vi.waitFor(() => expect(accept).toHaveResolved());
    },
  );

  it.each(["past", "future"] as const)(
    "closes a stale %s proof with safe diagnostics and accepts a fresh connection",
    async (reason) => {
      vi.stubEnv("AGENT_LOG_LEVEL", "info");
      setAgentLogOptions({ format: "json" });
      const output = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const warnings = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const onSessionError = vi.fn();
      const fixture = await startFixture({
        computerDaemonIdentityVerifier: createComputerDaemonIdentityVerifier(),
        onSessionError,
      });
      // TeamHub binds the Daemon Identity when it records a connection.
      const bind = vi.spyOn(fixture.computerRegistry, "connect");
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const rawKey = publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32);
      const proofHello = (offset: number, nonce: string) => {
        const frame = {
          ...hello(),
          protocol_version: "2" as const,
          sent_at: new Date(Date.now() + offset).toISOString(),
          connection_nonce: nonce,
          daemon_identity: {
            daemon_id: createHash("sha256").update(rawKey).digest("base64url"),
            public_key: rawKey.toString("base64"),
            identity_version: 1,
            proof: "",
          },
        };
        frame.daemon_identity.proof = sign(
          null,
          computerDaemonIdentityProofPayload(frame),
          privateKey,
        ).toString("base64");
        return frame;
      };
      const socket = new WebSocket(fixture.url, {
        headers: { Authorization: "Bearer runner-secret" },
      });
      try {
        await opened(socket);
        const stale = proofHello(
          reason === "past" ? -600_000 : 600_000,
          "stale",
        );
        const closed = onceClosed(socket);
        socket.send(JSON.stringify(stale));
        expect(await closed).toMatchObject({ code: 1002 });
        expect(bind).not.toHaveBeenCalled();
        const logs = JSON.stringify([
          ...output.mock.calls,
          ...warnings.mock.calls,
        ]);
        expect(logs).toContain("runner.identity_proof.stale");
        for (const field of [
          "sentAt",
          "verifiedAtUnixMs",
          "frameReceivedAtUnixMs",
          "differenceMs",
          "proofMaxAgeMs",
          "queueElapsedMs",
          "daemonVersion",
          "protocolVersion",
          "clientFieldsVerified",
          reason,
        ])
          expect(logs).toContain(field);
        expect(logs).not.toContain(stale.daemon_identity.proof);
        expect(logs).not.toContain(stale.daemon_identity.public_key);
        expect(logs).not.toContain("runner-secret");
        const fresh = proofHello(0, "fresh");
        const current = new WebSocket(fixture.url, {
          headers: { Authorization: "Bearer runner-secret" },
        });
        const incoming = messages(current);
        await opened(current);
        current.send(JSON.stringify(fresh));
        expect((await incoming.next()).value).toMatchObject({
          type: "runner.welcome",
        });
        expect(bind).toHaveBeenCalledOnce();
        // Replayed proof cannot replace the accepted connection.
        const replay = new WebSocket(fixture.url, {
          headers: { Authorization: "Bearer runner-secret" },
        });
        await opened(replay);
        const replayClosed = onceClosed(replay);
        replay.send(JSON.stringify(fresh));
        expect(await replayClosed).toMatchObject({ code: 1002 });
        expect(current.readyState).toBe(WebSocket.OPEN);
        current.terminate();
      } finally {
        socket.terminate();
        output.mockRestore();
        warnings.mockRestore();
      }
    },
  );

  it("reports the original hello exception with safe Computer and phase context", async () => {
    const onSessionError = vi.fn();
    const fixture = await startFixture({ onSessionError });
    const original = new Error(
      "Agent Runtime Assignment requires explicit rebind",
    );
    vi.spyOn(fixture.gateway, "acceptConnection").mockRejectedValueOnce(
      original,
    );
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    await opened(socket);
    const closed = onceClosed(socket);
    socket.send(JSON.stringify(hello()));
    expect(await closed).toMatchObject({
      code: 1011,
      reason: "Runner service failure",
    });
    expect(onSessionError).toHaveBeenCalledWith(original, {
      computerId: "runner-local",
      phase: "runner.hello",
      agentId: undefined,
    });
    expect(JSON.stringify(onSessionError.mock.calls)).not.toContain(
      "runner-secret",
    );
    expect(JSON.stringify(onSessionError.mock.calls)).not.toContain(
      "workspace_grants",
    );
  });
  it("keeps received heartbeats live while a registry write blocks the business queue", async () => {
    const fixture = await startFixture({ heartbeatTimeoutMs: 200 });
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    const incoming = messages(socket);
    await opened(socket);
    socket.send(JSON.stringify(hello()));
    expect((await incoming.next()).value).toMatchObject({
      type: "runner.welcome",
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const touch = vi
      .spyOn(fixture.computerRegistry, "touch")
      .mockImplementationOnce(async () => {
        await blocked;
      });
    try {
      const heartbeat = () =>
        socket.send(
          JSON.stringify({
            type: "runner.heartbeat",
            protocol_version: "2",
            runner_id: "runner-local",
            sent_at: new Date().toISOString(),
            active_operation_ids: [],
          }),
        );
      heartbeat();
      await vi.waitFor(() => expect(touch).toHaveBeenCalled());
      for (let i = 0; i < 6; i += 1) {
        heartbeat();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      release();
    }
    // A truly silent peer must still expire after the unchanged deadline.
    expect(await onceClosed(socket)).toMatchObject({
      code: 1001,
      reason: "Runner heartbeat timed out",
    });
  });

  it("drops frames that arrive after a heartbeat timeout while the close is pending", async () => {
    const onSessionError = vi.fn();
    const fixture = await startFixture({
      heartbeatTimeoutMs: 200,
      onSessionError,
    });
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    const incoming = messages(socket);
    await opened(socket);
    socket.send(JSON.stringify(hello()));
    expect((await incoming.next()).value).toMatchObject({
      type: "runner.welcome",
    });
    // The client stops reading, so the gateway's close frame stays unanswered
    // and the gateway remains CLOSING until its own close timer terminates it.
    (socket as unknown as { _socket: { pause(): void } })._socket.pause();
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket.send(JSON.stringify(heartbeatFrame()));
    await vi.waitFor(
      async () => expect(await serverConnectionCount(fixture.server)).toBe(0),
      { timeout: 2_500 },
    );
    expect(onSessionError).not.toHaveBeenCalled();
    (socket as unknown as { _socket: { resume(): void } })._socket.resume();
    socket.terminate();
  });

  it("drops frames from a replaced connection while its close is pending", async () => {
    const onSessionError = vi.fn();
    const fixture = await startFixture({ onSessionError });
    const connect = async (): Promise<WebSocket> => {
      const socket = new WebSocket(fixture.url, {
        headers: { Authorization: "Bearer runner-secret" },
      });
      const incoming = messages(socket);
      await opened(socket);
      socket.send(JSON.stringify(hello()));
      expect((await incoming.next()).value).toMatchObject({
        type: "runner.welcome",
      });
      return socket;
    };
    const previous = await connect();
    (previous as unknown as { _socket: { pause(): void } })._socket.pause();
    const current = await connect();
    previous.send(JSON.stringify(heartbeatFrame()));
    await vi.waitFor(
      async () => expect(await serverConnectionCount(fixture.server)).toBe(1),
      { timeout: 2_500 },
    );
    expect(onSessionError).not.toHaveBeenCalled();
    (previous as unknown as { _socket: { resume(): void } })._socket.resume();
    previous.terminate();
    current.terminate();
  });

  it("still reports an identity-mismatched frame while the socket is open", async () => {
    const onSessionError = vi.fn();
    const fixture = await startFixture({ onSessionError });
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    const incoming = messages(socket);
    await opened(socket);
    socket.send(JSON.stringify(hello()));
    expect((await incoming.next()).value).toMatchObject({
      type: "runner.welcome",
    });
    const closed = onceClosed(socket);
    socket.send(JSON.stringify(heartbeatFrame("runner-other")));
    expect(await closed).toMatchObject({
      code: 1002,
      reason: "Runner protocol violation",
    });
    expect(onSessionError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ computerId: "runner-local" }),
    );
  });

  it("replays large tool output and settles both Agents on a shared Computer connection", async () => {
    const fixture = await startFixture();
    const agentIds = ["agent-reviewer", "agent-helper"];
    for (const agentId of agentIds)
      fixture.computerRegistry.place(
        "runner-local",
        testRunnerPlacement({ agentId }),
      );
    const connect = async (activeOperations: ActiveOperation[] = []) => {
      const socket = new WebSocket(fixture.url, {
        headers: { Authorization: "Bearer runner-secret" },
      });
      const closed = onceClosed(socket);
      const incoming = messages(socket);
      const next = async () => {
        const frame = await Promise.race([
          incoming.next(),
          closed.then(({ code }) => {
            throw new Error(`Gateway closed before ACK: ${code}`);
          }),
        ]);
        if (!frame.value) throw new Error("Expected Gateway frame");
        return frame.value;
      };
      await opened(socket);
      const greeting = hello();
      if (greeting.type !== "runner.hello") throw new Error("Expected hello");
      socket.send(
        JSON.stringify({
          ...greeting,
          capacity: 2,
          active_operations: activeOperations,
        }),
      );
      const welcome = await next();
      expect(welcome).toMatchObject({ type: "runner.welcome" });
      if (activeOperations.length > 0) {
        expect(welcome).toMatchObject({
          reconcile_operation_ids: expect.arrayContaining(
            activeOperations.map((op) => op.operation_id),
          ),
        });
      }
      for (;;) {
        const frame = await next();
        if (frame.type === "runner.reconciled") break;
        if (frame.type === "operation.start") continue;
        if (frame.type !== "agent_runner.ensure")
          throw new Error(`Unexpected reconciliation frame: ${frame.type}`);
        socket.send(
          JSON.stringify({
            type: "agent_runner.state",
            state: "ready",
            protocol_version: frame.protocol_version,
            command_id: frame.command_id,
            runner_id: frame.runner_id,
            tenant_id: frame.tenant_id,
            registration_id: frame.registration_id,
            assignment_revision: frame.assignment_revision,
            agent_id: frame.agent_id,
            connection_epoch: frame.connection_epoch,
            runner_revision: frame.runner_revision,
            runner_pid: 100,
          }),
        );
      }
      return { socket, next, closed };
    };
    const first = await connect();
    const operations: RunnerOperation[] = [];
    const starts: OperationStart[] = [];
    for (const agentId of agentIds) {
      operations.push(
        await fixture.gateway.startOperation({
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
          runnerId: "runner-local",
          ...readyContextScope(agentId),
          agentId,
          workspaceGrantId: "grant-repo",
          request: {
            kind: "run.start",
            runtime: { type: "codex" },
            session_options: {
              thread_name: agentId,
            },
            input: { type: "text", text: "hello" },
            session: { thread_id: `thread-${agentId}` },
            run_context: {
              execution_run_ref: `run-${agentId}`,
              source_inbox_ids: ["room:room-main"],
            },
            run_resources: { mcp_servers: [] },
          },
        }),
      );
      const start = await first.next();
      if (start.type !== "operation.start")
        throw new Error("Expected operation start");
      starts.push(start);
      first.socket.send(
        JSON.stringify(
          operationEvent(start, 1, {
            type: "operation.accepted",
            command_id: start.command_id,
            runner_pid: 100,
          }),
        ),
      );
      expect(await first.next()).toMatchObject({
        type: "operation.ack",
        operation_id: start.operation_id,
        through_seq: 1,
      });
    }
    first.socket.close();
    await first.closed;

    // Both local operations finished during the disconnect. Their unacknowledged
    // events retain the original epoch and must not poison the shared connection.
    const second = await connect(
      starts.map((start) => ({
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
        last_emitted_seq: 3,
        last_acked_seq: 1,
      })),
    );
    const received = operations.map(async (operation) => {
      const events: RunEvent[] = [];
      for await (const event of operation.events) events.push(event);
      return events;
    });
    for (const [index, start] of starts.entries()) {
      const event = {
        type: "tool.returned",
        call_id: `call-${index}`,
        tool_name: "exec_command",
        output: index === 0 ? "x".repeat(311_431) : "helper output",
        is_error: false,
      } as const;
      const outputFrame = operationEvent(start, 2, {
        type: "operation.event",
        event,
      });
      // Lost ACKs can cause duplicate replay; output must be delivered only once.
      for (let replay = 0; replay < 2; replay += 1) {
        second.socket.send(JSON.stringify(outputFrame));
        expect(await second.next()).toMatchObject({
          type: "operation.ack",
          operation_id: start.operation_id,
          through_seq: 2,
        });
      }
      second.socket.send(
        JSON.stringify(
          operationEvent(start, 3, {
            type: "operation.completed",
            result: {
              type: "run",
              final_response: "done",
              session: { thread_id: `thread-${start.agent_id}` },
            },
          }),
        ),
      );
      expect(await second.next()).toMatchObject({
        type: "operation.ack",
        operation_id: start.operation_id,
        through_seq: 3,
      });
      await expect(operations[index]!.result).resolves.toMatchObject({
        type: "run",
        final_response: "done",
      });
      await expect(received[index]).resolves.toEqual([event]);
    }
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    expect(fixture.gateway.isLocalComputerExecutionReady("runner-local")).toBe(
      true,
    );
    second.socket.close();
    await second.closed;
  });

  it("authenticates one Runner and carries generated operation envelopes", async () => {
    const fixture = await startFixture();
    fixture.computerRegistry.place("runner-local", testRunnerPlacement());
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    const incoming = messages(socket, { registrationSnapshots: true });
    await opened(socket);
    const greeting = hello();
    if (greeting.type !== "runner.hello") throw new Error("Expected hello");
    socket.send(JSON.stringify(greeting));
    await expect(incoming.next()).resolves.toMatchObject({
      value: { type: "runner.welcome", runner_id: "runner-local" },
    });
    await expect(incoming.next()).resolves.toMatchObject({
      value: {
        type: "runtime.registration.snapshot",
        runner_id: "runner-local",
        registrations: [],
      },
    });
    const ensureFrame = await incoming.next();
    const ensure = ensureFrame.value;
    if (ensure?.type !== "agent_runner.ensure") {
      throw new Error("Expected agent_runner.ensure");
    }
    socket.send(
      JSON.stringify({
        type: "agent_runner.state",
        state: "ready",
        protocol_version: ensure.protocol_version,
        command_id: ensure.command_id,
        runner_id: ensure.runner_id,
        tenant_id: ensure.tenant_id,
        registration_id: ensure.registration_id,
        assignment_revision: ensure.assignment_revision,
        agent_id: ensure.agent_id,
        connection_epoch: ensure.connection_epoch,
        runner_revision: ensure.runner_revision,
        runner_pid: 100,
      }),
    );
    await expect(incoming.next()).resolves.toMatchObject({
      value: {
        type: "runner.reconciled",
        runner_id: "runner-local",
        connection_epoch: ensure.connection_epoch,
      },
    });
    let operation: RunnerOperation | undefined;
    await vi.waitFor(async () => {
      operation = await fixture.gateway.startOperation({
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
    });
    if (!operation) throw new Error("Expected operation admission");
    const startFrame = await incoming.next();
    const start = startFrame.value as OperationStart;
    expect(start).toMatchObject({
      type: "operation.start",
      operation_id: operation.operationId,
    });
    socket.send(
      JSON.stringify(
        operationEvent(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      ),
    );
    await expect(incoming.next()).resolves.toMatchObject({
      value: { type: "operation.ack", through_seq: 1 },
    });
    socket.send(
      JSON.stringify(
        operationEvent(start, 2, {
          type: "operation.completed",
          result: {
            type: "run",
            final_response: "",
            session: { thread_id: "thread-1" },
          },
        }),
      ),
    );

    await expect(operation.result).resolves.toMatchObject({
      type: "run",
      final_response: "",
      session: { thread_id: "thread-1" },
    });
    socket.close();
  });

  it("fails an operation on a schema-invalid event without closing the connection", async () => {
    const fixture = await startFixture();
    fixture.computerRegistry.place("runner-local", testRunnerPlacement());
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    const incoming = messages(socket);
    await opened(socket);
    socket.send(JSON.stringify(hello()));
    await expect(incoming.next()).resolves.toMatchObject({
      value: { type: "runner.welcome" },
    });
    const ensure = (await incoming.next()).value;
    if (ensure?.type !== "agent_runner.ensure") {
      throw new Error("Expected agent_runner.ensure");
    }
    socket.send(
      JSON.stringify({
        type: "agent_runner.state",
        state: "ready",
        protocol_version: ensure.protocol_version,
        command_id: ensure.command_id,
        runner_id: ensure.runner_id,
        tenant_id: ensure.tenant_id,
        registration_id: ensure.registration_id,
        assignment_revision: ensure.assignment_revision,
        agent_id: ensure.agent_id,
        connection_epoch: ensure.connection_epoch,
        runner_revision: ensure.runner_revision,
        runner_pid: 100,
      }),
    );
    let operation: RunnerOperation | undefined;
    await vi.waitFor(async () => {
      operation = await fixture.gateway.startOperation({
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
    });
    if (!operation) throw new Error("Expected operation admission");
    let start: OperationStart | undefined;
    while (!start) {
      const frame = (await incoming.next()).value;
      if (frame?.type === "operation.start") start = frame as OperationStart;
    }
    // The Daemon journals events without the Agent schema, so a bad event is
    // replayed after every reconnect; it must settle instead of closing.
    const invalid = JSON.stringify(
      operationEvent(start, 1, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "",
          session: { thread_id: "thread-1" },
        },
        unexpected_field: true,
      }),
    );
    socket.send(invalid);
    await expect(operation.result).rejects.toMatchObject({
      code: "runner_event_invalid",
    });
    const acknowledged = async () => {
      for (;;) {
        const frame = (await incoming.next()).value;
        if (frame?.type === "operation.ack") return frame;
      }
    };
    await expect(acknowledged()).resolves.toMatchObject({ through_seq: 1 });
    socket.send(invalid);
    await expect(acknowledged()).resolves.toMatchObject({ through_seq: 1 });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("drops a schema-invalid display event and keeps the Run going", async () => {
    const fixture = await startFixture();
    fixture.computerRegistry.place("runner-local", testRunnerPlacement());
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    const incoming = messages(socket);
    await opened(socket);
    socket.send(JSON.stringify(hello()));
    await expect(incoming.next()).resolves.toMatchObject({
      value: { type: "runner.welcome" },
    });
    const ensure = (await incoming.next()).value;
    if (ensure?.type !== "agent_runner.ensure") {
      throw new Error("Expected agent_runner.ensure");
    }
    socket.send(
      JSON.stringify({
        type: "agent_runner.state",
        state: "ready",
        protocol_version: ensure.protocol_version,
        command_id: ensure.command_id,
        runner_id: ensure.runner_id,
        tenant_id: ensure.tenant_id,
        registration_id: ensure.registration_id,
        assignment_revision: ensure.assignment_revision,
        agent_id: ensure.agent_id,
        connection_epoch: ensure.connection_epoch,
        runner_revision: ensure.runner_revision,
        runner_pid: 100,
      }),
    );
    let operation: RunnerOperation | undefined;
    await vi.waitFor(async () => {
      operation = await fixture.gateway.startOperation({
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
    });
    if (!operation) throw new Error("Expected operation admission");
    const pushed: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of operation.events) pushed.push(event);
    })();
    let start: OperationStart | undefined;
    while (!start) {
      const frame = (await incoming.next()).value;
      if (frame?.type === "operation.start") start = frame as OperationStart;
    }
    const acknowledged = async () => {
      for (;;) {
        const frame = (await incoming.next()).value;
        if (frame?.type === "operation.ack") return frame;
      }
    };
    socket.send(
      JSON.stringify(
        operationEvent(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      ),
    );
    await expect(acknowledged()).resolves.toMatchObject({ through_seq: 1 });
    socket.send(
      JSON.stringify(
        operationEvent(start, 2, {
          type: "operation.event",
          event: {
            type: "activity.started",
            activity_id: "activity-1",
            kind: "browse",
            title: "x".repeat(201),
          },
        }),
      ),
    );
    await expect(acknowledged()).resolves.toMatchObject({ through_seq: 2 });
    socket.send(
      JSON.stringify(
        operationEvent(start, 3, {
          type: "operation.completed",
          result: {
            type: "run",
            final_response: "",
            session: { thread_id: "thread-1" },
          },
        }),
      ),
    );
    await expect(operation.result).resolves.toMatchObject({ type: "run" });
    await drained;
    expect(pushed.some((event) => event.type === "activity.started")).toBe(
      false,
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("keeps the connection open for an oversized Debug inspection result", async () => {
    vi.stubEnv("AGENT_LOG_LEVEL", "info");
    setAgentLogOptions({ format: "json" });
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fixture = await startFixture();
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    try {
      const incoming = messages(socket);
      await opened(socket);
      socket.send(JSON.stringify(hello()));
      expect((await incoming.next()).value?.type).toBe("runner.welcome");
      const closed = onceClosed(socket);
      socket.send(
        JSON.stringify({
          type: "executed",
          kind: "debug_history",
          protocol_version: "2",
          command_id: "inspection-unknown",
          runner_id: "runner-local",
          result: {
            records: [{ native_record: { output: "x".repeat(262_145) } }],
          },
        }),
      );
      const invalid = async () => {
        for (;;) {
          const entry = output.mock.calls
            .map(
              ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
            )
            .find(({ event }) => event === "runner.frame.invalid");
          if (entry) return entry;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      await expect(invalid()).resolves.toMatchObject({
        frameType: "executed",
        schemaErrors: expect.stringContaining("DaemonToAgentEnvelope"),
      });
      const stillOpen = await Promise.race([
        closed.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100)),
      ]);
      expect(stillOpen).toBe(true);
    } finally {
      socket.close();
    }
  });

  it("rejects invalid credentials before accepting a WebSocket", async () => {
    const fixture = await startFixture();
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(fixture.url, {
        headers: { Authorization: "Bearer wrong-secret" },
      });
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      socket.once("error", reject);
    });

    expect(status).toBe(401);
  });

  it("answers an older-protocol Computer that can update itself with only target_release", async () => {
    const fixture = await startFixture();
    fixture.computerRegistry.enroll({
      computerId: "runner-local",
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
    });
    const accept = vi.spyOn(fixture.gateway, "acceptConnection");
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    try {
      const incoming = messages(socket);
      await opened(socket);
      socket.send(JSON.stringify(outdatedHello()));
      expect(await incoming.next()).toMatchObject({
        value: {
          type: "runner.welcome",
          protocol_version: "1.2",
          runner_id: "runner-local",
          reconcile_operation_ids: [],
          target_release: computerTargetRelease(testComputerRelease),
        },
      });
      // Its own protocol keeps flowing until it updates; nothing is read.
      socket.send(
        JSON.stringify({
          type: "runner.heartbeat",
          protocol_version: "1.2",
          runner_id: "runner-local",
          sent_at: new Date().toISOString(),
          active_operation_ids: [],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(accept).not.toHaveBeenCalled();
      expect(
        fixture.computerRegistry.list({
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
        }),
      ).toMatchObject([
        {
          status: "offline",
          daemonVersion: "0.42.0",
          recommendedVersion: testComputerRelease.version,
        },
      ]);
    } finally {
      socket.close();
    }
  });

  it("answers a protocol 2 Computer below the current release with only target_release", async () => {
    const fixture = await startFixture();
    fixture.computerRegistry.enroll({
      computerId: "runner-local",
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
    });
    const accept = vi.spyOn(fixture.gateway, "acceptConnection");
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    try {
      const incoming = messages(socket);
      await opened(socket);
      socket.send(
        JSON.stringify({
          ...hello(),
          daemon_version: FIRST_PROTOCOL_2_COMPUTER_VERSION,
        }),
      );
      expect(await incoming.next()).toMatchObject({
        value: {
          type: "runner.welcome",
          protocol_version: "2",
          reconcile_operation_ids: [],
          target_release: computerTargetRelease(testComputerRelease),
        },
      });
      expect(accept).not.toHaveBeenCalled();
    } finally {
      socket.close();
    }
  });

  it("requires a reinstall from a protocol 2 build older than the first protocol 2 release", async () => {
    const fixture = await startFixture();
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    await opened(socket);
    const closed = onceClosed(socket);
    socket.send(JSON.stringify({ ...hello(), daemon_version: "0.42.0" }));
    expect(await closed).toEqual({
      code: 1008,
      reason: RUNNER_UPGRADE_REQUIRED_CLOSE_REASON,
    });
    socket.terminate();
  });

  it.each([
    ["declares only self_update_v1", ["self_update_v1"], testComputerRelease],
    ["ships no release", ["self_update_v2"], undefined],
  ])(
    "requires a reinstall from an older-protocol Computer that %s",
    async (_case, selfUpdate, computerRelease) => {
      const fixture = await startFixture({ computerRelease });
      const socket = new WebSocket(fixture.url, {
        headers: { Authorization: "Bearer runner-secret" },
      });
      await opened(socket);
      const incoming = messages(socket);
      const closed = onceClosed(socket);
      socket.send(
        JSON.stringify({ ...outdatedHello(), capabilities: selfUpdate }),
      );
      expect(await closed).toEqual({
        code: 1008,
        reason: RUNNER_UPGRADE_REQUIRED_CLOSE_REASON,
      });
      socket.terminate();
      await expect(
        Promise.race([
          incoming.next(),
          new Promise((resolve) => setTimeout(() => resolve("none"), 50)),
        ]),
      ).resolves.not.toMatchObject({ value: { type: "runner.welcome" } });
    },
  );

  it("sends target_release to every current Computer", async () => {
    const fixture = await startFixture();
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    try {
      const incoming = messages(socket);
      await opened(socket);
      socket.send(JSON.stringify(hello()));
      expect((await incoming.next()).value).toMatchObject({
        type: "runner.welcome",
        target_release: computerTargetRelease(testComputerRelease),
      });
    } finally {
      socket.close();
    }
  });

  it("rejects a capability this protocol does not define", async () => {
    const fixture = await startFixture();
    const rejected = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    await opened(rejected);
    const closed = onceClosed(rejected);
    rejected.send(
      JSON.stringify({ ...hello(), capabilities: ["future_cap_v9"] }),
    );
    expect(await closed).toMatchObject({ code: 1002 });
  });

  it(`requires Computer ${MINIMUM_COMPUTER_VERSION} before parsing obsolete Runtime inventories`, async () => {
    const fixture = await startFixture();
    const owner = { tenantId: "tenant-acme", ownerActorId: "actor-alice" };
    const current = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    await opened(current);
    const welcome = messages(current);
    current.send(JSON.stringify(hello()));
    expect((await welcome.next()).value).toMatchObject({
      type: "runner.welcome",
    });
    const reported = structuredClone(fixture.computerRegistry.list(owner));
    expect(reported).toMatchObject([{ runtimes: ["codex"] }]);
    const disconnected = onceClosed(current);
    current.close();
    await disconnected;
    const accept = vi.spyOn(fixture.gateway, "acceptConnection");
    for (const daemonVersion of ["0.13.0", "0.21.9", undefined, "invalid"]) {
      const socket = new WebSocket(fixture.url, {
        headers: { Authorization: "Bearer runner-secret" },
      });
      await opened(socket);
      const closed = onceClosed(socket);
      socket.send(
        JSON.stringify({
          ...hello(),
          daemon_version: daemonVersion,
          runtime_diagnostics: [{ type: "unsupported-runtime" }],
        }),
      );
      expect(await closed).toEqual({
        code: 1008,
        reason: RUNNER_UPGRADE_REQUIRED_CLOSE_REASON,
      });
    }
    expect(accept).not.toHaveBeenCalled();
    // Web keeps the last reported inventory and shows the installer command.
    expect(fixture.computerRegistry.list(owner)).toEqual(
      reported.map((computer) => ({
        ...computer,
        status: "upgrade_required",
        lastSeenAt: expect.any(String),
      })),
    );
  });

  it("keeps current and newer Computer hellos subject to strict Runtime validation", async () => {
    const fixture = await startFixture();
    for (const daemonVersion of [
      MINIMUM_CURRENT_COMPUTER_VERSION,
      "1.0.0",
      "dev",
    ]) {
      const socket = new WebSocket(fixture.url, {
        headers: { Authorization: "Bearer runner-secret" },
      });
      await opened(socket);
      const incoming = messages(socket);
      socket.send(
        JSON.stringify({
          ...hello(),
          daemon_version: daemonVersion,
          capabilities: [...hello().capabilities],
        }),
      );
      expect((await incoming.next()).value).toMatchObject({
        type: "runner.welcome",
      });
      const closed = onceClosed(socket);
      socket.send(
        JSON.stringify({
          type: "runner.runtime_diagnostics",
          protocol_version: "2",
          runner_id: "runner-local",
          sent_at: new Date().toISOString(),
          revision: 1,
          runtime_diagnostics: [{ type: "unsupported-runtime" }],
        }),
      );
      expect(await closed).toEqual({
        code: 1002,
        reason: "Runner protocol violation",
      });
    }
  });

  it("rejects an upgrade when credential verification is unavailable", async () => {
    const fixture = await startFixture({
      credentialAuthenticators: [throwingAuthenticator()],
    });
    const status = await unexpectedStatus(fixture.url, {
      Authorization: "Bearer runner-secret",
    });

    expect(status).toBe(503);
  });

  it("accepts a dynamically issued signed Runner credential", async () => {
    const credentialFixture = createRunnerCredentialTestFixture();
    const credential = credentialFixture.enroll("computer_alice_mac");
    const fixture = await startFixture({
      credentialAuthenticators: [credentialFixture.authority],
    });
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: `Bearer ${credential.gatewayToken}` },
    });
    const incoming = messages(socket);
    await opened(socket);
    socket.send(JSON.stringify(hello(credential.computerId)));

    await expect(incoming.next()).resolves.toMatchObject({
      value: { runner_id: credential.computerId, type: "runner.welcome" },
    });
    socket.close();
  });

  it("closes an authenticated Runner when its credential expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const issuedAtMs = Date.now();
    try {
      const authenticator: RunnerCredentialAuthenticator = {
        authenticate: () => ({
          expiresAtMs: issuedAtMs + 30,
          runnerId: "runner-local",
          credentialGeneration: 0,
          tenantOwners: [
            { tenantId: "tenant-acme", ownerActorId: "actor-alice" },
          ],
          token: "expiring-secret",
        }),
      };
      const fixture = await startFixture({
        credentialAuthenticators: [authenticator],
      });
      const socket = new WebSocket(fixture.url, {
        headers: { Authorization: "Bearer expiring-secret" },
      });
      await opened(socket);

      const closed = onceClosed(socket);
      vi.setSystemTime(issuedAtMs + 30);
      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: "Runner credential expired",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces an authenticated Runner when the renewed Daemon connects", async () => {
    const credentialFixture = createRunnerCredentialTestFixture();
    const first = credentialFixture.enroll("computer_alice_mac");
    const fixture = await startFixture({
      credentialAuthenticators: [credentialFixture.authority],
    });
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: `Bearer ${first.gatewayToken}` },
    });
    const incoming = messages(socket);
    await opened(socket);
    socket.send(JSON.stringify(hello(first.computerId)));
    await expect(incoming.next()).resolves.toMatchObject({
      value: { type: "runner.welcome" },
    });

    const closed = onceClosed(socket);
    // TeamHub renewed the Computer; the renewed Daemon connecting replaces it.
    const renewed = credentialFixture.enroll(first.computerId);
    const replacement = new WebSocket(fixture.url, {
      headers: { Authorization: `Bearer ${renewed.gatewayToken}` },
    });
    const replacementIncoming = messages(replacement);
    await opened(replacement);
    replacement.send(
      JSON.stringify({
        ...hello(first.computerId),
        connection_nonce: "renewed",
      }),
    );
    await expect(replacementIncoming.next()).resolves.toMatchObject({
      value: { type: "runner.welcome" },
    });

    await expect(closed).resolves.toEqual({
      code: 1012,
      reason: "Runner connection replaced",
    });
    replacement.close();
  });

  it("rejects Tenant grants outside the credential claims", async () => {
    const fixture = await startFixture();
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    await opened(socket);
    const closed = onceClosed(socket);
    socket.send(
      JSON.stringify({
        ...hello(),
        workspace_grants: [
          {
            grant_id: "foreign-grant",
            tenant_id: "tenant-other",
            label: "Foreign workspace",
            mode: "workspace-write",
            scope: "owner",
          },
        ],
      }),
    );

    await expect(closed).resolves.toMatchObject({ code: 1008 });
  });

  it("rejects Agent Runner snapshots outside the credential claims", async () => {
    const fixture = await startFixture();
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    await opened(socket);
    const closed = onceClosed(socket);
    socket.send(
      JSON.stringify({
        ...hello(),
        agent_runners: [
          {
            runner_id: "runner-local",
            tenant_id: "tenant-other",
            agent_id: "agent-foreign",
            runner_revision: 1,
            state: "removed",
          },
        ],
      }),
    );

    await expect(closed).resolves.toMatchObject({ code: 1008 });
  });

  it("closes an authenticated socket that never sends runner.hello", async () => {
    const fixture = await startFixture({ helloTimeoutMs: 10 });
    const socket = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer runner-secret" },
    });
    await opened(socket);

    await expect(onceClosed(socket)).resolves.toMatchObject({
      code: 1002,
      reason: "runner.hello timed out",
    });
  });

  it("leaves unrelated WebSocket upgrade paths to the owning listener", async () => {
    const fixture = await startFixture();
    fixture.server.on("upgrade", (request, socket) => {
      if (request.url === "/other-websocket") {
        socket.end("HTTP/1.1 418 I'm a Teapot\r\nConnection: close\r\n\r\n");
      }
    });

    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(
        fixture.url.replace("/v1/runner-gateway", "/other-websocket"),
      );
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      socket.once("error", reject);
    });

    expect(status).toBe(418);
  });

  it("rejects unmatched upgrade paths when it owns the production upgrade surface", async () => {
    const fixture = await startFixture({ rejectUnmatchedUpgrades: true });
    const status = await unexpectedStatus(
      fixture.url.replace("/v1/runner-gateway", "/unowned-websocket"),
    );

    expect(status).toBe(404);
  });

  it("closes the Gateway listener idempotently", async () => {
    const fixture = await startFixture();

    await Promise.all([fixture.webSocket.close(), fixture.webSocket.close()]);
    await fixture.webSocket.close();
  });
});

const startFixture = async (
  options: {
    credentialAuthenticators?: readonly RunnerCredentialAuthenticator[];
    rejectUnmatchedUpgrades?: boolean;
    helloTimeoutMs?: number;
    heartbeatTimeoutMs?: number;
    computerDaemonIdentityVerifier?: ComputerDaemonIdentityVerifier;
    onSessionError?: AttachRunnerGatewayWebSocketOptions["onSessionError"];
    computerRelease?: ComputerRelease;
  } = {},
) => {
  const server = createServer();
  const computerRegistry = createTestLocalComputerRegistry();
  const gateway = createTestRunnerGateway({
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    computerRegistry,
    ...(options.computerDaemonIdentityVerifier
      ? {
          computerDaemonIdentityVerifier:
            options.computerDaemonIdentityVerifier,
        }
      : {}),
    ...("computerRelease" in options
      ? { computerRelease: options.computerRelease }
      : {}),
  });
  const webSocket = attachRunnerGatewayWebSocket({
    server,
    gateway,
    credentialAuthenticators: options.credentialAuthenticators ?? [
      createTestRunnerCredentialAuthority([
        {
          runnerId: "runner-local",
          token: "runner-secret",
          credentialGeneration: 0,
          tenantOwners: [
            { tenantId: "tenant-acme", ownerActorId: "actor-alice" },
          ],
        },
      ]),
    ],
    rejectUnmatchedUpgrades: options.rejectUnmatchedUpgrades,
    helloTimeoutMs: options.helloTimeoutMs,
    onSessionError: options.onSessionError,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = async (): Promise<void> => {
    await webSocket.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  cleanups.push(close);
  return {
    gateway,
    computerRegistry,
    server,
    webSocket,
    url: `ws://127.0.0.1:${address.port}/v1/runner-gateway`,
  };
};

const unexpectedStatus = (
  url: string,
  headers?: Record<string, string>,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    socket.once("error", reject);
  });

const throwingAuthenticator = (): RunnerCredentialAuthenticator => ({
  authenticate: () => {
    throw new Error("credential store unavailable");
  },
});

const hello = (runnerId = "runner-local"): RunnerHello => ({
  type: "runner.hello",
  platform: "darwin",
  daemon_version: MINIMUM_CURRENT_COMPUTER_VERSION,
  protocol_version: "2",
  ...currentRunnerIdentity(),
  capabilities: [...CURRENT_RUNNER_CAPABILITIES],
  runner_id: runnerId,
  display_name: "Alice's Mac",
  connection_nonce: "nonce-1",
  sent_at: "2026-07-29T00:00:00.000Z",
  capacity: 1,
  runtimes: ["codex"],
  runtime_diagnostics: runtimeDiagnostics(),
  workspace_grants: [
    {
      grant_id: "grant-repo",
      tenant_id: "tenant-acme",
      label: "Linger workspace",
      mode: "workspace-write",
      scope: "owner",
    },
  ],
  agent_runners: [],
  active_operations: [],
});

const heartbeatFrame = (runnerId = "runner-local") => ({
  type: "runner.heartbeat",
  protocol_version: "2",
  runner_id: runnerId,
  sent_at: new Date().toISOString(),
  active_operation_ids: [],
});

const serverConnectionCount = (server: Server): Promise<number> =>
  new Promise((resolve, reject) =>
    server.getConnections((error, count) =>
      error ? reject(error) : resolve(count),
    ),
  );

const operationEvent = (
  start: OperationStart,
  seq: number,
  fields: object,
): DaemonToAgentEnvelope =>
  ({
    protocol_version: start.protocol_version,
    host_access: start.host_access,
    registration_id: start.registration_id,
    assignment_revision: start.assignment_revision,
    tenant_id: start.tenant_id,
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
    ...fields,
  }) as DaemonToAgentEnvelope;

const opened = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

const onceClosed = (
  socket: WebSocket,
): Promise<{ code: number; reason: string }> =>
  new Promise((resolve) =>
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString("utf8") }),
    ),
  );

// Every welcome is followed by a Registration snapshot; only the tests that
// assert it keep it.
const messages = async function* (
  socket: WebSocket,
  options: { readonly registrationSnapshots?: boolean } = {},
): AsyncGenerator<AgentToDaemonEnvelope> {
  const queue: AgentToDaemonEnvelope[] = [];
  let wake: (() => void) | undefined;
  socket.on("message", (data) => {
    const envelope = JSON.parse(
      webSocketMessageText(data),
    ) as AgentToDaemonEnvelope;
    if (
      envelope.type === "runtime.registration.snapshot" &&
      !options.registrationSnapshots
    )
      return;
    queue.push(envelope);
    wake?.();
    wake = undefined;
  });
  for (;;) {
    const value = queue.shift();
    if (value) {
      yield value;
      continue;
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
};

// The hello of a Computer from before protocol 2 that can update itself.
const outdatedHello = () => ({
  type: "runner.hello",
  protocol_version: "1.2",
  daemon_version: "0.42.0",
  platform: "darwin",
  runner_id: "runner-local",
  connection_nonce: "nonce-outdated",
  sent_at: new Date().toISOString(),
  capabilities: ["turn", "daemon_identity", "self_update_v2"],
  runtimes: ["codex"],
  runtime_diagnostics: runtimeDiagnostics(),
  workspace_grants: [],
  agent_runners: [],
  active_operations: [],
});
