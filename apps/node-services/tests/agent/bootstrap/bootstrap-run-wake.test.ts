import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapAgentManager,
  type AgentManagerApplication,
} from "../../../src/agent/bootstrap/bootstrap-agent-manager.js";
import { RunWakeDispatcher } from "../../../src/agent/agent-features/inbox-source/run-wake-dispatcher.js";
import type { createTeamHubAgentWakeStream } from "../../../src/agent/agent-features/inbox-source/teamhub-agent-wake-stream.js";
import type { RunWakeKind } from "../../../src/agent/agent-features/inbox-source/types.js";
import { encodeExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import { createTeamHubRuntimeStateClientFake } from "../test-support/teamhub-runtime-state-client.js";

type Callbacks = Parameters<typeof createTeamHubAgentWakeStream>[0];
const ref = {
  kind: "meta" as const,
  agentId: "agent-existing",
  roomId: "room-test",
};
const contextKey = encodeExecutionContextRef(ref);
const harness = vi.hoisted(() => ({
  runWakes: null as RunWakeDispatcher | null,
  refresh: vi.fn<() => Promise<void>>(),
  refreshContext:
    vi.fn<(contextKey: string, stateRevision?: string) => Promise<boolean>>(),
  listWaitingContexts: vi.fn<() => Promise<readonly string[]>>(),
  callbacks: null as Callbacks | null,
  streamClose: vi.fn<() => Promise<void>>(),
  closeManager: vi.fn<() => Promise<void>>(),
  taskWake: vi.fn<() => void>(),
}));
vi.mock("../../../src/agent/task-manager/index.js", async (original) => ({
  ...(await original<object>()),
  createTaskWorker: () => ({
    start() {},
    runOnce: async () => false,
    wake: () => harness.taskWake(),
    close: async () => undefined,
  }),
}));
vi.mock("../../../src/agent/executor/application.js", async (original) => ({
  ...(await original<object>()),
  createAgentManagerApplication: () => ({
    agentManager: {
      updateAgent: vi.fn(),
      close: () => harness.closeManager(),
    },
    runWakes: harness.runWakes,
    refreshRuntimeState: () => harness.refresh(),
    refreshRuntimeContext: (key: string, stateRevision?: string) =>
      harness.refreshContext(key, stateRevision),
    closeRuntimeHosts: async () => undefined,
  }),
}));
vi.mock(
  "../../../src/agent/executor/http/agent-manager-http-server.js",
  async (original) => ({
    ...(await original<object>()),
    createAgentManagerHttpServer: () => ({
      start: async () => ({ host: "127.0.0.1", port: 0 }),
      drain: async () => undefined,
      close: async () => undefined,
    }),
  }),
);
vi.mock(
  "../../../src/agent/agent-features/inbox-source/teamhub-agent-wake-stream.js",
  () => ({
    createTeamHubAgentWakeStream: (options: Callbacks) => {
      harness.callbacks = options;
      return { start() {}, close: () => harness.streamClose() };
    },
  }),
);

let application: AgentManagerApplication | undefined;
let root: string;
let wakes: RunWakeKind[];
beforeEach(async () => {
  harness.refresh.mockReset().mockResolvedValue(undefined);
  harness.refreshContext.mockReset().mockResolvedValue(true);
  harness.listWaitingContexts.mockReset().mockResolvedValue([]);
  harness.streamClose.mockReset().mockResolvedValue(undefined);
  harness.closeManager.mockReset().mockResolvedValue(undefined);
  harness.taskWake.mockReset();
  wakes = [];
  harness.runWakes = new RunWakeDispatcher({
    claimContext: (key) => harness.refreshContext(key),
    listWaitingContexts: () => harness.listWaitingContexts(),
    logger: { log: vi.fn(), child: vi.fn() },
  });
  harness.runWakes.registerTarget({ ref, wake: (kind) => wakes.push(kind) });
  root = await mkdtemp(path.join(os.tmpdir(), "bootstrap-wake-"));
  application = await bootstrapAgentManager({
    contextHostRoot: path.join(root, "context-host"),
    roomBaseUrl: "http://teamhub.invalid",
    serviceToken: "test-token",
    inboundServiceToken: "test-token",
    runtimeStateClient: createTeamHubRuntimeStateClientFake(),
  });
});
afterEach(async () => {
  await application?.close();
  application = undefined;
  harness.runWakes?.close();
  harness.runWakes = null;
  harness.callbacks = null;
  await rm(root, { recursive: true, force: true });
});

describe("bootstrap run wake dispatch", () => {
  it("hands run hints to the bound Context without reading TeamHub", () => {
    harness.callbacks!.onRunWake(contextKey, "queued");
    harness.callbacks!.onRunWake(contextKey, "steered");
    expect(wakes).toEqual(["queued", "steered"]);
    expect(harness.refreshContext).not.toHaveBeenCalled();
  });

  it("claims a Context it does not hold before its binding takes the wake", async () => {
    const other = encodeExecutionContextRef({
      kind: "meta",
      agentId: "agent-new",
      roomId: "room-test",
    });
    harness.callbacks!.onRunWake(other, "queued");
    await vi.waitFor(() =>
      expect(harness.refreshContext).toHaveBeenCalledWith(other),
    );
  });

  it("scans waiting Runs and refreshes Contexts on reconcile", async () => {
    harness.listWaitingContexts.mockResolvedValueOnce([contextKey]);
    await harness.callbacks!.onReconcile();
    expect(harness.listWaitingContexts).toHaveBeenCalledOnce();
    expect(wakes).toEqual(["steered"]);
    await vi.waitFor(() => expect(harness.refresh).toHaveBeenCalledOnce());
  });

  it("wakes the Task Worker on task.claimable and on reconcile", async () => {
    harness.callbacks!.onTaskClaimable!();
    expect(harness.taskWake).toHaveBeenCalledOnce();
    await harness.callbacks!.onReconcile();
    expect(harness.taskWake).toHaveBeenCalledTimes(2);
  });

  it("refreshes Context changes and closes the stream on shutdown", async () => {
    await harness.callbacks!.onContextChanged(contextKey, "7");
    expect(harness.refreshContext).toHaveBeenCalledWith(contextKey, "7");
    await application!.close();
    expect(harness.streamClose).toHaveBeenCalledOnce();
  });
});
