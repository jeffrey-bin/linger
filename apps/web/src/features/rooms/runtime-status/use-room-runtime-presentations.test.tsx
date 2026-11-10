import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubRunStatus,
  TeamHubRuntimePresentationEventPage,
} from "@/features/teamhub/teamhub-types";

import { roomRuntimePresentationEventsQueryKey } from "../room-queries";
import { createRuntimePresentationEventsSync } from "./runtime-presentation-events-sync";
import { useRoomRuntimePresentations } from "./use-room-runtime-presentations";

const sharedConsumerRunStatuses = [testRunStatus(1)];

describe("Room Runtime presentations", () => {
  it("loads failed history after refresh without an active Run Status or cached events", async () => {
    const runtime = createTestTeamHubRuntime();
    const page: TeamHubRuntimePresentationEventPage = {
      has_more: false,
      published_through_ordinal: "1",
      items: [
        {
          event_ordinal: "1",
          segment_id: "segment-1",
          event: {
            type: "status.changed",
            status: "stopped",
            outcome: "failed",
            failure: {
              code: "session_not_found",
              runtime_type: "codex",
              runtime_version: "0.153.4",
            },
          },
        },
      ],
    };
    const listRoomRuntimePresentationEvents = vi.fn<TestRouteHandler>(
      () => page,
    );
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { result, unmount } = renderHook(
      () =>
        useRoomRuntimePresentations({
          activeRunStatuses: [],
          runStatuses: [{ ...testRunStatus(2), status: "aborted" }],
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current.eventsByRunStatusId["run-status-1"]).toEqual(
        page.items,
      ),
    );
    unmount();
    queryClient.clear();
  });

  it("appends from the last published ordinal while a newer revision loads", async () => {
    const nextRevision = deferred<TeamHubRuntimePresentationEventPage>();
    const runtime = createTestTeamHubRuntime();
    const listRoomRuntimePresentationEvents = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce(eventPage(["1"], "1"))
      .mockReturnValueOnce(nextRevision.promise);
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ revision }) =>
        useRoomRuntimePresentations({
          runStatuses: [testRunStatus(revision)],
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      { initialProps: { revision: 1 }, wrapper },
    );

    await waitFor(() =>
      expect(result.current.eventsByRunStatusId["run-status-1"]).toHaveLength(
        1,
      ),
    );
    expect(result.current.progressVersion).toBe("run-status-1:1");

    rerender({ revision: 2 });

    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(2),
    );
    expect(eventRead(listRoomRuntimePresentationEvents.mock.calls[1]!)).toEqual(
      ["room-1", "run-status-1", "1", 200],
    );
    expect(result.current.eventsByRunStatusId["run-status-1"]).toHaveLength(1);
    expect(result.current.progressVersion).toBe("run-status-1:1");

    await act(async () => {
      nextRevision.resolve(eventPage(["2"], "2"));
      await nextRevision.promise;
    });
    await waitFor(() =>
      expect(result.current.eventsByRunStatusId["run-status-1"]).toHaveLength(
        2,
      ),
    );
    expect(result.current.progressVersion).toBe("run-status-1:2");
  });

  it("coalesces fast wake revisions into one follow-up request", async () => {
    const runtime = createTestTeamHubRuntime();
    const listRoomRuntimePresentationEvents = vi.fn<TestRouteHandler>(
      ({ query }) =>
        query.get("after") === "0"
          ? eventPage(["1"], "1")
          : eventPage(["2", "3"], "3"),
    );
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ revision }) =>
        useRoomRuntimePresentations({
          runStatuses: [testRunStatus(revision)],
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      { initialProps: { revision: 1 }, wrapper },
    );

    await waitFor(() =>
      expect(result.current.progressVersion).toBe("run-status-1:1"),
    );

    rerender({ revision: 2 });
    rerender({ revision: 3 });
    await act(
      async () => await new Promise((resolve) => setTimeout(resolve, 25)),
    );
    expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1);

    await waitFor(() =>
      expect(result.current.progressVersion).toBe("run-status-1:3"),
    );
    expect(listRoomRuntimePresentationEvents.mock.calls).toHaveLength(2);
    expect(eventRead(listRoomRuntimePresentationEvents.mock.calls[1]!)).toEqual(
      ["room-1", "run-status-1", "1", 200],
    );
  });

  it("keeps one request in flight while wake revisions advance", async () => {
    const firstRevision = deferred<TeamHubRuntimePresentationEventPage>();
    const runtime = createTestTeamHubRuntime();
    const listRoomRuntimePresentationEvents = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce(firstRevision.promise)
      .mockReturnValueOnce(eventPage(["2", "3"], "3"));
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ revision }) =>
        useRoomRuntimePresentations({
          runStatuses: [testRunStatus(revision)],
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      { initialProps: { revision: 1 }, wrapper },
    );

    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1),
    );
    rerender({ revision: 2 });
    rerender({ revision: 3 });
    await act(
      async () => await new Promise((resolve) => setTimeout(resolve, 25)),
    );
    expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRevision.resolve(eventPage(["1"], "1"));
      await firstRevision.promise;
    });
    await waitFor(() =>
      expect(result.current.progressVersion).toBe("run-status-1:3"),
    );
    expect(listRoomRuntimePresentationEvents.mock.calls).toHaveLength(2);
    expect(eventRead(listRoomRuntimePresentationEvents.mock.calls[1]!)).toEqual(
      ["room-1", "run-status-1", "1", 200],
    );
  });

  it.each([0, 1])(
    "continues syncing after Strict Mode replays effect setup (initial revision %i)",
    async (initialRevision) => {
      const runtime = createTestTeamHubRuntime();
      const listRoomRuntimePresentationEvents = vi.fn<TestRouteHandler>(
        ({ query }) =>
          query.get("after") === "0"
            ? eventPage(["1"], "1")
            : eventPage(["2"], "2"),
      );
      runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TeamHubRuntimeProvider runtime={runtime}>
            {children}
          </TeamHubRuntimeProvider>
        </QueryClientProvider>
      );
      const { result, rerender } = renderHook(
        ({ revision }) =>
          useRoomRuntimePresentations({
            runStatuses: revision ? [testRunStatus(revision)] : [],
            roomId: "room-1",
            tenantId: "tenant-1",
          }),
        {
          initialProps: { revision: initialRevision },
          wrapper,
          reactStrictMode: true,
        },
      );

      rerender({ revision: 1 });
      await waitFor(() =>
        expect(result.current.progressVersion).toBe("run-status-1:1"),
      );
      rerender({ revision: 2 });
      await waitFor(() =>
        expect(result.current.progressVersion).toBe("run-status-1:2"),
      );
    },
  );

  it("does not resync for an unrelated rerender", async () => {
    const runtime = createTestTeamHubRuntime();
    const listRoomRuntimePresentationEvents = vi
      .fn<TestRouteHandler>()
      .mockReturnValue(eventPage(["1"], "1"));
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const runStatus = testRunStatus(1);
    const { result, rerender } = renderHook(
      ({ noise }) => {
        void noise;
        return useRoomRuntimePresentations({
          runStatuses: [runStatus],
          roomId: "room-1",
          tenantId: "tenant-1",
        });
      },
      { initialProps: { noise: 0 }, wrapper },
    );

    await waitFor(() =>
      expect(result.current.progressVersion).toBe("run-status-1:1"),
    );
    rerender({ noise: 1 });
    await act(
      async () => await new Promise((resolve) => setTimeout(resolve, 150)),
    );

    expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1);
  });

  it("limits initial synchronization to four concurrent Run Statuses", async () => {
    const runtime = createTestTeamHubRuntime();
    const pendingByRunStatusId = new Map(
      Array.from({ length: 5 }, (_, index) => [
        `run-status-${index + 1}`,
        deferred<TeamHubRuntimePresentationEventPage>(),
      ]),
    );
    const listRoomRuntimePresentationEvents = vi.fn<TestRouteHandler>(
      ({ params }) => pendingByRunStatusId.get(params.runId!)!.promise,
    );
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { unmount } = renderHook(
      () =>
        useRoomRuntimePresentations({
          runStatuses: Array.from({ length: 5 }, (_, index) =>
            testRunStatus(1, "room-1", `run-status-${index + 1}`),
          ),
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(4),
    );
    expect(
      listRoomRuntimePresentationEvents.mock.calls.map(
        ([request]) => request.params.runId,
      ),
    ).toEqual(["run-status-1", "run-status-2", "run-status-3", "run-status-4"]);

    await act(async () => {
      pendingByRunStatusId.get("run-status-1")!.resolve(eventPage(["1"], "1"));
      await pendingByRunStatusId.get("run-status-1")!.promise;
    });
    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(5),
    );
    expect(
      listRoomRuntimePresentationEvents.mock.calls[4]?.[0].params.runId,
    ).toBe("run-status-5");

    await act(async () => {
      for (const [runStatusId, pending] of pendingByRunStatusId) {
        if (runStatusId !== "run-status-1")
          pending.resolve(eventPage(["1"], "1"));
      }
      await Promise.all(
        [...pendingByRunStatusId.values()].map((pending) => pending.promise),
      );
    });
    unmount();
  });

  it("shares the four Run Status limit across mounted consumers", async () => {
    const runtime = createTestTeamHubRuntime();
    const pendingByRunStatusId = new Map(
      Array.from({ length: 6 }, (_, index) => [
        `run-status-${index + 1}`,
        deferred<TeamHubRuntimePresentationEventPage>(),
      ]),
    );
    const listRoomRuntimePresentationEvents = vi.fn<TestRouteHandler>(
      ({ params }) => pendingByRunStatusId.get(params.runId!)!.promise,
    );
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { unmount } = renderHook(
      () => {
        useRoomRuntimePresentations({
          runStatuses: [1, 2, 3].map((index) =>
            testRunStatus(1, "room-1", `run-status-${index}`),
          ),
          roomId: "room-1",
          tenantId: "tenant-1",
        });
        useRoomRuntimePresentations({
          runStatuses: [4, 5, 6].map((index) =>
            testRunStatus(1, "room-2", `run-status-${index}`),
          ),
          roomId: "room-2",
          tenantId: "tenant-1",
        });
      },
      { wrapper },
    );

    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(4),
    );
    expect(
      new Set(
        listRoomRuntimePresentationEvents.mock.calls.map(
          ([request]) => request.params.runId,
        ),
      ),
    ).toEqual(
      new Set(["run-status-1", "run-status-2", "run-status-3", "run-status-4"]),
    );

    await act(async () => {
      pendingByRunStatusId.get("run-status-1")!.resolve(eventPage(["1"], "1"));
      await pendingByRunStatusId.get("run-status-1")!.promise;
    });
    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(5),
    );

    for (const [runStatusId, pending] of pendingByRunStatusId) {
      if (runStatusId !== "run-status-1")
        pending.resolve(eventPage(["1"], "1"));
    }
    unmount();
  });

  it("keeps a shared Run Status request alive when one consumer unmounts", async () => {
    const pending = deferred<TeamHubRuntimePresentationEventPage>();
    const runtime = createTestTeamHubRuntime();
    let requestSignal: AbortSignal | undefined;
    const listRoomRuntimePresentationEvents = vi.fn<TestRouteHandler>(
      ({ request }) => {
        requestSignal = request.signal;
        return pending.promise;
      },
    );
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    function Consumer() {
      useRoomRuntimePresentations({
        runStatuses: sharedConsumerRunStatuses,
        roomId: "room-1",
        tenantId: "tenant-1",
      });
      return null;
    }
    function Consumers({ first }: { first: boolean }) {
      return (
        <>
          {first ? <Consumer key="first" /> : null}
          <Consumer key="second" />
        </>
      );
    }
    const view = render(<Consumers first />, { wrapper });

    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1),
    );
    view.rerender(<Consumers first={false} />);

    expect(requestSignal?.aborted).toBe(false);
    await act(async () => {
      pending.resolve(eventPage(["1"], "1"));
      await pending.promise;
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryData(
          roomRuntimePresentationEventsQueryKey(
            "tenant-1",
            "room-1",
            "run-status-1",
          ),
        ),
      ).toMatchObject({ published_through_ordinal: "1" }),
    );
    view.unmount();
  });

  it("catches up a higher revision requested by a second coordinator", async () => {
    const firstRevision = deferred<TeamHubRuntimePresentationEventPage>();
    const runtime = createTestTeamHubRuntime();
    const listRoomRuntimePresentationEvents = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce(firstRevision.promise)
      .mockReturnValueOnce(eventPage(["2"], "2"));
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const { client } = runtime;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const first = createRuntimePresentationEventsSync({
      client,
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });
    const second = createRuntimePresentationEventsSync({
      client,
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    first.request("run-status-1", 1);
    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1),
    );
    second.request("run-status-1", 2);
    firstRevision.resolve(eventPage(["1"], "1"));

    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(2),
    );
    expect(eventRead(listRoomRuntimePresentationEvents.mock.calls[1]!)).toEqual(
      ["room-1", "run-status-1", "1", 200],
    );
    first.dispose();
    second.dispose();
  });

  it("finishes active Run Status catch-up and retains cached events after it becomes terminal", async () => {
    const finalCatchUp = deferred<TeamHubRuntimePresentationEventPage>();
    const runtime = createTestTeamHubRuntime();
    const listRoomRuntimePresentationEvents = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce(eventPage(["1"], "1"))
      .mockReturnValueOnce(finalCatchUp.promise);
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({
        revision,
        status,
        visible,
      }: {
        revision: number;
        status: "active" | "completed";
        visible: boolean;
      }) => {
        const visibleRunStatus = { ...testRunStatus(revision), status };
        return useRoomRuntimePresentations({
          activeRunStatuses:
            visible && status === "active" ? [visibleRunStatus] : [],
          runStatuses: visible ? [visibleRunStatus] : [],
          roomId: "room-1",
          tenantId: "tenant-1",
        });
      },
      {
        initialProps: {
          revision: 1,
          status: "active" as "active" | "completed",
          visible: true,
        },
        wrapper,
      },
    );

    await waitFor(() =>
      expect(result.current.progressVersion).toBe("run-status-1:1"),
    );
    rerender({ revision: 2, status: "completed", visible: true });
    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(2),
    );
    expect(result.current.eventsByRunStatusId["run-status-1"]).toHaveLength(1);
    rerender({ revision: 2, status: "completed", visible: false });

    await act(async () => {
      finalCatchUp.resolve(eventPage(["2"], "2"));
      await finalCatchUp.promise;
    });
    await waitFor(() => {
      const cached =
        queryClient.getQueryData<TeamHubRuntimePresentationEventPage>(
          roomRuntimePresentationEventsQueryKey(
            "tenant-1",
            "room-1",
            "run-status-1",
          ),
        );
      expect(cached?.items).toHaveLength(2);
      expect(cached?.published_through_ordinal).toBe("2");
    });
  });

  it("retries a failed synchronization with backoff instead of waiting for a rerender", async () => {
    const runtime = createTestTeamHubRuntime();
    const listRoomRuntimePresentationEvents = vi
      .fn<TestRouteHandler>()
      .mockImplementationOnce(() => {
        throw new TypeError("network unavailable");
      })
      .mockReturnValueOnce(eventPage(["1"], "1"));
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useRoomRuntimePresentations({
          runStatuses: [testRunStatus(1)],
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1),
    );
    await act(
      async () => await new Promise((resolve) => setTimeout(resolve, 100)),
    );
    expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1);

    await waitFor(() =>
      expect(result.current.progressVersion).toBe("run-status-1:1"),
    );
    expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(2);
  });

  it("does not retry a protocol violation", async () => {
    const runtime = createTestTeamHubRuntime();
    const listRoomRuntimePresentationEvents = vi
      .fn<TestRouteHandler>()
      .mockReturnValue(eventPage(["2"], "2"));
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    renderHook(
      () =>
        useRoomRuntimePresentations({
          runStatuses: [testRunStatus(1)],
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1),
    );
    await act(
      async () => await new Promise((resolve) => setTimeout(resolve, 400)),
    );
    expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1);
  });

  it("does not restart a non-retryable synchronization when revision advances", async () => {
    const runtime = createTestTeamHubRuntime();
    const listRoomRuntimePresentationEvents = vi.fn<TestRouteHandler>(() =>
      teamHubErrorResponse(
        401,
        "AUTHENTICATION_REQUIRED",
        "Sign in to continue.",
      ),
    );
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { rerender } = renderHook(
      ({ revision }) =>
        useRoomRuntimePresentations({
          runStatuses: [testRunStatus(revision)],
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      { initialProps: { revision: 1 }, wrapper },
    );

    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1),
    );
    rerender({ revision: 2 });
    await act(
      async () => await new Promise((resolve) => setTimeout(resolve, 400)),
    );

    expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1);
  });

  it("cancels the previous Room request when identity changes", async () => {
    const runtime = createTestTeamHubRuntime();
    let previousSignal: AbortSignal | undefined;
    const listRoomRuntimePresentationEvents = vi.fn<TestRouteHandler>(
      ({ params, request }) => {
        if (params.roomId !== "room-1") {
          return eventPage(["1"], "1");
        }
        previousSignal = request.signal;
        return new Promise<TeamHubRuntimePresentationEventPage>(
          (_resolve, reject) =>
            previousSignal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            ),
        );
      },
    );
    runtime.server.on("GET", EVENTS_PATH, listRoomRuntimePresentationEvents);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ roomId }) =>
        useRoomRuntimePresentations({
          runStatuses: [testRunStatus(1, roomId)],
          roomId,
          tenantId: "tenant-1",
        }),
      { initialProps: { roomId: "room-1" }, wrapper },
    );

    await waitFor(() =>
      expect(listRoomRuntimePresentationEvents).toHaveBeenCalledTimes(1),
    );
    rerender({ roomId: "room-2" });

    await waitFor(() => expect(previousSignal?.aborted).toBe(true));
    await waitFor(() =>
      expect(result.current.progressVersion).toBe("run-status-1:1"),
    );
    expect(
      listRoomRuntimePresentationEvents.mock.calls[1]?.[0].params.roomId,
    ).toBe("room-2");
  });
});

