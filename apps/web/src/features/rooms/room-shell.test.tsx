import {
  QueryClient,
  QueryClientProvider,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Suspense } from "react";
import {
  createMemoryRouter,
  Link,
  RouterProvider,
  useParams,
} from "react-router";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import { SettingsLayout } from "@/features/settings/settings-page";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import {
  type TeamHubRuntime,
  TeamHubRuntimeProvider,
} from "@/features/teamhub/teamhub-runtime";

import { teamHubIdentityQueryKey } from "./room-queries";
import { browserRoomMessageOutbox } from "./chat/room-message-outbox";
import { RoomShell } from "./room-shell";
import {
  voiceNavigate,
  voiceSearch,
  voiceSearchResults,
} from "./chat/voice-mode/voice-ui-bridge";
import { useOptionalVoiceControl } from "./voice-control/voice-control-context";

afterEach(() => vi.restoreAllMocks());

describe("Room shell Account menu", () => {
  it.each(["listRooms", "getAnotherMe"] as const)(
    "keeps Room content usable while %s loads",
    async (method) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { anotherMe, listRooms, runtime } = await renderAccountShell({
        initialEntry: "/t/tenant-northstar/rooms/room-all/chat",
        ...(method === "getAnotherMe" ? { anotherMeReady: pending } : {}),
        configureRuntime: (runtime, listRooms) => {
          vi.spyOn(runtime.events, "subscribeSignals");
          if (method === "listRooms") {
            const original = listRooms.getMockImplementation()!;
            listRooms.mockImplementation(async (request) => {
              await pending;
              return original(request);
            });
          }
        },
      });
      const content = screen.getByText("Shell content");
      expect(content).toBeVisible();
      // The event stream starts while the sidebar request is still pending.
      await waitFor(() =>
        expect(runtime.events.subscribeSignals).toHaveBeenCalledTimes(1),
      );
      // The list and the Another Me card land together: nothing of the list
      // shows while either is still loading.
      expect(screen.queryByRole("link", { name: "all" })).toBeNull();
      await act(async () => release());
      expect(await screen.findByRole("link", { name: "all" })).toBeVisible();
      expect(screen.getByText("Shell content")).toBe(content);
      expect(method === "listRooms" ? listRooms : anotherMe).toHaveBeenCalled();
      expect(runtime.events.subscribeSignals).toHaveBeenCalledTimes(1);
    },
  );

  it("recovers a failed sidebar list without replacing the current Room", async () => {
    await renderAccountShell({
      initialEntry: "/t/tenant-northstar/rooms/room-all/chat",
      configureRuntime: (_runtime, listRooms) => {
        listRooms.mockImplementationOnce(() => {
          throw new Error("Temporary list failure");
        });
      },
    });
    const content = screen.getByText("Shell content");
    expect(
      await screen.findByRole("button", { name: "Retry Rooms" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry Rooms" }));
    expect(await screen.findByRole("link", { name: "all" })).toBeVisible();
    expect(screen.getByText("Shell content")).toBe(content);
    expect(
      screen.queryByRole("button", { name: "Retry Rooms" }),
    ).not.toBeInTheDocument();
  });

  it("loads the Create Room dialog from the navigation and keeps the shell visible on close", async () => {
    await renderAccountShell({
      initialEntry: "/t/tenant-northstar/rooms/room-all/chat",
    });
    fireEvent.click(await shellControl("Open Room navigation"));
    // The shared create menu lives in the lazily loaded navigation.
    fireEvent.click(await shellControl("Create chat"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Create Room" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Create Room" });
    expect(dialog).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Create Room" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Shell content")).toBeVisible();
  });

  it("opens global search from the shortcut and the rail, even inside a rich-text editor", async () => {
    await renderAccountShell({
      initialEntry: "/t/tenant-northstar/rooms/room-all/chat",
    });
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    document.body.append(editor);
    // The shortcut wins over editor key bindings: it is handled in the capture
    // phase before the editor sees the keystroke.
    const editorSaw = vi.fn();
    editor.addEventListener("keydown", editorSaw);
    await act(async () => {
      await import("@/features/search/global-search-dialog");
      fireEvent.keyDown(editor, { key: "k", metaKey: true });
    });
    const editorDialog = await screen.findByRole("dialog", { name: "Search" });
    expect(editorSaw).not.toHaveBeenCalled();
    fireEvent.keyDown(
      within(editorDialog).getByRole("combobox", {
        name: "Search messages, docs, people, agents and rooms",
      }),
      { key: "Escape" },
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Search" }),
      ).not.toBeInTheDocument(),
    );
    editor.remove();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    const input = within(dialog).getByRole("combobox", {
      name: "Search messages, docs, people, agents and rooms",
    });
    expect(input).toBeVisible();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Search" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(await shellControl("Search"));
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeVisible();
    expect(screen.getByText("Shell content")).toBeVisible();
  });

  it("lets Live voice switch pages and open a search already filled in", async () => {
    await renderAccountShell({
      initialEntry: "/t/tenant-northstar/rooms/room-all/chat",
    });
    await act(async () => {
      await import("@/features/search/global-search-dialog");
    });
    let navigated = false;
    act(() => {
      navigated = voiceNavigate("/t/tenant-northstar/apps");
    });
    expect(navigated).toBe(true);
    act(() => {
      expect(voiceSearch("Launch plan")).toBe(true);
    });
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    const input = within(dialog).getByRole("combobox", {
      name: "Search messages, docs, people, agents and rooms",
    });
    expect(input).toHaveValue("Launch plan");
    // The open dialog offers its results to voice, then stops when closed.
    expect(Array.isArray(voiceSearchResults())).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Search" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("opens the Account menu from the mobile rail and opens the Settings page", async () => {
    const { router, identity } = await renderAccountShell();
    fireEvent.click(await shellControl("Open Room navigation"));
    const trigger = screen.getByRole("button", { name: "Account menu" });
    expect(trigger).toHaveClass("size-11");
    expect(
      screen.queryByRole("link", { name: "Settings" }),
    ).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Account menu" });
    expect(within(menu).getByText("Jenny Bin")).toBeVisible();
    expect(within(menu).getByText(identity.account.email)).toBeVisible();
    const settings = within(menu).getByRole("menuitem", { name: "Settings" });
    await waitFor(() => expect(settings).toHaveFocus());
    fireEvent.keyDown(settings, { key: "ArrowDown" });
    expect(
      within(menu).getByRole("menuitem", { name: "Log out" }),
    ).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    // Settings is a page of the Space shell.
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/t/tenant-northstar/settings/account",
      ),
    );
    expect(screen.getByText("Shell content")).toBeVisible();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close Room navigation" }),
    ).not.toBeInTheDocument();
  }, 20_000);

  it("keeps logout failure visible after the menu and mobile rail close, then retries without duplicates", async () => {
    const { runtime, router } = await renderAccountShell();
    vi.spyOn(browserRoomMessageOutbox, "clearAccount").mockResolvedValue();
    let failLogout!: (error: Error) => void;
    const logout = vi
      .fn<TestRouteHandler>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            failLogout = reject;
          }),
      )
      .mockReturnValue(undefined);
    runtime.server.on("POST", "/v0/auth/logout", logout);
    fireEvent.click(await shellControl("Open Room navigation"));
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close Room navigation" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Room navigation" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const pending = screen.getByRole("menuitem", { name: "Logging out..." });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(logout).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(
      screen.getByRole("button", { name: "Close Room navigation" }),
    );
    await act(async () => failLogout(new Error("Response lost")));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not confirm logout. Please retry.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("still active");
    expect(screen.getByText("Shell content")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry logout" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(logout).toHaveBeenCalledTimes(2);
  });
});

