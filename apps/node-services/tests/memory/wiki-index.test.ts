import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

import { agentMemoryRoot } from "../../src/memory/paths.js";
import type { RawSource } from "../../src/memory/search/source-store.js";
import type { AnotherMeSubject } from "../../src/memory/types.js";
import { readIndexedWiki, WikiIndex } from "../../src/memory/wiki-index.js";

interface Held {
  source: RawSource;
  content: string;
  searchable: boolean;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true })),
  );
});

function subject(agent: string, owner = "owner_a"): AnotherMeSubject {
  return {
    tenantId: "tenant_a",
    agentActorId: `actor_${agent}`,
    agentManagementId: agent,
    agentDisplayName: agent,
    representedHumanActorId: owner,
    representedHumanDisplayName: owner,
    representedHumanAccountId: null,
    memorySubjectKey: agent,
  };
}

/** The index as the Wiki index sees it: sources by ID, read back over SQL. */
function memoryIndex() {
  const held = new Map<string, Held>();
  const chunks = {
    indexDatabaseSource: vi.fn(
      async (
        source: RawSource,
        content: string,
        options: { searchable?: boolean } = {},
      ) => {
        const prior = held.get(source.id);
        held.set(source.id, {
          source,
          content,
          searchable: options.searchable ?? true,
        });
        return prior?.source.contentHash !== source.contentHash;
      },
    ),
    retireDatabaseSources: vi.fn(
      async (
        identity: RawSource["identity"],
        originKind: string,
        keep: readonly string[],
        collection?: string,
      ) => {
        let retired = 0;
        for (const [id, entry] of held)
          if (
            entry.source.identity.agent_id === identity.agent_id &&
            entry.source.originKind === originKind &&
            (collection === undefined ||
              entry.source.metadata?.collection === collection) &&
            !keep.includes(id)
          ) {
            held.delete(id);
            retired += 1;
          }
        return retired;
      },
    ),
  };
  const sql = vi.fn(async (parts: TemplateStringsArray) => {
    if (!parts.join("?").includes("DISTINCT ON")) return [];
    const pages = new Map<
      string,
      { metadata: Record<string, string>; title: string; content: string }
    >();
    for (const { source, content } of held.values())
      if (source.originKind === "wiki")
        pages.set(source.metadata!.page_key!, {
          metadata: { ...source.metadata! },
          title: source.title,
          content,
        });
    return [...pages.values()];
  }) as unknown as postgres.Sql;
  return { held, chunks, sql };
}

/** A published Wiki whose first two pages change with each revision. */
function publishedWiki(pageCount = 3) {
  let revision = 0;
  let bodyGets = 0;
  const contents = (i: number) =>
    i === 0
      ? "# Index\n"
      : `# Page ${i}\n\nRevision ${i < 3 ? revision : 0}.\n`;
  const pages = () =>
    Array.from({ length: pageCount }, (_, i) => ({
      document_id: `document_${i}`,
      document_version_id: `version_${i}_${i > 0 && i < 3 ? revision : 0}`,
      page_key: i === 0 ? "index.md" : `projects/page-${i}.md`,
      media_type: "text/markdown",
      sha256: createHash("sha256").update(contents(i)).digest("hex"),
      size_bytes: Buffer.byteLength(contents(i)),
    }));
  const access = {
    baseUrl: "http://teamhub.test",
    token: "fixture",
    fetch: vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/document-revision"))
        return Response.json({
          wiki_revision_id: `revision_${revision}`,
          published_at: "2026-10-15T00:00:00Z",
          is_current: true,
          wiki_state: "idle",
          pages: pages(),
        });
      const match =
        /\/document-revisions\/([^/]+)\/documents\/document_(\d+)\//u.exec(
          request.url,
        );
      if (!match || match[1] !== `revision_${revision}`)
        return new Response(null, { status: 404 });
      bodyGets += 1;
      return new Response(contents(Number(match[2])));
    }),
  };
  return {
    access,
    gets: () => bodyGets,
    next: () => {
      revision += 1;
      bodyGets = 0;
    },
  };
}

async function dataRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-index-"));
  roots.push(root);
  return root;
}

