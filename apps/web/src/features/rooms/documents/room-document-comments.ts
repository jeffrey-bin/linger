import type {
  CommentBody,
  CommentData,
  ThreadData,
} from "@blocknote/core/comments";
import { ThreadStore, ThreadStoreAuth } from "@blocknote/core/comments";
import { queryOptions } from "@tanstack/react-query";

import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubDocumentComment,
  TeamHubDocumentCommentAnchorInput,
  TeamHubDocumentCommentCurrentContext,
  TeamHubDocumentCommentDurableHead,
  TeamHubDocumentCommentThread,
  TeamHubDocumentCommentThreadCreateInput,
} from "@/features/teamhub/teamhub-types";
import { collectTeamHubCursorPages } from "@/features/teamhub/teamhub-cursor-pages";

import { roomDocumentCommentThreadsQueryKey } from "../room-queries";

export type RoomDocumentCommentAnchor = TeamHubDocumentCommentAnchorInput;

export function roomDocumentCommentThreadsQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  roomId: string,
  documentId: string,
) {
  return queryOptions({
    queryFn: async () => {
      const page = await collectTeamHubCursorPages(
        (page) =>
          teamHubData(
            client.api.GET("/v0/documents/{documentId}/comment-threads", {
              params: { path: { documentId }, query: page },
            }),
          ),
        { pageSize: 100 },
      );
      const threads = page.items;
      if (threads.some((thread) => thread.document_id !== documentId)) {
        throw new Error(
          "TeamHub returned Comment Threads outside the Document",
        );
      }
      return threads;
    },
    queryKey: roomDocumentCommentThreadsQueryKey(tenantId, roomId, documentId),
    staleTime: 10_000,
  });
}

export function createTeamHubDocumentThreadStore(input: {
  attachSelectionAnchors?: boolean;
  client: TeamHubClient;
  currentActorId: string;
  documentId: string;
  currentContext?: TeamHubDocumentCommentCurrentContext;
  getCurrentAnchor: () => RoomDocumentCommentAnchor;
  getDurableHead: () => TeamHubDocumentCommentDurableHead | undefined;
  onSelectionAnchorAttached?: () => void;
}) {
  return new TeamHubDocumentThreadStore(input);
}

export class TeamHubDocumentThreadStore extends ThreadStore {
  declare addThreadToDocument: undefined;

  readonly #client: TeamHubClient;
  readonly #attachSelectionAnchors: boolean;
  readonly #documentId: string;
  readonly #currentContext?: TeamHubDocumentCommentCurrentContext;
  readonly #getCurrentAnchor: () => RoomDocumentCommentAnchor;
  readonly #getDurableHead: () => TeamHubDocumentCommentDurableHead | undefined;
  readonly #listeners = new Set<(threads: Map<string, ThreadData>) => void>();
  readonly #durableThreads = new Map<string, TeamHubDocumentCommentThread>();
  readonly #threads = new Map<string, ThreadData>();
  readonly #attachmentAttempts = new Map<
    string,
    {
      error?: string;
      head?: TeamHubDocumentCommentDurableHead;
    }
  >();
  readonly #onSelectionAnchorAttached?: () => void;

  constructor(input: {
    attachSelectionAnchors?: boolean;
    client: TeamHubClient;
    currentActorId: string;
    documentId: string;
    currentContext?: TeamHubDocumentCommentCurrentContext;
    getCurrentAnchor: () => RoomDocumentCommentAnchor;
    getDurableHead: () => TeamHubDocumentCommentDurableHead | undefined;
    onSelectionAnchorAttached?: () => void;
  }) {
    super(new TeamHubDocumentThreadStoreAuth(input.currentActorId));
    this.#client = input.client;
    this.#attachSelectionAnchors = input.attachSelectionAnchors ?? false;
    this.#documentId = input.documentId;
    this.#currentContext = input.currentContext;
    this.#getCurrentAnchor = input.getCurrentAnchor;
    this.#getDurableHead = input.getDurableHead;
    this.#onSelectionAnchorAttached = input.onSelectionAnchorAttached;
  }

  replaceThreads(threads: TeamHubDocumentCommentThread[]): void {
    this.#durableThreads.clear();
    this.#threads.clear();
    for (const thread of threads) {
      this.#setThread(thread);
    }
    this.#emit();
  }

