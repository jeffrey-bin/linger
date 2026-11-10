import { describe, expect, it, vi } from "vitest";
import {
  createAgentMemoryServices,
  type AgentMemoryServicesOptions,
} from "../../../../src/agent/agent-features/agent-memory/services.js";
import type { AgentMemoryHost } from "../../../../src/agent/agent-features/agent-memory/coordinator.js";
import type { TeamHubRuntimeStateClient } from "../../../../src/agent/executor/teamhub-runtime-state-client.js";
import { stubModelCall } from "../../../model-call-stub.js";

const host = (): AgentMemoryHost => ({
  getGhost: vi.fn(async () => null),
  inspectDebugContextHistory: vi.fn(),
});

const fixture = (
  overrides: Partial<AgentMemoryServicesOptions> = {},
): AgentMemoryServicesOptions => ({
  memory: { read: vi.fn(), commit: vi.fn() },
  contextHost: { ensureAgentRoots: vi.fn() },
  runtimeState: {
    listContexts: async () => [],
    getWorkState: vi.fn(),
  } as unknown as TeamHubRuntimeStateClient,
  logger: { log: vi.fn() },
  maintenance: {
    modelCall: stubModelCall({ call: vi.fn() }),
  },
  ...overrides,
});

describe("Agent Memory services lifecycle", () => {
  it("fails a wake before start loudly, then runs maintenance once started", async () => {
    const services = createAgentMemoryServices(fixture());
    const memoryHost = host();
    try {
      expect(() => services.featureDeps.agentMemory.wake("A")).toThrow(
        "agent memory services not started",
      );
      services.start(memoryHost);
      await services.featureDeps.agentMemory.wake("A");
      expect(memoryHost.getGhost).toHaveBeenCalledWith("A");
      expect(() => services.start(host())).toThrow(
        "agent memory services already started",
      );
    } finally {
      await services.close();
    }
  });

  it("projects memory but runs no maintenance without a gateway", async () => {
    const options = fixture({ maintenance: undefined });
    const services = createAgentMemoryServices(options);
    const memoryHost = host();
    try {
      services.start(memoryHost);
      expect(options.logger.log).toHaveBeenCalledWith(
        "info",
        "agent_memory.maintenance_unavailable",
        expect.any(Object),
      );
      await services.featureDeps.agentMemory.wake("A");
      expect(memoryHost.getGhost).not.toHaveBeenCalled();
      expect(services.featureDeps.agentMemoryProjection).toBeDefined();
      expect(() => services.start(host())).toThrow(
        "agent memory services already started",
      );
    } finally {
      await services.close();
    }
  });

  it("rejects start after close so no unmanaged timer survives", async () => {
    const services = createAgentMemoryServices(fixture());
    await services.close();
    expect(() => services.start(host())).toThrow(
      "agent memory services are closed",
    );
    // A stopped service keeps quiet wake semantics for late terminals.
    await services.featureDeps.agentMemory.wake("A");
  });

  it("shares one completion across concurrent closes", async () => {
    const services = createAgentMemoryServices(fixture());
    services.start(host());
    const first = services.close();
    const second = services.close();
    expect(second).toBe(first);
    await first;
  });
});
