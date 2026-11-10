import type {
  AgentToDaemonEnvelope,
  CapabilityComputerPermission,
  ComputerPermissionStatus,
  RunnerCapability,
} from "@linger/wire-contracts/runner-gateway/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalComputerCapabilityError,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
  LocalComputerPermissionError,
} from "../../../src/agent/runner-gateway/local-computer-management.js";
import { type RunnerGatewayConnection } from "../../../src/agent/runner-gateway/runner-gateway.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";
import {
  CURRENT_RUNNER_CAPABILITIES,
  currentRunnerIdentity,
} from "../test-support/runner-capabilities.js";

const granted: ComputerPermissionStatus = {
  platform: "darwin",
  host: "desktop",
  subjects: [
    {
      subject: "linger",
      permissions: [
        {
          id: "screen_recording",
          state: "granted",
          prompt: "available",
          relaunch_required: false,
        },
      ],
    },
  ],
};
const connections: RunnerGatewayConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.disconnect();
  vi.useRealTimers();
});

const connect = async (
  capabilities: RunnerCapability[] = ["computer_permissions"],
) => {
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
      capabilities: [...CURRENT_RUNNER_CAPABILITIES, ...capabilities],
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
  const command = async (): Promise<CapabilityComputerPermission> => {
    await vi.waitFor(() => expect(sent.some(isPermissionCommand)).toBe(true));
    const value = [...sent].reverse().find(isPermissionCommand);
    if (!value) throw new Error("Missing computer permission command");
    return value;
  };
  return { gateway, connection, sent, command };
};

const isPermissionCommand = (
  frame: AgentToDaemonEnvelope,
): frame is CapabilityComputerPermission =>
  frame.type === "execute" && frame.kind === "computer_permission";

const target = {
  computerId: "computer-local",
  tenantId: "tenant-1",
  ownerActorId: "actor-1",
} as const;

const identityOf = (request: CapabilityComputerPermission) => ({
  protocol_version: request.protocol_version,
  command_id: request.command_id,
  runner_id: request.runner_id,
  tenant_id: request.tenant_id,
  owner_actor_id: request.owner_actor_id,
  connection_epoch: request.connection_epoch,
  expires_at: request.expires_at,
});

describe("Runner Gateway computer permissions", () => {
  it("prompts for one permission and returns the Computer status", async () => {
    const { gateway, connection, command } = await connect();
    const prompting = gateway.computerPermissions({
      ...target,
      action: "prompt",
      subject: "linger",
      permission: "screen_recording",
    });
    const request = await command();
    expect(request).toMatchObject({
      action: "prompt",
      subject: "linger",
      permission: "screen_recording",
      runner_id: "computer-local",
      tenant_id: "tenant-1",
      owner_actor_id: "actor-1",
    });
    expect(Date.parse(request.expires_at) - Date.now()).toBeGreaterThanOrEqual(
      29_000,
    );
    await connection.receive({
      type: "executed",
      kind: "computer_permission",
      outcome: "succeeded",
      ...identityOf(request),
      action: "prompt",
      status: granted,
    });
    await expect(prompting).resolves.toEqual(granted);
  });

  it("sends status without a subject and surfaces the Computer's error code", async () => {
    const { gateway, connection, command } = await connect();
    const reading = gateway.computerPermissions({
      ...target,
      action: "status",
    });
    const request = await command();
    expect(request.action).toBe("status");
    expect(request).not.toHaveProperty("subject");
    expect(request).not.toHaveProperty("permission");
    await connection.receive({
      type: "executed",
      kind: "computer_permission",
      outcome: "failed",
      ...identityOf(request),
      action: "status",
      error: {
        code: "COMPUTER_PERMISSION_UNSUPPORTED",
        message: "Permissions are macOS only",
        retryable: false,
      },
    });
    await expect(reading).rejects.toMatchObject({
      name: "LocalComputerPermissionError",
      code: "COMPUTER_PERMISSION_UNSUPPORTED",
    });
  });

  it("refuses a prompt without a permission before sending", async () => {
    const { gateway, sent } = await connect();
    await expect(
      gateway.computerPermissions({
        ...target,
        action: "prompt",
        subject: "linger",
      }),
    ).rejects.toBeInstanceOf(LocalComputerPermissionError);
    expect(sent.some(isPermissionCommand)).toBe(false);
  });

  it("maps offline, foreign owners, and missing capability before sending", async () => {
    const offline = createTestRunnerGateway({ heartbeatIntervalMs: 60_000 });
    await expect(
      offline.computerPermissions({ ...target, action: "status" }),
    ).rejects.toBeInstanceOf(LocalComputerOfflineError);

    const owned = await connect();
    await expect(
      owned.gateway.computerPermissions({
        ...target,
        ownerActorId: "actor-2",
        action: "status",
      }),
    ).rejects.toBeInstanceOf(LocalComputerNotFoundError);

    const old = await connect(["browser_connection"]);
    await expect(
      old.gateway.computerPermissions({ ...target, action: "status" }),
    ).rejects.toBeInstanceOf(LocalComputerCapabilityError);
    expect([...owned.sent, ...old.sent].some(isPermissionCommand)).toBe(false);
  });

  it("rejects a pending command when the Computer disconnects", async () => {
    const { gateway, connection, command } = await connect();
    const reading = gateway.computerPermissions({
      ...target,
      action: "status",
    });
    await command();
    connection.disconnect();
    await expect(reading).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });

  it("times out after thirty seconds without an outcome", async () => {
    const { gateway, sent } = await connect();
    vi.useFakeTimers();
    const reading = gateway
      .computerPermissions({ ...target, action: "status" })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(sent.some(isPermissionCommand)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reading).resolves.toMatchObject({
      code: "COMPUTER_PERMISSION_TIMEOUT",
    });
  });
});
