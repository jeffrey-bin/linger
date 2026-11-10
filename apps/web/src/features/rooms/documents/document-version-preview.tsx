/* oxlint-disable react-doctor/no-create-object-url-without-revoke -- Preview URLs are revoked on effect cleanup and late-response races. */
import {
  Alert02Icon,
  Download04Icon,
  FileNotFoundIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { Icon } from "@/components/ui/icon";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { documentFileName } from "@/features/library/document-display-name";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubDocument,
  TeamHubDocumentVersion,
} from "@/features/teamhub/teamhub-types";
import { ArtifactContentRendererLoader } from "@/features/rooms/files/artifact-content-renderer-loader";
import {
  type ArtifactRendererDecision,
  resolveArtifactPreviewMediaType,
} from "@/features/rooms/files/artifact-renderer-policy";
import {
  loadArtifactPreview,
  triggerArtifactDownload,
} from "@/features/rooms/files/artifact-preview-loader";
import { ArtifactReadingViewport } from "../files/artifact-reading-viewport";
import type { ArtifactReadingPosition } from "../files/artifact-preview-cache";
import { PreviewSessionExpiryNotice } from "../files/preview-session-expiry-notice";

interface LoadedDocumentPreview {
  blob?: Blob;
  readingPosition?: ArtifactReadingPosition;
  sourceSizeBytes?: number;
  dispose?: () => void;
  decision: ArtifactRendererDecision;
  objectUrl?: string;
  previewUrl?: string;
  expiresAt?: string;
  textContent?: string;
  version: Pick<TeamHubDocumentVersion, "media_type"> & {
    id?: string;
    filename?: string;
  };
}

