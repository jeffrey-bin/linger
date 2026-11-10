import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, it, vi } from "vitest";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { WikiPreviewPage } from "./wiki-preview-page";
import {
  serveWikiDocuments,
  serveWikiStatus,
  wikiDocument,
} from "./wiki.test-support";

vi.mock("@/components/read-only-blocknote-document-loader", () => ({
  ReadOnlyBlockNoteDocumentLoader: ({
    markdown,
    resolveLink,
  }: {
    markdown: string;
    resolveLink: (reference: string) => string | null | undefined;
  }) => (
    <article>
      {markdown}
      <a href={resolveLink("../clients/contactout.md") ?? undefined}>
        ContactOut
      </a>
    </article>
  ),
}));

it("opens a page being written in the published page layout", async () => {
  const runtime = createTestTeamHubRuntime();
  const contactOut = wikiDocument("client-one", "ContactOut.md", "wiki_page");
  contactOut.from[0]!.page_key = "clients/contactout.md";
  serveWikiDocuments(runtime).mockResolvedValue({
    items: [contactOut],
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
      "projects/lev8.md": `---\n${JSON.stringify({ type: "Project", title: "Lev8" })}\n---\n\n# Lev8\n\nVisitor identity.\n`,
    }),
  );
  const router = createMemoryRouter(
    [{ path: "/t/:tenantId/wiki-preview", element: <WikiPreviewPage /> }],
    {
      initialEntries: [
        "/t/tenant-northstar/wiki-preview?page=projects%2Flev8.md",
      ],
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
    await screen.findByRole("heading", { level: 1, name: "Lev8" }),
  ).toBeVisible();
  expect(screen.getByText("Lev8.md")).toBeVisible();
  expect(screen.getByText("Generating")).toHaveAttribute(
    "title",
    "Not published yet. This page may still change.",
  );
  expect(screen.getByText(/Visitor identity\./)).toBeVisible();
  expect(screen.getByRole("link", { name: "ContactOut" })).toHaveAttribute(
    "href",
    "/t/tenant-northstar/documents/client-one",
  );
});
