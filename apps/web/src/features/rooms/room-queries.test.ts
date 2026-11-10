// @vitest-environment jsdom
import {
  type InfiniteData,
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { createTeamHubTestSeed } from "@/test/teamhub-seed";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type {
  TeamHubMessage,
  TeamHubMessagePage,
} from "@/features/teamhub/teamhub-types";

import {
  roomDocumentsQueryOptions,
  roomMembersQueryOptions,
  roomMessagesInfiniteQueryOptions,
  roomMessagesQueryKey,
  roomQueryOptions,
  tenantActorsQueryOptions,
  tenantAgentAvailabilityQueryOptions,
  tenantAgentsQueryOptions,
  tenantRoomsQueryOptions,
} from "./room-queries";

describe("Room query scope", () => {
  it("reuses a recent Message snapshot on remount and still refreshes on invalidation", async () => {
    const runtime = createTestTeamHubRuntime();

    const listMessages = () =>
      runtime.server.requestsTo("GET", "/v0/rooms/{roomId}/messages");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const options = roomMessagesInfiniteQueryOptions(
      runtime.client,
      "tenant-northstar",
      "room-all",
    );
    await queryClient.fetchInfiniteQuery(options);
    const observer = new InfiniteQueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      expect(listMessages()).toHaveLength(1);
      await queryClient.invalidateQueries({
        queryKey: options.queryKey,
        exact: true,
      });
      expect(listMessages()).toHaveLength(2);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it("does not poll the Agent directory; Local observations have a bounded refresh", async () => {
    const runtime = createTestTeamHubRuntime();

    expect(
      tenantAgentsQueryOptions(runtime.client, "tenant-northstar")
        .refetchInterval,
    ).toBeUndefined();
    expect(
      tenantAgentAvailabilityQueryOptions(runtime.client, "tenant-northstar")
        .refetchInterval,
    ).toBeTypeOf("function");
    expect(
      tenantAgentAvailabilityQueryOptions(runtime.client, "tenant-northstar")
        .staleTime,
    ).toBe(2_000);
  });

  it.each([true, false])(
    "refreshes only Local observations and stops when unmounted (local=%s)",
    async (local) => {
      const runtime = createTestTeamHubRuntime();

      const snapshot = await teamHubData(
        runtime.client.api.GET("/v0/tenants/{tenantId}/agent-availability", {
          params: { path: { tenantId: "tenant-northstar" } },
        }),
      );
      const localSnapshot = {
        ...snapshot,
        items: snapshot.items.map((item) => ({
          ...item,
          local_runtime_status: {
            computer_id: "local",
            display_name: "Computer",
            computer_status: "unknown" as const,
            runtime_type: "codex" as const,
            status: "ready" as const,
            connection_status: "reconnecting" as const,
            observed_at: "2026-09-28T01:00:00Z",
          },
        })),
      };
      const fetch = vi.fn(() =>
        local
          ? localSnapshot
          : {
              ...snapshot,
              items: snapshot.items.map((item) => ({
                ...item,
                local_runtime_status: undefined,
              })),
            },
      );
      runtime.server.on(
        "GET",
        "/v0/tenants/{tenantId}/agent-availability",
        fetch,
      );
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      vi.useFakeTimers();
      const observer = new QueryObserver(
        client,
        tenantAgentAvailabilityQueryOptions(runtime.client, "tenant-northstar"),
      );
      const unsubscribe = observer.subscribe(() => undefined);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(1);
        observer.setOptions(
          tenantAgentAvailabilityQueryOptions(
            runtime.client,
            "tenant-northstar",
          ),
        );
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fetch).toHaveBeenCalledTimes(local ? 2 : 1);
        unsubscribe();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetch).toHaveBeenCalledTimes(local ? 2 : 1);
      } finally {
        unsubscribe();
        client.clear();
        vi.useRealTimers();
      }
    },
  );

  it("loads 50 latest Messages for the initial Room snapshot", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await queryClient.fetchInfiniteQuery(
      roomMessagesInfiniteQueryOptions(
        runtime.client,
        "tenant-northstar",
        "room-all",
      ),
    );

    const [request] = runtime.server.requestsTo(
      "GET",
      "/v0/rooms/{roomId}/messages",
    );
    expect(new URL(request!.url).pathname).toBe("/v0/rooms/room-all/messages");
    expect([...new URL(request!.url).searchParams]).toEqual([["limit", "50"]]);
  });

  it("loads every Message exactly once across the 50 item boundary", async () => {
    const runtime = createTestTeamHubRuntime();
    const messages = Array.from({ length: 55 }, (_, index) =>
      message(`message-${String(index + 1).padStart(3, "0")}`),
    );
    const firstOlderMessage = messages[5]!;
    runtime.server.on("GET", "/v0/rooms/{roomId}/messages", ({ query }) => {
      if (!query.get("cursor")) {
        return {
          items: messages.slice(5),
          page: {
            has_more: true,
            next_cursor: firstOlderMessage.id,
          },
          snapshot_room_seq: 55,
        };
      }
      return {
        items: messages.slice(0, 5),
        page: { has_more: false },
        snapshot_room_seq: 55,
      };
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = new InfiniteQueryObserver(
      queryClient,
      roomMessagesInfiniteQueryOptions(
        runtime.client,
        "tenant-northstar",
        "room-all",
      ),
    );
    const unsubscribe = observer.subscribe(() => undefined);

    await observer.refetch();
    await observer.fetchNextPage();

    const loaded = observer
      .getCurrentResult()
      .data?.pages.slice()
      .reverse()
      .flatMap((page) => page.items);
    expect(loaded?.map((item) => item.id)).toEqual(
      messages.map((item) => item.id),
    );
    expect(new Set(loaded?.map((item) => item.id)).size).toBe(55);
    unsubscribe();
  });

  it("fails closed when an accessible Room is placed under another Tenant route", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(
      queryClient.fetchQuery(
        roomQueryOptions(runtime.client, "tenant-other", "room-all"),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      queryClient.fetchQuery(
        roomMembersQueryOptions(runtime.client, "tenant-other", "room-all"),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      queryClient.fetchInfiniteQuery(
        roomMessagesInfiniteQueryOptions(
          runtime.client,
          "tenant-other",
          "room-all",
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      queryClient.fetchQuery(
        roomDocumentsQueryOptions(runtime.client, "tenant-other", "room-all"),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("uses the public contract page limit for Room Documents", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await queryClient.fetchQuery(
      roomDocumentsQueryOptions(runtime.client, "tenant-northstar", "room-all"),
    );

    const [load] = runtime.server.requestsTo(
      "GET",
      "/v0/rooms/{roomId}/documents",
    );
    expect(new URL(load!.url).pathname).toBe("/v0/rooms/room-all/documents");
    expect(new URL(load!.url).searchParams.get("limit")).toBe("100");
  });

  it.each([
    [10, 20, 10],
    [20, 10, 10],
    [undefined, 20, undefined],
    [20, undefined, undefined],
  ])(
    "keeps a conservative member watermark across pages (%s, %s)",
    async (firstSeq, lastSeq, expected) => {
      const runtime = createTestTeamHubRuntime();

      const members = (await listRoomMembers(runtime, "room-all")).items;
      runtime.server.on("GET", "/v0/rooms/{roomId}/members", ({ query }) =>
        query.get("cursor") === "next"
          ? {
              items: members.slice(1),
              page: { has_more: false },
              snapshot_room_seq: lastSeq,
            }
          : {
              items: members.slice(0, 1),
              page: { has_more: true, next_cursor: "next" },
              snapshot_room_seq: firstSeq,
            },
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const page = await queryClient.fetchQuery(
        roomMembersQueryOptions(runtime.client, "tenant-northstar", "room-all"),
      );
      expect(page).toMatchObject({ items: members });
      expect((page as { snapshot_room_seq?: number }).snapshot_room_seq).toBe(
        expected,
      );
    },
  );

  it("loads every opaque cursor page for Room, Actor, and member directories", async () => {
    const runtime = createTestTeamHubRuntime();

    const tenant = runtime.seed.tenant;
    const actors = runtime.seed.actors;
    const agents = (
      await teamHubData(
        runtime.client.api.GET("/v0/tenants/{tenantId}/agents", {
          params: { path: { tenantId: tenant.id } },
        }),
      )
    ).items;
    const rooms = (
      await teamHubData(
        runtime.client.api.GET("/v0/tenants/{tenantId}/rooms", {
          params: { path: { tenantId: tenant.id } },
        }),
      )
    ).items;
    const members = (await listRoomMembers(runtime, "room-all")).items;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const agentMidpoint = Math.max(1, Math.ceil(agents.length / 2));
    const actorMidpoint = Math.max(1, Math.ceil(actors.length / 2));
    runtime.server.on("GET", "/v0/tenants/{tenantId}/actors", ({ query }) =>
      query.get("cursor") === "next"
        ? { items: actors.slice(actorMidpoint), page: { has_more: false } }
        : {
            items: actors.slice(0, actorMidpoint),
            page: { has_more: true, next_cursor: "next" },
          },
    );
    runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", ({ query }) =>
      query.get("cursor") === "next"
        ? { items: agents.slice(agentMidpoint), page: { has_more: false } }
        : {
            items: agents.slice(0, agentMidpoint),
            page: { has_more: true, next_cursor: "next" },
          },
    );
    routeTwoPages(runtime, "/v0/tenants/{tenantId}/rooms", rooms);
    routeTwoPages(runtime, "/v0/rooms/{roomId}/members", members);

    const [actorPage, agentPage, roomPage, memberPage] = await Promise.all([
      queryClient.fetchQuery(
        tenantActorsQueryOptions(runtime.client, tenant.id),
      ),
      queryClient.fetchQuery(
        tenantAgentsQueryOptions(runtime.client, tenant.id),
      ),
      queryClient.fetchQuery(
        tenantRoomsQueryOptions(runtime.client, tenant.id),
      ),
      queryClient.fetchQuery(
        roomMembersQueryOptions(runtime.client, tenant.id, "room-all"),
      ),
    ]);

    expect(actorPage.items).toEqual(actors);
    expect(agentPage.items).toEqual(agents);
    expect(roomPage.items).toEqual(rooms);
    expect(memberPage.items).toEqual(members);
  });

  it("does not poll Tenant Agents after the initial directory snapshot", async () => {
    vi.useFakeTimers();
    try {
      const runtime = createTestTeamHubRuntime();

      const listAgents = () =>
        runtime.server.requestsTo("GET", "/v0/tenants/{tenantId}/agents")
          .length;
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const observer = new QueryObserver(
        queryClient,
        tenantAgentsQueryOptions(runtime.client, "tenant-northstar"),
      );
      const unsubscribe = observer.subscribe(() => undefined);

      await vi.advanceTimersByTimeAsync(0);
      expect(listAgents()).toBe(1);
      expect(
        tenantAgentsQueryOptions(runtime.client, "tenant-northstar")
          .refetchInterval,
      ).toBeUndefined();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(listAgents()).toBe(1);
      unsubscribe();
      queryClient.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when TeamHub repeats a pagination cursor", async () => {
    const runtime = createTestTeamHubRuntime();

    const actors = runtime.seed.actors;
    runtime.server.on("GET", "/v0/tenants/{tenantId}/actors", ({ query }) => ({
      items: query.get("cursor") ? [] : actors,
      page: { has_more: true, next_cursor: "repeated" },
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(
      queryClient.fetchQuery(
        tenantActorsQueryOptions(runtime.client, "tenant-northstar"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_PAGINATION", status: 502 });
  });

  it.each([
    ["missing", undefined, undefined, [undefined]],
    ["repeated", "cursor-a", "cursor-a", [undefined, "cursor-a"]],
    ["cyclic", "cursor-a", "cursor-b", [undefined, "cursor-a"]],
  ])(
    "rejects a %s Room Message continuation cursor",
    (_label, nextCursor, requestedCursor, pageParams) => {
      const runtime = createTestTeamHubRuntime();
      const options = roomMessagesInfiniteQueryOptions(
        runtime.client,
        "tenant-northstar",
        "room-all",
      );
      const page = {
        items: [],
        page: { has_more: true, next_cursor: nextCursor },
        snapshot_room_seq: 0,
      };

      expect(() =>
        options.getNextPageParam(page, [page], requestedCursor, pageParams),
      ).toThrow(/invalid Room Message cursor/);
    },
  );

  it("stops automatic Room history scans at a bounded page count", () => {
    const runtime = createTestTeamHubRuntime();
    const options = roomMessagesInfiniteQueryOptions(
      runtime.client,
      "tenant-northstar",
      "room-all",
    );
    const pages = Array.from({ length: 100 }, (_, index) => ({
      items: [],
      page: { has_more: true, next_cursor: `cursor-${index + 1}` },
      snapshot_room_seq: 0,
    }));
    const pageParams = pages.map((_, index) =>
      index === 0 ? undefined : `cursor-${index}`,
    );

    expect(() =>
      options.getNextPageParam(
        pages.at(-1)!,
        pages,
        pageParams.at(-1),
        pageParams,
      ),
    ).toThrow(/more Room history/);
  });
});

describe("Room Message query reconciliation", () => {
  it("keeps a newer cached card when an older in-flight query resolves", async () => {
    const runtime = createTestTeamHubRuntime();

    const fixture = createTeamHubTestSeed();
    const source = fixture.messagesByRoom
      .get("room-product-v0")
      ?.find((message) => message.id === "message-card-room-creation");
    if (!source?.card) throw new Error("Typed card fixture is unavailable");

    const staleCard = withCardVersion(source, 2);
    const newerCard = withCardVersion(source, 3);
    const cachedOrdinary = withoutCard(source, "Cached ordinary Message");
    const serverOrdinary = withoutCard(source, "Server ordinary Message");
    const response = deferred<TeamHubMessagePage>();
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages",
      () => response.promise,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const queryKey = roomMessagesQueryKey(
      "tenant-northstar",
      "room-product-v0",
    );

    const pendingQuery = queryClient.fetchInfiniteQuery(
      roomMessagesInfiniteQueryOptions(
        runtime.client,
        "tenant-northstar",
        "room-product-v0",
      ),
    );
    queryClient.setQueryData<InfiniteData<TeamHubMessagePage>>(queryKey, {
      pageParams: [undefined],
      pages: [
        {
          items: [newerCard, cachedOrdinary],
          page: { has_more: false },
          snapshot_room_seq: 3,
        },
      ],
    });
    response.resolve({
      items: [staleCard, serverOrdinary],
      page: { has_more: false },
      snapshot_room_seq: 3,
    });

    await pendingQuery;

    const cached =
      queryClient.getQueryData<InfiniteData<TeamHubMessagePage>>(queryKey);
    expect(cached?.pages[0]?.items).toEqual([newerCard, serverOrdinary]);
  });
});

/** Serves items as two opaque cursor pages. */
function routeTwoPages(
  runtime: TestTeamHubRuntime,
  path: "/v0/rooms/{roomId}/members" | "/v0/tenants/{tenantId}/rooms",
  items: unknown[],
) {
  const midpoint = Math.max(1, Math.ceil(items.length / 2));
  runtime.server.on("GET", path, ({ query }) =>
    query.get("cursor") === "next"
      ? { items: items.slice(midpoint), page: { has_more: false } }
      : {
          items: items.slice(0, midpoint),
          page: { has_more: true, next_cursor: "next" },
        },
  );
}

function listRoomMembers(runtime: TestTeamHubRuntime, roomId: string) {
  return teamHubData(
    runtime.client.api.GET("/v0/rooms/{roomId}/members", {
      params: { path: { roomId } },
    }),
  );
}

function withCardVersion(
  message: TeamHubMessage,
  version: number,
): TeamHubMessage {
  if (!message.card) throw new Error("Typed card fixture is unavailable");
  return { ...message, card: { ...message.card, version } };
}

function message(id: string): TeamHubMessage {
  return {
    attachments: [],
    author: {
      display_name: "Codex",
      id: "actor-codex",
      kind: "agent",
      tenant_id: "tenant-northstar",
    },
    created_at: "2026-07-23T10:00:00Z",
    id,
    message_kind: "conversation",
    raw_message: id,
    room_id: "room-all",
    segments: [{ content: id, type: "text" }],
    tenant_id: "tenant-northstar",
  };
}

function withoutCard(message: TeamHubMessage, body: string): TeamHubMessage {
  const ordinary = {
    ...message,
    id: `${message.id}-ordinary`,
    raw_message: body,
    segments: [{ content: body, type: "text" as const }],
  };
  delete ordinary.card;
  return ordinary;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
