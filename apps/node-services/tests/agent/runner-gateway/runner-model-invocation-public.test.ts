import type {
  ModelInvoke,
  OperationStart,
  RunnerHello,
} from "@linger/wire-contracts/runner-gateway/types";
import { describe, expect, it, vi } from "vitest";
import { LocalComputerOfflineError } from "../../../src/agent/runner-gateway/local-computer-management.js";
import type {
  RunnerGateway,
  RunnerGatewayConnection,
  RunnerModelInvokeRequest,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import { RunnerModelInvokeUnavailableError } from "../../../src/agent/runner-gateway/runner-gateway.js";
import {
  modelCallPolicies,
  type ModelCallKind,
} from "../../../src/model-tasks.js";
import { CURRENT_RUNNER_CAPABILITIES } from "../test-support/runner-capabilities.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import {
  acceptReadyConnection,
  hello,
  RecordingPeer,
  sequenceIds,
  sessionTarget,
} from "./runner-gateway-fixtures.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";

/** A Computer whose Runtime reaches its model through a gateway, so it runs
 * one unit at a time. */
const invokingHello = (): RunnerHello => ({
  ...hello(),
  capabilities: [...CURRENT_RUNNER_CAPABILITIES],
  runtime_diagnostics: runtimeDiagnostics({ link: "api" }),
});

const queued = (kind: ModelCallKind, runOperationId?: string) => ({
  priority: modelCallPolicies[kind].priority,
  kind,
  key: `${kind}:test`,
  ...(runOperationId ? { runOperationId } : {}),
});

const request = (
  overrides: Partial<RunnerModelInvokeRequest> = {},
): RunnerModelInvokeRequest => ({
  tenantId: "tenant-acme",
  ownerActorId: "human-alice",
  agentId: "agent-another-me",
  runtimeType: "codex",
  mode: "structured",
  reasoningEffort: "low",
  instructions: "Summarize.",
  input: "Notes",
  outputSchema: { type: "object" },
  timeoutMs: 60_000,
  queue: queued("memory"),
  signal: new AbortController().signal,
  ...overrides,
});

const sentInvocations = (peer: RecordingPeer): ModelInvoke[] =>
  peer.sent.filter(
    (envelope): envelope is ModelInvoke =>
      envelope.type === "execute" && envelope.kind === "model_invoke",
  );

const invoked = (
  connection: RunnerGatewayConnection,
  command: Pick<ModelInvoke, "command_id" | "invoke_id">,
  outcome: "completed" | "unavailable" = "completed",
) =>
  connection.receive({
    type: "executed",
    kind: "model_invoke",
    command_id: command.command_id,
    runner_id: "runner-local",
    invoke_id: command.invoke_id,
    outcome,
    ...(outcome === "completed" ? { text: '{"summary":"ok"}' } : {}),
    duration_ms: 900,
  });

