import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import {
  anotherMeQueryKey,
  roomDocumentsQueryKey,
  roomMembersQueryKey,
  roomQueryKey,
} from "@/features/rooms/room-queries";

import { createAppRoutes } from "./router";

const routeFixture = vi.hoisted(() => ({ chatError: null as Error | null }));

vi.mock("@/features/auth/teamhub-login-page", () => ({
  TeamHubLoginPage: () => <h1>TeamHub sign in</h1>,
}));
vi.mock("@/features/apps/oauth-complete-page", () => ({
  OAUTH_COMPLETE_PATH: "/oauth/composio-complete",
  OAuthCompletePage: () => <h1>Authorization complete</h1>,
}));
vi.mock("@/features/local-computer/computers-page", () => ({
  ComputersPage: () => <h1>Local computers</h1>,
}));
vi.mock("@/features/rooms/room-shell", () => ({
  RoomShell: () => (
    <div>
      <p>Room shell</p>
      <Outlet />
    </div>
  ),
}));
vi.mock("@/features/rooms/room-surface", () => ({
  RoomSurface: () => <Outlet />,
}));
vi.mock("@/features/rooms/chat/room-chat", () => ({
  RoomChat: () => {
    if (routeFixture.chatError) throw routeFixture.chatError;
    return <h1>Fixture Room Chat</h1>;
  },
}));
vi.mock("@/features/rooms/room-empty-page", () => ({
  RoomEmptyPage: () => <h1>Create Room</h1>,
}));
vi.mock("@/features/library/library-layout", () => ({
  LibraryLayout: () => <Outlet />,
}));
vi.mock("@/features/library/library-documents-page", () => ({
  LibraryDocumentsPage: () => <h1>Fixture Documents</h1>,
}));
vi.mock("@/features/wiki/wiki-collection-page", () => ({
  WikiCollectionPage: () => <h1>Fixture Wiki Profile</h1>,
}));
vi.mock("@/features/memory/wiki-graph-page", () => ({
  WikiGraphPage: () => <h1>Fixture Wiki Graph</h1>,
}));
vi.mock("@/features/memory/meeting-page", () => ({
  MeetingPage: () => <h1>Fixture Meeting</h1>,
}));
vi.mock("@/features/work-items/work-items-page", () => ({
  WorkItemsPage: () => <h1>Fixture Dashboard</h1>,
}));

