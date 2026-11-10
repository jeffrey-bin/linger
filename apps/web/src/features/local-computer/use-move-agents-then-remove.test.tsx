import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubTenantAgent } from "@/features/teamhub/teamhub-types";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";

import {
  type AgentMovePlan,
  moveAgent,
  useMoveAgentsThenRemove,
} from "./use-move-agents-then-remove";

const target = {
  computerId: "computer-new",
  model: "openai/gpt-5.4",
  reasoningEffort: "high" as const,
  runtimeType: "codex" as const,
  workspaceGrantId: "grant-new",
};

describe("moveAgent", () => {
  it("moves the Agent with one update, even to an offline Computer", async () => {
    const { client, updateTenantAgent } = fakeClient({
      updateTenantAgent: () => placed("actor-a"),
    });
    const result = await moveAgent(client, "tenant-northstar", {
      action: "move",
      agent: agent("actor-a"),
      target,
    });
    expect(result.runtime.placement?.computer_id).toBe("computer-new");
    expect(updateTenantAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { tenantId: "tenant-northstar", agentId: "actor-a" },
        body: {
          expected_configuration_revision: 3,
          runtime: {
            model: "openai/gpt-5.4",
            reasoning_effort: "high",
            placement: {
              computer_id: "computer-new",
              runtime_type: "codex",
              type: "local",
              workspace_grant_id: "grant-new",
            },
          },
        },
      }),
    );
  });

  it("leaves an Agent already on the target alone", async () => {
    const { client, updateTenantAgent } = fakeClient();
    const onTarget = placed("actor-a");
    const result = await moveAgent(client, "tenant-northstar", {
      action: "move",
      agent: onTarget,
      target,
    });
    expect(result).toBe(onTarget);
    expect(updateTenantAgent).not.toHaveBeenCalled();
  });
});

describe("useMoveAgentsThenRemove", () => {
  it("runs plans in order, stops at the first failure, and retries only unfinished Agents", async () => {
    const calls: string[] = [];
    let rejectB = true;
    const { client } = fakeClient({
      deleteTenantAgent: ({ params }) => {
        calls.push(`delete:${params.agentId}`);
      },
      updateTenantAgent: ({ params }) => {
        const actorId = params.agentId!;
        calls.push(`move:${actorId}`);
        if (actorId === "actor-b" && rejectB) {
          rejectB = false;
          return teamHubErrorResponse(
            409,
            "AGENT_RUN_ACTIVE",
            "Agent has an active Run",
          );
        }
        return placed(actorId);
      },
    });
    const { result } = renderHook(
      () => useMoveAgentsThenRemove({ client, tenantId: "tenant-northstar" }),
      { wrapper },
    );
    const plans: AgentMovePlan[] = [
      { action: "move", agent: agent("actor-a"), target },
      { action: "move", agent: agent("actor-b"), target },
      { action: "delete", agent: agent("actor-c") },
    ];

    let complete: boolean | undefined;
    await act(async () => {
      complete = await result.current.run(plans);
    });
    expect(complete).toBe(false);
    expect(calls).toEqual(["move:actor-a", "move:actor-b"]);
    expect(result.current.progress.get("actor-a")).toEqual({ state: "moved" });
    expect(result.current.progress.get("actor-b")).toEqual({
      state: "failed",
      message: "Agent has an active Run",
    });
    expect(result.current.progress.get("actor-c")).toBeUndefined();
    expect(result.current.failed).toBe(true);
    expect(result.current.running).toBe(false);

    await act(async () => {
      complete = await result.current.run(plans);
    });
    expect(complete).toBe(true);
    expect(calls).toEqual([
      "move:actor-a",
      "move:actor-b",
      "move:actor-b",
      "delete:actor-c",
    ]);
    expect(result.current.progress.get("actor-b")).toEqual({ state: "moved" });
    expect(result.current.progress.get("actor-c")).toEqual({
      state: "deleted",
    });
    expect(result.current.failed).toBe(false);
    expect(result.current.isFinished("actor-a")).toBe(true);
  });
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

function fakeClient(
  handlers: {
    deleteTenantAgent?: TestRouteHandler;
    updateTenantAgent?: TestRouteHandler;
  } = {},
) {
  const deleteTenantAgent = vi.fn(handlers.deleteTenantAgent ?? (() => {}));
  const updateTenantAgent = vi.fn(handlers.updateTenantAgent ?? (() => {}));
  const server = new TeamHubTestServer()
    .on("DELETE", "/v0/tenants/{tenantId}/agents/{agentId}", deleteTenantAgent)
    .on("PATCH", "/v0/tenants/{tenantId}/agents/{agentId}", updateTenantAgent);
  const client = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  return { client, deleteTenantAgent, updateTenantAgent };
}

function placed(actorId: string): TeamHubTenantAgent {
  const moved = agent(actorId);
  return {
    ...moved,
    configuration_revision: 4,
    runtime: {
      ...moved.runtime,
      placement: { ...moved.runtime.placement!, computer_id: "computer-new" },
    },
  };
}

function agent(actorId: string): TeamHubTenantAgent {
  const timestamp = "2026-10-01T09:00:00Z";
  return {
    actor: {
      created_at: timestamp,
      display_name: `Agent ${actorId}`,
      id: actorId,
      kind: "agent",
      tenant_id: "tenant-northstar",
    },
    agent_management_id: `management-${actorId}`,
    agent_type: "general",
    configuration_revision: 3,
    created_at: timestamp,
    created_by: {
      display_name: "Jenny Bin",
      id: "actor-jenny",
      kind: "human",
      tenant_id: "tenant-northstar",
    },
    description: "",
    instructions: "Work locally.",
    runtime: {
      model: "openai/gpt-5.4",
      placement: {
        computer_id: "computer-old",
        runtime_type: "codex",
        type: "local",
        workspace_grant_id: "grant-old",
      },
    },
    skill_bindings: [],
    updated_at: timestamp,
    visibility_scope: "sponsor",
  };
}
