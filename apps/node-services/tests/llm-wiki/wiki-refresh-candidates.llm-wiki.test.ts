import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  LlmWikiGenerateRequest,
  LlmWikiGenerateResult,
} from "../../src/llm-wiki/backend.js";
import { ActorAssetError } from "../../src/llm-wiki/actor-wiki/actor-asset-client.js";
import { renderWikiPage } from "../../src/llm-wiki/wiki-page-template.js";
import { WikiRefreshCandidateService } from "../../src/llm-wiki/wiki-refresh-candidates.js";
import { WikiCandidateValidationError } from "../../src/llm-wiki/wiki-candidate-validation.js";
import { closeWikiServers, startWikiServer } from "./wiki-server-host.js";

const serviceToken = "wiki-candidate-service-token-for-test";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await closeWikiServers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Wiki refresh candidate HTTP API", () => {
  it("stages a Session from the index with its routing and message citations", async () => {
    const backendRequests: LlmWikiGenerateRequest[] = [];
    const inputs: string[] = [];
    const { httpUrl } = await startServer({
      backend: {
        id: "test-openwiki",
        async generate(request) {
          backendRequests.push(request);
          for (const input of request.changes.added)
            inputs.push(
              await readFile(
                join(request.inputsDirectory, input.contentPath),
                "utf8",
              ),
            );
          await mkdir(join(request.outputDirectory, "topics"), {
            recursive: true,
          });
          await writeFile(
            join(request.outputDirectory, "index.md"),
            "# Index\n",
          );
          await writeFile(
            join(request.outputDirectory, "topics", "launch.md"),
            "# Launch\n",
          );
          return { pageCount: 2, unsettled: [], deferred: [] };
        },
      },
    });
    const raw =
      '## 2026-11-04T09:00:00Z · Ada\n\nMessage metadata: {"message_id":"message_a","author_actor_id":"actor_ada","author_kind":"human"}\n\nShip it.\n';
    const room = {
      ...frozenSource({
        bytes: raw,
        documentId: "mis_000000000000000000000001",
        filename: "2026-11-04 Launch.md",
        versionId: createHash("sha256").update(raw).digest("hex"),
      }),
      session: {
        date: "2026-11-04",
        kind: "room",
        represented_human_actor_id: "actor_ada",
        represented_human_display_name: "Ada",
        room_id: "room_launch",
        session_id: "room_launch",
      },
    };
    const recording = {
      ...frozenSource({
        bytes: "Speaker 1: the budget is fixed.\n",
        documentId: "mis_000000000000000000000002",
        filename: "2026-11-04 Recording capture_one.md",
        versionId: "a".repeat(64),
      }),
      session: {
        date: "2026-11-04",
        kind: "recording",
        represented_human_actor_id: "actor_ada",
        represented_human_display_name: "Ada",
        room_id: "room_launch",
        session_id: "capture_one",
        transcript_document_id: "document_transcript",
        transcript_document_version_id: "version_transcript",
      },
    };
    recording.document_version_id = recording.sha256;
    const request = {
      ...candidateRequest(0),
      changes: { added: [room, recording], modified: [], removed: [] },
    };

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(request),
    );

    expect(response.status).toBe(200);
    expect(backendRequests[0]?.changes.added).toMatchObject([
      {
        title: "2026-11-04 Launch.md",
        session: {
          targetPath: "sessions/2026-11-04/room_launch.md",
          date: "2026-11-04",
          citations: ["teamhub://rooms/room_launch/messages/message_a"],
        },
      },
      {
        session: {
          targetPath: "sessions/2026-11-04/capture_one.md",
          citations: [
            "teamhub://documents/document_transcript/versions/version_transcript",
          ],
        },
      },
    ]);
    expect(inputs[0]).toContain(
      "target_path: sessions/2026-11-04/room_launch.md",
    );
    expect(inputs[0]).toContain("represented_human_display_name: Ada");
    expect(inputs[0]).toMatch(/Ship it\./u);
    expect(inputs[0]).toMatch(/Citation: \[\[source:raw:S[0-9a-f]{16}\]\]/u);
    expect(inputs[1]).toContain("source_kind: meeting");

    const invalid = {
      ...candidateRequest(0),
      changes: {
        added: [
          { ...recording, session: { ...recording.session, kind: "room" } },
        ],
        modified: [],
        removed: [],
      },
    };
    const rejected = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-b/candidates`,
      requestInit(invalid),
    );
    expect(rejected.status).toBe(400);
  });

  it("generates a complete candidate set from the frozen source Markdown", async () => {
    const backendRequests: LlmWikiGenerateRequest[] = [];
    const { httpUrl, stateDirectory } = await startServer({
      backend: {
        id: "test-openwiki",
        async generate(request) {
          backendRequests.push(request);
          await expect(
            readFile(
              join(
                request.inputsDirectory,
                "document-a_version-a",
                "document.md",
              ),
              "utf8",
            ),
          ).resolves.toBe("# Source A\n");
          await expect(
            readFile(
              join(
                request.inputsDirectory,
                "document-b_version-b",
                "document.md",
              ),
              "utf8",
            ),
          ).resolves.toBe("# Source B\n");
          await expect(
            readFile(
              join(
                request.inputsDirectory,
                "document-c_version-c",
                "document.md",
              ),
              "utf8",
            ),
          ).resolves.toBe("# Source C\n");
          await mkdir(join(request.outputDirectory, "topics"), {
            recursive: true,
          });
          await writeFile(
            join(request.outputDirectory, "index.md"),
            "# Index\n",
          );
          await writeFile(
            join(request.outputDirectory, "topics", "teamhub.md"),
            "# TeamHub\n",
          );
          await writeFile(
            join(request.outputDirectory, "topics", "a_b.md"),
            "# Underscore\n",
          );
          await writeFile(
            join(request.outputDirectory, "topics", "a-b.md"),
            "# Hyphen\n",
          );
          // A skipped task left Source B unwritten.
          return {
            pageCount: 4,
            unsettled: ["document-b_version-b"],
            deferred: ["document-c_version-c"],
          };
        },
      },
    });

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(candidateRequest()),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      wiki_refresh_id: "refresh-a",
      pages: [
        candidatePage("index.md", "# Index\n"),
        candidatePage("topics/a-b.md", "# Hyphen\n"),
        candidatePage("topics/a_b.md", "# Underscore\n"),
        candidatePage("topics/teamhub.md", "# TeamHub\n"),
      ],
      unsettled_sources: [
        {
          document_id: "document-b",
          document_version_id: "version-b",
          filename: "b.docx",
        },
      ],
      deferred_sources: [
        {
          document_id: "document-c",
          document_version_id: "version-c",
          filename: "c.txt",
        },
      ],
    });
    expect(backendRequests[0]?.generationId).toBe("refresh-a");
    expect(backendRequests).toHaveLength(1);
    expect(backendRequests[0]).toMatchObject({
      changes: {
        added: [
          {
            assetKey: "document-a_version-a",
            contentPath: "document-a_version-a/document.md",
            sourceUrl: "document://document-a/versions/version-a",
            title: "a.pdf",
          },
          {
            assetKey: "document-b_version-b",
            contentPath: "document-b_version-b/document.md",
            sourceUrl: "document://document-b/versions/version-b",
            title: "b.docx",
          },
          {
            assetKey: "document-c_version-c",
            contentPath: "document-c_version-c/document.md",
            sourceUrl: "document://document-c/versions/version-c",
            title: "c.txt",
          },
        ],
        modified: [],
        removed: [],
      },
      mode: "initialize",
    });
    await expect(readdir(join(stateDirectory, "operations"))).resolves.toEqual(
      [],
    );
  });

  it("rejects malformed authority, empty, duplicate, and corrupt sources before generation", async () => {
    let backendCalls = 0;
    const { httpUrl } = await startServer({
      backend: {
        id: "test-openwiki",
        async generate() {
          backendCalls += 1;
          return { pageCount: 0, unsettled: [], deferred: [] };
        },
      },
    });
    const valid = candidateRequest();
    const invalidBodies: unknown[] = [
      { ...valid, changes: { ...valid.changes, added: [] } },
      { ...valid, unexpected: true },
      { ...valid, wiki_refresh_id: "another-refresh" },
      {
        ...valid,
        changes: {
          ...valid.changes,
          added: [valid.changes.added[0], { ...valid.changes.added[0] }],
        },
      },
      {
        ...valid,
        changes: {
          ...valid.changes,
          added: [
            valid.changes.added[0],
            { ...valid.changes.added[1], document_version_id: "version-a" },
          ],
        },
      },
      {
        ...valid,
        changes: {
          ...valid.changes,
          added: [{ ...valid.changes.added[0], size_bytes: 999 }],
        },
      },
      {
        ...valid,
        changes: {
          ...valid.changes,
          added: [{ ...valid.changes.added[0], sha256: "0".repeat(64) }],
        },
      },
      {
        ...valid,
        changes: {
          ...valid.changes,
          added: [
            { ...valid.changes.added[0], content: "not canonical base64" },
          ],
        },
      },
      {
        ...valid,
        changes: {
          ...valid.changes,
          added: [
            { ...valid.changes.added[0], filename: "invalid\u0000name.md" },
          ],
        },
      },
    ];

    for (const body of invalidBodies) {
      const response = await fetch(
        `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
        requestInit(body),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "WIKI_REFRESH_CANDIDATE_REQUEST_INVALID" },
      });
    }
    const unauthorized = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      { method: "POST" },
    );
    expect(unauthorized.status).toBe(401);
    expect(backendCalls).toBe(0);
  });

  it("publishes a single entity change log entry after a rejected run is retried in halves", async () => {
    const key = "topics/alpha.md";
    let batches = 0;
    const { httpUrl } = await startServer({
      backend: {
        id: "test-refresh-log",
        async generate(request) {
          if (request.changes.added.length === 33)
            throw new WikiCandidateValidationError([
              { code: "missing_target_page", page: key, detail: "rejected" },
            ]);
          const previous = await readFile(
            join(request.existingOutputDirectory, key),
            "utf8",
          ).catch(() => undefined);
          batches += 1;
          const markdown = renderWikiPage(
            key,
            {
              title: "Alpha",
              description: "Topic summary",
              fields: { topic_name: "Alpha", aliases: [] },
              sections: {
                Overview: previous
                  ? {
                      text: "Revised overview. [[source:raw:S1]]",
                      reason: "Confirmed by a later source.",
                    }
                  : {
                      text: "Original overview. [[source:raw:S1]]",
                      reason: "First source.",
                    },
                "Current Understanding": previous
                  ? { keep: true }
                  : {
                      text: "Initial understanding. [[source:raw:S1]]",
                      reason: "First source.",
                    },
                Related: [],
              },
              source_refs: ["raw:S1"],
              relations: {},
            },
            new Map([
              ["raw:S1", "teamhub://rooms/room_one/messages/message_1"],
            ]),
            previous,
            new Date("2026-10-17T12:00:00Z"),
          );
          await mkdir(join(request.outputDirectory, "topics"), {
            recursive: true,
          });
          await writeFile(
            join(request.outputDirectory, "index.md"),
            "# Index\n",
          );
          await writeFile(join(request.outputDirectory, key), markdown);
          return { pageCount: 2, unsettled: [], deferred: [] };
        },
      },
    });
    const body = candidateRequest(0);
    body.changes.added = Array.from({ length: 33 }, (_, i) =>
      frozenSource({
        bytes: "Public test source",
        documentId: `document-${i}`,
        versionId: `version-${i}`,
        filename: `source-${i}.md`,
      }),
    );
    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(body),
    );
    expect(response.status).toBe(200);
    expect(batches).toBe(2);
    const result = (await response.json()) as {
      pages: ReturnType<typeof candidatePage>[];
    };
    const entity = result.pages.find((p) => p.page_key === key)!;
    const markdown = Buffer.from(entity.markdown_content, "base64").toString(
      "utf8",
    );
    expect(markdown).toContain("Revised overview.");
    expect(markdown.split("## Change Log\n\n")[1]).toBe(
      "- 2026-10-17 Created.\n",
    );
    expect(entity.markdown_sha256).toBe(
      createHash("sha256").update(markdown).digest("hex"),
    );
  });

  it("updates a materialized published wiki with only the source delta", async () => {
    const backendRequests: LlmWikiGenerateRequest[] = [];
    const { httpUrl } = await startServer({
      backend: {
        id: "test-openwiki",
        async generate(request) {
          backendRequests.push(request);
          await expect(
            readFile(join(request.existingOutputDirectory, "index.md"), "utf8"),
          ).resolves.toBe("# Existing index\n");
          await expect(
            readFile(
              join(
                request.inputsDirectory,
                "document-c_version-c",
                "document.md",
              ),
              "utf8",
            ),
          ).resolves.toBe("# Source C\n");
          await mkdir(request.outputDirectory, { recursive: true });
          await writeFile(
            join(request.outputDirectory, "index.md"),
            "# Updated index\n",
          );
          await writeFile(
            join(request.outputDirectory, "topic.md"),
            "# Topic\n",
          );
          return { pageCount: 2, unsettled: [], deferred: [] };
        },
      },
    });
    const request = candidateRequest(3);
    request.mode = "update";
    request.base_pages = [candidatePage("index.md", "# Existing index\n")];
    request.changes.added = [request.changes.added[2]!];

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(request),
    );

    expect(response.status).toBe(200);
    expect(backendRequests).toHaveLength(1);
    expect(backendRequests[0]).toMatchObject({
      changes: {
        added: [expect.objectContaining({ assetKey: "document-c_version-c" })],
        modified: [],
        removed: [],
      },
      mode: "update",
    });
  });

  it("accepts an update with up to 10,000 base pages", async () => {
    let existingTopics = 0;
    const { httpUrl } = await startServer({
      backend: {
        id: "test-openwiki",
        async generate(request) {
          existingTopics = (
            await readdir(join(request.existingOutputDirectory, "topics"))
          ).length;
          await mkdir(request.outputDirectory, { recursive: true });
          await writeFile(
            join(request.outputDirectory, "index.md"),
            "# Updated index\n",
          );
          await writeFile(
            join(request.outputDirectory, "topic.md"),
            "# Topic\n",
          );
          return { pageCount: 2, unsettled: [], deferred: [] };
        },
      },
    });
    const request = candidateRequest(3);
    request.mode = "update";
    request.changes.added = [request.changes.added[2]!];
    request.base_pages = [
      candidatePage("index.md", "# Existing index\n"),
      ...Array.from({ length: 1000 }, (_, index) =>
        candidatePage(`topics/page-${index}.md`, `# Page ${index}\n`),
      ),
    ];
    const url = `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`;

    const accepted = await fetch(url, requestInit(request));
    expect(accepted.status).toBe(200);
    expect(existingTopics).toBe(1000);

    request.base_pages = Array.from({ length: 10_001 }, (_, index) =>
      candidatePage(`page-${index}.md`, "# Page\n"),
    );
    const rejected = await fetch(url, requestInit(request));
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "WIKI_REFRESH_CANDIDATE_REQUEST_INVALID" },
    });
  });

  it("fails closed and removes operation bytes when generation fails", async () => {
    const { httpUrl, stateDirectory } = await startServer({
      backend: {
        id: "test-openwiki",
        async generate() {
          throw new Error("provider unavailable /private/source");
        },
      },
    });
    const url = `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`;

    for (const expectedCode of ["WIKI_REFRESH_GENERATION_UNAVAILABLE"]) {
      const response = await fetch(url, requestInit(candidateRequest(1)));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: expectedCode,
          disposition: "retryable",
          message:
            "Wiki refresh candidate generation is temporarily unavailable",
        },
      });
      await expect(
        readdir(join(stateDirectory, "operations")),
      ).resolves.toEqual([]);
    }
  });

  it("treats an invalid generated candidate as terminal", async () => {
    const { httpUrl, stateDirectory } = await startServer({
      backend: {
        id: "test-openwiki",
        async generate() {
          throw new WikiCandidateValidationError([
            {
              code: "placeholder_content",
              detail: "replace placeholder content",
              page: "index.md",
            },
          ]);
        },
      },
    });

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(candidateRequest(1)),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "WIKI_REFRESH_GENERATION_INVALID",
        disposition: "terminal",
        message: "Wiki refresh candidate output is invalid",
      },
    });
    await expect(readdir(join(stateDirectory, "operations"))).resolves.toEqual(
      [],
    );
  });

  it("maps retryable OpenWiki invocation failures to unavailable generation", async () => {
    const { httpUrl } = await startServer({
      backend: {
        id: "test-openwiki",
        async generate() {
          throw new ActorAssetError(
            "WIKI_OPERATION_RETRYABLE",
            "OpenWiki provider is temporarily unavailable: openwiki exited",
            "retryable",
          );
        },
      },
    });

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(candidateRequest(1)),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "WIKI_REFRESH_GENERATION_UNAVAILABLE",
        disposition: "retryable",
        message: "Wiki refresh candidate generation is temporarily unavailable",
      },
    });
  });

  it("reports an offline Computer with its own retryable code", async () => {
    const { httpUrl } = await startServer({
      backend: {
        id: "test-openwiki",
        async generate() {
          throw new ActorAssetError(
            "WIKI_COMPUTER_OFFLINE",
            "The Wiki owner's Computer is offline",
          );
        },
      },
    });

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(candidateRequest(1)),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "WIKI_COMPUTER_OFFLINE",
        disposition: "retryable",
        message: "The Wiki owner's Computer is offline",
      },
    });
  });

  it("does not retry a terminal OpenWiki invocation failure", async () => {
    const { httpUrl } = await startServer({
      backend: {
        id: "test-openwiki",
        async generate() {
          throw new ActorAssetError(
            "WIKI_OPERATION_FAILED",
            "invalid model configuration",
            "terminal",
          );
        },
      },
    });

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(candidateRequest(1)),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "WIKI_REFRESH_GENERATION_INVALID",
        disposition: "terminal",
        message: "Wiki refresh candidate generation cannot be completed",
      },
    });
  });

  it("rejects legacy generation descriptors before reading source bytes", async () => {
    let backendCalls = 0;
    const { httpUrl } = await startServer({
      backend: {
        id: "test-openwiki",
        async generate() {
          backendCalls += 1;
          return { pageCount: 0, unsettled: [], deferred: [] };
        },
      },
    });

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit({
        ...candidateRequest(1),
        generation_id: "legacy-generation",
        projection_revision: 7,
      }),
    );

    expect(response.status).toBe(400);
    expect(backendCalls).toBe(0);
  });

  it("rejects invalid UTF-8 in frozen source Markdown", async () => {
    const { httpUrl } = await startServer({
      backend: unusedBackend(),
    });
    const request = candidateRequest(1);
    request.changes.added = [
      frozenSourceBytes({
        bytes: Buffer.from([0xff]),
        documentId: "document-invalid-utf8",
        filename: "invalid.md",
        versionId: "version-invalid-utf8",
      }),
    ];

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(request),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "WIKI_REFRESH_CANDIDATE_REQUEST_INVALID" },
    });
  });

  it("accepts a multi-MiB frozen source", async () => {
    const { httpUrl } = await startServer({
      backend: outputBackend([
        { path: "index.md", content: "# Index\n" },
        { path: "topics/topic.md", content: "# Topic\n" },
      ]),
    });
    const request = candidateRequest(1);
    request.changes.added = [
      frozenSourceBytes({
        bytes: Buffer.alloc(4 << 20, 0x61),
        documentId: "document-large",
        filename: "large.pdf",
        versionId: "version-large",
      }),
    ];

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(request),
    );

    expect(response.status).toBe(200);
  });

  it("stops a running generation and removes its operation", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "llm-wiki-candidates-"),
    );
    temporaryDirectories.push(stateDirectory);
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new WikiRefreshCandidateService({
      dataDirectory: stateDirectory,
      runtime: {
        id: "test-openwiki",
        generationKey: "test",
        async generate(request) {
          started();
          return await new Promise((_resolve, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => reject(new Error("stopped")),
              { once: true },
            );
          });
        },
      },
    });
    await service.start();
    const generation = service.generate("refresh-a", candidateRequest(1));
    await running;

    await service.stop();
    // TeamHub runs a generation a restart stopped again without spending
    // an attempt.
    await expect(generation).rejects.toMatchObject({
      code: "WIKI_SERVICE_STOPPING",
      disposition: "retryable",
    });
    await expect(readdir(join(stateDirectory, "operations"))).resolves.toEqual(
      [],
    );
  });

  it("rejects a symlink in generated candidate output", async () => {
    const { httpUrl, stateDirectory } = await startServer({
      backend: {
        id: "test-openwiki",
        async generate(request) {
          await mkdir(request.outputDirectory, { recursive: true });
          await writeFile(
            join(request.outputDirectory, "topic.md"),
            "# Topic\n",
          );
          await symlink("topic.md", join(request.outputDirectory, "index.md"));
          return { pageCount: 2, unsettled: [], deferred: [] };
        },
      },
    });

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(candidateRequest(1)),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "WIKI_REFRESH_GENERATION_INVALID" },
    });
    await expect(readdir(join(stateDirectory, "operations"))).resolves.toEqual(
      [],
    );
  });

  it("does not publish category-local instructions or plans", async () => {
    const { httpUrl } = await startServer({
      backend: outputBackend([
        { path: "index.md", content: "# Index\n" },
        { path: "topics/topic.md", content: "# Topic\n" },
        { path: "topics/INSTRUCTIONS.md", content: "Internal guidance\n" },
        { path: "topics/_plan.md", content: "Internal plan\n" },
      ]),
    });
    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(candidateRequest(1)),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      wiki_refresh_id: "refresh-a",
      pages: [
        candidatePage("index.md", "# Index\n"),
        candidatePage("topics/topic.md", "# Topic\n"),
      ],
      unsettled_sources: [],
      deferred_sources: [],
    });
  });

  it("rejects generated candidate output without index.md", async () => {
    const { httpUrl } = await startServer({
      backend: outputBackend([{ path: "topic.md", content: "# Topic\n" }]),
    });

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      requestInit(candidateRequest(1)),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "WIKI_REFRESH_GENERATION_INVALID" },
    });
  });
});

