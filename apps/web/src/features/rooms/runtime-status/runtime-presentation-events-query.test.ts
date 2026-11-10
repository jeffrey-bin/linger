import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TestRouteHandler } from "@/test/teamhub-test-server";

import { roomRuntimePresentationEventsQueryOptions } from "./runtime-presentation-events-query";

describe("Runtime presentation event query", () => {
  it("keys the cache by Run Status identity without a wake revision", () => {
    const { client } = createTestTeamHubRuntime();

    const options = roomRuntimePresentationEventsQueryOptions(
      client,
      "tenant-1",
      "room-1",
      "run-status-1",
    );

    expect(options.queryKey).toEqual([
      "teamhub",
      "tenant-1",
      "room",
      "room-1",
      "run-statuses",
      "run-status-1",
      "runtime-presentation-events",
    ]);
  });

  it("recovers every published page using the last durable ordinal", async () => {
    const { client, server } = createTestTeamHubRuntime();
    const listRoomRuntimePresentationEvents = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce({
        has_more: true,
        items: [statusRecord("1"), statusRecord("2")],
        published_through_ordinal: "3",
      })
      .mockReturnValueOnce({
        has_more: false,
        items: [statusRecord("3")],
        published_through_ordinal: "3",
      });
    server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const result = await queryClient.fetchQuery(
      roomRuntimePresentationEventsQueryOptions(
        client,
        "tenant-1",
        "room-1",
        "run-status-1",
      ),
    );

    expect(
      listRoomRuntimePresentationEvents.mock.calls.map(([request]) => [
        request.params.roomId,
        request.params.runId,
        request.query.get("after"),
        Number(request.query.get("limit")),
      ]),
    ).toEqual([
      ["room-1", "run-status-1", "0", 200],
      ["room-1", "run-status-1", "2", 200],
    ]);
    expect(result.items.map((item) => item.event_ordinal)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("rejects a non-contiguous server projection", async () => {
    const { client, server } = createTestTeamHubRuntime();
    server.on("GET", EVENTS_PATH, () => ({
      has_more: false,
      items: [statusRecord("2")],
      published_through_ordinal: "2",
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(
      queryClient.fetchQuery(
        roomRuntimePresentationEventsQueryOptions(
          client,
          "tenant-1",
          "room-1",
          "run-status-1",
        ),
      ),
    ).rejects.toThrow("not contiguous");
  });
});

const EVENTS_PATH =
  "/v0/rooms/{roomId}/runs/{runId}/runtime-presentation-events";

function statusRecord(eventOrdinal: string) {
  return {
    event: { status: "working" as const, type: "status.changed" as const },
    event_ordinal: eventOrdinal,
    segment_id: "segment-1",
  };
}
