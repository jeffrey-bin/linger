import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { LibraryLayout } from "@/features/library/library-layout";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubPersonalWiki,
  TeamHubMemoryEntry,
} from "@/features/teamhub/teamhub-types";

import { serveWikiStatus, wikiStatus } from "@/features/wiki/wiki.test-support";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import { WikiGraphPage } from "./wiki-graph-page";

afterEach(() => vi.restoreAllMocks());
// jsdom supplies no scroll geometry; the real-service proof verifies movement.
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value: vi.fn(),
});

describe("WikiGraphPage", () => {
  // These tests assert report interactions; prepare their real lazy modules first.
  beforeAll(async () => {
    await Promise.all([
      import("./wiki-graph-daily-panel"),
      import("./wiki-graph-report-cards"),
    ]);
  }, 30_000);

  it("renders one dated Daily with sections, replaces it on selection, and closes it", async () => {
    const runtime = await loggedInRuntime();
    serveWikiStatus(runtime).mockResolvedValue(wikiStatus());
    vi.spyOn(
      runtime.client,
      "getPersonalKnowledgeGraphVisualization",
    ).mockResolvedValue(
      "const graph=" +
        JSON.stringify({
          types: ["Session"],
          nodes: [
            {
              id: "sessions/2026-09-01/kickoff",
              title: "Kickoff",
              category: "Session",
              body: "Related date: 2026-09-03",
              size: 1,
              links: [],
              backlinks: [],
              tags: [],
              description: "",
            },
          ],
          edges: [],
          timelineEvents: [
            { id: "event-1", day: "2026-09-03", title: "A dated event" },
          ],
        }) +
        ";\n",
    );
    const entry = (
      day: string,
      kind: "daily" | "weekly" = "daily",
    ): TeamHubMemoryEntry => ({
      id: day,
      kind,

      path: `${kind === "daily" ? "timeline/daily" : "timeline/weekly"}/${day}.md`,
      date: day,
      title: `${kind === "daily" ? "Daily" : "Weekly"} ${day}`,
      summary: "",
      updated_at: `${day}T00:00:00Z`,
      content: `---\nformatter: internal-only\ndate: ${day}\n---\n# Daily ${day}\n\n## Work\n\nReport for ${day}.\n\n### Follow-up\n\nPending tasks.\n\n## Pattern\n\nReviewed next steps.\n\n## Sources\n\nPrivate source scaffolding.\n\n### Internal session\n\nHidden session details.`,
    });
    const list = vi.fn<TestRouteHandler>(({ query }) =>
      query.get("kind") === "weekly"
        ? { items: [entry("2026-08-31", "weekly")] }
        : query.get("cursor")
          ? { items: [entry("2026-09-01"), entry("2026-09-02")] }
          : { items: [], next_cursor: "next" },
    );
    runtime.server.on("GET", "/v0/tenants/{tenantId}/memory", list);
    const get = vi.fn<TestRouteHandler>(({ params: { entryId = "" } }) =>
      entry(entryId, entryId === "2026-08-31" ? "weekly" : "daily"),
    );
    runtime.server.on("GET", "/v0/tenants/{tenantId}/memory/{entryId}", get);
    const listRequests = () =>
      list.mock.calls.map(([request]) => ({
        params: request.params,
        query: Object.fromEntries(request.query),
      }));
    renderPage(runtime);
    const slider = await screen.findByRole("slider", {
      name: "Timeline playhead",
    });
    expect(
      screen.queryByRole("complementary", { name: "Daily report" }),
    ).toBeNull();
    expect(screen.queryByRole("radio", { name: "Relations" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Day" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(slider).toBeVisible();
    expect(
      screen.queryByText("Related date: 2026-09-03"),
    ).not.toBeInTheDocument();
    await screen.findByRole("region", { name: "Daily timeline" });
    // The timeline region exists while its paginated reports are still loading.
    await screen.findByRole("button", { name: "Open Daily for 2026-09-01" });
    const latest = slider.getAttribute("aria-valuemax")!;
    expect(slider).toHaveAttribute("aria-valuenow", latest);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toHaveAttribute("data-hidden", "true");
    fireEvent(
      screen.getByLabelText("Daily cards", { exact: true }),
      new Event("scrollend", { bubbles: true }),
    );
    expect(slider).toHaveAttribute("aria-valuenow", latest);
    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();
    fireEvent.keyDown(slider, { key: "Home" });
    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "smooth" }),
    );
    fireEvent.keyDown(slider, { key: "End" });
    const rulerDate = slider.getAttribute("aria-valuetext");
    fireEvent(
      screen.getByLabelText("Daily cards", { exact: true }),
      new Event("scrollend", { bubbles: true }),
    );
    expect(slider).toHaveAttribute("aria-valuetext", rulerDate);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(
      screen.queryByRole("complementary", { name: "Daily report" }),
    ).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Daily for 2026-09-01" }),
    );
    const first = await screen.findByRole("article", {
      name: "2026-09-01 Daily content",
    });
    expect(
      await screen.findByRole("heading", { name: "Pattern" }),
    ).toBeVisible();
    expect(first).toHaveTextContent("Report for 2026-09-01.");
    expect(first).toHaveAttribute("data-editable", "false");
    expect(first).not.toHaveTextContent("internal-only");
    expect(first).not.toHaveTextContent("Private source scaffolding");
    expect(first).not.toHaveTextContent("Hidden session details");
    const panel = screen.getByRole("complementary", { name: "Daily report" });
    expect(panel.parentElement).toBe(document.body);
    const toc = await screen.findByRole("navigation", {
      name: "Daily contents",
    });
    const work = within(toc).getByRole("button", { name: "Work" });
    const child = within(toc).getByRole("button", {
      name: "Follow-up",
    });
    expect(Number.parseInt(child.style.paddingLeft)).toBeGreaterThan(
      Number.parseInt(work.style.paddingLeft),
    );
    expect(toc).not.toHaveTextContent("Source Sessions");
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    fireEvent.click(child);
    expect(child).toHaveAttribute("aria-current", "location");
    expect(scroll).toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle Daily contents" }),
    );
    expect(
      screen.queryByRole("navigation", { name: "Daily contents" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle Daily contents" }),
    );
    expect(screen.queryByRole("button", { name: "Expand Daily" })).toBeNull();
    expect(
      within(panel).getAllByRole("button", { name: /^Resize Daily / }),
    ).toHaveLength(8);
    expect(listRequests()).toContainEqual({
      params: { tenantId: "tenant-northstar" },
      query: { kind: "daily", limit: "100", cursor: "next" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open Daily for 2026-09-02" }),
    );
    expect(
      await screen.findByRole("article", { name: "2026-09-02 Daily content" }),
    ).toHaveTextContent("Report for 2026-09-02.");
    expect(
      screen.queryByRole("article", { name: "2026-09-01 Daily content" }),
    ).toBeNull();
    expect(
      screen.getAllByRole("complementary", { name: "Daily report" }),
    ).toHaveLength(1);
    expect(screen.getByRole("complementary", { name: "Daily report" })).toBe(
      panel,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Daily" }));
    expect(
      screen.queryByRole("complementary", { name: "Daily report" }),
    ).toBeNull();
    // Reopen the same card without changing the selected period.
    fireEvent.click(
      screen.getByRole("button", { name: "Open Daily for 2026-09-02" }),
    );
    expect(
      await screen.findByRole("article", { name: "2026-09-02 Daily content" }),
    ).toBeVisible();
    // The page behind an open report is blurred; clicking it closes the report.
    const backdrop = document.querySelector(".wiki-graph-daily-backdrop")!;
    expect(backdrop).toHaveClass("backdrop-blur-sm");
    fireEvent.click(backdrop);
    expect(
      screen.queryByRole("complementary", { name: "Daily report" }),
    ).toBeNull();
    expect(document.querySelector(".wiki-graph-daily-backdrop")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Daily for 2026-09-03" }),
    );
    expect(
      await within(
        screen.getByRole("complementary", { name: "Daily report" }),
      ).findByText("No Daily report for this day."),
    ).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("radio", { name: "Week" }));
    expect(
      screen.queryByRole("complementary", { name: "Daily report" }),
    ).toBeNull();
    expect(
      await screen.findByRole("region", { name: "Weekly timeline" }),
    ).toBeVisible();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Weekly for 2026-08-31" }),
    );
    const weekly = await screen.findByRole("article", {
      name: "2026-08-31 Weekly content",
    });
    expect(weekly).toHaveTextContent("Report for 2026-08-31.");
    expect(weekly).not.toHaveTextContent("Hidden session details");
    expect(
      screen.getByRole("navigation", { name: "Weekly contents" }),
    ).toBeVisible();
    expect(listRequests()).toContainEqual({
      params: { tenantId: "tenant-northstar" },
      query: { kind: "weekly", limit: "100" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Day" }));
    expect(
      screen.queryByRole("complementary", { name: "Weekly report" }),
    ).toBeNull();
    expect(
      screen.getByRole("slider", { name: "Timeline playhead" }),
    ).toBeVisible();
  });
  it("keeps the existing graph while an update fails", async () => {
    const runtime = await loggedInRuntime();
    const html = "<!doctype html><title>Existing graph</title>";
    let wiki: TeamHubPersonalWiki = wikiStatus({
      published_generation: 1,
      state: "refreshing",
    });
    serveWikiStatus(runtime).mockImplementation(async () => ({ ...wiki }));
    vi.spyOn(
      runtime.client,
      "getPersonalKnowledgeGraphVisualization",
    ).mockResolvedValue(html);
    const { queryClient } = renderPage(runtime);
    const frame = await screen.findByTitle("Personal knowledge graph");
    wiki = wikiStatus({
      published_generation: 1,
      state: "failed",
      updated_at: "2026-09-18T12:00:00Z",
    });
    await queryClient.refetchQueries({
      queryKey: ["teamhub", "tenant-northstar", "personal-wiki", "status"],
    });
    expect(await screen.findByText("Wiki update failed")).toBeVisible();
    expect(screen.getByTitle("Personal knowledge graph")).toBe(frame);
    expect(frame).toHaveAttribute("srcdoc", html);
  });
  it("renders the tenant-scoped graph in a script-only sandbox", async () => {
    const runtime = await loggedInRuntime();
    const html = "<!doctype html><title>Knowledge Graph</title>";
    const getGraph = vi
      .spyOn(runtime.client, "getPersonalKnowledgeGraphVisualization")
      .mockResolvedValue(html);
    renderPage(runtime);

    const frame = await screen.findByTitle("Personal knowledge graph");
    expect(getGraph).toHaveBeenCalledWith("tenant-northstar");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("srcdoc", html);
    expect(
      screen.queryByRole("navigation", { name: "Wiki directory" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Upload Wiki source")).toBeNull();
  });

  it("shows a retryable error without rendering stale HTML", async () => {
    const runtime = await loggedInRuntime();
    const getGraph = vi
      .spyOn(runtime.client, "getPersonalKnowledgeGraphVisualization")
      .mockRejectedValueOnce(new Error("Graph has not been generated yet."))
      .mockResolvedValueOnce("<!doctype html><title>Recovered</title>");
    renderPage(runtime);

    expect(
      await screen.findByRole("alert", {
        name: "Graph has not been generated yet.",
      }),
    ).toBeVisible();
    expect(screen.queryByTitle("Personal knowledge graph")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry graph" }));
    await waitFor(() => expect(getGraph).toHaveBeenCalledTimes(2));
    expect(await screen.findByTitle("Personal knowledge graph")).toBeVisible();
  });

  it("shows generation progress instead of a graph failure before the first revision", async () => {
    const runtime = await loggedInRuntime();
    serveWikiStatus(runtime).mockResolvedValue(
      wikiStatus({
        published_generation: 0,
        state: "refreshing",
      }),
    );
    vi.spyOn(
      runtime.client,
      "getPersonalKnowledgeGraphVisualization",
    ).mockRejectedValue(new Error("Graph has not been generated yet."));

    renderPage(runtime);

    expect(
      await screen.findAllByText("Wiki is being generated…"),
    ).not.toHaveLength(0);
    expect(
      screen.queryByRole("alert", {
        name: "Graph has not been generated yet.",
      }),
    ).toBeNull();
  });

  it("waits for Wiki publication before reloading the graph", async () => {
    const runtime = await loggedInRuntime();
    let wiki: TeamHubPersonalWiki = wikiStatus({
      published_generation: 1,
      state: "refreshing",
    });
    let graphHtml = "<!doctype html><title>Stale graph</title>";
    serveWikiStatus(runtime).mockImplementation(async () => ({ ...wiki }));
    const getGraph = vi
      .spyOn(runtime.client, "getPersonalKnowledgeGraphVisualization")
      .mockImplementation(async () => graphHtml);
    const { queryClient } = renderPage(runtime);

    expect(
      await screen.findByTitle("Personal knowledge graph"),
    ).toHaveAttribute("srcdoc", graphHtml);
    expect(
      await screen.findByText("Another Me is writing your Wiki"),
    ).toBeVisible();
    const graphCallsBeforePublish = getGraph.mock.calls.length;

    wiki = wikiStatus({
      published_generation: 2,
      state: "idle",
    });
    graphHtml = "<!doctype html><title>Published graph</title>";
    await queryClient.refetchQueries({
      queryKey: ["teamhub", "tenant-northstar", "personal-wiki", "status"],
    });
    await waitFor(() =>
      expect(screen.getByTitle("Personal knowledge graph")).toHaveAttribute(
        "srcdoc",
        graphHtml,
      ),
    );
    expect(getGraph.mock.calls.length).toBeGreaterThan(graphCallsBeforePublish);
  });
});

async function loggedInRuntime() {
  const runtime = createTestTeamHubRuntime();

  return runtime;
}

function renderPage(runtime: ReturnType<typeof createTestTeamHubRuntime>) {
  window.sessionStorage.setItem(
    "linger:library-owned-collapsed:v2:tenant-northstar",
    "false",
  );
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        element: <LibraryLayout />,
        children: [
          {
            element: <WikiGraphPage />,
            path: "/t/:tenantId/library/wiki/graph",
          },
          {
            element: <div>Wiki pages</div>,
            path: "/t/:tenantId/library/wiki/graph",
          },
        ],
      },
    ],
    { initialEntries: ["/t/tenant-northstar/library/wiki/graph"] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { queryClient };
}
