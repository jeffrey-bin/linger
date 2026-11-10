import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type {
  LlmWikiBackend,
  LlmWikiGenerateRequest,
} from "../../src/llm-wiki/backend.js";
import { ActorAssetError } from "../../src/llm-wiki/actor-wiki/actor-asset-client.js";
import { WikiCandidateValidationError } from "../../src/llm-wiki/wiki-candidate-validation.js";
import {
  generateWikiCandidate,
  WIKI_GENERATION_BUDGET_MS,
} from "../../src/llm-wiki/wiki-initialization.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture(count: number) {
  const root = await mkdtemp(join(tmpdir(), "wiki-init-batch-"));
  roots.push(root);
  const inputsDirectory = join(root, "inputs"),
    existingOutputDirectory = join(root, "base"),
    outputDirectory = join(root, "candidate", "openwiki");
  await mkdir(inputsDirectory);
  await mkdir(existingOutputDirectory);
  const added = [];
  for (let i = 0; i < count; i++) {
    const contentPath = `source-${i}.md`;
    const content =
      i === 0
        ? "# Uploaded product facts\nA product launch.\n"
        : `---\nsource_kind: ${i === 1 ? "meeting" : "room"}\nwiki_projection:\n  target_path: sessions/2026-09-29/session-${i}.md\n---\n# Raw conversation\nOriginal message ${i}: Voice quality is the priority.\n`;
    await writeFile(join(inputsDirectory, contentPath), content);
    added.push({
      assetKey: `source-${i}`,
      contentPath,
      contentSha256: "0".repeat(64),
      sourceUrl: `document://doc-${i}/versions/v-${i}`,
      title: contentPath,
    });
  }
  return {
    root,
    request: {
      mode: "initialize",
      generator: { tenantId: "tenant_1", agentActorId: "another_me_1" },
      generationId: "fixed-generation",
      inputsDirectory,
      existingOutputDirectory,
      outputDirectory,
      changes: { added, modified: [], removed: [] },
    } satisfies LlmWikiGenerateRequest,
  };
}
/** With `rejectBatches`, a multi-source run writes pages that fail validation. */
function renderer(
  calls: LlmWikiGenerateRequest[],
  rejectBatches = false,
): LlmWikiBackend {
  return {
    id: "test",
    generationKey: "test",
    async generate(request) {
      calls.push(request);
      await mkdir(request.outputDirectory, { recursive: true });
      await cp(request.existingOutputDirectory, request.outputDirectory, {
        recursive: true,
      });
      const rejected = rejectBatches && request.changes.added.length > 1;
      for (const source of request.changes.added) {
        const text = await readFile(
          join(request.inputsDirectory, source.contentPath),
          "utf8",
        );
        const target =
          /target_path:\s*(\S+)/u.exec(text)?.[1] ?? "projects/product.md";
        const file = join(request.outputDirectory, target);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(
          file,
          `# Extracted facts\n\n## Objective Summary\n\n${rejected ? "Rejected page." : text.split("---").at(-1)}\n`,
        );
      }
      if (rejected)
        throw new WikiCandidateValidationError([
          {
            code: "invalid_node_structure",
            page: "sessions/2026-09-29/session-1.md",
            detail: "rejected",
          },
        ]);
      return {
        pageCount: request.changes.added.length,
        unsettled: [],
        deferred: [],
      };
    },
  };
}
it("initializes an ordinary account in a single run", async () => {
  const { request } = await fixture(24);
  const calls: LlmWikiGenerateRequest[] = [];
  await generateWikiCandidate(renderer(calls), request);
  expect(calls.map((c) => [c.mode, c.changes.added.length])).toEqual([
    ["initialize", 24],
  ]);
});
it("gives a large update to one run; the backend sizes its own model tasks", async () => {
  const { request } = await fixture(80);
  const calls: LlmWikiGenerateRequest[] = [];
  await generateWikiCandidate(renderer(calls), { ...request, mode: "update" });
  expect(calls.map((c) => [c.mode, c.changes.added.length])).toEqual([
    ["update", 80],
  ]);
  expect(calls[0]!.outputDirectory).toBe(request.outputDirectory);
});
function rejecting(
  calls: LlmWikiGenerateRequest[],
  assetKey: string,
): LlmWikiBackend {
  const inner = renderer(calls);
  return {
    id: "one-invalid-source",
    generationKey: "test",
    async generate(r) {
      const result = await inner.generate(r);
      if (r.changes.added.some((s) => s.assetKey === assetKey))
        throw new WikiCandidateValidationError([
          { code: "missing_target_page", page: "x.md", detail: "bad" },
        ]);
      return result;
    },
  };
}
it("skips an update source that still fails on its own and publishes the rest", async () => {
  const { request } = await fixture(7);
  const calls: LlmWikiGenerateRequest[] = [];
  await generateWikiCandidate(rejecting(calls, "source-5"), {
    ...request,
    mode: "update",
  });
  expect(calls[0]!.changes.added).toHaveLength(7);
  const sessions = await readdir(
    join(request.outputDirectory, "sessions/2026-09-29"),
  );
  expect(sessions.sort()).toEqual([
    "session-1.md",
    "session-2.md",
    "session-3.md",
    "session-4.md",
    "session-6.md",
  ]);
});
it("bisects a rejected update from its halves instead of repeating it", async () => {
  const { request } = await fixture(4);
  const calls: LlmWikiGenerateRequest[] = [];
  await generateWikiCandidate(rejecting(calls, "source-3"), {
    ...request,
    mode: "update",
  });
  expect(calls.map((c) => c.changes.added.length)).toEqual([4, 2, 2, 1, 1]);
  const sessions = await readdir(
    join(request.outputDirectory, "sessions/2026-09-29"),
  );
  expect(sessions.sort()).toEqual(["session-1.md", "session-2.md"]);
});
it("republishes the base Wiki when the only updated source is rejected", async () => {
  const { request } = await fixture(2);
  request.changes.added.shift();
  await mkdir(join(request.existingOutputDirectory, "topics"));
  await writeFile(
    join(request.existingOutputDirectory, "topics/earlier.md"),
    "# Earlier\n",
  );
  const calls: LlmWikiGenerateRequest[] = [];
  await generateWikiCandidate(rejecting(calls, "source-1"), {
    ...request,
    mode: "update",
  });
  expect(calls).toHaveLength(1);
  expect(
    await readFile(join(request.outputDirectory, "topics/earlier.md"), "utf8"),
  ).toBe("# Earlier\n");
  await expect(
    stat(join(request.outputDirectory, "sessions")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("bisects a rejected run down to individual sources without accepting the rejected pages", async () => {
  const { request } = await fixture(9);
  const calls: LlmWikiGenerateRequest[] = [];
  await generateWikiCandidate(renderer(calls, true), request);
  expect(
    calls.filter((c) => c.changes.added.length === 1).length,
  ).toBeGreaterThanOrEqual(9);
  // The halves after the first accepted one build on it as an update.
  expect(calls.at(-1)!.mode).toBe("update");
  const body = await readFile(
    join(request.outputDirectory, "sessions/2026-09-29/session-1.md"),
    "utf8",
  );
  expect(body).toContain("Original message 1");
  expect(body).not.toContain("Rejected page.");
});
it("does not expose a partial candidate when a retry run fails", async () => {
  const { request } = await fixture(9);
  const calls: LlmWikiGenerateRequest[] = [];
  const inner = renderer(calls, true);
  const runtime: LlmWikiBackend = {
    id: "fail",
    generationKey: "test",
    async generate(r) {
      if (calls.length) throw Error("provider failure");
      return inner.generate(r);
    },
  };
  await expect(generateWikiCandidate(runtime, request)).rejects.toThrow(
    "provider failure",
  );
  await expect(stat(request.outputDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("bisects a rejected run and skips only a source that still fails", async () => {
  const { request } = await fixture(20);
  const calls: LlmWikiGenerateRequest[] = [];
  await generateWikiCandidate(rejecting(calls, "source-9"), request);
  expect(calls[0]!.changes.added).toHaveLength(20);
  const sessions = await readdir(
    join(request.outputDirectory, "sessions/2026-09-29"),
  );
  expect(sessions).toHaveLength(18);
  expect(sessions).not.toContain("session-9.md");
});
it("defers the sources past its retry run budget", async () => {
  const { request } = await fixture(160);
  const calls: LlmWikiGenerateRequest[] = [];
  const result = await generateWikiCandidate(renderer(calls, true), request);
  expect(calls).toHaveLength(1 + 32);
  // The accepted single-source runs publish; the sources never run stay
  // pending for a later refresh.
  const accepted = calls
    .slice(1)
    .filter((call) => call.changes.added.length === 1).length;
  // Not run is no failure of theirs: they spend none of their tries.
  expect(result.unsettled).toEqual([]);
  expect(result.deferred.length).toBeGreaterThan(0);
  expect(result.deferred.length).toBeLessThan(160 - accepted + 1);
  await expect(stat(request.outputDirectory)).resolves.toBeDefined();
});
it("stops bisecting at its deadline and fails an initialization with nothing accepted", async () => {
  const { request } = await fixture(4);
  const calls: LlmWikiGenerateRequest[] = [];
  const failure = await generateWikiCandidate(renderer(calls, true), {
    ...request,
    deadline: Date.now() - 1,
  }).catch((error: unknown) => error);
  // The first run still goes (the backend honours the deadline itself);
  // no bisection run starts after it.
  expect(calls).toHaveLength(1);
  expect(failure).toBeInstanceOf(ActorAssetError);
  expect(failure).toMatchObject({ disposition: "retryable" });
});
it("gives every run the refresh deadline", async () => {
  const { request } = await fixture(2);
  const calls: LlmWikiGenerateRequest[] = [];
  const before = Date.now();
  await generateWikiCandidate(renderer(calls), request);
  expect(calls[0]!.deadline).toBeGreaterThanOrEqual(
    before + WIKI_GENERATION_BUDGET_MS,
  );
});
it("stops retrying once the caller aborts", async () => {
  const { request } = await fixture(17);
  const controller = new AbortController();
  const calls: LlmWikiGenerateRequest[] = [];
  const base = renderer(calls, true);
  const runtime: LlmWikiBackend = {
    id: "test",
    generationKey: "test",
    async generate(batch) {
      controller.abort();
      return base.generate(batch);
    },
  };
  await expect(
    generateWikiCandidate(runtime, { ...request, signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.signal).toBe(controller.signal);
});