const EVENTS_PATH =
  "/v0/rooms/{roomId}/runs/{runId}/runtime-presentation-events";

/** The Room, Run, ordinal and page size one event read requested. */
function eventRead([request]: [TestRouteRequest]) {
  return [
    request.params.roomId,
    request.params.runId,
    request.query.get("after"),
    Number(request.query.get("limit")),
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function eventPage(
  eventOrdinals: readonly string[],
  publishedThroughOrdinal: string,
): TeamHubRuntimePresentationEventPage {
  return {
    has_more: false,
    items: eventOrdinals.map((eventOrdinal) => ({
      event: { status: "working" as const, type: "status.changed" as const },
      event_ordinal: eventOrdinal,
      segment_id: "segment-1",
    })),
    published_through_ordinal: publishedThroughOrdinal,
  };
}

function testRunStatus(
  revision: number,
  roomId = "room-1",
  runStatusId = "run-status-1",
): TeamHubRunStatus {
  return {
    agent: {
      display_name: "Codex",
      id: "agent-1",
      kind: "agent",
    },
    created_at: "2026-08-25T00:00:00Z",
    id: runStatusId,
    run_id: runStatusId,
    replied: false,
    revision,
    room_id: roomId,
    status: "active",
    updated_at: `2026-08-25T00:00:0${revision}Z`,
  };
}
