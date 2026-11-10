import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { TeamHubVoiceLiveTurnMarker } from "@/features/teamhub/teamhub-types";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import type { MessageComposition } from "./message-composer";
import { formatMentionToken } from "./message-mentions";
import {
  type ComposerDraft,
  type ComposerReferences,
  messageLengthError,
  TEAMHUB_MESSAGE_MAX_LENGTH,
} from "./use-composer-draft";
import type { ComposerSend } from "./use-composer-send";
import { useOptionalVoiceMaterials } from "./voice-mode/voice-materials-context";
import {
  isReferenceOnlyDraft,
  withVoiceMaterials,
} from "./voice-mode/voice-material-composition";
import type {
  VoiceModePresentation,
  VoiceModeTarget,
} from "./voice-mode/voice-mode-controls";
import { useOptionalVoiceModeSession } from "./voice-mode/voice-mode-session";
import { voiceTurnIdempotencyKey } from "./voice-mode/voice-turn-key";

/** Voice Mode presentation, the shared session, and this Room's materials. */
export function useComposerVoiceState(
  voiceModeTarget: VoiceModeTarget | undefined,
) {
  const [voiceMode, setVoiceMode] = useState<VoiceModePresentation>({
    entered: false,
    text: "",
  });
  const voiceSession = useOptionalVoiceModeSession();
  const materialContext = useOptionalVoiceMaterials();
  // Materials collected for a Voice Mode session in another Room stay there.
  const voiceMaterials =
    voiceModeTarget && materialContext?.roomId === voiceModeTarget.roomId
      ? materialContext
      : undefined;
  const claimedMaterialIds = useRef(new Set<string>());
  useEffect(() => {
    voiceMaterials?.setVoiceModeEntered(voiceMode.entered);
  }, [voiceMaterials, voiceMode.entered]);
  const voicePrefixRef = useRef("");
  const voicePrefixReferencesRef = useRef<ComposerReferences | undefined>(
    undefined,
  );
  const voiceModeSourceRef = useRef<string | undefined>(undefined);
  return {
    claimedMaterialIds,
    setVoiceMode,
    voiceMaterials,
    voiceMode,
    voiceModeSourceRef,
    voicePrefixRef,
    voicePrefixReferencesRef,
    voiceSession,
  };
}

export type ComposerVoiceState = ReturnType<typeof useComposerVoiceState>;

export interface ComposerVoiceTurnInput {
  draft: ComposerDraft;
  isVoiceDraftCurrent?: (expectedText: string) => boolean;
  onSend: (composition: MessageComposition) => Promise<void> | void;
  onVoiceModePresentation?: (presentation: VoiceModePresentation) => void;
  selectedContextMessages: TeamHubMessage[];
  selectedFileCount: number;
  sending: ComposerSend;
  voice: ComposerVoiceState;
  voiceModeTarget?: VoiceModeTarget;
}

/**
 * Turns voice transcripts into the draft and sends accepted turns, and binds
 * this composer to the shared Voice Mode session for its Room.
 */
