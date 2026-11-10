import type {
  TeamHubActorRef,
  TeamHubDocumentComment,
  TeamHubDocumentCommentThread,
} from "@/features/teamhub/teamhub-types";

export const commentActor: TeamHubActorRef = {
  display_name: "Jenny",
  id: "actor_human_1",
  kind: "human",
  tenant_id: "tenant_1",
};
const createdAt = "2026-08-28T00:00:00Z";

// Pure response data only; no simulated persistence or business rules.
export function commentResponse(
  id: string,
  threadId: string,
  body: string,
): TeamHubDocumentComment {
  return {
    author: commentActor,
    body,
    created_at: createdAt,
    id,
    reactions: [],
    segments: [{ content: body, type: "text" }],
    thread_id: threadId,
    updated_at: createdAt,
    version_number: 1,
  };
}

export function commentThreadResponse(
  id: string,
  body: string,
): TeamHubDocumentCommentThread {
  return {
    anchor: {
      block_id: "",
      context_after: "",
      context_before: "",
      created_at: createdAt,
      created_by: commentActor,
      document_version_id: "version_1",
      id: `${id}_anchor`,
      kind: "document_version",
      quoted_text: "review.pdf",
    },
    anchor_status: "attached",
    comments: [commentResponse(`${id}_comment`, id, body)],
    created_at: createdAt,
    created_by: commentActor,
    document_id: "document_1",
    id,
    resolved: false,
    updated_at: createdAt,
  };
}
