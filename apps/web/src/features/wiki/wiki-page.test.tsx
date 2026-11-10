import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deferred,
  loggedInWikiRuntime,
  renderWikiSurfaces,
  serveWikiDocuments,
  serveWikiStatus,
  wikiDocument,
} from "./wiki.test-support";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

// jsdom supplies no scroll geometry for the Daily card track.
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value: vi.fn(),
});

describe("Wiki source commands and shared file tree", () => {
  it.each([
    ["document-page-1", "Architecture", "wiki_page", "agent"],
    ["document-page-2", "Decisions", "wiki_page", "agent"],
    ["document-page-3", "Roadmap", "wiki_page", "human"],
    ["document-page-4", "Meeting notes", "wiki_page", "agent"],
    ["document-source-1", "brief.md", "wiki_source", "human"],
    ["document-source-2", "research.txt", "wiki_source", "human"],
    ["document-source-3", "design.html", "wiki_source", "agent"],
    ["document-source-4", "data.csv", "wiki_source", "human"],
  ] as const)(
    "lists %s by document_id in the correct Wiki section",
    async (id, title, role, ownerKind) => {
      const runtime = await loggedInWikiRuntime();
      serveWikiDocuments(runtime).mockResolvedValue({
        items: [wikiDocument(id, title, role, ownerKind)],
        page: { has_more: false },
      });
      renderWikiSurfaces(runtime);

      if (role === "wiki_page") {
        const link = await screen.findByRole("link", {
          name: new RegExp(title),
        });
        expect(link).toHaveAttribute(
          "href",
          `/t/tenant-northstar/documents/${encodeURIComponent(id)}`,
        );
        expect(screen.getByRole("region", { name: "Pages" })).toContainElement(
          link,
        );
      } else {
        expect(screen.queryByText(title)).toBeNull();
        expect(
          screen.queryByRole("region", { name: "Source Documents" }),
        ).toBeNull();
      }
    },
  );

  it("shows only the canonical Pages empty state", async () => {
    const runtime = await loggedInWikiRuntime();
    serveWikiDocuments(runtime).mockResolvedValue({
      items: [],
      page: { has_more: false },
    });
    renderWikiSurfaces(runtime);

    expect(await screen.findByText("No generated pages yet.")).toBeVisible();
    expect(screen.queryByText("No source Documents yet.")).toBeNull();
  });

  it("shows generated pages without a source section", async () => {
    const runtime = await loggedInWikiRuntime();
    serveWikiDocuments(runtime).mockResolvedValue({
      items: [wikiDocument("page-only", "Page only", "wiki_page")],
      page: { has_more: false },
    });
    renderWikiSurfaces(runtime);

    expect(await screen.findByText("Page only.md")).toBeVisible();
    expect(screen.queryByText("No source Documents yet.")).toBeNull();
  });

  it("keeps source-only state hidden behind the Pages empty state", async () => {
    const runtime = await loggedInWikiRuntime();
    const list = serveWikiDocuments(runtime).mockResolvedValue({
      items: [wikiDocument("source-only", "source-only.md", "wiki_source")],
      page: { has_more: false },
    });
    renderWikiSurfaces(runtime);

    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    expect(await screen.findByText("No generated pages yet.")).toBeVisible();
    expect(screen.queryByText("source-only.md")).toBeNull();
  });

  it("fails closed and retries the authoritative Document list", async () => {
    const runtime = await loggedInWikiRuntime();
    const list = serveWikiDocuments(runtime)
      .mockResolvedValueOnce(
        teamHubErrorResponse(500, "WIKI_UNAVAILABLE", "Wiki list unavailable"),
      )
      .mockResolvedValueOnce({ items: [], page: { has_more: false } });
    renderWikiSurfaces(runtime);

    expect(
      (await screen.findAllByRole("alert")).map((alert) => alert.textContent),
    ).toContainEqual(expect.stringContaining("Wiki list unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Retry Wiki" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No generated pages yet.")).toBeVisible();
  });

  it("shows a stable loading state while the Document list is pending", async () => {
    const runtime = await loggedInWikiRuntime();
    const pending = deferred<{
      items: [];
      page: { has_more: false };
    }>();
    serveWikiDocuments(runtime).mockReturnValue(pending.promise);
    renderWikiSurfaces(runtime);

    expect(await screen.findByText("Loading Wiki Documents…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    pending.resolve({ items: [], page: { has_more: false } });
    expect(await screen.findByText("No generated pages yet.")).toBeVisible();
  });

  it.each(["cursor-a", "cursor/a", "cursor with space", "curseur-é"])(
    "automatically loads the next Document page from cursor %s without Load more",
    async (cursor) => {
      const runtime = await loggedInWikiRuntime();
      const list = serveWikiDocuments(runtime)
        .mockResolvedValueOnce({
          items: [wikiDocument("page-first", "First page", "wiki_page")],
          page: { has_more: true, next_cursor: cursor },
        })
        .mockResolvedValueOnce({
          items: [wikiDocument("page-next", "Next page", "wiki_page")],
          page: { has_more: false },
        });
      renderWikiSurfaces(runtime);

      expect(await screen.findByText("Next page.md")).toBeVisible();
      expect(screen.getByText("First page.md")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
      expect(list).toHaveBeenCalledTimes(2);
      expect(list.mock.calls[1]?.[0].query.get("cursor")).toBe(cursor);
    },
  );

  it("continues through source-only pages until all generated pages are loaded", async () => {
    const runtime = await loggedInWikiRuntime();
    const list = serveWikiDocuments(runtime)
      .mockResolvedValueOnce({
        items: [wikiDocument("source", "internal.md", "wiki_source")],
        page: { has_more: true, next_cursor: "second" },
      })
      .mockResolvedValueOnce({
        items: [wikiDocument("middle", "Middle page", "wiki_page")],
        page: { has_more: true, next_cursor: "third" },
      })
      .mockResolvedValueOnce({
        items: [wikiDocument("last", "Last page", "wiki_page")],
        page: { has_more: false },
      });
    renderWikiSurfaces(runtime);

    expect(await screen.findByText("Last page.md")).toBeVisible();
    expect(screen.getByText("Middle page.md")).toBeVisible();
    expect(screen.queryByText("internal.md")).toBeNull();
    expect(screen.queryByText("No generated pages yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(
      list.mock.calls.map(([request]) => request.query.get("cursor")),
    ).toEqual([null, "second", "third"]);
  });

  it("keeps directory expansion while automatically loading remaining pages", async () => {
    const runtime = await loggedInWikiRuntime();
    const first = wikiDocument("first", "First", "wiki_page");
    first.from[0]!.page_key = "projects/first.md";
    const next = wikiDocument("next", "Next", "wiki_page");
    next.from[0]!.page_key = "projects/next.md";
    const pending = deferred<{
      items: (typeof first)[];
      page: { has_more: false };
    }>();
    const list = serveWikiDocuments(runtime)
      .mockResolvedValueOnce({
        items: [first],
        page: { has_more: true, next_cursor: "next" },
      })
      .mockReturnValueOnce(pending.promise);
    renderWikiSurfaces(runtime);

    const expand = await screen.findByRole("button", {
      name: "Expand projects",
    });
    expect(screen.queryByText("first.md")).toBeNull();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Loading Wiki Documents…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    fireEvent.click(expand);
    expect(screen.getByText("first.md")).toBeVisible();
    pending.resolve({ items: [next], page: { has_more: false } });
    expect(await screen.findByText("next.md")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Collapse projects" }),
    ).toBeVisible();
    expect(screen.queryByText("Loading Wiki Documents…")).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not request a repeated pagination cursor indefinitely", async () => {
    const runtime = await loggedInWikiRuntime();
    const list = serveWikiDocuments(runtime)
      .mockResolvedValueOnce({
        items: [wikiDocument("first", "First page", "wiki_page")],
        page: { has_more: true, next_cursor: "same" },
      })
      .mockResolvedValue({
        items: [wikiDocument("next", "Next page", "wiki_page")],
        page: { has_more: true, next_cursor: "same" },
      });
    renderWikiSurfaces(runtime);
    expect(await screen.findByText("Next page.md")).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("never renders a Human Publish command", async () => {
    const runtime = await loggedInWikiRuntime();
    renderWikiSurfaces(runtime);

    expect(
      await screen.findByRole("heading", { name: "Wiki", level: 1 }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /publish/i })).toBeNull();
  });

  it("includes only generated files in Pages", async () => {
    const runtime = await loggedInWikiRuntime();
    serveWikiDocuments(runtime).mockResolvedValue({
      items: [
        wikiDocument("page-1", "Page one", "wiki_page"),
        wikiDocument("page-2", "Page two", "wiki_page"),
        wikiDocument("source-1", "source.md", "wiki_source"),
      ],
      page: { has_more: false },
    });
    renderWikiSurfaces(runtime);

    const pages = await screen.findByRole("region", { name: "Pages" });
    expect(within(pages).getAllByRole("link")).toHaveLength(2);
    expect(
      screen.queryByRole("region", { name: "Source Documents" }),
    ).toBeNull();
  });

  it("keeps published pages visible while Wiki refresh is loading", async () => {
    const runtime = await loggedInWikiRuntime();
    serveWikiDocuments(runtime).mockResolvedValue({
      items: [wikiDocument("page-1", "Published page", "wiki_page")],
      page: { has_more: false },
    });
    serveWikiStatus(runtime).mockResolvedValue({
      created_at: "2026-08-23T00:00:00.000Z",
      id: "wiki-jenny",
      owner_actor_id: "actor-human",
      published_generation: 1,
      state: "refreshing",
      tenant_id: "tenant-northstar",
      updated_at: "2026-08-23T00:00:00.000Z",
    });
    renderWikiSurfaces(runtime);

    expect(
      await screen.findByText("Another Me is writing your Wiki"),
    ).toBeVisible();
    expect(await screen.findByText("Published page.md")).toBeVisible();
  });

  it.each(["document/a", "document with space", "dokument-ü"])(
    "opens stable encoded Document route for %s",
    async (documentId) => {
      const runtime = await loggedInWikiRuntime();
      serveWikiDocuments(runtime).mockResolvedValue({
        items: [wikiDocument(documentId, "Open me", "wiki_page")],
        page: { has_more: false },
      });
      const { router } = renderWikiSurfaces(runtime);

      fireEvent.click(await screen.findByRole("link", { name: /Open me/ }));
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(
          `/t/tenant-northstar/documents/${encodeURIComponent(documentId)}`,
        ),
      );
    },
  );
});