describe("Room shell document title", () => {
  it("names the tab after the Space owner's Tenant actor", async () => {
    document.title = "Linger";
    await renderAccountShell();

    await waitFor(() => expect(document.title).toBe("Jenny Bin's space"));
  });
});

/** The shell suspends on its Tenant bootstrap, which outlasts the default wait. */
function shellControl(name: string) {
  return screen.findByRole("button", { name }, { timeout: 10_000 });
}

async function renderAccountShell({
  anotherMeReady = Promise.resolve(),
  initialEntry = "/t/tenant-northstar/apps",
  nextTenantLoader = Promise.resolve(),
  configureRuntime,
}: {
  /** Holds the Another Me read until it settles. */
  anotherMeReady?: Promise<void>;
  initialEntry?: string;
  nextTenantLoader?: Promise<void>;
  configureRuntime?: (
    runtime: TestTeamHubRuntime,
    listRooms: Mock<TestRouteHandler>,
  ) => void;
} = {}) {
  const runtime = createTestTeamHubRuntime();

  const currentTenant = runtime.seed.tenant;
  const nextTenant = {
    ...currentTenant,
    id: "tenant-southstar",
    name: "Southstar Studio",
  };
  // A second runtime on the same seed answers the current Tenant's Room list.
  const seeded = createTestTeamHubRuntime(runtime.seed);
  const currentAnotherMe = await teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/another-me", {
      params: { path: { tenantId: currentTenant.id } },
    }),
  );
  const anotherMe = vi.fn<TestRouteHandler>(async ({ params }) => {
    await anotherMeReady;
    return params.tenantId === nextTenant.id ? {} : currentAnotherMe;
  });
  runtime.server
    .on(
      "GET",
      "/v0/tenants/{tenantId}",
      ({ params }) =>
        [currentTenant, nextTenant].find(
          (tenant) => tenant.id === params.tenantId,
        ) ?? teamHubErrorResponse(404, "TENANT_NOT_FOUND"),
    )
    .on("GET", "/v0/tenants", () => ({ items: [currentTenant, nextTenant] }))
    .on("GET", "/v0/tenants/{tenantId}/another-me", anotherMe);
  const listRooms = vi.fn<TestRouteHandler>(({ params, request }) =>
    params.tenantId === nextTenant.id
      ? { items: [], page: { has_more: false } }
      : seeded.server.fetch(request),
  );
  runtime.server.on("GET", "/v0/tenants/{tenantId}/rooms", listRooms);
  const identity = runtime.seed.identity;
  configureRuntime?.(runtime, listRooms);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: "/login", element: <p>Signed out</p> },
      {
        path: "/t/:tenantId",
        element: <RoomShell />,
        loader: ({ params }) =>
          params.tenantId === nextTenant.id ? nextTenantLoader : null,
        children: [{ path: "*", element: <p>Shell content</p> }],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <Suspense fallback={<p>Loading</p>}>
          <RouterProvider router={router} />
        </Suspense>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  // CI can take longer than the default one-second query to finish the voice chunk.
  await screen.findByRole(
    "button",
    { name: "Open Room navigation" },
    { timeout: 10_000 },
  );
  return { anotherMe, listRooms, runtime, router, identity };
}

