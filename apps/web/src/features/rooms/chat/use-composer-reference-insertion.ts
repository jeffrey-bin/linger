import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import type { MessageComposerProps } from "./message-composer";
import {
  formatDocumentToken,
  formatSkillToken,
  type MessageDocumentOption,
  type MessageSkillOption,
  replaceComposerToken,
} from "./message-composer-references";
import { formatMentionToken, replaceMessageMention } from "./message-mentions";
import type { ComposerDraft } from "./use-composer-draft";
import type { AtPickerItem, ComposerPicker } from "./use-composer-picker";

export interface ComposerReferenceInsertionInput {
  draft: ComposerDraft;
  picker: ComposerPicker;
  resolveDocumentLink?: MessageComposerProps["resolveDocumentLink"];
  skillOptions: MessageSkillOption[];
}

/** Inserts picked or imperatively added people, Documents, and Skills. */
export function useComposerReferenceInsertion({
  draft: {
    body,
    bodyRef,
    documentContexts,
    documentOptions,
    pendingCaretRef,
    resolvingDocumentLinksRef,
    selectedDocumentsRef,
    selectedMentionsRef,
    selectedSkillsRef,
    setMessageError,
    setResolvedDocumentOptions,
    setResolvingDocumentLinks,
    textareaRef,
    updateBody,
  },
  picker: {
    applyMentionQuery,
    closePicker,
    mentionQuery,
    setMentionSelection,
    setSkillQuery,
    skillQuery,
  },
  resolveDocumentLink,
  skillOptions,
}: ComposerReferenceInsertionInput) {
  function insertMention(actor: TeamHubActorRef) {
    if (!mentionQuery) {
      return;
    }

    const next = replaceMessageMention(body, mentionQuery, actor);
    pendingCaretRef.current = next.cursor;
    selectedDocumentsRef.current = selectedDocumentsRef.current.filter(
      (item) => item.token !== formatMentionToken(actor),
    );
    if (!selectedMentionsRef.current.some((item) => item.id === actor.id)) {
      selectedMentionsRef.current = [...selectedMentionsRef.current, actor];
    }
    updateBody(next.body);
    closePicker();
    setMentionSelection(0);
  }

  function insertAtPickerItem(item: AtPickerItem) {
    if (item.kind === "actor") {
      insertMention(item.actor);
      return;
    }
    insertDocument(item.document);
  }

  function insertDocument(document: MessageDocumentOption) {
    if (!mentionQuery) return;
    if (document.requiresRoomBinding) {
      if (!resolveDocumentLink || !document.tenantId) {
        setMessageError("Document cannot be shared in this Room.");
        return;
      }
      const selection = mentionQuery;
      const initialBody = body;
      resolvingDocumentLinksRef.current += 1;
      setResolvingDocumentLinks(resolvingDocumentLinksRef.current);
      setMessageError(null);
      closePicker();
      void resolveDocumentLink({
        bindToRoom: true,
        documentId: document.documentId,
        tenantId: document.tenantId,
      })
        .then((resolved) => {
          if (bodyRef.current !== initialBody) return;
          const token = formatDocumentToken(resolved, documentOptions);
          const next = replaceComposerToken(initialBody, selection, token);
          pendingCaretRef.current = next.cursor;
          setResolvedDocumentOptions((current) => [
            ...current.filter(
              (item) => item.documentId !== resolved.documentId,
            ),
            resolved,
          ]);
          selectedDocumentsRef.current = [
            ...selectedDocumentsRef.current.filter(
              (item) => item.documentId !== resolved.documentId,
            ),
            { documentId: resolved.documentId, token },
          ];
          updateBody(next.body, documentContexts, [
            ...documentOptions.filter(
              (item) => item.documentId !== resolved.documentId,
            ),
            resolved,
          ]);
        })
        .catch(() =>
          setMessageError(
            "Document could not be shared in this Room. Check your access and try again.",
          ),
        )
        .finally(() => {
          resolvingDocumentLinksRef.current = Math.max(
            0,
            resolvingDocumentLinksRef.current - 1,
          );
          setResolvingDocumentLinks(resolvingDocumentLinksRef.current);
        });
      return;
    }
    const token = formatDocumentToken(document, documentOptions);
    const next = replaceComposerToken(body, mentionQuery, token);
    pendingCaretRef.current = next.cursor;
    // Pin the selection: the catalog may drop it once the search query closes.
    setResolvedDocumentOptions((current) => [
      ...current.filter((item) => item.documentId !== document.documentId),
      document,
    ]);
    selectedMentionsRef.current = selectedMentionsRef.current.filter(
      (actor) => formatMentionToken(actor) !== token,
    );
    selectedDocumentsRef.current = [
      ...selectedDocumentsRef.current.filter((item) => item.token !== token),
      {
        documentId: document.documentId,
        token,
      },
    ];
    updateBody(next.body);
    applyMentionQuery(null);
    setSkillQuery(null);
  }

  function insertSkill(skill: MessageSkillOption) {
    if (!skillQuery) return;
    const token = formatSkillToken(skill, skillOptions);
    const next = replaceComposerToken(body, skillQuery, token);
    pendingCaretRef.current = next.cursor;
    selectedSkillsRef.current = [
      ...selectedSkillsRef.current.filter(
        (item) => !(item.target === skill.agent.id && item.token === token),
      ),
      {
        manifestVersion: skill.manifestVersion,
        skillId: skill.skillId,
        target: skill.agent.id,
        token,
      },
    ];
    updateBody(next.body);
    setSkillQuery(null);
  }

  function insertMentionAtCursor(actor: TeamHubActorRef) {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? body.length;
    const before = body.slice(0, cursor);
    const after = body.slice(textarea?.selectionEnd ?? cursor);
    const prefix = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const suffix = after.length === 0 || !/^\s/.test(after) ? " " : "";
    const token = formatMentionToken(actor);
    const nextBody = `${before}${prefix}${token}${suffix}${after}`;
    pendingCaretRef.current =
      before.length + prefix.length + token.length + suffix.length;
    if (!selectedMentionsRef.current.some((item) => item.id === actor.id)) {
      selectedMentionsRef.current = [...selectedMentionsRef.current, actor];
    }
    updateBody(nextBody);
    applyMentionQuery(null);
    setSkillQuery(null);
  }

  return {
    insertAtPickerItem,
    insertMentionAtCursor,
    insertSkill,
  };
}

export type ComposerReferenceInsertion = ReturnType<
  typeof useComposerReferenceInsertion
>;
