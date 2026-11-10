import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { waitForCurrentPublishedWiki } from "../../src/memory/teamhub-wiki.js";

function fixture() {
  let revision = 0;
  let bodyGets = 0;
  const contents = (i: number) =>
    `# Page ${i}\n\nRevision ${i < 2 ? revision : 0}.\n`;
  const manifest = () => ({
    wiki_revision_id: `revision_${revision}`,
    published_at: "2026-10-15T00:00:00Z",
    is_current: true,
    wiki_state: "idle",
    pages: Array.from({ length: 123 }, (_, i) => ({
      document_id: `document_${i}`,
      document_version_id: `version_${i}_${i < 2 ? revision : 0}`,
      page_key: `page-${i}.md`,
      media_type: "text/markdown",
      sha256: createHash("sha256").update(contents(i)).digest("hex"),
      size_bytes: Buffer.byteLength(contents(i)),
    })),
  });
  const access = {
    baseUrl: "http://teamhub.test",
    token: "fixture",
    fetch: vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/document-revision"))
        return Response.json(manifest());
      const match =
        /\/document-revisions\/([^/]+)\/documents\/document_(\d+)\//u.exec(
          request.url,
        );
      // TeamHub serves a page only from its current Wiki revision.
      if (!match || match[1] !== `revision_${revision}`)
        return new Response(null, { status: 404 });
      bodyGets++;
      return new Response(contents(Number(match[2])));
    }),
  };
  return {
    access,
    manifest,
    gets: () => bodyGets,
    next: () => {
      revision++;
      bodyGets = 0;
    },
  };
}

it("polls nine times when publication completes at 80 seconds", async () => {
  let now = 0;
  const f = fixture();
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ ...f.manifest(), is_current: now >= 80_000 }),
  );
  const waiting = waitForCurrentPublishedWiki(
    { ...f.access, fetch: fetcher },
    "owner_a",
    {
      random: () => 1,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  await waiting;
  expect(fetcher).toHaveBeenCalledTimes(9);
});
