import type {
  AgentToDaemonEnvelope,
  ComputerToolCall,
} from "@linger/wire-contracts/runner-gateway/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
} from "../../../src/agent/runner-gateway/local-computer-management.js";
import { type RunnerGatewayConnection } from "../../../src/agent/runner-gateway/runner-gateway.js";
import {
  createTestRunnerGateway,
  testRegistryOf,
} from "../test-support/runner-gateway.js";
import {
  testRegistrationId,
  testRunnerPlacement,
} from "../test-support/local-computer-registry.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";
import {
  CURRENT_RUNNER_CAPABILITIES,
  currentRunnerIdentity,
} from "../test-support/runner-capabilities.js";

const connections: RunnerGatewayConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.disconnect();
  vi.useRealTimers();
});

const connect = async () => {
  const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 60_000 });
  testRegistryOf(gateway).place(
    "computer-local",
    testRunnerPlacement({
      agentId: "agent-1",
      tenantId: "tenant-1",
      ownerActorId: "actor-1",
      workspaceGrantId: "workspace-1",
    }),
  );
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
      capabilities: [...CURRENT_RUNNER_CAPABILITIES],
      runner_id: "computer-local",
      display_name: "Alice's Mac",
      connection_nonce: "nonce-1",
      sent_at: new Date().toISOString(),
      runtimes: ["codex"],
      runtime_diagnostics: runtimeDiagnostics(),
      workspace_grants: [],
      agent_runners: [
        {
          runner_id: "computer-local",
          tenant_id: "tenant-1",
          agent_id: "agent-1",
          runner_revision: 1,
          state: "ready",
          runtime: { type: "codex" },
          registration_id: testRegistrationId("codex", {
            tenantId: "tenant-1",
            ownerActorId: "actor-1",
          }),
          assignment_revision: 1,
          workspace_grant_id: "workspace-1",
          runner_pid: 4242,
        },
      ],
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
  const command = async (): Promise<ComputerToolCall> => {
    await vi.waitFor(() =>
      expect(
        sent.some(
          (frame) => frame.type === "execute" && frame.kind === "computer_tool",
        ),
      ).toBe(true),
    );
    const value = [...sent]
      .reverse()
      .find((item) => item.type === "execute" && item.kind === "computer_tool");
    if (value?.type !== "execute" || value?.kind !== "computer_tool")
      throw new Error("Missing Computer tool command");
    return value;
  };
  return { gateway, connection, sent, command };
};

const target = {
  computerId: "computer-local",
  tenantId: "tenant-1",
  ownerActorId: "actor-1",
  agentId: "agent-1",
  toolSessionId: "voice-session-1",
  server: "task_files" as const,
  toolName: "list_files",
  arguments: {},
  taskScope: {
    version: 1 as const,
    tenant_id: "tenant-1",
    agent_id: "agent-1",
    role: "alter_ego" as const,
    origin_room_id: "room-1",
    task_id: "task-1",
  },
  signal: new AbortController().signal,
};

describe("Live native Computer tools", () => {
  it("reads a retained task workspace without starting a model", async () => {
    const { gateway, connection, command, sent } = await connect();
    const pending = gateway.callComputerTool(target);
    const request = await command();
    expect(request.task_scope).toEqual(target.taskScope);
    await connection.receive({
      type: "executed",
      kind: "computer_tool",
      protocol_version: "2",
      command_id: request.command_id,
      runner_id: request.runner_id,
      connection_epoch: request.connection_epoch,
      tenant_id: request.tenant_id,
      owner_actor_id: request.owner_actor_id,
      agent_id: request.agent_id,
      result: { files: ["output/report.md"] },
    });
    await expect(pending).resolves.toEqual({ files: ["output/report.md"] });
    expect(
      sent.some(
        (item) => item.type === "execute" && item.kind === "model_invoke",
      ),
    ).toBe(false);
  });
  it("rejects another owner, Agent or task scope before dispatch", async () => {
    const { gateway, sent } = await connect();
    await expect(
      gateway.callComputerTool({ ...target, ownerActorId: "actor-other" }),
    ).rejects.toBeInstanceOf(LocalComputerNotFoundError);
    await expect(
      gateway.callComputerTool({ ...target, agentId: "agent-other" }),
    ).rejects.toBeInstanceOf(LocalComputerNotFoundError);
    await expect(
      gateway.callComputerTool({
        ...target,
        taskScope: { ...target.taskScope, tenant_id: "tenant-other" },
      }),
    ).rejects.toBeInstanceOf(LocalComputerNotFoundError);
    expect(
      sent.some(
        (item) => item.type === "execute" && item.kind === "computer_tool",
      ),
    ).toBe(false);
  });
  it("requires a live connection", async () => {
    const { gateway, connection } = await connect();
    connection.disconnect();
    await expect(gateway.callComputerTool(target)).rejects.toBeInstanceOf(
      LocalComputerOfflineError,
    );
  });
  it("keeps the outcome uncertain on disconnect and never replays effects", async () => {
    const { gateway, connection, command, sent } = await connect();
    const pending = gateway.callComputerTool({
      ...target,
      server: "browser",
      toolName: "browser_click",
      taskScope: undefined,
    });
    await command();
    connection.disconnect();
    await expect(pending).resolves.toMatchObject({ status: "outcome_unknown" });
    expect(
      sent.filter(
        (item) => item.type === "execute" && item.kind === "computer_tool",
      ),
    ).toHaveLength(1);
  });
  it("does not dispatch an already aborted request", async () => {
    const { gateway, sent } = await connect();
    const abort = new AbortController();
    abort.abort();
    await expect(
      gateway.callComputerTool({ ...target, signal: abort.signal }),
    ).rejects.toThrow();
    expect(
      sent.some(
        (item) => item.type === "execute" && item.kind === "computer_tool",
      ),
    ).toBe(false);
  });
});