async function startServer(input: {
  backend: {
    id: string;
    generate(request: LlmWikiGenerateRequest): Promise<LlmWikiGenerateResult>;
  };
}): Promise<{ httpUrl: string; stateDirectory: string }> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "llm-wiki-candidates-"));
  temporaryDirectories.push(stateDirectory);
  const candidateService = new WikiRefreshCandidateService({
    dataDirectory: stateDirectory,
    runtime: { generationKey: "test", ...input.backend },
  });
  return {
    httpUrl: await startWikiServer({ candidateService, serviceToken }),
    stateDirectory,
  };
}

function requestInit(body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${serviceToken}`,
      "content-type": "application/json",
    },
    method: "POST",
  };
}

function candidateRequest(sourceCount = 3) {
  const sources = [
    frozenSource({
      bytes: "# Source A\n",
      documentId: "document-a",
      filename: "a.pdf",
      versionId: "version-a",
    }),
    frozenSource({
      bytes: "# Source B\n",
      documentId: "document-b",
      filename: "b.docx",
      versionId: "version-b",
    }),
    frozenSource({
      bytes: "# Source C\n",
      documentId: "document-c",
      filename: "c.txt",
      versionId: "version-c",
    }),
  ];
  return {
    base_pages: [] as ReturnType<typeof candidatePage>[],
    changes: {
      added: sources.slice(0, sourceCount),
      modified: [],
      removed: [],
    },
    generator_agent_actor_id: "agent-a",
    mode: "initialize",
    tenant_id: "tenant-a",
    wiki_refresh_id: "refresh-a",
  };
}

function frozenSource(input: {
  bytes: string;
  documentId: string;
  filename: string;
  versionId: string;
}) {
  return frozenSourceBytes({ ...input, bytes: Buffer.from(input.bytes) });
}

function frozenSourceBytes(input: {
  bytes: Uint8Array;
  documentId: string;
  filename: string;
  versionId: string;
}) {
  const content = Buffer.from(input.bytes);
  return {
    content: content.toString("base64"),
    document_id: input.documentId,
    document_version_id: input.versionId,
    filename: input.filename,
    sha256: createHash("sha256").update(content).digest("hex"),
    size_bytes: content.byteLength,
  };
}

function unusedBackend() {
  return {
    id: "test-openwiki",
    async generate(): Promise<LlmWikiGenerateResult> {
      throw new Error("backend must not be called");
    },
  };
}

function outputBackend(files: Array<{ content: string; path: string }>) {
  return {
    id: "test-openwiki",
    async generate(request: LlmWikiGenerateRequest) {
      await mkdir(request.outputDirectory, { recursive: true });
      for (const file of files) {
        await mkdir(dirname(join(request.outputDirectory, file.path)), {
          recursive: true,
        });
        await writeFile(join(request.outputDirectory, file.path), file.content);
      }
      return { pageCount: files.length, unsettled: [], deferred: [] };
    },
  };
}

function candidatePage(pageKey: string, markdown: string) {
  const content = Buffer.from(markdown);
  return {
    markdown_content: content.toString("base64"),
    markdown_sha256: createHash("sha256").update(content).digest("hex"),
    page_key: pageKey,
  };
}
