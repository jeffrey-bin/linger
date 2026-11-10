import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { RunStatusTransport } from "@/features/teamhub/run-status-transport";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubRunStatus } from "@/features/teamhub/teamhub-types";

import { roomRunStatusesQueryKey } from "../room-queries";
import { useRoomRunStatusCollection } from "./use-room-run-statuses";

describe("Room Run Status subscription", () => {
  it("does not resubscribe on unrelated rerenders and cleans up once per Room identity", async () => {
    const subscriptions: Array<{
      cleanup: ReturnType<typeof vi.fn>;
      publish: (items: TeamHubRunStatus[]) => void;
      roomId: string;
    }> = [];
    const transport: RunStatusTransport = {
      subscribe(input) {
        const cleanup = vi.fn();
        subscriptions.push({
          cleanup,
          publish: input.onCollection,
          roomId: input.roomId,
        });
        input.onCollection([testRunStatus(input.roomId, 1)]);
        return cleanup;
      },
    };
    const runtime = {
      ...createTestTeamHubRuntime(),
      runStatuses: transport,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { rerender, unmount } = renderHook(
      ({ roomId, renderVersion }) => {
        void renderVersion;
        return useRoomRunStatusCollection({
          roomId,
          tenantId: "tenant-northstar",
        });
      },
      {
        initialProps: { renderVersion: 1, roomId: "room-1" },
        wrapper,
      },
    );

    await waitFor(() => expect(subscriptions).toHaveLength(1));
    expect(invalidateQueries).not.toHaveBeenCalled();
    act(() => {
      subscriptions[0]?.publish([testRunStatus("room-1", 2)]);
    });
    expect(invalidateQueries).not.toHaveBeenCalled();
    act(() => {
      subscriptions[0]?.publish([]);
    });
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [
        "teamhub",
        "tenant-northstar",
        "room",
        "room-1",
        "run-statuses",
        "runtime-presentation-history",
      ],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["teamhub", "tenant-northstar", "room-activity"],
    });
    rerender({ renderVersion: 2, roomId: "room-1" });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.cleanup).not.toHaveBeenCalled();

    rerender({ renderVersion: 3, roomId: "room-2" });
    await waitFor(() => expect(subscriptions).toHaveLength(2));
    expect(subscriptions[0]?.cleanup).toHaveBeenCalledOnce();
    expect(subscriptions.map((item) => item.roomId)).toEqual([
      "room-1",
      "room-2",
    ]);

    unmount();
    expect(subscriptions[1]?.cleanup).toHaveBeenCalledOnce();
  });

  it("invalidates cached history when the first live snapshot drops an active Run Status", async () => {
    const transport: RunStatusTransport = {
      subscribe(input) {
        input.onCollection([]);
        return vi.fn();
      },
    };
    const runtime = {
      ...createTestTeamHubRuntime(),
      runStatuses: transport,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      roomRunStatusesQueryKey("tenant-northstar", "room-1"),
      { items: [testRunStatus("room-1", 1)] },
    );
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );

    renderHook(
      () =>
        useRoomRunStatusCollection({
          roomId: "room-1",
          tenantId: "tenant-northstar",
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: [
          "teamhub",
          "tenant-northstar",
          "room",
          "room-1",
          "run-statuses",
          "runtime-presentation-history",
        ],
      }),
    );
  });
});

function testRunStatus(roomId: string, revision: number): TeamHubRunStatus {
  return {
    agent: {
      display_name: "Codex",
      id: "agent-1",
      kind: "agent",
    },
    created_at: "2026-08-25T00:00:00Z",
    id: "run-status-1",
    run_id: "run-status-1",
    replied: false,
    revision,
    room_id: roomId,
    status: "active",
    updated_at: `2026-08-25T00:00:0${revision}Z`,
  };
}
