import {
  QueryClient,
  QueryClientProvider,
  useSuspenseInfiniteQuery,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Suspense, useEffect, useState } from "react";
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAppRoutes } from "@/app/router";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import {
  TeamHubRuntimeProvider,
  useTeamHubRuntime,
} from "@/features/teamhub/teamhub-runtime";
import {
  roomMembersQueryOptions,
  roomMessagesInfiniteQueryOptions,
  roomQueryOptions,
  roomQueryKey,
} from "./room-queries";

const subscriptions = vi.hoisted(() => ({ starts: vi.fn(), stops: vi.fn() }));
vi.mock("./room-shell", () => ({
  RoomShell: () => (
    <Suspense fallback={<p>Loading destination</p>}>
      <Outlet />
    </Suspense>
  ),
}));
vi.mock("./chat/room-chat", () => ({ RoomChat: ChatProbe }));
vi.mock("./chat/room-realtime-sync", () => ({
  RoomRealtimeSync: ({
    roomId,
    initialRoomSeq,
  }: {
    roomId: string;
    initialRoomSeq: number;
  }) => {
    useEffect(() => {
      subscriptions.starts(roomId, initialRoomSeq);
      return () => subscriptions.stops(roomId);
    }, [roomId, initialRoomSeq]);
    return null;
  },
}));

function ChatProbe() {
  const { client } = useTeamHubRuntime();
  const { tenantId = "", roomId = "" } = useParams();
  const { data } = useSuspenseInfiniteQuery(
    roomMessagesInfiniteQueryOptions(client, tenantId, roomId),
  );
  const [draft, setDraft] = useState("");
  return (
    <>
      <p>
        Chat {roomId}: {data.pages[0]?.items.length} messages
      </p>
      <input
        aria-label="Draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </>
  );
}

const tenantId = "tenant-northstar";
const roomId = "room-all";
async function readJson(response: Promise<Response>) {
  return (await (await response).json()) as object;
}