describe("TeamHub routes", () => {
  it("starts the Agent directory before the Room snapshot and does not gate chat on it", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = testQueryClient();
    let releaseMessages!: () => void;
    let releaseDirectory!: () => void;
    const messagesGate = new Promise<void>((resolve) => {
      releaseMessages = resolve;
    });
    const directoryGate = new Promise<void>((resolve) => {
      releaseDirectory = resolve;
    });
    // A second runtime on the same seed answers the held Message snapshot.
    const seeded = createTestTeamHubRuntime(runtime.seed);
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages",
      async ({ request }) => {
        await messagesGate;
        return seeded.server.fetch(request);
      },
    );
    const directory = vi.fn(async () => {
      await directoryGate;
      return { items: runtime.seed.tenantAgents, page: { has_more: false } };
    });
    runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", directory);
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/t/tenant-northstar/rooms/room-all/chat"],
    });
    renderApp(queryClient, runtime, router);
    try {
      await waitFor(() => expect(directory).toHaveBeenCalledTimes(1));
      releaseMessages();
      expect(
        await screen.findByRole("heading", { name: "Fixture Room Chat" }),
      ).toBeVisible();
    } finally {
      releaseMessages();
      releaseDirectory();
      router.dispose();
      queryClient.clear();
    }
  });

  beforeEach(() => {
    routeFixture.chatError = null;
  });

  it("keeps the Composio OAuth completion route public", async () => {
    const runtime = createTestTeamHubRuntime();
    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/oauth/composio-complete"],
    });

    renderApp(queryClient, runtime, router);

    expect(
      await screen.findByRole("heading", { name: "Authorization complete" }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe("/oauth/composio-complete");
  });

  it("redirects an unauthenticated Product Client to TeamHub login", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/session", () =>
      teamHubErrorResponse(401, "UNAUTHENTICATED", "Sign in to continue."),
    );
    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/"],
    });

    renderApp(queryClient, runtime, router);

    expect(
      await screen.findByRole("heading", { name: "TeamHub sign in" }),
    ).toBeVisible();
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toBe("");
  });

  it("keeps an unauthenticated visitor on the login page", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/session", () =>
      teamHubErrorResponse(401, "UNAUTHENTICATED", "Sign in to continue."),
    );
    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/login"],
    });

    renderApp(queryClient, runtime, router);

    expect(
      await screen.findByRole("heading", { name: "TeamHub sign in" }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("sends an authenticated visitor from the login page to the product entry", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/login"],
    });

    renderApp(queryClient, runtime, router);

    expect(
      await screen.findByRole("heading", { name: "Fixture Room Chat" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/t/tenant-northstar/rooms/room-another-me/chat",
      ),
    );
  });

  it("returns an authenticated visitor from the login page to the pending Local Computer setup", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = testQueryClient();
    const setupPath =
      "/connect-computer?redirect_uri=http%3A%2F%2F127.0.0.1%3A64747%2Fcallback&state=setup-state&code_challenge=setup-challenge";
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: [`/login?return_to=${encodeURIComponent(setupPath)}`],
    });

    renderApp(queryClient, runtime, router);

    await waitFor(() =>
      expect(
        `${router.state.location.pathname}${router.state.location.search}`,
      ).toBe(setupPath),
    );
  });

  it("preserves the unauthenticated Local Computer setup return path", async () => {
    const setupPath =
      "/connect-computer?redirect_uri=http%3A%2F%2F127.0.0.1%3A64747%2Fcallback&state=setup-state&code_challenge=setup-challenge";
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/session", () =>
      teamHubErrorResponse(401, "UNAUTHENTICATED", "Sign in to continue."),
    );
    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: [setupPath],
    });

    renderApp(queryClient, runtime, router);

    expect(
      await screen.findByRole("heading", { name: "TeamHub sign in" }),
    ).toBeVisible();
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(
      new URLSearchParams(router.state.location.search).get("return_to"),
    ).toBe(setupPath);
  });

  it("resolves the first Tenant and Room through the shared query cache", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/tenants/{tenantId}/another-me", () => ({}));

    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/"],
    });

    renderApp(queryClient, runtime, router);

    expect(
      await screen.findByRole("heading", { name: "Fixture Room Chat" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/t/tenant-northstar/rooms/room-all/chat",
      ),
    );
    expect(queryClient.getQueryData(["teamhub", "tenants"])).toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ id: "tenant-northstar" })],
      }),
    );
  });

  it("opens the Another Me Chat from the Room index and preserves Settings", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/t/tenant-northstar/rooms?settings=account"],
    });

    renderApp(queryClient, runtime, router);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/t/tenant-northstar/rooms/room-another-me/chat",
      ),
    );
    expect(router.state.location.search).toBe("?settings=account");
  });

  it("falls back to the first Room when Another Me cannot be loaded", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/tenants/{tenantId}/another-me", () =>
      teamHubErrorResponse(500, "INTERNAL", "Unavailable"),
    );
    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/"],
    });

    renderApp(queryClient, runtime, router);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/t/tenant-northstar/rooms/room-all/chat",
      ),
    );
  });

  it("falls back to the first Room when the cached Another Me Room is unavailable", async () => {
    const runtime = createTestTeamHubRuntime();
    const queryClient = testQueryClient();
    queryClient.setQueryData(anotherMeQueryKey("tenant-northstar"), {
      agent_actor_id: "actor-delegate",
      room_id: "room-unavailable",
    });
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/t/tenant-northstar/rooms"],
    });

    renderApp(queryClient, runtime, router);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/t/tenant-northstar/rooms/room-all/chat",
      ),
    );
  });

  it("opens Library Overview and Wiki and keeps the Library query", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/t/tenant-northstar/library?artifact=one"],
    });

    renderApp(queryClient, runtime, router);

    expect(
      await screen.findByRole("heading", { name: "Fixture Documents" }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe("/t/tenant-northstar/library");
    expect(router.state.location.search).toBe("?artifact=one");
    await router.navigate("/t/tenant-northstar/library/wiki");
    expect(
      await screen.findByRole("heading", { name: "Fixture Wiki Profile" }),
    ).toBeVisible();
    await router.navigate("/t/tenant-northstar/library/wiki/graph");
    expect(
      await screen.findByRole("heading", { name: "Fixture Wiki Profile" }),
    ).toBeVisible();
    await router.navigate(
      "/t/tenant-northstar/library/meetings?entry=meeting_one",
    );
    expect(
      await screen.findByRole("heading", { name: "Fixture Meeting" }),
    ).toBeVisible();
    await router.navigate("/t/tenant-northstar/library/meetings");
    await waitFor(() =>
      expect(router.state.location.search).toBe("?tab=meetings"),
    );
    expect(router.state.location.pathname).toBe("/t/tenant-northstar/library");
    await router.navigate("/t/tenant-northstar/library/documents");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/t/tenant-northstar/library",
      ),
    );
  });

  it("opens the Local computers address as the Computers Settings page", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/t/tenant-northstar/computers?computer=computer-1"],
    });

    renderApp(queryClient, runtime, router);

    expect(await screen.findByText("Room shell")).toBeVisible();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/t/tenant-northstar/settings/computers",
      ),
    );
    expect(router.state.location.search).toBe("?computer=computer-1");
  });

  it("keeps the Room shell visible when one Room view fails", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = testQueryClient();
    routeFixture.chatError = new Error("Chat projection unavailable.");
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/t/tenant-northstar/rooms/room-all/chat"],
    });

    renderApp(queryClient, runtime, router);

    expect(await screen.findByText("Room shell")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "This view could not be loaded" }),
    ).toBeVisible();
    expect(screen.getByText("Chat projection unavailable.")).toBeVisible();
  });

  it("opens an authorized Room without waiting for the sidebar Room list", async () => {
    const runtime = createTestTeamHubRuntime();

    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/rooms",
      () => new Promise(() => {}),
    );
    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/t/tenant-northstar/rooms/room-all/chat"],
    });
    renderApp(queryClient, runtime, router);
    expect(
      await screen.findByRole("heading", { name: "Fixture Room Chat" }),
    ).toBeVisible();
    router.dispose();
    queryClient.clear();
  });

  it("loads Room projections alongside the Message snapshot without losing its watermark", async () => {
    const runtime = createTestTeamHubRuntime();

    const tenantId = "tenant-northstar";
    const roomId = "room-all";
    const queryClient = testQueryClient();
    queryClient.setQueryData(roomQueryKey(tenantId, roomId), {
      id: roomId,
      tenant_id: tenantId,
    });
    queryClient.setQueryData(roomMembersQueryKey(tenantId, roomId), {
      items: [],
      page: { has_more: false },
    });
    queryClient.setQueryData(roomDocumentsQueryKey(tenantId, roomId), {
      items: [],
      page: { has_more: false },
    });
    const cancelled: string[] = [];
    const staleRequests = [
      startAbortableQuery(
        queryClient,
        roomQueryKey(tenantId, roomId),
        "room",
        cancelled,
      ),
      startAbortableQuery(
        queryClient,
        roomMembersQueryKey(tenantId, roomId),
        "members",
        cancelled,
      ),
    ];
    // A second runtime on the same seed answers the recorded projection reads.
    const seeded = createTestTeamHubRuntime(runtime.seed);
    const lifecycle: string[] = [];
    let releaseMessages!: () => void;
    const messageSnapshot = new Promise<void>((resolve) => {
      releaseMessages = resolve;
    });
    const listMessagesSpy = vi.fn(async ({ request }: TestRouteRequest) => {
      lifecycle.push("messages-started");
      await messageSnapshot;
      lifecycle.push("messages-completed");
      return seeded.server.fetch(request);
    });
    runtime.server
      .on("GET", "/v0/rooms/{roomId}/messages", listMessagesSpy)
      .on("GET", "/v0/rooms/{roomId}", ({ request }) => {
        lifecycle.push("room");
        return seeded.server.fetch(request);
      })
      .on("GET", "/v0/rooms/{roomId}/members", ({ request }) => {
        lifecycle.push("members");
        return seeded.server.fetch(request);
      });
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: [`/t/${tenantId}/rooms/${roomId}/chat`],
    });

    renderApp(queryClient, runtime, router);

    await waitFor(() => expect(listMessagesSpy).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(lifecycle).toEqual(
        expect.arrayContaining(["messages-started", "room", "members"]),
      ),
    );
    expect(lifecycle).not.toContain("messages-completed");
    releaseMessages();
    expect(
      await screen.findByRole("heading", { name: "Fixture Room Chat" }),
    ).toBeVisible();
    expect(lifecycle[0]).toBe("messages-started");
    expect(lifecycle.slice(1, 3).sort()).toEqual(["members", "room"]);
    expect(lifecycle[3]).toBe("messages-completed");
    await waitFor(() => expect(cancelled.sort()).toEqual(["members", "room"]));
    await Promise.all(staleRequests);
  });

  it("commits a Room navigation before the destination Message snapshot resolves", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/t/tenant-northstar/rooms/room-all/chat"],
    });

    renderApp(queryClient, runtime, router);
    expect(
      await screen.findByRole("heading", { name: "Fixture Room Chat" }),
    ).toBeVisible();

    // A second runtime on the same seed answers the held Message snapshot.
    const seeded = createTestTeamHubRuntime(runtime.seed);
    let releaseMessages!: () => void;
    const messagesPending = new Promise<void>((resolve) => {
      releaseMessages = resolve;
    });
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages",
      async ({ params, request }) => {
        if (params.roomId === "room-gtm-launch") {
          await messagesPending;
        }
        return seeded.server.fetch(request);
      },
    );

    const destination = "/t/tenant-northstar/rooms/room-gtm-launch/chat";
    const navigation = router.navigate(destination);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(destination),
    );
    expect(router.state.navigation.state).toBe("idle");

    releaseMessages();
    await navigation;
  });

  it("keeps navigation chrome visible when the TeamHub shell request fails", async () => {
    const runtime = createTestTeamHubRuntime();

    runtime.server.on("GET", "/v0/tenants/{tenantId}/rooms", () =>
      teamHubErrorResponse(
        502,
        "BAD_GATEWAY",
        "TeamHub request failed with status 502.",
      ),
    );
    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/t/tenant-northstar/rooms"],
    });

    renderApp(queryClient, runtime, router);

    expect(await screen.findByText("Room shell")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "This view could not be loaded" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("keeps application chrome visible when initial TeamHub discovery fails", async () => {
    const runtime = createTestTeamHubRuntime();

    runtime.server.on("GET", "/v0/tenants", () =>
      teamHubErrorResponse(
        502,
        "BAD_GATEWAY",
        "TeamHub request failed with status 502.",
      ),
    );
    const queryClient = testQueryClient();
    const router = createMemoryRouter(createAppRoutes(queryClient, runtime), {
      initialEntries: ["/"],
    });

    renderApp(queryClient, runtime, router);

    expect(
      await screen.findByRole("complementary", {
        name: "Collaboration sidebar",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "TeamHub unavailable" }),
    ).toBeVisible();
  });
});

function renderApp(
  queryClient: QueryClient,
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  router: ReturnType<typeof createMemoryRouter>,
) {
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

function testQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function startAbortableQuery(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  label: string,
  cancelled: string[],
) {
  return queryClient
    .fetchQuery({
      queryFn: ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled.push(label);
              reject(new Error(`${label} stale request cancelled`));
            },
            { once: true },
          );
        }),
      queryKey,
      staleTime: 0,
    })
    .catch(() => undefined);
}
