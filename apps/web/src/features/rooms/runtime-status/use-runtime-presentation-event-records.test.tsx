import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubRunStatus,
  TeamHubRunStatusList,
  TeamHubRuntimePresentationEventPage,
} from "@/features/teamhub/teamhub-types";

import { roomRunStatusesQueryKey } from "../room-queries";

import { useRuntimePresentationEventRecords } from "./use-runtime-presentation-event-records";

describe("Runtime presentation event records", () => {
  it("loads a completed Run Status's events after Strict Mode replays effects", async () => {
    const runtime = createTestTeamHubRuntime();
    const page: TeamHubRuntimePresentationEventPage = {
      has_more: false,
      items: [
        {
          event: {
            status: "thinking",
            title: "Plan the reply",
            type: "status.changed",
          },
          event_ordinal: "1",
          segment_id: "segment-1",
        },
      ],
      published_through_ordinal: "1",
    };
    runtime.server.on("GET", EVENTS_PATH, () => page);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <TeamHubRuntimeProvider runtime={runtime}>
            {children}
          </TeamHubRuntimeProvider>
        </QueryClientProvider>
      </StrictMode>
    );

    const { result } = renderHook(
      () =>
        useRuntimePresentationEventRecords({
          runStatusId: "run-status-completed",
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.items).toEqual(page.items);
    expect(result.current.error).toBeNull();
  });

  it("reloads events when Strict Mode aborts the first in-flight fetch", async () => {
    const runtime = createTestTeamHubRuntime();
    const page: TeamHubRuntimePresentationEventPage = {
      has_more: false,
      items: [
        {
          event: {
            status: "thinking",
            title: "Plan the reply",
            type: "status.changed",
          },
          event_ordinal: "1",
          segment_id: "segment-1",
        },
      ],
      published_through_ordinal: "1",
    };
    let release!: (value: TeamHubRuntimePresentationEventPage) => void;
    const listRoomRuntimePresentationEvents = vi.fn(
      () =>
        new Promise<TeamHubRuntimePresentationEventPage>((resolve) => {
          release = resolve;
        }),
    );
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <TeamHubRuntimeProvider runtime={runtime}>
            {children}
          </TeamHubRuntimeProvider>
        </QueryClientProvider>
      </StrictMode>
    );

    const { result } = renderHook(
      () =>
        useRuntimePresentationEventRecords({
          runStatusId: "run-status-completed",
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalled(),
    );
    release(page);
    await waitFor(() => expect(result.current.items).toEqual(page.items));
    expect(result.current.pending).toBe(false);
  });
});

const EVENTS_PATH =
  "/v0/rooms/{roomId}/runs/{runId}/runtime-presentation-events";

const runEvents: TeamHubRuntimePresentationEventPage = {
  has_more: false,
  published_through_ordinal: "1",
  items: [
    {
      event_ordinal: "1",
      segment_id: "current-segment",
      event: {
        type: "status.changed",
        status: "thinking",
        title: "Current run activity",
      },
    },
  ],
};
const runStatusQuery: TeamHubRunStatus = {
  id: "current-run-status",
  run_id: "current-run",
  room_id: "room-1",
  agent: { id: "agent-1", kind: "agent", display_name: "Codex" },
  status: "active",
  replied: false,
  revision: 1,
  created_at: "2026-10-20T00:00:00Z",
  updated_at: "2026-10-20T00:00:00Z",
};
function runWrapper(
  listRunStatuses: () => Promise<TeamHubRunStatusList>,
  liveRunStatuses?: TeamHubRunStatus[],
) {
  const fixture = createTestTeamHubRuntime();
  const listEvents = vi.fn<TestRouteHandler>(() => runEvents);
  fixture.server.on("GET", EVENTS_PATH, listEvents);
  const runtime = {
    ...fixture,
    client: {
      ...fixture.client,
      listRoomRuntimePresentationRuns: listRunStatuses,
    },
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  if (liveRunStatuses) {
    queryClient.setQueryData(roomRunStatusesQueryKey("tenant-1", "room-1"), {
      items: liveRunStatuses,
    });
  }
  const subscribe = vi.spyOn(runtime.runStatuses, "subscribe");
  return { wrapper, listEvents, queryClient, subscribe };
}
const runInput = {
  runStatusId: "previous-run-status",
  runId: "current-run",
  actorId: "agent-1",
  roomId: "room-1",
  tenantId: "tenant-1",
};

it("reads a completed Run Status once when it is absent from the live collection", async () => {
  const listRunStatuses = vi
    .fn()
    .mockResolvedValue({ items: [{ ...runStatusQuery, status: "completed" }] });
  const { wrapper, listEvents } = runWrapper(listRunStatuses);
  const { result, unmount } = renderHook(
    () => useRuntimePresentationEventRecords(runInput),
    { wrapper },
  );
  await waitFor(() => expect(result.current.items).toEqual(runEvents.items));
  expect(listRunStatuses).toHaveBeenCalledOnce();
  expect(listRunStatuses).toHaveBeenCalledWith("room-1", [], "current-run");
  expect(
    listEvents.mock.calls.every(
      ([request]) => request.params.runId === "current-run-status",
    ),
  ).toBe(true);
  unmount();
});

it("keeps the observed live Run Status when an earlier missing Run Status lookup resolves late", async () => {
  let release!: (page: TeamHubRunStatusList) => void;
  const listRunStatuses = vi.fn(
    () =>
      new Promise<TeamHubRunStatusList>((resolve) => {
        release = resolve;
      }),
  );
  const { wrapper, queryClient } = runWrapper(listRunStatuses);
  const { result, unmount } = renderHook(
    () => useRuntimePresentationEventRecords(runInput),
    { wrapper },
  );
  await waitFor(() => expect(listRunStatuses).toHaveBeenCalledOnce());
  await act(() =>
    queryClient.setQueryData(roomRunStatusesQueryKey("tenant-1", "room-1"), {
      items: [{ ...runStatusQuery, status: "completed" }],
    }),
  );
  await waitFor(() => expect(result.current.items).toEqual(runEvents.items));
  await act(async () => {
    release({ items: [] });
  });
  await act(() =>
    queryClient.setQueryData(roomRunStatusesQueryKey("tenant-1", "room-1"), {
      items: [],
    }),
  );
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.items).toEqual(runEvents.items);
  expect(listRunStatuses).toHaveBeenCalledOnce();
  unmount();
});

it("isolates a new Run from late old queries and unrelated Agent Run Statuses", async () => {
  let release!: (page: TeamHubRunStatusList) => void;
  const listRunStatuses = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<TeamHubRunStatusList>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({
      items: [
        {
          ...runStatusQuery,
          run_id: "next-run",
          agent: { ...runStatusQuery.agent, id: "other-agent" },
        },
      ],
    });
  const { wrapper, listEvents } = runWrapper(listRunStatuses);
  const { result, rerender, unmount } = renderHook(
    ({ runId }) => useRuntimePresentationEventRecords({ ...runInput, runId }),
    { wrapper, initialProps: { runId: "current-run" } },
  );
  await waitFor(() => expect(listRunStatuses).toHaveBeenCalledTimes(1));
  rerender({ runId: "next-run" });
  release({ items: [runStatusQuery] });
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.items).toEqual([]);
  expect(listEvents).not.toHaveBeenCalled();
  unmount();
});

it.each([404, 503])(
  "reports Run Status lookup %s without reading the previous reply",
  async (httpStatus) => {
    const failure = new Error(`HTTP ${httpStatus}`);
    const { wrapper, listEvents } = runWrapper(
      vi.fn().mockRejectedValue(failure),
    );
    const { result, unmount } = renderHook(
      () => useRuntimePresentationEventRecords(runInput),
      { wrapper },
    );
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.items).toEqual([]);
    expect(listEvents).not.toHaveBeenCalled();
    unmount();
  },
);

