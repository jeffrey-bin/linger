import type { ClipboardEvent } from "react";

import { readDocumentClipboardLink } from "@/features/rooms/files/document-clipboard-link";
import type { MessageComposerProps } from "./message-composer";
import {
  formatDocumentToken,
  type MessageDocumentOption,
  parseInternalDocumentLink,
} from "./message-composer-references";
import {
  type ComposerAttachments,
  filesFromClipboard,
} from "./use-composer-attachments";
import type { ComposerDraft } from "./use-composer-draft";
import type { ComposerPicker } from "./use-composer-picker";

export interface ComposerDocumentPasteInput {
  attachments: ComposerAttachments;
  disabled: boolean;
  documentOptionsReady?: boolean;
  draft: ComposerDraft;
  picker: ComposerPicker;
  resolveDocumentLink?: MessageComposerProps["resolveDocumentLink"];
}

/**
 * Pastes clipboard files as attachments and internal Document links as
 * structured Document tokens, resolving links the catalog cannot authorize.
 */
export function useComposerDocumentPaste({
  attachments: { addFiles },
  disabled,
  documentOptionsReady,
  draft: {
    body,
    bodyRef,
    documentContexts,
    documentOptions,
    pendingCaretRef,
    resolvingDocumentLinksRef,
    selectedDocumentsRef,
    setMessageError,
    setResolvedDocumentOptions,
    setResolvingDocumentLinks,
    submitting,
    updateBody,
  },
  picker: { closePicker },
  resolveDocumentLink,
}: ComposerDocumentPasteInput) {
  function pasteUnresolvedDocumentLink(
    event: ClipboardEvent<HTMLTextAreaElement>,
    link: NonNullable<ReturnType<typeof parseInternalDocumentLink>>,
    pasted: string,
    resolve: NonNullable<MessageComposerProps["resolveDocumentLink"]>,
  ) {
    event.preventDefault();
    const start = event.currentTarget.selectionStart ?? body.length;
    const end = event.currentTarget.selectionEnd ?? start;
    const bodyBeforePaste = body;
    const clipboardLink = readDocumentClipboardLink(
      event.clipboardData,
      window.location.origin,
    );
    const provisional: MessageDocumentOption = {
      documentId: link.documentId,
      name: clipboardLink?.title ?? "Document",
      tenantId: link.tenantId,
      updatedAt: "",
    };
    const provisionalOptions = [...documentOptions, provisional];
    const before = bodyBeforePaste.slice(0, start);
    const after = bodyBeforePaste.slice(end);
    const provisionalToken = formatDocumentToken(
      provisional,
      provisionalOptions,
    );
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = !after || !/^\s/.test(after) ? " " : "";
    const tokenStart = before.length + prefix.length;
    const provisionalBody = `${before}${prefix}${provisionalToken}${suffix}${after}`;
    pendingCaretRef.current =
      tokenStart + provisionalToken.length + suffix.length;
    setResolvedDocumentOptions((current) => [
      ...current.filter(
        (option) => option.documentId !== provisional.documentId,
      ),
      provisional,
    ]);
    selectedDocumentsRef.current = [
      ...selectedDocumentsRef.current.filter(
        (item) => item.documentId !== provisional.documentId,
      ),
      { documentId: provisional.documentId, token: provisionalToken },
    ];
    updateBody(provisionalBody, documentContexts, provisionalOptions);
    closePicker();
    resolvingDocumentLinksRef.current += 1;
    setResolvingDocumentLinks(resolvingDocumentLinksRef.current);
    void resolve(link)
      .then((resolved) => {
        if (
          resolved.documentId !== link.documentId ||
          (resolved.tenantId !== undefined &&
            resolved.tenantId !== link.tenantId)
        ) {
          throw new Error("Document cannot be shared in this Room.");
        }
        const options = [...documentOptions, resolved];
        const token = formatDocumentToken(resolved, options);
        const nextBody = replacePendingDocumentToken(
          bodyRef.current,
          tokenStart,
          provisionalToken,
          token,
        );
        setResolvedDocumentOptions((current) => [
          ...current.filter(
            (option) => option.documentId !== resolved.documentId,
          ),
          resolved,
        ]);
        selectedDocumentsRef.current = [
          ...selectedDocumentsRef.current.filter(
            (item) => item.documentId !== resolved.documentId,
          ),
          { documentId: resolved.documentId, token },
        ];
        updateBody(nextBody, documentContexts, options);
      })
      .catch((error) => {
        const restoredBody = replacePendingDocumentToken(
          bodyRef.current,
          tokenStart,
          provisionalToken,
          pasted,
        );
        setResolvedDocumentOptions((current) =>
          current.filter(
            (option) => option.documentId !== provisional.documentId,
          ),
        );
        selectedDocumentsRef.current = selectedDocumentsRef.current.filter(
          (item) => item.documentId !== provisional.documentId,
        );
        updateBody(restoredBody, documentContexts, documentOptions);
        setMessageError(
          error instanceof Error
            ? error.message
            : "Document cannot be shared in this Room.",
        );
      })
      .finally(() => {
        resolvingDocumentLinksRef.current = Math.max(
          0,
          resolvingDocumentLinksRef.current - 1,
        );
        setResolvingDocumentLinks(resolvingDocumentLinksRef.current);
      });
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (disabled || submitting) return;
    const clipboardFiles = filesFromClipboard(event.clipboardData);
    if (clipboardFiles.length > 0) {
      if (addFiles(clipboardFiles)) event.preventDefault();
      return;
    }
    if (!documentOptionsReady) return;
    const pasted = event.clipboardData.getData("text/plain");
    const link = parseInternalDocumentLink(pasted, window.location.origin);
    if (!link) return;
    const document = documentOptions.find(
      (option) =>
        option.documentId === link.documentId &&
        (!option.tenantId || option.tenantId === link.tenantId),
    );
    if (!document || document.requiresRoomBinding) {
      if (!resolveDocumentLink) return;
      pasteUnresolvedDocumentLink(event, link, pasted, resolveDocumentLink);
      return;
    }

    event.preventDefault();
    const start = event.currentTarget.selectionStart ?? body.length;
    const end = event.currentTarget.selectionEnd ?? start;
    const token = formatDocumentToken(document, documentOptions);
    const before = body.slice(0, start);
    const after = body.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = !after || !/^\s/.test(after) ? " " : "";
    const nextBody = `${before}${prefix}${token}${suffix}${after}`;
    pendingCaretRef.current =
      before.length + prefix.length + token.length + suffix.length;
    selectedDocumentsRef.current = [
      ...selectedDocumentsRef.current.filter((item) => item.token !== token),
      {
        documentId: document.documentId,
        token,
      },
    ];
    updateBody(nextBody);
    closePicker();
  }

  return { handlePaste };
}

function replacePendingDocumentToken(
  body: string,
  expectedStart: number,
  pendingToken: string,
  replacement: string,
) {
  if (
    body.slice(expectedStart, expectedStart + pendingToken.length) ===
    pendingToken
  ) {
    return `${body.slice(0, expectedStart)}${replacement}${body.slice(expectedStart + pendingToken.length)}`;
  }
  const match = body.indexOf(pendingToken);
  if (match < 0 || match !== body.lastIndexOf(pendingToken)) return body;
  return `${body.slice(0, match)}${replacement}${body.slice(match + pendingToken.length)}`;
}
