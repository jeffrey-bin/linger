import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunnerDesiredStateError } from "../../../src/agent/runner-gateway/agent-runner-desired-state.js";
import { RunnerGatewayProtocolError } from "../../../src/agent/runner-gateway/runner-operation.js";
import type { LocalContextRuntimeGateway } from "../../../src/agent/executor/local-backend.js";
import { createPersistedHistoryInspector } from "../../../src/agent/executor/application.js";
import type { ContextRuntimeStatePort } from "../../../src/agent/executor/context-runtime-state.js";
import type { LocalRuntimeSettings } from "../../../src/agent/runtime-settings.js";
import { createTestFeatureAssembly } from "../test-support/executor-features.js";
import { createStandaloneExecutor } from "../test-support/standalone-executor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const runtime = {
  type: "local",
  model: "gpt-6-astra",
  reasoningEffort: "high",
  placement: {
    type: "local",
    tenantId: "tenant-acme",
    ownerActorId: "actor-owner",
    computerId: "computer-1",
    runtimeType: "codex",
    workspaceGrantId: "grant-1",
    assignmentRevision: 1,
  },
} satisfies LocalRuntimeSettings;

class DetachedHistoryGateway {
  readonly #failure: Error | undefined;

  constructor(failure: Error | undefined) {
    this.#failure = failure;
  }

  async inspectDetachedLocalHistory() {
    if (this.#failure) throw this.#failure;
    return {
      status: "available",
      provider_kind: "codex",
      source: "codex_rollout",
      snapshot: {
        id: "snapshot-old",
        thread_id: "thread-old",
        captured_at: "2026-10-09T13:00:00.000Z",
        record_count: 0,
        tail_state: "clean",
      },
      instructions: {
        status: "available",
        source: "codex_rollout",
        blocks: [],
      },
      records: [],
    };
  }
}

const createHarness = async (failure?: Error) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "detached-history-test-"));
  temporaryDirectories.push(root);
  const gateway = new DetachedHistoryGateway(failure);
  const inspectDetachedLocalHistory = vi.spyOn(
    gateway,
    "inspectDetachedLocalHistory",
  );
  const activate = vi.fn();
  const inspectHistory = createPersistedHistoryInspector(
    gateway as unknown as LocalContextRuntimeGateway,
  );
  const shell = await createStandaloneExecutor<LocalRuntimeSettings>({
    activator: { activate },
    stateFactory: async () =>
      ({
        getRuntimeSession: () => ({ threadId: "thread-old" }),
        hasPendingWork: () => false,
        hasQueuedRuns: () => false,
        hasWaitingMessages: () => false,
        close: () => undefined,
      }) as unknown as ContextRuntimeStatePort,
    inspectPersistedHistory: inspectHistory,
    options: {
      ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
      actorId: "actor-agent-1",
      tenantId: "tenant-acme",
      agent: { name: "Bo", instructions: "test" },
      runtime,
      resources: { skills: [], mcpServers: [] },
      features: createTestFeatureAssembly({
        ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
        actorId: "actor-agent-1",
      }).ports,
    },
  });
  return { inspectHistory, shell, inspectDetachedLocalHistory, activate };
};

describe("detached Local Runtime history", () => {
  it("inspects a persisted session without a Context executor", async () => {
    const { inspectHistory, inspectDetachedLocalHistory, activate } =
      await createHarness();
    const session = { threadId: "thread-old" };

    await expect(
      inspectHistory({
        ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
        runtime,
        session,
        options: {},
      }),
    ).resolves.toMatchObject({
      status: "available",
      providerKind: "codex",
      snapshot: { threadId: "thread-old" },
    });
    expect(inspectDetachedLocalHistory).toHaveBeenCalledOnce();
    expect(inspectDetachedLocalHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        request: expect.objectContaining({ session }),
      }),
    );
    expect(activate).not.toHaveBeenCalled();
  });

  it("reads retained history through the Gateway instance without activating a Runtime", async () => {
    const { shell, activate } = await createHarness();
    await expect(shell.inspectRuntimeHistory({})).resolves.toMatchObject({
      status: "available",
      providerKind: "codex",
      snapshot: { threadId: "thread-old" },
    });
    expect(activate).not.toHaveBeenCalled();
    await shell.stop();
  });

  it("reports an unready Agent Runner as a structured reason", async () => {
    const { shell, inspectDetachedLocalHistory } = await createHarness(
      new AgentRunnerDesiredStateError(
        "Agent Runner desired state is not ready",
      ),
    );

    await expect(shell.inspectRuntimeHistory({})).resolves.toMatchObject({
      status: "unavailable",
      providerKind: "codex",
      reason: "Agent Runner desired state is not ready",
    });
    expect(inspectDetachedLocalHistory).toHaveBeenCalledOnce();
    await shell.stop();
  });

  it("keeps a protocol failure opaque instead of reporting it as state", async () => {
    const { shell } = await createHarness(
      new RunnerGatewayProtocolError("Invalid history command"),
    );

    await expect(shell.inspectRuntimeHistory({})).resolves.toMatchObject({
      status: "unavailable",
      reason: "Runtime provider history inspection failed",
    });
    await shell.stop();
  });
});
