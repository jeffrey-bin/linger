import type { ThreadData } from "@blocknote/core/comments";
import { QuoteDownIcon, RotateLeft01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";

import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";

import { RoomDocumentCommentAgentReplying } from "./room-document-comment-agent-replying";
import { RoomDocumentCommentReplyComposer } from "./room-document-comment-reply-composer";
import { RoomDocumentCommentRow } from "./room-document-comment-row";
import {
  visibleThreadComments,
  type TeamHubDocumentThreadStore,
} from "./room-document-comments";

export function RoomDocumentCommentThread({
  anchorPosition,
  mentionOptions,
  actorDirectory = mentionOptions,
  onFocus,
  orphaned,
  referenceText,
  selected,
  thread,
  threadStore,
}: {
  actorDirectory?: TeamHubActorRef[];
  anchorPosition?: number;
  mentionOptions: TeamHubActorRef[];
  onFocus: () => void;
  orphaned: boolean;
  referenceText: string;
  selected: boolean;
  thread: ThreadData;
  threadStore: TeamHubDocumentThreadStore;
}) {
  const actors = useMemo(
    () => new Map(actorDirectory.map((actor) => [actor.id, actor])),
    [actorDirectory],
  );
  const [attachmentPending, setAttachmentPending] = useState(false);
  const metadata = thread.metadata as
    | { anchorStatus?: string; attachmentError?: string }
    | undefined;
  const selectionPending = metadata?.anchorStatus === "pending";

  async function retryAttachment() {
    setAttachmentPending(true);
    try {
      await threadStore.attachSelectionAnchor(thread.id);
    } finally {
      setAttachmentPending(false);
    }
  }

  return (
    // The card mirrors clicking the highlight in the document. Keyboard users
    // reach the same action from the reference button inside this card, and an
    // interactive role cannot be used because the card contains its own
    // buttons and reply editor.
    // react-doctor-disable-next-line no-noninteractive-element-interactions
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- clicking the card selects its thread; the card controls stay keyboard accessible
    <article
      aria-label={`Comment on ${referenceText}`}
      className="room-document-comment-thread"
      data-anchor-pos={anchorPosition}
      data-comment-card={thread.id}
      id={`room-document-comment-thread-${thread.id}`}
      data-orphaned={String(orphaned && !thread.resolved)}
      data-selected={String(selected)}
      onClick={(event) => {
        // Clicking anywhere on the card reaches its anchored text, mirroring
        // clicking the highlight to reach the card. Controls and the reply
        // editor keep their own behaviour.
        if (
          (event.target as HTMLElement).closest(
            "button, a, input, textarea, [contenteditable='true']",
          )
        ) {
          return;
        }
        onFocus();
      }}
      onKeyDown={(event) => {
        // Keyboard users reach the same action from the reference button, so
        // this only mirrors it when the card itself holds focus.
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onFocus();
      }}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the comment card is focusable so keyboard users can reach its anchored text
      tabIndex={0}
    >
      <header className="room-document-comment-thread-header">
        <button
          className="room-document-comment-reference"
          onClick={onFocus}
          type="button"
          title={orphaned ? "Deleted reference" : referenceText}
          disabled={orphaned || selectionPending}
        >
          <Icon icon={QuoteDownIcon} size={14} />
          <span>{orphaned ? "Deleted reference" : referenceText}</span>
        </button>
      </header>

      <div className="room-document-comment-list">
        {visibleThreadComments(thread).map((comment) => (
          <RoomDocumentCommentRow
            actors={actors}
            comment={comment}
            key={comment.id}
            mentionOptions={mentionOptions}
            threadId={thread.id}
            threadStore={threadStore}
          />
        ))}
      </div>
      <RoomDocumentCommentAgentReplying
        actors={actors}
        anchorText={orphaned ? null : referenceText}
        thread={thread}
      />
      {selectionPending && metadata?.attachmentError ? (
        <div className="mt-2" role="alert">
          <p className="text-xs text-app-danger">
            Comment saved, but it couldn't be linked to the selected text.
          </p>
          <Button
            className="mt-2"
            disabled={attachmentPending}
            onClick={() => void retryAttachment()}
            size="compact"
            tone="secondary"
          >
            <Icon icon={RotateLeft01Icon} size={14} />
            {attachmentPending ? "Retrying..." : "Retry linking"}
          </Button>
        </div>
      ) : null}
      {!thread.resolved && threadStore.auth.canAddComment(thread) ? (
        <RoomDocumentCommentReplyComposer
          mentionOptions={mentionOptions}
          threadId={thread.id}
          threadStore={threadStore}
        />
      ) : null}
    </article>
  );
}
