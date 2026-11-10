import { testComputerRelease } from "../test-support/runner-gateway.js";
import { computerTargetRelease } from "../../../src/agent/runner-gateway/computer-release.js";
import { describe, expect, it, vi } from "vitest";
import type {
  OperationStart,
  RunnerHello,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  LocalComputerOfflineError,
  MINIMUM_CURRENT_COMPUTER_VERSION,
} from "../../../src/agent/runner-gateway/local-computer-management.js";
import {
  RunnerGateway,
  RunnerUpgradeRequiredError,
  type RunnerGatewayConnection,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import {
  createTestRunnerGateway,
  testRegistrationId,
  testRegistryOf,
} from "../test-support/runner-gateway.js";
import { TeamHubRuntimeStateError } from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";

import {
  hello,
  contextHello,
  authenticatedPrincipal,
  RecordingPeer,
  defaultAgentPlacement,
  localContextViewIdentity,
  acknowledgeEnsuredAgent,
  acceptReadyConnection,
  BlockingWelcomePeer,
  sessionTarget,
  runTarget,
  contextRunTarget,
  event,
  sequenceIds,
  waitFor,
  placeAgent,
  settledWithTimers,
} from "./runner-gateway-fixtures.js";

describe("RunnerGateway", () => {
  it("answers an outdated Computer only with the release to update to", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    const touch = vi.spyOn(testRegistryOf(gateway), "touch");
    const welcome = await gateway.acceptOutdatedComputer(
      authenticatedPrincipal(),
      { protocolVersion: "1.2", daemonVersion: "0.42.0" },
    );
    expect(welcome).toMatchObject({
      type: "runner.welcome",
      protocol_version: "1.2",
      runner_id: "runner-local",
      reconcile_operation_ids: [],
      target_release: computerTargetRelease(testComputerRelease),
    });
    expect(touch).toHaveBeenCalledWith(
      "runner-local",
      expect.objectContaining({
        status: "offline",
        daemonVersion: "0.42.0",
        recommendedVersion: testComputerRelease.version,
      }),
    );
    expect(gateway.isLocalComputerExecutionReady("runner-local")).toBe(false);
    await expect(gateway.startOperation(runTarget())).rejects.toThrow();
  });

  it("has no update answer when this image ships no Computer release", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      computerRelease: undefined,
    });
    await expect(
      gateway.acceptOutdatedComputer(authenticatedPrincipal(), {
        protocolVersion: "1.2",
        daemonVersion: "0.42.0",
      }),
    ).rejects.toBeInstanceOf(RunnerUpgradeRequiredError);
  });

  it("refuses a release below the current floor as a Runner connection", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    await expect(
      gateway.acceptConnection(
        authenticatedPrincipal(),
        { ...hello(), daemon_version: "0.42.0" },
        new RecordingPeer(),
      ),
    ).rejects.toBeInstanceOf(RunnerUpgradeRequiredError);
  });

  it.each([
    [MINIMUM_CURRENT_COMPUTER_VERSION, true],
    ["dev", true],
  ])(
    "prepares durable empty sessions on a current release (%s)",
    async (daemonVersion, supported) => {
      const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 60_000 });
      const peer = new RecordingPeer();
      let connection: RunnerGatewayConnection | undefined;
      try {
        expect(gateway.supportsDurableCodexSession("runner-local")).toBe(false);
        connection = await gateway.acceptConnection(
          authenticatedPrincipal(),
          {
            ...hello(),
            daemon_version: daemonVersion,
            capabilities: [...hello().capabilities],
          },
          peer,
        );
        expect(gateway.supportsDurableCodexSession("runner-local")).toBe(
          supported,
        );
        connection.disconnect();
        expect(gateway.supportsDurableCodexSession("runner-local")).toBe(false);
      } finally {
        connection?.disconnect();
      }
    },
  );

  it("requires current ready authentication before preparing a durable session", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 60_000 });
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello(),
        daemon_version: MINIMUM_CURRENT_COMPUTER_VERSION,
        runtime_diagnostics: runtimeDiagnostics({
          authenticationRequired: ["codex"],
          ready: [],
        }),
      },
      new RecordingPeer(),
    );
    try {
      expect(gateway.supportsDurableCodexSession("runner-local")).toBe(false);
      await connection.receive({
        type: "runner.runtime_diagnostics",
        protocol_version: "2",
        runner_id: "runner-local",
        sent_at: "2026-07-29T00:00:15.000Z",
        revision: 2,
        runtime_diagnostics: runtimeDiagnostics(),
      });
      expect(gateway.supportsDurableCodexSession("runner-local")).toBe(true);
      await connection.receive({
        type: "runner.runtime_diagnostics",
        protocol_version: "2",
        runner_id: "runner-local",
        sent_at: "2026-07-29T00:00:30.000Z",
        revision: 3,
        runtime_diagnostics: runtimeDiagnostics({
          authenticationRequired: ["codex"],
          ready: [],
        }),
      });
      expect(gateway.supportsDurableCodexSession("runner-local")).toBe(false);
    } finally {
      connection.disconnect();
    }
  });

  it("admits no Computer until the Agent Service epoch starts, then ensures its placed Agents", async () => {
    const gateway = createTestRunnerGateway({ openConnectionsLater: true });
    placeAgent(gateway, defaultAgentPlacement());
    await expect(
      gateway.acceptConnection(
        authenticatedPrincipal(),
        hello(),
        new RecordingPeer(),
      ),
    ).rejects.toThrow("Agent Service is starting");
    gateway.openConnections();
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      hello(),
      peer,
    );
    expect(peer.sent).toContainEqual(
      expect.objectContaining({
        type: "agent_runner.ensure",
        agent_id: "agent-reviewer",
        runner_revision: 1,
        registration_id: testRegistrationId("codex"),
      }),
    );
    connection.disconnect();
  });

  it("proves the Daemon Identity and names Runtime Registrations on every hello", async () => {
    const verify = vi.fn();
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      computerDaemonIdentityVerifier: { verify },
    });
    const value: RunnerHello = {
      ...hello(),
      runtime_registrations: [
        {
          tenant_id: "tenant-acme",
          owner_actor_id: "actor-alice",
          provider_type: "codex",
          status: "online",
          revision: 1,
          capabilities: ["turn"],
          runtime_diagnostics: { status: "ready" },
        },
      ],
    };
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      value,
      peer,
    );

    expect(verify).toHaveBeenCalledWith({
      computerId: "runner-local",
      hello: value,
    });
    expect(peer.registrationSnapshots).toMatchObject([
      {
        runner_id: "runner-local",
        registrations: [{ registration_id: testRegistrationId("codex") }],
      },
    ]);
    const snapshot = peer.registrationSnapshots[0]!;
    await expect(
      connection.receive({
        type: "runtime.registration.observed",
        protocol_version: snapshot.protocol_version,
        command_id: snapshot.command_id,
        runner_id: snapshot.runner_id,
        connection_epoch: snapshot.connection_epoch,
        observed_count: 1,
      }),
    ).resolves.toBeUndefined();
    await expect(
      connection.receive({
        type: "runner.runtime_diagnostics",
        protocol_version: "2",
        runner_id: "runner-local",
        sent_at: "2026-07-29T00:00:15.000Z",
        revision: 2,
        runtime_diagnostics: runtimeDiagnostics({
          authenticationRequired: ["codex"],
          ready: [],
        }),
      }),
    ).resolves.toBeUndefined();
    expect(peer.registrationSnapshots[1]).toMatchObject({
      registrations: [
        {
          registration_id: testRegistrationId("codex"),
          observation: {
            revision: 2,
            runtime_diagnostics: { status: "authentication_required" },
          },
        },
      ],
    });
    connection.disconnect();
  });

  it("omits target_release when this image ships no Computer release", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      computerRelease: undefined,
    });
    const peer = new RecordingPeer();
    await acceptReadyConnection(gateway, peer, {
      ...hello(),
      capabilities: [...hello().capabilities],
    });
    expect(peer.sent[0]).toMatchObject({ type: "runner.welcome" });
    expect(peer.sent[0]).not.toHaveProperty("target_release");
  });

  it("settles Local waiters when the Computer disconnect write fails", async () => {
    const gateway = createTestRunnerGateway();
    const computerRegistry = testRegistryOf(gateway);
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello(),
        capabilities: [...hello().capabilities],
      },
      peer,
    );
    const controller = new AbortController();
    const scanning = gateway
      .scanLocalSkills({
        tenantId: "tenant-acme",
        ownerActorId: "actor-alice",
        computerId: "runner-local",
        commandId: "disconnect-skill-scan-command",
        scanId: "disconnect-skill-scan",
        runtimeType: "codex",
        expiresAt: "2099-08-17T09:10:00.000Z",
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    const disconnect = vi
      .spyOn(computerRegistry, "touch")
      .mockRejectedValue(new LocalComputerOfflineError());
    try {
      expect(() => connection.disconnect()).not.toThrow();
      expect(disconnect).toHaveBeenCalledTimes(1);
      await expect(scanning).resolves.toBeInstanceOf(LocalComputerOfflineError);
      expect(() => connection.disconnect()).not.toThrow();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      disconnect.mockRestore();
      connection.disconnect();
      await scanning;
    }
  });

  it("keeps an online Computer online while peer close synchronously disconnects the replaced connection", async () => {
    const gateway = createTestRunnerGateway();
    const placement = defaultAgentPlacement({
      workspaceGrantId: "grant-owner",
    });
    const firstPeer = new RecordingPeer();
    const first = await acceptReadyConnection(
      gateway,
      firstPeer,
      contextHello(),
      placement,
    );
    firstPeer.onClose = () => first.disconnect();

    const secondPeer = new RecordingPeer();
    const second = await gateway.acceptConnection(
      authenticatedPrincipal(),
      contextHello(),
      secondPeer,
    );

    expect(firstPeer.closed).toEqual([
      { code: 1012, reason: "Runner connection replaced" },
    ]);
    first.disconnect();
    await acknowledgeEnsuredAgent(second, secondPeer);
    second.disconnect();
  });

  it("requires explicit Tenant-owner claims from the authenticated principal", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });

    await expect(
      gateway.acceptConnection(
        {
          runnerId: "runner-local",
          credentialGeneration: 0,
          tenantOwners: [{ tenantId: "tenant-acme", ownerActorId: "" }],
        },
        hello(),
        new RecordingPeer(),
      ),
    ).rejects.toThrow("Authenticated Runner principal is invalid");
  });

  it("persists Computer liveness on heartbeat rather than every operation frame", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const touch = vi.spyOn(testRegistryOf(gateway), "touch");
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    touch.mockClear();

    const operation = await gateway.startOperation(sessionTarget());
    const start = peer.sent[1] as OperationStart;
    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    expect(touch).not.toHaveBeenCalled();

    await connection.receive({
      type: "runner.heartbeat",
      protocol_version: "2",
      runner_id: "runner-local",
      sent_at: "2026-07-29T00:00:01.000Z",
      active_operation_ids: [start.operation_id],
    });
    expect(touch).toHaveBeenCalledTimes(1);

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
    await expect(operation.result).resolves.toMatchObject({ type: "run" });
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it("writes Computer liveness at most every 20 seconds of heartbeats", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      createId: sequenceIds(),
    });
    const touch = vi.spyOn(testRegistryOf(gateway), "touch");
    const connection = await acceptReadyConnection(
      gateway,
      new RecordingPeer(),
    );
    touch.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let second = 0; second <= 40; second += 5) {
        await connection.receive({
          type: "runner.heartbeat",
          protocol_version: "2",
          runner_id: "runner-local",
          sent_at: new Date().toISOString(),
          active_operation_ids: [],
        });
        vi.advanceTimersByTime(5_000);
      }
    } finally {
      vi.useRealTimers();
      connection.disconnect();
    }
    // Heartbeats at 0..40s write at 0s, 20s and 40s.
    expect(
      touch.mock.calls.filter(([, write]) => write.status === "online"),
    ).toHaveLength(3);
  });

  it("keeps the Runner connected when a heartbeat liveness write fails transiently but disconnects a removed Computer", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const touch = vi.spyOn(testRegistryOf(gateway), "touch");
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    touch.mockClear();
    const heartbeat = () =>
      connection.receive({
        type: "runner.heartbeat",
        protocol_version: "2",
        runner_id: "runner-local",
        sent_at: "2026-07-29T00:00:01.000Z",
        active_operation_ids: [],
      });

    // A failed write is retried on the next heartbeat, not after 20 seconds.
    for (const error of [
      new TeamHubRuntimeStateError(503, "TeamHub unavailable"),
      new TeamHubRuntimeStateError(429, "TeamHub rate limited"),
      new TeamHubRuntimeStateError(null, "TeamHub request failed"),
    ]) {
      touch.mockRejectedValueOnce(error);
      await expect(heartbeat()).resolves.toBeUndefined();
    }
    expect(touch).toHaveBeenCalledTimes(3);
    expect(peer.closed).toEqual([]);

    touch.mockRejectedValueOnce(
      new TeamHubRuntimeStateError(404, "Local Computer not found"),
    );
    await expect(heartbeat()).rejects.toThrow("Local Computer not found");
    expect(peer.closed).toEqual([
      { code: 1011, reason: "Runner service failure" },
    ]);
  });

  it("rejects a reconnect that reports an Operation under another identity", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1000,
      createId: sequenceIds(),
    });
    const capableHello = contextHello();
    const peer = new RecordingPeer();
    const first = await acceptReadyConnection(
      gateway,
      peer,
      capableHello,
      defaultAgentPlacement({ workspaceGrantId: "grant-owner" }),
    );
    const context = localContextViewIdentity();
    const operation = await gateway.startOperation(
      contextRunTarget(context, []),
    );
    const start = peer.sent.at(-1);
    if (start?.type !== "operation.start") throw new Error("Expected start");
    await first.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    first.disconnect();
    const {
      request: _request,
      type: _type,
      command_id: _command,
      ...identity
    } = start;
    const reconnectHello = contextHello([
      {
        ...identity,
        execution_lease_id: "wrong-lease",
        kind: "run.start",
        last_emitted_seq: 3,
        last_acked_seq: 1,
      },
    ]);
    reconnectHello.capabilities = capableHello.capabilities;
    await expect(
      acceptReadyConnection(
        gateway,
        new RecordingPeer(),
        reconnectHello,
        defaultAgentPlacement({ workspaceGrantId: "grant-owner" }),
      ),
    ).rejects.toThrow("identity mismatch");
    // The failed connection leaves the existing handle available for retry.
    void operation.result.catch(() => undefined);
  });

  it("rejects admission until Runner reconciliation is complete", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 20,
      createId: sequenceIds(),
    });
    const peer = new BlockingWelcomePeer();
    placeAgent(gateway, defaultAgentPlacement());
    const accepting = gateway.acceptConnection(
      authenticatedPrincipal(),
      hello(),
      peer,
    );
    await peer.welcomeStarted.promise;

    await expect(gateway.startOperation(sessionTarget())).rejects.toThrow(
      "not yet reconciled",
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(peer.closed).toEqual([]);

    peer.releaseWelcome.resolve(undefined);
    const connection = await accepting;
    await acknowledgeEnsuredAgent(connection, peer);
  });

  it("treats valid operation traffic as Runner liveness", async () => {
    vi.useFakeTimers();
    try {
      const gateway = createTestRunnerGateway({
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 30,
        createId: sequenceIds(),
      });
      const peer = new RecordingPeer();
      const connection = await acceptReadyConnection(gateway, peer);
      await gateway.startOperation(sessionTarget());
      const start = peer.sent[1] as OperationStart;

      await vi.advanceTimersByTimeAsync(15);
      await connection.receive(
        event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      );
      await vi.advanceTimersByTimeAsync(16);

      expect(peer.closed).toEqual([]);
      await vi.advanceTimersByTimeAsync(14);
      expect(peer.closed).toEqual([
        { code: 1001, reason: "Runner heartbeat timed out" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a stale Runner connection after the heartbeat deadline", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 20,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    await gateway.acceptConnection(authenticatedPrincipal(), hello(), peer);

    await waitFor(() => peer.closed.length > 0);
    expect(peer.closed).toEqual([
      { code: 1001, reason: "Runner heartbeat timed out" },
    ]);
  });
});

describe("RunnerGateway local Computer reconnect wait", () => {
  const localRequirement = () => ({
    type: "local" as const,
    computerId: "runner-local",
    tenantId: "tenant-acme",
    ownerActorId: "actor-alice",
    workspaceGrantId: "grant-owner",
    runtimeType: "codex" as const,
    assignmentRevision: 1,
  });
  const acceptRestoredConnection = async (
    gateway: RunnerGateway,
    peer: RecordingPeer,
  ) => {
    placeAgent(
      gateway,
      defaultAgentPlacement({ workspaceGrantId: "grant-owner" }),
    );
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      contextHello(),
      peer,
    );
    await acknowledgeEnsuredAgent(connection, peer);
    return connection;
  };
  const settled = async (promise: Promise<void>) => {
    let done = false;
    void promise.then(
      () => (done = true),
      () => (done = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    return done;
  };

  it("reports execution readiness only for an execution-ready connection", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    expect(gateway.isLocalComputerExecutionReady("runner-local")).toBe(false);
    await acceptReadyConnection(gateway, new RecordingPeer());
    expect(gateway.isLocalComputerExecutionReady("runner-local")).toBe(true);
    expect(gateway.isLocalComputerExecutionReady("runner-other")).toBe(false);
  });

  it("returns immediately when the Computer is already execution-ready", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      localComputerReconnectWaitMs: 1_000,
    });
    await acceptReadyConnection(gateway, new RecordingPeer());

    await expect(
      gateway.awaitLocalComputerReconnect(
        "runner-local",
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves on the ready event when the Computer reconnects inside the startup window", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      localComputerReconnectWaitMs: 5_000,
    });
    const waiting = gateway.awaitLocalComputerReconnect(
      "runner-local",
      new AbortController().signal,
    );
    expect(await settled(waiting)).toBe(false);

    await acceptRestoredConnection(gateway, new RecordingPeer());
    await waiting;
    expect(() =>
      gateway.requireLocalPlacement(localRequirement(), "codex-default"),
    ).not.toThrow();
  });

  it("resolves at the deadline when the Computer never connects", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      localComputerReconnectWaitMs: 30,
    });
    await gateway.awaitLocalComputerReconnect(
      "runner-local",
      new AbortController().signal,
    );
    expect(() =>
      gateway.requireLocalPlacement(localRequirement(), "codex-default"),
    ).toThrow(LocalComputerOfflineError);
  });

  it("does not wait once the startup window has closed", async () => {
    vi.useFakeTimers();
    try {
      const gateway = createTestRunnerGateway({
        heartbeatIntervalMs: 1_000,
        localComputerReconnectWaitMs: 100,
      });
      await vi.advanceTimersByTimeAsync(150);
      const waiting = gateway.awaitLocalComputerReconnect(
        "runner-local",
        new AbortController().signal,
      );
      expect(await settledWithTimers(waiting)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with the abort reason and removes the waiter", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      localComputerReconnectWaitMs: 5_000,
    });
    const controller = new AbortController();
    const waiting = gateway.awaitLocalComputerReconnect(
      "runner-local",
      controller.signal,
    );
    const reason = new Error("activation stopped");
    controller.abort(reason);

    await expect(waiting).rejects.toBe(reason);
    await acceptReadyConnection(gateway, new RecordingPeer());
  });

  it("wakes every waiter for the Computer and leaves other Computers waiting", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      localComputerReconnectWaitMs: 5_000,
    });
    const first = gateway.awaitLocalComputerReconnect(
      "runner-local",
      new AbortController().signal,
    );
    const second = gateway.awaitLocalComputerReconnect(
      "runner-local",
      new AbortController().signal,
    );
    const otherController = new AbortController();
    const other = gateway.awaitLocalComputerReconnect(
      "runner-other",
      otherController.signal,
    );
    const otherSettled = other.then(
      () => "resolved",
      () => "rejected",
    );

    await acceptReadyConnection(gateway, new RecordingPeer());
    await Promise.all([first, second]);
    expect(await settled(other)).toBe(false);
    otherController.abort();
    await expect(otherSettled).resolves.toBe("rejected");
  });

  it("opens a fresh window from the Computer's disconnect time", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      localComputerReconnectWaitMs: 40,
    });
    const connection = await acceptReadyConnection(
      gateway,
      new RecordingPeer(),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    connection.disconnect();

    const waiting = gateway.awaitLocalComputerReconnect(
      "runner-local",
      new AbortController().signal,
    );
    expect(await settled(waiting)).toBe(false);
    await acceptReadyConnection(gateway, new RecordingPeer());
    await waiting;
  });
});
