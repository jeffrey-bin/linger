import { Spinner } from "@/components/ui/spinner";
import { lazy, Suspense, useEffect } from "react";

import { ReadOnlyBlockNoteDocumentLoader } from "@/components/read-only-blocknote-document-loader";
import type { ReadOnlyMarkdownPresentation } from "@/components/read-only-markdown-presentation";

import type { ArtifactReadingPosition } from "./artifact-preview-cache";
import type { ArtifactContentRendererProps } from "./artifact-content-renderer";
import type { ArtifactRendererKind } from "./artifact-renderer-policy";
import { DataPreviewAdapterLoader } from "./data-preview-adapter-loader";
import { MediaPreviewAdapterLoader } from "./media-preview-adapter-loader";
import { OfficePreviewAdapterLoader } from "./office-preview-adapter-loader";
import { PdfPreviewAdapterLoader } from "./pdf-preview-adapter-loader";

const ArtifactContentRenderer = lazy(async () => {
  const module = await import("./artifact-content-renderer");
  return { default: module.ArtifactContentRenderer };
});

type ArtifactContentRendererLoaderProps = Omit<
  ArtifactContentRendererProps,
  "kind"
> & {
  blob?: Blob;
  readingPosition?: ArtifactReadingPosition;
  kind: Exclude<ArtifactRendererKind, "download">;
  mediaType?: string;
  onError?: (message: string) => void;
  presentation?: ReadOnlyMarkdownPresentation;
  sourceSizeBytes?: number;
};

export function ArtifactContentRendererLoader({
  kind,
  ...props
}: ArtifactContentRendererLoaderProps) {
  if (kind === "markdown") {
    return (
      <ReadOnlyBlockNoteDocumentLoader
        ariaLabel="Read-only Markdown document"
        assetBaseUrl={props.previewUrl}
        markdown={props.textContent ?? ""}
        presentation={props.presentation}
      />
    );
  }

  if (kind === "office") {
    return props.blob && props.mediaType ? (
      <OfficePreviewAdapterLoader
        blob={props.blob}
        filename={props.filename}
        mediaType={props.mediaType}
        onError={props.onError}
        readingPosition={props.readingPosition}
      />
    ) : (
      <UnavailablePreview label={"Office"} onError={props.onError} />
    );
  }

  if (kind === "pdf") {
    return props.blob ? (
      <PdfPreviewAdapterLoader
        blob={props.blob}
        filename={props.filename}
        onError={props.onError}
        readingPosition={props.readingPosition}
      />
    ) : (
      <UnavailablePreview label={"PDF"} onError={props.onError} />
    );
  }

  if (kind === "csv") {
    return props.blob && props.mediaType ? (
      <DataPreviewAdapterLoader
        blob={props.blob}
        filename={props.filename}
        mediaType={props.mediaType}
        onError={props.onError}
        sourceSizeBytes={props.sourceSizeBytes}
      />
    ) : (
      <UnavailablePreview label={"table"} onError={props.onError} />
    );
  }

  if (kind === "media") {
    return props.objectUrl && props.mediaType ? (
      <MediaPreviewAdapterLoader
        filename={props.filename}
        key={`${props.mediaType}:${props.objectUrl}`}
        mediaType={props.mediaType}
        objectUrl={props.objectUrl}
        onError={props.onError}
        sourceSizeBytes={props.sourceSizeBytes}
      />
    ) : (
      <UnavailablePreview label={"media"} onError={props.onError} />
    );
  }

  return (
    <Suspense
      fallback={
        <div
          className="flex h-full items-center justify-center gap-2 text-sm text-app-subtle"
          role="status"
        >
          <Spinner size={16} />
          Loading renderer...
        </div>
      }
    >
      <ArtifactContentRenderer {...props} kind={kind} />
    </Suspense>
  );
}

/**
 * A renderer whose content never arrived. Rendering nothing here is
 * indistinguishable from a successful preview of an empty file, so say so and
 * report upward: the preview surfaces turn this into their own fallback with
 * Download and Retry.
 */
function UnavailablePreview({
  label,
  onError,
}: {
  label: string;
  onError?: (message: string) => void;
}) {
  const message = `This ${label} preview could not start because its content was unavailable.`;
  useEffect(() => {
    onError?.(message);
  }, [message, onError]);
  return (
    <div
      className="flex h-full min-h-[420px] items-center justify-center bg-app-surface-soft p-8 text-center text-sm text-app-muted"
      role="alert"
    >
      {message}
    </div>
  );
}
