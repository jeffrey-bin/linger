import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "@/app/query-client";
import {
  acceptRoomMembers,
  createTestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { RoomMembersSection } from "./room-members-section";

describe("RoomMembersSection", () => {
  afterEach(() => onlineManager.setOnline(true));

  it("issues Add member when the browser connectivity manager reports offline", async () => {
    const runtime = await runtimeWithOnlyCurrentMember();

    renderPanel(runtime);
    await screen.findByRole("region", { name: "Room members" });
    window.dispatchEvent(new Event("offline"));

    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    const dialog = screen.getByRole("dialog", { name: "Add Room member" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Maya Chen/ }));

    await waitFor(() =>
      expect(
        runtime.server.requestsTo(
          "PUT",
          "/v0/rooms/{roomId}/members/{actorId}",
        ),
      ).toHaveLength(1),
    );
  });

  it("keeps an Add member failure visible inside the open dialog", async () => {
    const runtime = await runtimeWithOnlyCurrentMember();
    runtime.server.on("PUT", "/v0/rooms/{roomId}/members/{actorId}", () =>
      teamHubErrorResponse(
        409,
        "MEMBER_REJECTED",
        "TeamHub rejected this membership.",
      ),
    );

    renderPanel(runtime);

    await screen.findByRole("region", { name: "Room members" });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    const dialog = screen.getByRole("dialog", { name: "Add Room member" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Maya Chen/ }));

    expect(
      await screen.findByText("TeamHub rejected this membership."),
    ).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: "Add Room member" }),
    ).toBeVisible();
  });

  it("keeps Human additions available when the Agent directory fails", async () => {
    const runtime = await runtimeWithOnlyCurrentMember();
    const listTenantAgents = vi
      .fn()
      .mockReturnValueOnce(
        teamHubErrorResponse(
          503,
          "AGENT_DIRECTORY_UNAVAILABLE",
          "Directory unavailable.",
        ),
      )
      .mockReturnValue({ items: [], page: { has_more: false } });
    runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", listTenantAgents);

    renderPanel(runtime);
    await screen.findByRole("region", { name: "Room members" });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    const dialog = screen.getByRole("dialog", { name: "Add Room member" });

    expect(
      within(dialog).getByRole("button", { name: /Maya Chen/ }),
    ).toBeVisible();
    expect(
      await within(dialog).findByText("Your agents are unavailable"),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(listTenantAgents).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        within(dialog).queryByText("Your agents are unavailable"),
      ).not.toBeInTheDocument(),
    );
  });

  it("surfaces Agent availability failures and retries both Agent snapshots", async () => {
    const runtime = await runtimeWithOnlyCurrentMember();
    const listTenantAgentAvailability = vi
      .fn()
      .mockReturnValueOnce(
        teamHubErrorResponse(
          503,
          "AGENT_AVAILABILITY_UNAVAILABLE",
          "Availability unavailable.",
        ),
      )
      .mockReturnValue({ items: [], page: { has_more: false } });
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/agent-availability",
      listTenantAgentAvailability,
    );

    renderPanel(runtime);
    await screen.findByRole("region", { name: "Room members" });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    const dialog = screen.getByRole("dialog", { name: "Add Room member" });

    expect(
      await within(dialog).findByText("Your agents are unavailable"),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(listTenantAgentAvailability).toHaveBeenCalledTimes(2),
    );
    expect(
      runtime.server.requestsTo("GET", "/v0/tenants/{tenantId}/agents"),
    ).toHaveLength(2);
    await waitFor(() =>
      expect(
        within(dialog).queryByText("Your agents are unavailable"),
      ).not.toBeInTheDocument(),
    );
  });

  it("lets a non-owner add eligible members without exposing removal", async () => {
    const runtime = await runtimeWithOnlyCurrentMember("member");

    renderPanel(runtime);

    await screen.findByRole("region", { name: "Room members" });
    expect(screen.getByRole("button", { name: "Add member" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Remove/ }),
    ).not.toBeInTheDocument();
  });

  it("requires owner confirmation before removing a Room member", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMembers(runtime);

    const deleteRoomMember = () =>
      runtime.server.requestsTo(
        "DELETE",
        "/v0/rooms/{roomId}/members/{actorId}",
      );

    renderPanel(runtime);
    await screen.findByRole("region", { name: "Room members" });
    fireEvent.click(screen.getByRole("button", { name: "Remove Codex" }));

    const confirmation = screen.getByRole("dialog", {
      name: "Remove Codex?",
    });
    expect(
      within(confirmation).getByText("They will lose access to this Room."),
    ).toBeVisible();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    );
    expect(deleteRoomMember()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Remove Codex" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Remove Codex?" })).getByRole(
        "button",
        { name: "Remove" },
      ),
    );

    await waitFor(() => expect(deleteRoomMember()).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Open Codex profile" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps a failed removal visible and prevents duplicate pending commands", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMembers(runtime);

    let failRemoval!: (response: Response) => void;
    const deleteRoomMember = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          failRemoval = resolve;
        }),
    );
    runtime.server.on(
      "DELETE",
      "/v0/rooms/{roomId}/members/{actorId}",
      deleteRoomMember,
    );

    renderPanel(runtime);
    await screen.findByRole("region", { name: "Room members" });
    fireEvent.click(screen.getByRole("button", { name: "Remove Codex" }));
    const confirmation = screen.getByRole("dialog", {
      name: "Remove Codex?",
    });
    const remove = within(confirmation).getByRole("button", { name: "Remove" });
    fireEvent.click(remove);

    await waitFor(() => expect(deleteRoomMember).toHaveBeenCalledOnce());
    await waitFor(() => expect(remove).toBeDisabled());
    fireEvent.click(remove);
    expect(deleteRoomMember).toHaveBeenCalledOnce();
    failRemoval(teamHubErrorResponse(500, "REMOVAL_FAILED", "Removal failed."));
    expect(
      await within(confirmation).findByText("Removal failed."),
    ).toBeVisible();
    expect(remove).toBeEnabled();
  });

  it("hands the selected Actor to the shared Room Profile surface", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMembers(runtime);

    const onOpenProfile = vi.fn();

    renderPanel(runtime, { onOpenProfile });

    fireEvent.click(
      await screen.findByRole("button", { name: "Open Codex profile" }),
    );
    expect(onOpenProfile).toHaveBeenCalledWith("actor-codex");
  });

  it("offers Tenant Humans, Workspace Agents, and the current Human's private Agents", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMembers(runtime);

    const { unmount } = renderPanel(runtime);
    await screen.findByRole("region", { name: "Room members" });
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    expect(
      within(screen.getByRole("dialog", { name: "Add Room member" })).getByText(
        "Every Tenant Actor is already in this Room.",
      ),
    ).toBeVisible();

    unmount();
    renderPanel(runtime, { roomId: "room-dm-codex" });
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    const dialog = screen.getByRole("dialog", { name: "Add Room member" });
    expect(
      within(dialog).getByRole("button", { name: /Maya Chen/ }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: /Jenny's Delegate.*Yours/ }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: /Lev8 GTM/ }),
    ).toBeVisible();
    expect(
      within(dialog).queryByText("@jenny_delegate"),
    ).not.toBeInTheDocument();
  });
});

async function runtimeWithOnlyCurrentMember(
  role: "member" | "owner" = "owner",
) {
  const runtime = createTestTeamHubRuntime();
  acceptRoomMembers(runtime);

  const members = runtime.seed.membersByRoom.get("room-all")!;
  runtime.server.on("GET", "/v0/rooms/{roomId}/members", () => ({
    items: [{ ...members[0]!, role }],
    page: { has_more: false },
  }));
  return runtime;
}

function renderPanel(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  callbacks: {
    onOpenProfile?: (actorId: string) => void;
    roomId?: string;
  } = {},
) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <Suspense fallback={<p>Loading members</p>}>
          <RoomMembersSection
            onOpenProfile={callbacks.onOpenProfile}
            roomId={callbacks.roomId ?? "room-all"}
            tenantId="tenant-northstar"
          />
        </Suspense>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}
