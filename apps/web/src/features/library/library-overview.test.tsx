import {
  useQuery,
  useQueryClient,
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
import { Suspense } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDocumentTestRuntime,
  seedFolder,
  seedNativeDocument,
  documentSeeds,
} from "@/test/document-scenarios";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import {
  useTeamHubRuntime,
  TeamHubRuntimeProvider,
} from "@/features/teamhub/teamhub-runtime";

import { LibraryLayout } from "./library-layout";
import { LibrarySidebar } from "./library-sidebar";
import {
  LibraryDocumentsPage,
  MyDocumentsTree,
} from "./library-documents-page";

describe("Library Home", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createTestStorage(),
    });
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers My pages, Shared with me, and Meetings without Favorite or Unfiled", async () => {
    const runtime = createDocumentTestRuntime();

    renderHome(runtime);

    expect(
      await screen.findByRole("heading", { level: 2, name: "Library" }),
    ).toBeVisible();
    const tabs = within(
      screen.getByRole("tablist", { name: "Library views" }),
    ).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "My pages",
      "Shared with me",
      "Meetings",
    ]);
    expect(screen.getByRole("tab", { name: "My pages" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("tab", { name: "Recent" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Favorites" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Unfiled" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Documents" })).toBeNull();
  });

  it("shows no sidebar on the Workspace home and keeps the tab in the URL", async () => {
    const runtime = createDocumentTestRuntime();

    const { router } = renderHome(runtime);
    expect(
      await screen.findByRole("tab", { name: "My pages" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByRole("complementary", { name: "Library sidebar" }),
    ).toBeNull();
    expect(
      screen.queryByRole("separator", { name: "Resize Library sidebar" }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Owned by Me tree" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Search documents" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "File type" })).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Sort documents" }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Shared with me" }));
    expect(router.state.location.search).toBe("?tab=shared");
    expect(screen.getByRole("tab", { name: "Shared with me" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Meetings" }));
    expect(router.state.location.search).toBe("?tab=meetings");
    expect(
      screen.getByRole("radiogroup", { name: "Meeting range" }),
    ).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "File type" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "My pages" }));
    expect(router.state.location.search).toBe("");
  });

  it("lists canonical recently updated Documents as cards with source and owner", async () => {
    const runtime = createDocumentTestRuntime();

    renderHome(runtime);

    const recent = await screen.findByRole("region", { name: "Recent" });
    expect(
      await within(recent).findByRole("link", { name: "product-v0-brief.md" }),
    ).toBeVisible();
    expect(within(recent).getAllByText("Visible in room")[0]).toBeVisible();
    expect(within(recent).getAllByText("Jenny Bin")[0]).toBeVisible();
    expect(recent.querySelector("time")).not.toBeNull();
    // Download lives in the card's actions menu, not as its own button.
    expect(
      within(recent).queryByRole("button", {
        name: "Download product-v0-brief.md",
      }),
    ).toBeNull();
    expect(
      within(recent).getAllByRole("button", { name: /^Actions for / })[0],
    ).toBeVisible();
    expect(screen.queryByText(/blocknote/i)).not.toBeInTheDocument();
  });

  it("opens a recent file through its document route", async () => {
    const runtime = createDocumentTestRuntime();

    const { router } = renderHome(runtime);

    const recent = await screen.findByRole("region", { name: "Recent" });
    fireEvent.click(
      await within(recent).findByRole("link", { name: "product-v0-brief.md" }),
    );

    expect(router.state.location.pathname).toBe(
      "/t/tenant-northstar/documents/document-product-v0-brief",
    );
  });

  it("restores the My Documents sidebar scroll position after route remount", async () => {
    const runtime = createDocumentTestRuntime();

    const first = renderHome(runtime, true);
    const sidebar = await screen.findByRole("complementary", {
      name: "Library sidebar",
    });
    sidebar.scrollTop = 180;
    fireEvent.scroll(sidebar);
    first.unmount();

    renderHome(runtime, true);

    expect(
      screen.getByRole("complementary", { name: "Library sidebar" }),
    ).toHaveProperty("scrollTop", 180);
  });

  it("creates an empty My Documents folder from the sidebar tree without an Artifact room", async () => {
    const runtime = createDocumentTestRuntime();

    const folder = seedFolder(runtime, "folder-new", { name: "New Folder" });
    documentSeeds(runtime).tree.items = [];
    runtime.server.on(
      "POST",
      "/v0/tenants/{tenantId}/me/document-folders",
      () => {
        documentSeeds(runtime).tree.items = [folder];
        return folder;
      },
    );
    renderHome(runtime, true);

    await chooseCreateAction("New folder");
    expect(
      await screen.findByRole("textbox", { name: "Rename folder" }),
    ).toHaveFocus();

    await vi.waitFor(async () => {
      await expect(
        teamHubData(
          runtime.client.api.GET("/v0/tenants/{tenantId}/me/document-tree", {
            params: { path: { tenantId: "tenant-northstar" } },
          }),
        ),
      ).resolves.toEqual({
        items: expect.arrayContaining([
          expect.objectContaining({ name: "New Folder", node_kind: "folder" }),
        ]),
      });
    });
  });

  it("creates a new document in user-files from the header New menu and opens it", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(runtime, "new-page");
    runtime.server.on(
      "POST",
      "/v0/tenants/{tenantId}/documents",
      () => document,
    );
    runtime.server.on(
      "PUT",
      "/v0/tenants/{tenantId}/personal-wiki/documents/{documentId}",
      () => document,
    );
    const { router } = renderHome(runtime);
    fireEvent.click(
      await screen.findByRole("button", { name: "Create in My pages" }),
    );
    const newFile = await screen.findByRole("menuitem", { name: "New file" });
    await waitFor(() => expect(newFile).toBeEnabled());
    fireEvent.click(newFile);

    await vi.waitFor(() => {
      expect(router.state.location.pathname).toMatch(
        /^\/t\/tenant-northstar\/documents\/document-/,
      );
    });
    expect(router.state.location.pathname).not.toContain("undefined");
  });
});

