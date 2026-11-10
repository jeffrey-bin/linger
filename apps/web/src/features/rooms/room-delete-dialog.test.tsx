import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { describe, expect, it, vi } from "vitest";

import {
  acceptRoomUpdates,
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import {
  type TeamHubRuntime,
  TeamHubRuntimeProvider,
} from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubRoom,
  TeamHubRoomPage,
} from "@/features/teamhub/teamhub-types";

import { RoomDeleteDialog } from "./room-delete-dialog";
import { roomQueryKey, tenantRoomsQueryKey } from "./room-queries";

describe("Room deletion", () => {
  it("requires the exact Room name, clears Room caches, and leaves the route", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomUpdates(runtime);

    const room = await getRoom(runtime, "room-all");
    const rooms = await listRooms(runtime);
    const queryClient = new QueryClient();
    const roomKey = roomQueryKey("tenant-northstar", room.id);
    queryClient.setQueryData(roomKey, room);
    queryClient.setQueryData([...roomKey, "members"], { items: [] });
    queryClient.setQueryData(tenantRoomsQueryKey("tenant-northstar"), rooms);
    let finishNavigation!: () => void;
    const navigation = new Promise<void>((resolve) => {
      finishNavigation = resolve;
    });
    const removedWhileMounted: boolean[] = [];
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "removed") {
        removedWhileMounted.push(
          screen.queryByRole("dialog", { name: `Delete Room ${room.name}` }) !==
            null,
        );
      }
    });
    const { router } = renderDeleteDialog({
      queryClient,
      room,
      runtime,
      indexLoader: async () => {
        await navigation;
        return null;
      },
    });
    const confirm = screen.getByRole("button", { name: "Delete Room" });

    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Room name confirmation"), {
      target: { value: "All" },
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Room name confirmation"), {
      target: { value: room.name },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(router.state.navigation.state).toBe("loading"));
    try {
      // The current Room is still mounted while the destination loads. Its
      // last snapshot must survive so Suspense cannot re-fetch the deleted Room.
      expect(queryClient.getQueryData(roomKey)).toEqual(room);
    } finally {
      finishNavigation();
    }
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/t/tenant-northstar/rooms"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    unsubscribe();
    expect(removedWhileMounted).toEqual([false, false]);
    expect(queryClient.getQueriesData({ queryKey: roomKey })).toEqual([]);
    expect(
      queryClient
        .getQueryData<TeamHubRoomPage>(tenantRoomsQueryKey("tenant-northstar"))
        ?.items.some((candidate) => candidate.id === room.id),
    ).toBe(false);
    await expect(getRoom(runtime, room.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it.each([true, false])(
    "clears caches after a late deletion confirmation, but keeps them on failure (confirmed=%s)",
    async (confirmed) => {
      const runtime = createTestTeamHubRuntime();
      acceptRoomUpdates(runtime);

      const room = await getRoom(runtime, "room-all");
      let finishDeletion!: () => void;
      const pendingDeletion = new Promise<void>((resolve) => {
        finishDeletion = resolve;
      });
      const deletion = vi.fn<TestRouteHandler>(async () => {
        await pendingDeletion;
        if (!confirmed) throw new Error("Deletion was not confirmed.");
      });
      runtime.server.on("DELETE", "/v0/rooms/{roomId}", deletion);
      const queryClient = new QueryClient();
      const roomKey = roomQueryKey("tenant-northstar", room.id);
      queryClient.setQueryData(roomKey, room);
      const { unmount } = renderDeleteDialog({ queryClient, room, runtime });
      fireEvent.change(screen.getByLabelText("Room name confirmation"), {
        target: { value: room.name },
      });
      fireEvent.click(screen.getByRole("button", { name: "Delete Room" }));
      await waitFor(() => expect(deletion).toHaveBeenCalledOnce());
      unmount();
      expect(queryClient.getQueryData(roomKey)).toEqual(room);
      finishDeletion();
      await waitFor(() => expect(queryClient.isMutating()).toBe(0));
      expect(queryClient.getQueryData(roomKey)).toEqual(
        confirmed ? undefined : room,
      );
    },
  );

  it("retries the deletion after an unknown outcome", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomUpdates(runtime);

    const room = await getRoom(runtime, "room-all");
    const deleteRoom = vi.fn<TestRouteHandler>(() => {
      throw new Error("Connection closed before confirmation.");
    });
    runtime.server.on("DELETE", "/v0/rooms/{roomId}", deleteRoom);
    renderDeleteDialog({ queryClient: new QueryClient(), room, runtime });

    fireEvent.change(screen.getByLabelText("Room name confirmation"), {
      target: { value: room.name },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete Room" }));
    await screen.findByText(/did not confirm whether this Room was deleted/);
    fireEvent.click(screen.getByRole("button", { name: "Delete Room" }));

    await waitFor(() => expect(deleteRoom).toHaveBeenCalledTimes(2));
    expect(deleteRoom.mock.calls[1]![0].params).toEqual({ roomId: room.id });
  });

  it("leaves a deleted Room out of active Room access", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomUpdates(runtime);

    const room = await getRoom(runtime, "room-all");
    const rooms = await listRooms(runtime);
    runtime.server.on("DELETE", "/v0/rooms/{roomId}", () => undefined);
    const queryClient = new QueryClient();
    const roomKey = roomQueryKey("tenant-northstar", room.id);
    queryClient.setQueryData(roomKey, room);
    queryClient.setQueryData(tenantRoomsQueryKey("tenant-northstar"), rooms);
    const { router } = renderDeleteDialog({ queryClient, room, runtime });

    fireEvent.change(screen.getByLabelText("Room name confirmation"), {
      target: { value: room.name },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete Room" }));

    // Router state changes before React commits the route and unmounts this
    // dialog. Cache removal belongs to that unmount, so await its outcome.
    await screen.findByText("Rooms index");
    expect(router.state.location.pathname).toBe("/t/tenant-northstar/rooms");
    await waitFor(() =>
      expect(queryClient.getQueriesData({ queryKey: roomKey })).toEqual([]),
    );
    expect(
      queryClient
        .getQueryData<TeamHubRoomPage>(tenantRoomsQueryKey("tenant-northstar"))
        ?.items.some((candidate) => candidate.id === room.id),
    ).toBe(false);
    expect(screen.queryByText(/deleted successfully/i)).not.toBeInTheDocument();
  });
});

function renderDeleteDialog({
  queryClient,
  room,
  runtime,
  indexLoader,
}: {
  queryClient: QueryClient;
  room: TeamHubRoom;
  runtime: TeamHubRuntime;
  indexLoader?: () => Promise<null>;
}) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <RoomDeleteDialog
            onClose={vi.fn()}
            room={room}
            tenantId="tenant-northstar"
          />
        ),
        path: "/t/:tenantId/rooms/:roomId/chat",
      },
      {
        element: <div>Rooms index</div>,
        path: "/t/:tenantId/rooms",
        loader: indexLoader,
      },
    ],
    { initialEntries: [`/t/tenant-northstar/rooms/${room.id}/chat`] },
  );

  const view = render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );

  return { router, unmount: view.unmount };
}

function getRoom(runtime: TestTeamHubRuntime, roomId: string) {
  return teamHubData(
    runtime.client.api.GET("/v0/rooms/{roomId}", {
      params: { path: { roomId } },
    }),
  );
}

function listRooms(runtime: TestTeamHubRuntime) {
  return teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/rooms", {
      params: { path: { tenantId: "tenant-northstar" } },
    }),
  );
}