describe("Run Status collection synchronization", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([403, 404, 503])(
    "does not poll or retry a Run Status lookup rejected with HTTP %s",
    async (status) => {
      const failure = new TeamHubError({
        code: "unavailable",
        message: "rejected",
        status,
      });
      const listRunStatuses = vi.fn().mockRejectedValue(failure);
      const { wrapper, subscribe } = runWrapper(listRunStatuses);
      const { result, rerender, unmount } = renderHook(
        () => useRuntimePresentationEventRecords(runInput),
        { wrapper },
      );
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(result.current.error).toBe(failure);
      rerender();
      await act(() => vi.advanceTimersByTimeAsync(180_000));
      expect(listRunStatuses).toHaveBeenCalledOnce();
      expect(subscribe).not.toHaveBeenCalled();
      unmount();
    },
  );

  it("follows a later live Run Status after the one missing Run Status lookup, without polling", async () => {
    const listRunStatuses = vi.fn().mockResolvedValue({ items: [] });
    const { wrapper, listEvents, queryClient, subscribe } =
      runWrapper(listRunStatuses);
    const { result, unmount } = renderHook(
      () => useRuntimePresentationEventRecords(runInput),
      { wrapper },
    );
    await act(() => vi.advanceTimersByTimeAsync(180_000));
    expect(listRunStatuses).toHaveBeenCalledOnce();
    expect(listEvents).not.toHaveBeenCalled();
    act(() => {
      queryClient.setQueryData(roomRunStatusesQueryKey("tenant-1", "room-1"), {
        items: [runStatusQuery],
      });
    });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(result.current.items).toEqual(runEvents.items);
    expect(listRunStatuses).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
    unmount();
  });

  it("reuses the live Run Status and syncs newer revisions without recreating its subscription", async () => {
    const listRunStatuses = vi.fn().mockResolvedValue({ items: [] });
    const { wrapper, listEvents, queryClient, subscribe } = runWrapper(
      listRunStatuses,
      [runStatusQuery],
    );
    const nextEvent = {
      ...runEvents.items[0]!,
      event_ordinal: "2",
      event: {
        type: "status.changed" as const,
        status: "thinking" as const,
        title: "Next step",
      },
    };
    listEvents.mockImplementation(({ query }) =>
      query.get("after") === "0"
        ? runEvents
        : {
            has_more: false,
            published_through_ordinal: "2",
            items: [nextEvent],
          },
    );
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) =>
        useRuntimePresentationEventRecords({ ...runInput, enabled }),
      { wrapper, initialProps: { enabled: true } },
    );
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(result.current.items).toEqual(runEvents.items);
    const settledCalls = listEvents.mock.calls.length;
    rerender({ enabled: true });
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(listEvents).toHaveBeenCalledTimes(settledCalls);
    act(() => {
      queryClient.setQueryData(roomRunStatusesQueryKey("tenant-1", "room-1"), {
        items: [{ ...runStatusQuery, revision: 2, status: "completed" }],
      });
    });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(result.current.items).toEqual([...runEvents.items, nextEvent]);
    expect(listRunStatuses).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    act(() => {
      queryClient.setQueryData(roomRunStatusesQueryKey("tenant-1", "room-1"), {
        items: [],
      });
    });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(result.current.items).toEqual([...runEvents.items, nextEvent]);
    expect(listRunStatuses).not.toHaveBeenCalled();
    rerender({ enabled: false });
    act(() => {
      queryClient.setQueryData(roomRunStatusesQueryKey("tenant-1", "room-1"), {
        items: [{ ...runStatusQuery, revision: 3 }],
      });
    });
    const disabledCalls = listEvents.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(listEvents).toHaveBeenCalledTimes(disabledCalls);
    unmount();
  });
});
