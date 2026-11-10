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
import { LibraryLayout } from "@/features/library/library-layout";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import {
  loggedInWikiRuntime,
  serveWikiDocuments,
  wikiDocument,
} from "./wiki.test-support";
import { WikiCollectionPage } from "./wiki-collection-page";
import { WikiGraphPage } from "@/features/memory/wiki-graph-page";
import { filterWikiGraph, wikiPageKey } from "./wiki-display-state";
import type { WikiGraphData } from "@/features/memory/wiki-graph-model";
import type { TeamHubPersonalProfileDocument } from "@/features/teamhub/teamhub-types";

// Exercise Profile navigation and content with the real renderer, independently
// of the test server's first transform of the lazy Profile module.
beforeAll(async () => {
  await import("./wiki-profile-page");
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});
const graph: WikiGraphData = {
  types: ["Project"],
  nodes: ["projects/alpha", "projects/beta"].map((id) => ({
    id,
    title: id,
    category: "Project",
    description: "",
    tags: [],
    body: "",
    size: 1,
    links: ["projects/alpha"],
    backlinks: ["projects/beta"],
  })),
  edges: [{ source: "projects/alpha", target: "projects/beta" }],
};
const emptyModule = { overview: "", points: [] };
function profileDocument(
  overrides: Partial<TeamHubPersonalProfileDocument> = {},
): TeamHubPersonalProfileDocument {
  return {
    name: "Jenny Bin",
    background: {
      overview: "Existing personal profile",
      points: [],
      timeline: [],
    },
    communication_style: emptyModule,
    working_style: emptyModule,
    preferences: emptyModule,
    writing_style: emptyModule,
    ...overrides,
  };
}
const moduleHeadings = [
  "Background",
  "Communication style",
  "Working style",
  "Preferences",
  "Writing style",
];
async function setup(
  initial = "/t/tenant-northstar/library/wiki",
  profile = profileDocument(),
  pageKeys: Record<string, string> = {},
  profileResponse?: object,
) {
  const runtime = await loggedInWikiRuntime();
  const pages = ["alpha", "beta"].map((id) => {
    const page = wikiDocument(id, id, "wiki_page");
    page.from[0]!.page_key = pageKeys[id] ?? `projects/${id}.md`;
    return page;
  });
  serveWikiDocuments(runtime).mockResolvedValue({
    items: pages,
    page: { has_more: false },
  });
  runtime.server.on(
    "GET",
    "/v0/documents/{documentId}",
    ({ params }) => pages.find((page) => page.id === params.documentId)!,
  );
  vi.spyOn(runtime.client, "getPersonalProfile").mockResolvedValue(
    (profileResponse ?? { current: { profile } }) as Awaited<
      ReturnType<typeof runtime.client.getPersonalProfile>
    >,
  );
  vi.spyOn(
    runtime.client,
    "getPersonalKnowledgeGraphVisualization",
  ).mockResolvedValue(`const graph=${JSON.stringify(graph)};\n`);
  const router = createMemoryRouter(
    [
      {
        element: <LibraryLayout />,
        children: [
          {
            path: "/t/:tenantId/library/wiki/:collection?",
            element: <WikiCollectionPage />,
          },
          {
            path: "/t/:tenantId/library/wiki/graph",
            element: <WikiGraphPage />,
          },
          {
            path: "/t/:tenantId/documents/:documentId",
            element: <h1>Document</h1>,
          },
        ],
      },
    ],
    { initialEntries: [initial] },
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, runtime, queryClient, pages };
}
describe("Wiki directory", () => {
  it("opens Wiki on the Profile tab and switches to the Wiki tab", async () => {
    await setup();
    expect(
      screen.queryByRole("navigation", { name: "Wiki directory" }),
    ).toBeNull();
    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("button", { name: /Upload/ })).toBeNull();
    expect(
      await screen.findByRole("article", { name: "Profile content" }),
    ).toHaveTextContent("Existing personal profile");
    const details = screen.getByRole("complementary", {
      name: "Profile details",
    });
    // The page title is Wiki; the name appears once, in the details card.
    const name = within(details).getByRole("heading", { level: 2 }).textContent;
    expect(screen.getAllByRole("heading", { name })).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Wiki", level: 1 }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Change cover" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    const content = screen.getByRole("article", { name: "Profile content" });
    expect(content).toHaveAttribute("data-editable", "false");
    expect(
      within(content)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(moduleHeadings);
    expect(
      screen.getByRole("complementary", { name: "Profile details" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Wiki" }));
    expect(screen.getByRole("tab", { name: "Wiki" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.queryByRole("article", { name: "Profile content" }),
    ).toBeNull();
  });
  it("shows the account name once, in the details card, not in the Profile body", async () => {
    await setup("/t/tenant-northstar/library/wiki/profile");
    const content = await screen.findByRole("article", {
      name: "Profile content",
    });
    expect(screen.getAllByRole("heading", { name: "Jenny Bin" })).toHaveLength(
      1,
    );
    expect(
      within(content).queryByRole("heading", { name: "Jenny Bin" }),
    ).toBeNull();
    expect(content).toHaveTextContent("Existing personal profile");
  });
  it("renders each module from its fields as overview and point bullets", async () => {
    await setup(
      "/t/tenant-northstar/library/wiki/profile",
      profileDocument({
        background: {
          overview: "Runs research at Northstar.",
          points: [
            { title: "Current work", text: "Owns the roadmap.", items: [] },
          ],
          timeline: [],
        },
        communication_style: {
          overview: "# Not a heading *or emphasis*",
          points: [
            {
              title: "Meetings",
              text: "",
              items: ["Sends agendas first", "Writes follow-ups"],
            },
          ],
        },
      }),
    );
    const content = await screen.findByRole("article", {
      name: "Profile content",
    });
    await within(content).findByRole("heading", { name: "Background" });
    expect(
      within(content)
        .getAllByRole("heading")
        .map((heading) => [heading.tagName, heading.textContent]),
    ).toEqual(moduleHeadings.map((heading) => ["H2", heading]));
    const bullets = [
      ...content.querySelectorAll('[data-content-type="bulletListItem"]'),
    ].map((bullet) => bullet.textContent);
    expect(bullets).toEqual(
      expect.arrayContaining([
        "Current work: Owns the roadmap.",
        "Sends agendas first",
        "Writes follow-ups",
      ]),
    );
    expect(content).toHaveTextContent("# Not a heading *or emphasis*");
    expect(content).toHaveTextContent("Runs research at Northstar.");
  });
  it("renders the Background overview, then its timeline oldest first", async () => {
    const place = "\u676d\u5dde";
    await setup(
      "/t/tenant-northstar/library/wiki/profile",
      profileDocument({
        background: {
          overview: "Avery leads research.",
          points: [],
          timeline: [
            {
              period: "2026.02–Present",
              organization: "Example Co",
              place,
              role: "Product Manager",
              description: "Leads the voice product.",
              details: [
                "Owns the voice assistant launch.",
                "Works with the agent team.",
              ],
            },
            {
              period: "2019.06–2020.01",
              organization: "Example Lab",
              place: "",
              role: "",
              description: "Built screening models.",
              details: [],
            },
          ],
        },
      }),
    );
    const content = await screen.findByRole("article", {
      name: "Profile content",
    });
    await within(content).findByRole("heading", { name: "Background" });
    const timeline = within(content).getByRole("list", { name: "Timeline" });
    const entries = [
      ...timeline.querySelectorAll(".wiki-profile-timeline-entry"),
    ].map((entry) => entry.textContent);
    expect(entries).toEqual([
      "2019.06–2020.01Example LabBuilt screening models.",
      `2026.02–PresentExample Co · ${place}Product ManagerLeads the voice product.Owns the voice assistant launch.Works with the agent team.`,
    ]);
    const overview = within(content).getByText("Avery leads research.");
    expect(
      overview.compareDocumentPosition(timeline) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it("says the Profile is being written while an Agent builds it", async () => {
    await setup(
      "/t/tenant-northstar/library/wiki",
      undefined,
      {},
      {
        building_since: "2026-11-07T08:00:00Z",
      },
    );
    expect(await screen.findByText("Getting to know you…")).toBeVisible();
    expect(screen.queryByText(/Add a source under Sources/)).toBeNull();
  });
  it("keeps the current Profile under the update card", async () => {
    await setup(
      "/t/tenant-northstar/library/wiki",
      undefined,
      {},
      {
        building_since: "2026-11-07T08:00:00Z",
        current: { profile: profileDocument() },
      },
    );
    expect(
      await screen.findByText("Another Me is updating your profile"),
    ).toBeVisible();
    expect(await screen.findByText("Existing personal profile")).toBeVisible();
  });
  it("filters a collection page by name", async () => {
    await setup("/t/tenant-northstar/library/wiki/projects");
    const search = await screen.findByRole("searchbox", {
      name: "Search Projects",
    });
    expect(await screen.findByRole("link", { name: /alpha/ })).toBeVisible();
    fireEvent.change(search, { target: { value: "BET" } });
    expect(screen.queryByRole("link", { name: /alpha/ })).toBeNull();
    expect(screen.getByRole("link", { name: /beta/ })).toBeVisible();
    fireEvent.change(search, { target: { value: "gamma" } });
    expect(screen.getByText("No projects match “gamma”.")).toBeVisible();
  });
  it.each(["projects", "topics", "contacts", "clients"])(
    "shows %s with Back and no directory",
    async (collection) => {
      await setup(`/t/tenant-northstar/library/wiki/${collection}`);
      expect(
        await screen.findByRole("link", { name: "Back to Wiki" }),
      ).toHaveAttribute("href", "/t/tenant-northstar/library/wiki?tab=wiki");
      expect(
        screen.queryByRole("navigation", { name: "Wiki directory" }),
      ).toBeNull();
      expect(screen.queryByRole("link", { name: "Home" })).toBeNull();
    },
  );
  it("locks a collection through opening files until Back to Wiki", async () => {
    const { router } = await setup("/t/tenant-northstar/documents/beta");
    const files = await screen.findByRole("navigation", {
      name: "Projects files",
    });
    expect(within(files).queryByRole("link", { name: "Home" })).toBeNull();
    fireEvent.click(await within(files).findByRole("link", { name: "alpha" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/documents\/alpha$/),
    );
    expect(
      screen.queryByRole("navigation", { name: "Wiki directory" }),
    ).toBeNull();
    expect(
      screen.getByRole("navigation", { name: "Projects files" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to Wiki" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/t/tenant-northstar/library/wiki",
      ),
    );
    expect(router.state.location.search).toBe("?tab=wiki");
    expect(
      screen.queryByRole("complementary", { name: "Wiki sidebar" }),
    ).toBeNull();
  });
  it("lists the open page's own collection after following a link", async () => {
    // A Session page sits outside the collections, so the root directory shows.
    const { router } = await setup(
      "/t/tenant-northstar/documents/alpha",
      undefined,
      { alpha: "sessions/2026-10-12/alpha.md" },
    );
    const directory = await screen.findByRole("navigation", {
      name: "Wiki directory",
    });
    fireEvent.click(within(directory).getByRole("link", { name: "Topics" }));
    // A link in a Topic then opens a Project page.
    await router.navigate("/t/tenant-northstar/documents/beta");
    const projects = await screen.findByRole("navigation", {
      name: "Projects files",
    });
    expect(within(projects).getByRole("link", { name: "beta" })).toBeVisible();
    expect(
      screen.queryByRole("navigation", { name: "Topics files" }),
    ).toBeNull();
  });
  it("persists Keep/Delete locally without deleting Documents", async () => {
    const { runtime, unmount, pages } = await setup(
      "/t/tenant-northstar/documents/alpha",
    );
    const keep = await screen.findByRole("button", { name: "Keep alpha" });
    await waitFor(() => expect(keep).toBeEnabled());
    fireEvent.click(keep);
    fireEvent.click(screen.getByRole("button", { name: "Delete beta" }));
    const files = screen.getByRole("navigation", { name: "Projects files" });
    expect(within(files).getByRole("link", { name: "alpha" })).toBeVisible();
    expect(within(files).queryByText("Kept")).toBeNull();
    expect(
      within(files).queryByRole("button", { name: "Keep alpha" }),
    ).toBeNull();
    expect(
      within(files).queryByRole("button", { name: "Delete alpha" }),
    ).toBeNull();
    expect(within(files).queryByRole("link", { name: "beta" })).toBeNull();
    expect(
      runtime.server.requestsTo("DELETE", "/v0/documents/{documentId}"),
    ).toHaveLength(0);
    expect(pages).toHaveLength(2);
    unmount();
    await setup("/t/tenant-northstar/documents/alpha");
    const restored = await screen.findByRole("navigation", {
      name: "Projects files",
    });
    expect(
      await within(restored).findByRole("link", { name: "alpha" }),
    ).toBeVisible();
    expect(within(restored).queryByText("Kept")).toBeNull();
    expect(
      within(restored).queryByRole("button", { name: "Keep alpha" }),
    ).toBeNull();
    expect(
      within(restored).queryByRole("button", { name: "Delete alpha" }),
    ).toBeNull();
    expect(
      within(
        screen.getByRole("navigation", { name: "Projects files" }),
      ).queryByRole("link", { name: "beta" }),
    ).toBeNull();
  });
  it("filters hidden graph nodes and all their links without mutating the graph", () => {
    const result = filterWikiGraph(graph, {
      [wikiPageKey("projects/alpha.md")]: "delete",
    });
    expect(result.nodes.map((node) => node.id)).toEqual(["projects/beta"]);
    expect(result.edges).toEqual([]);
    expect(result.nodes[0]!.links).toEqual([]);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
  });
});
