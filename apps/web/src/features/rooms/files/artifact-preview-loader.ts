/* oxlint-disable react-doctor/no-create-object-url-without-revoke -- Every loaded preview carries a required dispose callback; both dialog and inline consumers invoke it for late responses and effect cleanup. */
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubDocumentVersion } from "@/features/teamhub/teamhub-types";

import {
  type ArtifactRendererDecision,
  selectArtifactRenderer,
} from "./artifact-renderer-policy";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import {
  artifactPreviewCache,
  type ArtifactReadingPosition,
} from "./artifact-preview-cache";
import { takeUploadedImage } from "./uploaded-image-preview";
import { dataPreviewLimits } from "./data-preview-protocol";
import { verifyArtifactDownloadIntegrity } from "./artifact-download-integrity";

import { prepareOfficePreview } from "./office-preview-preparation";

export interface LoadedArtifactPreview {
  blob?: Blob;
  readingPosition?: ArtifactReadingPosition;
  decision: ArtifactRendererDecision;
  dispose: () => void;
  objectUrl?: string;
  previewUrl?: string;
  expiresAt?: string;
  sourceSizeBytes?: number;
  textContent?: string;
  version: TeamHubDocumentVersion;
}

export async function downloadArtifactPreview({
  client,
  preview,
  signal,
}: {
  client: TeamHubClient;
  preview: LoadedArtifactPreview;
  signal: AbortSignal;
}) {
  if (preview.blob && preview.blob.size === preview.version.size_bytes) {
    return preview.blob;
  }

  return (
    await verifyArtifactDownloadIntegrity(
      preview.version,
      await client.downloadDocumentVersion(preview.version.id, {
        expectedSizeBytes: preview.version.size_bytes,
        signal,
      }),
    )
  ).blob;
}

export function triggerArtifactDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * `knownVersion` is immutable metadata already returned by a server read check,
 * such as Document open. It is used only when it names the requested Version.
 */
export async function loadArtifactPreview({
  client,
  documentId,
  knownVersion,
  signal,
  versionId,
}: {
  client: TeamHubClient;
  documentId: string;
  knownVersion?: TeamHubDocumentVersion;
  signal: AbortSignal;
  versionId: string;
}): Promise<LoadedArtifactPreview> {
  signal.throwIfAborted();
  const revision = artifactPreviewCache.revision;
  try {
    const version =
      knownVersion?.id === versionId && knownVersion.document_id === documentId
        ? knownVersion
        : await teamHubData(
            client.api.GET("/v0/document-versions/{documentVersionId}", {
              params: { path: { documentVersionId: versionId } },
            }),
          );
    signal.throwIfAborted();
    if (revision !== artifactPreviewCache.revision)
      throw new DOMException("Preview session changed.", "AbortError");
    assertDocumentVersionScope({ documentId, versionId }, version);
    if (
      selectArtifactRenderer({
        filename: version.filename,
        mediaType: version.media_type,
        sizeBytes: version.size_bytes,
      }).kind === "office"
    )
      prepareOfficePreview(version.filename, version.media_type);
    const authorizedRevision = artifactPreviewCache.revision;
    const cacheKey = artifactPreviewCacheKey(client, version);
    const preview = await loadAuthorizedArtifactPreview({
      client,
      signal,
      version,
      cacheKey,
    });
    if (
      signal.aborted ||
      authorizedRevision !== artifactPreviewCache.revision
    ) {
      preview.dispose();
      throw new DOMException("Preview loading was cancelled.", "AbortError");
    }
    return preview;
  } catch (error) {
    if (error instanceof TeamHubError && [401, 403, 404].includes(error.status))
      artifactPreviewCache.clear();
    throw error;
  }
}

function artifactPreviewCacheKey(
  client: TeamHubClient,
  version: TeamHubDocumentVersion,
) {
  return JSON.stringify([
    artifactPreviewCache.scope(client),
    version.document_id,
    version.id,
    version.sha256,
    version.size_bytes,
    version.media_type,
    version.filename,
  ]);
}

const WHOLE_FILE_PREVIEW_KINDS = new Set([
  "image",
  "markdown",
  "mermaid",
  "office",
  "pdf",
  "svg",
  "text",
]);

/**
 * Start the content transfer for a Room card click before Document open
 * returns. This never authorizes display: the viewer still waits for a
 * successful open and joins this transfer only when open names the same
 * Version. A transfer nobody joins stops when its only reader times out.
 */
export function prefetchArtifactPreview({
  client,
  version,
}: {
  client: TeamHubClient;
  version: TeamHubDocumentVersion;
}) {
  const { kind } = selectArtifactRenderer({
    filename: version.filename,
    mediaType: version.media_type,
    sizeBytes: version.size_bytes,
  });
  if (!WHOLE_FILE_PREVIEW_KINDS.has(kind)) return;
  if (kind === "office")
    prepareOfficePreview(version.filename, version.media_type);
  void artifactPreviewCache
    .get(
      artifactPreviewCacheKey(client, version),
      AbortSignal.timeout(15_000),
      (transfer) => downloadPreviewContent(client, version, kind, transfer),
    )
    .catch(() => undefined);
}

