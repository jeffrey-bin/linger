import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import { LibraryLayout } from "@/features/library/library-layout";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMemoryEntry } from "@/features/teamhub/teamhub-types";

import { MeetingPage } from "./meeting-page";

beforeAll(async () => {
  // Exercise the real preview without timing its cold module transform.
  await import("@/components/read-only-blocknote-document");
});

function meetingEntry(
  overrides: Partial<TeamHubMemoryEntry> = {},
  summaryReady = false,
): TeamHubMemoryEntry {
  return {
    id: "meeting_012345678901234567890123",
    kind: "meeting",

    title: "Meeting 14-30-05",
    path: "Meetings/2026/09/23/Meeting 14-30-05",
    content: "",
    summary: "",
    updated_at: "2026-09-23T07:00:00Z",
    meeting: {
      capture_id: "capture_meeting",
      started_at: "2026-09-23T06:30:05Z",
      recording_document_id: "audio",
      recording_version_id: "audio_v1",
      recording_filename: "recording.m4a",
      transcript_document_id: "document-meeting-transcript",
      transcript_version_id: "document-meeting-transcript-version-1",
      summary_ready: summaryReady,
    },
    ...overrides,
  };
}

/** Serves the given meetings from the list and by id. */
function serveMeetings(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  entries: TeamHubMemoryEntry[],
) {
  runtime.server.on("GET", "/v0/tenants/{tenantId}/memory", ({ query }) => ({
    items: query.get("kind") === "meeting" ? entries : [],
  }));
  serveMemoryEntry(
    runtime,
    ({ params }) => entries.find((entry) => entry.id === params.entryId)!,
  );
}