function readRoom(client: TeamHubClient, id: string) {
  return teamHubData(
    client.api.GET("/v0/rooms/{roomId}", { params: { path: { roomId: id } } }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function setup({
  cached = true,
  invalidated = false,
  blockMembers = false,
} = {}) {
  const runtime = createTestTeamHubRuntime();

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (cached) {
    await queryClient.ensureInfiniteQueryData(
      roomMessagesInfiniteQueryOptions(runtime.client, tenantId, roomId),
    );
    await Promise.all([
      queryClient.ensureQueryData(
        roomQueryOptions(runtime.client, tenantId, roomId),
      ),
      queryClient.ensureQueryData(
        roomMembersQueryOptions(runtime.client, tenantId, roomId),
      ),
    ]);
  }
  if (invalidated) {
    await queryClient.invalidateQueries({
      queryKey: roomMembersQueryOptions(runtime.client, tenantId, roomId)
        .queryKey,
      refetchType: "none",
    });
  }
  // A second runtime on the same seed answers the reads these routes delay.
  const seeded = createTestTeamHubRuntime(runtime.seed);
  const membersGate = deferred<void>();
  if (blockMembers) {
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/members",
      async ({ request }) => {
        await membersGate.promise;
        return seeded.server.fetch(request);
      },
    );
  }
  // Resolving with an error response denies the Room read.
  const gate = deferred<Response | void>();
  const refresh = vi.fn<TestRouteHandler>(async ({ params, request }) => {
    if (params.roomId === roomId) {
      const denial = await gate.promise;
      if (denial) return denial;
    }
    return seeded.server.fetch(request);
  });
  runtime.server.on("GET", "/v0/rooms/{roomId}", refresh);
  const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
    initialEntries: [`/t/${tenantId}/rooms/${roomId}/chat`],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  return { gate, membersGate, queryClient, router, runtime };
}

describe("Room cached presentation during bootstrap", () => {
  beforeEach(() => {
    subscriptions.starts.mockClear();
    subscriptions.stops.mockClear();
  });

  it.each([401, 403, 404])(
    "hides cached messages immediately on %s even while a sibling request is pending",
    async (httpStatus) => {
      const { gate, membersGate, queryClient } = await setup({
        blockMembers: true,
      });
      expect(await screen.findByText(/^Chat room-all:/)).toBeVisible();
      try {
        await act(async () =>
          gate.resolve(
            teamHubErrorResponse(httpStatus, "UNAVAILABLE", "Room denied"),
          ),
        );
        await waitFor(
          () =>
            expect(
              screen.queryByText(/^Chat room-all:/),
            ).not.toBeInTheDocument(),
          { timeout: 500 },
        );
        expect(subscriptions.starts).not.toHaveBeenCalled();
      } finally {
        await act(async () => membersGate.resolve());
      }
      await waitFor(() =>
        expect(
          queryClient
            .getQueriesData({ queryKey: roomQueryKey(tenantId, roomId) })
            .every(([, data]) => data === undefined),
        ).toBe(true),
      );
    },
  );

  it.each([
    { roomSeq: 10, membersSeq: 10, roomReads: 1, memberReads: 1 },
    { roomSeq: 9, membersSeq: 10, roomReads: 2, memberReads: 1 },
    { roomSeq: 10, membersSeq: 9, roomReads: 1, memberReads: 2 },
    { roomSeq: undefined, membersSeq: undefined, roomReads: 2, memberReads: 2 },
  ])(
    "refreshes only projections older than the Message watermark: %j",
    async ({ roomSeq, membersSeq, roomReads, memberReads }) => {
      const runtime = createTestTeamHubRuntime();

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const seeded = createTestTeamHubRuntime(runtime.seed);
      const roomRead = vi.fn<TestRouteHandler>(async ({ params }) => ({
        ...(await readRoom(seeded.client, params.roomId!)),
        snapshot_room_seq: roomSeq,
      }));
      runtime.server.on("GET", "/v0/rooms/{roomId}", roomRead);
      const memberRead = vi.fn<TestRouteHandler>(async ({ params }) => ({
        ...(await teamHubData(
          seeded.client.api.GET("/v0/rooms/{roomId}/members", {
            params: { path: { roomId: params.roomId! } },
          }),
        )),
        snapshot_room_seq: membersSeq,
      }));
      runtime.server.on("GET", "/v0/rooms/{roomId}/members", memberRead);
      runtime.server.on(
        "GET",
        "/v0/rooms/{roomId}/messages",
        async ({ request }) => ({
          ...(await readJson(seeded.server.fetch(request))),
          snapshot_room_seq: 10,
        }),
      );
      const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
        initialEntries: [`/t/${tenantId}/rooms/${roomId}/chat`],
      });
      render(
        <QueryClientProvider client={queryClient}>
          <TeamHubRuntimeProvider runtime={runtime}>
            <RouterProvider router={router} />
          </TeamHubRuntimeProvider>
        </QueryClientProvider>,
      );
      expect(await screen.findByText(/^Chat room-all:/)).toBeVisible();
      await waitFor(() =>
        expect(subscriptions.starts).toHaveBeenCalledTimes(1),
      );
      expect(subscriptions.starts).toHaveBeenCalledWith(roomId, 10);
      expect(roomRead).toHaveBeenCalledTimes(roomReads);
      expect(memberRead).toHaveBeenCalledTimes(memberReads);
    },
  );

  it("refreshes an interleaved Room change after the message watermark before realtime", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const messageGate = deferred<void>();
    const seeded = createTestTeamHubRuntime(runtime.seed);
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages",
      async ({ request }) => {
        await messageGate.promise;
        return {
          ...(await readJson(seeded.server.fetch(request))),
          snapshot_room_seq: 10,
        };
      },
    );
    let revision = "before watermark";
    const refreshGate = deferred<void>();
    const refreshRoom = vi.fn<TestRouteHandler>(async ({ params }) => {
      if (revision === "after watermark") await refreshGate.promise;
      return {
        ...(await readRoom(seeded.client, params.roomId!)),
        name: revision,
        snapshot_room_seq: revision === "before watermark" ? 9 : 10,
      };
    });
    runtime.server.on("GET", "/v0/rooms/{roomId}", refreshRoom);
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: [`/t/${tenantId}/rooms/${roomId}/chat`],
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <RouterProvider router={router} />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryData<{ name: string }>(
          roomQueryKey(tenantId, roomId),
        )?.name,
      ).toBe("before watermark"),
    );
    expect(refreshRoom).toHaveBeenCalledTimes(1);
    expect(subscriptions.starts).not.toHaveBeenCalled();
    revision = "after watermark";
    await act(async () => messageGate.resolve());
    expect(await screen.findByText(/^Chat room-all:/)).toBeVisible();
    expect(subscriptions.starts).not.toHaveBeenCalled();
    const draft = screen.getByLabelText("Draft");
    fireEvent.change(draft, { target: { value: "Cold Room draft" } });
    await act(async () => refreshGate.resolve());
    await waitFor(() => expect(subscriptions.starts).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Draft")).toBe(draft);
    expect(draft).toHaveValue("Cold Room draft");
    expect(subscriptions.stops).not.toHaveBeenCalled();
    expect(refreshRoom).toHaveBeenCalledTimes(2);
    expect(
      queryClient.getQueryData<{ name: string }>(roomQueryKey(tenantId, roomId))
        ?.name,
    ).toBe("after watermark");
  });

  it("shows cached chat before refresh and waits to start realtime without remounting the draft", async () => {
    const { gate, queryClient, runtime } = await setup();
    const messagesKey = roomMessagesInfiniteQueryOptions(
      runtime.client,
      tenantId,
      roomId,
    ).queryKey;
    const snapshot = queryClient.getQueryData(messagesKey)!;
    const initialRoomSeq = snapshot.pages[0]!.snapshot_room_seq;
    try {
      expect(await screen.findByText(/^Chat room-all:/)).toBeVisible();
      expect(subscriptions.starts).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText("Draft"), {
        target: { value: "Keep my draft" },
      });
      // A background Message refresh must not move the bootstrap cursor.
      await act(async () =>
        queryClient.setQueryData(messagesKey, {
          ...snapshot,
          pages: snapshot.pages.map((page) => ({
            ...page,
            snapshot_room_seq: initialRoomSeq + 50,
          })),
        }),
      );
    } finally {
      await act(async () => gate.resolve());
    }
    await waitFor(() => expect(subscriptions.starts).toHaveBeenCalledTimes(1));
    expect(subscriptions.starts).toHaveBeenCalledWith(roomId, initialRoomSeq);
    expect(screen.getByLabelText("Draft")).toHaveValue("Keep my draft");
    expect(subscriptions.stops).not.toHaveBeenCalled();
  });

  it("keeps a cold Room behind bootstrap", async () => {
    const { gate } = await setup({ cached: false });
    expect(screen.queryByText(/^Chat room-all:/)).not.toBeInTheDocument();
    expect(subscriptions.starts).not.toHaveBeenCalled();
    await act(async () => gate.resolve());
    expect(await screen.findByText(/^Chat room-all:/)).toBeVisible();
  });

  it.each([401, 403, 404])(
    "never presents cold messages when Room authorization returns %s",
    async (httpStatus) => {
      const { gate, queryClient } = await setup({ cached: false });
      expect(screen.queryByText(/^Chat room-all:/)).not.toBeInTheDocument();
      await act(async () =>
        gate.resolve(
          teamHubErrorResponse(httpStatus, "UNAVAILABLE", "Room unavailable"),
        ),
      );
      expect(
        await screen.findByRole("heading", {
          name: /not found|access|could not|unavailable|not available/i,
        }),
      ).toBeVisible();
      expect(screen.queryByText(/^Chat room-all:/)).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          queryClient
            .getQueriesData({ queryKey: roomQueryKey(tenantId, roomId) })
            .every(([, data]) => data === undefined),
        ).toBe(true),
      );
      expect(subscriptions.starts).not.toHaveBeenCalled();
    },
  );

  it("does not present an invalidated Room cache before revalidation", async () => {
    const { gate } = await setup({ invalidated: true });
    expect(screen.queryByText(/^Chat room-all:/)).not.toBeInTheDocument();
    expect(subscriptions.starts).not.toHaveBeenCalled();
    await act(async () => gate.resolve());
    expect(await screen.findByText(/^Chat room-all:/)).toBeVisible();
  });

  it.each([401, 403, 404])(
    "removes cached content on an authoritative %s denial",
    async (httpStatus) => {
      const { gate, queryClient } = await setup();
      await act(async () =>
        gate.resolve(
          teamHubErrorResponse(httpStatus, "UNAVAILABLE", "Room unavailable"),
        ),
      );
      expect(
        await screen.findByRole("heading", {
          name: /not found|access|could not|unavailable|not available/i,
        }),
      ).toBeVisible();
      expect(screen.queryByText(/^Chat room-all:/)).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          queryClient
            .getQueriesData({ queryKey: roomQueryKey(tenantId, roomId) })
            .every(([, data]) => data === undefined),
        ).toBe(true),
      );
      expect(subscriptions.starts).not.toHaveBeenCalled();
    },
  );

  it("does not start an abandoned Room subscription when its refresh finishes late", async () => {
    const { gate, router } = await setup();
    try {
      expect(await screen.findByText(/^Chat room-all:/)).toBeVisible();
      await act(async () =>
        router.navigate(`/t/${tenantId}/rooms/room-gtm-launch/chat`),
      );
      expect(await screen.findByText(/^Chat room-gtm-launch:/)).toBeVisible();
    } finally {
      await act(async () => gate.resolve());
    }
    expect(screen.queryByText(/^Chat room-all:/)).not.toBeInTheDocument();
    expect(
      subscriptions.starts.mock.calls.every(([id]) => id === "room-gtm-launch"),
    ).toBe(true);
  });
});
