import { describe, expect, it, vi } from "vitest";
import type { RunnerHello } from "@linger/wire-contracts/runner-gateway/types";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";

import {
  hello,
  contextHello,
  authenticatedPrincipal,
  RecordingPeer,
  assignmentFence,
  defaultAgentPlacement,
  localContextViewIdentity,
  acknowledgeEnsuredAgent,
  acceptReadyConnection,
  placeAgent,
  runTarget,
  contextRunTarget,
  sequenceIds,
} from "./runner-gateway-fixtures.js";

const ownerPlacement = {
  type: "local" as const,
  computerId: "runner-local",
  tenantId: "tenant-acme",
  ownerActorId: "actor-alice",
  runtimeType: "codex" as const,
  workspaceGrantId: "grant-owner",
  assignmentRevision: 1,
};

describe("RunnerGateway", () => {
  it("removes a deleted Agent's Runner from its connected Computer", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      contextHello(),
      defaultAgentPlacement({ workspaceGrantId: "grant-owner" }),
    );
    const removal = gateway.finalizeDeletedLocalAgentRunner("agent-reviewer");
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "agent_runner.remove",
        agent_id: "agent-reviewer",
        runner_revision: 2,
      }),
    );
    const remove = peer.sent.at(-1);
    if (remove?.type !== "agent_runner.remove")
      throw new Error("Expected agent_runner.remove");
    await connection.receive({
      type: "agent_runner.state",
      state: "removed",
      protocol_version: remove.protocol_version,
      command_id: remove.command_id,
      runner_id: remove.runner_id,
      ...assignmentFence(remove),
      tenant_id: remove.tenant_id,
      agent_id: remove.agent_id,
      connection_epoch: remove.connection_epoch,
      runner_revision: remove.runner_revision,
    });
    await removal;
    await expect(
      gateway.startOperation(contextRunTarget(localContextViewIdentity())),
    ).rejects.toThrow("Agent Runner desired state is not ready");
    connection.disconnect();
  });

  it("reuses a confirmed ready Runner without another ensure", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      contextHello(),
      peer,
    );
    const options = {
      placement: ownerPlacement,
      modelId: "codex-default",
      agentId: "agent-reviewer",
    };
    const first = gateway.ensureReadyLocalAgentRunner(options);
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)?.type).toBe("agent_runner.ensure"),
    );
    await acknowledgeEnsuredAgent(connection, peer);
    await expect(first).resolves.toBe(1);

    const sent = peer.sent.length;
    await expect(gateway.ensureReadyLocalAgentRunner(options)).resolves.toBe(1);
    expect(peer.sent).toHaveLength(sent);
    connection.disconnect();
  });

  it("keeps Computer reconciliation and healthy Runners available after a scoped Runner failure", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    const bad = defaultAgentPlacement({ workspaceGrantId: "grant-owner" });
    const good = defaultAgentPlacement({
      agentId: "agent-healthy",
      workspaceGrantId: "grant-owner",
    });
    placeAgent(gateway, bad);
    placeAgent(gateway, good);
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      contextHello(),
      peer,
    );
    for (const command of [...peer.sent]) {
      if (command.type !== "agent_runner.ensure") continue;
      const identity = {
        protocol_version: command.protocol_version,
        command_id: command.command_id,
        runner_id: command.runner_id,
        tenant_id: command.tenant_id,
        ...assignmentFence(command),
        agent_id: command.agent_id,
        connection_epoch: command.connection_epoch,
        runner_revision: command.runner_revision,
      };
      await connection.receive(
        command.agent_id === bad.agentId
          ? {
              ...identity,
              type: "agent_runner.state",
              state: "failed",
              error: {
                code: "AGENT_RUNNER_FAILED",
                message: "Agent Runner lifecycle failed",
                retryable: false,
              },
            }
          : {
              ...identity,
              type: "agent_runner.state",
              state: "ready",
              runner_pid: 100,
            },
      );
    }
    expect(peer.closed).toEqual([]);
    const requirement = {
      type: "local" as const,
      computerId: bad.computerId,
      tenantId: bad.tenantId,
      ownerActorId: "actor-alice",
      runtimeType: "codex" as const,
      workspaceGrantId: bad.workspaceGrantId,
      assignmentRevision: 1,
    };
    await expect(
      gateway.ensureReadyLocalAgentRunner({
        placement: requirement,
        modelId: "codex-default",
        agentId: good.agentId,
      }),
    ).resolves.toBe(1);
    await expect(
      gateway.startOperation({
        ...runTarget(),
        ownerActorId: "actor-alice",
        workspaceGrantId: "grant-owner",
      }),
    ).rejects.toThrow("Agent Runner desired state is not ready");
    // The failed Runner is retried under a newer revision, not reused.
    const retry = gateway.ensureReadyLocalAgentRunner({
      placement: requirement,
      modelId: "codex-default",
      agentId: bad.agentId,
    });
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "agent_runner.ensure",
        agent_id: bad.agentId,
        runner_revision: 2,
      }),
    );
    await acknowledgeEnsuredAgent(connection, peer);
    await expect(retry).resolves.toBe(2);
    connection.disconnect();
  });

  it("keeps a Computer offline until desired Agent Runners reconcile", async () => {
    const gateway = createTestRunnerGateway();
    placeAgent(gateway, defaultAgentPlacement());
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello(),
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

    expect(gateway.isLocalComputerExecutionReady("runner-local")).toBe(false);
    await connection.receive({
      type: "runner.heartbeat",
      protocol_version: "2",
      runner_id: "runner-local",
      sent_at: "2026-07-29T00:00:01.000Z",
      active_operation_ids: [],
    });
    expect(gateway.isLocalComputerExecutionReady("runner-local")).toBe(false);

    await acknowledgeEnsuredAgent(connection, peer);
    expect(gateway.isLocalComputerExecutionReady("runner-local")).toBe(true);
  });

  it("keeps a ready Agent available while another Agent Runner reconciles", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const placement = defaultAgentPlacement({
      workspaceGrantId: "grant-owner",
    });
    const peer = new RecordingPeer();
    await acceptReadyConnection(gateway, peer, contextHello(), placement);
    const context = localContextViewIdentity();

    const second = gateway.ensureReadyLocalAgentRunner({
      placement: ownerPlacement,
      modelId: "codex-default",
      agentId: "agent-second",
    });
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "agent_runner.ensure",
        agent_id: "agent-second",
      }),
    );

    await expect(
      gateway.startOperation(contextRunTarget(context)),
    ).resolves.toBeDefined();
    void second.catch(() => undefined);
  });

  it("uses the selected Computer Runtime model and reasoning catalog", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    const peer = new RecordingPeer();
    const diagnostics = runtimeDiagnostics().map((diagnostic) =>
      diagnostic.type === "codex"
        ? {
            ...diagnostic,
            models: [
              {
                id: "gpt-5.6",
                label: "GPT-5.6",
                allowed_reasoning_effort: ["medium", "high"] as const,
                default_reasoning_effort: "medium" as const,
              },
            ],
          }
        : { ...diagnostic, models: [] },
    ) as unknown as RunnerHello["runtime_diagnostics"];
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello(),
        runtime_diagnostics: diagnostics,
        workspace_grants: [
          {
            grant_id: "grant-owner",
            tenant_id: "tenant-acme",
            label: "Linger workspace",
            mode: "workspace-write",
            scope: "owner",
          },
        ],
      },
      peer,
    );
    expect(() =>
      gateway.requireLocalPlacement(
        {
          type: "local",
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
          computerId: "runner-local",
          runtimeType: "codex",
          workspaceGrantId: "grant-owner",
          assignmentRevision: 1,
        },
        "gpt-5.6",
        "ultra",
      ),
    ).toThrow("reasoning effort is unavailable");

    const options = {
      placement: {
        type: "local" as const,
        computerId: "runner-local",
        tenantId: "tenant-acme",
        ownerActorId: "actor-alice",
        runtimeType: "codex" as const,
        workspaceGrantId: "grant-owner",
        assignmentRevision: 1,
      },
      agentId: "agent-reviewer",
      modelId: "gpt-5.6",
      reasoningEffort: "high" as const,
    };
    const ensuring = gateway.ensureReadyLocalAgentRunner(options);
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "agent_runner.ensure",
        runtime: {
          type: "codex",
          model: "gpt-5.6",
          reasoning_effort: "high",
        },
      }),
    );
    await acknowledgeEnsuredAgent(connection, peer);
    await expect(ensuring).resolves.toBe(1);
    connection.disconnect();
  });
});
