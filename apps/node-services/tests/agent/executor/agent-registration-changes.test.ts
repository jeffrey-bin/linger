import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import type {
  AgentDeletionOptions,
  AgentManagerApi,
} from "../../../src/agent/executor/agent-manager-api.js";
import type { RunCancellationStatus } from "../../../src/agent/executor/types.js";
import { createAgentManagerHttpServer } from "../../../src/agent/executor/http/agent-manager-http-server.js";
import {
  snapshotGhost,
  type GhostRegistration,
} from "../../../src/agent/executor/ghost.js";
import type { LocalAgentRunnerManagement } from "../../../src/agent/runner-gateway/local-computer-management.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";

interface TestRuntimeSettings {
  type: "codex";
  model: string;
  reasoningEffort?: "low" | "xhigh";
  placement: {
    type: "local";
    tenantId: string;
    ownerActorId: string;
    computerId: string;
    runtimeType: "codex";
    workspaceGrantId: string;
    assignmentRevision: number;
  };
}

const registration: GhostRegistration<TestRuntimeSettings> = {
  tenantId: "tenant-a",
  revision: "1",
  agent: {
    name: "Reviewer",
    instructions: "Review the Room conversation.",
  },
  runtime: {
    type: "codex",
    model: "gpt-test",
    placement: {
      type: "local",
      tenantId: "tenant-a",
      ownerActorId: "actor-a",
      computerId: "computer-a",
      runtimeType: "codex",
      workspaceGrantId: "grant-a",
      assignmentRevision: 1,
    },
  },
  resources: { skills: [], mcpServers: [] },
};

const serviceToken = "agent-registration-changes-test-token";
const servers: Array<ReturnType<typeof createAgentManagerHttpServer>> = [];

// RegistrationApi stands in for TeamHub's registration rows: an Agent is
// active while it is registered and revoked once removed from the map.
class RegistrationApi implements AgentManagerApi<TestRuntimeSettings> {
  refreshes = 0;
  readonly registrations = new Map<
    string,
    GhostRegistration<TestRuntimeSettings>
  >();
  readonly deleted = new Set<string>();

  async cancelLocalRun(): Promise<RunCancellationStatus> {
    return "not_found";
  }

  async getGhost(agentId: string) {
    const registered = this.registrations.get(agentId);
    return registered ? snapshotGhost({ agentId, ...registered }) : null;
  }

  async refreshAgent(agentId: string) {
    this.refreshes += 1;
    return this.deleted.has(agentId) ? null : this.getGhost(agentId);
  }

  async deleteAgent(agentId: string, options: AgentDeletionOptions = {}) {
    if (!this.registrations.has(agentId)) return "not_found" as const;
    await options.beforeIdentityRemoval?.();
    return this.registrations.delete(agentId)
      ? ("deleted" as const)
      : ("not_found" as const);
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Agent registration change notifications", () => {
  it("forgets a revoked Agent whose Computer is offline", async () => {
    const api = new RegistrationApi();
    api.registrations.set("agent-local", registration);
    api.deleted.add("agent-local");
    const url = await startServer(api, createTestRunnerGateway());

    // The Computer learns that the Agent is gone when it connects again.
    assert.equal((await notify(url, "agent-local")).status, 204);
    assert.equal(await api.getGhost("agent-local"), null);
    assert.equal((await notify(url, "agent-local")).status, 204);
  });

  it("notes the placement of an active Agent without removing it", async () => {
    const api = new RegistrationApi();
    api.registrations.set("agent-local", registration);
    const management = new RegistrationRunnerManagement();
    const url = await startServer(api, management);

    assert.equal((await notify(url, "agent-local")).status, 204);
    assert.equal(api.refreshes, 1);
    assert.notEqual(await api.getGhost("agent-local"), null);
    assert.deepEqual(management.notedPlacements, [
      ["agent-local", "computer-a"],
    ]);
    assert.equal(management.deletions, 0);
  });

  it("requires the service bearer and the POST method", async () => {
    const api = new RegistrationApi();
    const url = await startServer(api);
    const unauthenticated = await fetch(
      `${url}/v1/agents/agent-local/registration-changes`,
      { method: "POST" },
    );
    assert.equal(unauthenticated.status, 401);
    const wrongMethod = await fetch(
      `${url}/v1/agents/agent-local/registration-changes`,
      { method: "GET", headers: { authorization: `Bearer ${serviceToken}` } },
    );
    assert.equal(wrongMethod.status, 405);
    assert.equal(api.refreshes, 0);
  });
});

const startServer = async (
  api: RegistrationApi,
  localComputerManagement?: LocalAgentRunnerManagement,
): Promise<string> => {
  const server = createAgentManagerHttpServer({
    api,
    localComputerManagement:
      localComputerManagement ?? new RegistrationRunnerManagement(),

    serviceToken,
    port: 0,
  });
  servers.push(server);
  return (await server.start()).url;
};

class RegistrationRunnerManagement implements LocalAgentRunnerManagement {
  readonly notedPlacements: Array<[string, string]> = [];
  deletions = 0;

  removeLocalComputer(): void {}

  async runLocalComputerMutation<T>(
    _computerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await operation();
  }

  requireLocalPlacement() {
    return { id: "codex-default", label: "Codex default" };
  }

  async ensureReadyLocalAgentRunner(
    _options: Parameters<
      LocalAgentRunnerManagement["ensureReadyLocalAgentRunner"]
    >[0],
  ): Promise<number> {
    return 1;
  }

  async noteAgentPlacement(agentId: string, computerId: string): Promise<void> {
    this.notedPlacements.push([agentId, computerId]);
  }

  async finalizeDeletedLocalAgentRunner(): Promise<void> {
    this.deletions += 1;
  }
}

const notify = (baseUrl: string, agentId: string): Promise<Response> =>
  fetch(`${baseUrl}/v1/agents/${agentId}/registration-changes`, {
    method: "POST",
    headers: { authorization: `Bearer ${serviceToken}` },
  });
