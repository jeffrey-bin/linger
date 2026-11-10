import { describe, expect, it } from "vitest";

import type { TeamHubTenantAgentAvailabilitySnapshot } from "@/features/teamhub/teamhub-types";

import { projectAgentAvailabilitySnapshots } from "./agent-availability";

describe("Agent availability", () => {
  it("projects TeamHub's authoritative availability snapshot", () => {
    const snapshots: TeamHubTenantAgentAvailabilitySnapshot[] = [
      {
        actor_id: "actor-agent",
        availability: {
          active_task_count: 2,
          status: "error",
          label: "Needs attention",
          current_activity: {
            summary: "Claude Code authentication is required",
          },
        },
        local_runtime_status: {
          computer_id: "computer-local",
          computer_status: "online",
          display_name: "Alice's Mac",
          error_code: "RUNTIME_AUTHENTICATION_REQUIRED",
          runtime_type: "claude",
          status: "authentication_required",
        },
      },
    ];

    expect(projectAgentAvailabilitySnapshots(snapshots)).toEqual(
      new Map([
        [
          "actor-agent",
          {
            activeTaskCount: 2,
            available: false,
            currentActivity: {
              summary: "Claude Code authentication is required",
            },
            label: "Needs attention",
            localRuntimeStatus: snapshots[0]!.local_runtime_status,
            status: "error",
          },
        ],
      ]),
    );
  });
});