describe("published Wiki in the one index", () => {
  it("indexes each page as a wiki source of every Another Me and downloads only changed versions", async () => {
    const index = memoryIndex();
    const wiki = publishedWiki(123);
    const subjects = [subject("agent_a"), subject("agent_other", "owner_b")];
    const wikiIndex = new WikiIndex(
      index.chunks,
      await dataRoot(),
      wiki.access,
      index.sql,
      async () => subjects,
    );
    try {
      await wikiIndex.indexWiki("tenant_a", "owner_a");
      expect(wiki.gets()).toBe(123);
      expect(index.held.size).toBe(123);
      const sources = [...index.held.values()];
      expect(
        sources.every(
          ({ source }) =>
            source.originKind === "wiki" &&
            source.sourceKind === "wiki_page" &&
            source.identity.agent_id === "agent_a",
        ),
      ).toBe(true);
      // The navigation page is kept for the graph but has no chunks.
      expect(
        sources.find(({ source }) => source.metadata?.page_key === "index.md")
          ?.searchable,
      ).toBe(false);

      wiki.next();
      await wikiIndex.indexWiki("tenant_a", "owner_a");
      expect(wiki.gets()).toBe(2);
      const read = await readIndexedWiki(
        "tenant_a",
        "owner_a",
        undefined,
        index.sql,
      );
      expect(read.pages).toHaveLength(123);
      expect(
        read.pages.filter((page) => page.content.includes("Revision 1")),
      ).toHaveLength(2);
      expect(read.revision).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await wikiIndex.close();
    }
  });

  it("never mixes revisions when the Wiki is republished during download", async () => {
    const index = memoryIndex();
    const wiki = publishedWiki(5);
    let switched = false;
    const interrupted = {
      ...wiki.access,
      fetch: vi.fn<typeof fetch>(async (input, init) => {
        const url = new Request(input, init).url;
        if (!url.endsWith("/document-revision") && !switched) {
          switched = true;
          wiki.next();
        }
        return wiki.access.fetch(input, init);
      }),
    };
    const wikiIndex = new WikiIndex(
      index.chunks,
      await dataRoot(),
      interrupted,
      index.sql,
      async () => [subject("agent_a")],
    );
    try {
      await expect(wikiIndex.indexWiki("tenant_a", "owner_a")).rejects.toThrow(
        "404",
      );
      expect(index.held.size).toBe(0);
      await wikiIndex.indexWiki("tenant_a", "owner_a");
      expect(index.held.size).toBe(5);
    } finally {
      await wikiIndex.close();
    }
  });

  it("retires pages the published Wiki no longer has", async () => {
    const index = memoryIndex();
    const wiki = publishedWiki(3);
    const wikiIndex = new WikiIndex(
      index.chunks,
      await dataRoot(),
      wiki.access,
      index.sql,
      async () => [subject("agent_a")],
    );
    try {
      await wikiIndex.indexWiki("tenant_a", "owner_a");
      const stale = {
        ...[...index.held.values()][1]!,
        source: {
          ...[...index.held.values()][1]!.source,
          id: "f".repeat(64),
        },
      };
      index.held.set(stale.source.id, stale);
      await wikiIndex.indexWiki("tenant_a", "owner_a");
      expect(index.held.has("f".repeat(64))).toBe(false);
      expect(index.held.size).toBe(3);
    } finally {
      await wikiIndex.close();
    }
  });

  it("never reads a Wiki for a Human without an Another Me", async () => {
    const index = memoryIndex();
    const wiki = publishedWiki(3);
    const wikiIndex = new WikiIndex(
      index.chunks,
      await dataRoot(),
      wiki.access,
      index.sql,
      async () => [],
    );
    try {
      await wikiIndex.indexWiki("tenant_a", "owner_a");
      expect(wiki.access.fetch).not.toHaveBeenCalled();
    } finally {
      await wikiIndex.close();
    }
  });
});

describe("Daily and Weekly reports in the one index", () => {
  it("indexes report files as period_summary sources and retires removed ones", async () => {
    const root = await dataRoot();
    const daily = path.join(agentMemoryRoot(root, "agent_a"), "timeline/daily");
    await fs.mkdir(daily, { recursive: true });
    await fs.writeFile(path.join(daily, "2026-09-01.md"), "# Day\n\nA.\n");
    await fs.writeFile(path.join(daily, "2026-09-02.md"), "# Next\n\nB.\n");
    await fs.writeFile(path.join(daily, "notes.txt"), "not a report");
    const index = memoryIndex();
    const wikiIndex = new WikiIndex(
      index.chunks,
      root,
      publishedWiki().access,
      index.sql,
      async () => [subject("agent_a")],
    );
    try {
      await wikiIndex.indexReports("agent_a", "daily");
      expect(
        [...index.held.values()].map(({ source }) => ({
          origin: source.originKind,
          kind: source.sourceKind,
          date: source.date,
          collection: source.metadata?.collection,
        })),
      ).toEqual([
        {
          origin: "period_summary",
          kind: "period_report",
          date: "2026-09-01",
          collection: "daily",
        },
        {
          origin: "period_summary",
          kind: "period_report",
          date: "2026-09-02",
          collection: "daily",
        },
      ]);
      await fs.rm(path.join(daily, "2026-09-02.md"));
      await wikiIndex.indexReports("agent_a", "daily");
      expect([...index.held.values()].map(({ source }) => source.date)).toEqual(
        ["2026-09-01"],
      );
      // Weekly reports have no directory yet: nothing is retired.
      await wikiIndex.indexReports("agent_a", "weekly");
      expect(index.chunks.retireDatabaseSources).toHaveBeenCalledTimes(2);
    } finally {
      await wikiIndex.close();
    }
  });

  it("skips report indexing for a subject whose history rebuild is pending", async () => {
    const root = await dataRoot();
    const daily = path.join(agentMemoryRoot(root, "agent_a"), "timeline/daily");
    await fs.mkdir(daily, { recursive: true });
    await fs.writeFile(path.join(daily, "2026-09-01.md"), "# Day\n\nA.\n");
    const index = memoryIndex();
    const wikiIndex = new WikiIndex(
      index.chunks,
      root,
      publishedWiki().access,
      index.sql,
      async () => [subject("agent_a")],
    );
    wikiIndex.indexHold = (agentId) => agentId === "agent_a";
    try {
      await wikiIndex.indexReports("agent_a", "daily");
      expect(index.chunks.indexDatabaseSource).not.toHaveBeenCalled();
      wikiIndex.indexHold = () => false;
      await wikiIndex.indexReports("agent_a", "daily");
      expect(index.chunks.indexDatabaseSource).toHaveBeenCalledOnce();
    } finally {
      await wikiIndex.close();
    }
  });
});
