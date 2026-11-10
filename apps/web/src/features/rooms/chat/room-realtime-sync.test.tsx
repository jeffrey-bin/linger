import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import { roomQueryKey, tenantRoomsQueryKey } from "../room-queries";
import { RoomRealtimeSync } from "./room-realtime-sync";

describe("Room realtime sync", () => {
  it("reports a sequence only after the Room projection applies it", async () => {
    const fixture = createTestTeamHubRuntime();
    const onAppliedRoomSeq = vi.fn();
    const runtime = {
      ...fixture,
      events: {
        ...fixture.events,
        subscribeRoom(
          input: Parameters<typeof fixture.events.subscribeRoom>[0],
        ) {
          void input.applyEvent({
            event_id: "event-1",
            event_type: "room.history.compacted",
            occurred_at: "2026-07-24T10:00:00Z",
            payload: {
              kind: "room.history.compacted",
              removed_event_type: "legacy.event",
            },
            room_id: "room-1",
            room_seq: 1,
            tenant_id: "tenant-1",
          });
          return () => undefined;
        },
      },
    };
    const queryClient = new QueryClient();
    const router = createMemoryRouter(
      [
        {
          element: (
            <RoomRealtimeSync
              onAppliedRoomSeq={onAppliedRoomSeq}
              roomId="room-1"
              tenantId="tenant-1"
            />
          ),
          path: "/",
        },
      ],
      { initialEntries: ["/"] },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <RouterProvider router={router} />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(onAppliedRoomSeq).toHaveBeenCalledWith(1));
  });

  it("leaves a Room whose invalidation reread finds it inaccessible", async () => {
    const fixture = createTestTeamHubRuntime();
    const getRoom = vi.fn<TestRouteHandler>(() =>
      teamHubErrorResponse(404, "ROOM_NOT_FOUND", "Room is unavailable."),
    );
    fixture.server.on("GET", "/v0/rooms/{roomId}", getRoom);
    const runtime = {
      ...fixture,
      events: {
        ...fixture.events,
        subscribeRoom(
          input: Parameters<typeof fixture.events.subscribeRoom>[0],
        ) {
          input.onRoomInvalidated();
          return () => undefined;
        },
      },
    };
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantRoomsQueryKey("tenant-1"), {
      items: [{ id: "room-1" }, { id: "room-2" }],
      page: { has_more: false },
    });
    queryClient.setQueryData(roomQueryKey("tenant-1", "room-1"), {
      id: "room-1",
    });
    const router = createMemoryRouter(
      [
        {
          element: <RoomRealtimeSync roomId="room-1" tenantId="tenant-1" />,
          path: "/t/:tenantId/rooms/:roomId/chat",
        },
        {
          element: <p>Room list</p>,
          path: "/t/:tenantId/rooms",
        },
      ],
      { initialEntries: ["/t/tenant-1/rooms/room-1/chat"] },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <RouterProvider router={router} />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Room list")).toBeVisible();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/t/tenant-1/rooms"),
    );
    expect(getRoom).toHaveBeenCalledWith(
      expect.objectContaining({ params: { roomId: "room-1" } }),
    );
    expect(queryClient.getQueryData(roomQueryKey("tenant-1", "room-1"))).toBe(
      undefined,
    );
    expect(
      queryClient.getQueryData<{ items: Array<{ id: string }> }>(
        tenantRoomsQueryKey("tenant-1"),
      )?.items,
    ).toEqual([{ id: "room-2" }]);
  });

  it("keeps a Room when a stale removal event arrives after readmission", async () => {
    const getRoom = vi.fn<TestRouteHandler>(() => ({
      id: "room-1",
      tenant_id: "tenant-1",
    }));
    const { onAppliedRoomSeq, queryClient, router } =
      renderCurrentMemberRemoval(getRoom);

    await waitFor(() => expect(onAppliedRoomSeq).toHaveBeenCalledWith(1));
    expect(getRoom).toHaveBeenCalledWith(
      expect.objectContaining({ params: { roomId: "room-1" } }),
    );
    expect(router.state.location.pathname).toBe(
      "/t/tenant-1/rooms/room-1/chat",
    );
    expect(
      queryClient.getQueryData(roomQueryKey("tenant-1", "room-1")),
    ).toMatchObject({ id: "room-1" });
  });

  it("leaves a Room when removal revalidation confirms it is inaccessible", async () => {
    const getRoom = vi.fn<TestRouteHandler>(() =>
      teamHubErrorResponse(404, "ROOM_NOT_FOUND", "Room is unavailable."),
    );
    const { queryClient, router } = renderCurrentMemberRemoval(getRoom);

    expect(await screen.findByText("Room list")).toBeVisible();
    expect(router.state.location.pathname).toBe("/t/tenant-1/rooms");
    expect(queryClient.getQueryData(roomQueryKey("tenant-1", "room-1"))).toBe(
      undefined,
    );
  });

  it("hands new Messages to the latest callback without resubscribing", async () => {
    const fixture = createTestTeamHubRuntime();
    let applyEvent:
      | Parameters<typeof fixture.events.subscribeRoom>[0]["applyEvent"]
      | undefined;
    const subscribe = vi.fn(
      (input: Parameters<typeof fixture.events.subscribeRoom>[0]) => {
        applyEvent = input.applyEvent;
        return () => undefined;
      },
    );
    const runtime = {
      ...fixture,
      events: { ...fixture.events, subscribeRoom: subscribe },
    };
    const queryClient = new QueryClient();
    const first = vi.fn();
    const latest = vi.fn();
    const sync = (onMessageCreated: (message: TeamHubMessage) => void) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomRealtimeSync
              onMessageCreated={onMessageCreated}
              roomId="room-1"
              tenantId="tenant-1"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );

    const view = render(sync(first));
    view.rerender(sync(latest));
    await applyEvent!({
      event_id: "event-1",
      event_type: "message.created",
      occurred_at: "2026-10-17T10:00:00Z",
      payload: {
        kind: "message.created",
        message: {
          author: {
            display_name: "Codex",
            id: "agent-1",
            kind: "agent",
            tenant_id: "tenant-1",
          },
          attachments: [],
          created_at: "2026-10-17T10:00:00Z",
          id: "message-1",
          message_kind: "conversation",
          raw_message: "Email to Lisa",
          room_id: "room-1",
          segments: [
            {
              content: "Email to Lisa",
              document_id: "document-canvas",
              presentation: "canvas",
              type: "document",
            },
          ],
          tenant_id: "tenant-1",
        },
      },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    });

    expect(subscribe).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "message-1" }),
    );
  });
});

