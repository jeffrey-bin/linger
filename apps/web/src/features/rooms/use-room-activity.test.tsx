import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { tenantRoomActivityQueryKey } from "./room-queries";
import { useRoomActivity } from "./use-room-activity";

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

function activitySnapshot(
  runningRoomIds: readonly string[] = [],
  failedRoomIds: readonly string[] = [],
) {
  return {
    failed_room_ids: [...failedRoomIds],
    running_room_ids: [...runningRoomIds],
  };
}

function setup() {
  const runtime = createTestTeamHubRuntime();
  const read = vi.fn<TestRouteHandler>(() => activitySnapshot(["room-a"]));
  runtime.server.on("GET", "/v0/tenants/{tenantId}/room-activity", read);
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
  return { read, queryClient, wrapper };
}

describe("Room activity batch polling", () => {
  it("reuses one tenant snapshot through rerenders, clears failed refreshes, and recovers", async () => {
    const { read, queryClient, wrapper } = setup();
    const { result, rerender, unmount } = renderHook(
      ({ tenantId, enabled }) => useRoomActivity(tenantId, enabled),
      { initialProps: { tenantId: "tenant-a", enabled: true }, wrapper },
    );
    await waitFor(() =>
      expect(result.current.runningRoomIds).toEqual(["room-a"]),
    );
    rerender({ tenantId: "tenant-a", enabled: true });
    expect(read).toHaveBeenCalledTimes(1);
    read.mockReturnValueOnce(teamHubErrorResponse(503, "OFFLINE"));
    await act(() =>
      queryClient.refetchQueries({
        queryKey: tenantRoomActivityQueryKey("tenant-a"),
      }),
    );
    await waitFor(() => expect(result.current.runningRoomIds).toEqual([]));
    read.mockReturnValue(activitySnapshot());
    await act(() =>
      queryClient.refetchQueries({
        queryKey: tenantRoomActivityQueryKey("tenant-a"),
      }),
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryState(tenantRoomActivityQueryKey("tenant-a"))
          ?.status,
      ).toBe("success"),
    );
    expect(result.current.runningRoomIds).toEqual([]);
    read.mockReturnValue(activitySnapshot(["room-b"]));
    rerender({ tenantId: "tenant-b", enabled: true });
    expect(result.current.runningRoomIds).toEqual([]);
    await waitFor(() =>
      expect(result.current.runningRoomIds).toEqual(["room-b"]),
    );
    rerender({ tenantId: "tenant-b", enabled: false });
    expect(result.current.runningRoomIds).toEqual([]);
    unmount();
    queryClient.clear();
  });

  it("pauses polling in the background, refreshes on return, and stops on unmount", async () => {
    vi.useFakeTimers();
    const { read, queryClient, wrapper } = setup();
    const { result, unmount } = renderHook(
      () => useRoomActivity("tenant-a", true),
      { wrapper },
    );
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.runningRoomIds).toEqual(["room-a"]);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(read).toHaveBeenCalledTimes(2);
    act(() => focusManager.setFocused(false));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => {
      focusManager.setFocused(true);
    });
    expect(read).toHaveBeenCalledTimes(3);
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(read).toHaveBeenCalledTimes(3);
    queryClient.clear();
  });

  it("aborts the old tenant request and does not request activity outside Room navigation", async () => {
    const { read, queryClient, wrapper } = setup();
    read.mockImplementation(() => new Promise(() => {}));
    const { rerender, unmount } = renderHook(
      ({ tenantId, enabled }) => useRoomActivity(tenantId, enabled),
      { initialProps: { tenantId: "tenant-a", enabled: false }, wrapper },
    );
    expect(read).not.toHaveBeenCalled();
    rerender({ tenantId: "tenant-a", enabled: true });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const oldSignal = read.mock.calls[0]![0].request.signal;
    rerender({ tenantId: "tenant-b", enabled: true });
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    unmount();
    expect(read.mock.calls[1]![0].request.signal.aborted).toBe(true);
    queryClient.clear();
  });

  it("returns failed Room IDs from the snapshot", async () => {
    const { read, wrapper } = setup();
    read.mockReturnValue(activitySnapshot([], ["room-failed"]));
    const { result } = renderHook(() => useRoomActivity("tenant-a", true), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current.failedRoomIds).toEqual(["room-failed"]),
    );
    expect(result.current.runningRoomIds).toEqual([]);
  });

  it("uses the refreshed server state without retaining a local working marker", async () => {
    const { read, queryClient, wrapper } = setup();
    const { result } = renderHook(() => useRoomActivity("tenant-a", true), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current.runningRoomIds).toEqual(["room-a"]),
    );
    read.mockReturnValue(activitySnapshot());
    await act(() =>
      queryClient.invalidateQueries({
        queryKey: tenantRoomActivityQueryKey("tenant-a"),
      }),
    );
    await waitFor(() => expect(result.current.runningRoomIds).toEqual([]));
    queryClient.clear();
  });
});
