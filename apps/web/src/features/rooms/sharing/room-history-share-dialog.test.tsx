import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { RoomHistoryShareDialog } from "./room-history-share-dialog";

const share = {
  id: "share_1",
  room_name: "Room",
  created_at: "2026-09-22T06:30:03.000Z",
  message_count: 2,
  snapshot_room_seq: 4,
};

function renderDialog(roomHistory: Partial<TeamHubClient["roomHistory"]>) {
  const client = {
    roomHistory: {
      list: vi.fn().mockResolvedValue({ items: [share] }),
      create: vi.fn(),
      link: vi.fn(),
      revoke: vi.fn(),
      ...roomHistory,
    },
  } as unknown as TeamHubClient;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TeamHubRuntimeProvider runtime={{ client } as never}>
        <RoomHistoryShareDialog onClose={vi.fn()} roomId="room_1" />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return client;
}

describe("Room history share dialog", () => {
  beforeEach(() => {
    vi.stubGlobal("open", vi.fn().mockReturnValue(null));
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("reuses the created token when opening its own snapshot", async () => {
    // TeamHub stores one token per snapshot, so issuing another would silently
    // invalidate the link the author has already copied.
    const client = renderDialog({
      create: vi
        .fn()
        .mockResolvedValue({ ...share, token: "room_share_first" }),
    });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    const conversationLink = await screen.findByLabelText(
      "Copy conversation link",
    );
    expect(conversationLink).toBeVisible();

    fireEvent.click(
      await screen.findByRole("button", { name: /Open shared link/ }),
    );
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        expect.stringContaining("room_share_first"),
        "_blank",
        "noopener,noreferrer",
      ),
    );
    expect(client.roomHistory.link).not.toHaveBeenCalled();
  });

  it("issues a link only for a snapshot this session has no token for", async () => {
    const client = renderDialog({
      link: vi.fn().mockResolvedValue({ ...share, token: "room_share_issued" }),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /Open shared link/ }),
    );
    await waitFor(() =>
      expect(client.roomHistory.link).toHaveBeenCalledWith("room_1", "share_1"),
    );
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        expect.stringContaining("room_share_issued"),
        "_blank",
        "noopener,noreferrer",
      ),
    );
  });

  it("does not show the raw shared address in a snapshot row", async () => {
    renderDialog({
      link: vi.fn().mockResolvedValue({ ...share, token: "room_share_issued" }),
    });
    await screen.findByRole("button", { name: /Open shared link/ });
    expect(
      screen.queryByDisplayValue(/shared-room-history/),
    ).not.toBeInTheDocument();
  });
});