/** Answers Memory entry reads. */
function serveMemoryEntry<Handler extends TestRouteHandler>(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  handler: Handler,
) {
  runtime.server.on("GET", "/v0/tenants/{tenantId}/memory/{entryId}", handler);
  return handler;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("MeetingPage", () => {
  it("lists every meeting page in the sidebar grouped by day, newest first", async () => {
    // 18:00 local time on 2026-09-23.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 23, 18));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const runtime = await loggedInRuntime();
    const paths = [
      "2026/09/22/Meeting 12-00-00",
      "2026/09/23/Meeting 08-00-00",
      "2026/09/10/Meeting 09-00-00",
      "2026/09/23/Meeting 14-30-05",
      "2026/09/20/Meeting 08-00-00",
    ];
    const items = paths.map((path, index) =>
      meetingEntry({
        id: `meeting_${String(index).padStart(24, "0")}`,
        path: `Meetings/${path}`,
      }),
    );
    const list = vi.fn<TestRouteHandler>(({ query }) =>
      query.get("kind") !== "meeting"
        ? { items: [] }
        : query.get("cursor") === "meetings-next"
          ? { items: items.slice(3) }
          : { items: items.slice(0, 3), next_cursor: "meetings-next" },
    );
    runtime.server.on("GET", "/v0/tenants/{tenantId}/memory", list);
    renderPage(runtime);
    fireEvent.click(screen.getByRole("button", { name: "Expand Meetings" }));
    const meetingsTree = await screen.findByRole("region", {
      name: "Meetings tree",
    });
    // Every meeting on every page, grouped by day with the newest day first.
    await within(meetingsTree).findByRole("region", {
      name: "Meetings on 2026-09-20",
    });
    expect(
      list.mock.calls.map(([request]) => ({
        params: request.params,
        query: Object.fromEntries(request.query),
      })),
    ).toContainEqual({
      params: { tenantId: "tenant-northstar" },
      query: { cursor: "meetings-next", kind: "meeting", limit: "100" },
    });
    expect(
      within(meetingsTree)
        .getAllByRole("region", { name: /^Meetings on / })
        .map((day) => day.getAttribute("aria-label")),
    ).toEqual([
      "Meetings on 2026-09-23",
      "Meetings on 2026-09-22",
      "Meetings on 2026-09-20",
      "Meetings on 2026-09-10",
    ]);
    // Within a day the newest meeting comes first.
    expect(
      within(
        within(meetingsTree).getByRole("region", {
          name: "Meetings on 2026-09-23",
        }),
      )
        .getAllByRole("link", { name: /^Meeting \d{4}-\d{2}-\d{2} / })
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(["Meeting 2026-09-23 14:30:05", "Meeting 2026-09-23 08:00:00"]);
    expect(
      within(meetingsTree).queryByRole("link", { name: /^Past 7 days/ }),
    ).toBeNull();
    expect(
      within(meetingsTree).queryByRole("button", {
        name: /(?:Create|Upload|Import)/,
      }),
    ).toBeNull();
    expect(meetingsTree.querySelector('input[type="file"]')).toBeNull();
    // Sorting the presentation must not mutate the query cache's page order.
    expect(items.map((entry) => entry.path)).toEqual(
      paths.map((path) => `Meetings/${path}`),
    );
  });

  it("opens a meeting as one page: tabs on top, the recording closing Summary", async () => {
    // 16:00 local time on 2026-09-23: the meeting is today.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 23, 16));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const runtime = await loggedInRuntime();
    const entry = meetingEntry();
    serveMeetings(runtime, [entry]);
    const download = vi.spyOn(runtime.client, "downloadDocumentVersion");
    const router = renderPage(runtime);
    const meetingsToggle = screen.getByRole("button", {
      name: "Expand Meetings",
    });
    expect(meetingsToggle.querySelector("svg")).not.toBeNull();
    fireEvent.click(meetingsToggle);
    fireEvent.click(
      await screen.findByRole("link", {
        name: "Meeting 2026-09-23 14:30:05",
      }),
    );
    expect(router.state.location.search).toBe(`?entry=${entry.id}`);
    const reader = await screen.findByRole("article", { name: "Meeting" });
    expect(
      within(reader).getByRole("heading", {
        name: "Meeting · Sep 23, 14:30",
        level: 2,
      }),
    ).toBeVisible();
    // The Transcript tab holds only the transcript; the recording closes Summary.
    expect(
      within(reader).queryByRole("region", { name: "Meeting recording" }),
    ).toBeNull();
    const transcriptTab = within(reader).getByRole("tab", {
      name: "Transcript",
    });
    expect(transcriptTab).toHaveAttribute("aria-selected", "true");
    await waitFor(() =>
      expect(download).toHaveBeenCalledWith(
        "document-meeting-transcript-version-1",
        expect.anything(),
      ),
    );
    expect(
      await within(reader).findByRole("article", {
        name: "Read-only Markdown document",
      }),
    ).toHaveAttribute("data-editable", "false");
    expect(
      within(reader).getByRole("button", { name: "Download transcript.md" }),
    ).toBeInTheDocument();

    fireEvent.click(within(reader).getByRole("tab", { name: "Summary" }));
    expect(router.state.location.search).toContain("file=summary");
    expect(
      within(reader).getByText(/The summary is still being written\./),
    ).toBeVisible();
    const summaryPanel = within(reader).getByRole("tabpanel");
    expect(
      within(summaryPanel).getByRole("region", { name: "Meeting recording" }),
    ).toBeInTheDocument();
    expect(
      within(reader)
        .getByRole("tablist", { name: "Meeting views" })
        .compareDocumentPosition(
          within(summaryPanel).getByRole("region", {
            name: "Meeting recording",
          }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Meetings", level: 1 }),
    ).toBeVisible();
    // The meeting reads only; deleting removes it from the reader's Meetings.
    expect(
      within(reader).queryByRole("button", {
        name: /Edit|Rename|Move|Upload/,
      }),
    ).toBeNull();
    expect(
      within(reader).getByRole("button", { name: "Delete" }),
    ).toBeVisible();
  });

  it("adds summary only when ready and never sends it to the Document editor", async () => {
    const runtime = await loggedInRuntime();
    const entry = meetingEntry(
      {
        content:
          "---\ntype: session\ngenerated: internal-only\n---\n\n# Decisions\n\nThe meeting summary is ready.\n\n## CRM Evidence Cache\n\nInternal CRM evidence.\n\n### Client Candidates\n\nNone observed.\n\n## Workflow Evidence Cache\n\nInternal workflow evidence.\n\n## Runtime Evidence\n\nNo runtime evidence in bundle.\n\n## Subject Relation Note\n\nInternal authorization note.\n\n## Action Items\n\nConfirm the release.\n\n## Sources\n\nInternal source path.",
      },
      true,
    );
    serveMeetings(runtime, [entry]);
    renderPage(runtime, `?entry=${entry.id}&file=summary`);
    expect(
      await screen.findByRole("article", { name: "Meeting summary" }),
    ).toHaveAttribute("data-editable", "false");
    // The route names a meeting, so its collection opens to show it.
    expect(
      screen.getByRole("button", { name: "Collapse Meetings" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("The meeting summary is ready.")).toBeVisible();
    expect(screen.queryByText("CRM Evidence Cache")).toBeNull();
    expect(screen.queryByText("Internal CRM evidence.")).toBeNull();
    expect(screen.queryByText("Client Candidates")).toBeNull();
    expect(screen.queryByText("Workflow Evidence Cache")).toBeNull();
    expect(screen.queryByText("Runtime Evidence")).toBeNull();
    expect(screen.queryByText("Subject Relation Note")).toBeNull();
    expect(screen.queryByText("Internal source path.")).toBeNull();
    expect(screen.queryByText(/internal-only/)).toBeNull();
    // Not a Session page: no overview card.
    expect(
      screen.queryByRole("region", { name: "Meeting overview" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Table of contents" }));
    expect(
      await screen.findByRole("button", { name: "To-do list" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Document mode" })).toBeNull();
  });

  it("shows topic cards inside a Session page summary", async () => {
    const runtime = await loggedInRuntime();
    const entry = meetingEntry(
      {
        content:
          "---\ntype: Session\n---\n\n# Launch kickoff\n\n## Objective Summary\n\nScoped the first release [R1]. More detail.\n\n## Meeting Summary\n\n### Release plan [00:01:00 - 00:05:00]\n\n- Open source by October [R1].\n",
      },
      true,
    );
    serveMeetings(runtime, [entry]);
    renderPage(runtime, `?entry=${entry.id}&file=summary`);
    const summary = await screen.findByRole("article", {
      name: "Meeting summary",
    });
    const overview = screen.getByRole("region", { name: "Meeting overview" });
    expect(summary).toHaveTextContent("Scoped the first release.");
    expect(overview).not.toHaveTextContent("Scoped the first release.");
    expect(overview).toHaveTextContent(
      "01Release plan00:01:00 – 00:05:00Open source by October.",
    );
    expect(summary.contains(overview)).toBeTruthy();
  });

  it("scrolls summary section links in place, shows missing-section feedback, and leaves private evidence as text", async () => {
    const runtime = await loggedInRuntime();
    const entry = meetingEntry(
      {
        content:
          "## Decisions\n\n[Direction](#direction-test)\n\n[Missing section](#missing)\n\n[Raw session](../../evidence/2026-09-09/sessions/room.md)\n\n[Session source](teamhub://documents/doc-one/versions/version-one)\n\n[Website](https://example.test/)\n\n##### Direction: Test\n\nDetails.",
      },
      true,
    );
    serveMeetings(runtime, [entry]);
    const router = renderPage(runtime, `?entry=${entry.id}`);
    const article = await screen.findByRole("article", {
      name: "Meeting summary",
    });
    for (const name of ["Raw session", "Session source"]) {
      expect(within(article).queryByRole("link", { name })).toBeNull();
      expect(within(article).getByText(name)).toBeVisible();
    }
    expect(
      within(article).getByRole("link", { name: "Website" }),
    ).toHaveAttribute("href", "https://example.test/");
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    expect(
      fireEvent.click(within(article).getByRole("link", { name: "Direction" })),
    ).toBe(false);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(router.state.location.search).toBe(`?entry=${entry.id}`);
    fireEvent.click(
      within(article).getByRole("link", { name: "Missing section" }),
    );
    expect(screen.getByText(/This section is unavailable/)).toHaveAttribute(
      "role",
      "alert",
    );
    expect(article).toBeVisible();
  });

  it("starts all sidebar collections collapsed without an open meeting", async () => {
    const runtime = await loggedInRuntime();
    renderPage(runtime);

    const sidebar = screen.getByRole("complementary", {
      name: "Library sidebar",
    });
    expect(
      within(sidebar).queryByRole("button", { name: "Expand Wiki" }),
    ).toBeNull();
    for (const label of ["Owned by Me", "Shared with me", "Meetings"]) {
      expect(
        within(sidebar).getByRole("button", { name: `Expand ${label}` }),
      ).toHaveAttribute("aria-expanded", "false");
    }
    expect(
      screen.queryByRole("button", { name: "Table of contents" }),
    ).toBeNull();
  });

  it("lists only rendered summary sections and navigates without editing the summary", async () => {
    const runtime = await loggedInRuntime();
    const entry = meetingEntry(
      {
        content:
          "---\ntitle: Outline meeting\n---\n#### Summary\n\nMeeting summary.\n\n##### Next step\n\nDo the work.\n\n```markdown\n## Not a section\n```\n\n#### Sources\n\n##### Private references\n\nDo not display.\n",
      },
      true,
    );
    const original = entry.content;
    serveMeetings(runtime, [entry]);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    renderPage(runtime, `?entry=${entry.id}`);
    const article = await screen.findByRole("article", {
      name: "Meeting summary",
    });
    const button = screen.getByRole("button", { name: "Table of contents" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    const outline = await screen.findByRole("navigation", {
      name: "Document table of contents",
    });
    await waitFor(() =>
      expect(
        within(outline)
          .getAllByRole("button")
          .map((node) => node.textContent),
      ).toEqual(["Summary", "Next step"]),
    );
    expect(
      within(outline).getByRole("button", { name: "Summary" }),
    ).toHaveStyle({ paddingLeft: "8px" });
    const next = within(outline).getByRole("button", { name: "Next step" });
    expect(next).toHaveStyle({ paddingLeft: "20px" });
    fireEvent.click(next);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(article).toContainElement(
      scroll.mock.instances.at(-1) as HTMLElement,
    );
    expect(article).toHaveAttribute("data-editable", "false");
    expect(entry.content).toBe(original);
    expect(screen.queryByRole("button", { name: "Document mode" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Close table of contents" }),
    );
    expect(
      screen.queryByRole("navigation", { name: "Document table of contents" }),
    ).toBeNull();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("replaces the open outline when changing meetings and handles summaries without headings", async () => {
    const runtime = await loggedInRuntime();
    serveMeetings(runtime, [
      meetingEntry(
        {
          id: "meeting_alpha",
          content: "## Alpha summary\n\nContent.",
        },
        true,
      ),
      meetingEntry(
        {
          id: "meeting_beta",
          path: "Meetings/2026/09/23/Meeting 16-00-00",
          content: "No sections yet.",
        },
        true,
      ),
    ]);
    const router = renderPage(runtime, "?entry=meeting_alpha");
    await screen.findByText("Content.");
    fireEvent.click(screen.getByRole("button", { name: "Table of contents" }));
    const outline = await screen.findByRole("navigation", {
      name: "Document table of contents",
    });
    expect(
      await within(outline).findByRole("button", { name: "Alpha summary" }),
    ).toBeVisible();
    await act(() =>
      router.navigate(
        "/t/tenant-northstar/library/meetings?entry=meeting_beta",
      ),
    );
    await screen.findByText("No sections yet.");
    const emptyOutline = await screen.findByRole("navigation", {
      name: "Document table of contents",
    });
    expect(await within(emptyOutline).findByText("No headings")).toBeVisible();
    expect(within(emptyOutline).queryByText("Alpha summary")).toBeNull();
    await act(() => router.navigate("/t/tenant-northstar/library/meetings"));
    expect(
      screen.queryByRole("button", { name: "Table of contents" }),
    ).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Document table of contents" }),
    ).toBeNull();
  });

  it("shows a retryable meeting failure", async () => {
    const runtime = await loggedInRuntime();
    const entry = meetingEntry();
    serveMeetings(runtime, [entry]);
    const get = serveMemoryEntry(runtime, vi.fn<TestRouteHandler>())
      .mockResolvedValueOnce(
        teamHubErrorResponse(
          500,
          "MEMORY_ENTRY_UNAVAILABLE",
          "Meeting entry unavailable.",
        ),
      )
      .mockResolvedValueOnce(entry);
    renderPage(runtime, `?entry=${entry.id}`);

    expect(
      await screen.findByRole("alert", { name: "Meeting entry unavailable." }),
    ).toBeVisible();
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { entryId: entry.id, tenantId: "tenant-northstar" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry meeting" }));
    expect(
      await screen.findByRole("article", { name: "Meeting" }),
    ).toBeVisible();
  });
});

async function loggedInRuntime() {
  const runtime = createTestTeamHubRuntime();

  return runtime;
}

function renderPage(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  search = "",
) {
  const router = createMemoryRouter(
    [
      {
        element: <LibraryLayout />,
        children: [
          {
            element: <MeetingPage />,
            path: "/t/:tenantId/library/meetings",
          },
        ],
      },
    ],
    {
      initialEntries: [`/t/tenant-northstar/library/meetings${search}`],
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
