import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import { roomQueryKey } from "./room-queries";
import { useRoomParticipation } from "./room-participation";

describe("Room participation", () => {
  it("sets the parent Room's participation and caches the returned Room", async () => {
    const runtime = createTestTeamHubRuntime();
    const parent = runtime.seed.rooms.find((room) => room.id === "room-all")!;
    const thread = { ...parent, id: "room-thread", parent_room_id: parent.id };
    const updated = { ...parent, name: "Left" };
    const participation = vi.fn<TestRouteHandler>(() => updated);
    runtime.server.on("PUT", "/v0/rooms/{roomId}/participation", participation);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useRoomParticipation(thread), {
      wrapper,
    });

    await act(() => result.current.mutateAsync("left"));

    expect(participation).toHaveBeenCalledOnce();
    expect(participation).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { status: "left" },
        params: { roomId: parent.id },
      }),
    );
    expect(
      queryClient.getQueryData(roomQueryKey(parent.tenant_id, parent.id)),
    ).toEqual(updated);
  });
});
