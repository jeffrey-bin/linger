import { describe, expect, it, vi } from "vitest";

import {
  getPersonalKnowledgeGraphVisualization,
  PersonalKnowledgeGraphNotFoundError,
  type PersonalKnowledgeGraphVisualizationDependencies,
} from "../../src/memory/graph-visualization.js";

describe("personal knowledge graph visualization", () => {
  it("builds the current tenant's graph from the indexed published Wiki", async () => {
    const dependencies = dependencyMocks();
    dependencies.loadSubjects.mockResolvedValue([
      {
        agentManagementId: "agent_other",
        memorySubjectKey: "agent_other",
        representedHumanActorId: "actor_alice",
        tenantId: "tenant_other",
      },
      {
        agentManagementId: "agent_acme",
        memorySubjectKey: "agent_acme",
        representedHumanActorId: "actor_alice",
        tenantId: "tenant_acme",
      },
    ]);
    dependencies.readWiki.mockResolvedValue({
      revision: "wiki-r1",
      pages: [
        {
          key: "projects/atlas.md",
          title: "Atlas",
          content: "# Atlas\n\n[Kickoff](../sessions/2026-09-01/a.md)",
          metadata: {},
        },
        {
          key: "sessions/2026-09-01/a.md",
          title: "Kickoff",
          content: "# Kickoff",
          metadata: {},
        },
      ],
    });
    dependencies.renderGraph.mockReturnValue("<html>graph</html>");
    dependencies.readEvents.mockResolvedValue([
      { id: "event-1", day: "2026-09-01", title: "Kickoff" },
    ]);

    await expect(
      getPersonalKnowledgeGraphVisualization(
        { owner_actor_id: "actor_alice", tenant_id: "tenant_acme" },
        dependencies,
      ),
    ).resolves.toBe("<html>graph</html>");
    expect(dependencies.loadSubjects).toHaveBeenCalledWith("actor_alice");
    expect(dependencies.readWiki).toHaveBeenCalledWith(
      "tenant_acme",
      "actor_alice",
    );
    expect(dependencies.readEvents).toHaveBeenCalledWith(
      "tenant_acme",
      "actor_alice",
      "agent_acme",
    );
    expect(dependencies.renderGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        wikiRevision: "wiki-r1",
        edges: [{ source: "projects/atlas", target: "sessions/2026-09-01/a" }],
      }),
      {
        embedded: true,
        events: [{ id: "event-1", day: "2026-09-01", title: "Kickoff" }],
      },
    );
  });

  it("fails closed without an Another Me in the tenant or an indexed Wiki", async () => {
    const dependencies = dependencyMocks();
    dependencies.loadSubjects.mockResolvedValue([
      {
        agentManagementId: "agent_other",
        memorySubjectKey: "agent_other",
        representedHumanActorId: "actor_alice",
        tenantId: "tenant_other",
      },
    ]);
    await expect(
      getPersonalKnowledgeGraphVisualization(
        { owner_actor_id: "actor_alice", tenant_id: "tenant_acme" },
        dependencies,
      ),
    ).rejects.toBeInstanceOf(PersonalKnowledgeGraphNotFoundError);
    expect(dependencies.readWiki).not.toHaveBeenCalled();

    dependencies.readWiki.mockResolvedValue({ pages: [] });
    await expect(
      getPersonalKnowledgeGraphVisualization(
        { owner_actor_id: "actor_alice", tenant_id: "tenant_other" },
        dependencies,
      ),
    ).rejects.toBeInstanceOf(PersonalKnowledgeGraphNotFoundError);
  });
});

function dependencyMocks() {
  return {
    loadSubjects: vi.fn(),
    readWiki: vi.fn(),
    readEvents: vi.fn(),
    renderGraph: vi.fn(),
  } as unknown as PersonalKnowledgeGraphVisualizationDependencies & {
    loadSubjects: ReturnType<typeof vi.fn>;
    readWiki: ReturnType<typeof vi.fn>;
    readEvents: ReturnType<typeof vi.fn>;
    renderGraph: ReturnType<typeof vi.fn>;
  };
}
