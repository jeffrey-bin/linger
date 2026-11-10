import { CommentsExtension } from "@blocknote/core/comments";
import { useBlockNoteEditor, useExtension } from "@blocknote/react";
import { useEffect, useRef } from "react";

import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import {
  MessageComposer,
  type MessageComposition,
  type MessageComposerHandle,
} from "../chat/message-composer";

import { commentBodyFromComposition } from "./room-document-comment-body";

interface DocumentMentionComposerProps {
  ariaLabel?: string;
  autoFocus?: boolean;
  initialMentions?: TeamHubActorRef[];
  initialValue?: string;
  mentionDirectoryError?: boolean;
  mentionDirectoryLoading?: boolean;
  mentionOptions: TeamHubActorRef[];
  onCancel?: () => void;
  placeholder?: string;
  submitLabel?: string;
}

export function RoomDocumentCommentComposer(
  props: DocumentMentionComposerProps,
) {
  const editor = useBlockNoteEditor();
  const comments = useExtension(CommentsExtension);
  return (
    <DocumentMentionMessageComposer
      {...props}
      // eslint-disable-next-line jsx-a11y/no-autofocus -- the field is focused on purpose because the user just opened this dialog or inline editor
      autoFocus
      onSubmit={async (composition) => {
        await comments.createThread({
          initialComment: {
            body: commentBodyFromComposition(composition),
          },
        });
        comments.stopPendingComment();
      }}
      onSubmitted={() => editor.focus()}
    />
  );
}

export function DocumentMentionMessageComposer({
  ariaLabel = "New Document comment",
  autoFocus = false,
  initialMentions,
  initialValue,
  mentionDirectoryError = false,
  mentionDirectoryLoading = false,
  mentionOptions,
  onCancel,
  onSubmit,
  onSubmitted,
  placeholder = "Add a comment",
  submitLabel,
}: DocumentMentionComposerProps & {
  onSubmit: (composition: MessageComposition) => Promise<void>;
  onSubmitted?: () => void;
}) {
  const composerRef = useRef<MessageComposerHandle>(null);
  useEffect(() => {
    // Native autofocus runs before the anchored card is positioned and can
    // scroll the shared document container back to the top.
    if (autoFocus) composerRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  return (
    <div
      aria-busy={mentionDirectoryLoading}
      className="room-document-comment-composer"
    >
      <MessageComposer
        ariaLabel={ariaLabel}
        ref={composerRef}
        documentMentionsEnabled={false}
        initialMentions={initialMentions}
        initialValue={initialValue}
        mentionOptions={mentionOptions}
        onCancel={onCancel}
        submitLabel={submitLabel}
        onSend={async (composition) => {
          await onSubmit(composition);
          onSubmitted?.();
        }}
        placeholder={placeholder}
      />
      {mentionDirectoryError ? (
        <p className="mt-2 text-xs text-app-danger" role="alert">
          Mention directory is unavailable.
        </p>
      ) : null}
    </div>
  );
}
