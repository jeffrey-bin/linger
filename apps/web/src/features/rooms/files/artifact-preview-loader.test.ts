import { describe, expect, it, vi } from "vitest";

import {
  createDocumentTestRuntime,
  seedRoomUpload,
} from "@/test/document-scenarios";
import type { TestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TestRouteRequest } from "@/test/teamhub-test-server";

import {
  downloadArtifactPreview,
  loadArtifactPreview,
  prefetchArtifactPreview,
} from "./artifact-preview-loader";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

describe("loadArtifactPreview", () => {
  it("opens authored HTML through a signed folder preview URL", async () => {
    const runtime = createDocumentTestRuntime();

    const document = await seedRoomUpload(runtime, "preview-html", {
      file: new File(["<h1>Preview</h1>"], "site/index.html", {
        type: "text/html",
      }),
      representationFormat: "html",
    });
    const versionId = document.current_version!.id;
    const createSession = vi.fn(() => ({
      expires_at: "2026-08-25T12:10:00Z",
      preview_url:
        "https://preview.example.test/v0/document-previews/token/index.html",
    }));
    runtime.server.on(
      "POST",
      "/v0/document-versions/{documentVersionId}/preview-sessions",
      createSession,
    );
    const download = vi.spyOn(runtime.client, "downloadDocumentVersion");

    const preview = await loadArtifactPreview({
      client: runtime.client,
      documentId: document.id,
      signal: new AbortController().signal,
      versionId,
    });

    expect(preview.decision.kind).toBe("html");
    expect(preview.previewUrl).toBe(
      "https://preview.example.test/v0/document-previews/token/index.html",
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ params: { documentVersionId: versionId } }),
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("gives Room Markdown a folder base without executing it", async () => {
    const runtime = createDocumentTestRuntime();

    const document = await seedRoomUpload(runtime, "preview-markdown", {
      file: new File(["# Product V0"], "product-v0-brief.md", {
        type: "text/markdown",
      }),
      representationFormat: "markdown",
    });
    const versionId = document.current_version!.id;
    const createSession = vi.fn(() => ({
      expires_at: "2026-08-25T12:10:00Z",
      preview_url:
        "https://preview.example.test/v0/document-previews/token/product-v0-brief.md",
    }));
    runtime.server.on(
      "POST",
      "/v0/document-versions/{documentVersionId}/preview-sessions",
      createSession,
    );
    const preview = await loadArtifactPreview({
      client: runtime.client,
      documentId: document.id,
      signal: new AbortController().signal,
      versionId,
    });

    expect(preview.decision.kind).toBe("markdown");
    expect(preview.textContent).toContain("# Product V0");
    expect(preview.previewUrl).toContain(
      "/v0/document-previews/token/product-v0-brief.md",
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ params: { documentVersionId: versionId } }),
    );
  });

  it("uses the exact authorized Version URL for streaming media", async () => {
    const runtime = createDocumentTestRuntime();

    const document = await seedRoomUpload(runtime, "preview-video", {
      file: new File(["video"], "meeting.mp4", { type: "video/mp4" }),
      representationFormat: "mp4",
    });
    const versionId = document.current_version!.id;
    const version = await readDocumentVersion(runtime.client, versionId);
    runtime.server.on(
      "GET",
      "/v0/document-versions/{documentVersionId}",
      () => ({
        ...version,
        filename: "meeting.mp4",
        media_type: "video/mp4",
        size_bytes: 500 * 1024 * 1024,
      }),
    );
    const dispose = vi.fn();
    const location = vi
      .spyOn(runtime.client, "getDocumentVersionContentLocation")
      .mockResolvedValue({
        dispose,
        url: `/v0/document-versions/${versionId}/content`,
      });
    const download = vi.spyOn(runtime.client, "downloadDocumentVersion");

    const preview = await loadArtifactPreview({
      client: runtime.client,
      documentId: document.id,
      signal: new AbortController().signal,
      versionId,
    });

    expect(preview.decision.kind).toBe("media");
    expect(preview.sourceSizeBytes).toBe(500 * 1024 * 1024);
    expect(preview.objectUrl).toBe(
      `/v0/document-versions/${versionId}/content`,
    );
    expect(location).toHaveBeenCalledWith(versionId);
    expect(download).not.toHaveBeenCalled();
    preview.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rechecks media access and obtains a fresh descriptor on every open", async () => {
    const runtime = createDocumentTestRuntime();

    const document = await seedRoomUpload(runtime, "preview-cached-video", {
      file: new File(["video"], "cached.mp4", { type: "video/mp4" }),
      representationFormat: "mp4",
    });
    const versionId = document.current_version!.id;
    const getVersion = countVersionReads(runtime);
    const location = vi
      .spyOn(runtime.client, "getDocumentVersionContentLocation")
      .mockResolvedValue({
        dispose: vi.fn(),
        url: `http://localhost/v0/document-versions/${versionId}/content`,
      });

    const first = await loadArtifactPreview({
      client: runtime.client,
      documentId: document.id,
      signal: new AbortController().signal,
      versionId,
    });
    first.dispose();
    const second = await loadArtifactPreview({
      client: runtime.client,
      documentId: document.id,
      signal: new AbortController().signal,
      versionId,
    });

    expect(second.objectUrl).toBe(first.objectUrl);
    expect(getVersion).toHaveBeenCalledTimes(2);
    expect(location).toHaveBeenCalledTimes(2);
  });

  it("loads only the bounded byte range for a large CSV preview", async () => {
    const runtime = createDocumentTestRuntime();

    const document = await seedRoomUpload(runtime, "preview-csv", {
      file: new File(["name,value\nJenny,1"], "large.csv", {
        type: "text/csv",
      }),
      representationFormat: "csv",
    });
    const versionId = document.current_version!.id;
    const version = await readDocumentVersion(runtime.client, versionId);
    const sourceSizeBytes = 50 * 1024 * 1024;
    runtime.server.on(
      "GET",
      "/v0/document-versions/{documentVersionId}",
      () => ({
        ...version,
        filename: "large.csv",
        media_type: "text/csv",
        size_bytes: sourceSizeBytes,
      }),
    );
    const range = vi
      .spyOn(runtime.client, "downloadDocumentVersionRange")
      .mockResolvedValue({
        blob: new Blob(["name,value\nJenny,1"], { type: "text/csv" }),
        endInclusive: 5 * 1024 * 1024 - 1,
        mediaType: "text/csv",
        start: 0,
        totalSize: sourceSizeBytes,
      });
    const download = vi.spyOn(runtime.client, "downloadDocumentVersion");

    const preview = await loadArtifactPreview({
      client: runtime.client,
      documentId: document.id,
      signal: new AbortController().signal,
      versionId,
    });

    expect(preview.decision.kind).toBe("csv");
    expect(preview.sourceSizeBytes).toBe(sourceSizeBytes);
    expect(range).toHaveBeenCalledWith(
      versionId,
      expect.objectContaining({
        endInclusive: 5 * 1024 * 1024 - 1,
        expectedSha256: version.sha256,
        expectedTotalSize: sourceSizeBytes,
      }),
    );
    expect(download).not.toHaveBeenCalled();

    download.mockResolvedValue({
      blob: new Blob(["complete CSV"]),
      mediaType: "text/csv",
      sha256: version.sha256,
    });
    await expect(
      downloadArtifactPreview({
        client: runtime.client,
        preview,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/immutable Version metadata/);
    expect(download).toHaveBeenCalledWith(
      versionId,
      expect.objectContaining({ expectedSizeBytes: sourceSizeBytes }),
    );
  });

  it("previews SVG through an SVG-typed object URL", async () => {
    const runtime = createDocumentTestRuntime();
    const document = await seedRoomUpload(runtime, "preview-svg", {
      file: new File(
        [
          '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:red}</style><rect width="1" height="1"/></svg>',
        ],
        "pelican.svg",
        { type: "image/svg+xml" },
      ),
      representationFormat: "binary",
    });
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:pelican");

    const preview = await loadArtifactPreview({
      client: runtime.client,
      documentId: document.id,
      signal: new AbortController().signal,
      versionId: document.current_version!.id,
    });

    expect(preview.decision.kind).toBe("svg");
    expect(preview.objectUrl).toBe("blob:pelican");
    expect(createObjectUrl.mock.calls[0]?.[0]).toMatchObject({
      type: "image/svg+xml",
    });
    createObjectUrl.mockRestore();
    preview.dispose();
  });

  it("uses Version metadata returned by open without Session or Version lookups", async () => {
    const runtime = createDocumentTestRuntime();
    const document = await seedRoomUpload(runtime, "preview-known-version", {
      file: new File(["known"], "known.txt", { type: "text/plain" }),
      representationFormat: "text",
    });
    const versionId = document.current_version!.id;
    const knownVersion = await readDocumentVersion(runtime.client, versionId);
    const getVersion = countVersionReads(runtime);
    const download = vi.spyOn(runtime.client, "downloadDocumentVersion");

    const preview = await loadArtifactPreview({
      client: runtime.client,
      documentId: document.id,
      knownVersion,
      signal: new AbortController().signal,
      versionId,
    });

    expect(preview.textContent).toBe("known");
    expect(runtime.server.requestsTo("GET", "/v0/session")).toHaveLength(0);
    expect(getVersion).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledOnce();
    preview.dispose();
  });

  it("looks up the requested Version when known metadata names another one", async () => {
    const runtime = createDocumentTestRuntime();
    const document = await seedRoomUpload(runtime, "preview-other-version", {
      file: new File(["current"], "current.txt", { type: "text/plain" }),
      representationFormat: "text",
    });
    const versionId = document.current_version!.id;
    const version = await readDocumentVersion(runtime.client, versionId);
    const getVersion = countVersionReads(runtime);

    const preview = await loadArtifactPreview({
      client: runtime.client,
      documentId: document.id,
      knownVersion: { ...version, id: "stale-version", filename: "stale.txt" },
      signal: new AbortController().signal,
      versionId,
    });

    expect(getVersion).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ params: { documentVersionId: versionId } }),
    );
    expect(runtime.server.requestsTo("GET", "/v0/session")).toHaveLength(0);
    expect(preview.version.filename).toBe("current.txt");
    preview.dispose();
  });

  it("joins a click prefetch with the later open-authorized load", async () => {
    const runtime = createDocumentTestRuntime();
    const document = await seedRoomUpload(runtime, "preview-prefetch", {
      file: new File(["prefetched"], "prefetched.txt", { type: "text/plain" }),
      representationFormat: "text",
    });
    const version = await readDocumentVersion(
      runtime.client,
      document.current_version!.id,
    );
    const download = vi.spyOn(runtime.client, "downloadDocumentVersion");

    prefetchArtifactPreview({ client: runtime.client, version });
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const preview = await loadArtifactPreview({
      client: runtime.client,
      documentId: document.id,
      knownVersion: version,
      signal: new AbortController().signal,
      versionId: version.id,
    });

    expect(preview.textContent).toBe("prefetched");
    expect(download).toHaveBeenCalledOnce();
    preview.dispose();
  });

  it("discards a stale prefetch when open names a newer Version", async () => {
    const runtime = createDocumentTestRuntime();
    const stale = await seedRoomUpload(runtime, "preview-stale", {
      file: new File(["stale"], "notes.txt", { type: "text/plain" }),
      representationFormat: "text",
    });
    const current = await seedRoomUpload(runtime, "preview-current", {
      file: new File(["current"], "notes.txt", { type: "text/plain" }),
      representationFormat: "text",
    });
    const staleVersion = await readDocumentVersion(
      runtime.client,
      stale.current_version!.id,
    );
    const currentVersion = await readDocumentVersion(
      runtime.client,
      current.current_version!.id,
    );
    const download = vi.spyOn(runtime.client, "downloadDocumentVersion");

    prefetchArtifactPreview({ client: runtime.client, version: staleVersion });
    const preview = await loadArtifactPreview({
      client: runtime.client,
      documentId: current.id,
      knownVersion: currentVersion,
      signal: new AbortController().signal,
      versionId: currentVersion.id,
    });

    expect(preview.textContent).toBe("current");
    expect(download.mock.calls.map(([id]) => id)).toEqual([
      staleVersion.id,
      currentVersion.id,
    ]);
    preview.dispose();
  });

  it.each([
    ["clip.mp4", "video/mp4", "binary"],
    ["table.csv", "text/csv", "binary"],
    ["site/index.html", "text/html", "html"],
    ["archive.zip", "application/zip", "binary"],
  ])(
    "does not prefetch %s, whose preview is not a whole-file download",
    async (filename, type, representationFormat) => {
      const runtime = createDocumentTestRuntime();
      const document = await seedRoomUpload(runtime, `skip-${filename}`, {
        file: new File(["bytes"], filename, { type }),
        representationFormat,
      });
      const version = await readDocumentVersion(
        runtime.client,
        document.current_version!.id,
      );
      const download = vi.spyOn(runtime.client, "downloadDocumentVersion");
      const location = vi.spyOn(
        runtime.client,
        "getDocumentVersionContentLocation",
      );
      const range = vi.spyOn(runtime.client, "downloadDocumentVersionRange");

      prefetchArtifactPreview({ client: runtime.client, version });
      await Promise.resolve();
      await Promise.resolve();

      expect(download).not.toHaveBeenCalled();
      expect(location).not.toHaveBeenCalled();
      expect(range).not.toHaveBeenCalled();
    },
  );
});

// Serves the seeded Version and records each metadata read.
function countVersionReads(runtime: TestTeamHubRuntime) {
  const read = vi.fn(({ params }: TestRouteRequest) =>
    runtime.seed.documentVersions.get(params.documentVersionId!),
  );
  runtime.server.on("GET", "/v0/document-versions/{documentVersionId}", read);
  return read;
}

function readDocumentVersion(client: TeamHubClient, documentVersionId: string) {
  return teamHubData(
    client.api.GET("/v0/document-versions/{documentVersionId}", {
      params: { path: { documentVersionId } },
    }),
  );
}
