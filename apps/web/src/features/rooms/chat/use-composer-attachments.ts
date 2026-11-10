import {
  type ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { createTeamHubIdempotencyKey } from "@/features/teamhub/teamhub-client";
import {
  type ComposerAttachment,
  composerAttachmentStore,
} from "./composer-attachment-drafts";
import type { MessageComposerProps } from "./message-composer";
import { decodeLocalImage } from "@/features/rooms/files/local-message-images";

const maximumAttachmentCount = 5;

export interface ComposerAttachmentsInput {
  attachmentDraftKey?: string;
  attachmentEnabled: boolean;
  disabled: boolean;
  onCancelAttachment?: MessageComposerProps["onCancelAttachment"];
  onStageAttachment?: MessageComposerProps["onStageAttachment"];
  submitting: boolean;
  voiceModeEntered: boolean;
}

/** Selected files, their staged uploads, and the attachment intent key. */
export function useComposerAttachments({
  attachmentDraftKey,
  attachmentEnabled,
  disabled,
  onCancelAttachment,
  onStageAttachment,
  submitting,
  voiceModeEntered,
}: ComposerAttachmentsInput) {
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attachmentStore = useMemo(
    () => composerAttachmentStore(attachmentDraftKey),
    [attachmentDraftKey],
  );
  const selectedFiles = useSyncExternalStore(
    attachmentStore.subscribe,
    attachmentStore.snapshot,
  );
  const selectedFilesRef = attachmentStore.attachments;
  const attachmentIntentKeyRef = attachmentStore.idempotencyKey;
  const attachmentAbortControllersRef = attachmentStore.controllers;
  const cancelAttachmentRef = useRef(onCancelAttachment);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    cancelAttachmentRef.current = onCancelAttachment;
  }, [onCancelAttachment]);

  useEffect(
    () => () => {
      // A keyed draft keeps uploading after unmount and reappears on return.
      if (!attachmentStore.private) return;
      for (const controller of attachmentStore.controllers.current.values()) {
        controller.abort();
      }
      const idempotencyKey = attachmentStore.idempotencyKey.current;
      if (!idempotencyKey) return;
      for (const attachment of attachmentStore.attachments.current) {
        void cancelAttachmentRef.current?.({
          attachmentClientId: attachment.clientId,
          idempotencyKey,
        });
      }
    },
    [attachmentStore],
  );

  function updateSelectedFiles(
    update: (current: ComposerAttachment[]) => ComposerAttachment[],
  ) {
    attachmentStore.set(update(attachmentStore.attachments.current));
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function canAcceptFiles() {
    return attachmentEnabled && !disabled && !submitting && !voiceModeEntered;
  }

  function addFiles(files: File[]) {
    if (!canAcceptFiles() || files.length === 0) return false;

    const currentAttachments = selectedFilesRef.current;
    const result = validateMessageAttachments([
      ...currentAttachments.map((attachment) => attachment.file),
      ...files,
    ]);
    if (result.error) {
      setAttachmentError(result.error);
      return false;
    }

    setAttachmentError(null);
    const addedFiles = result.files.slice(currentAttachments.length);
    const idempotencyKey =
      attachmentIntentKeyRef.current ?? createTeamHubIdempotencyKey();
    attachmentIntentKeyRef.current = idempotencyKey;
    const addedAttachments = addedFiles.map((file) => ({
      clientId: createTeamHubIdempotencyKey(),
      file,
      progress: onStageAttachment ? 0 : 1,
      status: onStageAttachment ? ("uploading" as const) : ("ready" as const),
    }));
    updateSelectedFiles((current) => [...current, ...addedAttachments]);
    for (const attachment of addedAttachments) {
      // Decoded now, so the sent image shows at its size from its first frame.
      if (attachment.file.type.startsWith("image/"))
        void decodeLocalImage(attachment.file);
      if (onStageAttachment) {
        void stageSelectedAttachment(attachment, idempotencyKey);
      }
    }
    return true;
  }

  async function stageSelectedAttachment(
    attachment: ComposerAttachment,
    idempotencyKey: string,
  ) {
    if (!onStageAttachment) return;
    const controller = new AbortController();
    attachmentAbortControllersRef.current.set(attachment.clientId, controller);
    updateSelectedFiles((current) =>
      current.map((candidate) =>
        candidate.clientId === attachment.clientId
          ? { ...candidate, error: undefined, progress: 0, status: "uploading" }
          : candidate,
      ),
    );
    try {
      await onStageAttachment({
        attachment: {
          clientId: attachment.clientId,
          file: attachment.file,
        },
        idempotencyKey,
        onProgress: (progress) =>
          updateSelectedFiles((current) =>
            current.map((candidate) =>
              candidate.clientId === attachment.clientId
                ? { ...candidate, progress }
                : candidate,
            ),
          ),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      updateSelectedFiles((current) =>
        current.map((candidate) =>
          candidate.clientId === attachment.clientId
            ? { ...candidate, progress: 1, status: "ready" }
            : candidate,
        ),
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      updateSelectedFiles((current) =>
        current.map((candidate) =>
          candidate.clientId === attachment.clientId
            ? {
                ...candidate,
                error:
                  error instanceof Error ? error.message : "Upload failed.",
                status: "failed",
              }
            : candidate,
        ),
      );
    } finally {
      if (
        attachmentAbortControllersRef.current.get(attachment.clientId) ===
        controller
      ) {
        attachmentAbortControllersRef.current.delete(attachment.clientId);
      }
    }
  }

  function retryAttachment(attachment: ComposerAttachment) {
    const idempotencyKey = attachmentIntentKeyRef.current;
    if (!idempotencyKey || attachment.status !== "failed") return;
    void stageSelectedAttachment(attachment, idempotencyKey);
  }

  function removeAttachment(attachment: ComposerAttachment) {
    const idempotencyKey = attachmentIntentKeyRef.current;
    attachmentAbortControllersRef.current.get(attachment.clientId)?.abort();
    attachmentAbortControllersRef.current.delete(attachment.clientId);
    const next = selectedFilesRef.current.filter(
      (candidate) => candidate.clientId !== attachment.clientId,
    );
    if (next.length === 0) attachmentIntentKeyRef.current = undefined;
    updateSelectedFiles(() => next);
    if (!idempotencyKey) return;
    void onCancelAttachment?.({
      attachmentClientId: attachment.clientId,
      idempotencyKey,
    }).catch((error) =>
      setAttachmentError(
        error instanceof Error
          ? `Attachment cleanup failed: ${error.message}`
          : "Attachment cleanup failed.",
      ),
    );
  }

  return {
    addFiles,
    attachmentError,
    attachmentIntentKeyRef,
    canAcceptFiles,
    fileInputRef,
    handleFiles,
    removeAttachment,
    retryAttachment,
    selectedFiles,
    setAttachmentError,
    updateSelectedFiles,
  };
}

export type ComposerAttachments = ReturnType<typeof useComposerAttachments>;

export function filesFromClipboard(clipboardData: DataTransfer): File[] {
  const directFiles = Array.from(clipboardData.files ?? []);
  const files =
    directFiles.length > 0
      ? directFiles
      : Array.from(clipboardData.items ?? []).flatMap((item) => {
          if (item.kind !== "file") return [];
          const file = item.getAsFile();
          return file ? [file] : [];
        });

  return files.map((file, index) => {
    if (file.name.trim()) return file;
    const kind = file.type.split("/", 1)[0] || "file";
    const extension = clipboardExtension(file.type);
    const suffix = files.length > 1 ? `-${index + 1}` : "";
    return new File([file], `pasted-${kind}${suffix}${extension}`, {
      lastModified: file.lastModified,
      type: file.type,
    });
  });
}

function validateMessageAttachments(files: File[]) {
  if (files.length > maximumAttachmentCount) {
    return {
      error: `Attach up to ${maximumAttachmentCount} files at a time.`,
      files: [],
    };
  }

  return { error: null, files };
}

function clipboardExtension(mediaType: string) {
  const extensions: Record<string, string> = {
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
  };
  return extensions[mediaType] ?? "";
}
