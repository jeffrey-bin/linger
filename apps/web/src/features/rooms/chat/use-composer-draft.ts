import { useId, useRef, useState } from "react";

import type { TeamHubMessageSkillReference } from "@/features/teamhub/teamhub-message-content";
import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import type {
  RoomComposerDocumentContext,
  RoomComposerDocumentReference,
} from "../room-drafts";
import type { MessageComposerDraft } from "./message-composer";
import {
  activeDocumentReferences,
  activeSkillReferences,
  type MessageDocumentOption,
  type MessageSkillOption,
} from "./message-composer-references";
import { activeMessageMentions, formatMentionToken } from "./message-mentions";
import type { ComposerVoiceState } from "./use-composer-voice";

export const TEAMHUB_MESSAGE_MAX_LENGTH = 50_000;

export interface ComposerDraftInput {
  agentOptionsReady?: boolean;
  catalogDocumentOptions: MessageDocumentOption[];
  documentOptionsReady?: boolean;
  initialDocumentContexts: RoomComposerDocumentContext[];
  initialDocumentReferences: RoomComposerDocumentReference[];
  initialMentions: TeamHubActorRef[];
  initialSkillReferences: TeamHubMessageSkillReference[];
  initialValue: string;
  mentionOptions: TeamHubActorRef[];
  onDraftStateChange?: (draft: MessageComposerDraft) => void;
  skillOptions: MessageSkillOption[];
  voice: ComposerVoiceState;
}

/**
 * Owns the draft text, its structured references, the editor refs, and the
 * submission flags every other composer hook reads.
 */
