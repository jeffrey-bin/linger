import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
} from "@/test/teamhub-test-server";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import {
  createHttpTeamHubClient,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubRoomPage } from "@/features/teamhub/teamhub-types";

import { tenantRoomsQueryKey } from "../room-queries";
import { createRoomReadStateAdvancer } from "./room-read-state-advancer";
import { RoomReadStateSync } from "./room-read-state-sync";

describe("Room read-state advancement", () => {
  it("skips the Room list reload when the read covers the latest event", async () => {
    const fixture = createTestTeamHubRuntime();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const queryKey = tenantRoomsQueryKey("tenant-northstar");
    const initialRooms = await listRooms(fixture.client);
    const unreadRooms: TeamHubRoomPage = {
      ...initialRooms,
      items: initialRooms.items.map((room) =>
        room.id === "room-gtm-launch"
          ? {
              ...room,
              latest_room_seq: 1,
              read_through_room_seq: 0,
              unread_mention_count: 1,
              unread_message_count: 1,
            }
          : room,
      ),
    };
    const clearedRooms: TeamHubRoomPage = {
      ...unreadRooms,
      items: unreadRooms.items.map((room) =>
        room.id === "room-gtm-launch"
          ? {
              ...room,
              read_through_room_seq: 1,
              unread_mention_count: 0,
              unread_message_count: 0,
            }
          : room,
      ),
    };
    const refreshRoomList = vi.fn().mockResolvedValue(clearedRooms);
    queryClient.setQueryDefaults(queryKey, { queryFn: refreshRoomList });
    queryClient.setQueryData(queryKey, unreadRooms);
    const observer = new QueryObserver(queryClient, {
      queryFn: refreshRoomList,
      queryKey,
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const updateRoomReadState = vi.fn().mockResolvedValue(readState(1));
    routeReadState(fixture.server, updateRoomReadState);

    const view = render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={fixture}>
          <RoomReadStateSync
            roomId="room-gtm-launch"
            tenantId="tenant-northstar"
            throughRoomSeq={1}
          />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    await vi.waitFor(() => expect(updateRoomReadState).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        queryClient
          .getQueryData<TeamHubRoomPage>(queryKey)
          ?.items.find((room) => room.id === "room-gtm-launch"),
      ).toMatchObject({
        read_through_room_seq: 1,
        unread_mention_count: 0,
        unread_message_count: 0,
      }),
    );
    // The local patch is exact, so nothing is reloaded.
    expect(refreshRoomList).not.toHaveBeenCalled();

    view.unmount();
    unsubscribe();
  });

  it("projects a partial read cursor before the authoritative Room refresh settles", async () => {
    const fixture = createTestTeamHubRuntime();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const queryKey = tenantRoomsQueryKey("tenant-northstar");
    const initialRooms = await listRooms(fixture.client);
    const unreadRooms: TeamHubRoomPage = {
      ...initialRooms,
      items: initialRooms.items.map((room) =>
        room.id === "room-gtm-launch"
          ? {
              ...room,
              latest_room_seq: 6,
              read_through_room_seq: 4,
              unread_mention_count: 1,
              unread_message_count: 2,
            }
          : room,
      ),
    };
    const clearedRooms: TeamHubRoomPage = {
      ...unreadRooms,
      items: unreadRooms.items.map((room) =>
        room.id === "room-gtm-launch"
          ? {
              ...room,
              read_through_room_seq: 5,
              unread_mention_count: 0,
              unread_message_count: 1,
            }
          : room,
      ),
    };
    let releaseRefresh!: () => void;
    const refreshPending = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshRoomList = vi.fn(async () => {
      await refreshPending;
      return clearedRooms;
    });
    queryClient.setQueryDefaults(queryKey, { queryFn: refreshRoomList });
    queryClient.setQueryData(queryKey, unreadRooms);
    const observer = new QueryObserver(queryClient, {
      queryFn: refreshRoomList,
      queryKey,
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const updateRoomReadState = vi.fn().mockResolvedValue(readState(5));
    routeReadState(fixture.server, updateRoomReadState);

    const view = render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={fixture}>
          <RoomReadStateSync
            roomId="room-gtm-launch"
            tenantId="tenant-northstar"
            throughRoomSeq={5}
          />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    await vi.waitFor(() => expect(refreshRoomList).toHaveBeenCalledOnce());
    expect(
      queryClient
        .getQueryData<TeamHubRoomPage>(queryKey)
        ?.items.find((room) => room.id === "room-gtm-launch"),
    ).toMatchObject({
      // Only TeamHub can recount what remains after a partial read.
      read_through_room_seq: 5,
      unread_mention_count: 1,
      unread_message_count: 2,
    });

    releaseRefresh();
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(queryKey)).toEqual(clearedRooms),
    );
    view.unmount();
    unsubscribe();
  });

  it("keeps the read-state advancer stable when a stale Room projection rerenders the Chat", async () => {
    const fixture = createTestTeamHubRuntime();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const queryKey = tenantRoomsQueryKey("tenant-northstar");
    const initialRooms = await listRooms(fixture.client);
    const roomsAt = (readThroughRoomSeq: number): TeamHubRoomPage => ({
      ...initialRooms,
      items: initialRooms.items.map((room) =>
        room.id === "room-gtm-launch"
          ? {
              ...room,
              latest_room_seq: 2,
              read_through_room_seq: readThroughRoomSeq,
              unread_mention_count: readThroughRoomSeq < 2 ? 1 : 0,
              unread_message_count: readThroughRoomSeq < 2 ? 1 : 0,
            }
          : room,
      ),
    });
    queryClient.setQueryDefaults(queryKey, {
      queryFn: async () => queryClient.getQueryData(queryKey)!,
    });
    queryClient.setQueryData(queryKey, roomsAt(0));
    const updateRoomReadState = vi
      .fn()
      .mockImplementation(async (_roomId: string, roomSeq: number) =>
        readState(roomSeq),
      );
    routeReadState(fixture.server, updateRoomReadState);
    const sync = (throughRoomSeq: number) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={fixture}>
          <RoomReadStateSync
            roomId="room-gtm-launch"
            tenantId="tenant-northstar"
            throughRoomSeq={throughRoomSeq}
          />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );

    const view = render(sync(1));
    await vi.waitFor(() => expect(updateRoomReadState).toHaveBeenCalledOnce());

    queryClient.setQueryData(queryKey, roomsAt(1));
    view.rerender(sync(1));
    queryClient.setQueryData(queryKey, roomsAt(0));
    view.rerender(sync(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateRoomReadState.mock.calls).toEqual([["room-gtm-launch", 1]]);

    view.rerender(sync(2));
    await vi.waitFor(() =>
      expect(updateRoomReadState.mock.calls).toEqual([
        ["room-gtm-launch", 1],
        ["room-gtm-launch", 2],
      ]),
    );
  });

  it("keeps reporting newer Room sequences after a StrictMode remount", async () => {
    const fixture = createTestTeamHubRuntime();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const queryKey = tenantRoomsQueryKey("tenant-northstar");
    queryClient.setQueryData(queryKey, await listRooms(fixture.client));
    queryClient.setQueryDefaults(queryKey, {
      queryFn: async () => queryClient.getQueryData(queryKey)!,
    });
    const updateRoomReadState = vi
      .fn()
      .mockImplementation(async (_roomId: string, roomSeq: number) =>
        readState(roomSeq),
      );
    routeReadState(fixture.server, updateRoomReadState);
    const sync = (throughRoomSeq: number) => (
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <TeamHubRuntimeProvider runtime={fixture}>
            <RoomReadStateSync
              roomId="room-gtm-launch"
              tenantId="tenant-northstar"
              throughRoomSeq={throughRoomSeq}
            />
          </TeamHubRuntimeProvider>
        </QueryClientProvider>
      </StrictMode>
    );

    const view = render(sync(1));
    await vi.waitFor(() =>
      expect(updateRoomReadState).toHaveBeenCalledWith("room-gtm-launch", 1),
    );

    view.rerender(sync(2));
    await vi.waitFor(() =>
      expect(updateRoomReadState).toHaveBeenLastCalledWith(
        "room-gtm-launch",
        2,
      ),
    );
    view.unmount();
  });

  it("retries a failed read-state update without requiring a newer Room sequence", async () => {
    vi.useFakeTimers();
    try {
      const updateRoomReadState = vi
        .fn()
        .mockReturnValueOnce(teamHubErrorResponse(503, "TEAMHUB_UNAVAILABLE"))
        .mockImplementation(async (_roomId: string, roomSeq: number) =>
          readState(roomSeq),
        );
      const refreshRoomList = vi.fn();
      const advancer = createRoomReadStateAdvancer({
        client: readStateClient(updateRoomReadState),
        refreshRoomList,
        roomId: "room-1",
      });

      advancer.advance(5);
      await vi.waitFor(() =>
        expect(updateRoomReadState).toHaveBeenCalledOnce(),
      );
      await vi.advanceTimersByTimeAsync(1_000);

      expect(updateRoomReadState.mock.calls).toEqual([
        ["room-1", 5],
        ["room-1", 5],
      ]);
      expect(refreshRoomList).toHaveBeenCalledOnce();
      advancer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed Room-list refresh without resending acknowledged read state", async () => {
    vi.useFakeTimers();
    try {
      const updateRoomReadState = vi
        .fn()
        .mockImplementation(async (_roomId: string, roomSeq: number) =>
          readState(roomSeq),
        );
      const refreshRoomList = vi
        .fn()
        .mockRejectedValueOnce(new Error("Room list unavailable"))
        .mockResolvedValue(undefined);
      const advancer = createRoomReadStateAdvancer({
        client: readStateClient(updateRoomReadState),
        refreshRoomList,
        roomId: "room-1",
      });

      advancer.advance(5);
      await vi.waitFor(() => expect(refreshRoomList).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(1_000);

      expect(updateRoomReadState).toHaveBeenCalledOnce();
      expect(refreshRoomList).toHaveBeenCalledTimes(2);
      advancer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes updates and coalesces pending work to the highest applied sequence", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstUpdate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const updateRoomReadState = vi
      .fn()
      .mockImplementationOnce(async (_roomId: string, roomSeq: number) => {
        await firstUpdate;
        return readState(roomSeq);
      })
      .mockImplementation(async (_roomId: string, roomSeq: number) =>
        readState(roomSeq),
      );
    const refreshRoomList = vi.fn();
    const advancer = createRoomReadStateAdvancer({
      client: readStateClient(updateRoomReadState),
      refreshRoomList,
      roomId: "room-1",
    });

    advancer.advance(2);
    advancer.advance(3);
    advancer.advance(5);
    await vi.waitFor(() => expect(updateRoomReadState).toHaveBeenCalledOnce());
    releaseFirst?.();

    await vi.waitFor(() =>
      expect(updateRoomReadState.mock.calls).toEqual([
        ["room-1", 2],
        ["room-1", 5],
      ]),
    );
    expect(refreshRoomList).toHaveBeenCalledTimes(2);
  });

  it("never resends an acknowledged or older Room sequence", async () => {
    const updateRoomReadState = vi
      .fn()
      .mockImplementation(async (_roomId: string, roomSeq: number) =>
        readState(roomSeq),
      );
    const advancer = createRoomReadStateAdvancer({
      client: readStateClient(updateRoomReadState),
      initialReadThroughRoomSeq: 4,
      refreshRoomList: vi.fn(),
      roomId: "room-1",
    });

    advancer.advance(4);
    advancer.advance(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateRoomReadState).not.toHaveBeenCalled();

    advancer.advance(5);
    await vi.waitFor(() => expect(updateRoomReadState).toHaveBeenCalledOnce());
    advancer.advance(5);
    advancer.advance(3);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateRoomReadState).toHaveBeenCalledOnce();
  });
});

function readState(roomSeq: number) {
  return {
    read_through_room_seq: roomSeq,
    room_id: "room-1",
    updated_at: "2026-07-24T10:00:00Z",
  };
}

function listRooms(client: TeamHubClient) {
  return teamHubData(
    client.api.GET("/v0/tenants/{tenantId}/rooms", {
      params: { path: { tenantId: "tenant-northstar" } },
    }),
  );
}

/** Routes read-state writes to a stub that receives the Room and sequence. */
function routeReadState(
  server: TeamHubTestServer,
  updateRoomReadState: (roomId: string, roomSeq: number) => unknown,
) {
  server.on("PUT", "/v0/rooms/{roomId}/read-state", ({ body, params }) =>
    updateRoomReadState(
      params.roomId!,
      (body as { through_room_seq: number }).through_room_seq,
    ),
  );
}

function readStateClient(
  updateRoomReadState: (roomId: string, roomSeq: number) => unknown,
) {
  const server = new TeamHubTestServer();
  routeReadState(server, updateRoomReadState);
  return createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
}
