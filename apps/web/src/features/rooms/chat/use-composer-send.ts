import type { VoiceDocumentSelection } from "../room-drafts";
import type {
  MessageComposerProps,
  MessageComposition,
} from "./message-composer";
import { formatMentionToken } from "./message-mentions";
import type { ComposerAttachments } from "./use-composer-attachments";
import {
  type ComposerDraft,
  messageLengthError,
  TEAMHUB_MESSAGE_MAX_LENGTH,
} from "./use-composer-draft";
import type { ComposerPicker } from "./use-composer-picker";
import type { ComposerVoiceState } from "./use-composer-voice";
import { withVoiceMaterials } from "./voice-mode/voice-material-composition";
import type { VoiceModeTarget } from "./voice-mode/voice-mode-controls";

export interface ComposerSendInput {
  attachments: ComposerAttachments;
  disabled: boolean;
  draft: ComposerDraft;
  onSend: (composition: MessageComposition) => Promise<void> | void;
  onStageAttachment?: MessageComposerProps["onStageAttachment"];
  picker: ComposerPicker;
  resolveDocumentLink?: MessageComposerProps["resolveDocumentLink"];
  voice: ComposerVoiceState;
  voiceModeTarget?: VoiceModeTarget;
}

/** Commits the written draft, its files, and selected voice materials. */
export function useComposerSend({
  attachments: {
    attachmentIntentKeyRef,
    selectedFiles,
    setAttachmentError,
    updateSelectedFiles,
  },
  disabled,
  draft: {
    body,
    documentContexts,
    resolveReferences,
    resolvingDocumentLinksRef,
    selectedDocumentsRef,
    selectedMentionsRef,
    selectedSkillsRef,
    setDocumentContexts,
    setMessageError,
    setSubmitting,
    submitting,
    updateBody,
  },
  onSend,
  onStageAttachment,
  picker: { applyMentionQuery, setSkillQuery },
  resolveDocumentLink,
  voice: { voiceMaterials, voiceMode },
  voiceModeTarget,
}: ComposerSendInput) {
  async function send() {
    const normalized = body.trim();

    if (normalized.length > TEAMHUB_MESSAGE_MAX_LENGTH) {
      setMessageError(messageLengthError());
      return;
    }

    if (resolvingDocumentLinksRef.current > 0) {
      setMessageError("Document link is still loading.");
      return;
    }

    if (
      disabled ||
      submitting ||
      voiceMode.entered ||
      selectedFiles.some((attachment) => attachment.status !== "ready") ||
      (!normalized &&
        selectedFiles.length === 0 &&
        documentContexts.length === 0)
    ) {
      return;
    }

    const {
      documentReferences,
      mentions,
      pendingAvailability,
      skillReferences,
    } = resolveReferences(normalized);
    if (pendingAvailability) {
      setMessageError("Message references are still loading. Try again.");
      return;
    }

    setSubmitting(true);
    const committedAttachments = selectedFiles;
    const attachmentIdempotencyKey = attachmentIntentKeyRef.current;
    const committedDocumentContexts = documentContexts;
    try {
      const value: MessageComposition = {
        ...(attachmentIdempotencyKey && onStageAttachment
          ? {
              attachmentIdempotencyKey,
              attachmentInputs: committedAttachments.map(
                ({ clientId, file }) => ({ clientId, file }),
              ),
            }
          : {}),
        ...(committedDocumentContexts.length
          ? { documentContexts: committedDocumentContexts }
          : {}),
        body: normalized,
        files: committedAttachments.map((attachment) => attachment.file),
        mentions,
        ...(documentReferences.length
          ? {
              documentReferences: documentReferences.map(
                ({ documentId, token }) => ({
                  documentId,
                  token,
                }),
              ),
            }
          : {}),
        ...(skillReferences.length ? { skillReferences } : {}),
      };
      const materials =
        voiceMaterials?.materials.map((item) => ({ ...item })) ?? [];
      if (materials.length) await authorizeVoiceMaterials(materials);
      const result = onSend(
        withVoiceMaterials(value, materials, reservedVoiceTokens()),
      );
      if (result) await result;
      // Selected material belongs to the one message it was sent with.
      for (const material of materials) voiceMaterials?.remove(material.id);
      setDocumentContexts([]);
      updateBody("", []);
      setAttachmentError(null);
      setMessageError(null);
      updateSelectedFiles(() => []);
      attachmentIntentKeyRef.current = undefined;
      applyMentionQuery(null);
      setSkillQuery(null);
      selectedMentionsRef.current = [];
      selectedDocumentsRef.current = [];
      selectedSkillsRef.current = [];
    } catch (error) {
      setDocumentContexts(committedDocumentContexts);
      selectedMentionsRef.current = mentions;
      selectedDocumentsRef.current = documentReferences;
      selectedSkillsRef.current = skillReferences;
      updateBody(normalized, committedDocumentContexts);
      setMessageError(
        error instanceof Error ? error.message : "Message could not be sent",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function authorizeVoiceMaterials(
    materials: readonly VoiceDocumentSelection[],
  ) {
    // Message excerpts come from this Room and need no Document grant.
    const ids = [
      ...new Set(
        materials.flatMap((item) => (item.documentId ? [item.documentId] : [])),
      ),
    ];
    if (!ids.length) return;
    if (!voiceModeTarget || !resolveDocumentLink)
      throw new Error(
        "Document references are unavailable in this conversation.",
      );
    await Promise.all(
      ids.map((documentId) =>
        resolveDocumentLink({
          documentId,
          tenantId: voiceModeTarget.tenantId,
          bindToRoom: true,
        }),
      ),
    );
  }

  function reservedVoiceTokens() {
    return voiceModeTarget?.recipient
      ? [formatMentionToken(voiceModeTarget.recipient)]
      : [];
  }

  return { authorizeVoiceMaterials, reservedVoiceTokens, send };
}

export type ComposerSend = ReturnType<typeof useComposerSend>;