async function downloadPreviewContent(
  client: TeamHubClient,
  version: TeamHubDocumentVersion,
  kind: ArtifactRendererDecision["kind"],
  transferSignal: AbortSignal,
) {
  const uploadedImage =
    kind === "image" ? await takeUploadedImage(client, version) : undefined;
  const verified = uploadedImage
    ? { blob: uploadedImage, mediaType: version.media_type }
    : await verifyArtifactDownloadIntegrity(
        version,
        await client.downloadDocumentVersion(version.id, {
          expectedSizeBytes: version.size_bytes,
          signal: transferSignal,
        }),
      );
  transferSignal.throwIfAborted();
  const usesText = ["markdown", "mermaid", "text"].includes(kind);
  return {
    ...verified,
    textContent: usesText ? await verified.blob.text() : undefined,
    readingPosition: {},
  };
}

async function loadAuthorizedArtifactPreview({
  client,
  signal,
  version,
  cacheKey,
}: {
  client: TeamHubClient;
  signal: AbortSignal;
  version: TeamHubDocumentVersion;
  cacheKey: string;
}): Promise<LoadedArtifactPreview> {
  const versionId = version.id;
  const metadataDecision = selectArtifactRenderer({
    filename: version.filename,
    mediaType: version.media_type,
    sizeBytes: version.size_bytes,
  });
  if (metadataDecision.kind === "download") {
    return { decision: metadataDecision, dispose: () => undefined, version };
  }

  if (metadataDecision.kind === "media") {
    const location = await client.getDocumentVersionContentLocation(versionId);
    const preview = {
      decision: metadataDecision,
      dispose: location.dispose,
      objectUrl: location.url,
      sourceSizeBytes: version.size_bytes,
      version,
    };
    return preview;
  }

  if (metadataDecision.kind === "html") {
    const session = await createPreviewSession(client, versionId);
    return {
      decision: metadataDecision,
      dispose: () => undefined,
      previewUrl: session.preview_url,
      expiresAt: session.expires_at,
      version,
    };
  }

  if (metadataDecision.kind === "csv" && version.size_bytes > 0) {
    const endInclusive =
      Math.min(version.size_bytes, dataPreviewLimits.maxBytes) - 1;
    const content = await client.downloadDocumentVersionRange(versionId, {
      endInclusive,
      expectedSha256: version.sha256,
      expectedTotalSize: version.size_bytes,
      signal,
    });
    const decision = selectArtifactRenderer({
      filename: version.filename,
      mediaType: content.mediaType,
      sizeBytes: version.size_bytes,
    });
    if (decision.kind !== "csv") {
      return { decision, dispose: () => undefined, version };
    }
    return {
      blob: content.blob,
      decision,
      dispose: () => undefined,
      sourceSizeBytes: content.totalSize,
      version,
    };
  }

  const content = await artifactPreviewCache.get(cacheKey, signal, (transfer) =>
    downloadPreviewContent(client, version, metadataDecision.kind, transfer),
  );
  const decision = selectArtifactRenderer({
    filename: version.filename,
    mediaType: content.mediaType,
    sizeBytes: content.blob.size,
  });
  if (decision.kind === "download") {
    return { decision, dispose: () => undefined, version };
  }

  const previewSession =
    decision.kind === "markdown"
      ? await createPreviewSession(client, versionId)
      : undefined;
  // An SVG previews as an image, which runs it without scripts or external
  // loads but keeps its CSS and SMIL animation. Browsers decode a Blob URL as
  // SVG only when the Blob carries the SVG media type.
  const objectUrl =
    decision.kind === "svg"
      ? URL.createObjectURL(new Blob([content.blob], { type: "image/svg+xml" }))
      : ["image", "media"].includes(decision.kind)
        ? URL.createObjectURL(content.blob)
        : undefined;
  return {
    blob: content.blob,
    decision,
    dispose: () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
    objectUrl,
    previewUrl: previewSession?.preview_url,
    expiresAt: previewSession?.expires_at,
    sourceSizeBytes: content.blob.size,
    textContent: content.textContent,
    readingPosition: content.readingPosition,
    version,
  };
}

function assertDocumentVersionScope(
  scope: {
    documentId: string;
    versionId: string;
  },
  version: TeamHubDocumentVersion,
) {
  if (
    version.id !== scope.versionId ||
    version.document_id !== scope.documentId
  ) {
    throw new Error("This Version does not belong to the selected Document.");
  }
}

function createPreviewSession(client: TeamHubClient, versionId: string) {
  return teamHubData(
    client.api.POST(
      "/v0/document-versions/{documentVersionId}/preview-sessions",
      { params: { path: { documentVersionId: versionId } } },
    ),
  );
}
