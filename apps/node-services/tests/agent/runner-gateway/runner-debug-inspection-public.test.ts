import { describe, expect, it, vi } from "vitest";
import {
  RunnerGatewayError,
  RunnerGatewayProtocolError,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";

import {
  hello,
  contextHello,
  authenticatedPrincipal,
  RecordingPeer,
  defaultAgentPlacement,
  localContextViewIdentity,
  acceptReadyConnection,
  sequenceIds,
} from "./runner-gateway-fixtures.js";

describe("RunnerGateway", () => {
  it("reads the ready revision without changing stale assignments or placement", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      contextHello(),
      defaultAgentPlacement({
        assignmentRevision: 2,
        workspaceGrantId: "grant-owner",
      }),
    );
    const options = {
      agentId: "agent-reviewer",
      modelId: "codex-default",
      placement: {
        type: "local" as const,
        tenantId: "tenant-acme",
        ownerActorId: "actor-alice",
        computerId: "runner-local",
        runtimeType: "codex" as const,
        workspaceGrantId: "grant-owner",
        assignmentRevision: 2,
      },
    };
    try {
      const sent = structuredClone(peer.sent);
      const revision = gateway.readReadyLocalAgentRunnerRevision(options);
      expect(revision).toBeGreaterThan(0);
      expect(() =>
        gateway.readReadyLocalAgentRunnerRevision({
          ...options,
          placement: { ...options.placement, assignmentRevision: 1 },
        }),
      ).toThrow("assignment");
      expect(() =>
        gateway.readReadyLocalAgentRunnerRevision({
          ...options,
          placement: { ...options.placement, workspaceGrantId: "old-grant" },
        }),
      ).toThrow();
      expect(() =>
        gateway.readReadyLocalAgentRunnerRevision({
          ...options,
          placement: { ...options.placement, computerId: "old-computer" },
        }),
      ).toThrow();
      expect(gateway.readReadyLocalAgentRunnerRevision(options)).toBe(revision);
      expect(peer.sent).toEqual(sent);
    } finally {
      connection.disconnect();
    }
    expect(() => gateway.readReadyLocalAgentRunnerRevision(options)).toThrow();
  });

  it("fails only the inspection whose result violates the Runner contract", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    const peer = new RecordingPeer();
    const greeting = hello();
    const connection = await acceptReadyConnection(gateway, peer, {
      ...greeting,
    });
    try {
      const pending = gateway.inspectDetachedLocalHistory({
        placement: {
          type: "local",
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
          computerId: "runner-local",
          runtimeType: "codex",
          workspaceGrantId: "grant-repo",
          assignmentRevision: 1,
        },
        agentId: "agent-reviewer",
        executionContextKey: "context-detached",
        runtimeInstanceId: "context-detached",
        request: {
          runtime: { type: "codex" },
          session: { threadId: "thread-1" },
        },
      });
      await vi.waitFor(() =>
        expect(peer.sent.at(-1)).toMatchObject({
          type: "execute",
          kind: "debug_history",
        }),
      );
      const command = peer.sent.at(-1);
      if (command?.type !== "execute" || command?.kind !== "debug_history")
        throw new Error("Missing inspection");
      connection.receiveInvalidDebugInspection("inspection-unknown");
      connection.receiveInvalidDebugInspection(command.command_id);
      const error = await pending.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(RunnerGatewayError);
      expect(error).not.toBeInstanceOf(RunnerGatewayProtocolError);
      expect(peer.closed).toEqual([]);
    } finally {
      connection.disconnect();
    }
  });

  it("reads detached History without Context preparation or execution admission", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    const peer = new RecordingPeer();
    const greeting = hello();
    const connection = await acceptReadyConnection(gateway, peer, {
      ...greeting,
    });
    const history = gateway.inspectDetachedLocalHistory({
      placement: {
        type: "local",
        tenantId: "tenant-acme",
        ownerActorId: "actor-alice",
        computerId: "runner-local",
        runtimeType: "codex",
        workspaceGrantId: "grant-repo",
        assignmentRevision: 1,
      },
      agentId: "agent-reviewer",
      executionContextKey: "context-detached",
      runtimeInstanceId: "context-detached",
      request: {
        runtime: { type: "codex" },
        session: { threadId: "thread-1" },
      },
    });
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "execute",
        kind: "debug_history",
      }),
    );
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "execute",
        kind: "debug_history",
      }),
    );
    const command = peer.sent.at(-1);
    if (command?.type !== "execute" || command?.kind !== "debug_history")
      throw new Error("Missing debug command");
    expect(command).toMatchObject({ detached_history: true });
    expect(command).not.toHaveProperty("view_digest");
    expect(peer.sent.some((item) => item.type === "operation.start")).toBe(
      false,
    );
    const { request: _request, ...identity } = command;
    await connection.receive({
      ...identity,
      type: "executed",
      kind: "debug_history",
      result: {
        status: "unavailable",
        provider_kind: "codex",
        reason: "missing",
        instructions: {
          status: "unavailable",
          source: "codex_rollout",
          reason: "missing",
          blocks: [],
        },
        records: [],
      },
    });
    expect(await history).toMatchObject({
      status: "unavailable",
    });
  });

  it("reads detached History for a cold Context without an in-process Runner identity", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    const peer = new RecordingPeer();
    const greeting = hello();
    // No Agent Runner placement: this Agent Service process has never materialized
    // the Context, so it holds no Agent Runner desired state to quote.
    await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...greeting,
      },
      peer,
    );
    void gateway
      .inspectDetachedLocalHistory({
        placement: {
          type: "local",
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
          computerId: "runner-local",
          runtimeType: "codex",
          workspaceGrantId: "grant-repo",
          assignmentRevision: 1,
        },
        agentId: "agent-reviewer",
        executionContextKey: "context-cold",
        runtimeInstanceId: "context-cold",
        request: {
          runtime: { type: "codex" },
          session: { threadId: "thread-1" },
        },
      })
      .catch(() => undefined);

    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "execute",
        kind: "debug_history",
      }),
    );
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "execute",
        kind: "debug_history",
      }),
    );
    const command = peer.sent.at(-1);
    if (command?.type !== "execute" || command?.kind !== "debug_history")
      throw new Error("Missing debug command");
    expect(command).toMatchObject({
      detached_history: true,
      execution_context_key: "context-cold",
    });
    // The Runner identity is all-or-nothing: the Runner authorizes this read
    // from its own ready Assignment instead of reconciling a partial one.
    expect(command).not.toHaveProperty("registration_id");
    expect(command).not.toHaveProperty("assignment_revision");
    expect(command).not.toHaveProperty("runner_revision");
  });

  it("binds Debug inspection to the Context View it names", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const placement = defaultAgentPlacement({
      workspaceGrantId: "grant-owner",
    });
    const peer = new RecordingPeer();
    const value = contextHello();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      value,
      placement,
    );
    const context = localContextViewIdentity();

    const inspecting = gateway.inspectLocalContext({
      context,
      request: {
        runtime: { type: "codex", model: "gpt-test" },
        session: { threadId: "thread-debug" },
        cursor: "cursor-debug",
        limit: 50,
      },
    });
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "execute",
        kind: "debug_history",
      }),
    );
    const command = peer.sent.at(-1);
    if (command?.type !== "execute" || command?.kind !== "debug_history") {
      throw new Error("Expected debug.inspect");
    }
    expect(command).toMatchObject({
      view_digest: context.viewDigest,
      request: {
        session: { threadId: "thread-debug" },
        cursor: "cursor-debug",
        limit: 50,
      },
    });
    const { request: _request, ...identity } = command;
    await connection.receive({
      ...identity,
      type: "executed",
      kind: "debug_history",
      result: {
        status: "available",
        provider_kind: "codex",
        source: "codex_rollout",
        snapshot: {
          id: "snapshot-debug",
          thread_id: "thread-debug",
          captured_at: "2026-08-24T12:00:00.000Z",
          record_count: 0,
          tail_state: "clean",
        },
        instructions: {
          status: "unavailable",
          source: "codex_rollout",
          reason: "none",
          blocks: [],
        },
        records: [],
      },
    });

    await expect(inspecting).resolves.toEqual({
      status: "available",
      provider_kind: "codex",
      source: "codex_rollout",
      snapshot: {
        id: "snapshot-debug",
        thread_id: "thread-debug",
        captured_at: "2026-08-24T12:00:00.000Z",
        record_count: 0,
        tail_state: "clean",
      },
      instructions: {
        status: "unavailable",
        source: "codex_rollout",
        reason: "none",
        blocks: [],
      },
      records: [],
    });
  });
});
