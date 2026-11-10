import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManagerApplicationOptions } from "../../../src/agent/executor/application.js";
import {
  bootstrapAgentManager,
  type AgentManagerApplication,
} from "../../../src/agent/bootstrap/bootstrap-agent-manager.js";
import { createTeamHubRuntimeStateClientFake } from "../test-support/teamhub-runtime-state-client.js";

const harness = vi.hoisted(() => ({
  options: undefined as AgentManagerApplicationOptions | undefined,
}));
vi.mock("../../../src/agent/executor/application.js", async (original) => ({
  ...(await original<object>()),
  createAgentManagerApplication: (options: AgentManagerApplicationOptions) => {
    harness.options = options;
    return {
      agentManager: { updateAgent: vi.fn(), close: async () => undefined },
      refreshRuntimeState: async () => undefined,
      refreshRuntimeContext: async () => true,
      closeRuntimeHosts: async () => undefined,
    };
  },
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

let application: AgentManagerApplication | undefined;
let root: string;
const bootstrap = () =>
  bootstrapAgentManager({
    contextHostRoot: path.join(root, "context-host"),
    roomBaseUrl: "http://teamhub.invalid",
    serviceToken: "test-token",
    inboundServiceToken: "test-token",
    runtimeStateClient: createTeamHubRuntimeStateClientFake(),
  });
beforeEach(async () => {
  harness.options = undefined;
  root = await mkdtemp(path.join(os.tmpdir(), "another-me-features-"));
});
afterEach(async () => {
  await application?.close();
  application = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("Another Me bootstrap features", () => {
  it("assembles proactive review and reply rhythm", async () => {
    application = await bootstrap();
    expect(harness.options?.proactive).toBeDefined();
    expect(harness.options?.replyRhythm).toEqual({});
  });
});