  async reanchorThread(threadId: string): Promise<void> {
    this.#requireDurableThread(threadId);
    const thread = await teamHubData(
      this.#client.api.POST(
        "/v0/document-comment-threads/{documentCommentThreadId}/anchors",
        {
          params: { path: { documentCommentThreadId: threadId } },
          body: this.#getCurrentAnchor(),
        },
      ),
    );
    this.#upsertThread(thread);
  }

  async createThread(options: {
    initialComment: { body: CommentBody; metadata?: unknown };
    metadata?: unknown;
  }): Promise<ThreadData> {
    const durableHead = this.#requireDurableHead();
    const request: TeamHubDocumentCommentThreadCreateInput = {
      anchor: this.#getCurrentAnchor(),
      current_context: this.#currentContext,
      durable_head: durableHead,
      initial_comment: {
        segments: commentBodyToSegments(options.initialComment.body),
      },
    };
    const thread = await teamHubData(
      this.#client.api.POST("/v0/documents/{documentId}/comment-threads", {
        params: { path: { documentId: this.#documentId } },
        body: request,
      }),
    );
    this.#upsertThread(thread);
    if (
      this.#attachSelectionAnchors &&
      thread.anchor.kind === "selection" &&
      thread.anchor_status === "pending"
    ) {
      this.#attachmentAttempts.set(thread.id, { head: durableHead });
      await this.attachSelectionAnchor(thread.id);
    }
    return this.getThread(thread.id);
  }

  async attachSelectionAnchor(threadId: string): Promise<void> {
    const thread = this.#requireDurableThread(threadId);
    if (thread.anchor_status === "attached") return;
    if (
      thread.anchor.kind !== "selection" ||
      thread.anchor_status !== "pending"
    ) {
      throw new Error("Document Comment Anchor cannot be attached");
    }
    const attempt = this.#attachmentAttempts.get(threadId) ?? {};
    this.#attachmentAttempts.set(threadId, attempt);
    try {
      attempt.head ??= this.#requireDurableHead();
      const result = await teamHubData(
        this.#client.api.POST(
          "/v0/document-comment-threads/{documentCommentThreadId}/anchor-attachments",
          {
            params: { path: { documentCommentThreadId: threadId } },
            body: {
              expected_full_state_fingerprint: attempt.head.state_hash,
              expected_persisted_seq: attempt.head.persisted_seq,
            },
          },
        ),
      );
      this.#attachmentAttempts.delete(threadId);
      this.#upsertThread(result.thread);
      this.#onSelectionAnchorAttached?.();
    } catch (error) {
      attempt.error =
        error instanceof Error
          ? error.message
          : "Comment Anchor could not be attached.";
      this.#setThread(thread);
      this.#emit();
    }
  }

  async addComment(options: {
    comment: { body: CommentBody; metadata?: unknown };
    threadId: string;
  }): Promise<CommentData> {
    this.#requireDurableThread(options.threadId);
    const comment = await teamHubData(
      this.#client.api.POST(
        "/v0/document-comment-threads/{documentCommentThreadId}/comments",
        {
          params: { path: { documentCommentThreadId: options.threadId } },
          body: {
            current_context: this.#currentContext,
            durable_head: this.#requireDurableHead(),
            segments: commentBodyToSegments(options.comment.body),
          },
        },
      ),
    );
    this.#replaceComment(options.threadId, comment, false);
    return projectComment(comment);
  }

  async updateComment(options: {
    comment: { body: CommentBody; metadata?: unknown };
    threadId: string;
    commentId: string;
  }): Promise<void> {
    const current = this.#requireComment(options.threadId, options.commentId);
    const comment = await teamHubData(
      this.#client.api.PATCH("/v0/document-comments/{documentCommentId}", {
        params: { path: { documentCommentId: options.commentId } },
        body: {
          current_context: this.#currentContext,
          durable_head: this.#requireDurableHead(),
          expected_version: current.version_number,
          segments: commentBodyToSegments(options.comment.body),
        },
      }),
    );
    this.#replaceComment(options.threadId, comment, true);
  }

  async deleteComment(options: {
    threadId: string;
    commentId: string;
  }): Promise<void> {
    const current = this.#requireComment(options.threadId, options.commentId);
    const comment = await teamHubData(
      this.#client.api.DELETE("/v0/document-comments/{documentCommentId}", {
        params: { path: { documentCommentId: options.commentId } },
        body: { expected_version: current.version_number },
      }),
    );
    this.#replaceComment(options.threadId, comment, true);
  }

  async deleteThread(): Promise<void> {
    throw new Error("Document Comment Threads cannot be deleted");
  }

  async resolveThread(): Promise<void> {
    throw new Error("Document Comment Threads cannot be resolved");
  }

  async unresolveThread(): Promise<void> {
    throw new Error("Document Comment Threads cannot be resolved");
  }

  async addReaction(options: {
    threadId: string;
    commentId: string;
    emoji: string;
  }): Promise<void> {
    this.#requireComment(options.threadId, options.commentId);
    await teamHubDone(
      this.#client.api.PUT(
        "/v0/document-comments/{documentCommentId}/reactions/{emoji}",
        {
          params: {
            path: {
              documentCommentId: options.commentId,
              emoji: options.emoji,
            },
          },
        },
      ),
    );
    await this.#refreshThread(options.threadId);
  }

  async deleteReaction(options: {
    threadId: string;
    commentId: string;
    emoji: string;
  }): Promise<void> {
    this.#requireComment(options.threadId, options.commentId);
    await teamHubDone(
      this.#client.api.DELETE(
        "/v0/document-comments/{documentCommentId}/reactions/{emoji}",
        {
          params: {
            path: {
              documentCommentId: options.commentId,
              emoji: options.emoji,
            },
          },
        },
      ),
    );
    await this.#refreshThread(options.threadId);
  }

  getThread(threadId: string): ThreadData {
    const thread = this.#threads.get(threadId);
    if (thread === undefined) {
      throw new Error("Document Comment Thread is unavailable");
    }
    return thread;
  }

  getThreads(): Map<string, ThreadData> {
    return new Map(this.#threads);
  }

  subscribe(cb: (threads: Map<string, ThreadData>) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #upsertThread(thread: TeamHubDocumentCommentThread): ThreadData {
    this.#setThread(thread);
    this.#emit();
    return this.#threads.get(thread.id)!;
  }

  #requireDurableHead(): TeamHubDocumentCommentDurableHead {
    const head = this.#getDurableHead();
    if (head === undefined) {
      throw new Error("Save the Document before creating or editing Comments");
    }
    return head;
  }

  #setThread(thread: TeamHubDocumentCommentThread): void {
    if (thread.document_id !== this.#documentId) {
      throw new Error("TeamHub returned a Comment Thread outside the Document");
    }
    this.#durableThreads.set(thread.id, thread);
    this.#threads.set(
      thread.id,
      projectThread(thread, this.#attachmentAttempts.get(thread.id)?.error),
    );
  }

  #replaceComment(
    threadId: string,
    comment: TeamHubDocumentComment,
    replace: boolean,
  ): void {
    const thread = this.#requireDurableThread(threadId);
    if (comment.thread_id !== threadId) {
      throw new Error("TeamHub returned a Comment outside the Thread");
    }
    const comments = replace
      ? thread.comments.map((current) =>
          current.id === comment.id ? comment : current,
        )
      : [...thread.comments, comment];
    if (replace && !comments.some((current) => current.id === comment.id)) {
      throw new Error("TeamHub returned an unknown Document Comment");
    }
    this.#upsertThread({ ...thread, comments, updated_at: comment.updated_at });
  }

  async #refreshThread(threadId: string): Promise<void> {
    const thread = await teamHubData(
      this.#client.api.GET(
        "/v0/document-comment-threads/{documentCommentThreadId}",
        { params: { path: { documentCommentThreadId: threadId } } },
      ),
    );
    this.#upsertThread(thread);
  }

  #requireDurableThread(threadId: string): TeamHubDocumentCommentThread {
    const thread = this.#durableThreads.get(threadId);
    if (thread === undefined) {
      throw new Error("Document Comment Thread is unavailable");
    }
    return thread;
  }

  #requireComment(threadId: string, commentId: string): TeamHubDocumentComment {
    const comment = this.#requireDurableThread(threadId).comments.find(
      (candidate) => candidate.id === commentId,
    );
    if (comment === undefined) {
      throw new Error("Document Comment is unavailable");
    }
    return comment;
  }

  #emit(): void {
    const threads = this.getThreads();
    for (const listener of this.#listeners) {
      listener(threads);
    }
  }
}

