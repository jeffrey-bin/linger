import { describe, expect, it } from "vitest";

import type {
  TeamHubTenantAgent,
  TeamHubTenantAgentAvailabilitySnapshot,
} from "@/features/teamhub/teamhub-types";

import { eligibleRoomAgents } from "./agent-admission";

function registration(
  actorId: string,
  sponsorActorId: string,
  visibilityScope: TeamHubTenantAgent["visibility_scope"] = "workspace",
): TeamHubTenantAgent {
  return {
    agent_type: "general",
    actor: {
      created_at: "2026-07-29T00:00:00Z",
      display_name: actorId,
      id: actorId,
      kind: "agent",
      tenant_id: "tenant-1",
    },
    agent_management_id: `management-${actorId}`,
    configuration_revision: 1,
    created_at: "2026-07-29T00:00:00Z",
    created_by: {
      display_name: sponsorActorId,
      id: sponsorActorId,
      kind: "human",
      tenant_id: "tenant-1",
    },
    description: "",
    instructions: "Help the Room.",
    runtime: { model: "openai/gpt-5.4" },
    skill_bindings: [],
    updated_at: "2026-07-29T00:00:00Z",
    visibility_scope: visibilityScope,
  };
}

describe("eligibleRoomAgents", () => {
  it("returns Workspace Agents and the caller's private Agents", () => {
    const eligible = registration("actor-eligible", "actor-me");

    expect(
      eligibleRoomAgents({
        availabilitySnapshots: [],
        agents: [
          eligible,
          registration("actor-in-room", "actor-me"),
          registration("actor-workspace", "actor-someone-else"),
          registration("actor-private", "actor-someone-else", "sponsor"),
          registration("actor-mine", "actor-me", "sponsor"),
        ],
        roomMemberIds: new Set(["actor-in-room"]),
        sponsorActorId: "actor-me",
      }),
    ).toEqual([
      eligible.actor,
      expect.objectContaining({ id: "actor-workspace" }),
      expect.objectContaining({ id: "actor-mine" }),
    ]);
  });

  it("excludes an unavailable Local Agent from Add member candidates", () => {
    const local = registration("agent-local", "actor-me");
    local.runtime = {
      model: "claude-default",
      placement: {
        type: "local",
        computer_id: "computer-local",
        runtime_type: "claude",
        workspace_grant_id: "grant-local",
      },
    };
    const availability: TeamHubTenantAgentAvailabilitySnapshot = {
      actor_id: local.actor.id,
      availability: {
        active_task_count: 0,
        label: "Needs attention",
        status: "error",
      },
      local_runtime_status: {
        computer_id: "computer-local",
        computer_status: "online",
        display_name: "Local Mac",
        runtime_type: "claude",
        status: "authentication_required",
        error_code: "RUNTIME_AUTHENTICATION_REQUIRED",
        message: "Claude Code authentication is required",
      },
    };

    expect(
      eligibleRoomAgents({
        agents: [local],
        availabilitySnapshots: [availability],
        roomMemberIds: new Set(),
        sponsorActorId: "actor-me",
      }),
    ).toEqual([]);
  });
});
