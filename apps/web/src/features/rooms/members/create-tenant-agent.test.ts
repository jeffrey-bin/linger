import { describe, expect, it, vi } from "vitest";

import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import { TeamHubTestServer } from "@/test/teamhub-test-server";

import { createTenantAgent } from "./create-tenant-agent";

describe("createTenantAgent", () => {
  it("maps Product Client Agent input to the TeamHub command", async () => {
    const createTenantAgentCall = vi.fn(() => ({
      actor: {
        created_at: "2026-07-24T10:00:00Z",
        display_name: "Mirror Reviewer",
        handle: "@actor-agent-1",
        id: "actor-agent-1",
        kind: "agent",
        tenant_id: "tenant-a",
      },
    }));
    const server = new TeamHubTestServer().on(
      "POST",
      "/v0/tenants/{tenantId}/agents",
      createTenantAgentCall,
    );
    const client = createHttpTeamHubClient({
      fetchRequest: server.fetch,
      onAuthenticationRequired: () => undefined,
    });
    await expect(
      createTenantAgent(client, {
        agentType: "general",
        description: "Reviews every release boundary.",
        instructions: " Review the Room conversation. ",
        model: " gpt-5.6-luna ",
        name: " Mirror Reviewer ",
        reasoningEffort: "xhigh",
        skillBindings: [
          {
            manifest_version: "2.0.0",
            name: "Research brief",
            skill_id: "research-brief",
          },
        ],
        tenantId: "tenant-a",
        visibilityScope: "sponsor",
      }),
    ).resolves.toMatchObject({ id: "actor-agent-1" });
    expect(createTenantAgentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { tenantId: "tenant-a" },
        body: {
          agent_type: "general",
          description: "Reviews every release boundary.",
          instructions: "Review the Room conversation.",
          name: "Mirror Reviewer",
          runtime: {
            model: "gpt-5.6-luna",
            reasoning_effort: "xhigh",
          },
          skill_bindings: [
            {
              manifest_version: "2.0.0",
              name: "Research brief",
              skill_id: "research-brief",
            },
          ],
          visibility_scope: "sponsor",
        },
      }),
    );
    const [request] = server.requestsTo(
      "POST",
      "/v0/tenants/{tenantId}/agents",
    );
    expect(request?.headers.get("Idempotency-Key")).toBeNull();

    await createTenantAgent(client, {
      agentType: "general",
      instructions: "Review locally.",
      model: "gpt-5.6-luna",
      name: "Local Reviewer",
      placement: {
        computerId: "computer-alice",
        runtimeType: "claude",
        type: "local",
        workspaceGrantId: "grant-workspace",
      },
      tenantId: "tenant-a",
      skillBindings: [],
      visibilityScope: "workspace",
    });
    expect(createTenantAgentCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: { tenantId: "tenant-a" },
        body: {
          agent_type: "general",
          instructions: "Review locally.",
          name: "Local Reviewer",
          runtime: {
            model: "gpt-5.6-luna",
            placement: {
              computer_id: "computer-alice",
              runtime_type: "claude",
              type: "local",
              workspace_grant_id: "grant-workspace",
            },
          },
          skill_bindings: [],
          visibility_scope: "workspace",
        },
      }),
    );
  });
});
