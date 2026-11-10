import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadPublishedWikiPage,
  readPublishedWiki,
  type PublishedWiki,
  type TeamHubWikiAccess,
} from "../../src/memory/teamhub-wiki.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TeamHub published Wiki reads", () => {
  it("times out a stalled manifest read with an uncancelled caller signal", async () => {
    const caller = new AbortController();
    const timeout = new AbortController();
    const timeoutFactory = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    const read = readPublishedWiki(
      {
        baseUrl: "https://teamhub.example.test",
        token: "memory-token",
        fetch: async (_input, init) => {
          const signal = init!.signal!;
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
      },
      "human_1",
      { signal: caller.signal },
    );
    const rejected = expect(read).rejects.toMatchObject({
      name: "TeamHubWikiReadError",
      retryable: true,
      cause: { name: "TimeoutError" },
    });
    timeout.abort(new DOMException("Request timed out", "TimeoutError"));
    await rejected;
    expect(caller.signal.aborted).toBe(false);
    expect(timeoutFactory).toHaveBeenCalledWith(120_000);
  });

  it("reads the published Wiki and downloads its pages", async () => {
    const contents = new Map([
      ["index.md", Buffer.from("# Index\n")],
      ["topics/memory.md", Buffer.from("# Memory\n\nCurrent design.\n")],
    ]);
    const wiki = publishedWiki(contents);
    const access: TeamHubWikiAccess = {
      baseUrl: "https://teamhub.example.test",
      token: "memory-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.get("authorization")).toBe(
          "Bearer memory-token",
        );
        if (request.url.endsWith("/document-revision")) {
          return Response.json({
            pages: wiki.pages.map((page) => ({
              document_id: page.documentId,
              document_version_id: page.documentVersionId,
              media_type: "text/markdown",
              page_key: page.path,
              sha256: page.sha256,
              size_bytes: page.sizeBytes,
            })),
            published_at: wiki.publishedAt,
            wiki_revision_id: wiki.revision,
          });
        }
        const page = wiki.pages.find((candidate) =>
          request.url.includes(`/documents/${candidate.documentId}/`),
        );
        return page
          ? new Response(contents.get(page.path))
          : new Response(null, { status: 404 });
      },
    };

    const published = await readPublishedWiki(access, "human_1");
    expect(published).toEqual(wiki);
    const page = published!.pages.find(
      (candidate) => candidate.path === "topics/memory.md",
    )!;
    await expect(
      downloadPublishedWikiPage(access, "human_1", published!.revision, page),
    ).resolves.toEqual(new Uint8Array(contents.get("topics/memory.md")!));
  });

  it("rejects a downloaded page that does not match its hash", async () => {
    const contents = new Map([["index.md", Buffer.from("# Latest\n")]]);
    const wiki = publishedWiki(contents);
    wiki.pages[0]!.sha256 = "0".repeat(64);

    await expect(
      downloadPublishedWikiPage(
        {
          baseUrl: "https://teamhub.example.test",
          token: "memory-token",
          fetch: async () => new Response(contents.get("index.md")),
        },
        "human_1",
        wiki.revision,
        wiki.pages[0]!,
      ),
    ).rejects.toThrow("integrity failed");
  });
});

function publishedWiki(contents: Map<string, Buffer>): PublishedWiki {
  return {
    pages: [...contents].map(([pagePath, content], index) => ({
      documentId: `document_${index}`,
      documentVersionId: `version_${index}`,
      path: pagePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength,
    })),
    publishedAt: "2026-09-01T12:00:00Z",
    revision: "revision_1",
  };
}
