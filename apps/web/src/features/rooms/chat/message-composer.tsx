import type { TeamHubVoiceLiveTurnMarker } from "@/features/teamhub/teamhub-types";
import { dateTimeFormat } from "@/lib/date-format";
import {
  AlertCircleIcon,
  ArrowUp02Icon,
  Cancel01Icon,
  Doc02Icon,
  File01Icon,
  FileAudioIcon,
  FileCodeIcon,
  FileLockedIcon,
  FileSpreadsheetIcon,
  FileVideoIcon,
  FileZipIcon,
  Image01Icon,
  LinkSquare02Icon,
  Loading03Icon,
  MagicWand01Icon,
  Pdf02Icon,
  PlusSignIcon,
  Ppt02Icon,
} from "@hugeicons/core-free-icons";
import {
  type ChangeEvent,
  type ForwardedRef,
  type RefObject,
  type ReactNode,
  forwardRef,
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "@/components/ui/icon";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { markdownPlainText } from "@/features/teamhub/markdown-plain-text";
import {
  findTeamHubMessageTokenMatches,
  teamHubMentionTokenAliases,
} from "@/features/teamhub/teamhub-message-content";
import type { TeamHubCompositionAttachmentInput } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import type {
  TeamHubMessageDocumentReference,
  TeamHubMessageSkillReference,
} from "@/features/teamhub/teamhub-message-content";
import type {
  RoomComposerDocumentContext,
  RoomComposerDocumentReference,
  VoiceDocumentSelection,
} from "../room-drafts";
import type { ComposerAttachment } from "./composer-attachment-drafts";
import { VoiceMaterialsPreview } from "./voice-mode/voice-materials-preview";
import { useVoiceMediaPolicy } from "@/features/rooms/voice-control/use-voice-media-policy";
import type {
  VoiceModePresentation,
  VoiceModeTarget,
} from "./voice-mode/voice-mode-controls";

import {
  useOptionalVoiceModeSession,
  VoiceModeSessionProvider,
} from "./voice-mode/voice-mode-session";

const VoiceModeControls = lazy(async () => ({
  default: (await import("./voice-mode/voice-mode-controls")).VoiceModeControls,
}));

import { ActorAvatar } from "../members/actor-avatar";
import {
  ComposerAgentPeek,
  useComposerPeek,
  type ComposerPeekAgent,
} from "./composer-agent-peek";
import { formatMentionToken } from "./message-mentions";
import {
  formatSkillToken,
  type MessageDocumentOption,
  type MessageSkillOption,
} from "./message-composer-references";
import { useAgentMentionStyle } from "./agent-mention-style";
import { useComposerAttachments } from "./use-composer-attachments";
import { useComposerDocumentPaste } from "./use-composer-document-paste";
import {
  findDocumentOption,
  TEAMHUB_MESSAGE_MAX_LENGTH,
  useComposerDraft,
} from "./use-composer-draft";
import { useComposerKeyDown } from "./use-composer-keydown";
import {
  adjacentMentionTab,
  type AtPickerItem,
  type MentionTab,
  useComposerPicker,
} from "./use-composer-picker";
import { useComposerReferenceInsertion } from "./use-composer-reference-insertion";
import { useComposerSend } from "./use-composer-send";
import {
  syncComposerHighlightScroll,
  useComposerTextarea,
} from "./use-composer-textarea";
import {
  useComposerVoiceState,
  useComposerVoiceTurn,
} from "./use-composer-voice";

const composerDateFormatter = dateTimeFormat({
  day: "numeric",
  month: "short",
});

export interface MessageComposition {
  voiceLiveTurn?: TeamHubVoiceLiveTurnMarker;
  contextMessages?: TeamHubMessage[];
  messageIdempotencyKey?: string;
  attachmentIdempotencyKey?: string;
  attachmentInputs?: TeamHubCompositionAttachmentInput[];
  documentContexts?: RoomComposerDocumentContext[];
  body: string;
  documentReferences?: TeamHubMessageDocumentReference[];
  files: File[];
  mentions: TeamHubActorRef[];
  skillReferences?: TeamHubMessageSkillReference[];
}

export interface MessageComposerDraft {
  voiceMaterials?: VoiceDocumentSelection[];
  documentContexts: RoomComposerDocumentContext[];
  body: string;
  documentReferences: RoomComposerDocumentReference[];
  mentions: TeamHubActorRef[];
  skillReferences: TeamHubMessageSkillReference[];
}

export interface MessageComposerHandle {
  addFiles: (files: File[]) => boolean;
  canAcceptFiles: () => boolean;
  clearCommittedBody: (body: string) => void;
  insertMention: (actor: TeamHubActorRef) => void;
  focus: (options?: FocusOptions) => void;
}

export interface MessageComposerProps {
  voiceModeTarget?: VoiceModeTarget;
  isVoiceDraftCurrent?: (expectedText: string) => boolean;
  ariaLabel?: string;
  agentOptionsReady?: boolean;
  attachmentEnabled?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  documentMentionsEnabled?: boolean;
  documentOptions?: MessageDocumentOption[];
  documentOptionsReady?: boolean;
  initialDocumentReferences?: RoomComposerDocumentReference[];
  initialDocumentContexts?: RoomComposerDocumentContext[];
  initialMentions?: TeamHubActorRef[];
  initialSkillReferences?: TeamHubMessageSkillReference[];
  initialValue?: string;
  mentionOptions?: TeamHubActorRef[];
  onDraftStateChange?: (draft: MessageComposerDraft) => void;
  onVoiceModePresentation?: (presentation: VoiceModePresentation) => void;
  /**
   * Keeps selected attachments and their uploads alive across remounts, so
   * leaving and reopening the Room does not drop them.
   */
  attachmentDraftKey?: string;
  onCancelAttachment?: (input: {
    attachmentClientId: string;
    idempotencyKey: string;
  }) => Promise<void>;
  /** Reports the open Document mention query so the owner can search the catalog. */
  onDocumentQueryChange?: (query: string | null) => void;
  onOpenDocument?: (document: MessageDocumentOption) => void;
  onOpenDocumentContext?: (context: RoomComposerDocumentContext) => void;
  onOpenProfile?: (actorId: string) => void;
  onRemoveContextMessage?: (messageId: string) => void;
  onCancel?: () => void;
  onSend: (composition: MessageComposition) => Promise<void> | void;
  onStageAttachment?: (input: {
    attachment: TeamHubCompositionAttachmentInput;
    idempotencyKey: string;
    onProgress?: (progress: number) => void;
    signal?: AbortSignal;
  }) => Promise<void>;
  placeholder?: string;
  resolveDocumentLink?: (link: {
    bindToRoom?: boolean;
    documentId: string;
    tenantId: string;
  }) => Promise<MessageDocumentOption>;
  selectedContextMessages?: TeamHubMessage[];
  skillOptions?: MessageSkillOption[];
  /** Replaces the icon send control with a labelled confirm button. */
  submitLabel?: string;
  /**
   * Agents that peek over the composer while someone writes to them: the
   * direct chat's Agent, or else the Agents mentioned in the draft. Busy
   * Agents stay down.
   */
  agentPeek?: {
    busyAgentIds: readonly string[];
    directAgent?: ComposerPeekAgent;
  };
  /** Direct Agent chats render model and thinking-effort controls here. */
  modelSwitch?: ReactNode;
  /** Extra icon entries rendered before the send controls, outside Voice Mode. */
}

export const MessageComposer = forwardRef<
  MessageComposerHandle,
  MessageComposerProps
>(function MessageComposer(props, ref) {
  const session = useOptionalVoiceModeSession();
  const content = <MessageComposerContent {...props} ref={ref} />;
  // The app shell owns Voice Mode across Rooms; a composer rendered on its
  // own keeps a session scoped to itself, as before.
  return props.voiceModeTarget && !session ? (
    <VoiceModeSessionProvider>{content}</VoiceModeSessionProvider>
  ) : (
    content
  );
});

const MessageComposerContent = forwardRef<
  MessageComposerHandle,
  MessageComposerProps
>(function MessageComposerContent(props, ref) {
  return (
    <MessageComposerView
      agentPeek={props.agentPeek}
      controller={useMessageComposer(props, ref)}
      modelSwitch={props.modelSwitch}
    />
  );
});

function useMessageComposer(
  {
    agentOptionsReady,
    ariaLabel = "Message Room",
    attachmentDraftKey,
    attachmentEnabled = false,
    autoFocus = false,
    disabled = false,
    documentMentionsEnabled = true,
    documentOptions: catalogDocumentOptions = [],
    documentOptionsReady,
    initialDocumentReferences = [],
    initialDocumentContexts = [],
    initialMentions = [],
    initialSkillReferences = [],
    initialValue = "",
    mentionOptions = [],
    onCancelAttachment,
    onDocumentQueryChange,
    onDraftStateChange,
    onVoiceModePresentation,
    onOpenDocument,
    onOpenDocumentContext,
    onOpenProfile,
    onCancel,
    onRemoveContextMessage,
    onSend,
    onStageAttachment,
    placeholder = "Message this Room",
    resolveDocumentLink,
    selectedContextMessages = [],
    skillOptions = [],
    submitLabel,
    voiceModeTarget,
    isVoiceDraftCurrent,
  }: MessageComposerProps,
  ref: ForwardedRef<MessageComposerHandle>,
) {
  // Sub-hooks run in this order so their effects keep the order the composer
  // relies on: material sync, attachment cleanup, handle and layout, then the
  // Voice Mode session binding.
  const voice = useComposerVoiceState(voiceModeTarget);
  const draft = useComposerDraft({
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
    voice,
  });
  const attachments = useComposerAttachments({
    attachmentDraftKey,
    attachmentEnabled,
    disabled,
    onCancelAttachment,
    onStageAttachment,
    submitting: draft.submitting,
    voiceModeEntered: voice.voiceMode.entered,
  });
  const picker = useComposerPicker({
    documentMentionsEnabled,
    draft,
    mentionOptions,
    onDocumentQueryChange,
    skillOptions,
  });
  const insertion = useComposerReferenceInsertion({
    draft,
    picker,
    resolveDocumentLink,
    skillOptions,
  });
  const { handlePaste } = useComposerDocumentPaste({
    attachments,
    disabled,
    documentOptionsReady,
    draft,
    picker,
    resolveDocumentLink,
  });
  const sending = useComposerSend({
    attachments,
    disabled,
    draft,
    onSend,
    onStageAttachment,
    picker,
    resolveDocumentLink,
    voice,
    voiceModeTarget,
  });
  const { handleKeyDown } = useComposerKeyDown({
    draft,
    insertion,
    picker,
    sending,
  });
  useComposerTextarea({
    attachments,
    draft,
    insertion,
    picker,
    ref,
    voiceModeEntered: voice.voiceMode.entered,
  });
  const voiceTurn = useComposerVoiceTurn({
    draft,
    isVoiceDraftCurrent,
    onSend,
    onVoiceModePresentation,
    selectedContextMessages,
    selectedFileCount: attachments.selectedFiles.length,
    sending,
    voice,
    voiceModeTarget,
  });

  const { body, currentReferences, updateBody } = draft;
  return {
    ...voiceTurn,
    activeMentionIndex: picker.activeMentionIndex,
    activePickerLength: picker.activePickerLength,
    availableMentionTabs: picker.availableMentionTabs,
    ariaLabel,
    attachmentEnabled,
    attachmentError: attachments.attachmentError,
    documentContexts: draft.documentContexts,
    atPickerItems: picker.atPickerItems,
    autoFocus,
    body,
    closePicker: picker.closePicker,
    disabled,
    documentOptions: draft.documentOptions,
    documentReferences: currentReferences.documentReferences,
    fileInputRef: attachments.fileInputRef,
    handleFiles: attachments.handleFiles,
    handleKeyDown,
    handlePaste,
    highlightContentRef: draft.highlightContentRef,
    insertAtPickerItem: insertion.insertAtPickerItem,
    insertSkill: insertion.insertSkill,
    isComposing: draft.isComposing,
    lengthStatusId: draft.lengthStatusId,
    matchingSkills: picker.matchingSkills,
    mentionListId: picker.mentionListId,
    mentionQuery: picker.mentionQuery,
    mentionTab: picker.mentionTab,
    mentions: currentReferences.mentions,
    messageError: draft.messageError,
    onOpenDocument,
    onOpenDocumentContext,
    onCancel,
    onOpenProfile,
    onRemoveContextMessage,
    placeholder,
    resolvingDocumentLinks: draft.resolvingDocumentLinks,
    removeAttachment: attachments.removeAttachment,
    retryAttachment: attachments.retryAttachment,
    selectedContextMessages,
    selectedFiles: attachments.selectedFiles,
    send: sending.send,
    setMentionSelection: picker.setMentionSelection,
    setMentionTab: picker.setMentionTab,
    submitLabel,
    setDocumentContexts: (next: RoomComposerDocumentContext[]) => {
      draft.setDocumentContexts(next);
      updateBody(body, next);
    },
    skillQuery: picker.skillQuery,
    skillOptions,
    skillReferences: currentReferences.skillReferences,
    submitting: draft.submitting,
    textareaRef: draft.textareaRef,
    updateBody,
    updateMentionQuery: picker.updateMentionQuery,
    voiceMode: voice.voiceMode,
    visibleBody: draft.visibleBody,
    voiceModeTarget,
  };
}

type MessageComposerController = ReturnType<typeof useMessageComposer>;

function MessageComposerView({
  agentPeek,
  modelSwitch,
  controller,
}: {
  agentPeek?: MessageComposerProps["agentPeek"];
  controller: MessageComposerController;
  modelSwitch?: ReactNode;
}) {
  const {
    attachmentEnabled,
    attachmentError,
    documentContexts,
    body,
    lengthStatusId,
    mentions,
    messageError,
    onOpenDocumentContext,
    onRemoveContextMessage,
    removeAttachment,
    retryAttachment,
    selectedContextMessages,
    selectedFiles,
    setDocumentContexts,
    submitting,
    textareaRef,
    voiceMode,
    visibleBody,
    voiceModeTarget,
    voiceMaterialRows,
  } = controller;
  const peek = useComposerPeek();
  const { submitted: peekSubmitted } = peek;
  useEffect(() => {
    if (submitting) peekSubmitted();
  }, [peekSubmitted, submitting]);
  const peekAgents = agentPeek
    ? (agentPeek.directAgent
        ? [agentPeek.directAgent]
        : mentions.filter(
            (mention, index) =>
              mention.kind === "agent" &&
              mentions.findIndex((other) => other.id === mention.id) === index,
          )
      ).filter((agent) => !agentPeek.busyAgentIds.includes(agent.id))
    : [];
  const compact =
    documentContexts.length === 0 &&
    selectedContextMessages.length === 0 &&
    selectedFiles.length === 0 &&
    !attachmentError &&
    !messageError &&
    !voiceMaterialRows &&
    !voiceMode.entered;

  return (
    <div className="room-readable relative">
      <ComposerAgentPeek
        agents={peekAgents}
        blink={peek.blink}
        onDismiss={peek.dismiss}
        onReturnFocus={() => textareaRef.current?.focus()}
        visible={peek.visible}
      />
      <ComposerPickerMenus controller={controller} />

      <div
        className="message-composer-box"
        data-voice-mode={voiceMode.entered || undefined}
        data-voice-prefix={(voiceMode.entered && visibleBody) || undefined}
        data-attachment-enabled={attachmentEnabled || undefined}
        data-compact={compact || undefined}
      >
        {voiceModeTarget ? <VoiceMaterialsPreview /> : null}
        <DocumentContextChips
          contexts={documentContexts}
          onOpen={onOpenDocumentContext}
          onRemove={(context) =>
            setDocumentContexts(
              documentContexts.filter(
                (candidate) =>
                  candidate.documentVersionId !== context.documentVersionId,
              ),
            )
          }
        />
        <ReplyContextPreview
          messages={selectedContextMessages}
          onRemove={onRemoveContextMessage}
        />
        <AttachmentError
          message={attachmentError ?? failedUploadMessage(selectedFiles)}
        />
        <AttachmentPreviews
          attachments={selectedFiles}
          onRemove={removeAttachment}
          onRetry={retryAttachment}
        />
        <ComposerEditor controller={controller} peek={peek} />
        <MessageLengthStatus
          bodyLength={body.length}
          error={messageError}
          id={lengthStatusId}
        />
        <ComposerSendControls
          controller={controller}
          modelSwitch={modelSwitch}
        />
      </div>
    </div>
  );
}

/** The `@` mention and `/` Skill menus that float above the editor. */
function ComposerPickerMenus({
  controller: {
    activeMentionIndex,
    atPickerItems,
    availableMentionTabs,
    insertAtPickerItem,
    insertSkill,
    matchingSkills,
    mentionListId,
    mentionQuery,
    mentionTab,
    setMentionSelection,
    setMentionTab,
    skillOptions,
    skillQuery,
  },
}: {
  controller: MessageComposerController;
}) {
  return (
    <>
      {mentionQuery ? (
        <MentionMenu
          activeIndex={activeMentionIndex}
          items={atPickerItems}
          listId={mentionListId}
          onSelect={insertAtPickerItem}
          onSelectionChange={setMentionSelection}
          onTabChange={(tab) => {
            setMentionTab(tab);
            setMentionSelection(0);
          }}
          tab={mentionTab}
          tabs={availableMentionTabs}
        />
      ) : null}
      {skillQuery ? (
        <SkillMenu
          activeIndex={activeMentionIndex}
          agent={skillQuery.agent}
          items={matchingSkills}
          listId={mentionListId}
          options={skillOptions}
          onSelect={insertSkill}
          onSelectionChange={setMentionSelection}
        />
      ) : null}
    </>
  );
}

/** The textarea with its structured-token highlight layer underneath. */
function ComposerEditor({
  controller: {
    activeMentionIndex,
    activePickerLength,
    ariaLabel,
    autoFocus,
    body,
    closePicker,
    disabled,
    documentOptions,
    documentReferences,
    handleKeyDown,
    handlePaste,
    highlightContentRef,
    isComposing,
    lengthStatusId,
    mentionListId,
    mentionQuery,
    mentions,
    messageError,
    onOpenDocument,
    onOpenProfile,
    placeholder,
    skillOptions,
    skillQuery,
    skillReferences,
    submitting,
    textareaRef,
    updateBody,
    updateMentionQuery,
    visibleBody,
    voiceMode,
  },
  peek,
}: {
  controller: MessageComposerController;
  peek: ReturnType<typeof useComposerPeek>;
}) {
  return (
    <div className="message-composer-editor relative">
      <textarea
        aria-label={ariaLabel}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the field is focused on purpose because the user just opened this dialog or inline editor
        autoFocus={autoFocus}
        aria-describedby={
          messageError || body.length >= TEAMHUB_MESSAGE_MAX_LENGTH * 0.9
            ? lengthStatusId
            : undefined
        }
        aria-activedescendant={
          activePickerLength
            ? `${mentionListId}-${activeMentionIndex}`
            : undefined
        }
        aria-autocomplete="list"
        aria-controls={mentionQuery || skillQuery ? mentionListId : undefined}
        className="message-composer-input relative z-[1] block w-full resize-none bg-transparent outline-none"
        maxLength={TEAMHUB_MESSAGE_MAX_LENGTH}
        onChange={(event) => {
          peek.typed(event.target.value.length);
          updateBody(event.target.value);
          updateMentionQuery(
            event.target.value,
            event.target.selectionStart ?? event.target.value.length,
          );
        }}
        onCompositionEnd={(event) => {
          isComposing.current = false;
          delete event.currentTarget.dataset.composing;
        }}
        onCompositionStart={(event) => {
          isComposing.current = true;
          event.currentTarget.dataset.composing = "true";
        }}
        // Input-method candidates count as typing before they commit.
        onCompositionUpdate={(event) =>
          peek.typed(event.currentTarget.value.length)
        }
        onKeyDown={handleKeyDown}
        onPaste={(event) => {
          peek.pasted();
          handlePaste(event);
        }}
        onClick={closePicker}
        onScroll={(event) =>
          syncComposerHighlightScroll(
            event.currentTarget,
            highlightContentRef.current,
          )
        }
        placeholder={placeholder}
        disabled={disabled}
        readOnly={submitting || voiceMode.entered}
        ref={textareaRef}
        rows={1}
        value={visibleBody}
      />
      <ComposerHighlight
        body={visibleBody}
        documentOptions={documentOptions}
        documentReferences={documentReferences}
        highlightContentRef={highlightContentRef}
        mentions={mentions}
        onOpenDocument={onOpenDocument}
        onOpenProfile={onOpenProfile}
        skillOptions={skillOptions}
        skillReferences={skillReferences}
      />
    </div>
  );
}

/** The toolbar with send, attachments, and the lazy Voice Mode controls. */
function ComposerSendControls({
  controller: {
    attachmentEnabled,
    body,
    disabled,
    documentContexts,
    draftHasMentions,
    fileInputRef,
    handleFiles,
    onCancel,
    resolvingDocumentLinks,
    selectedFiles,
    send,
    submitLabel,
    submitting,
    voiceHasMaterials,
    voiceMode,
    voiceModeEmpty,
    voiceModeTarget,
    voicePrefix,
    voiceSessionActiveHere,
  },
  modelSwitch,
}: {
  controller: MessageComposerController;
  modelSwitch?: ReactNode;
}) {
  const voicePolicy = useVoiceMediaPolicy(
    voiceModeTarget?.tenantId ?? "",
    Boolean(voiceModeTarget),
  );
  // Without Soniox or xAI there is no Voice Mode, so the empty composer keeps
  // its send button. Until the policy answers the voice entry keeps the slot,
  // so a deployment with voice never flashes the send button first.
  const voiceOff =
    voicePolicy !== undefined &&
    voicePolicy.voice_media_supported !== true &&
    voicePolicy.live_supported !== true;
  return (
    <ComposerToolbar
      attachmentEnabled={attachmentEnabled}
      disabled={disabled || submitting || voiceMode.entered}
      fileInputRef={fileInputRef}
      onFilesChange={handleFiles}
      onCancel={onCancel}
      onSend={() => void send()}
      submitLabel={submitLabel}
      voiceModeControls={
        voiceModeTarget &&
        !voiceOff &&
        ((voiceModeEmpty && !draftHasMentions) ||
          voiceMode.entered ||
          voiceSessionActiveHere) ? (
          <Suspense fallback={null}>
            <VoiceModeControls
              key={voiceModeTarget.roomId}
              target={voiceModeTarget}
              disabled={disabled || submitting}
              empty={voiceModeEmpty}
              prefix={voicePrefix}
              policy={voicePolicy}
            />
          </Suspense>
        ) : undefined
      }
      modelSwitch={modelSwitch}
      voiceModeEntered={voiceMode.entered}
      keepSendWithVoice={voiceHasMaterials && !voiceMode.entered}
      sendDisabled={
        disabled ||
        submitting ||
        resolvingDocumentLinks > 0 ||
        body.trim().length > TEAMHUB_MESSAGE_MAX_LENGTH ||
        selectedFiles.some((attachment) => attachment.status !== "ready") ||
        (!body.trim() &&
          selectedFiles.length === 0 &&
          documentContexts.length === 0)
      }
    />
  );
}

function DocumentContextChips({
  contexts,
  onOpen,
  onRemove,
}: {
  contexts: RoomComposerDocumentContext[];
  onOpen?: (context: RoomComposerDocumentContext) => void;
  onRemove: (context: RoomComposerDocumentContext) => void;
}) {
  if (contexts.length === 0) return null;
  return (
    <div aria-label="Artifact contexts" className="mb-2 flex flex-wrap gap-2">
      {contexts.map((context) => (
        <div
          className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-app-border-strong bg-app-surface-soft p-1"
          key={context.documentVersionId}
        >
          <button
            aria-label={`Open ${context.filename} Version ${context.versionNumber}`}
            className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-app-focus"
            disabled={!onOpen}
            onClick={() => onOpen?.(context)}
            type="button"
          >
            <Icon
              icon={FileLockedIcon}
              className="shrink-0 text-app-accent"
              size={16}
            />
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold text-app-body">
                {context.filename}
              </span>
              <span className="block truncate text-[12px] text-app-subtle">
                Version {context.versionNumber} · {context.sourceRoomName}
              </span>
            </span>
            {onOpen ? (
              <Icon
                icon={LinkSquare02Icon}
                className="shrink-0 text-app-subtle"
                size={12}
              />
            ) : null}
          </button>
          <Button
            aria-label={`Remove ${context.filename} Version ${context.versionNumber}`}
            onClick={() => onRemove(context)}
            size="compactIcon"
            title="Remove context"
            tone="ghost"
          >
            <Icon icon={Cancel01Icon} size={14} />
          </Button>
        </div>
      ))}
    </div>
  );
}

type ComposerReferenceMatch =
  | {
      actor: TeamHubActorRef;
      end: number;
      kind: "actor";
      start: number;
      token: string;
    }
  | {
      document: MessageDocumentOption;
      end: number;
      kind: "document";
      start: number;
      token: string;
    }
  | {
      end: number;
      kind: "skill";
      skill: MessageSkillOption;
      start: number;
      token: string;
    };

function ComposerHighlight({
  body,
  documentOptions,
  documentReferences,
  highlightContentRef,
  mentions,
  onOpenDocument,
  onOpenProfile,
  skillOptions,
  skillReferences,
}: {
  body: string;
  documentOptions: MessageDocumentOption[];
  documentReferences: RoomComposerDocumentReference[];
  highlightContentRef: RefObject<HTMLDivElement | null>;
  mentions: TeamHubActorRef[];
  onOpenDocument?: (document: MessageDocumentOption) => void;
  onOpenProfile?: (actorId: string) => void;
  skillOptions: MessageSkillOption[];
  skillReferences: TeamHubMessageSkillReference[];
}) {
  const references = findComposerReferenceMatches(
    body,
    mentions,
    documentReferences,
    documentOptions,
    skillReferences,
    skillOptions,
  );
  const content = [];
  let cursor = 0;

  for (const reference of references) {
    if (reference.start > cursor) {
      content.push(
        <span aria-hidden="true" key={`text-${cursor}`}>
          {body.slice(cursor, reference.start)}
        </span>,
      );
    }
    if (reference.kind === "skill") {
      content.push(
        <SkillReferenceToken
          key={`skill-${reference.start}`}
          skill={reference.skill}
          token={reference.token}
        />,
      );
      cursor = reference.end;
      continue;
    }
    // An Agent reads as its avatar and name; the "@" keeps its width so the
    // overlay stays aligned with the caret in the textarea below it.
    const agent =
      reference.kind === "actor" &&
      reference.actor.kind === "agent" &&
      reference.token.startsWith("@");
    const display =
      agent && reference.kind === "actor" ? (
        <ComposerAgentMention
          actorId={reference.actor.id}
          name={reference.actor.display_name}
          token={reference.token}
        />
      ) : (
        reference.token
      );
    const actionable =
      reference.kind === "actor"
        ? Boolean(onOpenProfile)
        : Boolean(onOpenDocument);
    const label =
      reference.kind === "actor"
        ? `Open ${reference.actor.display_name} profile`
        : `Open ${reference.document.name}`;
    const token = actionable ? (
      <span
        aria-label={label}
        className="message-composer-reference"
        data-agent={agent || undefined}
        data-reference-kind={reference.kind}
        key={`${reference.kind}-${reference.start}`}
        onClick={() => {
          if (reference.kind === "actor") {
            onOpenProfile?.(reference.actor.id);
          } else {
            onOpenDocument?.(reference.document);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
        role="button"
        tabIndex={0}
        title={label}
      >
        {display}
      </span>
    ) : (
      <span
        aria-hidden="true"
        className="message-composer-reference"
        data-agent={agent || undefined}
        data-reference-kind={reference.kind}
        key={`${reference.kind}-${reference.start}`}
      >
        {display}
      </span>
    );
    content.push(token);
    cursor = reference.end;
  }

  if (cursor < body.length) {
    content.push(
      <span aria-hidden="true" key={`text-${cursor}`}>
        {body.slice(cursor)}
      </span>,
    );
  }

  return (
    <div
      aria-label="Composer references"
      className="message-composer-highlight-layer absolute inset-0 overflow-hidden"
      role="group"
    >
      <div
        className="message-composer-highlight-content whitespace-pre-wrap text-app-ink"
        ref={highlightContentRef}
      >
        {content}
      </div>
    </div>
  );
}

function findComposerReferenceMatches(
  body: string,
  mentions: TeamHubActorRef[],
  documentReferences: RoomComposerDocumentReference[],
  documentOptions: MessageDocumentOption[],
  skillReferences: TeamHubMessageSkillReference[],
  skillOptions: MessageSkillOption[],
) {
  const actorsByToken = new Map(
    mentions.flatMap((actor) =>
      teamHubMentionTokenAliases(actor).map((token) => [token, actor] as const),
    ),
  );
  const documentsByToken = new Map<string, MessageDocumentOption>();
  for (const reference of documentReferences) {
    const document = findDocumentOption(reference, documentOptions);
    if (document) documentsByToken.set(reference.token, document);
  }
  const skillsByTargetAndToken = new Map(
    skillReferences.flatMap((reference) => {
      const skill = skillOptions.find(
        (option) =>
          option.agent.id === reference.target &&
          option.manifestVersion === reference.manifestVersion &&
          option.skillId === reference.skillId,
      );
      return skill
        ? [[`${reference.target}\u0000${reference.token}`, skill] as const]
        : [];
    }),
  );

  const matches: ComposerReferenceMatch[] = [];
  let activeAgentId: string | null = null;
  const tokens = new Set([
    ...actorsByToken.keys(),
    ...documentsByToken.keys(),
    ...skillReferences.map((reference) => reference.token),
  ]);
  for (const match of findTeamHubMessageTokenMatches(body, tokens)) {
    const start = match.index ?? 0;
    const actor = actorsByToken.get(match.token);
    if (actor) {
      activeAgentId = actor.kind === "agent" ? actor.id : null;
      matches.push({
        actor,
        end: start + match.token.length,
        kind: "actor",
        start,
        token: match.token,
      });
      continue;
    }
    const skill = activeAgentId
      ? skillsByTargetAndToken.get(`${activeAgentId}\u0000${match.token}`)
      : undefined;
    if (skill) {
      matches.push({
        end: start + match.token.length,
        kind: "skill",
        skill,
        start,
        token: match.token,
      });
      continue;
    }
    const document = documentsByToken.get(match.token);
    if (document) {
      matches.push({
        document,
        end: start + match.token.length,
        kind: "document",
        start,
        token: match.token,
      });
    }
  }
  return matches;
}

function SkillReferenceToken({
  skill,
  token,
}: {
  skill: MessageSkillOption;
  token: string;
}) {
  const description = skill.description?.trim() || "No description available.";
  const tooltipId = useId();
  const [tooltipPosition, setTooltipPosition] = useState<{
    left: number;
    top: number;
  }>();

  function showTooltip(target: HTMLElement) {
    const bounds = target.getBoundingClientRect();
    setTooltipPosition({
      left: Math.max(12, Math.min(bounds.left, window.innerWidth - 332)),
      top: bounds.top - 8,
    });
  }

  return (
    <>
      <span
        aria-describedby={tooltipPosition ? tooltipId : undefined}
        aria-label={`Skill ${token}`}
        className="message-composer-reference"
        data-reference-kind="skill"
        onBlur={() => setTooltipPosition(undefined)}
        onFocus={(event) => showTooltip(event.currentTarget)}
        onMouseEnter={(event) => showTooltip(event.currentTarget)}
        onMouseLeave={() => setTooltipPosition(undefined)}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the focusable reference token reveals its tooltip for keyboard users
        tabIndex={0}
      >
        {token}
      </span>
      {tooltipPosition
        ? createPortal(
            <div
              className="app-floating-enter fixed z-50 w-80 max-w-[calc(100vw-24px)] rounded-lg bg-popover px-3 py-2 text-left text-xs leading-5 text-app-body shadow-md"
              id={tooltipId}
              role="tooltip"
              style={{
                left: tooltipPosition.left,
                top: tooltipPosition.top,
                transform: "translateY(-100%)",
              }}
            >
              <p className="line-clamp-6">{description}</p>
              <p className="mt-1 text-[12px] font-medium text-app-subtle">
                Skill
              </p>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function ReplyContextPreview({
  messages,
  onRemove,
}: {
  messages: TeamHubMessage[];
  onRemove?: (messageId: string) => void;
}) {
  if (!messages.length) return null;
  return (
    <div
      aria-label="Selected reply context"
      className="mb-2 max-h-36 space-y-1 overflow-y-auto border-b border-app-border pb-2 pr-1"
    >
      {messages.map((message) => (
        <div
          className="flex min-h-8 items-center gap-2 border-l-2 border-app-accent-border bg-app-surface-soft px-2 py-1 text-xs"
          key={message.id}
        >
          <span className="shrink-0 font-semibold">
            {message.author.display_name}
          </span>
          <span className="min-w-0 flex-1 truncate text-app-muted">
            {markdownPlainText(message.raw_message)}
          </span>
          <Button
            aria-label={`Remove ${message.author.display_name} from reply context`}
            onClick={() => onRemove?.(message.id)}
            size="compactIcon"
            title="Remove reply context"
            tone="ghost"
          >
            <Icon icon={Cancel01Icon} size={14} />
          </Button>
        </div>
      ))}
    </div>
  );
}

// A failed chip only shows an icon, so name the failure where it can be read.
function failedUploadMessage(attachments: readonly ComposerAttachment[]) {
  const failed = attachments.find(
    (attachment) => attachment.status === "failed",
  );
  if (!failed) return null;
  return `${failed.file.name}: ${failed.error ?? "Upload failed."}`;
}

function AttachmentError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      className="mb-2 border border-[var(--app-card-feedback-border)] bg-[var(--app-card-feedback-surface)] px-2.5 py-2 text-xs text-app-danger [border-radius:var(--app-control-radius-large)]"
      role="alert"
    >
      {message}
    </p>
  );
}

function MessageLengthStatus({
  bodyLength,
  error,
  id,
}: {
  bodyLength: number;
  error: string | null;
  id: string;
}) {
  if (!error && bodyLength < TEAMHUB_MESSAGE_MAX_LENGTH * 0.9) return null;
  return (
    <p
      className={`pb-1 text-right text-[12px] ${
        error ? "text-app-danger" : "text-app-muted"
      }`}
      id={id}
      role={error ? "alert" : "status"}
    >
      {error ??
        `${bodyLength.toLocaleString()} / ${TEAMHUB_MESSAGE_MAX_LENGTH.toLocaleString()}`}
    </p>
  );
}

function ComposerToolbar({
  attachmentEnabled,
  disabled,
  fileInputRef,
  onCancel,
  onFilesChange,
  modelSwitch,
  onSend,
  sendDisabled,
  submitLabel,
  voiceModeControls,
  voiceModeEntered,
  keepSendWithVoice,
}: {
  attachmentEnabled: boolean;
  disabled: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onCancel?: () => void;
  onFilesChange: (event: ChangeEvent<HTMLInputElement>) => void;
  modelSwitch?: ReactNode;
  onSend: () => void;
  sendDisabled: boolean;
  submitLabel?: string;
  voiceModeControls?: ReactNode;
  voiceModeEntered?: boolean;
  keepSendWithVoice?: boolean;
}) {
  const showAttach = attachmentEnabled && !voiceModeEntered;
  const showTools = !submitLabel && !voiceModeEntered && Boolean(modelSwitch);
  const hasLeftTools = showAttach || showTools;
  return (
    <div className="message-composer-toolbar mt-1.5 flex min-h-7 items-center justify-between gap-3">
      {hasLeftTools ? (
        <div className="message-composer-toolbar-left flex min-w-0 items-center gap-0.5">
          {showAttach ? (
            <>
              <Button
                aria-label="Attach file"
                className="composer-attach-button text-app-muted"
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
                size="compactIcon"
                title="Attach file"
                tone="ghost"
              >
                <Icon icon={PlusSignIcon} size={16} />
              </Button>
              <input
                aria-label="Choose message attachments"
                className="sr-only"
                disabled={disabled}
                multiple
                onChange={onFilesChange}
                ref={fileInputRef}
                type="file"
              />
            </>
          ) : null}
          {showTools ? modelSwitch : null}
        </div>
      ) : null}
      <div
        className={`message-composer-toolbar-right ml-auto flex items-center gap-1 ${voiceModeEntered ? "min-w-0 flex-1" : "shrink-0"}`}
      >
        {submitLabel ? (
          <>
            {onCancel ? (
              <Button onClick={onCancel} size="compact" tone="ghost">
                Cancel
              </Button>
            ) : null}
            <Button
              className="message-composer-confirm"
              disabled={sendDisabled}
              onClick={onSend}
              size="compact"
              tone="primary"
            >
              {submitLabel}
            </Button>
          </>
        ) : (
          <>
            {voiceModeControls}
            {!voiceModeControls || keepSendWithVoice ? (
              <Button
                aria-label="Send message"
                className="message-composer-send disabled:!opacity-100"
                disabled={sendDisabled}
                onClick={onSend}
                size="compactIcon"
                tone="primary"
              >
                <Icon icon={ArrowUp02Icon} size={16} />
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function AttachmentPreviews({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: ComposerAttachment[];
  onRemove: (attachment: ComposerAttachment) => void;
  onRetry: (attachment: ComposerAttachment) => void;
}) {
  if (!attachments.length) {
    return null;
  }

  return (
    <div
      aria-label="Pending attachments"
      className="workspace-scrollbar mb-2 flex min-w-0 items-center gap-2 overflow-x-auto px-1"
      role="region"
    >
      {attachments.map((attachment) => (
        <AttachmentPreview
          attachment={attachment}
          key={attachment.clientId}
          onRemove={() => onRemove(attachment)}
          onRetry={() => onRetry(attachment)}
        />
      ))}
    </div>
  );
}

function AttachmentPreview({
  attachment,
  onRemove,
  onRetry,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const { file } = attachment;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string>();
  const isImage = file.type.startsWith("image/");
  const isAudio = file.type.startsWith("audio/");
  const isVideo = file.type.startsWith("video/");
  const fileIcon = isAudio
    ? FileAudioIcon
    : isVideo
      ? FileVideoIcon
      : isImage
        ? Image01Icon
        : File01Icon;
  const token = attachmentTokenPresentation(file);

  useEffect(() => {
    const nextUrl = URL.createObjectURL(file);
    setObjectUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  function download() {
    if (!objectUrl) return;
    const link = document.createElement("a");
    link.download = file.name;
    link.href = objectUrl;
    link.click();
  }

  if (isImage && objectUrl && attachment.status === "ready") {
    return (
      <div className="group relative h-8 shrink-0">
        <button
          aria-label={`Preview ${file.name}`}
          className="block h-8 overflow-hidden rounded-md border border-border focus-visible:outline-2 focus-visible:outline-app-focus"
          onClick={() => setPreviewOpen(true)}
          type="button"
        >
          <img
            alt=""
            className="h-full w-auto max-w-none object-cover"
            src={objectUrl}
          />
        </button>
        <button
          aria-label={`Remove ${file.name}`}
          className="pointer-events-none absolute right-0 top-0 flex size-4 items-center justify-center rounded-bl bg-foreground/60 text-background opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:outline-2 focus-visible:outline-app-focus [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
          onClick={onRemove}
          type="button"
        >
          <Icon icon={Cancel01Icon} size={10} />
        </button>
        {previewOpen ? (
          <ImageAttachmentDialog
            file={file}
            objectUrl={objectUrl}
            onClose={() => setPreviewOpen(false)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`flex h-5 max-w-32 shrink-0 items-center overflow-hidden rounded-md px-1 py-0.5 font-(family-name:--app-header-font) text-[10px] font-medium leading-4 backdrop-blur-[6px] ${token.surface}`}
    >
      {attachment.status === "uploading" ? (
        <span
          aria-label={`Uploading ${file.name}`}
          className="inline-flex size-4 shrink-0 animate-spin motion-reduce:animate-none"
          role="status"
        >
          <Icon icon={Loading03Icon} size={16} />
        </span>
      ) : attachment.status === "failed" ? (
        <Icon
          icon={AlertCircleIcon}
          className="size-4 shrink-0 text-app-danger"
        />
      ) : (
        <Icon
          className={`size-4 shrink-0 ${token.text}`}
          icon={token.icon ?? fileIcon}
        />
      )}
      {attachment.status === "uploading" ? (
        <div className={`flex min-w-0 flex-1 items-center px-1 ${token.text}`}>
          <span className="sr-only">
            Uploading {Math.round(attachment.progress * 100)}%
          </span>
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <span className="shrink-0">
            {Math.round(attachment.progress * 100)}%
          </span>
        </div>
      ) : attachment.status === "failed" ? (
        <button
          aria-label={`Retry upload ${file.name}`}
          className="min-w-0 flex-1 truncate px-1 text-left text-app-danger focus-visible:outline-2 focus-visible:outline-app-focus"
          onClick={onRetry}
          title={attachment.error}
          type="button"
        >
          {file.name}
        </button>
      ) : (
        <button
          aria-label={`Download ${file.name}`}
          className={`min-w-0 flex-1 truncate px-1 text-left focus-visible:outline-2 focus-visible:outline-app-focus ${token.text}`}
          onClick={download}
          type="button"
        >
          {file.name}
        </button>
      )}
      <button
        aria-label={`Remove ${file.name}`}
        className="flex size-3 shrink-0 items-center justify-center text-muted-foreground/60 hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-app-focus"
        onClick={onRemove}
        type="button"
      >
        <Icon icon={Cancel01Icon} size={12} />
      </button>
    </div>
  );
}

function ImageAttachmentDialog({
  file,
  objectUrl,
  onClose,
}: {
  file: File;
  objectUrl: string;
  onClose: () => void;
}) {
  return (
    <ModalDialog
      ariaLabel={`Preview ${file.name}`}
      className="overflow-hidden"
      closeOnBackdrop
      onClose={onClose}
      size="xl"
    >
      <div className="flex items-center justify-between border-b border-app-border px-3 py-2">
        <p className="truncate text-sm font-semibold text-app-ink">
          {file.name}
        </p>
        <Button
          aria-label="Close image preview"
          onClick={onClose}
          size="compactIcon"
          tone="ghost"
        >
          <Icon icon={Cancel01Icon} size={16} />
        </Button>
      </div>
      <div className="flex max-h-[calc(100vh-88px)] items-center justify-center overflow-auto bg-app-surface-soft p-4">
        <img
          alt={file.name}
          className="max-h-[calc(100vh-120px)] max-w-full object-contain"
          src={objectUrl}
        />
      </div>
    </ModalDialog>
  );
}

function attachmentTokenPresentation(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (file.type === "application/pdf" || extension === "pdf") {
    return {
      icon: Pdf02Icon,
      surface: "bg-[var(--composer-attachment-pdf-surface)]",
      text: "text-[var(--composer-attachment-pdf-text)]",
    };
  }
  if (
    file.type.includes("javascript") ||
    file.type.includes("json") ||
    ["css", "html", "js", "jsx", "json", "md", "ts", "tsx"].includes(
      extension ?? "",
    )
  ) {
    return {
      icon: FileCodeIcon,
      surface: "bg-[var(--composer-attachment-code-surface)]",
      text: "text-[var(--composer-attachment-code-text)]",
    };
  }
  if (["key", "ppt", "pptx"].includes(extension ?? "")) {
    return {
      icon: Ppt02Icon,
      surface: "bg-[var(--composer-attachment-presentation-surface)]",
      text: "text-[var(--composer-attachment-presentation-text)]",
    };
  }
  if (["doc", "docx", "rtf", "txt"].includes(extension ?? "")) {
    return {
      icon: Doc02Icon,
      surface: "bg-[var(--composer-attachment-document-surface)]",
      text: "text-[var(--composer-attachment-document-text)]",
    };
  }
  if (["csv", "xls", "xlsx"].includes(extension ?? "")) {
    return {
      icon: FileSpreadsheetIcon,
      surface: "bg-[var(--composer-attachment-sheet-surface)]",
      text: "text-[var(--composer-attachment-sheet-text)]",
    };
  }
  if (["7z", "gz", "rar", "tar", "zip"].includes(extension ?? "")) {
    return {
      icon: FileZipIcon,
      surface: "bg-[var(--composer-attachment-compressed-surface)]",
      text: "text-[var(--composer-attachment-compressed-text)]",
    };
  }
  return {
    icon: undefined,
    surface: "bg-[var(--composer-attachment-universal-surface)]",
    text: "text-[var(--composer-attachment-universal-text)]",
  };
}

function MentionMenu({
  activeIndex,
  items,
  listId,
  onSelect,
  onSelectionChange,
  onTabChange,
  tab,
  tabs,
}: {
  activeIndex: number;
  items: AtPickerItem[];
  listId: string;
  onSelect: (item: AtPickerItem) => void;
  onSelectionChange: (index: number) => void;
  onTabChange: (tab: MentionTab) => void;
  tab: MentionTab;
  tabs: readonly MentionTab[];
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<MentionTab, HTMLButtonElement>>>({});

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = menu?.parentElement;
    if (!menu || !anchor) return;

    const fitToVisibleArea = () => {
      let top = 0;
      let bottom = window.innerHeight;
      // The viewport alone is not the visible area: document/tool panels have
      // scrolling ancestors below a fixed header that also clip this popup.
      for (
        let parent = anchor.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        if (!/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY))
          continue;
        const rect = parent.getBoundingClientRect();
        top = Math.max(top, rect.top + parent.clientTop);
        bottom = Math.min(
          bottom,
          rect.top + parent.clientTop + parent.clientHeight,
        );
      }
      const rect = anchor.getBoundingClientRect();
      const above = Math.max(0, rect.top - top - 16);
      const below = Math.max(0, bottom - rect.bottom - 16);
      const opensBelow = above < 160 && below > above;
      menu.style.top = opensBelow ? "calc(100% + 8px)" : "auto";
      menu.style.bottom = opensBelow ? "auto" : "calc(100% + 8px)";
      menu.style.maxHeight = `min(26rem, ${opensBelow ? below : above}px)`;
    };
    fitToVisibleArea();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleFit = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        fitToVisibleArea();
      }, 16);
    };
    window.addEventListener("resize", scheduleFit);
    window.addEventListener("scroll", scheduleFit, true);
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(fitToVisibleArea)
        : undefined;
    observer?.observe(anchor);
    return () => {
      observer?.disconnect();
      clearTimeout(timer);
      window.removeEventListener("resize", scheduleFit);
      window.removeEventListener("scroll", scheduleFit, true);
    };
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    const option = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !option) return;
    const bounds = list.getBoundingClientRect();
    const selected = option.getBoundingClientRect();
    // Only scroll the choices; scrollIntoView also moves the document/panel.
    if (selected.top < bounds.top) list.scrollTop += selected.top - bounds.top;
    else if (selected.bottom > bounds.bottom)
      list.scrollTop += selected.bottom - bounds.bottom;
  }, [activeIndex]);

  return (
    <div
      aria-label="Mention people or documents"
      className="app-floating-enter message-mention-menu absolute bottom-[calc(100%+8px)] left-0 z-30 flex max-h-[min(26rem,calc(100dvh-7rem))] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden bg-popover shadow-md [border-radius:var(--app-panel-radius)]"
      ref={menuRef}
    >
      <div
        className="sticky top-0 z-10 flex shrink-0 gap-1 border-b border-app-border bg-app-surface px-2 pt-2"
        role="tablist"
      >
        {tabs.map((value) => (
          <button
            aria-controls={`${listId}-panel`}
            aria-selected={tab === value}
            className={`min-h-9 border-b-2 px-2.5 text-xs font-medium capitalize ${
              tab === value
                ? "border-app-accent text-app-ink"
                : "border-transparent text-app-muted hover:text-app-ink"
            }`}
            id={`${listId}-tab-${value}`}
            key={value}
            onClick={() => onTabChange(value)}
            onKeyDown={(event) => {
              let nextTab: MentionTab | null = null;
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                nextTab = adjacentMentionTab(
                  tab,
                  event.key === "ArrowRight" ? 1 : -1,
                  tabs,
                );
              } else if (event.key === "Home") {
                nextTab = "all";
              } else if (event.key === "End") {
                nextTab = tabs.at(-1) ?? "all";
              }
              if (!nextTab) return;
              event.preventDefault();
              onTabChange(nextTab);
              tabRefs.current[nextTab]?.focus();
            }}
            onMouseDown={(event) => event.preventDefault()}
            ref={(node) => {
              tabRefs.current[value] = node ?? undefined;
            }}
            role="tab"
            tabIndex={tab === value ? 0 : -1}
            type="button"
          >
            {value}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`${listId}-tab-${tab}`}
        className="flex min-h-0 flex-1"
        id={`${listId}-panel`}
        role="tabpanel"
      >
        <div
          aria-label="Mention people or documents"
          className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto p-1.5"
          id={listId}
          ref={listRef}
          role="listbox"
        >
          {items.length ? (
            items.map((item, index) => (
              <MentionOption
                active={index === activeIndex}
                id={`${listId}-${index}`}
                item={item}
                key={
                  item.kind === "actor"
                    ? `actor-${item.actor.id}`
                    : `document-${item.document.documentId}`
                }
                onSelect={() => onSelect(item)}
                onSelectionChange={() => onSelectionChange(index)}
              />
            ))
          ) : (
            <p className="px-3 py-5 text-center text-xs text-app-muted">
              No matching{" "}
              {tab === "docs"
                ? "documents"
                : tab === "people"
                  ? "people"
                  : "results"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function MentionOption({
  active,
  id,
  item,
  onSelect,
  onSelectionChange,
}: {
  active: boolean;
  id: string;
  item: AtPickerItem;
  onSelect: () => void;
  onSelectionChange: () => void;
}) {
  const disabled = false;
  return (
    <button
      aria-disabled={disabled || undefined}
      aria-selected={active && !disabled}
      className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left ${
        active ? "bg-app-selected" : "hover:bg-app-hover"
      } ${disabled ? "cursor-not-allowed opacity-55" : ""}`}
      disabled={disabled}
      id={id}
      onClick={() => (disabled ? undefined : onSelect())}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => (disabled ? undefined : onSelectionChange())}
      role="option"
      tabIndex={-1}
      type="button"
    >
      {item.kind === "actor" ? (
        <ActorAvatar
          actorId={item.actor.id}
          kind={item.actor.kind}
          name={item.actor.display_name}
          size="xs"
        />
      ) : (
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-app-surface-soft text-app-muted">
          <Icon icon={File01Icon} size={16} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {item.kind === "actor" ? item.actor.display_name : item.document.name}
        </span>
        <span className="block truncate text-[12px] text-app-subtle">
          {item.kind === "actor"
            ? item.actor.kind === "agent"
              ? "Agent"
              : formatMentionToken(item.actor)
            : `Updated ${formatRelativeDate(item.document.updatedAt)}`}
        </span>
      </span>
      <span className="shrink-0 text-[10px] font-medium text-app-muted">
        {item.kind === "document"
          ? "Doc"
          : item.actor.kind === "agent"
            ? "Agent"
            : "Person"}
      </span>
    </button>
  );
}

function SkillMenu({
  activeIndex,
  agent,
  items,
  listId,
  options,
  onSelect,
  onSelectionChange,
}: {
  activeIndex: number;
  agent: TeamHubActorRef;
  items: MessageSkillOption[];
  listId: string;
  options: MessageSkillOption[];
  onSelect: (skill: MessageSkillOption) => void;
  onSelectionChange: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);
  const selectedSkill = items[activeIndex];
  return (
    <div className="app-floating-enter absolute bottom-[calc(100%+8px)] left-0 z-30 flex max-h-[min(24rem,calc(100dvh-7rem))] w-[min(42rem,calc(100vw-1.5rem))] flex-col overflow-hidden bg-popover shadow-md [border-radius:var(--app-panel-radius)]">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-app-border px-3">
        <ActorAvatar
          actorId={agent.id}
          kind="agent"
          name={agent.display_name}
          size="xs"
        />
        <span className="min-w-0 truncate text-xs font-medium text-app-muted">
          Skills for <span className="text-app-ink">{agent.display_name}</span>
        </span>
      </div>
      <div className="grid min-h-0 flex-1 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <div
          aria-label={`Skills for ${agent.display_name}`}
          className="workspace-scrollbar min-h-14 overflow-y-auto p-1.5 sm:border-r sm:border-app-border"
          id={listId}
          ref={listRef}
          role="listbox"
        >
          {items.length ? (
            items.map((skill, index) => (
              <button
                aria-selected={index === activeIndex}
                className={`flex min-h-12 w-full items-center gap-2 rounded-md px-2 text-left ${index === activeIndex ? "bg-app-selected" : "hover:bg-app-hover"}`}
                id={`${listId}-${index}`}
                key={`${skill.agent.id}-${skill.skillId}-${skill.manifestVersion}`}
                onClick={() => onSelect(skill)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onSelectionChange(index)}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-app-surface-soft text-app-muted">
                  <Icon icon={MagicWand01Icon} size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {formatSkillToken(skill, options)}
                  </span>
                  <span className="block truncate text-[12px] text-app-subtle">
                    {skill.name}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-[12px] leading-4 text-app-subtle sm:hidden">
                    {skill.description || "No description available."}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <p className="px-3 py-5 text-center text-xs text-app-muted">
              No matching skills for {agent.display_name}
            </p>
          )}
        </div>
        <div
          aria-label="Selected Skill description"
          className="workspace-scrollbar hidden min-h-0 overflow-y-auto bg-app-surface-soft p-4 sm:block"
          role="region"
        >
          {selectedSkill ? (
            <>
              <p className="text-sm font-semibold text-app-ink">
                {formatSkillToken(selectedSkill, options)}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-5 text-app-body">
                {selectedSkill.description || "No description available."}
              </p>
              <p className="mt-3 text-[12px] font-medium text-app-subtle">
                Skill
              </p>
            </>
          ) : (
            <p className="text-sm text-app-muted">Select a Skill.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function formatRelativeDate(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "recently";
  const date = new Date(timestamp);
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  const days = Math.round((Date.now() - timestamp) / 86_400_000);
  const day =
    days <= 0
      ? "today"
      : days === 1
        ? "yesterday"
        : days < 30
          ? `${days}d ago`
          : composerDateFormatter.format(timestamp);
  return `${day} ${time}`;
}

/** The composer's Agent mention: avatar over the "@", name in its colour. */
function ComposerAgentMention({
  actorId,
  name,
  token,
}: {
  actorId: string;
  name: string;
  token: string;
}) {
  const style = useAgentMentionStyle(actorId, name);
  return (
    <span className="composer-agent-mention" style={style}>
      <span className="composer-agent-mention-at">
        @
        <span aria-hidden="true" className="composer-agent-mention-avatar">
          <ActorAvatar
            actorId={actorId}
            kind="agent"
            name={name}
            showTitle={false}
            size="micro"
          />
        </span>
      </span>
      {token.slice(1)}
    </span>
  );
}