async function chooseCreateAction(action: "New folder") {
  fireEvent.click(
    await screen.findByRole("button", { name: "Create in Owned by Me" }),
  );
  const item = await screen.findByRole("menuitem", { name: action });
  await waitFor(() => expect(item).toBeEnabled());
  fireEvent.click(item);
}

function TreeSurface() {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const queryKey = ["teamhub", "tenant-northstar", "document-tree"];
  const tree = useQuery({
    queryKey,
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/me/document-tree", {
          params: { path: { tenantId: "tenant-northstar" } },
        }),
      ),
  });
  return (
    <LibrarySidebar active="overview" tenantId="tenant-northstar">
      <MyDocumentsTree
        items={tree.data?.items ?? []}
        loadError={tree.error}
        pending={tree.isPending}
        tenantId="tenant-northstar"
        onChanged={() => queryClient.invalidateQueries({ queryKey })}
      />
    </LibrarySidebar>
  );
}

function renderHome(
  runtime: ReturnType<typeof createDocumentTestRuntime>,
  treeOnly = false,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        children: [
          {
            element: treeOnly ? <TreeSurface /> : <LibraryDocumentsPage />,
            index: true,
          },
        ],
        ...(treeOnly ? {} : { element: <LibraryLayout /> }),
        path: "/t/:tenantId/library",
      },
      {
        element: <p>Document surface</p>,
        path: "/t/:tenantId/documents/:documentId",
      },
    ],
    { initialEntries: ["/t/tenant-northstar/library"] },
  );

  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <Suspense fallback={<p>Loading Home</p>}>
          <div id="workspace-new-page-slot" />
          <RouterProvider router={router} />
        </Suspense>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );

  return { ...rendered, queryClient, router };
}

function createTestStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
