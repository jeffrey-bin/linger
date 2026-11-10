import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render as renderInDocument,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type ReactElement, type ReactNode, useState } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import {
  TeamHubRuntimeProvider,
  type TeamHubRuntime,
} from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubAnotherMe,
  TeamHubRoomListItem,
} from "@/features/teamhub/teamhub-types";
import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import { TeamHubTestServer } from "@/test/teamhub-test-server";

import * as avatarImages from "./members/actor-avatar-image";
import { RoomSecondaryNavigation } from "./room-secondary-navigation";

/** Row actions read the Room list cache and the runtime client. */
function NavigationProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={liveRuntime()}>
        {children}
      </TeamHubRuntimeProvider>
    </QueryClientProvider>
  );
}

function render(ui: ReactElement) {
  return renderInDocument(ui, { wrapper: NavigationProviders });
}

describe("RoomSecondaryNavigation attention", () => {
  it("shows newly created Agents and Rooms first after updates and reloads", () => {
    const olderRoom = {
      ...room("older-room", 0, 0),
      updated_at: "2026-07-26T09:00:00Z",
    };
    const newerRoom = {
      ...room("newer-room", 0, 0),
      created_at: "2026-07-25T09:00:00Z",
    };
    const olderAgent = {
      ...deletedDirectRoom(),
      id: "older-agent",
      direct_peer_active: true,
      updated_at: olderRoom.updated_at,
      name: "Older Agent",
      direct_peer: {
        ...deletedDirectRoom().direct_peer!,
        display_name: "Older Agent",
      },
    };
    const newerAgent = {
      ...olderAgent,
      id: "newer-agent",
      name: "Newer Agent",
      created_at: newerRoom.created_at,
      direct_peer: { ...olderAgent.direct_peer, display_name: "Newer Agent" },
    };
    const anotherMe = { ...olderAgent, id: "another-me", name: "Another Me" };
    const initialRooms = [anotherMe, olderAgent, olderRoom];
    const updatedRooms = [...initialRooms, newerAgent, newerRoom];
    const navigation = (rooms: TeamHubRoomListItem[]) => (
      <MemoryRouter>
        <RoomSecondaryNavigation
          anotherMeRoomId="another-me"
          onCloseMobile={() => undefined}
          onCreateRoom={() => undefined}
          rooms={rooms}
          tenant={{
            id: "tenant-a",
            name: "Northstar",
            created_at: olderRoom.created_at,
          }}
        />
      </MemoryRouter>
    );
    const assertOrder = () => {
      const links = screen
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"));
      expect(links).toEqual(
        [
          "another-me",
          "newer-agent",
          "newer-room",
          "older-agent",
          "older-room",
        ].map((id) => `/t/tenant-a/rooms/${id}/chat`),
      );
    };
    const view = render(navigation(initialRooms));
    view.rerender(navigation(updatedRooms));
    assertOrder();
    expect(updatedRooms.map((item) => item.id)).toEqual([
      "another-me",
      "older-agent",
      "older-room",
      "newer-agent",
      "newer-room",
    ]);
    view.unmount();
    render(navigation(updatedRooms));
    assertOrder();
  });

  it("puts capture tools and Search in the header row and a plus beside AGENTS and ROOMS", () => {
    const queryClient = new QueryClient();
    const onCreateRoom = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={liveRuntime()}>
          <MemoryRouter initialEntries={["/t/tenant-a/rooms/room-active/chat"]}>
            <Routes>
              <Route
                element={
                  <RoomSecondaryNavigation
                    onCloseMobile={() => undefined}
                    onCreateRoom={onCreateRoom}
                    rooms={[room("room-active", 0, 0)]}
                    tenant={{
                      created_at: "2026-07-24T09:00:00Z",
                      id: "tenant-a",
                      name: "Northstar",
                    }}
                  />
                }
                path="/t/:tenantId/rooms/:roomId/chat"
              />
            </Routes>
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    const quickAccess = screen.getByLabelText("Quick access");
    expect(
      within(quickAccess).getByRole("button", { name: "Pocket Notes" }),
    ).toBeVisible();
    expect(
      within(quickAccess).getByRole("button", { name: "Meetings" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search" })).toBeVisible();
    const chats = screen
      .getByRole("button", { name: "Messages" })
      .closest("section")!;
    fireEvent.click(within(chats).getByRole("button", { name: "Create chat" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Create Room" }));
    expect(onCreateRoom).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("textbox", { name: "Search Rooms" }),
    ).not.toBeInTheDocument();
  });

  it("opens Local Agent setup from Create Agent without navigating away", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={liveRuntime()}>
          <MemoryRouter initialEntries={["/t/tenant-a/rooms/room-active/chat"]}>
            <RoomSecondaryNavigation
              onCloseMobile={() => undefined}
              onCreateRoom={() => undefined}
              rooms={[room("room-active", 0, 0)]}
              tenant={{
                created_at: "2026-07-24T09:00:00Z",
                id: "tenant-a",
                name: "Northstar",
              }}
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Create Agent" }));

    expect(
      await screen.findByRole("dialog", { name: "Create local agent" }),
    ).toBeVisible();
    expect(screen.queryByText("/t/tenant-a/agents/new?type=local")).toBeNull();
  });

  it("uses one compact badge and gives Mentions priority", () => {
    render(
      <TeamHubRuntimeProvider runtime={liveRuntime()}>
        <MemoryRouter initialEntries={["/t/tenant-a/rooms/room-active/chat"]}>
          <Routes>
            <Route
              element={
                <RoomSecondaryNavigation
                  onCloseMobile={() => undefined}
                  onCreateRoom={() => undefined}
                  rooms={[
                    room("room-active", 0, 0),
                    room("room-mentioned", 3, 1),
                  ]}
                  tenant={{
                    created_at: "2026-07-24T09:00:00Z",
                    id: "tenant-a",
                    name: "Northstar",
                  }}
                />
              }
              path="/t/:tenantId/rooms/:roomId/chat"
            />
          </Routes>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );

    expect(screen.getByLabelText("1 unread mention")).toBeVisible();
    expect(
      screen.queryByLabelText("3 unread messages"),
    ).not.toBeInTheDocument();
  });

  it("keeps a Mention visible when the Room has no unread Messages", () => {
    render(
      <TeamHubRuntimeProvider runtime={liveRuntime()}>
        <MemoryRouter initialEntries={["/t/tenant-a/rooms/room-active/chat"]}>
          <Routes>
            <Route
              element={
                <RoomSecondaryNavigation
                  onCloseMobile={() => undefined}
                  onCreateRoom={() => undefined}
                  rooms={[
                    room("room-active", 0, 0),
                    room("room-mentioned", 0, 1),
                  ]}
                  tenant={{
                    created_at: "2026-07-24T09:00:00Z",
                    id: "tenant-a",
                    name: "Northstar",
                  }}
                />
              }
              path="/t/:tenantId/rooms/:roomId/chat"
            />
          </Routes>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );

    expect(screen.getByLabelText("1 unread mention")).toBeVisible();
    expect(screen.queryByLabelText(/unread messages/)).not.toBeInTheDocument();
  });

  it("leaves Thread Rooms out of the Room navigation", () => {
    const anotherMe = {
      ...deletedDirectRoom(),
      direct_peer_active: true,
      name: "Another Me",
    };
    const agentDirect = {
      ...deletedDirectRoom(),
      direct_peer: {
        display_name: "118 Service",
        id: "actor-118",
        kind: "agent" as const,
        tenant_id: "tenant-a",
      },
      direct_peer_active: true,
      id: "room-agent-118",
      name: "118 Service",
    };

    render(
      <TeamHubRuntimeProvider runtime={liveRuntime()}>
        <MemoryRouter initialEntries={["/t/tenant-a/rooms/room-thread/chat"]}>
          <Routes>
            <Route
              element={
                <RoomSecondaryNavigation
                  activeRoomId="room-thread"
                  anotherMeRoomId={anotherMe.id}
                  onCloseMobile={() => undefined}
                  onCreateRoom={() => undefined}
                  rooms={[
                    anotherMe,
                    agentDirect,
                    room("room-active", 0, 0),
                    {
                      ...room("room-thread", 1, 0),
                      kind: "thread",
                      name: "Checklist thread",
                      parent_room_id: "room-active",
                      root_message_id: "message-2",
                    },
                    {
                      ...room("room-direct-thread", 2, 0),
                      kind: "thread",
                      name: "Workflow discussion",
                      parent_room_id: anotherMe.id,
                      root_message_id: "message-workflow-card",
                    },
                    {
                      ...room("room-agent-thread", 3, 0),
                      kind: "thread",
                      name: "118 Service Thread",
                      parent_room_id: agentDirect.id,
                      root_message_id: "message-agent-thread",
                    },
                  ]}
                  tenant={{
                    created_at: "2026-07-24T09:00:00Z",
                    id: "tenant-a",
                    name: "Northstar",
                  }}
                />
              }
              path="/t/:tenantId/rooms/:roomId/chat"
            />
          </Routes>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );

    expect(screen.getByRole("link", { name: "room-active" })).toBeVisible();
    expect(screen.getByRole("link", { name: "118 Service" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Checklist thread" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Workflow discussion" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "118 Service Thread" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/unread message/)).not.toBeInTheDocument();
  });

  it("marks a deleted Agent beside its retained Direct Room", () => {
    render(
      <TeamHubRuntimeProvider runtime={liveRuntime()}>
        <MemoryRouter initialEntries={["/t/tenant-a/rooms/room-direct/chat"]}>
          <Routes>
            <Route
              element={
                <RoomSecondaryNavigation
                  onCloseMobile={() => undefined}
                  onCreateRoom={() => undefined}
                  rooms={[deletedDirectRoom()]}
                  tenant={{
                    created_at: "2026-07-24T09:00:00Z",
                    id: "tenant-a",
                    name: "Northstar",
                  }}
                />
              }
              path="/t/:tenantId/rooms/:roomId/chat"
            />
          </Routes>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );

    expect(screen.getByRole("link", { name: "Codex, Deleted" })).toBeVisible();
  });

  it("lists parent Rooms but keeps thread Rooms out of the sidebar", () => {
    render(
      <TeamHubRuntimeProvider runtime={liveRuntime()}>
        <MemoryRouter initialEntries={["/t/tenant-a/rooms/room-active/chat"]}>
          <Routes>
            <Route
              element={
                <RoomSecondaryNavigation
                  activeRoomId="room-active"
                  onCloseMobile={() => undefined}
                  onCreateRoom={() => undefined}
                  rooms={[
                    room("room-active", 0, 0),
                    room("room-other", 0, 0),
                    {
                      ...room("room-thread", 0, 0),
                      kind: "thread",
                      name: "Release discussion",
                      parent_room_id: "room-active",
                      root_message_id: "message-1",
                    },
                  ]}
                  tenant={{
                    created_at: "2026-07-24T09:00:00Z",
                    id: "tenant-a",
                    name: "Northstar",
                  }}
                />
              }
              path="/t/:tenantId/rooms/:roomId/chat"
            />
          </Routes>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );

    expect(screen.getByRole("link", { name: "room-active" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "room-other" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Release discussion" }),
    ).not.toBeInTheDocument();
  });
});

function deletedDirectRoom(): TeamHubRoomListItem {
  return {
    ...room("room-direct", 0, 0),
    direct_peer: {
      display_name: "Codex",
      id: "actor-codex",
      kind: "agent",
      tenant_id: "tenant-a",
    },
    direct_peer_active: false,
    kind: "direct",
    name: "Codex",
  };
}

function room(
  id: string,
  unreadMessageCount: number,
  unreadMentionCount: number,
): TeamHubRoomListItem {
  return {
    created_at: "2026-07-24T09:00:00Z",
    created_by: {
      display_name: "Jenny",
      id: "actor-jenny",
      kind: "human",
      tenant_id: "tenant-a",
    },
    id,
    kind: "room",
    latest_room_seq: 4,
    name: id,
    read_through_room_seq: unreadMessageCount ? 1 : 4,
    tenant_id: "tenant-a",
    unread_mention_count: unreadMentionCount,
    unread_message_count: unreadMessageCount,
    updated_at: "2026-07-24T10:00:00Z",
  };
}

function liveRuntime(): TeamHubRuntime {
  return {
    client: {} as TeamHubRuntime["client"],
    runStatuses: {} as TeamHubRuntime["runStatuses"],
    events: {} as TeamHubRuntime["events"],
  };
}

describe("Room navigation working indicator", () => {
  it("shows activity only for its Room, keeps unread badges, and clears on completion", () => {
    const group = room("room-working", 2, 1);
    const direct = { ...deletedDirectRoom(), direct_peer_active: true };
    const renderNavigation = (runningRoomIds: readonly string[]) => (
      <MemoryRouter>
        <RoomSecondaryNavigation
          activeRoomId={group.id}
          onCloseMobile={() => undefined}
          onCreateRoom={() => undefined}
          rooms={[group, direct, room("room-idle", 0, 0)]}
          runningRoomIds={runningRoomIds}
          tenant={{
            id: "tenant-a",
            name: "Northstar",
            created_at: "2026-07-24T09:00:00Z",
          }}
        />
      </MemoryRouter>
    );
    const { rerender } = render(renderNavigation([group.id, direct.id]));
    for (const name of [group.name, "Codex"]) {
      expect(
        within(screen.getByRole("link", { name })).getByRole("img", {
          name: "Agent working",
        }),
      ).toBeVisible();
    }
    expect(
      within(screen.getByRole("link", { name: "room-idle" })).queryByRole(
        "img",
        { name: "Agent working" },
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("1 unread mention")).toBeVisible();
    rerender(renderNavigation([direct.id]));
    expect(
      within(screen.getByRole("link", { name: group.name })).queryByRole(
        "img",
        { name: "Agent working" },
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Agent working" })).toBeVisible();
    rerender(renderNavigation([]));
    expect(
      screen.queryByRole("img", { name: "Agent working" }),
    ).not.toBeInTheDocument();
  });

  it("shows a failed mark that yields to a working spinner", () => {
    const group = room("room-failed", 1, 0);
    const renderNavigation = (
      runningRoomIds: readonly string[],
      failedRoomIds: readonly string[] = [],
    ) => (
      <MemoryRouter>
        <RoomSecondaryNavigation
          activeRoomId={group.id}
          failedRoomIds={failedRoomIds}
          onCloseMobile={() => undefined}
          onCreateRoom={() => undefined}
          rooms={[group, room("room-idle", 0, 0)]}
          runningRoomIds={runningRoomIds}
          tenant={{
            id: "tenant-a",
            name: "Northstar",
            created_at: "2026-07-24T09:00:00Z",
          }}
        />
      </MemoryRouter>
    );
    const { rerender } = render(renderNavigation([], [group.id]));
    expect(
      within(screen.getByRole("link", { name: group.name })).getByRole("img", {
        name: "Last run failed",
      }),
    ).toBeVisible();
    expect(
      within(screen.getByRole("link", { name: "room-idle" })).queryByRole(
        "img",
        { name: "Last run failed" },
      ),
    ).not.toBeInTheDocument();
    rerender(renderNavigation([group.id], [group.id]));
    expect(
      within(screen.getByRole("link", { name: group.name })).getByRole("img", {
        name: "Agent working",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("img", { name: "Last run failed" }),
    ).not.toBeInTheDocument();
  });
});

describe("Another Me card", () => {
  it.each([
    ["FFFFFF", "#1a1a16", "0.82"],
    ["8DA488", "#1a1a16", "1"],
    ["010101", "#fff", "0.82"],
    ["777777", "#1a1a16", "1"],
    ["6E3CED", "#fff", "1"],
  ])("keeps text readable on avatar background %s", (color, text, opacity) => {
    const record = vi
      .spyOn(avatarImages, "useAgentAvatarRecord")
      .mockReturnValue({ avatarKey: `figure:lion:${color}` });
    try {
      const anotherMe = { ...deletedDirectRoom(), direct_peer_active: true };
      render(
        <MemoryRouter>
          <RoomSecondaryNavigation
            activeRoomId={anotherMe.id}
            anotherMeRoomId={anotherMe.id}
            onCloseMobile={() => undefined}
            onCreateRoom={() => undefined}
            rooms={[anotherMe]}
            tenant={{
              id: "tenant-a",
              name: "Northstar",
              created_at: anotherMe.created_at,
            }}
          />
        </MemoryRouter>,
      );
      const card = screen.getByRole("link", {
        name: "Another Me Chat",
      }).parentElement!;
      expect(card.style.getPropertyValue("--am-brand")).toBe(`#${color}`);
      expect(card.style.getPropertyValue("--am-text")).toBe(text);
      expect(card.style.getPropertyValue("--am-sub-opacity")).toBe(opacity);
    } finally {
      record.mockRestore();
    }
  });

  it("fills the current card with the Agent's colour and keeps the working and failed icons", () => {
    const anotherMe = {
      ...deletedDirectRoom(),
      direct_peer: {
        display_name: "Jenny's Delegate",
        id: "actor-another-me",
        kind: "agent" as const,
        tenant_id: "tenant-a",
      },
      direct_peer_active: true,
      id: "room-another-me",
      name: "Jenny's Delegate",
    };
    const renderCard = (state: {
      running?: string[];
      failed?: string[];
      active?: boolean;
    }) => (
      <MemoryRouter>
        <RoomSecondaryNavigation
          activeRoomId={state.active ? anotherMe.id : "room-other"}
          anotherMeRoomId={anotherMe.id}
          failedRoomIds={state.failed ?? []}
          onCloseMobile={() => undefined}
          onCreateRoom={() => undefined}
          rooms={[anotherMe, room("room-other", 0, 0)]}
          runningRoomIds={state.running ?? []}
          tenant={{
            id: "tenant-a",
            name: "Northstar",
            created_at: "2026-07-24T09:00:00Z",
          }}
        />
      </MemoryRouter>
    );
    const card = () => screen.getByRole("link", { name: "Another Me Chat" });

    const { rerender } = render(renderCard({ running: [anotherMe.id] }));
    expect(card().parentElement).not.toHaveAttribute("data-active");
    // The card glows and fills with the Agent's avatar background colour.
    expect(card().parentElement!.style.getPropertyValue("--am-brand")).toMatch(
      /^#[0-9A-F]{6}$/,
    );
    expect(
      within(card()).getByRole("img", { name: "Agent working" }),
    ).toBeVisible();

    rerender(renderCard({ active: true, failed: [anotherMe.id] }));
    expect(card().parentElement).toHaveAttribute("data-active", "true");
    expect(
      within(card()).getByRole("img", { name: "Last run failed" }),
    ).toBeVisible();
  });
});

describe("Another Me before its Computer connects", () => {
  function renderWithAnotherMe(
    anotherMe: TeamHubAnotherMe,
    rooms: TeamHubRoomListItem[] = [],
  ) {
    renderInDocument(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={liveRuntime()}>
          <MemoryRouter>
            <RoomSecondaryNavigation
              anotherMeRoomId={anotherMe.room_id}
              onCloseMobile={() => undefined}
              onCreateRoom={() => undefined}
              rooms={rooms}
              tenant={{
                id: "tenant-a",
                name: "Northstar",
                created_at: "2026-07-24T09:00:00Z",
              }}
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
  }

  it("shows no Another Me until it exists", () => {
    renderWithAnotherMe({});
    expect(screen.queryByRole("link", { name: "Another Me Chat" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the Another Me card once it exists", () => {
    const anotherMe = { ...deletedDirectRoom(), direct_peer_active: true };
    renderWithAnotherMe(
      { agent_actor_id: anotherMe.direct_peer!.id, room_id: anotherMe.id },
      [anotherMe],
    );
    expect(screen.getByRole("link", { name: "Another Me Chat" })).toBeVisible();
  });
});

describe("Room navigation pins", () => {
  function renderPinnedNavigation(
    rooms: TeamHubRoomListItem[],
    // Identity and Agent reads fail unless a test routes them, which leaves
    // Agent deletion unavailable.
    server = new TeamHubTestServer().allowUnhandledRoutes(),
  ) {
    const updateRoomPin = vi.fn((roomId: string, pinned: boolean) => ({
      room_id: roomId,
      ...(pinned ? { pinned_at: "2026-07-25T00:00:00Z" } : {}),
    }));
    server.on("PUT", "/v0/rooms/{roomId}/pin", ({ body, params }) =>
      updateRoomPin(params.roomId!, (body as { pinned: boolean }).pinned),
    );
    const runtime = {
      ...liveRuntime(),
      client: createHttpTeamHubClient({
        fetchRequest: server.fetch,
        onAuthenticationRequired: () => undefined,
      }),
    };
    renderInDocument(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomSecondaryNavigation
              onCloseMobile={() => undefined}
              onCreateRoom={() => undefined}
              rooms={rooms}
              tenant={{
                id: "tenant-a",
                name: "Northstar",
                created_at: "2026-07-24T09:00:00Z",
              }}
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    return updateRoomPin;
  }

  it("leads each section with pinned chats, the most recently pinned first", () => {
    const agent = {
      ...deletedDirectRoom(),
      direct_peer_active: true,
      pinned_at: "2026-07-01T00:00:00Z",
    };
    const otherAgent = {
      ...agent,
      direct_peer: { ...agent.direct_peer!, display_name: "Claude" },
      id: "room-claude",
      name: "Claude",
      pinned_at: undefined,
    };
    renderPinnedNavigation([
      room("room-plain", 0, 0),
      { ...room("room-older-pin", 0, 0), pinned_at: "2026-07-01T00:00:00Z" },
      { ...room("room-newer-pin", 0, 0), pinned_at: "2026-07-02T00:00:00Z" },
      otherAgent,
      agent,
    ]);

    const chats = screen
      .getByRole("heading", { name: "Messages" })
      .closest("section")!;
    const links = within(chats)
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label"));
    expect(links.slice(0, 3)).toEqual([
      "room-newer-pin",
      "room-older-pin",
      "Codex",
    ]);
    expect(links).toEqual(expect.arrayContaining(["room-plain", "Claude"]));
    expect(
      within(screen.getByRole("link", { name: "room-newer-pin" })).getByRole(
        "img",
        { name: "Pinned" },
      ),
    ).toBeInTheDocument();
  });

  it("pins a Room from its row and offers Pin and Delete for an Agent chat", async () => {
    const agent = { ...deletedDirectRoom(), direct_peer_active: true };
    const updateRoomPin = renderPinnedNavigation([
      room("room-plain", 0, 0),
      agent,
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Pin room-plain" }));
    await waitFor(() =>
      expect(updateRoomPin).toHaveBeenCalledWith("room-plain", true),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Codex" }),
    );
    const menu = await screen.findByRole("menu", {
      name: "More actions for Codex",
    });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Pin", "Delete"]);
    // Only the Human who registered the Agent may remove it.
    expect(
      within(menu).getByRole("menuitem", { name: "Delete" }),
    ).toBeDisabled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Pin" }));
    await waitFor(() =>
      expect(updateRoomPin).toHaveBeenCalledWith(agent.id, true),
    );
  });

  it("keeps the Delete dialog outside the row's pointer-transparent actions", async () => {
    const agent = { ...deletedDirectRoom(), direct_peer_active: true };
    const jenny = {
      display_name: "Jenny",
      id: "actor-jenny",
      kind: "human",
      tenant_id: "tenant-a",
    };
    const server = new TeamHubTestServer()
      .on("GET", "/v0/me", () => ({ actors: [jenny] }))
      .on("GET", "/v0/tenants/{tenantId}/agents", () => ({
        items: [
          {
            actor: agent.direct_peer,
            agent_type: "general",
            created_by: jenny,
            status: "active",
          },
        ],
        page: { has_more: false },
      }));
    renderPinnedNavigation([agent], server);

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Codex" }),
    );
    const remove = await screen.findByRole("menuitem", { name: "Delete" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);

    const dialog = await waitFor(() => {
      const element = document.querySelector("dialog");
      expect(element).not.toBeNull();
      return element!;
    });
    // The strip ignores the pointer whenever the row is not hovered, and a
    // dialog inheriting that renders but cannot be clicked.
    expect(dialog.closest(".row-reveal-action")).toBeNull();
  });
});

describe("Room navigation composer focus", () => {
  function StateProbe() {
    const location = useLocation();
    return (
      <output aria-label="Location state">{`${location.pathname}|${JSON.stringify(location.state)}`}</output>
    );
  }
  function navigation() {
    return (
      <MemoryRouter initialEntries={["/t/tenant-a/rooms/room-active/chat"]}>
        <RoomSecondaryNavigation
          activeRoomId="room-active"
          onCloseMobile={() => undefined}
          onCreateRoom={() => undefined}
          rooms={[room("room-active", 0, 0), room("room-other", 0, 0)]}
          tenant={{
            created_at: "2026-07-24T09:00:00Z",
            id: "tenant-a",
            name: "Northstar",
          }}
        />
        <StateProbe />
      </MemoryRouter>
    );
  }

  it("asks the next Room to focus its composer after a mouse click", () => {
    render(navigation());
    fireEvent.click(screen.getByRole("link", { name: "room-other" }), {
      detail: 1,
    });
    expect(screen.getByLabelText("Location state")).toHaveTextContent(
      '/t/tenant-a/rooms/room-other/chat|{"focusComposer":true}',
    );
  });

  it("keeps keyboard activation and touch navigation without composer focus", () => {
    render(navigation());
    fireEvent.click(screen.getByRole("link", { name: "room-other" }), {
      detail: 0,
    });
    expect(screen.getByLabelText("Location state")).toHaveTextContent(
      "/t/tenant-a/rooms/room-other/chat|null",
    );
  });

  it("does not focus the composer from a coarse pointer", () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(pointer: coarse)",
          media: query,
        }) as MediaQueryList,
    );
    render(navigation());
    fireEvent.click(screen.getByRole("link", { name: "room-other" }), {
      detail: 1,
    });
    expect(screen.getByLabelText("Location state")).toHaveTextContent(
      "/t/tenant-a/rooms/room-other/chat|null",
    );
    matchMedia.mockRestore();
  });
});