describe("Room shell Tenant transition", () => {
  it("resolves the new account's voice target when identity changes in the same Tenant", async () => {
    const fixture = createTestTeamHubRuntime();

    const identity = fixture.seed.identity;
    let target = await teamHubData(
      fixture.client.api.GET("/v0/tenants/{tenantId}/another-me", {
        params: { path: { tenantId: "tenant-northstar" } },
      }),
    );
    fixture.server.on("GET", "/v0/tenants/{tenantId}/another-me", () => target);
    const runtime: TeamHubRuntime = fixture;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        {
          element: <RoomShell />,
          path: "/t/:tenantId",
          children: [
            { path: "rooms/:roomId/chat", element: <VoiceTargetProbe /> },
          ],
        },
      ],
      { initialEntries: ["/t/tenant-northstar/rooms/room-all/chat"] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <Suspense fallback={<p>Loading</p>}>
            <RouterProvider router={router} />
          </Suspense>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(`Voice target: ${target.room_id}`),
    ).toBeVisible();
    target = {
      ...target,
      room_id: "room-next-account",
      agent_actor_id: "actor-codex",
    };
    act(() => {
      queryClient.setQueryData(teamHubIdentityQueryKey, {
        ...identity,
        account: { ...identity.account, id: "account-next" },
      });
    });
    expect(
      await screen.findByText("Voice target: room-next-account"),
    ).toBeVisible();
  });
  it("replaces the old page with the destination loading surface immediately", async () => {
    const fixture = createTestTeamHubRuntime();

    let releaseMembers!: () => void;
    const membersLoader = new Promise<void>((resolve) => {
      releaseMembers = resolve;
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        {
          children: [
            {
              element: <p>Current Room content</p>,
              path: "rooms/:roomId/chat",
            },
            {
              element: <p>Agent loaded</p>,
              loader: async () => membersLoader,
              path: "library",
            },
          ],
          element: <RoomShell />,
          path: "/t/:tenantId",
        },
      ],
      {
        initialEntries: ["/t/tenant-northstar/rooms/room-all/chat"],
      },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={fixture}>
          <Suspense fallback={<p>Loading workspace</p>}>
            <RouterProvider router={router} />
          </Suspense>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Current Room content")).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "Library" }));

    expect(
      await screen.findByRole("status", { name: "Loading Library" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Messages" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(
      screen.queryByRole("navigation", { name: "Agent navigation" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Current Room content")).not.toBeInTheDocument();

    await act(async () => releaseMembers());
    expect(await screen.findByText("Agent loaded")).toBeVisible();
  });

  it("keeps the Settings navigation mounted while a section loads", async () => {
    const runtime = createTestTeamHubRuntime();

    const router = createMemoryRouter(
      [
        {
          path: "/t/:tenantId",
          element: <RoomShell />,
          children: [
            {
              path: "rooms/:roomId/chat",
              element: <p>Current Room content</p>,
            },
            {
              path: "settings",
              element: <SettingsLayout />,
              children: [
                { path: "account", element: <p>Profile section</p> },
                {
                  path: "security",
                  lazy: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    return { element: <p>Security section</p> };
                  },
                },
              ],
            },
          ],
        },
      ],
      { initialEntries: ["/t/tenant-northstar/rooms/room-all/chat"] },
    );
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TeamHubRuntimeProvider runtime={runtime}>
          <Suspense fallback={<p>Loading entire space</p>}>
            <RouterProvider router={router} />
          </Suspense>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    const room = await screen.findByText(
      "Current Room content",
      {},
      { timeout: 10_000 },
    );

    fireEvent.click(await shellControl("Account menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));

    const sidebar = await screen.findByRole("complementary", {
      name: "Settings navigation",
    });
    expect(room).not.toBeInTheDocument();
    expect(screen.getByText("Profile section")).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "Security" }));
    expect(
      screen.queryByRole("status", { name: /^Loading/ }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("Security section")).toBeVisible();
    expect(
      screen.getByRole("complementary", { name: "Settings navigation" }),
    ).toBe(sidebar);
    expect(router.state.location.pathname).toBe(
      "/t/tenant-northstar/settings/security",
    );
  });

  it("replaces a committed Room page while its query data is pending", async () => {
    const fixture = createTestTeamHubRuntime();

    let releaseRoom!: (content: string) => void;
    const pendingRoom = new Promise<string>((resolve) => {
      releaseRoom = resolve;
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        {
          children: [
            {
              element: (
                <SuspendingRoomContent
                  loadContent={(roomId) =>
                    roomId === "room-gtm-launch"
                      ? pendingRoom
                      : Promise.resolve("Current Room content")
                  }
                />
              ),
              loader: () => null,
              path: "rooms/:roomId/chat",
            },
          ],
          element: <RoomShell />,
          path: "/t/:tenantId",
        },
      ],
      { initialEntries: ["/t/tenant-northstar/rooms/room-all/chat"] },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={fixture}>
          <Suspense fallback={<p>Loading workspace</p>}>
            <RouterProvider router={router} />
          </Suspense>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Current Room content")).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "gtm-launch" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/t/tenant-northstar/rooms/room-gtm-launch/chat",
      ),
    );
    expect(router.state.navigation.state).toBe("idle");

    expect(
      screen.getByRole("status", { name: "Loading gtm-launch" }),
    ).toBeVisible();
    expect(screen.queryByText("Current Room content")).not.toBeInTheDocument();

    await act(async () => releaseRoom("Destination Room content"));
    expect(await screen.findByText("Destination Room content")).toBeVisible();
  });

  it("keeps the current page visible for search-only navigation", async () => {
    const fixture = createTestTeamHubRuntime();

    let releaseProfile!: () => void;
    const profileLoader = new Promise<void>((resolve) => {
      releaseProfile = resolve;
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        {
          children: [
            {
              element: (
                <div>
                  <Link to="?profile=actor-codex">Open Codex profile</Link>
                  <p>Connectors remain visible</p>
                </div>
              ),
              loader: ({ request }) =>
                new URL(request.url).search ? profileLoader : null,
              path: "apps",
            },
          ],
          element: <RoomShell />,
          path: "/t/:tenantId",
        },
      ],
      { initialEntries: ["/t/tenant-northstar/apps"] },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={fixture}>
          <Suspense fallback={<p>Loading workspace</p>}>
            <RouterProvider router={router} />
          </Suspense>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Connectors remain visible")).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "Open Codex profile" }));
    await waitFor(() => expect(router.state.navigation.state).toBe("loading"));

    expect(screen.getByText("Connectors remain visible")).toBeVisible();
    expect(
      screen.queryByRole("status", { name: "Loading Members" }),
    ).not.toBeInTheDocument();

    await act(async () => releaseProfile());
    await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
  });
});

function VoiceTargetProbe() {
  return (
    <p>
      Voice target: {useOptionalVoiceControl()?.targetRoomId ?? "unresolved"}
    </p>
  );
}

function SuspendingRoomContent({
  loadContent,
}: {
  loadContent: (roomId: string) => Promise<string>;
}) {
  const roomId = useParams().roomId!;
  const { data } = useSuspenseQuery({
    queryFn: () => loadContent(roomId),
    queryKey: ["deferred-room-content", roomId],
  });

  return <p>{data}</p>;
}