export function useComposerVoiceTurn({
  draft: {
    body,
    bodyRef,
    currentReferences,
    documentContexts,
    resolveReferences,
    resolvingDocumentLinks,
    textareaRef,
    updateBody,
  },
  isVoiceDraftCurrent,
  onSend,
  onVoiceModePresentation,
  selectedContextMessages,
  selectedFileCount,
  sending: { authorizeVoiceMaterials, reservedVoiceTokens },
  voice: {
    claimedMaterialIds,
    setVoiceMode,
    voiceMaterials,
    voiceMode,
    voiceModeSourceRef,
    voicePrefixRef,
    voicePrefixReferencesRef,
    voiceSession,
  },
  voiceModeTarget,
}: ComposerVoiceTurnInput) {
  function prepareVoiceTurn(text: string, eventId: string) {
    const prefix = voicePrefixRef.current;
    const references =
      voicePrefixReferencesRef.current ?? resolveReferences(prefix);
    // The accepted turn owns the selected material: later turns skip it,
    // and it is removed once this message is sent (kept for retry on failure).
    const materials =
      voiceMaterials?.materials
        .filter((item) => !claimedMaterialIds.current.has(item.id))
        .map((item) => ({ ...item })) ?? [];
    for (const material of materials)
      claimedMaterialIds.current.add(material.id);
    const reservedTokens = reservedVoiceTokens();
    const value: MessageComposition = {
      body: [prefix, text].filter(Boolean).join("\n"),
      files: [],
      mentions: [...references.mentions],
      documentReferences: references.documentReferences.map((item) => ({
        ...item,
      })),
      documentContexts: documentContexts.map((item) => ({ ...item })),
      contextMessages: [...selectedContextMessages],
    };
    let snapshot: MessageComposition | undefined;
    return async (voiceLiveTurn?: TeamHubVoiceLiveTurnMarker) => {
      if (references.pendingAvailability)
        throw new Error(
          "Message references are still loading. Exit to review the draft.",
        );
      try {
        snapshot ??= withVoiceMaterials(
          {
            ...value,
            voiceLiveTurn,
            messageIdempotencyKey: voiceTurnIdempotencyKey(eventId),
          },
          materials,
          reservedTokens,
        );
        if (snapshot.body.length > TEAMHUB_MESSAGE_MAX_LENGTH)
          throw new Error(messageLengthError());
        await authorizeVoiceMaterials(materials);
        await onSend(snapshot);
      } catch (error) {
        for (const material of materials)
          claimedMaterialIds.current.delete(material.id);
        throw error;
      }
      for (const material of materials) {
        claimedMaterialIds.current.delete(material.id);
        voiceMaterials?.remove(material.id);
      }
    };
  }

  function updateVoiceMode(next: VoiceModePresentation) {
    if (
      next.entered &&
      !voiceMode.entered &&
      next.sourceId !== voiceModeSourceRef.current
    ) {
      voicePrefixRef.current = next.prefix ?? bodyRef.current.trim();
      // Keep chosen IDs even if a later catalog refresh removes an item.
      // TeamHub must reject lost access, not receive only an unbound label.
      voicePrefixReferencesRef.current = resolveReferences(
        voicePrefixRef.current,
      );
    }
    const prefix = voicePrefixRef.current;
    const nextBody = [prefix, next.text].filter(Boolean).join("\n");
    const expectedBody =
      next.expectedText === undefined
        ? undefined
        : [prefix, next.expectedText].filter(Boolean).join("\n");
    if (
      expectedBody !== undefined &&
      (voiceModeSourceRef.current !== next.sourceId ||
        bodyRef.current !== expectedBody ||
        isVoiceDraftCurrent?.(expectedBody) === false)
    )
      return;
    if (next.entered) voiceModeSourceRef.current = next.sourceId;
    setVoiceMode(next);
    onVoiceModePresentation?.(next);
    // Keep the transcript in the draft for delivery. While Voice Mode is
    // active, the timeline's live draft bubble is its single visible copy.
    updateBody(nextBody);
    if (!next.entered && next.expectedText === undefined)
      textareaRef.current?.focus();
  }

  const voiceBinding = useRef({ prepareVoiceTurn, updateVoiceMode });
  useLayoutEffect(() => {
    voiceBinding.current = { prepareVoiceTurn, updateVoiceMode };
  });
  const bindVoiceSession = voiceSession?.bind;
  const voiceRoomId = voiceModeTarget?.roomId;
  // Bind only by Room identity; the ref carries the latest callbacks.
  useEffect(() => {
    if (!bindVoiceSession || !voiceRoomId) return;
    return bindVoiceSession(voiceRoomId, {
      onChange: (next) => voiceBinding.current.updateVoiceMode(next),
      prepareSend: (text, eventId) =>
        voiceBinding.current.prepareVoiceTurn(text, eventId),
    });
  }, [bindVoiceSession, voiceRoomId]);

  return {
    updateVoiceMode,
    prepareVoiceTurn,
    voiceModeEmpty:
      isReferenceOnlyDraft(body, [
        ...currentReferences.documentReferences.map((ref) => ref.token),
        ...currentReferences.mentions.map(formatMentionToken),
      ]) &&
      !selectedFileCount &&
      !currentReferences.skillReferences.length &&
      resolvingDocumentLinks === 0,
    voiceHasMaterials: Boolean(
      voiceMaterials?.materials.length ||
      selectedContextMessages.length ||
      documentContexts.length ||
      currentReferences.documentReferences.length ||
      currentReferences.mentions.length,
    ),
    /**
     * Only selected voice materials stack a row above the editor. Mentions and
     * Document references stay inline in the text, so they keep the single row.
     */
    voiceMaterialRows: Boolean(
      voiceMaterials?.materials.length || voiceMaterials?.error,
    ),
    /**
     * Addressing someone starts a written message, so the draft is no longer the
     * empty Composer that Voice Mode replaces. A Document reference is material
     * rather than composition, and still leads into Voice Mode.
     */
    draftHasMentions: Boolean(currentReferences.mentions.length),
    /** Voice Mode keeps running for this Room while the Human was elsewhere. */
    voiceSessionActiveHere: Boolean(
      voiceModeTarget &&
      voiceSession?.session?.target.roomId === voiceModeTarget.roomId,
    ),
    voicePrefix: {
      body: body.trim(),
      documentReferences: currentReferences.documentReferences.map((item) => ({
        ...item,
      })),
      mentions: [...currentReferences.mentions],
    },
  };
}
