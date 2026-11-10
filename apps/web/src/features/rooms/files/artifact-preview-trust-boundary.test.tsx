import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDocumentTestRuntime,
  seedRoomUpload,
} from "@/test/document-scenarios";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";

import { ArtifactPreviewSurface } from "./artifact-preview-surface";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

describe("ArtifactPreviewSurface trust boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not expose the legacy Artifact-to-Wiki copy command", async () => {
    const { node, runtime } = await previewFixture();

    renderPreview(runtime, node);

    expect(await screen.findByText(node.title)).toBeVisible();
    expect(screen.queryByRole("button", { name: /personal copy/i })).toBeNull();
    expect("importPersonalWikiArtifactVersion" in runtime.client).toBe(false);
  });

  it("keeps immutable download available without a Wiki identity branch", async () => {
    const { node, runtime } = await previewFixture();

    renderPreview(runtime, node);

    expect(
      await screen.findByRole("button", { name: `Download ${node.title}` }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: /personal copy/i })).toBeNull();
  });

  it("does not restore the legacy copy action when the selected Version changes", async () => {
    const { node, runtime } = await previewFixture();
    const firstVersionId = node.current_version!.id;
    const view = renderPreview(runtime, node);
    expect(await screen.findByText(node.title)).toBeVisible();

    const nextVersionId = `${firstVersionId}-next`;
    view.rerender(
      previewElement(runtime, {
        ...node,
        current_version: {
          ...node.current_version!,
          id: nextVersionId,
          version_number: node.current_version!.version_number + 1,
        },
      }),
    );
    expect(screen.queryByRole("button", { name: /personal copy/i })).toBeNull();
  });

  it("rejects Version metadata outside the selected Document scope", async () => {
    const { node, runtime } = await previewFixture();
    const version = await readDocumentVersion(
      runtime.client,
      node.current_version!.id,
    );
    runtime.server.on(
      "GET",
      "/v0/document-versions/{documentVersionId}",
      () => ({
        ...version,
        document_id: "document-other",
      }),
    );
    const download = vi.spyOn(runtime.client, "downloadDocumentVersion");

    renderPreview(runtime, node);

    expect(
      await screen.findByText(
        /Version does not belong to the selected Document/,
      ),
    ).toBeVisible();
    const downloadButton = screen.getByRole("button", {
      name: `Download ${node.title}`,
    });
    expect(downloadButton).toBeDisabled();
    fireEvent.click(downloadButton);
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects preview bytes that disagree with immutable Version metadata", async () => {
    const { node, runtime } = await previewFixture();
    const version = await readDocumentVersion(
      runtime.client,
      node.current_version!.id,
    );
    runtime.server.on(
      "GET",
      "/v0/document-versions/{documentVersionId}",
      () => ({
        ...version,
        media_type: "text/markdown",
        size_bytes: 10,
      }),
    );
    vi.spyOn(runtime.client, "downloadDocumentVersion").mockResolvedValue({
      blob: new Blob(["longer than ten bytes"], { type: "text/markdown" }),
      mediaType: "text/markdown",
    });

    renderPreview(runtime, node);

    expect(
      await screen.findByText(
        /bytes do not match its immutable Version metadata/,
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: `Download ${node.title}` }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Download" }),
    ).not.toBeInTheDocument();
  });

  it("uses immutable Version media metadata for an octet-stream download", async () => {
    const { node, runtime } = await previewFixture();
    const versionId = node.current_version!.id;
    const original = await runtime.client.downloadDocumentVersion(versionId);
    vi.spyOn(runtime.client, "downloadDocumentVersion").mockResolvedValue({
      blob: original.blob.slice(
        0,
        original.blob.size,
        "application/octet-stream",
      ),
      mediaType: "application/octet-stream",
    });

    renderPreview(runtime, node);

    expect(await screen.findByText("Product V0")).toBeVisible();
    expect(
      screen.queryByText(/media type does not match its immutable Version/),
    ).not.toBeInTheDocument();
  });

  it("aborts an active content transfer when the preview closes", async () => {
    const { node, runtime } = await previewFixture();
    let downloadSignal: AbortSignal | undefined;
    vi.spyOn(runtime.client, "downloadDocumentVersion").mockImplementation(
      (_versionId, options) => {
        downloadSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    );
    const onClose = vi.fn();

    renderPreview(runtime, node, onClose);
    await waitFor(() => expect(downloadSignal).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Close file preview" }));

    expect(downloadSignal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("aborts an active download when the preview is unmounted", async () => {
    const { node, runtime } = await previewFixture("zip");
    let downloadSignal: AbortSignal | undefined;
    vi.spyOn(runtime.client, "downloadLatestDocument").mockImplementation(
      (_versionId, options) => {
        downloadSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    );
    const view = renderPreview(runtime, node);
    expect(
      await screen.findByText("This format is available as a download only."),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(downloadSignal).toBeDefined());
    view.unmount();

    expect(downloadSignal?.aborted).toBe(true);
  });

  it.each([false, true])(
    "downloads latest content even when the current Version is explicitly selected (%s)",
    async (explicitVersion) => {
      const { node, runtime } = await previewFixture();
      const download = vi.spyOn(runtime.client, "downloadDocumentVersion");
      const latestBlob = new Blob(["# Edited after preview"]);
      const downloadLatest = vi
        .spyOn(runtime.client, "downloadLatestDocument")
        .mockResolvedValue({ blob: latestBlob, mediaType: "text/markdown" });
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => undefined);

      render(
        previewElement(
          runtime,
          node,
          vi.fn(),
          explicitVersion ? node.current_version!.id : undefined,
        ),
      );
      expect(await screen.findByText("Product V0")).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: `Download ${node.title}` }),
      );

      expect(download).toHaveBeenCalledOnce();
      await waitFor(() => expect(click).toHaveBeenCalledOnce());
      expect(downloadLatest).toHaveBeenCalledWith(node.id, {
        signal: expect.any(AbortSignal),
      });
      expect(URL.createObjectURL).toHaveBeenLastCalledWith(latestBlob);
    },
  );

  it("keeps an explicitly selected historical Version download pinned", async () => {
    const { node, runtime } = await previewFixture();
    const downloadLatest = vi.spyOn(runtime.client, "downloadLatestDocument");
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    render(
      previewElement(
        runtime,
        {
          ...node,
          current_version: { ...node.current_version!, id: "newer-version" },
        },
        vi.fn(),
        node.current_version!.id,
      ),
    );
    expect(await screen.findByText("Product V0")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: `Download ${node.title}` }),
    );
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(downloadLatest).not.toHaveBeenCalled();
  });

  it("clears a failed download after a successful retry", async () => {
    const { node, runtime } = await previewFixture("zip");
    const downloadLatestDocument = runtime.client.downloadLatestDocument.bind(
      runtime.client,
    );
    vi.spyOn(runtime.client, "downloadLatestDocument")
      .mockRejectedValueOnce(new Error("File download failed."))
      .mockImplementation(downloadLatestDocument);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );

    renderPreview(runtime, node);
    expect(
      await screen.findByText("This format is available as a download only."),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByText("File download failed.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(
        screen.queryByText("File download failed."),
      ).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByText("This format is available as a download only."),
    ).toBeVisible();
  });
});

async function previewFixture(format = "markdown") {
  const runtime = createDocumentTestRuntime();

  const filename = format === "zip" ? "archive.zip" : "product-v0-brief.md";
  const mediaType = format === "zip" ? "application/zip" : "text/markdown";
  const content = format === "zip" ? "zip bytes" : "# Product V0";
  const node = await seedRoomUpload(runtime, `preview-${format}`, {
    file: new File([content], filename, { type: mediaType }),
    representationFormat: format,
  });
  return { node, runtime };
}

function renderPreview(
  runtime: ReturnType<typeof createDocumentTestRuntime>,
  node: TeamHubDocument,
  onClose = vi.fn(),
) {
  return render(previewElement(runtime, node, onClose));
}

function previewElement(
  runtime: ReturnType<typeof createDocumentTestRuntime>,
  node: TeamHubDocument,
  onClose = vi.fn(),
  versionId?: string,
) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <ArtifactPreviewSurface
          node={node}
          onClose={onClose}
          versionId={versionId}
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>
  );
}

function readDocumentVersion(client: TeamHubClient, documentVersionId: string) {
  return teamHubData(
    client.api.GET("/v0/document-versions/{documentVersionId}", {
      params: { path: { documentVersionId } },
    }),
  );
}
