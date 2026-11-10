import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { RoomAddMembersDialog } from "./members/room-add-members-dialog";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "@/app/query-client";
import {
  acceptRoomCreation,
  acceptRoomMembers,
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { RoomCreateDialog } from "./room-create-dialog";

describe("Room creation", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "showPopover", {
      configurable: true,
      value: function (this: HTMLElement) {
        this.style.display = "flex";
      },
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    onlineManager.setOnline(true);
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  });

  it("uses the authored compact form without a secondary cancel action", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomCreateDialog onClose={vi.fn()} tenantId="tenant-northstar" />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("Room name")).toHaveClass("ui-field-control");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByLabelText(/Description/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add members" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Create Room$/ }),
    ).toBeInTheDocument();
  });

  it("retries the same Room creation after an ambiguous failure", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    const createRoom = vi.fn<TestRouteHandler>(() => {
      throw new Error("Connection closed before confirmation.");
    });
    runtime.server.on("POST", "/v0/tenants/{tenantId}/rooms", createRoom);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomCreateDialog onClose={vi.fn()} tenantId="tenant-northstar" />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "release-room" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Create Room$/ }));
    await screen.findByText(/did not confirm whether this Room was created/);
    fireEvent.click(screen.getByRole("button", { name: /^Create Room$/ }));

    await waitFor(() => expect(createRoom).toHaveBeenCalledTimes(2));
    expect(createRoom.mock.calls[1]![0].body).toEqual(
      createRoom.mock.calls[0]![0].body,
    );
  });

  it("adds Humans and Agents in a separate dialog after the Room already exists", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    const room = await createRoom(runtime, "Team launch");
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomAddMembersDialog
              onClose={onClose}
              roomId={room.id}
              tenantId="tenant-northstar"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose existing members" }),
    );
    const picker = screen.getByRole("dialog", { name: "Choose members" });
    fireEvent.change(screen.getByLabelText("Search members"), {
      target: { value: "Maya" },
    });
    fireEvent.click(
      await within(picker).findByRole("button", { name: /Maya Chen/ }),
    );
    fireEvent.change(screen.getByLabelText("Search members"), {
      target: { value: "Codex" },
    });
    fireEvent.click(
      await within(picker).findByRole("button", { name: /Codex/ }),
    );
    fireEvent.keyDown(screen.getByLabelText("Search members"), {
      key: "Escape",
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Choose existing members" }),
    ).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Remove Maya Chen" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Choose existing members" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Maya Chen avatar/ }),
    );
    fireEvent.keyDown(screen.getByLabelText("Search members"), {
      key: "Escape",
    });
    fireEvent.click(screen.getByRole("button", { name: "Add members" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const members = await listRoomMembers(runtime, room.id);
    expect(members.items.map((member) => member.actor.display_name)).toEqual(
      expect.arrayContaining(["Maya Chen", "Codex"]),
    );
  });

  it("keeps successful additions and retries only failed members", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    const room = await createRoom(runtime, "Retry members");
    const members = new TeamHubTestServer();
    acceptRoomMembers({ ...runtime, server: members });
    let attempts = 0;
    runtime.server.on(
      "PUT",
      "/v0/rooms/{roomId}/members/{actorId}",
      ({ request }) => {
        attempts += 1;
        return attempts === 2
          ? Promise.reject(new Error("Temporary failure"))
          : members.fetch(request);
      },
    );
    const putActorIds = () =>
      runtime.server
        .requestsTo("PUT", "/v0/rooms/{roomId}/members/{actorId}")
        .map((request) => new URL(request.url).pathname.split("/").at(-1));
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomAddMembersDialog
              roomId={room.id}
              tenantId="tenant-northstar"
              onClose={onClose}
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose existing members" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Maya Chen avatar/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Codex avatar/ }),
    );
    fireEvent.keyDown(screen.getByLabelText("Search members"), {
      key: "Escape",
    });
    fireEvent.click(screen.getByRole("button", { name: "Add members" }));
    await screen.findByRole("alert");
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Remove Maya Chen" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Remove Codex" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add members" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(putActorIds()).toHaveLength(3);
    expect(putActorIds()[2]).toBe(putActorIds()[1]);
    expect(
      (await listRoomMembers(runtime, room.id)).items.map(
        (item) => item.actor.display_name,
      ),
    ).toEqual(expect.arrayContaining(["Maya Chen", "Codex"]));
  });

  it("closes the second step directly without a skip confirmation", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    const room = await createRoom(runtime, "Skip confirmation");
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomAddMembersDialog
              onClose={onClose}
              roomId={room.id}
              tenantId="tenant-northstar"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose existing members" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Maya Chen avatar/ }),
    );
    fireEvent.keyDown(screen.getByLabelText("Search members"), {
      key: "Escape",
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect((await getRoom(runtime, room.id)).name).toBe("Skip confirmation");
  });

  it("allows skipping members without removing the created Room", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    const room = await createRoom(runtime, "Skip members");
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomAddMembersDialog
              onClose={onClose}
              roomId={room.id}
              tenantId="tenant-northstar"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    // Closing with nothing queued confirms first, so the Room owner sees where
    // members can be added later.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole("button", { name: "Skip for now" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(
      runtime.server.requestsTo("PUT", "/v0/rooms/{roomId}/members/{actorId}"),
    ).toHaveLength(0);
    expect((await getRoom(runtime, room.id)).name).toBe("Skip members");
  });

  it("attempts Room creation when the browser connectivity hint is offline", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomCreateDialog onClose={vi.fn()} tenantId="tenant-northstar" />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    window.dispatchEvent(new Event("offline"));

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "connectivity-hint-room" },
    });
    expect(screen.getByRole("button", { name: /^Create Room$/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /^Create Room$/ }));
    await waitFor(() =>
      expect(
        runtime.server.requestsTo("POST", "/v0/tenants/{tenantId}/rooms"),
      ).toHaveLength(1),
    );
  });

  it("rejects a created Room outside the active Tenant before navigation", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    const onClose = vi.fn();
    const existingRoom = await getRoom(runtime, "room-all");
    runtime.server.on("POST", "/v0/tenants/{tenantId}/rooms", () => ({
      ...existingRoom,
      id: "room-foreign",
      tenant_id: "tenant-foreign",
    }));

    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomCreateDialog onClose={onClose} tenantId="tenant-northstar" />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "foreign-room" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Create Room$/ }));

    await expect(
      screen.findByText("The requested TeamHub resource is unavailable."),
    ).resolves.toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a specific error when the Room name is already taken", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    runtime.server.on("POST", "/v0/tenants/{tenantId}/rooms", () =>
      teamHubErrorResponse(
        409,
        "ROOM_NAME_TAKEN",
        "a Room with this name already exists",
      ),
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomCreateDialog onClose={vi.fn()} tenantId="tenant-northstar" />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "room-all" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Create Room$/ }));

    await expect(
      screen.findByText(
        "You already have a Room with this name. Choose a different name.",
      ),
    ).resolves.toBeVisible();
  });
});

function createRoom(runtime: TestTeamHubRuntime, name: string) {
  return teamHubData(
    runtime.client.api.POST("/v0/tenants/{tenantId}/rooms", {
      params: { path: { tenantId: "tenant-northstar" } },
      body: { name },
    }),
  );
}

function getRoom(runtime: TestTeamHubRuntime, roomId: string) {
  return teamHubData(
    runtime.client.api.GET("/v0/rooms/{roomId}", {
      params: { path: { roomId } },
    }),
  );
}

function listRoomMembers(runtime: TestTeamHubRuntime, roomId: string) {
  return teamHubData(
    runtime.client.api.GET("/v0/rooms/{roomId}/members", {
      params: { path: { roomId } },
    }),
  );
}
