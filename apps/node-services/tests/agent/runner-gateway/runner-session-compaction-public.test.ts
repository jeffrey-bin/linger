import type { RunnerHello } from "@linger/wire-contracts/runner-gateway/types";
import { describe, expect, it, vi } from "vitest";
import { LocalComputerOfflineError } from "../../../src/agent/runner-gateway/local-computer-management.js";
import type {
  RunnerGateway,
  RunnerGatewayConnection,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import { CURRENT_RUNNER_CAPABILITIES } from "../test-support/runner-capabilities.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";
import {
  acceptReadyConnection,
  hello,
  RecordingPeer,
  sequenceIds,
} from "./runner-gateway-fixtures.js";

/** One unit at a time, as on a gateway Runtime. */
const compactingHello = (): RunnerHello => ({
  ...hello(),
  capabilities: [...CURRENT_RUNNER_CAPABILITIES],
  runtime_diagnostics: runtimeDiagnostics({ link: "api" }),
});

const target = {
  runnerId: "runner-local",
  agentId: "agent-reviewer",
  executionContextKey: "context-1",
};

const sentCompaction = async (peer: RecordingPeer) => {
  await vi.waitFor(() =>
    expect(peer.sent.at(-1)).toMatchObject({
      type: "execute",
      kind: "session_compact",
    }),
  );
  const command = peer.sent.at(-1);
  if (command?.type !== "execute" || command?.kind !== "session_compact")
    throw new Error("Missing session.compact");
  return command;
};

const compacted = (
  connection: RunnerGatewayConnection,
  command: { readonly command_id: string; readonly compact_id: string },
  outcome: "compacted" | "canceled" = "compacted",
) =>
  connection.receive({
    type: "executed",
    kind: "session_compact",
    command_id: command.command_id,
    runner_id: "runner-local",
    compact_id: command.compact_id,
    execution_context_key: "context-1",
    outcome,
    pre_tokens: 120_000,
    duration_ms: 900,
  });

const connect = async (
  value: RunnerHello = compactingHello(),
): Promise<{
  gateway: RunnerGateway;
  peer: RecordingPeer;
  connection: RunnerGatewayConnection;
}> => {
  const gateway = createTestRunnerGateway({
    createId: sequenceIds(),
  });
  const peer = new RecordingPeer();
  const connection = await acceptReadyConnection(gateway, peer, value);
  return { gateway, peer, connection };
};

describe("RunnerGateway session compaction", () => {
  it("sends session.compact and resolves with the Daemon's outcome", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      expect(gateway.supportsSessionCompaction("runner-local", "codex")).toBe(
        true,
      );
      const pending = gateway.compactParkedSession(target, {
        runtimeType: "codex",
        instructions: "Keep task ids",
        signal: new AbortController().signal,
      });
      const command = await sentCompaction(peer);
      expect(command).toEqual({
        type: "execute",
        kind: "session_compact",
        protocol_version: "2",
        command_id: expect.any(String),
        compact_id: expect.any(String),
        runner_id: "runner-local",
        connection_epoch: expect.any(Number),
        agent_id: "agent-reviewer",
        runtime_type: "codex",
        execution_context_key: "context-1",
        instructions: "Keep task ids",
      });
      // An outcome for another compaction is not this one's answer.
      await compacted(connection, { ...command, compact_id: "compact-other" });
      await compacted(connection, command);
      await expect(pending).resolves.toMatchObject({
        outcome: "compacted",
        pre_tokens: 120_000,
      });
      expect(peer.closed).toEqual([]);
    } finally {
      connection.disconnect();
    }
  });

  it("answers no_process locally when the Computer cannot compact", async () => {
    const { gateway, peer, connection } = await connect({
      ...hello(),
      runtime_diagnostics: runtimeDiagnostics({
        authenticationRequired: ["codex"],
        ready: [],
      }),
    });
    try {
      expect(gateway.supportsSessionCompaction("runner-local", "codex")).toBe(
        false,
      );
      await expect(
        gateway.compactParkedSession(target, {
          runtimeType: "codex",
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ outcome: "no_process" });
      expect(
        peer.sent.some(
          (frame) =>
            frame.type === "execute" && frame.kind === "session_compact",
        ),
      ).toBe(false);
    } finally {
      connection.disconnect();
    }
  });

  it("waits for its turn while other model work fills the endpoint, ahead of background work", async () => {
    const { gateway, peer, connection } = await connect();
    const codex = { computerId: "runner-local", runtimeType: "codex" as const };
    try {
      const running = await gateway.acquireModelChain(
        codex,
        { priority: 70, kind: "wiki", key: "wiki:test" },
        new AbortController().signal,
      );
      const memory = gateway.acquireModelChain(
        codex,
        { priority: 40, kind: "memory", key: "memory:test" },
        new AbortController().signal,
      );
      const pending = gateway.compactParkedSession(target, {
        runtimeType: "codex",
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        peer.sent.some(
          (frame) =>
            frame.type === "execute" && frame.kind === "session_compact",
        ),
      ).toBe(false);
      running.release({ outcome: "completed" });
      const command = await sentCompaction(peer);
      let admitted = false;
      void memory.then(() => (admitted = true));
      await compacted(connection, command);
      await expect(pending).resolves.toMatchObject({ outcome: "compacted" });
      (await memory).release({ outcome: "completed" });
      expect(admitted).toBe(true);
    } finally {
      connection.disconnect();
    }
  });

  it("answers no_process when the Computer disconnects while compaction waits", async () => {
    const { gateway, connection } = await connect();
    const running = await gateway.acquireModelChain(
      { computerId: "runner-local", runtimeType: "codex" },
      { priority: 70, kind: "wiki", key: "wiki:test" },
      new AbortController().signal,
    );
    const pending = gateway.compactParkedSession(target, {
      runtimeType: "codex",
      signal: new AbortController().signal,
    });
    connection.disconnect();
    await expect(pending).resolves.toEqual({
      outcome: "no_process",
      reason: "computer_unavailable",
    });
    running.release({ outcome: "lost" });
  });

  it("never offers compaction for Pi or a Runtime that is not ready", async () => {
    const { gateway, connection } = await connect();
    try {
      expect(gateway.supportsSessionCompaction("runner-local", "pi")).toBe(
        false,
      );
      expect(gateway.supportsSessionCompaction("runner-local", "claude")).toBe(
        false,
      );
    } finally {
      connection.disconnect();
    }
  });

  it("rejects the wait when the Computer disconnects", async () => {
    const { gateway, peer, connection } = await connect();
    const pending = gateway.compactParkedSession(target, {
      runtimeType: "codex",
      signal: new AbortController().signal,
    });
    await sentCompaction(peer);
    connection.disconnect();
    await expect(pending).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });

  it("stops waiting on abort without a cancel frame and ignores the late outcome", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const controller = new AbortController();
      const pending = gateway.compactParkedSession(target, {
        runtimeType: "codex",
        signal: controller.signal,
      });
      const command = await sentCompaction(peer);
      const sentBeforeAbort = peer.sent.length;
      controller.abort(new Error("new input arrived"));
      await expect(pending).rejects.toThrow("new input arrived");
      expect(peer.sent).toHaveLength(sentBeforeAbort);
      await compacted(connection, command, "canceled");
      expect(peer.closed).toEqual([]);
    } finally {
      connection.disconnect();
    }
  });
});
