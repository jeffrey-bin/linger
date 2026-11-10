// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createDocumentTestRuntime,
  seedRoomUpload,
} from "@/test/document-scenarios";
import {
  teamHubErrorResponse,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";
import { loadArtifactPreview } from "./artifact-preview-loader";

async function setup(filename = "cache.txt", mediaType = "text/plain") {
  const runtime = createDocumentTestRuntime();
  const { client } = runtime;
  const document = await seedRoomUpload(runtime, "cache-upload", {
    file: new File(["verified content"], filename, { type: mediaType }),
    representationFormat: "binary",
  });
  const download = vi.spyOn(client, "downloadDocumentVersion");
  // Serves the seeded Version and records each metadata read.
  const metadata = vi.fn(({ params }: TestRouteRequest): unknown =>
    runtime.seed.documentVersions.get(params.documentVersionId!),
  );
  runtime.server.on(
    "GET",
    "/v0/document-versions/{documentVersionId}",
    metadata,
  );
  const load = (signal = new AbortController().signal) =>
    loadArtifactPreview({
      client,
      documentId: document.id,
      versionId: document.current_version!.id,
      signal,
    });
  return { client, document, download, load, metadata, server: runtime.server };
}

describe("immutable preview content reuse", () => {
  it("reopens verified content while rechecking current access", async () => {
    const { load, download, metadata } = await setup();
    const first = await load();
    first.dispose();
    const second = await load();
    second.dispose();
    expect(second.textContent).toBe("verified content");
    expect(download).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent transfers without sharing preview URLs", async () => {
    const { load, download, server } = await setup("cache.md", "text/markdown");
    const [a, b] = await Promise.all([load(), load()]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(
      server.requestsTo(
        "POST",
        "/v0/document-versions/{documentVersionId}/preview-sessions",
      ),
    ).toHaveLength(2);
    expect(a.previewUrl).not.toBe(b.previewUrl);
    a.dispose();
    b.dispose();
  });

  it("keeps another reader's transfer alive when one reader closes", async () => {
    const { load, download, client, document } = await setup();
    const content = await client.downloadDocumentVersion(
      document.current_version!.id,
    );
    const pending = deferred<typeof content>();
    download.mockClear().mockReturnValue(pending.promise);
    const controller = new AbortController();
    const first = load(controller.signal);
    const rejected = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    const second = load();
    await vi.waitFor(() => expect(download).toHaveBeenCalled());
    controller.abort();
    pending.resolve(content);
    await rejected;
    expect((await second).textContent).toBe("verified content");
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("never looks up the Session to key retained content", async () => {
    const { load, download, server } = await setup();
    (await load()).dispose();
    (await load()).dispose();
    expect(server.requestsTo("GET", "/v0/session")).toHaveLength(0);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404])(
    "discards retained bytes after HTTP %s",
    async (status) => {
      const { load, download, metadata } = await setup();
      (await load()).dispose();
      metadata.mockReturnValueOnce(
        teamHubErrorResponse(status, "DENIED", "Access denied"),
      );
      await expect(load()).rejects.toThrow("Access denied");
      (await load()).dispose();
      expect(download).toHaveBeenCalledTimes(2);
    },
  );

  it("never serves a cached Version for a different Document or changed digest", async () => {
    const { client, document, load, metadata, download } = await setup();
    (await load()).dispose();
    await expect(
      loadArtifactPreview({
        client,
        documentId: "other-document",
        versionId: document.current_version!.id,
        signal: signal(),
      }),
    ).rejects.toThrow(/does not belong/);
    const version = await readDocumentVersion(
      client,
      document.current_version!.id,
    );
    metadata.mockReturnValue({ ...version, sha256: "a".repeat(64) });
    await expect(load()).rejects.toThrow(/SHA-256/);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("does not retain a failed integrity check", async () => {
    const { load, download } = await setup();
    download.mockResolvedValueOnce({
      blob: new Blob(["wrong"]),
      mediaType: "text/plain",
    });
    await expect(load()).rejects.toThrow(/immutable Version/);
    expect((await load()).textContent).toBe("verified content");
    expect(download).toHaveBeenCalledTimes(2);
  });
});

import {
  ArtifactPreviewCache,
  artifactPreviewCache,
} from "./artifact-preview-cache";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

function bytes(size: number, textContent?: string) {
  return {
    blob: new Blob([new Uint8Array(size)]),
    mediaType: "application/pdf",
    textContent,
    readingPosition: {},
  };
}
const signal = () => new AbortController().signal;

describe("preview cache retention and recovery", () => {
  it("evicts the least recently used entry under a total byte/string budget", async () => {
    const cache = new ArtifactPreviewCache(12, 3);
    const load = vi.fn(async () => bytes(4));
    await cache.get("a", signal(), load);
    await cache.get("b", signal(), load);
    await cache.get("a", signal(), load);
    await cache.get("c", signal(), async () => bytes(4, "xx"));
    await cache.get("a", signal(), load);
    expect(load).toHaveBeenCalledTimes(2);
    await cache.get("b", signal(), load);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it("bounds tiny entries and does not retain oversized content", async () => {
    const cache = new ArtifactPreviewCache(10, 2);
    const load = vi.fn(async () => bytes(1));
    for (const key of ["a", "b", "c", "a"])
      await cache.get(key, signal(), load);
    expect(load).toHaveBeenCalledTimes(4);
    const large = vi.fn(async () => bytes(11));
    await cache.get("big", signal(), large);
    await cache.get("big", signal(), large);
    expect(large).toHaveBeenCalledTimes(2);
  });
  it.each(["cancel", "clear"])(
    "does not refill from late responses after %s",
    async (mode) => {
      const cache = new ArtifactPreviewCache();
      const pending = deferred<ReturnType<typeof bytes>>();
      const controller = new AbortController();
      const load = vi.fn(() => pending.promise);
      const first = cache.get("a", controller.signal, load);
      const rejected = expect(first).rejects.toMatchObject({
        name: "AbortError",
      });
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      if (mode === "cancel") controller.abort();
      else cache.clear();
      await rejected;
      pending.resolve(bytes(4));
      await Promise.resolve();
      const reload = vi.fn(async () => bytes(4));
      await cache.get("a", signal(), reload);
      expect(reload).toHaveBeenCalledOnce();
    },
  );
  it("clears bytes and prevents late authorization from crossing logout", async () => {
    const { client, document, load, metadata } = await setup();
    const version = await readDocumentVersion(
      client,
      document.current_version!.id,
    );
    const pending = deferred<typeof version>();
    metadata.mockReturnValue(pending.promise);
    const first = load();
    const rejected = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(metadata).toHaveBeenCalledTimes(2));
    artifactPreviewCache.clear();
    pending.resolve(version);
    await rejected;
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function readDocumentVersion(client: TeamHubClient, documentVersionId: string) {
  return teamHubData(
    client.api.GET("/v0/document-versions/{documentVersionId}", {
      params: { path: { documentVersionId } },
    }),
  );
}