class TeamHubDocumentThreadStoreAuth extends ThreadStoreAuth {
  constructor(private readonly currentActorId: string) {
    super();
  }

  canCreateThread(): boolean {
    return true;
  }

  canAddComment(): boolean {
    return true;
  }

  canUpdateComment(comment: CommentData): boolean {
    return comment.userId === this.currentActorId;
  }

  canDeleteComment(comment: CommentData): boolean {
    return comment.userId === this.currentActorId;
  }

  canDeleteThread(): boolean {
    return false;
  }

  canResolveThread(): boolean {
    return false;
  }

  canUnresolveThread(): boolean {
    return false;
  }

  canAddReaction(comment: CommentData, emoji?: string): boolean {
    return !emoji || !hasCurrentReaction(comment, emoji, this.currentActorId);
  }

  canDeleteReaction(comment: CommentData, emoji?: string): boolean {
    return !emoji || hasCurrentReaction(comment, emoji, this.currentActorId);
  }
}

function projectThread(
  thread: TeamHubDocumentCommentThread,
  attachmentError?: string,
): ThreadData {
  return {
    comments: thread.comments.map(projectComment),
    createdAt: new Date(thread.created_at),
    id: thread.id,
    metadata: {
      anchor: thread.anchor,
      anchorStatus: thread.anchor_status,
      ...(attachmentError ? { attachmentError } : {}),
      documentId: thread.document_id,
    },
    resolved: thread.resolved,
    ...(thread.resolved_at === undefined
      ? {}
      : {
          resolvedBy: thread.resolved_by?.id,
          resolvedUpdatedAt: new Date(thread.resolved_at),
        }),
    type: "thread",
    updatedAt: new Date(thread.updated_at),
  };
}

