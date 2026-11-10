import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deferred,
  loggedInWikiRuntime,
  renderWikiSurfaces,
  serveWikiDocuments,
  wikiDocument,
} from "./wiki.test-support";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";
import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";

function moveDocumentToTenant(
  document: TeamHubDocument,
  tenantId: string,
): TeamHubDocument {
  return {
    ...document,
    creator: { ...document.creator, tenant_id: tenantId },
    owner: { ...document.owner, tenant_id: tenantId },
    tenant_id: tenantId,
  };
}

// The seeded graph renders the Timeline cards; jsdom has no scroll geometry.
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value: vi.fn(),
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("Wiki Graph commands and file tree resilience", () => {
  it("rejects a Document page containing another Tenant", async () => {
    const runtime = await loggedInWikiRuntime();
    serveWikiDocuments(runtime).mockResolvedValue({
      items: [
        {
          ...wikiDocument("foreign-document", "Foreign secret", "wiki_page"),
          tenant_id: "tenant-other",
        },
      ],
      page: { has_more: false },
    });
    renderWikiSurfaces(runtime);

    expect(
      (await screen.findAllByRole("alert")).map((alert) => alert.textContent),
    ).toContainEqual(
      expect.stringContaining("Wiki Documents are unavailable."),
    );
    expect(screen.queryByText("Foreign secret")).toBeNull();
  });

  it("fails closed when loading a later Document page fails", async () => {
    const runtime = await loggedInWikiRuntime();
    const list = serveWikiDocuments(runtime)
      .mockResolvedValueOnce({
        items: [wikiDocument("first", "First page", "wiki_page")],
        page: { has_more: true, next_cursor: "next" },
      })
      .mockResolvedValueOnce(
        teamHubErrorResponse(500, "WIKI_UNAVAILABLE", "next page unavailable"),
      );
    renderWikiSurfaces(runtime);

    // The overview's own alerts can land before the file tree's.
    await waitFor(() =>
      expect(
        screen.getAllByRole("alert").map((alert) => alert.textContent),
      ).toContainEqual(expect.stringContaining("next page unavailable")),
    );
    expect(screen.queryByText("First page.md")).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    list
      .mockResolvedValueOnce({
        items: [wikiDocument("first", "First page", "wiki_page")],
        page: { has_more: true, next_cursor: "next" },
      })
      .mockResolvedValueOnce({
        items: [wikiDocument("last", "Last page", "wiki_page")],
        page: { has_more: false },
      });
    fireEvent.click(screen.getByRole("button", { name: "Retry Wiki" }));
    expect(await screen.findByText("Last page.md")).toBeVisible();
    expect(screen.getByText("First page.md")).toBeVisible();
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("does not reuse Documents across Tenant routes", async () => {
    const runtime = await loggedInWikiRuntime();
    serveWikiDocuments(runtime).mockImplementation(
      async ({ params: { tenantId = "" } }) => ({
        items: [
          moveDocumentToTenant(
            wikiDocument(
              `document-${tenantId}`,
              `Page for ${tenantId}`,
              "wiki_page",
            ),
            tenantId,
          ),
        ],
        page: { has_more: false },
      }),
    );
    const { router } = renderWikiSurfaces(runtime);
    expect(
      await screen.findByText("Page for tenant-northstar.md"),
    ).toBeVisible();

    await act(() => router.navigate("/t/tenant-other/library/wiki"));
    expect(await screen.findByText("Page for tenant-other.md")).toBeVisible();
    expect(screen.queryByText("Page for tenant-northstar.md")).toBeNull();
  });

  it("ignores a late Document page from the previous Tenant route", async () => {
    const runtime = await loggedInWikiRuntime();
    const late = deferred<{
      items: ReturnType<typeof wikiDocument>[];
      page: { has_more: false };
    }>();
    serveWikiDocuments(runtime).mockImplementation(
      async ({ params: { tenantId = "" } }) => {
        if (tenantId === "tenant-northstar") return late.promise;
        return {
          items: [
            moveDocumentToTenant(
              wikiDocument("current", "Current Tenant page", "wiki_page"),
              tenantId,
            ),
          ],
          page: { has_more: false },
        };
      },
    );
    const { router } = renderWikiSurfaces(runtime);
    expect(await screen.findByText("Loading Wiki Documents…")).toBeVisible();

    await act(() => router.navigate("/t/tenant-other/library/wiki"));
    expect(await screen.findByText("Current Tenant page.md")).toBeVisible();
    late.resolve({
      items: [wikiDocument("late", "Late previous page", "wiki_page")],
      page: { has_more: false },
    });

    await waitFor(() =>
      expect(screen.queryByText("Late previous page.md")).toBeNull(),
    );
    expect(screen.getByText("Current Tenant page.md")).toBeVisible();
  });
});
