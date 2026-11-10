import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMemoryEntry } from "@/features/teamhub/teamhub-types";

import {
  MeetingsPanel,
  meetingsRangeFromSearch,
  meetingsTabPath,
} from "./meetings-panel";

function meeting(
  id: string,
  path: string,
  filename: string,
  summaryReady = false,
): TeamHubMemoryEntry {
  return {
    id,
    kind: "meeting",

    title: path.split("/").at(-1)!,
    path,
    content: "",
    summary: "",
    updated_at: "2026-10-01T08:00:00Z",
    meeting: {
      capture_id: `capture_${id}`,
      started_at: "2026-10-01T08:00:00Z",
      recording_document_id: "audio",
      recording_version_id: "audio_v1",
      recording_filename: filename,
      transcript_document_id: "transcript",
      transcript_version_id: "transcript_v1",
      summary_ready: summaryReady,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 16:00 local time on 2026-10-01.
  vi.setSystemTime(new Date(2026, 9, 1, 16));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Panel() {
  const { tenantId } = useParams();
  return <MeetingsPanel tenantId={tenantId!} />;
}

let items: TeamHubMemoryEntry[] = [];

function renderPanel(search = "") {
  const runtime = createTestTeamHubRuntime();
  items = [
    meeting(
      "meeting_000000000000000000000002",
      "Meetings/2026/10/01/Meeting 17-41-02",
      "afternoon.m4a",
      true,
    ),
    meeting(
      "meeting_000000000000000000000001",
      "Meetings/2026/10/01/Meeting 09-05-00",
      "morning.m4a",
    ),
    meeting(
      "meeting_000000000000000000000004",
      "Meetings/2026/09/28/Meeting 11-00-00",
      "standup.m4a",
    ),
    meeting(
      "meeting_000000000000000000000003",
      "Meetings/2026/09/23/Meeting 14-30-05",
      "review.m4a",
    ),
  ];
  runtime.server.on("GET", "/v0/tenants/{tenantId}/memory", ({ query }) => ({
    items: query.get("kind") === "meeting" ? items : [],
  }));
  runtime.server.on(
    "DELETE",
    "/v0/tenants/{tenantId}/me/meetings/{captureSessionId}",
    ({ params }) => {
      items = items.filter(
        (item) => item.meeting?.capture_id !== params.captureSessionId,
      );
    },
  );
  const router = createMemoryRouter(
    [
      { element: <Panel />, path: "/t/:tenantId/library" },
      {
        element: <div>Meeting page</div>,
        path: "/t/:tenantId/library/meetings",
      },
    ],
    {
      initialEntries: [`/t/tenant-northstar/library?tab=meetings${search}`],
    },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return router;
}

function dayRegions(list: HTMLElement) {
  return within(list)
    .getAllByRole("region", { name: /^Meetings on / })
    .map((day) => day.getAttribute("aria-label"));
}

describe("Meetings panel", () => {
  it("collapses a date and reopens it when selected in the calendar", async () => {
    renderPanel();
    const toggle = await screen.findByRole("button", { name: /Thu, Oct 1/ });
    expect(
      screen.getByRole("link", { name: "Meeting Oct 1, 09:05" }),
    ).toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("link", { name: "Meeting Oct 1, 09:05" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "2026-10-01: 2 meetings" }),
    );
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("opens on the past seven days with one square per day", async () => {
    renderPanel();
    const recent = await screen.findByRole("region", { name: "Past 7 days" });
    expect(screen.getByRole("radio", { name: "Past 7 days" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // 2026-09-23 is eight days before 2026-10-01 and stays out of the list.
    expect(dayRegions(recent)).toEqual([
      "Meetings on 2026-10-01",
      "Meetings on 2026-09-28",
    ]);
    // The calendar narrows to seven squares, oldest first, today last.
    const calendar = screen.getByRole("region", { name: "Meeting calendar" });
    expect(
      within(calendar)
        .getAllByRole("button")
        .map((day) => day.getAttribute("aria-label")),
    ).toEqual([
      "2026-09-25: 0 meetings",
      "2026-09-26: 0 meetings",
      "2026-09-27: 0 meetings",
      "2026-09-28: 1 meeting",
      "2026-09-29: 0 meetings",
      "2026-09-30: 0 meetings",
      "2026-10-01: 2 meetings",
    ]);
    const todaySquare = within(calendar).getByRole("button", {
      name: "2026-10-01: 2 meetings",
    });
    expect(todaySquare).toHaveTextContent("2");
    expect(todaySquare).toHaveAttribute("aria-pressed", "true");
    expect(within(calendar).getByText("Today")).toBeVisible();
  });

  it("links each meeting and its ready summary to the meeting entry", async () => {
    const router = renderPanel();
    const today = await screen.findByRole("region", {
      name: "Meetings on 2026-10-01",
    });
    expect(
      within(today)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Meeting Oct 1, 09:05", "Meeting Oct 1, 17:41", "Summary"]);
    const entry =
      "/t/tenant-northstar/library/meetings?entry=meeting_000000000000000000000002";
    expect(
      within(today).getByRole("link", { name: "Meeting Oct 1, 17:41" }),
    ).toHaveAttribute("href", entry);
    expect(
      within(today).getByRole("link", {
        name: "Summary of Meeting Oct 1, 17:41",
      }),
    ).toHaveAttribute("href", entry);
    // A meeting without a summary offers no Summary link.
    expect(
      within(today).queryByRole("link", {
        name: "Summary of Meeting Oct 1, 09:05",
      }),
    ).toBeNull();
    fireEvent.click(
      within(today).getByRole("link", {
        name: "Summary of Meeting Oct 1, 17:41",
      }),
    );
    expect(router.state.location.pathname).toBe(
      "/t/tenant-northstar/library/meetings",
    );
  });

  it("deletes a meeting from the list after confirming", async () => {
    renderPanel();
    const today = await screen.findByRole("region", {
      name: "Meetings on 2026-10-01",
    });
    fireEvent.click(
      within(today).getByRole("button", {
        name: "Delete Meeting Oct 1, 09:05",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Delete meeting" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "Meeting Oct 1, 09:05" }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: "Meeting Oct 1, 17:41" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "2026-10-01: 1 meeting" }),
    ).toBeInTheDocument();
  });

  it("shows the year and every meeting newest day first under All meetings, and searches", async () => {
    const router = renderPanel();
    await screen.findByRole("region", { name: "Past 7 days" });
    fireEvent.click(screen.getByRole("radio", { name: "All meetings" }));
    expect(router.state.location.search).toBe("?tab=meetings&meetings=all");
    const all = screen.getByRole("region", { name: "All meetings" });
    expect(dayRegions(all)).toEqual([
      "Meetings on 2026-10-01",
      "Meetings on 2026-09-28",
      "Meetings on 2026-09-23",
    ]);
    // The year heatmap offers squares beyond the past seven days, but none
    // after today.
    const calendar = screen.getByRole("region", { name: "Meeting calendar" });
    expect(within(calendar).getAllByRole("button").length).toBeGreaterThan(7);
    expect(
      within(calendar).queryByRole("button", { name: /^2026-10-02:/ }),
    ).toBeNull();
    fireEvent.click(
      within(calendar).getByRole("button", { name: "2026-09-23: 1 meeting" }),
    );
    expect(
      within(calendar).getByRole("button", { name: "2026-09-23: 1 meeting" }),
    ).toHaveAttribute("aria-pressed", "true");

    const search = within(all).getByRole("searchbox", {
      name: "Search meetings",
    });
    fireEvent.change(search, { target: { value: "morning" } });
    expect(
      within(all)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Meeting Oct 1, 09:05"]);
    fireEvent.change(search, { target: { value: "nothing" } });
    expect(within(all).getByText("No meetings match “nothing”.")).toBeVisible();
  });

  it("shows only today's meetings and no calendar under Today", async () => {
    renderPanel("&meetings=today");
    const today = await screen.findByRole("region", { name: "Today" });
    expect(screen.getByRole("radio", { name: "Today" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(dayRegions(today)).toEqual(["Meetings on 2026-10-01"]);
    expect(
      screen.queryByRole("region", { name: "Meeting calendar" }),
    ).toBeNull();
  });

  it("keeps the chosen range in the URL", async () => {
    const router = renderPanel("&meetings=all");
    await screen.findByRole("region", { name: "All meetings" });
    fireEvent.click(screen.getByRole("radio", { name: "Today" }));
    expect(router.state.location.search).toBe("?tab=meetings&meetings=today");
    fireEvent.click(screen.getByRole("radio", { name: "Past 7 days" }));
    expect(router.state.location.search).toBe("?tab=meetings&meetings=7d");
    expect(
      screen.getByRole("region", { name: "Past 7 days" }),
    ).toBeInTheDocument();
  });

  it("reads and writes the range parameter", () => {
    expect(meetingsRangeFromSearch(new URLSearchParams(""))).toBe("week");
    expect(meetingsRangeFromSearch(new URLSearchParams("meetings=7d"))).toBe(
      "week",
    );
    expect(meetingsRangeFromSearch(new URLSearchParams("meetings=today"))).toBe(
      "today",
    );
    expect(meetingsRangeFromSearch(new URLSearchParams("meetings=all"))).toBe(
      "all",
    );
    expect(meetingsTabPath("tenant-northstar", "week")).toBe(
      "/t/tenant-northstar/library?tab=meetings&meetings=7d",
    );
    expect(meetingsTabPath("tenant-northstar", "all")).toBe(
      "/t/tenant-northstar/library?tab=meetings&meetings=all",
    );
  });
});
