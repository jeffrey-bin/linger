import { describe, expect, it } from "vitest";

import type { TeamHubWorkItem } from "@/features/teamhub/teamhub-types";

import {
  createWorkItemRoomFilterModel,
  NO_SOURCE_ROOM_FILTER,
} from "./work-item-room-filter";

describe("Work Item Room filter model", () => {
  it("builds stable options from every Work Item origin", () => {
    const items = [
      workItem("visible", "room-all"),
      workItem("private-b", "room-private-b"),
      workItem("private-a", "room-private-a"),
      workItem("no-source"),
      workItem("private-a-duplicate", "room-private-a"),
    ];

    const model = createWorkItemRoomFilterModel(
      [{ id: "room-all", name: "all" }],
      items,
    );

    expect(model.options).toEqual([
      { id: "room-all", label: "#all" },
      {
        id: "room-private-a",
        label: "Unknown room (room-private-a)",
      },
      {
        id: "room-private-b",
        label: "Unknown room (room-private-b)",
      },
      { id: NO_SOURCE_ROOM_FILTER, label: "No source room" },
    ]);
  });

  it("uses the same authority for filtering and card labels", () => {
    const visible = workItem("visible", "room-all");
    const hidden = workItem("private", "room-private");
    const withoutSource = workItem("no-source");
    const model = createWorkItemRoomFilterModel(
      [{ id: "room-all", name: "all" }],
      [visible, hidden, withoutSource],
    );

    expect(model.matches(visible, "room-all")).toBe(true);
    expect(model.matches(hidden, "room-all")).toBe(false);
    expect(model.matches(withoutSource, NO_SOURCE_ROOM_FILTER)).toBe(true);
    expect(model.originLabel(visible)).toBe("#all");
    expect(model.originLabel(hidden)).toBe("Unknown room (room-private)");
    expect(model.originLabel(withoutSource)).toBe("No source room");
  });
});

function workItem(id: string, originRoomId?: string): TeamHubWorkItem {
  const actor = {
    display_name: "Alice",
    id: "actor-alice",
    kind: "human" as const,
    tenant_id: "tenant-1",
  };
  return {
    assignees: [],
    created_at: "2026-07-30T00:00:00Z",
    created_by: actor,
    description: "Test Work Item",
    explicit_access_grants: [],
    id,
    kind: "issue",
    number: 1,
    ...(originRoomId ? { origin_room_id: originRoomId } : {}),
    priority: "medium",
    referenced_actors: [],
    state: "open",
    tenant_id: "tenant-1",
    title: id,
    updated_at: "2026-07-30T00:00:00Z",
    updated_by: actor,
    version: 1,
  };
}
