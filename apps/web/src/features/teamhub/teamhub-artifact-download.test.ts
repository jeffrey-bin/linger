import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpTeamHubClient } from "./teamhub-client";
import {
  MAXIMUM_ARTIFACT_DOWNLOAD_BYTES,
  readBoundedArtifactContent,
  runBoundedArtifactDownload,
} from "./teamhub-artifact-download";

const helloSha256 =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("TeamHub Artifact download", () => {
  it("cancels rejected response bodies before returning a metadata error", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": "6" },
    });
    await expect(
      readBoundedArtifactContent(response, {
        expectedSizeBytes: 5,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/immutable Version metadata/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a response when its caller has already aborted", async () => {
    const cancel = vi.fn();
    const caller = new AbortController();
    caller.abort();
    const response = new Response(new ReadableStream({ cancel }));
    await expect(
      readBoundedArtifactContent(response, { signal: caller.signal }),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("verifies latest HTML when zstd delivery strips its ETag", async () => {
    const client = createHttpTeamHubClient({
      fetchRequest: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("hello", {
          headers: {
            "content-type": "text/html",
            "content-encoding": "zstd",
            "x-content-sha256": helloSha256,
          },
        }),
      ),
    });
    const content = await client.downloadLatestDocument("html-document");
    expect(await content.blob.text()).toBe("hello");
    expect(content.sha256).toBe(helloSha256);
  });

  it.each(["wrong", "HELLO"])(
    "rejects changed bytes despite an intact source digest (%s)",
    async (body) => {
      const client = createHttpTeamHubClient({
        fetchRequest: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(body, {
            headers: {
              "content-type": "text/html",
              "x-content-sha256": helloSha256,
            },
          }),
        ),
      });
      await expect(
        client.downloadLatestDocument("html-document"),
      ).rejects.toThrow(/integrity verification/);
    },
  );

  it("does not fall back to an ETag when an explicit source digest is invalid", async () => {
    const client = createHttpTeamHubClient({
      fetchRequest: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("hello", {
          headers: { "x-content-sha256": "invalid", etag: `"${helloSha256}"` },
        }),
      ),
    });
    await expect(
      client.downloadLatestDocument("html-document"),
    ).rejects.toThrow(/integrity verification/);
  });
  it.each(['"', 'W/"'])(
    "verifies decoded HTML bytes with a %s SHA-256 ETag",
    async (prefix) => {
      const client = createHttpTeamHubClient({
        fetchRequest: vi.fn<typeof fetch>().mockResolvedValue(
          new Response("hello", {
            headers: {
              "content-type": "text/html",
              etag: `${prefix}${helloSha256}"`,
            },
          }),
        ),
      });
      await expect(
        client.downloadLatestDocument("html-document"),
      ).resolves.toMatchObject({ sha256: helloSha256 });
    },
  );

  it("rejects corrupted HTML even with a weak SHA-256 ETag", async () => {
    const client = createHttpTeamHubClient({
      fetchRequest: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("wrong", {
          headers: { "content-type": "text/html", etag: `W/"${helloSha256}"` },
        }),
      ),
    });
    await expect(
      client.downloadLatestDocument("html-document"),
    ).rejects.toThrow(/integrity verification/);
  });

  it("compares decoded size rather than compressed Content-Length with Version metadata", async () => {
    const controller = new AbortController();
    await expect(
      readBoundedArtifactContent(
        new Response("hello", {
          headers: {
            "content-type": "text/html",
            "content-encoding": "gzip",
            "content-length": "25",
          },
        }),
        { expectedSizeBytes: 5, signal: controller.signal },
      ),
    ).resolves.toMatchObject({ sha256: helloSha256 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([`"${helloSha256}"`, `W/"${helloSha256}"`])(
    "verifies latest Document bytes with response ETag %s",
    async (etag) => {
      const client = createHttpTeamHubClient({
        fetchRequest: vi.fn<typeof fetch>().mockResolvedValue(
          // Fetch exposes decoded bytes even when a proxy compresses the response.
          new Response("hello", {
            headers: { etag, "content-encoding": "br" },
          }),
        ),
      });

      const content = await client.downloadLatestDocument("document-1");
      expect(content.sha256).toBe(helloSha256);
      expect(await content.blob.text()).toBe("hello");
    },
  );

  it.each([
    null,
    helloSha256,
    `w/"${helloSha256}"`,
    `W/W/"${helloSha256}"`,
    `"${"0".repeat(64)}"`,
    `W/"${"0".repeat(64)}"`,
  ])("rejects latest Document bytes with invalid ETag %s", async (etag) => {
    const client = createHttpTeamHubClient({
      fetchRequest: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("hello", { headers: etag === null ? {} : { etag } }),
        ),
    });

    await expect(client.downloadLatestDocument("document-1")).rejects.toThrow(
      "The File download failed integrity verification.",
    );
  });

  it("rejects weak ETags for immutable Version byte ranges", async () => {
    const client = createHttpTeamHubClient({
      fetchRequest: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("hello", {
          headers: {
            "content-range": "bytes 0-4/5",
            etag: `W/"${helloSha256}"`,
          },
          status: 206,
        }),
      ),
    });

    await expect(
      client.downloadDocumentVersionRange("version-1", {
        endInclusive: 4,
        expectedSha256: helloSha256,
        expectedTotalSize: 5,
      }),
    ).rejects.toThrow(
      "The File preview no longer matches its immutable Version.",
    );
  });

  it("streams bounded bytes and computes SHA-256 during the transfer", async () => {
    const client = createHttpTeamHubClient({
      fetchRequest: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("hello", {
          headers: {
            "content-length": "5",
            "content-type": "text/plain",
          },
        }),
      ),
    });

    await expect(
      client.downloadDocumentVersion("version-1", { expectedSizeBytes: 5 }),
    ).resolves.toMatchObject({
      mediaType: "text/plain",
      sha256: helloSha256,
    });
  });

  it("downloads an exact immutable Version byte range", async () => {
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("hello", {
        headers: {
          "content-length": "5",
          "content-range": "bytes 0-4/12",
          "content-type": "text/csv",
          etag: `"${helloSha256}"`,
        },
        status: 206,
      }),
    );
    const client = createHttpTeamHubClient({ fetchRequest });

    await expect(
      client.downloadDocumentVersionRange("version-1", {
        endInclusive: 4,
        expectedSha256: helloSha256,
        expectedTotalSize: 12,
      }),
    ).resolves.toMatchObject({
      endInclusive: 4,
      mediaType: "text/csv",
      start: 0,
      totalSize: 12,
    });
    expect(fetchRequest).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: {
          "If-Range": `"${helloSha256}"`,
          Range: "bytes=0-4",
        },
      }),
    );
  });

  it("rejects a range response that does not match the immutable Version", async () => {
    const client = createHttpTeamHubClient({
      fetchRequest: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("hello", {
          headers: {
            "content-length": "5",
            "content-range": "bytes 1-5/12",
            etag: `"${helloSha256}"`,
          },
          status: 206,
        }),
      ),
    });

    await expect(
      client.downloadDocumentVersionRange("version-1", {
        endInclusive: 4,
        expectedSha256: helloSha256,
        expectedTotalSize: 12,
      }),
    ).rejects.toThrow(/unexpected byte range/);
  });

  it("preserves a TeamHub error returned for a rejected range", async () => {
    const client = createHttpTeamHubClient({
      fetchRequest: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "ARTIFACT_RANGE_NOT_SATISFIABLE",
              message: "The requested Artifact range is invalid.",
              retryable: false,
            },
          },
          { status: 416 },
        ),
      ),
    });

    await expect(
      client.downloadDocumentVersionRange("version-1", {
        endInclusive: 4,
        expectedSha256: helloSha256,
        expectedTotalSize: 12,
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_RANGE_NOT_SATISFIABLE",
      message: "The requested Artifact range is invalid.",
      status: 416,
    });
  });

  it("rejects Content-Length disagreement before reading the body", async () => {
    const controller = new AbortController();

    await expect(
      readBoundedArtifactContent(
        new Response("hello", {
          headers: { "content-length": "4" },
        }),
        { expectedSizeBytes: 5, signal: controller.signal },
      ),
    ).rejects.toThrow(/immutable Version metadata/);
  });

  it("stops a stream as soon as received bytes exceed Version metadata", async () => {
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode("hello!"));
          streamController.close();
        },
      }),
    );

    await expect(
      readBoundedArtifactContent(response, {
        expectedSizeBytes: 5,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/immutable Version metadata/);
  });

  it("rejects a declared download above the fixed client byte budget", async () => {
    const controller = new AbortController();

    await expect(
      readBoundedArtifactContent(
        new Response(null, {
          headers: {
            "content-length": String(MAXIMUM_ARTIFACT_DOWNLOAD_BYTES + 1),
          },
        }),
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/100 MiB client limit/);
  });

  it("binds caller cancellation to the active download", async () => {
    const caller = new AbortController();
    const download = runBoundedArtifactDownload(
      { signal: caller.signal },
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    caller.abort();

    await expect(download).rejects.toMatchObject({ name: "AbortError" });
  });

  it("turns an expired download budget into a stable timeout error", async () => {
    vi.useFakeTimers();
    const download = runBoundedArtifactDownload(
      { timeoutMs: 50 },
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const assertion = expect(download).rejects.toThrow(/download timed out/);

    await vi.advanceTimersByTimeAsync(50);

    await assertion;
  });
});
