import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, it, vi } from "vitest";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { WikiHomePage } from "./wiki-home-page";
import {
  serveWikiDocuments,
  serveWikiStatus,
  wikiDocument,
} from "./wiki.test-support";

vi.mock("@/components/read-only-blocknote-document-loader", () => ({
  ReadOnlyBlockNoteDocumentLoader: ({ markdown }: { markdown: string }) => (
    <article>{markdown}</article>
  ),
}));

it("shows real collection pages on the Wiki tab and returns to Profile", async () => {
  const runtime = createTestTeamHubRuntime();
  const page = wikiDocument("project-one", "Launch.md", "wiki_page");
  page.from[0]!.page_key = "projects/launch.md";
  serveWikiDocuments(runtime).mockResolvedValue({
    items: [page],
    page: { has_more: false },
  });
  const router = createMemoryRouter(
    [
      { path: "/t/:tenantId/library/wiki", element: <WikiHomePage /> },
      {
        path: "/t/:tenantId/documents/:documentId",
        element: <div>Document</div>,
      },
    ],
    { initialEntries: ["/t/tenant-northstar/library/wiki?tab=wiki"] },
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
  expect(await screen.findByRole("link", { name: /Launch/ })).toHaveAttribute(
    "href",
    "/t/tenant-northstar/documents/project-one",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Profile" }));
  expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.queryByRole("link", { name: /Launch/ })).toBeNull();
});

it("shows the pages a refresh has written as ordinary cards that open as pages", async () => {
  const runtime = createTestTeamHubRuntime();
  const published = wikiDocument("project-one", "Launch.md", "wiki_page");
  published.from[0]!.page_key = "projects/launch.md";
  serveWikiDocuments(runtime).mockResolvedValue({
    items: [published],
    page: { has_more: false },
  });
  serveWikiStatus(runtime).mockResolvedValue({
    created_at: "2026-08-23T00:00:00.000Z",
    id: "wiki-tenant-northstar",
    latest_refresh_id: "refresh-1",
    owner_actor_id: "actor-human",
    preview_revision: 1,
    published_generation: 1,
    state: "refreshing",
    tenant_id: "tenant-northstar",
    updated_at: "2026-08-23T00:00:00.000Z",
  });
  runtime.server.on(
    "GET",
    "/v0/tenants/{tenantId}/personal-wiki/preview",
    () => ({
      "projects/atlas.md": `---\n${JSON.stringify({ type: "Project", title: "Project Atlas", description: "Delivery analytics migration" })}\n---\n\n# Project Atlas\n\nBudget USD 210,000.\n`,
      "contacts/tom.md": `---\n${JSON.stringify({ type: "Contact", title: "Tom Becker", description: "Northwind sponsor" })}\n---\n\n# Tom Becker\n`,
    }),
  );
  const router = createMemoryRouter(
    [{ path: "/t/:tenantId/library/wiki", element: <WikiHomePage /> }],
    { initialEntries: ["/t/tenant-northstar/library/wiki?tab=wiki"] },
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
  const atlas = await screen.findByRole("link", { name: /Project Atlas/ });
  expect(atlas).toHaveTextContent("Delivery analytics migration");
  expect(atlas).not.toHaveTextContent("Updating");
  expect(atlas).toHaveAttribute(
    "href",
    "/t/tenant-northstar/wiki-preview?page=projects%2Fatlas.md",
  );
  expect(screen.getByRole("link", { name: /Launch/ })).toHaveAttribute(
    "href",
    "/t/tenant-northstar/documents/project-one",
  );
  expect(screen.getByRole("link", { name: /Tom Becker/ })).toHaveTextContent(
    "Northwind sponsor",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Another Me is writing your Wiki",
  );
  expect(screen.queryByText("No topics yet.")).toBeNull();
});