const connect = async (
  value: RunnerHello = invokingHello(),
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

describe("RunnerGateway model invocation", () => {
  it("sends model.invoke and resolves with the Daemon's outcome", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      expect(gateway.supportsModelInvoke("runner-local", "codex")).toBe(true);
      const pending = gateway.invokeModel(
        "runner-local",
        request({
          sessionKey: "permission-review:abc",
          maxOutputChars: 24_000,
        }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      const [command] = sentInvocations(peer);
      expect(command).toEqual({
        type: "execute",
        kind: "model_invoke",
        protocol_version: "2",
        command_id: expect.any(String),
        invoke_id: expect.any(String),
        runner_id: "runner-local",
        connection_epoch: expect.any(Number),
        tenant_id: "tenant-acme",
        owner_actor_id: "human-alice",
        agent_id: "agent-another-me",
        runtime_type: "codex",
        mode: "structured",
        reasoning_effort: "low",
        instructions: "Summarize.",
        input: "Notes",
        output_schema: { type: "object" },
        session_key: "permission-review:abc",
        timeout_ms: 60_000,
        max_output_chars: 24_000,
      });
      // A reply for another call is not this one's answer.
      await invoked(connection, { ...command!, invoke_id: "invoke-other" });
      await invoked(connection, command!);
      await expect(pending).resolves.toEqual({
        outcome: "completed",
        text: '{"summary":"ok"}',
        duration_ms: 900,
      });
      expect(peer.closed).toEqual([]);
    } finally {
      connection.disconnect();
    }
  });

  it("starts queued calls by priority as the endpoint frees", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const results = [
        request({ input: "wiki", queue: queued("wiki") }),
        request({ input: "profile", queue: queued("profile") }),
        request({ input: "memory", queue: queued("memory") }),
      ].map((value) => gateway.invokeModel("runner-local", value));
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      expect(sentInvocations(peer)[0]!.input).toBe("wiki");
      // A reply nobody waits for still frees its place.
      await invoked(connection, sentInvocations(peer)[0]!, "unavailable");
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(2));
      expect(sentInvocations(peer)[1]!.input).toBe("memory");
      await invoked(connection, sentInvocations(peer)[1]!);
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(3));
      expect(sentInvocations(peer)[2]!.input).toBe("profile");
      await invoked(connection, sentInvocations(peer)[2]!);
      await expect(Promise.all(results)).resolves.toMatchObject([
        { outcome: "unavailable" },
        { outcome: "completed" },
        { outcome: "completed" },
      ]);
    } finally {
      connection.disconnect();
    }
  });

  it("starts a call that never queues while queued work fills the endpoint", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const background = gateway.invokeModel(
        "runner-local",
        request({ input: "memory" }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      const ask = gateway.invokeModel(
        "runner-local",
        request({ input: "voice", queue: undefined }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(2));
      expect(sentInvocations(peer)[1]!.input).toBe("voice");
      for (const command of sentInvocations(peer))
        await invoked(connection, command);
      await Promise.all([background, ask]);
    } finally {
      connection.disconnect();
    }
  });

  it("runs an approval in the place of the Run it reviews, and queues one for any other Run first", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      await gateway.startOperation(sessionTarget());
      const start = peer.sent.find(
        (command): command is OperationStart =>
          command.type === "operation.start",
      )!;
      const background = gateway.invokeModel(
        "runner-local",
        request({ input: "memory" }),
      );
      const other = gateway.invokeModel(
        "runner-local",
        request({
          input: "other review",
          queue: queued("approval", "operation-elsewhere"),
        }),
      );
      const review = gateway.invokeModel(
        "runner-local",
        request({
          input: "review",
          queue: queued("approval", start.operation_id),
        }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      expect(sentInvocations(peer)[0]!.input).toBe("review");
      await invoked(connection, sentInvocations(peer)[0]!);
      await expect(review).resolves.toMatchObject({ outcome: "completed" });
      connection.disconnect();
      await expect(other).rejects.toBeInstanceOf(LocalComputerOfflineError);
      await expect(background).rejects.toBeInstanceOf(
        LocalComputerOfflineError,
      );
    } finally {
      connection.disconnect();
    }
  });

  it("drops a queued call whose caller stops waiting", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const running = gateway.invokeModel("runner-local", request());
      const controller = new AbortController();
      const queued = gateway.invokeModel(
        "runner-local",
        request({ input: "abandoned", signal: controller.signal }),
      );
      const next = gateway.invokeModel(
        "runner-local",
        request({ input: "next" }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      controller.abort(new Error("caller gave up"));
      await expect(queued).rejects.toThrow("caller gave up");
      await invoked(connection, sentInvocations(peer)[0]!);
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(2));
      expect(sentInvocations(peer)[1]!.input).toBe("next");
      await invoked(connection, sentInvocations(peer)[1]!);
      await Promise.all([running, next]);
    } finally {
      connection.disconnect();
    }
  });

  it("rejects running and queued calls when the Computer disconnects", async () => {
    const { gateway, peer, connection } = await connect();
    const calls = [1, 2, 3].map(() =>
      gateway.invokeModel("runner-local", request()),
    );
    await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
    connection.disconnect();
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(LocalComputerOfflineError);
    }
    await expect(
      gateway.invokeModel("runner-local", request()),
    ).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });

  it("refuses a Runtime that is not ready", async () => {
    const current = await connect();
    try {
      for (const runtimeType of ["claude", "pi"] as const) {
        expect(
          current.gateway.supportsModelInvoke("runner-local", runtimeType),
        ).toBe(false);
      }
      await expect(
        current.gateway.invokeModel(
          "runner-local",
          request({ runtimeType: "claude" }),
        ),
      ).rejects.toBeInstanceOf(RunnerModelInvokeUnavailableError);
      expect(sentInvocations(current.peer)).toEqual([]);
    } finally {
      current.connection.disconnect();
    }
  });

  it("sends Skill-sized instructions within the 3 MiB prompt", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const instructions = "i".repeat(250_000);
      const pending = gateway.invokeModel(
        "runner-local",
        request({ instructions }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      const [command] = sentInvocations(peer);
      expect(command!.instructions).toBe(instructions);
      await invoked(connection, command!);
      await expect(pending).resolves.toMatchObject({ outcome: "completed" });
    } finally {
      connection.disconnect();
    }
  });

  it("rejects a prompt over 3 MiB before it reaches the Computer", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      await expect(
        gateway.invokeModel(
          "runner-local",
          request({ input: "€".repeat(1_048_577) }),
        ),
      ).rejects.toThrow("Model invocation prompt exceeds 3 MiB");
      expect(sentInvocations(peer)).toEqual([]);
    } finally {
      connection.disconnect();
    }
  });
});
