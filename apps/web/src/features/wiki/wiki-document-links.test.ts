import { describe, expect, it } from "vitest";

import {
  createDocumentTestRuntime,
  seedRoomDocument,
} from "@/test/document-scenarios";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { serveWikiDocuments } from "./wiki.test-support";
import {
  findWikiPageDocument,
  resolveWikiPageReference,
} from "./wiki-document-links";

describe("Wiki page references", () => {
  it.each([
    ["../projects/lev8.md", "projects/lev8.md", ""],
    ["./jenny.md", "people/jenny.md", ""],
    ["/projects/lev8.md#current-areas", "projects/lev8.md", "#current-areas"],
    ["../projects/%6cev8.md", "projects/lev8.md", ""],
    ["../index.md", "index.md", ""],
    ["../", "index.md", ""],
    ["/", "index.md", ""],
    ["/#overview", "index.md", "#overview"],
    ["../projects/", "projects/index.md", ""],
    ["../projects/lev8", "projects/lev8", ""],
    ["/projects#active", "projects", "#active"],
    ["./jenny?view=read#bio", "people/jenny", "#bio"],
    ["../topics/v1.2", "topics/v1.2", ""],
    ["/projects/#active", "projects/index.md", "#active"],
  ])(
    "resolves %s relative to the Wiki page, not the browser route",
    (href, pageKey, hash) => {
      expect(resolveWikiPageReference(href, "people/casey-example.md")).toEqual(
        {
          pageKey,
          hash,
        },
      );
    },
  );

  it.each([
    "#current-areas",
    "https://example.com/guide.md",
    "//example.com/page.md",
    "mailto:person@example.com",
    "/t/tenant/documents/document-id",
    "/t/tenant/documents/document.md",
    "bad%ZZ.md",
    "",
    "\\server\\page.md",
  ])("does not treat %s as a Wiki page", (href) => {
    expect(
      resolveWikiPageReference(href, "people/casey-example.md"),
    ).toBeNull();
  });

  it("loads later directory pages and matches the exact tenant, Wiki and page key", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedRoomDocument(runtime, "wiki-link-lookup");
    const target = {
      ...document,
      id: "linked-project",
      from: [
        {
          binding_kind: "wiki_page" as const,
          context_id: "wiki-jenny",
          page_key: "projects/lev8.md",
        },
      ],
    };
    const list = serveWikiDocuments(runtime)
      .mockResolvedValueOnce({
        items: [
          { ...target, id: "wrong-tenant", tenant_id: "another-tenant" },
          {
            ...target,
            id: "wrong-wiki",
            from: [{ ...target.from[0]!, context_id: "other-wiki" }],
          },
          {
            ...target,
            id: "source-only",
            from: [{ ...target.from[0]!, binding_kind: "wiki_source" }],
          },
          {
            ...target,
            id: "same-filename",
            from: [{ ...target.from[0]!, page_key: "products/lev8.md" }],
          },
        ],
        page: { has_more: true, next_cursor: "page-2" },
      })
      .mockResolvedValueOnce({ items: [target], page: { has_more: false } });
    await expect(
      findWikiPageDocument(
        runtime.client,
        document,
        "wiki-jenny",
        "projects/lev8.md",
      ),
    ).resolves.toBe("linked-project");
    expect(list).toHaveBeenCalledTimes(2);
    const request = list.mock.calls[1]?.[0];
    expect(request?.params).toEqual({ tenantId: document.tenant_id });
    expect(Object.fromEntries(request?.query ?? [])).toEqual({
      cursor: "page-2",
      limit: "100",
    });
  });

  it.each(["projects/lev8.md", "projects/lev8/index.md"])(
    "opens an extensionless link to %s in the same Wiki",
    async (pageKey) => {
      const source = { id: "source", tenant_id: "tenant", from: [] };
      const target = {
        id: "target",
        tenant_id: "tenant",
        from: [
          {
            binding_kind: "wiki_page" as const,
            context_id: "wiki",
            page_key: pageKey,
          },
        ],
      };
      const runtime = createTestTeamHubRuntime();
      serveWikiDocuments(runtime).mockResolvedValue({
        items: [
          { ...target, id: "wrong-tenant", tenant_id: "other" },
          {
            ...target,
            id: "wrong-wiki",
            from: [{ ...target.from[0]!, context_id: "other" }],
          },
          {
            ...target,
            id: "source-only",
            from: [{ ...target.from[0]!, binding_kind: "wiki_source" }],
          },
          target,
        ],
        page: { has_more: false },
      });
      await expect(
        findWikiPageDocument(runtime.client, source, "wiki", "projects/lev8"),
      ).resolves.toBe("target");
    },
  );

  it("prefers the Markdown page over a directory index on an earlier directory page", async () => {
    const source = { id: "source", tenant_id: "tenant", from: [] };
    const target = {
      id: "page",
      tenant_id: "tenant",
      from: [
        {
          binding_kind: "wiki_page" as const,
          context_id: "wiki",
          page_key: "projects/lev8.md",
        },
      ],
    };
    const runtime = createTestTeamHubRuntime();
    const list = serveWikiDocuments(runtime)
      .mockResolvedValueOnce({
        items: [
          {
            ...target,
            id: "index",
            from: [{ ...target.from[0]!, page_key: "projects/lev8/index.md" }],
          },
        ],
        page: { has_more: true, next_cursor: "page-2" },
      })
      .mockResolvedValueOnce({ items: [target], page: { has_more: false } });
    await expect(
      findWikiPageDocument(runtime.client, source, "wiki", "projects/lev8"),
    ).resolves.toBe("page");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("uses the current page for self-links and fails explicitly for missing pages or broken pagination", async () => {
    const source = {
      id: "person",
      tenant_id: "tenant",
      from: [
        {
          binding_kind: "wiki_page" as const,
          context_id: "wiki",
          page_key: "people/person.md",
        },
      ],
    };
    const runtime = createTestTeamHubRuntime();
    const { client } = runtime;
    const list = serveWikiDocuments(runtime).mockResolvedValue({
      items: [],
      page: { has_more: false },
    });
    await expect(
      findWikiPageDocument(client, source, "wiki", "people/person.md"),
    ).resolves.toBe("person");
    await expect(
      findWikiPageDocument(client, source, "wiki", "people/person"),
    ).resolves.toBe("person");
    expect(list).not.toHaveBeenCalled();
    await expect(
      findWikiPageDocument(client, source, "wiki", "missing.md"),
    ).rejects.toThrow("unavailable");
    list.mockResolvedValue({
      items: [],
      page: { has_more: true, next_cursor: "same" },
    });
    await expect(
      findWikiPageDocument(client, source, "wiki", "missing.md"),
    ).rejects.toThrow("directory could not be loaded");
    expect(list).toHaveBeenCalledTimes(3);
  });
});