function projectComment(comment: TeamHubDocumentComment): CommentData {
  const common = {
    createdAt: new Date(comment.created_at),
    id: comment.id,
    metadata: {
      author: comment.author,
      parentCommentId: comment.parent_comment_id,
      versionNumber: comment.version_number,
    },
    reactions: comment.reactions.map((reaction) => ({
      createdAt: new Date(reaction.created_at),
      emoji: reaction.emoji,
      userIds: reaction.actor_ids,
    })),
    type: "comment" as const,
    updatedAt: new Date(comment.updated_at),
    userId: comment.author.id,
  };
  return comment.deleted_at === undefined
    ? { ...common, body: segmentsToCommentBody(comment.segments) }
    : { ...common, body: undefined, deletedAt: new Date(comment.deleted_at) };
}

function segmentsToCommentBody(
  segments: TeamHubDocumentComment["segments"],
): CommentBody {
  return [
    {
      content: segments.map((segment) =>
        segment.type === "reference"
          ? {
              props: { actorId: segment.actor_id, label: segment.content },
              type: "mention",
            }
          : { styles: {}, text: segment.content, type: "text" },
      ),
      props: {},
      type: "paragraph",
    },
  ];
}

function commentBodyToSegments(
  body: CommentBody,
): TeamHubDocumentCommentThreadCreateInput["initial_comment"]["segments"] {
  if (!Array.isArray(body)) {
    throw new Error("Document Comment body is invalid");
  }
  const segments: TeamHubDocumentCommentThreadCreateInput["initial_comment"]["segments"] =
    [];
  body.forEach((block, blockIndex) => {
    if (blockIndex > 0) {
      segments.push({ content: "\n", type: "text" });
    }
    appendCommentContent(segments, block?.content);
  });
  if (segments.length === 0) {
    throw new Error("Document Comment body is empty");
  }
  return segments;
}

function appendCommentContent(
  segments: TeamHubDocumentCommentThreadCreateInput["initial_comment"]["segments"],
  content: unknown,
): void {
  if (typeof content === "string") {
    if (content !== "") {
      segments.push({ content, type: "text" });
    }
    return;
  }
  if (!Array.isArray(content)) {
    return;
  }
  for (const inline of content) {
    if (!inline || typeof inline !== "object") {
      throw new Error("Document Comment inline content is invalid");
    }
    const value = inline as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      if (value.text !== "") {
        segments.push({ content: value.text, type: "text" });
      }
      continue;
    }
    if (value.type === "mention") {
      const props = value.props as Record<string, unknown> | undefined;
      if (
        typeof props?.actorId !== "string" ||
        props.actorId === "" ||
        typeof props.label !== "string" ||
        props.label === ""
      ) {
        throw new Error("Document Comment mention is invalid");
      }
      segments.push({
        actor_id: props.actorId,
        content: props.label,
        type: "reference",
      });
      continue;
    }
    if ("content" in value) {
      appendCommentContent(segments, value.content);
      continue;
    }
    throw new Error("Document Comment inline content is unsupported");
  }
}

function hasCurrentReaction(
  comment: CommentData,
  emoji: string,
  currentActorId: string,
) {
  return comment.reactions.some(
    (reaction) =>
      reaction.emoji === emoji && reaction.userIds.includes(currentActorId),
  );
}

/** Comments a reader can still see; a deleted one leaves no tombstone. */
export function visibleThreadComments(thread: ThreadData): CommentData[] {
  return thread.comments.filter((comment) => comment.body !== undefined);
}
