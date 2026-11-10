import { describe, expect, it } from "vitest";
import type { TeamHubRunStatus } from "@/features/teamhub/teamhub-types";
import { visibleDirectPeerRunStatuses } from "./direct-peer-streaming";

describe("Direct Room streaming", () => {
  it("shows only the current peer while keeping group Room Run Statuses", () => {
    const runStatuses = ["actor-one", "actor-two"].map((id) => ({
      agent: { id, display_name: id, kind: "agent" as const },
      created_at: "2026-09-17T07:16:30Z",
      id: `run-status-${id}`,
      run_id: `run-status-${id}`,
      replied: false,
      revision: 1,
      room_id: "room-one",
      status: "active" as const,
      updated_at: "2026-09-17T07:16:30Z",
    })) satisfies TeamHubRunStatus[];
    expect(visibleDirectPeerRunStatuses(runStatuses, "actor-two")).toEqual([
      runStatuses[1],
    ]);
    expect(visibleDirectPeerRunStatuses(runStatuses)).toBe(runStatuses);
  });
});
