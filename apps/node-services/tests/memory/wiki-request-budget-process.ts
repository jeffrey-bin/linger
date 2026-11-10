import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeMemoryDatabase,
  memoryDatabase,
} from "../../src/memory/database.js";
import { MemoryChunkIndex } from "../../src/memory/chunk-index.js";
import { readIndexedWiki, WikiIndex } from "../../src/memory/wiki-index.js";
import { startMemoryServer } from "../../src/memory/server.js";
import {
  teamHubWikiAccess,
  waitForCurrentPublishedWiki,
} from "../../src/memory/teamhub-wiki.js";
import { buildWikiGraph } from "../../src/memory/graph/build.js";
import type { MemoryScheduler } from "../../src/memory/scheduler.js";

const dataRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "wiki-budget-process-"),
);
const access = teamHubWikiAccess();
const sql = memoryDatabase();
const chunks = new MemoryChunkIndex({ dataRoot, sql });
const sync = new WikiIndex(chunks, dataRoot, access, sql);
const memory = await startMemoryServer({
  host: "127.0.0.1",
  port: 0,
  dataRoot,
  serviceToken: "budget-callback-fixture",
  scheduler: {} as MemoryScheduler,
  onWikiPublished: async (publication) => {
    await sync.indexWiki(publication.tenant_id, publication.owner_actor_id);
  },
});
const control = async (route: string, body?: unknown) => {
  const response = await fetch(`${access.baseUrl}/test/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  assert.equal(response.status, 204, await response.text());
};
const counts = async () => {
  const response = await fetch(`${access.baseUrl}/test/counts`);
  return (await response.json()) as {
    counts: Record<string, number>;
    bad_ua: number;
  };
};
try {
  await control("publish", { memory_url: memory.url, revision: 0 });
  const cold = await counts();
  assert.equal(cold.counts.body_200, 123);
  const baselineHashes = new Map(
    (
      await sql`SELECT id, active_sha256 FROM memory_index.sources WHERE origin_kind = 'wiki'`
    ).map((page) => [page.id as string, page.active_sha256 as string]),
  );
  assert.equal(baselineHashes.size, 123);
  await control("stale");
  let now = 0;
  let published = false;
  const pollCounts = { "200": 0, "304": 0 };
  const pollingAccess = {
    ...access,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      assert.match(
        new Headers(init?.headers).get("user-agent") ?? "",
        /^linger-memory\/budget-test$/u,
      );
      if (response.status === 200 || response.status === 304)
        pollCounts[String(response.status) as "200" | "304"]++;
      return response;
    },
  };
  await waitForCurrentPublishedWiki(pollingAccess, "actor_human_a", {
    now: () => now,
    random: () => 1,
    sleep: async (ms) => {
      const next = now + ms;
      if (!published && next >= 80_000) {
        now = 80_000;
        published = true;
        await control("publish", { memory_url: memory.url, revision: 1 });
      }
      now = next;
    },
  });
  const warm = await counts();
  assert.equal(warm.counts.body_200, 2);
  assert.deepEqual(pollCounts, { "200": 2, "304": 7 });
  const total = Object.values(warm.counts).reduce((a, b) => a + b, 0);
  assert.ok(total <= 15, `Wiki GET total ${total}`);
  assert.equal(warm.bad_ua, 0);
  const pages =
    await sql`SELECT * FROM memory_index.sources WHERE origin_kind = 'wiki'`;
  assert.equal(pages.length, 123);
  // Each page keeps only its current version. Compare live hashes to prove
  // that exactly two pages changed.
  assert.ok(pages.every((page) => baselineHashes.has(page.id as string)));
  const updated = pages.filter(
    (page) => baselineHashes.get(page.id as string) !== page.active_sha256,
  ).length;
  assert.equal(updated, 2);
  // Source lookup uses the actual TeamHub scope (not a test-supplied subject).
  const { loadAnotherMeSubjects } =
    await import("../../src/memory/collector.js");
  const subjects = await loadAnotherMeSubjects();
  const agent = subjects.find(
    (s) => s.representedHumanActorId === "actor_human_a",
  )!;
  const indexed = await readIndexedWiki(
    agent.tenantId,
    "actor_human_a",
    undefined,
    sql,
  );
  const { graph } = buildWikiGraph(indexed.pages, indexed.revision!);
  assert.equal(graph.nodes.length, 123);
  // The Wiki is not copied into the data root.
  await assert.rejects(
    fs.stat(path.join(dataRoot, agent.agentManagementId, "llm-wiki")),
    { code: "ENOENT" },
  );
  // A same-revision retry reads page bodies from the index, including after
  // a worker restart.
  await sync.indexWiki(agent.tenantId, "actor_human_a");
  assert.equal((await counts()).counts.body_200, 2);
  process.stdout.write(
    JSON.stringify({
      cold_body_gets: cold.counts.body_200,
      body_gets: warm.counts.body_200,
      waiting_polls: pollCounts,
      wiki_gets: total,
      pages: pages.length,
      pg_updated: updated,
      bad_ua: warm.bad_ua,
    }) + "\n",
  );
} finally {
  await memory.close();
  await sync.close();
  await chunks.close();
  await closeMemoryDatabase();
  await fs.rm(dataRoot, { force: true, recursive: true });
}
