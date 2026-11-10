import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  createMemoryRouter,
  MemoryRouter,
  RouterProvider,
  useLocation,
} from "react-router";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type {
  TeamHubDocument,
  TeamHubMemoryEntry,
} from "@/features/teamhub/teamhub-types";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { MeetingsSidebarTree, WikiFileTree } from "./knowledge-sidebar-trees";
import { serveWikiDocuments } from "./wiki.test-support";

describe("knowledge collection expansion", () => {
  it("starts the Meetings collection collapsed and toggles it in place", async () => {
    const runtime = createTestTeamHubRuntime();

    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter initialEntries={["/original"]}>
            <MeetingsSidebarTree tenantId="tenant-northstar" />
            <LocationDisplay />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Expand Meetings" }),
    ).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByText("Meetings", { exact: true }));
    expect(
      screen.getByRole("button", { name: "Collapse Meetings" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("location")).toHaveTextContent("/original");
    fireEvent.click(screen.getByText("Meetings", { exact: true }));
    expect(
      screen.getByRole("button", { name: "Expand Meetings" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Pages" })).toBeNull();
  });

  it("lists meetings under their day in Workspace, marking a ready summary", async () => {
    // 16:00 local time on 2026-09-23: the meeting is today.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 23, 16));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const runtime = createTestTeamHubRuntime();

    const entry: TeamHubMemoryEntry = {
      id: "meeting_capture",
      kind: "meeting",

      title: "Meeting 14-30-05",
      path: "Meetings/2026/09/23/Meeting 14-30-05",
      summary: "",
      content: "",
      updated_at: "2026-09-23T06:30:05Z",
      meeting: {
        capture_id: "capture",
        started_at: "2026-09-23T06:30:05Z",
        recording_document_id: "audio",
        recording_version_id: "audio_v1",
        recording_filename: "recording.m4a",
        transcript_document_id: "transcript",
        transcript_version_id: "transcript_v1",
        summary_ready: false,
      },
    };
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/memory",
      async ({ query }) => ({
        items:
          query.get("kind") === "meeting"
            ? [
                {
                  ...entry,
                  meeting: { ...entry.meeting!, summary_ready: false },
                },
              ]
            : [],
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter initialEntries={["/t/tenant-northstar/library/wiki"]}>
            <MeetingsSidebarTree tenantId="tenant-northstar" />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    expect(
      screen
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label")),
    ).toEqual(["Meetings tree"]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Expand Meetings" }),
    );
    // Meetings sit under their day's heading; the arrow opens the
    // Workspace Meetings tab on the past seven days.
    expect(screen.getByRole("link", { name: "Open Meetings" })).toHaveAttribute(
      "href",
      "/t/tenant-northstar/library?tab=meetings&meetings=7d",
    );
    const day = await screen.findByRole("region", {
      name: "Meetings on 2026-09-23",
    });
    expect(within(day).getByRole("heading", { level: 3 })).toHaveTextContent(
      "Wed, Sep 23",
    );
    // One flat row per meeting opens the meeting itself, not a file.
    const row = within(day).getByRole("link", {
      name: "Meeting 2026-09-23 14:30:05",
    });
    expect(row).toHaveAttribute(
      "href",
      "/t/tenant-northstar/library/meetings?entry=meeting_capture",
    );
    expect(row).toHaveTextContent("Meeting Sep 23, 14:30");
    expect(row).not.toHaveTextContent("recording.m4a");
    expect(
      screen.queryByRole("link", { name: /View all meetings/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Expand 2026/ })).toBeNull();
  });

  it("opens the folder holding the Document the route names", async () => {
    const runtime = createTestTeamHubRuntime();

    serveWikiDocuments(runtime).mockResolvedValue({
      items: [
        wikiPage("document-plan", "Plan", "projects/lev8/plan.md"),
        wikiPage("document-note", "Note", "topics/note.md"),
      ],
      page: { has_more: false },
    });
    const router = createMemoryRouter(
      [
        {
          element: <WikiFileTree tenantId="tenant-northstar" />,
          path: "/t/:tenantId/documents/:documentId",
        },
      ],
      {
        initialEntries: ["/t/tenant-northstar/documents/document-plan"],
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

    // The collection opens itself because the route named a file it holds, and
    // both ancestors of that file open; the unrelated folder does not.
    expect(
      await screen.findByRole("button", { name: "Collapse projects" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Collapse lev8" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Expand topics" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("link", { name: /plan\.md/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("leaves recording Session summaries to Meetings instead of listing them in Wiki", async () => {
    const runtime = createTestTeamHubRuntime();

    serveWikiDocuments(runtime).mockResolvedValue({
      items: [
        wikiPage("document-planning", "Planning", "projects/planning.md"),
        wikiPage(
          "document-meeting-session",
          "Meeting session",
          "sessions/2026-10-01/capture_session_8036995d0af5.md",
        ),
        wikiPage(
          "document-meeting-only-day",
          "Meeting only",
          "sessions/2026-09-30/capture_session_1234.md",
        ),
      ],
      page: { has_more: false },
    });
    const router = createMemoryRouter(
      [
        {
          element: <WikiFileTree tenantId="tenant-northstar" />,
          path: "/t/:tenantId/documents/:documentId",
        },
      ],
      {
        initialEntries: ["/t/tenant-northstar/documents/document-planning"],
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
    expect(
      await screen.findByRole("link", { name: /planning\.md/ }),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: /capture_session_/ })).toBeNull();
    // Days holding only recording summaries do not appear in Wiki.
    expect(screen.queryByText("2026-09-30")).toBeNull();
    expect(screen.queryByText("2026-10-01")).toBeNull();
  });

  it("preserves manual state on unrelated rerenders", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = new QueryClient();
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <MeetingsSidebarTree tenantId="tenant-northstar" />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const view = render(tree());
    fireEvent.click(screen.getByRole("button", { name: "Expand Meetings" }));
    expect(await screen.findByText("No completed meetings yet.")).toBeVisible();
    view.rerender(tree());
    expect(
      screen.getByRole("button", { name: "Collapse Meetings" }),
    ).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Collapse Meetings" }));
    expect(screen.queryByText("No completed meetings yet.")).toBeNull();
    view.rerender(tree());
    expect(
      screen.getByRole("button", { name: "Expand Meetings" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("retains manual expansion across remounts without sharing it with another Tenant or a new session", async () => {
    const runtime = createTestTeamHubRuntime();

    const client = new QueryClient();
    const tree = (tenantId: string, routeKey: string, queryClient = client) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <MeetingsSidebarTree key={routeKey} tenantId={tenantId} />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const view = render(tree("tenant-northstar", "wiki-route"));
    fireEvent.click(screen.getByText("Meetings", { exact: true }));
    expect(await screen.findByText("No completed meetings yet.")).toBeVisible();
    view.rerender(tree("tenant-northstar", "document-route"));
    expect(screen.getByText("No completed meetings yet.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Collapse Meetings" }),
    ).toHaveAttribute("aria-expanded", "true");
    view.rerender(tree("tenant-other", "other-tenant"));
    expect(
      screen.getByRole("button", { name: "Expand Meetings" }),
    ).toHaveAttribute("aria-expanded", "false");
    view.rerender(tree("tenant-northstar", "return-to-original"));
    expect(
      screen.getByRole("button", { name: "Collapse Meetings" }),
    ).toHaveAttribute("aria-expanded", "true");
    view.rerender(tree("tenant-northstar", "new-session", new QueryClient()));
    expect(
      screen.getByRole("button", { name: "Expand Meetings" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});

function LocationDisplay() {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}

function wikiPage(id: string, title: string, pageKey: string): TeamHubDocument {
  return {
    capabilities: {
      comment: true,
      delete: true,
      duplicate: true,
      export: true,
      manage: true,
      read: true,
      use_as_context: true,
      write: true,
    },
    can_edit_native_content: true,
    created_at: "2026-07-23T09:00:00Z",
    creator: {
      display_name: "Jenny Bin",
      id: "actor-jenny",
      kind: "human",
      tenant_id: "tenant-northstar",
    },
    current_version: {
      id: `${id}-v1`,
      sha256: "a".repeat(64),
      version_number: 1,
    },
    draft_capability: "write",
    format: "markdown",
    from: [
      {
        binding_kind: "wiki_page",
        context_id: "wiki-jenny",
        page_key: pageKey,
      },
    ],
    id,
    owner: {
      display_name: "Jenny Bin",
      id: "actor-jenny",
      kind: "human",
      tenant_id: "tenant-northstar",
    },
    representation_format: "markdown",
    status: "active",
    tenant_id: "tenant-northstar",
    title,
    updated_at: "2026-07-23T09:00:00Z",
  };
}