describe("RoomRealtimeSync team.md", () => {
  it("announces a published team.md to the latest callback", async () => {
    const fixture = createTestTeamHubRuntime();
    let applyEvent:
      | Parameters<typeof fixture.events.subscribeRoom>[0]["applyEvent"]
      | undefined;
    const runtime = {
      ...fixture,
      events: {
        ...fixture.events,
        subscribeRoom(
          input: Parameters<typeof fixture.events.subscribeRoom>[0],
        ) {
          applyEvent = input.applyEvent;
          return () => undefined;
        },
      },
    };
    const queryClient = new QueryClient();
    const first = vi.fn();
    const latest = vi.fn();
    const sync = (onTeamMdPublished: () => void) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomRealtimeSync
              onTeamMdPublished={onTeamMdPublished}
              roomId="room-1"
              tenantId="tenant-1"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );

    const view = render(sync(first));
    view.rerender(sync(latest));
    await applyEvent!({
      event_id: "event-1",
      event_type: "team_md.published",
      occurred_at: "2026-11-04T10:00:00Z",
      payload: { kind: "team_md.published", revision: 2 },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    });

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });
});

function renderCurrentMemberRemoval(getRoom: TestRouteHandler) {
  const fixture = createTestTeamHubRuntime();
  fixture.server.on("GET", "/v0/rooms/{roomId}", getRoom);
  const onAppliedRoomSeq = vi.fn();
  const runtime = {
    ...fixture,
    events: {
      ...fixture.events,
      subscribeRoom(input: Parameters<typeof fixture.events.subscribeRoom>[0]) {
        void input.applyEvent(currentMemberRemovedEvent());
        return () => undefined;
      },
    },
  };
  const queryClient = new QueryClient();
  queryClient.setQueryData(tenantRoomsQueryKey("tenant-1"), {
    items: [{ id: "room-1" }],
    page: { has_more: false },
  });
  queryClient.setQueryData(roomQueryKey("tenant-1", "room-1"), {
    id: "room-1",
    tenant_id: "tenant-1",
  });
  const router = createMemoryRouter(
    [
      {
        element: (
          <RoomRealtimeSync
            currentActorId="actor-current"
            onAppliedRoomSeq={onAppliedRoomSeq}
            roomId="room-1"
            tenantId="tenant-1"
          />
        ),
        path: "/t/:tenantId/rooms/:roomId/chat",
      },
      {
        element: <p>Room list</p>,
        path: "/t/:tenantId/rooms",
      },
    ],
    { initialEntries: ["/t/tenant-1/rooms/room-1/chat"] },
  );

  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { onAppliedRoomSeq, queryClient, router };
}

function currentMemberRemovedEvent() {
  return {
    event_id: "event-old-membership-removed",
    event_type: "room.member.removed" as const,
    occurred_at: "2026-07-31T10:00:00Z",
    payload: {
      kind: "room.member.removed" as const,
      member: {
        actor: {
          display_name: "Current Human",
          id: "actor-current",
          kind: "human" as const,
          tenant_id: "tenant-1",
        },
        added_by: {
          display_name: "Owner",
          id: "actor-owner",
          kind: "human" as const,
          tenant_id: "tenant-1",
        },
        joined_at: "2026-07-31T09:00:00Z",
        role: "member" as const,
        room_id: "room-1",
        updated_at: "2026-07-31T09:30:00Z",
      },
    },
    room_id: "room-1",
    room_seq: 1,
    tenant_id: "tenant-1",
  };
}
