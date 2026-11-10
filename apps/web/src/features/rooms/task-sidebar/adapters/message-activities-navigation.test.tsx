import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import { MessageActivitiesPanelTab } from "./message-activities-panel-tab";

const query = vi.hoisted(() => ({
  data: {
    status: "available",
    records: [{ id: "one" }],
    has_native_turn: true,
  },
  isPending: false,
  isFetching: false,
  refetch: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => query }));
vi.mock("@/features/teamhub/teamhub-runtime", () => ({
  useTeamHubRuntime: () => ({ client: {} }),
}));
vi.mock("./runtime-history-view", () => ({
  RuntimeHistoryView: () => <p>Activity records</p>,
}));
vi.mock("../../members/actor-avatar", () => ({ ActorAvatar: () => null }));

describe("Message activity navigation", () => {
  it("jumps to latest on open and explicit reactivation, while respecting history reading", async () => {
    const message = {
      id: "message-1",
      author: { id: "agent-1", display_name: "Agent" },
    } as TeamHubMessage;
    const props = {
      message,
      roomId: "room-1",
      tenantId: "tenant-1",
      hidden: false,
    };
    const { rerender } = render(
      <MessageActivitiesPanelTab {...props} activationKey={1} />,
    );
    const scroller = screen
      .getByText("Activity records")
      .closest("section")!.parentElement!;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1600 },
      clientHeight: { configurable: true, value: 400 },
    });
    await waitFor(() => expect(scroller.scrollTop).toBe(1600));
    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);
    query.data = { ...query.data, records: [{ id: "one" }, { id: "two" }] };
    rerender(<MessageActivitiesPanelTab {...props} activationKey={1} />);
    expect(scroller.scrollTop).toBe(200);
    rerender(<MessageActivitiesPanelTab {...props} activationKey={2} />);
    await waitFor(() => expect(scroller.scrollTop).toBe(1600));
  });
});
