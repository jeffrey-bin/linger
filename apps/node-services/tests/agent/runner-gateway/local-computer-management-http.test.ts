import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentDeletionOptions,
  AgentManagerApi,
} from "../../../src/agent/executor/agent-manager-api.js";
import {
  createAgentManagerHttpServer,
  type AgentManagerHttpServerHandle,
} from "../../../src/agent/executor/http/agent-manager-http-server.js";
import { snapshotGhost } from "../../../src/agent/executor/ghost.js";
import type { Ghost } from "../../../src/agent/executor/ghost.js";
import type {
  LocalAgentRunnerManagement,
  LocalPlacementRequirement,
} from "../../../src/agent/runner-gateway/local-computer-management.js";
import { LocalComputerOfflineError } from "../../../src/agent/runner-gateway/local-computer-management.js";

const SERVICE_TOKEN = "agent-manager-test-token";
const servers: AgentManagerHttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Agent Management Local Computer routes", () => {
  const codexPlacement = {
    type: "local" as const,
    computerId: "computer-alice",
    ownerActorId: "actor-alice",
    tenantId: "tenant-acme",
    runtimeType: "codex" as const,
    workspaceGrantId: "grant-repo",
    assignmentRevision: 1,
  };
  const codexGhost = () =>
    snapshotGhost({
      agentId: "agent-codex",
      tenantId: "tenant-acme",
      revision: "1",
      agent: { name: "Reviewer", instructions: "Review" },
      runtime: { model: "codex-default", placement: codexPlacement },
      resources: { skills: [], mcpServers: [] },
    });

  it("removes a revoked Agent and its Local Agent Runners on a registration change", async () => {
    const management = new RecordingLocalComputerManagement();
    const api = new RecordingAgentManager();
    api.ghosts.set("agent-codex", codexGhost());
    api.revoked.add("agent-codex");
    const address = await startServer(management, api);
    const response = await authenticatedFetch(
      `${address}/v1/agents/agent-codex/registration-changes`,
      { method: "POST" },
    );
    expect(response.status).toBe(204);
    expect(management.finalizedDeletedAgentIds).toEqual([
      "agent-codex",
      "agent-codex",
    ]);
    expect(api.ghosts.has("agent-codex")).toBe(false);
  });

  it("notes the new placement of a moved Agent on a registration change", async () => {
    const management = new RecordingLocalComputerManagement();
    const api = new RecordingAgentManager();
    api.ghosts.set("agent-codex", codexGhost());
    const address = await startServer(management, api);
    const response = await authenticatedFetch(
      `${address}/v1/agents/agent-codex/registration-changes`,
      { method: "POST" },
    );
    expect(response.status).toBe(204);
    expect(management.notedPlacements).toEqual([
      ["agent-codex", "computer-alice"],
    ]);
    expect(management.finalizedDeletedAgentIds).toEqual([]);
    expect(api.ghosts.has("agent-codex")).toBe(true);
  });

  it("removes an unassigned Computer and reports assignment conflicts", async () => {
    const management = new RecordingLocalComputerManagement();
    const address = await startServer(management);

    const removed = await authenticatedFetch(
      `${address}/v1/tenants/tenant-acme/owners/actor-alice/local-computers/computer-alice`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(204);
    expect(management.removed).toEqual([
      {
        computerId: "computer-alice",
        ownerActorId: "actor-alice",
        tenantId: "tenant-acme",
      },
    ]);

    management.removeConflict = true;
    const conflict = await authenticatedFetch(
      `${address}/v1/tenants/tenant-acme/owners/actor-alice/local-computers/computer-alice`,
      { method: "DELETE" },
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "LOCAL_COMPUTER_HAS_AGENTS" },
    });
  });

  it("finalizes an unreleased assignment when Ghost deletion already committed", async () => {
    const management = new RecordingLocalComputerManagement();
    const address = await startServer(management);

    const deleted = await authenticatedFetch(
      `${address}/v1/agents/agent-orphan/registration-changes`,
      { method: "POST" },
    );

    expect(deleted.status).toBe(204);
    expect(management.finalizedDeletedAgentIds).toEqual(["agent-orphan"]);
  });
});

const startServer = async (
  localComputerManagement?: LocalAgentRunnerManagement,
  api: TestAgentApi = emptyAgentManager,
) => {
  const server = createAgentManagerHttpServer({
    api,
    localComputerManagement,
    serviceToken: SERVICE_TOKEN,
    port: 0,
  });
  servers.push(server);
  return (await server.start()).url;
};

const authenticatedFetch = (url: string, init: RequestInit) =>
  fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });

interface TestRuntimeSettings {
  readonly type?: "codex";
  readonly model: string;
  readonly placement: LocalPlacementRequirement;
}

type TestAgentApi = AgentManagerApi<TestRuntimeSettings>;

const emptyAgentManager: TestAgentApi = {
  cancelLocalRun: async () => "not_found",
  deleteAgent: async () => "not_found",
  getGhost: async () => null,
  refreshAgent: async () => null,
};

class RecordingAgentManager implements AgentManagerApi<TestRuntimeSettings> {
  readonly ghosts = new Map<string, Ghost<TestRuntimeSettings>>();
  readonly revoked = new Set<string>();

  async cancelLocalRun() {
    return "not_found" as const;
  }

  async getGhost(agentId: string) {
    return this.ghosts.get(agentId) ?? null;
  }

  async refreshAgent(agentId: string) {
    return this.revoked.has(agentId) ? null : this.getGhost(agentId);
  }

  async deleteAgent(agentId: string, options: AgentDeletionOptions = {}) {
    if (!this.ghosts.has(agentId)) return "not_found" as const;
    await options.beforeIdentityRemoval?.();
    return this.ghosts.delete(agentId)
      ? ("deleted" as const)
      : ("not_found" as const);
  }
}

class RecordingLocalComputerManagement implements LocalAgentRunnerManagement {
  readonly mutationComputerIds: string[] = [];
  readonly ensuredRunners: Array<{
    agentId: string;
    modelId: string;
    placement: LocalPlacementRequirement;
  }> = [];
  readonly placements: LocalPlacementRequirement[] = [];
  readonly notedPlacements: Array<[string, string]> = [];
  readonly finalizedDeletedAgentIds: string[] = [];
  readonly removed: Array<{
    computerId: string;
    ownerActorId: string;
    tenantId: string;
  }> = [];
  removeConflict = false;
  offline = false;
  authenticationRequired = false;

  async runLocalComputerMutation<T>(
    computerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.mutationComputerIds.push(computerId);
    return await operation();
  }

  removeLocalComputer(input: {
    computerId: string;
    ownerActorId: string;
    tenantId: string;
  }) {
    if (this.removeConflict) {
      const error = new Error("Local Computer still has assigned Agents");
      Object.assign(error, { code: "local_computer_has_agents" });
      throw error;
    }
    this.removed.push(input);
  }

  async ensureReadyLocalAgentRunner(options: {
    agentId: string;
    modelId: string;
    placement: LocalPlacementRequirement;
  }) {
    this.ensuredRunners.push(options);
    return 1;
  }

  async noteAgentPlacement(agentId: string, computerId: string) {
    this.notedPlacements.push([agentId, computerId]);
  }

  async finalizeDeletedLocalAgentRunner(agentId: string) {
    this.finalizedDeletedAgentIds.push(agentId);
  }

  requireLocalPlacement(
    requirement: LocalPlacementRequirement,
    _modelId: string,
  ) {
    if (this.offline) throw new LocalComputerOfflineError();
    this.placements.push(requirement);
    return { id: "codex-default", label: "Codex default" };
  }
}
