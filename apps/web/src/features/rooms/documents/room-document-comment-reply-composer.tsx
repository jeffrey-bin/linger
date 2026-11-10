import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";

import { commentBodyFromComposition } from "./room-document-comment-body";
import { DocumentMentionMessageComposer } from "./room-document-comment-composer";
import type { TeamHubDocumentThreadStore } from "./room-document-comments";

export function RoomDocumentCommentReplyComposer({
  mentionOptions,
  threadId,
  threadStore,
}: {
  mentionOptions: TeamHubActorRef[];
  threadId: string;
  threadStore: TeamHubDocumentThreadStore;
}) {
  return (
    <div className="room-document-comment-reply">
      <DocumentMentionMessageComposer
        ariaLabel="Reply to Document comment"
        mentionOptions={mentionOptions}
        onSubmit={async (composition) => {
          await threadStore.addComment({
            comment: { body: commentBodyFromComposition(composition) },
            threadId,
          });
        }}
        placeholder="Reply..."
      />
    </div>
  );
}
