import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WikiFileTree } from "./knowledge-sidebar-trees";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";
import { serveWikiDocuments } from "./wiki.test-support";

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("WikiFileTree", () => {
  it("starts every Wiki directory collapsed and hides navigation indexes", async () => {
    const runtime = await loggedInRuntime();
    serveWikiDocuments(runtime).mockResolvedValue({
      items: [
        wikiDocument("root-index", "Index", "wiki_page", "index.md"),
        wikiDocument("people-index", "Index", "wiki_page", "people/index.md"),
        wikiDocument(
          "person-casey-example",
          "Casey example",
          "wiki_page",
          "people/casey-example.md",
        ),
        wikiDocument(
          "projects-index",
          "Index",
          "wiki_page",
          "projects/index.md",
        ),
        wikiDocument("project-lev8", "Lev8", "wiki_page", "projects/lev8.md"),
        wikiDocument(
          "project-design",
          "Design",
          "wiki_page",
          "projects/lev8/design.md",
        ),
      ],
      page: { has_more: false },
    });
    renderPage(runtime);

    const pages = await screen.findByRole("region", { name: "Pages" });
    expect(within(pages).queryByText(/index\.md/i)).toBeNull();
    expect(pages.closest("aside")).toHaveAccessibleName("Wiki sidebar");
    expect(
      within(pages).getByRole("button", { name: "Expand people" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      within(pages).getByRole("button", { name: "Expand projects" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(within(pages).queryByText("casey-example.md")).toBeNull();
    expect(within(pages).queryByText("lev8.md")).toBeNull();
    fireEvent.click(
      within(pages).getByRole("button", { name: "Expand people" }),
    );
    expect(within(pages).getByText("casey-example.md")).toBeVisible();
    expect(within(pages).queryByText("lev8.md")).toBeNull();
    fireEvent.click(
      within(pages).getByRole("button", { name: "Expand projects" }),
    );
    expect(within(pages).getByText("lev8.md")).toBeVisible();
    expect(
      within(pages).getByRole("button", { name: "Expand lev8" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(within(pages).queryByText("design.md")).toBeNull();
    fireEvent.click(within(pages).getByRole("button", { name: "Expand lev8" }));
    expect(within(pages).getByText("design.md")).toBeVisible();

    fireEvent.click(
      within(pages).getByRole("button", { name: "Collapse people" }),
    );
    expect(
      within(pages).getByRole("button", { name: "Expand people" }),
    ).toBeVisible();
    expect(within(pages).queryByText("casey-example.md")).toBeNull();
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
  const router = createMemoryRouter(
    [
      {
        children: [
          { element: <div />, path: "/t/:tenantId/library/wiki" },
          {
            element: <div>Shared Document editor</div>,
            path: "/t/:tenantId/documents/:documentId",
          },
        ],
        element: (
          <>
            <aside aria-label="Wiki sidebar">
              <WikiFileTree tenantId="tenant-northstar" />
            </aside>
            <Outlet />
          </>
        ),
      },
    ],
    { initialEntries: ["/t/tenant-northstar/library/wiki"] },
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

function wikiDocument(
  id: string,
  title: string,
  bindingKind: "wiki_page" | "wiki_source",
  pageKey?: string,
): TeamHubDocument {
  const timestamp = "2026-08-23T00:00:00.000Z";
  const actor = {
    display_name: bindingKind === "wiki_page" ? "Wiki Agent" : "Jenny",
    id: bindingKind === "wiki_page" ? "actor-agent" : "actor-human",
    kind: bindingKind === "wiki_page" ? ("agent" as const) : ("human" as const),
    tenant_id: "tenant-northstar",
  };
  return {
    capabilities: {
      comment: bindingKind === "wiki_page",
      delete: bindingKind === "wiki_source",
      duplicate: true,
      export: true,
      manage: bindingKind === "wiki_source",
      read: true,
      use_as_context: true,
      write: true,
    },
    created_at: timestamp,
    creator: actor,
    current_version: null,
    can_edit_native_content: bindingKind === "wiki_page",
    draft_capability: bindingKind === "wiki_page" ? "write" : "none",
    format: bindingKind === "wiki_page" ? "blocknote" : "markdown",
    representation_format: "markdown",
    from: [
      {
        binding_kind: bindingKind,
        context_id: "wiki-jenny",
        label: "Personal Wiki",
        ...(pageKey ? { page_key: pageKey } : {}),
      },
    ],
    id,
    owner: actor,
    status: "active",
    tenant_id: "tenant-northstar",
    title,
    updated_at: timestamp,
  };
}
