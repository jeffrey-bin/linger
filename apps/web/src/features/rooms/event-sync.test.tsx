import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubDocumentsQueryKey } from "@/features/teamhub/document-queries";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubRoomEvent } from "@/features/teamhub/teamhub-types";

import { applyTeamHubEventSignal, TeamHubEventSync } from "./event-sync";
import { artifactPreviewCache } from "./files/artifact-preview-cache";
import {
  roomMembersQueryKey,
  roomQueryKey,
  tenantAgentAvailabilityQueryKey,
  tenantRoomActivityQueryKey,
  tenantRoomsQueryKey,
} from "./room-queries";

describe("TeamHub event signals", () => {
  it("refreshes only the named Tenant's Room list for a Room hint", async () => {
    const queryClient = new QueryClient();
    const tenantA = observe(queryClient, tenantRoomsQueryKey("tenant-a"));
    const tenantB = observe(queryClient, tenantRoomsQueryKey("tenant-b"));
    await vi.waitFor(() => expect(tenantA.fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(tenantB.fetch).toHaveBeenCalledOnce());

    await applyTeamHubEventSignal(queryClient, {
      hint: {
        id: "room-1",
        resource: "room",
        room_seq: 4,
        tenant_id: "tenant-a",
      },
      type: "resource.invalidated",
    });

    await vi.waitFor(() => expect(tenantA.fetch).toHaveBeenCalledTimes(2));
    expect(tenantB.fetch).toHaveBeenCalledOnce();
    tenantA.stop();
    tenantB.stop();
  });

  it("rereads a displayed Room named by a Room hint", async () => {
    const queryClient = new QueryClient();
    const room = observe(queryClient, roomQueryKey("tenant-a", "room-1"));
    const other = observe(queryClient, roomQueryKey("tenant-a", "room-2"));
    await vi.waitFor(() => expect(room.fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(other.fetch).toHaveBeenCalledOnce());

    await applyTeamHubEventSignal(queryClient, {
      hint: { id: "room-1", resource: "room", tenant_id: "tenant-a" },
      type: "resource.invalidated",
    });

    await vi.waitFor(() => expect(room.fetch).toHaveBeenCalledTimes(2));
    expect(other.fetch).toHaveBeenCalledOnce();
    room.stop();
    other.stop();
  });

  it("marks an unmounted Room list stale until it mounts", async () => {
    const queryClient = new QueryClient();
    const queryKey = tenantRoomsQueryKey("tenant-a");
    const fetch = vi.fn().mockResolvedValue({ items: [] });
    queryClient.setQueryData(queryKey, { items: [] });

    await applyTeamHubEventSignal(queryClient, {
      event: roomEvent("room.updated"),
      type: "room.event",
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    const stop = new QueryObserver(queryClient, {
      queryFn: fetch,
      queryKey,
    }).subscribe(() => undefined);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    stop();
  });

  it("refreshes only Room activity when a displayed Room commits a message", async () => {
    const queryClient = new QueryClient();
    const activity = observe(
      queryClient,
      tenantRoomActivityQueryKey("tenant-a"),
    );
    const availability = observe(
      queryClient,
      tenantAgentAvailabilityQueryKey("tenant-a"),
    );
    await vi.waitFor(() => expect(activity.fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(availability.fetch).toHaveBeenCalledOnce());

    await applyTeamHubEventSignal(queryClient, {
      event: roomEvent("message.created"),
      type: "room.event",
    });

    await vi.waitFor(() => expect(activity.fetch).toHaveBeenCalledTimes(2));
    // A message does not move Tenant availability.
    expect(availability.fetch).toHaveBeenCalledOnce();
    activity.stop();
    availability.stop();
  });

  it("refreshes Room activity and availability for an agents hint", async () => {
    const queryClient = new QueryClient();
    const activity = observe(
      queryClient,
      tenantRoomActivityQueryKey("tenant-a"),
    );
    const availability = observe(
      queryClient,
      tenantAgentAvailabilityQueryKey("tenant-a"),
    );
    const otherTenant = observe(
      queryClient,
      tenantRoomActivityQueryKey("tenant-b"),
    );
    await vi.waitFor(() => expect(activity.fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(availability.fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(otherTenant.fetch).toHaveBeenCalledOnce());

    await applyTeamHubEventSignal(queryClient, {
      hint: { id: "tenant-a", resource: "agents", tenant_id: "tenant-a" },
      type: "resource.invalidated",
    });

    await vi.waitFor(() => expect(activity.fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(availability.fetch).toHaveBeenCalledTimes(2));
    expect(otherTenant.fetch).toHaveBeenCalledOnce();
    for (const observer of [activity, availability, otherTenant])
      observer.stop();
  });

  it("refreshes the directory, the Room members and the Room list it shows", async () => {
    const queryClient = new QueryClient();
    const members = observe(
      queryClient,
      roomMembersQueryKey("tenant-a", "room-1"),
    );
    const rooms = observe(queryClient, tenantRoomsQueryKey("tenant-a"));
    const availability = observe(
      queryClient,
      tenantAgentAvailabilityQueryKey("tenant-a"),
    );
    await vi.waitFor(() => expect(members.fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(rooms.fetch).toHaveBeenCalledOnce());

    await applyTeamHubEventSignal(queryClient, {
      hint: { id: "tenant-a", resource: "directory", tenant_id: "tenant-a" },
      type: "resource.invalidated",
    });

    await vi.waitFor(() => expect(members.fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(availability.fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(rooms.fetch).toHaveBeenCalledTimes(2));
    members.stop();
    availability.stop();
    rooms.stop();
  });

  it("drops retained preview bytes only when Document access may change", async () => {
    const load = vi.fn(async () => ({
      blob: new Blob(["preview"]),
      mediaType: "text/plain",
      readingPosition: {},
    }));
    const read = () =>
      artifactPreviewCache.get(
        "access-test",
        new AbortController().signal,
        load,
      );
    await read();
    const queryClient = new QueryClient();

    await applyTeamHubEventSignal(queryClient, {
      hint: { id: "document-a", resource: "document", tenant_id: "tenant-a" },
      type: "resource.invalidated",
    });
    await read();
    expect(load).toHaveBeenCalledOnce();

    await applyTeamHubEventSignal(queryClient, {
      hint: {
        id: "document-a",
        resource: "document-access",
        tenant_id: "tenant-a",
      },
      type: "resource.invalidated",
    });
    await read();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("refreshes the named Document", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    await applyTeamHubEventSignal(queryClient, {
      hint: { id: "document-a", resource: "document", tenant_id: "tenant-a" },
      type: "resource.invalidated",
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: teamHubDocumentsQueryKey,
      refetchType: "none",
    });
    const predicate = invalidateQueries.mock.calls
      .map((call) => call[0]?.predicate)
      .find((candidate) => typeof candidate === "function");
    expect(
      predicate?.({
        queryKey: ["teamhub", "tenant-a", "document", "document-a"],
      } as never),
    ).toBe(true);
    expect(
      predicate?.({
        queryKey: ["teamhub", "tenant-a", "document", "document-b"],
      } as never),
    ).toBe(false);
  });

  it("refreshes every displayed TeamHub query once on resync", async () => {
    const queryClient = new QueryClient();
    const rooms = observe(queryClient, tenantRoomsQueryKey("tenant-a"));
    const documents = observe(queryClient, teamHubDocumentsQueryKey);
    queryClient.setQueryData(["teamhub", "tenant-a", "hidden"], 1);
    await vi.waitFor(() => expect(documents.fetch).toHaveBeenCalledOnce());

    await applyTeamHubEventSignal(queryClient, { type: "stream.resync" });

    await vi.waitFor(() => expect(rooms.fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(documents.fetch).toHaveBeenCalledTimes(2));
    expect(
      queryClient.getQueryState(["teamhub", "tenant-a", "hidden"])
        ?.isInvalidated,
    ).toBe(true);
    rooms.stop();
    documents.stop();
  });
});

describe("TeamHub event sync lifecycle", () => {
  it("subscribes once across unrelated rerenders and cleans up once", () => {
    const fixture = createTestTeamHubRuntime();
    const unsubscribe = vi.fn();
    const subscribeSignals = vi.fn(() => unsubscribe);
    const runtime = {
      ...fixture,
      events: { ...fixture.events, subscribeSignals },
    };
    const queryClient = new QueryClient();
    const tree = (label: string) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <TeamHubEventSync />
          <p>{label}</p>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const view = render(tree("first"));

    view.rerender(tree("second"));
    expect(subscribeSignals).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

function observe(queryClient: QueryClient, queryKey: readonly unknown[]) {
  const fetch = vi.fn().mockResolvedValue({ items: [] });
  const stop = new QueryObserver(queryClient, {
    queryFn: fetch,
    queryKey,
    staleTime: Number.POSITIVE_INFINITY,
  }).subscribe(() => undefined);
  return { fetch, stop };
}

// Signal routing reads only the envelope, so the payload stays minimal.
function roomEvent(eventType: TeamHubRoomEvent["event_type"]) {
  return {
    event_id: `event-${eventType}`,
    event_type: eventType,
    occurred_at: "2026-11-03T10:00:00Z",
    payload: { kind: eventType },
    room_id: "room-1",
    room_seq: 4,
    tenant_id: "tenant-a",
  } as TeamHubRoomEvent;
}
