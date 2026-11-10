import {
  type ForwardedRef,
  type RefObject,
  useImperativeHandle,
  useLayoutEffect,
} from "react";

import type { MessageComposerHandle } from "./message-composer";
import type { ComposerAttachments } from "./use-composer-attachments";
import type { ComposerDraft } from "./use-composer-draft";
import type { ComposerPicker } from "./use-composer-picker";
import type { ComposerReferenceInsertion } from "./use-composer-reference-insertion";
import { useVoiceModeTextareaLayout } from "./voice-mode/use-voice-mode-textarea-layout";

const maximumComposerHeight = 400;

export interface ComposerTextareaInput {
  attachments: ComposerAttachments;
  draft: ComposerDraft;
  insertion: ComposerReferenceInsertion;
  picker: ComposerPicker;
  ref: ForwardedRef<MessageComposerHandle>;
  voiceModeEntered: boolean;
}

/** Exposes the composer handle and keeps the editor's size and caret in sync. */
export function useComposerTextarea({
  attachments: { addFiles, canAcceptFiles },
  draft: {
    body,
    highlightContentRef,
    pendingCaretRef,
    selectedDocumentsRef,
    selectedMentionsRef,
    selectedSkillsRef,
    setMessageError,
    textareaRef,
    updateBody,
    visibleBody,
  },
  insertion: { insertMentionAtCursor },
  picker: { applyMentionQuery, setSkillQuery },
  ref,
  voiceModeEntered,
}: ComposerTextareaInput) {
  useImperativeHandle(ref, () => ({
    addFiles,
    canAcceptFiles,
    clearCommittedBody: (committedBody) => {
      if (body.trim() !== committedBody) return;
      updateBody("");
      setMessageError(null);
      applyMentionQuery(null);
      setSkillQuery(null);
      selectedMentionsRef.current = [];
      selectedDocumentsRef.current = [];
      selectedSkillsRef.current = [];
    },
    focus: (options) => {
      const textarea = textareaRef.current;
      textarea?.focus(options);
      // Continue an existing draft rather than typing ahead of it.
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    },
    insertMention: insertMentionAtCursor,
  }));

  useVoiceModeTextareaLayout({
    active: voiceModeEntered,
    text: visibleBody,
    textareaRef,
  });
  useComposerTextareaLayout(
    body,
    textareaRef,
    pendingCaretRef,
    highlightContentRef,
    voiceModeEntered,
  );
}

export function syncComposerHighlightScroll(
  textarea: HTMLTextAreaElement | null,
  highlightContent: HTMLDivElement | null,
) {
  if (!textarea || !highlightContent) return;
  highlightContent.style.transform = textarea.value
    ? `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`
    : "translate(0px, 0px)";
}

function useComposerTextareaLayout(
  body: string,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  pendingCaretRef: RefObject<number | null>,
  highlightContentRef: RefObject<HTMLDivElement | null>,
  voiceModeActive = false,
) {
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (voiceModeActive || !textarea || typeof ResizeObserver === "undefined")
      return;
    let observedWidth: number | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === observedWidth) return;
      observedWidth = entry.contentRect.width;
      resizeComposer(textarea);
      syncComposerHighlightScroll(textarea, highlightContentRef.current);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [highlightContentRef, textareaRef, voiceModeActive]);

  useLayoutEffect(() => {
    if (!voiceModeActive) resizeComposer(textareaRef.current);
    syncComposerHighlightScroll(
      textareaRef.current,
      highlightContentRef.current,
    );
    if (pendingCaretRef.current !== null) {
      textareaRef.current?.setSelectionRange(
        pendingCaretRef.current,
        pendingCaretRef.current,
      );
      textareaRef.current?.focus();
      pendingCaretRef.current = null;
    }
  }, [
    body,
    highlightContentRef,
    pendingCaretRef,
    textareaRef,
    voiceModeActive,
  ]);
}

function resizeComposer(textarea: HTMLTextAreaElement | null) {
  if (!textarea) {
    return;
  }

  const box = textarea.closest<HTMLElement>(".message-composer-box");
  // Measure at the single-line width: the Document comment pill widens its
  // editor once multiline, which would otherwise alternate near the wrap edge.
  box?.removeAttribute("data-multiline");
  textarea.style.overflowY = "hidden";
  // The empty editor keeps its CSS one-line height. Reading scrollHeight here
  // would synchronously lay out the newly mounted Room just to rediscover it.
  if (!textarea.value) {
    textarea.style.height = "";
    return;
  }
  // The height it shows now, so a change can ease from it once measured.
  const previousHeight = textarea.style.height;
  textarea.style.height = "auto";
  const style = getComputedStyle(textarea);
  const singleLineHeight = Math.max(
    Number.parseFloat(style.minHeight) || 0,
    (Number.parseFloat(style.lineHeight) || 20) +
      (Number.parseFloat(style.paddingTop) || 0) +
      (Number.parseFloat(style.paddingBottom) || 0),
  );
  const maximumHeight =
    Number.parseFloat(style.maxHeight) || maximumComposerHeight;
  const contentHeight = textarea.scrollHeight;
  if (box && contentHeight > singleLineHeight + 1) {
    box.dataset.multiline = "true";
  }

  const nextHeight = `${Math.min(contentHeight, maximumHeight)}px`;
  if (previousHeight && previousHeight !== nextHeight) {
    // Restore the old height and commit it, so the CSS transition runs.
    textarea.style.height = previousHeight;
    void textarea.offsetHeight;
  }
  textarea.style.height = nextHeight;
  textarea.style.overflowY = contentHeight > maximumHeight ? "auto" : "hidden";
}