export function useComposerDraft({
  agentOptionsReady,
  catalogDocumentOptions,
  documentOptionsReady,
  initialDocumentContexts,
  initialDocumentReferences,
  initialMentions,
  initialSkillReferences,
  initialValue,
  mentionOptions,
  onDraftStateChange,
  skillOptions,
  voice: { voiceMaterials, voiceMode, voicePrefixRef },
}: ComposerDraftInput) {
  const [body, setBody] = useState(initialValue);
  const bodyRef = useRef(initialValue);
  const visibleBody = voiceMode.entered ? voicePrefixRef.current : body;
  const [resolvedDocumentOptions, setResolvedDocumentOptions] = useState<
    MessageDocumentOption[]
  >([]);
  const documentOptions = [
    ...catalogDocumentOptions,
    ...resolvedDocumentOptions.filter(
      (resolved) =>
        !catalogDocumentOptions.some(
          (catalog) => catalog.documentId === resolved.documentId,
        ),
    ),
  ];
  const [documentContexts, setDocumentContexts] = useState(
    initialDocumentContexts,
  );
  const lengthStatusId = useId();
  const isComposing = useRef(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [resolvingDocumentLinks, setResolvingDocumentLinks] = useState(0);
  const resolvingDocumentLinksRef = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  const selectedMentionsRef = useLazyRef(() =>
    activeMessageMentions(initialValue, initialMentions),
  );
  const selectedDocumentsRef = useLazyRef(() =>
    activeDocumentReferences(initialValue, initialDocumentReferences),
  );
  const selectedSkillsRef = useLazyRef(() =>
    activeSkillReferences(
      initialValue,
      initialSkillReferences,
      selectedMentionsRef.current,
    ),
  );
  const highlightContentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const currentReferences = resolveReferences(body);

  function updateBody(
    nextBody: string,
    nextDocumentContexts = documentContexts,
    nextDocumentOptions = documentOptions,
  ) {
    bodyRef.current = nextBody;
    setBody(nextBody);
    setMessageError(
      nextBody.length > TEAMHUB_MESSAGE_MAX_LENGTH
        ? messageLengthError()
        : null,
    );
    const { documentReferences, mentions, skillReferences } = resolveReferences(
      nextBody,
      nextDocumentOptions,
    );
    selectedMentionsRef.current = mentions;
    selectedDocumentsRef.current = documentReferences;
    selectedSkillsRef.current = skillReferences;
    onDraftStateChange?.({
      ...(voiceMaterials?.materials.length
        ? { voiceMaterials: voiceMaterials.materials }
        : {}),
      documentContexts: nextDocumentContexts,
      body: nextBody,
      documentReferences,
      mentions,
      skillReferences,
    });
  }

  function resolveReferences(
    nextBody: string,
    nextDocumentOptions = documentOptions,
  ) {
    return resolveAvailableComposerReferences({
      body: nextBody,
      agentOptionsReady,
      documentOptions: nextDocumentOptions,
      documentOptionsReady,
      documentReferences: selectedDocumentsRef.current,
      mentionOptions,
      mentions: selectedMentionsRef.current,
      skillOptions,
      skillReferences: selectedSkillsRef.current,
    });
  }

  return {
    body,
    bodyRef,
    currentReferences,
    documentContexts,
    documentOptions,
    highlightContentRef,
    isComposing,
    lengthStatusId,
    messageError,
    pendingCaretRef,
    resolveReferences,
    resolvingDocumentLinks,
    resolvingDocumentLinksRef,
    selectedDocumentsRef,
    selectedMentionsRef,
    selectedSkillsRef,
    setDocumentContexts,
    setMessageError,
    setResolvedDocumentOptions,
    setResolvingDocumentLinks,
    setSubmitting,
    submitting,
    textareaRef,
    updateBody,
    visibleBody,
  };
}

export type ComposerDraft = ReturnType<typeof useComposerDraft>;

export type ComposerReferences = ReturnType<
  typeof resolveAvailableComposerReferences
>;

export function messageLengthError() {
  return `Message must be ${TEAMHUB_MESSAGE_MAX_LENGTH.toLocaleString()} characters or fewer.`;
}

export function findDocumentOption(
  reference: RoomComposerDocumentReference,
  documentOptions: MessageDocumentOption[],
) {
  return documentOptions.find(
    (option) => option.documentId === reference.documentId,
  );
}

function useLazyRef<T>(initialize: () => T) {
  // A state initializer runs exactly once without mutating a ref during render,
  // which keeps the deferred construction this hook exists for.
  const [ref] = useState(() => ({ current: initialize() }));
  return ref;
}

function resolveAvailableComposerReferences({
  agentOptionsReady,
  body,
  documentOptions,
  documentOptionsReady,
  documentReferences,
  mentionOptions,
  mentions,
  skillOptions,
  skillReferences,
}: {
  agentOptionsReady?: boolean;
  body: string;
  documentOptions: MessageDocumentOption[];
  documentOptionsReady?: boolean;
  documentReferences: RoomComposerDocumentReference[];
  mentionOptions: TeamHubActorRef[];
  mentions: TeamHubActorRef[];
  skillOptions: MessageSkillOption[];
  skillReferences: TeamHubMessageSkillReference[];
}) {
  let pendingAvailability = false;
  const activeMentions = activeMessageMentions(body, mentions);
  const availableMentions = activeMentions.flatMap((mention) => {
    const current = mentionOptions.find(
      (option) =>
        option.id === mention.id &&
        option.tenant_id === mention.tenant_id &&
        formatMentionToken(option) === formatMentionToken(mention),
    );
    if (current) return [current];
    if (agentOptionsReady === false) pendingAvailability = true;
    return agentOptionsReady === true ? [] : [mention];
  });

  const activeDocuments = activeDocumentReferences(body, documentReferences);
  const availableDocuments = activeDocuments.filter((reference) => {
    if (findDocumentOption(reference, documentOptions)) return true;
    if (documentOptionsReady === false) pendingAvailability = true;
    return documentOptionsReady !== true;
  });

  const activeSkills = activeSkillReferences(
    body,
    skillReferences,
    availableMentions,
  );
  const availableSkills = activeSkills.filter((reference) => {
    const current = skillOptions.some(
      (option) =>
        option.agent.id === reference.target &&
        option.manifestVersion === reference.manifestVersion &&
        option.skillId === reference.skillId,
    );
    if (current) return true;
    if (agentOptionsReady === false) pendingAvailability = true;
    return agentOptionsReady !== true;
  });

  return {
    documentReferences: availableDocuments,
    mentions: availableMentions,
    pendingAvailability,
    skillReferences: availableSkills,
  };
}
