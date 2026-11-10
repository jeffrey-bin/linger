import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { seedTeamMd } from "@/test/teamhub-seed";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { CollaborationGraph, CollaborationPanel } from "./collaboration-panel";

describe("Collaboration", () => {
  it("selects an avatar, displays the actual assignment and restores all highlights on empty space", () => {
    const document = structuredClone(seedTeamMd);
    document.members.push({
      name: "Second reviewer",
      actor_id: "reviewer-2",
      receive_from: ["Codex"],
      report_to: ["Codex"],
      role: "Check accessibility.",
    });
    render(<CollaborationGraph actors={[]} document={document} />);
    const graph = screen.getByRole("group", {
      name: "Agent collaboration graph",
    });
    const reviewer = within(graph).getByRole("button", {
      name: "Lev8 GTM · Verifier",
    });
    fireEvent.click(within(reviewer).getByRole("img"));
    expect(reviewer).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(document.members[0]!.role!)).toBeVisible();
    expect(
      within(graph).getByRole("button", { name: "Second reviewer · Verifier" }),
    ).toHaveAttribute("data-faded", "true");
    expect(
      within(graph).getByRole("button", { name: "Codex · Coordinator" }),
    ).not.toHaveAttribute("data-faded");
    const handoffs = screen.getByRole("button", { name: "Handoff" });
    expect(handoffs).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(handoffs);
    expect(reviewer).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(graph.querySelector("svg")!);
    expect(reviewer).toHaveAttribute("aria-pressed", "false");
    expect(graph.querySelectorAll('[data-faded="true"]')).toHaveLength(0);
    expect(handoffs).toHaveAttribute("aria-pressed", "false");
    expect(
      graph.querySelectorAll('[data-relationship="handoff"]'),
    ).toHaveLength(0);
    expect(graph.querySelectorAll('[data-relationship="report"]')).toHaveLength(
      2,
    );
    expect(screen.getByText(document.task_goal)).toBeVisible();
  });

  it("handles missing roles and clears a removed selection when the protocol changes", () => {
    const document = structuredClone(seedTeamMd);
    delete document.members[0]!.role;
    const view = render(<CollaborationGraph actors={[]} document={document} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Lev8 GTM · Verifier" }),
    );
    expect(
      screen.getByText("No responsibility specified in team.md."),
    ).toBeVisible();
    document.members = [
      { ...document.members[0]!, name: "New verifier", actor_id: "new" },
    ];
    view.rerender(<CollaborationGraph actors={[]} document={document} />);
    expect(screen.getByText(document.task_goal)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Lev8 GTM · Verifier" }),
    ).toBeNull();
  });

  it("loads only when opened, refreshes revisions and isolates Room data", async () => {
    const runtime = createTestTeamHubRuntime();
    const read = vi.fn<TestRouteHandler>(() => seedTeamMd);
    runtime.server.on("GET", "/v0/rooms/{roomId}/team-md", read);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const panel = (hidden: boolean, roomId = "room-a") => (
      <QueryClientProvider client={client}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <CollaborationPanel
            actors={[]}
            hidden={hidden}
            roomId={roomId}
            tenantId="tenant-a"
          />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const view = render(panel(true));
    expect(read).not.toHaveBeenCalled();
    view.rerender(panel(false));
    await screen.findByText(seedTeamMd.task_goal);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ params: { roomId: "room-a" } }),
    );
    read.mockReturnValue({
      ...seedTeamMd,
      revision: 2,
      task_goal: "Updated goal",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh collaboration" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh collaboration" }),
    );
    await screen.findByText("Updated goal");
    read.mockReturnValue(teamHubErrorResponse(404, "NOT_FOUND", "Missing"));
    view.rerender(panel(false, "room-b"));
    await screen.findByText("No collaboration plan yet");
    expect(screen.queryByText("Updated goal")).toBeNull();
    client.clear();
  });

  it.each([403, 500])(
    "shows %s as an error instead of an empty team and can retry",
    async (status) => {
      const runtime = createTestTeamHubRuntime();
      const read = vi.fn<TestRouteHandler>(() =>
        teamHubErrorResponse(status, "ERROR", "Unavailable"),
      );
      runtime.server.on("GET", "/v0/rooms/{roomId}/team-md", read);
      const client = new QueryClient();
      render(
        <QueryClientProvider client={client}>
          <TeamHubRuntimeProvider runtime={runtime}>
            <CollaborationPanel
              actors={[]}
              hidden={false}
              roomId="room-a"
              tenantId="tenant-a"
            />
          </TeamHubRuntimeProvider>
        </QueryClientProvider>,
      );
      await screen.findByRole("alert");
      expect(screen.queryByText("No collaboration plan yet")).toBeNull();
      read.mockReturnValue(seedTeamMd);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText(seedTeamMd.task_goal);
      client.clear();
    },
  );
});
