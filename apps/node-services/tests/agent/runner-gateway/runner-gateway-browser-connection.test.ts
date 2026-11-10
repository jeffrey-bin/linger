import type {
  AgentToDaemonEnvelope,
  CapabilityBrowserConnect,
  BrowserConnectionStatus,
} from "@linger/wire-contracts/runner-gateway/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalBrowserConnectionError,
  LocalComputerCapabilityError,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
} from "../../../src/agent/runner-gateway/local-computer-management.js";
import { type RunnerGatewayConnection } from "../../../src/agent/runner-gateway/runner-gateway.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";
import {
  CURRENT_RUNNER_CAPABILITIES,
  currentRunnerIdentity,
} from "../test-support/runner-capabilities.js";

const token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U_-";
const connected: BrowserConnectionStatus = {
  mode: "user_chrome",
  state: "connected",
  platform: "darwin",
  browser: "chrome",
  profile: "Default",
  verified_at: "2026-10-22T10:00:00.000Z",
};
const connections: RunnerGatewayConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.disconnect();
  vi.useRealTimers();
});

const connect = async (capabilities: string[] = ["browser_connection"]) => {
  const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 60_000 });
  const sent: AgentToDaemonEnvelope[] = [];
  const connection = await gateway.acceptConnection(
    {
      runnerId: "computer-local",
      credentialGeneration: 0,
      tenantOwners: [{ tenantId: "tenant-1", ownerActorId: "actor-1" }],
    },
    {
      type: "runner.hello",
      platform: "darwin",
      protocol_version: "2",
      daemon_version: "dev",
      ...currentRunnerIdentity(),
      capabilities: [
        ...CURRENT_RUNNER_CAPABILITIES,
        ...(capabilities as "browser_connection"[]),
      ],
      runner_id: "computer-local",
      display_name: "Alice's Mac",
      connection_nonce: "nonce-1",
      sent_at: new Date().toISOString(),
      runtimes: ["codex"],
      runtime_diagnostics: runtimeDiagnostics(),
      workspace_grants: [],
      agent_runners: [],
      active_operations: [],
    },
    {
      send: vi.fn(async (envelope: AgentToDaemonEnvelope) => {
        sent.push(envelope);
      }),
      close: vi.fn(),
    },
  );
  connections.push(connection);
  const command = async (): Promise<CapabilityBrowserConnect> => {
    await vi.waitFor(() =>
      expect(
        sent.some(
          (frame) =>
            frame.type === "execute" && frame.kind === "browser_connect",
        ),
      ).toBe(true),
    );
    const value = [...sent]
      .reverse()
      .find(
        (item) => item.type === "execute" && item.kind === "browser_connect",
      );
    if (value?.type !== "execute" || value?.kind !== "browser_connect")
      throw new Error("Missing browser connect command");
    return value;
  };
  return { gateway, connection, sent, command };
};

const target = {
  computerId: "computer-local",
  tenantId: "tenant-1",
  ownerActorId: "actor-1",
} as const;

describe("Runner Gateway browser connection", () => {
  it("configures the owner's Chrome and returns the Computer status", async () => {
    const { gateway, connection, command } = await connect();
    const configuring = gateway.connectLocalBrowser({
      ...target,
      action: "configure",
      profile: "Default",
      extensionToken: token,
    });
    const request = await command();
    expect(request).toMatchObject({
      action: "configure",
      profile: "Default",
      extension_token: token,
      runner_id: "computer-local",
      tenant_id: "tenant-1",
      owner_actor_id: "actor-1",
    });
    expect(Date.parse(request.expires_at) - Date.now()).toBeGreaterThanOrEqual(
      59_000,
    );
    await connection.receive({
      type: "executed",
      kind: "browser_connect",
      outcome: "succeeded",
      protocol_version: request.protocol_version,
      command_id: request.command_id,
      runner_id: request.runner_id,
      tenant_id: request.tenant_id,
      owner_actor_id: request.owner_actor_id,
      connection_epoch: request.connection_epoch,
      expires_at: request.expires_at,
      action: "configure",
      status: connected,
    });
    await expect(configuring).resolves.toEqual(connected);
  });

  it("sends status and disconnect without a token", async () => {
    const { gateway, connection, command } = await connect();
    const reading = gateway.connectLocalBrowser({
      ...target,
      action: "status",
    });
    const request = await command();
    expect(request.action).toBe("status");
    expect(request).not.toHaveProperty("extension_token");
    await connection.receive({
      type: "executed",
      kind: "browser_connect",
      outcome: "failed",
      protocol_version: request.protocol_version,
      command_id: request.command_id,
      runner_id: request.runner_id,
      tenant_id: request.tenant_id,
      owner_actor_id: request.owner_actor_id,
      connection_epoch: request.connection_epoch,
      expires_at: request.expires_at,
      action: "status",
      error: {
        code: "BROWSER_STATUS_FAILED",
        message: "Browser status is unavailable",
        retryable: true,
      },
    });
    await expect(reading).rejects.toMatchObject({
      name: "LocalBrowserConnectionError",
      code: "BROWSER_STATUS_FAILED",
    });
    await expect(
      gateway.connectLocalBrowser({
        ...target,
        action: "disconnect",
        extensionToken: token,
      }),
    ).rejects.toBeInstanceOf(LocalBrowserConnectionError);
  });

  it("maps offline, foreign owners, and missing capability before sending", async () => {
    const offline = createTestRunnerGateway({ heartbeatIntervalMs: 60_000 });
    await expect(
      offline.connectLocalBrowser({ ...target, action: "status" }),
    ).rejects.toBeInstanceOf(LocalComputerOfflineError);

    const owned = await connect();
    await expect(
      owned.gateway.connectLocalBrowser({
        ...target,
        ownerActorId: "actor-2",
        action: "status",
      }),
    ).rejects.toBeInstanceOf(LocalComputerNotFoundError);

    const old = await connect([]);
    await expect(
      old.gateway.connectLocalBrowser({ ...target, action: "status" }),
    ).rejects.toBeInstanceOf(LocalComputerCapabilityError);
    expect(
      [...owned.sent, ...old.sent].some(
        (frame) => frame.type === "execute" && frame.kind === "browser_connect",
      ),
    ).toBe(false);
  });

  it("rejects a pending command when the Computer disconnects", async () => {
    const { gateway, connection, command } = await connect();
    const configuring = gateway.connectLocalBrowser({
      ...target,
      action: "configure",
      extensionToken: token,
    });
    await command();
    connection.disconnect();
    await expect(configuring).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });

  it("times out after one minute without an outcome", async () => {
    const { gateway, sent } = await connect();
    vi.useFakeTimers();
    const configuring = gateway
      .connectLocalBrowser({
        ...target,
        action: "configure",
        extensionToken: token,
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(
      sent.some(
        (frame) => frame.type === "execute" && frame.kind === "browser_connect",
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(configuring).resolves.toMatchObject({
      code: "BROWSER_CONNECTION_TIMEOUT",
    });
  });
});
