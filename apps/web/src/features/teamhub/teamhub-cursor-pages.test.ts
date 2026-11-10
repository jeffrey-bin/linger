import { describe, expect, it, vi } from "vitest";

import { collectTeamHubCursorPages } from "./teamhub-cursor-pages";

describe("TeamHub cursor page collection", () => {
  it("collects bounded opaque cursor pages without interpreting cursors", async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: "first" }],
        page: { has_more: true, next_cursor: "opaque next" },
      })
      .mockResolvedValueOnce({
        items: [{ id: "second" }],
        page: { has_more: false },
      });

    await expect(collectTeamHubCursorPages(loadPage)).resolves.toEqual({
      items: [{ id: "first" }, { id: "second" }],
      page: { has_more: false },
    });
    expect(loadPage).toHaveBeenNthCalledWith(1, { limit: 200 });
    expect(loadPage).toHaveBeenNthCalledWith(2, {
      cursor: "opaque next",
      limit: 200,
    });
  });

  it("uses a smaller page size when the endpoint contract requires it", async () => {
    const loadPage = vi.fn().mockResolvedValue({
      items: [],
      page: { has_more: false },
    });

    await collectTeamHubCursorPages(loadPage, { pageSize: 100 });

    expect(loadPage).toHaveBeenCalledWith({ limit: 100 });
  });

  it("fails closed when TeamHub repeats a cursor", async () => {
    const loadPage = vi.fn().mockResolvedValue({
      items: [],
      page: { has_more: true, next_cursor: "repeated" },
    });

    await expect(collectTeamHubCursorPages(loadPage)).rejects.toMatchObject({
      code: "INVALID_PAGINATION",
      status: 502,
    });
  });

  it("stops a server from producing unbounded cursor pages", async () => {
    let page = 0;
    const loadPage = vi.fn().mockImplementation(async () => ({
      items: [],
      page: { has_more: true, next_cursor: `cursor-${(page += 1)}` },
    }));

    await expect(collectTeamHubCursorPages(loadPage)).rejects.toMatchObject({
      code: "PAGINATION_LIMIT_EXCEEDED",
      status: 502,
    });
    expect(loadPage).toHaveBeenCalledTimes(100);
  });

  it("stops a server from returning an unbounded item collection", async () => {
    let page = 0;
    const loadPage = vi.fn().mockImplementation(async () => ({
      items: Array.from({ length: 201 }, (_, index) => ({ index })),
      page: { has_more: true, next_cursor: `cursor-${(page += 1)}` },
    }));

    await expect(collectTeamHubCursorPages(loadPage)).rejects.toMatchObject({
      code: "PAGINATION_LIMIT_EXCEEDED",
      status: 502,
    });
    expect(loadPage).toHaveBeenCalledTimes(100);
  });
});
