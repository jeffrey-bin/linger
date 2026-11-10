import {
  documentSeeds,
  createDocumentTestRuntime,
  seedRoomUpload,
  seedUploadedDocument,
} from "@/test/document-scenarios";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubDocumentPreviewSession } from "@/features/teamhub/teamhub-types";
import type { TestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";

import { DocumentVersionPreview } from "./document-version-preview";
import { rememberUploadedImage } from "../files/uploaded-image-preview";
import { teamHubData } from "@/features/teamhub/teamhub-api";

vi.mock("@/features/rooms/files/office-preview-adapter-loader", () => ({
  OfficePreviewAdapterLoader: ({ mediaType }: { mediaType: string }) => (
    <div data-media-type={mediaType}>Office preview</div>
  ),
}));

describe("Document Version media preview", () => {
  it("downloads Latest from the fallback instead of using preview bytes or an old Version", async () => {
    const { runtime } = await mediaDocument("latest-download");
    const document = await seedRoomUpload(runtime, "latest-download", {
      file: new File(["zip"], "archive.zip", { type: "application/zip" }),
      representationFormat: "binary",
    });
    const download = vi.spyOn(runtime.client, "downloadLatestDocument");
    render(
      <DocumentVersionPreview client={runtime.client} document={document} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(download).toHaveBeenCalledWith(
        document.id,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it("gives Office previews a definite height to fill", async () => {
    const { runtime } = await mediaDocument("office-height");
    const document = await seedRoomUpload(runtime, "office-preview-height", {
      file: new File(["office bytes"], "brief.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      representationFormat: "binary",
    });

    render(
      <DocumentVersionPreview client={runtime.client} document={document} />,
    );

    const preview = (await screen.findByText("Office preview")).closest(
      "[data-document-version-preview]",
    );
    expect(preview).toHaveClass("h-full", "min-h-0");
  });

  it("hands the Office adapter a canonical media type for a generic Version", async () => {
    const { runtime } = await mediaDocument("office-generic-media-type");
    const document = await seedRoomUpload(
      runtime,
      "office-generic-media-type",
      {
        file: new File(["deck bytes"], "lev8_overview.pptx", {
          type: "application/octet-stream",
        }),
        representationFormat: "binary",
      },
    );

    render(
      <DocumentVersionPreview client={runtime.client} document={document} />,
    );

    // A stored generic type must not reach the adapter verbatim: the sibling
    // ArtifactPreviewSurface normalizes it, and a falsy type rendered nothing.
    expect(await screen.findByText("Office preview")).toHaveAttribute(
      "data-media-type",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });

  it.each([false, true])(
    "reuses only matching uploaded image bytes (changed=%s)",
    async (changed) => {
      const { runtime } = await mediaDocument("uploaded-image");
      const file = new File(["uploaded PNG bytes"], "card.png", {
        type: "image/png",
      });
      const document = await seedRoomUpload(runtime, "uploaded-image", {
        file,
        representationFormat: "png",
      });
      rememberUploadedImage(
        runtime.client,
        document,
        changed
          ? new File(["different PNG data"], "card.png", { type: "image/png" })
          : file,
      );
      const metadata = countVersionReads(runtime);
      const download = vi.spyOn(runtime.client, "downloadDocumentVersion");
      const view = render(
        <DocumentVersionPreview client={runtime.client} document={document} />,
      );
      expect(
        await screen.findByRole("img", { name: "card.png" }),
      ).toBeVisible();
      expect(metadata).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { documentVersionId: document.current_version!.id },
        }),
      );
      expect(download).toHaveBeenCalledTimes(changed ? 1 : 0);
      view.unmount();
    },
  );

  it("checks current access before using an uploaded image", async () => {
    const { runtime } = await mediaDocument("uploaded-image-denied");
    const file = new File(["PNG"], "card.png", { type: "image/png" });
    const document = await seedRoomUpload(runtime, "uploaded-image-denied", {
      file,
      representationFormat: "png",
    });
    rememberUploadedImage(runtime.client, document, file);
    runtime.server.on("GET", "/v0/document-versions/{documentVersionId}", () =>
      teamHubErrorResponse(403, "FORBIDDEN", "Access denied"),
    );
    render(
      <DocumentVersionPreview client={runtime.client} document={document} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Access denied");
    expect(screen.queryByRole("img", { name: "card.png" })).toBeNull();
  });
  it.each([false, true])(
    "disposes HTML preview sessions, including late responses (late=%s)",
    async (late) => {
      const { runtime } = await mediaDocument("html-preview");
      const document = await seedRoomUpload(runtime, "html-preview-upload", {
        file: new File(
          [
            '<style>p{color:red}</style><p>HTML</p><script>document.title="ready"</script>',
          ],
          "page.html",
          { type: "text/html" },
        ),
        representationFormat: "html",
      });
      let resolveSession!: (value: TeamHubDocumentPreviewSession) => void;
      const pendingSession = new Promise<TeamHubDocumentPreviewSession>(
        (resolve) => {
          resolveSession = resolve;
        },
      );
      const create = vi.fn(() => pendingSession);
      runtime.server.on(
        "POST",
        "/v0/document-versions/{documentVersionId}/preview-sessions",
        create,
      );
      const session = {
        expires_at: "2026-09-07T12:00:00Z",
        preview_url:
          "https://preview.example.test/v0/document-previews/token/page.html",
      };
      const download = vi.spyOn(runtime.client, "downloadDocumentVersion");
      const view = render(
        <DocumentVersionPreview
          client={runtime.client}
          document={{ ...document, representation_format: "" }}
        />,
      );
      await waitFor(() =>
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({
            params: { documentVersionId: document.current_version!.id },
          }),
        ),
      );
      if (late) view.unmount();
      resolveSession(session);
      if (!late) {
        const frame = await screen.findByTitle("Preview page.html");
        expect(frame).toHaveAttribute(
          "src",
          "https://preview.example.test/v0/document-previews/token/page.html",
        );
        expect(frame).toHaveAttribute("sandbox", "allow-scripts");
        expect(frame).not.toHaveAttribute("srcdoc");
        expect(frame.closest("[data-document-version-preview]")).toHaveClass(
          "h-full",
          "min-h-0",
        );
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({
            params: { documentVersionId: document.current_version!.id },
          }),
        );
        expect(download).not.toHaveBeenCalled();
        view.unmount();
      }
    },
  );

  it("loads the selected immutable Version through the canonical Document API", async () => {
    const { document, initialVersion, runtime } =
      await mediaDocument("canonical");
    const getVersion = countVersionReads(runtime);
    const downloadVersion = vi.spyOn(runtime.client, "downloadDocumentVersion");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:canonical");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);

    const view = render(
      <DocumentVersionPreview client={runtime.client} document={document} />,
    );

    await waitFor(() =>
      expect(downloadVersion).toHaveBeenCalledWith(
        document.current_version!.id,
        expect.objectContaining({
          expectedSizeBytes: initialVersion.size_bytes,
          signal: expect.any(AbortSignal),
        }),
      ),
    );
    expect(getVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { documentVersionId: document.current_version!.id },
      }),
    );

    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:canonical");
  });

  it("revokes the previous Blob URL when the selected Version changes", async () => {
    const {
      document,
      initialVersion,
      replacement,
      replacementVersion,
      runtime,
    } = await mediaDocument("switch");
    vi.spyOn(URL, "createObjectURL").mockImplementation((source) => {
      if (!(source instanceof Blob)) throw new Error("Expected preview Blob.");
      return source.size === initialVersion.size_bytes
        ? "blob:first"
        : "blob:second";
    });
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const view = render(
      <DocumentVersionPreview client={runtime.client} document={document} />,
    );
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());

    view.rerender(
      <DocumentVersionPreview client={runtime.client} document={replacement} />,
    );

    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:first"));
    await waitFor(() =>
      expect(URL.createObjectURL).toHaveBeenCalledWith(
        expect.objectContaining({ size: replacementVersion.size_bytes }),
      ),
    );
    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:second");
  });

  it("does not create a Blob URL for an abandoned Version", async () => {
    const { document, initialVersion, replacement, runtime } =
      await mediaDocument("late");
    const firstVersionId = document.current_version!.id;
    const originalDownload = runtime.client.downloadDocumentVersion.bind(
      runtime.client,
    );
    let resolveFirst!: (
      value: Awaited<ReturnType<TeamHubClient["downloadDocumentVersion"]>>,
    ) => void;
    const firstDownload = new Promise<
      Awaited<ReturnType<TeamHubClient["downloadDocumentVersion"]>>
    >((resolve) => {
      resolveFirst = resolve;
    });
    vi.spyOn(runtime.client, "downloadDocumentVersion").mockImplementation(
      (versionId, options) =>
        versionId === firstVersionId
          ? firstDownload
          : originalDownload(versionId, options),
    );
    vi.spyOn(URL, "createObjectURL").mockImplementation((source) => {
      if (!(source instanceof Blob)) throw new Error("Expected preview Blob.");
      return source.size === initialVersion.size_bytes
        ? "blob:late"
        : "blob:current";
    });
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const view = render(
      <DocumentVersionPreview client={runtime.client} document={document} />,
    );
    await waitFor(() =>
      expect(runtime.client.downloadDocumentVersion).toHaveBeenCalledWith(
        firstVersionId,
        expect.any(Object),
      ),
    );

    view.rerender(
      <DocumentVersionPreview client={runtime.client} document={replacement} />,
    );
    await waitFor(() =>
      expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob)),
    );
    resolveFirst(await originalDownload(firstVersionId));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revoke).not.toHaveBeenCalledWith("blob:late");
    expect(URL.createObjectURL).not.toHaveBeenCalledWith(
      expect.objectContaining({ size: initialVersion.size_bytes }),
    );
    view.unmount();
  });
});

async function mediaDocument(label: string) {
  const runtime = createDocumentTestRuntime();

  const document = await seedUploadedDocument(
    runtime,
    `${label}-document-upload`,
    {
      file: new File([`${label}-first`], `${label}.png`, {
        type: "image/png",
      }),
      representationFormat: "binary",
    },
  );
  const initialVersion = await readDocumentVersion(
    runtime.client,
    document.current_version!.id,
  );
  const replacement = await seedUploadedDocument(
    runtime,
    `${label}-replacement`,
    {
      file: new File([`${label}-second`], `${label}-second.png`, {
        type: "image/png",
      }),
      representationFormat: "binary",
    },
  );
  documentSeeds(runtime).documents.delete(replacement.id);
  replacement.id = document.id;
  replacement.current_version!.version_number = 2;
  documentSeeds(runtime).documents.set(document.id, replacement);
  const replacementVersion = await readDocumentVersion(
    runtime.client,
    replacement.current_version!.id,
  );
  replacementVersion.document_id = document.id;
  replacementVersion.version_number = 2;
  documentSeeds(runtime).versions.set(
    replacementVersion.id,
    replacementVersion,
  );
  return { document, initialVersion, replacement, replacementVersion, runtime };
}

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