export function DocumentVersionPreview({
  client,
  document,
  knownVersion,
}: {
  client: TeamHubClient;
  document: TeamHubDocument;
  knownVersion?: TeamHubDocumentVersion;
}) {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<LoadedDocumentPreview | null>(null);
  const [downloading, setDownloading] = useState(false);
  const transferRef = useRef<AbortController | null>(null);
  const versionId = document.current_version?.id;
  const previewFilename =
    preview?.version.filename ?? documentFileName(document);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let dispose: () => void = () => undefined;
    transferRef.current = controller;
    setError(null);
    setPreview(null);

    if (!versionId && document.representation_format !== "html") {
      setError("This Document has no published Version.");
      transferRef.current = null;
      return () => controller.abort();
    }

    function handleLoaded(loaded: LoadedDocumentPreview) {
      if (!active) {
        loaded.dispose?.();
        if (!loaded.dispose && loaded.objectUrl)
          URL.revokeObjectURL(loaded.objectUrl);
        return;
      }
      dispose = () => {
        loaded.dispose?.();
        if (!loaded.dispose && loaded.objectUrl)
          URL.revokeObjectURL(loaded.objectUrl);
      };
      setPreview(loaded);
      if (transferRef.current === controller) transferRef.current = null;
    }

    function handleLoadError(loadError: unknown) {
      if (active && !controller.signal.aborted) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Document preview could not be loaded.",
        );
      }
      if (transferRef.current === controller) transferRef.current = null;
    }

    void (async () => {
      try {
        handleLoaded(
          await loadDocumentPreview(
            client,
            document.id,
            versionId,
            knownVersion,
            controller.signal,
          ),
        );
      } catch (loadError) {
        handleLoadError(loadError);
      }
    })();

    return () => {
      active = false;
      controller.abort();
      if (transferRef.current === controller) transferRef.current = null;
      dispose();
    };
  }, [
    attempt,
    client,
    document.id,
    document.representation_format,
    knownVersion,
    versionId,
  ]);

  async function download() {
    const downloadVersionId = preview?.version.id ?? versionId;
    if ((!downloadVersionId && !preview?.blob) || downloading) return;
    const controller = new AbortController();
    transferRef.current = controller;
    setDownloading(true);
    setError(null);
    try {
      const content = await client.downloadLatestDocument(document.id, {
        signal: controller.signal,
      });
      triggerArtifactDownload(content.blob, previewFilename);
    } catch (downloadError) {
      if (!controller.signal.aborted) {
        setError(
          downloadError instanceof Error
            ? downloadError.message
            : "Document download failed.",
        );
      }
    } finally {
      if (transferRef.current === controller) transferRef.current = null;
      setDownloading(false);
    }
  }

  if (error) {
    return (
      <div
        className="flex min-h-full items-center justify-center p-6 text-center"
        role="alert"
      >
        <div className="max-w-md">
          <Icon
            icon={Alert02Icon}
            size={20}
            className="mx-auto text-app-danger"
          />
          <p className="mt-3 text-sm text-app-danger">{error}</p>
          <div className="mt-4 flex justify-center gap-2">
            {versionId ? (
              <Button
                onClick={() => setAttempt((value) => value + 1)}
                tone="secondary"
              >
                <Icon icon={RefreshIcon} size={14} /> Retry preview
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
  if (!preview) {
    return (
      <div
        className="flex min-h-full items-center justify-center gap-2 text-sm text-app-muted"
        role="status"
      >
        <Spinner size={16} /> Loading preview…
      </div>
    );
  }
  if (preview.decision.kind === "download") {
    return (
      <div className="flex min-h-full items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <Icon
            icon={FileNotFoundIcon}
            size={24}
            className="mx-auto text-app-muted"
          />
          <p className="mt-3 text-sm text-app-muted">
            {preview.decision.reason ??
              "Preview is unavailable for this Version."}
          </p>
          <Button
            className="mt-4"
            disabled={downloading}
            onClick={() => void download()}
            tone="secondary"
          >
            {downloading ? (
              <Spinner size={14} />
            ) : (
              <Icon icon={Download04Icon} size={14} />
            )}
            Download
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-document-version-preview>
      <PreviewSessionExpiryNotice
        expiresAt={preview.expiresAt}
        onRefresh={() => setAttempt((value) => value + 1)}
      />
      <ArtifactReadingViewport
        position={
          ["text", "markdown"].includes(preview.decision.kind)
            ? preview.readingPosition
            : undefined
        }
      >
        <ArtifactContentRendererLoader
          blob={preview.blob}
          filename={previewFilename}
          kind={preview.decision.kind}
          mediaType={resolveArtifactPreviewMediaType(
            previewFilename,
            preview.version.media_type,
          )}
          objectUrl={preview.objectUrl}
          onError={setError}
          previewUrl={preview.previewUrl}
          presentation={isKnowledgeDocument(document) ? "knowledge" : "default"}
          sourceSizeBytes={preview.sourceSizeBytes ?? preview.blob?.size}
          readingPosition={preview.readingPosition}
          textContent={preview.textContent}
        />
      </ArtifactReadingViewport>
    </div>
  );
}

function isKnowledgeDocument(document: TeamHubDocument) {
  return document.from.some((source) => source.binding_kind === "wiki_page");
}

async function loadDocumentPreview(
  client: TeamHubClient,
  documentId: string,
  versionId: string | undefined,
  knownVersion: TeamHubDocumentVersion | undefined,
  signal: AbortSignal,
): Promise<LoadedDocumentPreview> {
  if (!versionId) {
    // A native HTML Document shows its latest HTML snapshot, the same bytes
    // Download returns.
    const content = await client.downloadLatestDocument(documentId, {
      signal,
    });
    const objectUrl = URL.createObjectURL(content.blob);
    return {
      blob: content.blob,
      objectUrl,
      previewUrl: objectUrl,
      decision: { kind: "html" },
      version: {
        media_type: content.mediaType,
      },
    };
  }
  return loadArtifactPreview({
    client,
    documentId,
    knownVersion,
    versionId,
    signal,
  });
}
