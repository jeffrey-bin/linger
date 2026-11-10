import { useEffect, useRef, useState, type ReactNode } from "react";

import { FileTypeIcon } from "@/features/library/workspace-file-icon";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { loadArtifactPreview } from "./artifact-preview-loader";
import {
  chatImageSize,
  localMessageImage,
  useDecodedImage,
} from "./local-message-images";
import {
  resolveArtifactPreviewMediaType,
  selectArtifactRenderer,
} from "./artifact-renderer-policy";
import {
  artifactFileTypeLabel,
  type ArtifactFileKind,
} from "./artifact-file-kind";
import { fileItemDetail, MessageFileItem } from "./message-file-item";
import { FileVoiceMaterialButton } from "../chat/voice-mode/file-voice-material-button";

/**
 * A Document-backed file in a Message. An image shows itself in the chat
 * and a video plays there; any other file, or media that cannot load, is a
 * MessageFileItem whose media type decides whether it previews or opens.
 */
export function MessageFileAttachment({
  actionLabel,
  disabled = false,
  documentId,
  filename,
  iconKind,
  mediaType,
  onOpen,
  onOpenImage,
  previewEnabled = true,
  sizeBytes,
  sourceFilename = filename,
  typeLabel,
  versionId,
}: {
  /** Overrides the action the media type picks. */
  actionLabel?: "Open" | "Preview";
  disabled?: boolean;
  documentId?: string;
  /** The name people see, such as a Document's current title. */
  filename: string;
  iconKind?: ArtifactFileKind;
  mediaType?: string;
  onOpen: () => void;
  onOpenImage?: () => void;
  previewEnabled?: boolean;
  sizeBytes?: number;
  /** The stored file name, which with the media type decides previewability. */
  sourceFilename?: string;
  typeLabel?: string;
  versionId?: string;
}) {
  const renderer = selectArtifactRenderer({
    filename: sourceFilename,
    mediaType: mediaType ?? "",
    sizeBytes: sizeBytes ?? 0,
  }).kind;
  const canOpen = previewEnabled && !disabled;
  const image =
    canOpen && documentId && versionId && renderer === "image"
      ? { documentId, versionId }
      : undefined;
  const video =
    canOpen &&
    versionId &&
    renderer === "media" &&
    resolveArtifactPreviewMediaType(sourceFilename, mediaType ?? "").startsWith(
      "video/",
    )
      ? versionId
      : undefined;
  const icon = (
    <FileTypeIcon
      filename={sourceFilename}
      kind={iconKind}
      mediaType={mediaType}
    />
  );
  const item = (
    <MessageFileItem
      actionLabel={
        actionLabel ?? (renderer === "download" ? "Open" : "Preview")
      }
      detail={fileItemDetail(
        typeLabel ?? artifactFileTypeLabel(sourceFilename, mediaType),
        sizeBytes,
      )}
      disabled={disabled}
      name={filename}
      onOpen={canOpen ? onOpen : undefined}
      visual={icon}
    />
  );
  return (
    // The hover group is as wide as what it shows, so Add to voice centres
    // under a file item and under a narrower image alike.
    <div className="group/file relative w-fit max-w-full">
      {image ? (
        <MessageImage
          {...image}
          fallback={item}
          filename={filename}
          key={`${image.documentId}:${image.versionId}`}
          onOpen={onOpenImage ?? onOpen}
        />
      ) : video ? (
        <MessageVideo
          fallback={item}
          filename={filename}
          key={video}
          versionId={video}
        />
      ) : (
        item
      )}
      {documentId && !disabled ? (
        <FileVoiceMaterialButton
          documentId={documentId}
          filename={filename}
          versionId={versionId}
        />
      ) : null}
    </div>
  );
}

/**
 * A video played in the chat at the size of an image. It streams from its
 * content URL, so only its metadata loads before someone plays it.
 */
function MessageVideo({
  fallback,
  filename,
  versionId,
}: {
  fallback: ReactNode;
  filename: string;
  versionId: string;
}) {
  const { client } = useTeamHubRuntime();
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let dispose = () => {};
    client.getDocumentVersionContentLocation(versionId).then(
      (location) => {
        if (!active) {
          location.dispose();
          return;
        }
        dispose = location.dispose;
        setUrl(location.url);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
      dispose();
    };
  }, [client, versionId]);

  if (failed) return fallback;
  return (
    <div className="w-fit max-w-[28rem] overflow-hidden rounded-xl bg-black">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user-provided media has no caption track to reference */}
      <video
        aria-label={filename}
        className="block h-auto max-h-[360px] max-w-full"
        controls
        onError={() => setFailed(true)}
        playsInline
        preload="metadata"
        src={url}
      />
    </div>
  );
}

/** An image shown in the chat at a readable size; opening it previews it. */
function MessageImage({
  documentId,
  fallback,
  filename,
  onOpen,
  versionId,
}: {
  documentId: string;
  fallback: ReactNode;
  filename: string;
  onOpen: () => void;
  versionId: string;
}) {
  const { client } = useTeamHubRuntime();
  const container = useRef<HTMLDivElement>(null);
  const local = useDecodedImage(localMessageImage(documentId));
  const [objectUrl, setObjectUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let started = false;
    let dispose = () => {};
    const controller = new AbortController();
    setObjectUrl(undefined);
    setFailed(false);
    if (localMessageImage(documentId)) return;

    async function load() {
      if (started) return;
      started = true;
      try {
        const preview = await loadArtifactPreview({
          client,
          documentId,
          signal: controller.signal,
          versionId,
        });
        if (!active) {
          preview.dispose();
          return;
        }
        if (preview.decision.kind !== "image" || !preview.objectUrl) {
          preview.dispose();
          setFailed(true);
          return;
        }
        dispose = preview.dispose;
        setObjectUrl(preview.objectUrl);
      } catch {
        if (active) setFailed(true);
      }
    }

    // Defer the authenticated Blob transfer until this item approaches the
    // viewport (including scrollable Threads).
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) {
                observer?.disconnect();
                void load();
              }
            },
            { rootMargin: "300px" },
          );
    if (observer && container.current) observer.observe(container.current);
    else void load();

    return () => {
      active = false;
      observer?.disconnect();
      controller.abort();
      dispose();
    };
  }, [client, documentId, versionId]);

  return (
    // Only as wide as the image, so an own Message can align it right.
    <div className="w-fit max-w-full" ref={container}>
      {failed ? (
        fallback
      ) : local || objectUrl ? (
        <button
          aria-label={`Preview ${filename}`}
          className="block w-fit max-w-[28rem] overflow-hidden rounded-xl transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onOpen}
          type="button"
        >
          <img
            alt={filename}
            className="block h-auto max-h-[360px] max-w-full object-contain"
            decoding="async"
            {...(local ? chatImageSize(local) : {})}
            onError={() => setFailed(true)}
            src={local?.url ?? objectUrl}
          />
        </button>
      ) : (
        <div
          aria-label={`Loading ${filename}`}
          className="flex h-40 w-80 max-w-full items-center justify-center rounded-xl bg-app-surface-soft text-sm text-app-muted"
          role="status"
        >
          Loading image...
        </div>
      )}
    </div>
  );
}
