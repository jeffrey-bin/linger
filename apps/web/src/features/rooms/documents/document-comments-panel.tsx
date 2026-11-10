import { formatDateTime } from "@/lib/date-format";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowTurnBackwardIcon,
  ArrowUp02Icon,
  Cancel01Icon,
  QuoteDownIcon,
  RotateLeft01Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { MessageMarkdown } from "@/features/rooms/chat/message-markdown";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubDocumentCommentThread } from "@/features/teamhub/teamhub-types";

import { roomDocumentCommentThreadsQueryOptions } from "./room-document-comments";

export function DocumentCommentsPanel({
  client,
  documentId,
  documentVersionId,
  onClose,
  onSelectionConsumed,
  open,
  portalTarget,
  roomId,
  scopeId,
  selectionQuote,
  tenantId,
}: {
  client: TeamHubClient;
  documentId: string;
  documentVersionId?: string;
  onClose: () => void;
  onSelectionConsumed?: () => void;
  open: boolean;
  portalTarget: HTMLElement | null;
  roomId?: string;
  scopeId: string;
  selectionQuote?: string | null;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  const threadOptions = roomDocumentCommentThreadsQueryOptions(
    client,
    tenantId,
    scopeId,
    documentId,
  );
  const threads = useQuery({
    ...threadOptions,
    enabled: open,
  });

  async function createThread(body: string) {
    if (!documentVersionId) return;
    const commentBody = selectionQuote
      ? `“${selectionQuote}”\n\n${body}`
      : body;
    const thread = await teamHubData(
      client.api.POST("/v0/documents/{documentId}/comment-threads", {
        params: { path: { documentId } },
        body: {
          ...(roomId
            ? {
                current_context: {
                  binding_kind: "room" as const,
                  context_id: roomId,
                },
              }
            : {}),
          document_version_id: documentVersionId,
          initial_comment: {
            segments: [{ content: commentBody, type: "text" }],
          },
        },
      }),
    );
    queryClient.setQueryData<TeamHubDocumentCommentThread[]>(
      threadOptions.queryKey,
      (current = []) => [
        ...current.filter((candidate) => candidate.id !== thread.id),
        thread,
      ],
    );
    onSelectionConsumed?.();
  }

  async function replyToThread(threadId: string, body: string) {
    const comment = await teamHubData(
      client.api.POST(
        "/v0/document-comment-threads/{documentCommentThreadId}/comments",
        {
          params: { path: { documentCommentThreadId: threadId } },
          body: {
            ...(roomId
              ? {
                  current_context: {
                    binding_kind: "room" as const,
                    context_id: roomId,
                  },
                }
              : {}),
            segments: [{ content: body, type: "text" }],
          },
        },
      ),
    );
    queryClient.setQueryData<TeamHubDocumentCommentThread[]>(
      threadOptions.queryKey,
      (current = []) =>
        current.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                comments: [
                  ...thread.comments.filter(
                    (candidate) => candidate.id !== comment.id,
                  ),
                  comment,
                ],
                updated_at: comment.updated_at,
              }
            : thread,
        ),
    );
  }

  if (!open || portalTarget === null) return null;

  const items = threads.data ?? [];

  return createPortal(
    <aside
      aria-label="All Document comments"
      className="flex h-full min-h-0 flex-col bg-app-surface"
    >
      <div className="flex shrink-0 items-center justify-between px-3 pb-2 pt-5">
        <h3 className="text-sm font-semibold text-app-ink">Comments</h3>
        <Button
          aria-label="Close comments"
          onClick={onClose}
          size="compactIcon"
          title="Close comments"
          tone="ghost"
        >
          <Icon icon={Cancel01Icon} size={14} />
        </Button>
      </div>
      <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto">
        {threads.isPending ? (
          <p className="px-4 py-8 text-center text-sm text-app-muted">
            Loading comments...
          </p>
        ) : threads.isError ? (
          <div className="px-4 py-8 text-center" role="alert">
            <p className="text-sm text-app-danger">
              Comments could not be loaded.
            </p>
            <Button
              className="mt-3"
              onClick={() => void threads.refetch()}
              size="compact"
              tone="secondary"
            >
              <Icon icon={RotateLeft01Icon} size={14} />
              Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-app-muted">
            No comments
          </p>
        ) : (
          <div className="space-y-3 p-3">
            {items.map((thread) => (
              <DocumentCommentThread
                key={thread.id}
                onReply={(body) => replyToThread(thread.id, body)}
                thread={thread}
              />
            ))}
          </div>
        )}
      </div>
      {documentVersionId && threads.isSuccess ? (
        <DocumentCommentComposer
          actionLabel="Add comment"
          ariaLabel="New Document comment"
          onSubmit={createThread}
          placeholder="Add comment..."
          selectionQuote={selectionQuote}
        />
      ) : null}
    </aside>,
    portalTarget,
  );
}

function DocumentCommentComposer({
  actionLabel,
  ariaLabel,
  embedded = false,
  onSubmit,
  placeholder,
  selectionQuote,
}: {
  actionLabel: string;
  ariaLabel: string;
  embedded?: boolean;
  onSubmit: (body: string) => Promise<void>;
  placeholder: string;
  selectionQuote?: string | null;
}) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isComposing = useRef(false);
  const inputId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = body.trim();
    if (!content || pending) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(content);
      setBody("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Comment could not be added.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className={
        embedded
          ? "flex min-w-0 flex-col gap-2 pt-1"
          : "mx-3 mb-4 mt-3 flex min-w-0 shrink-0 flex-col gap-2"
      }
      onSubmit={(event) => void submit(event)}
    >
      <label className="sr-only" htmlFor={inputId}>
        {ariaLabel}
      </label>
      {selectionQuote ? (
        <div className="room-document-comment-reference town-selection-pulse">
          <Icon icon={QuoteDownIcon} size={14} />
          <span>{selectionQuote}</span>
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-1 overflow-hidden rounded-full bg-app-canvas p-1">
        <textarea
          aria-label={ariaLabel}
          className="document-comment-input workspace-scrollbar block min-h-8 min-w-0 max-h-20 flex-1 resize-none border-0 bg-transparent px-2 text-sm text-app-ink outline-none placeholder:text-app-muted"
          disabled={pending}
          id={inputId}
          onChange={(event) => setBody(event.target.value)}
          onCompositionStart={() => {
            isComposing.current = true;
          }}
          onCompositionEnd={() => {
            isComposing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !isComposing.current &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={placeholder}
          rows={1}
          value={body}
        />
        <Button
          aria-label={actionLabel}
          className="document-comment-send !rounded-full"
          disabled={!body.trim() || pending}
          size="compactIcon"
          tone="primary"
          type="submit"
        >
          <Icon icon={ArrowUp02Icon} size={14} />
          <span className="sr-only">{pending ? "Adding..." : actionLabel}</span>
        </Button>
      </div>
      {error ? (
        <p className="px-2 text-xs text-app-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function DocumentCommentThread({
  onReply,
  thread,
}: {
  onReply: (body: string) => Promise<void>;
  thread: TeamHubDocumentCommentThread;
}) {
  const [replying, setReplying] = useState(false);
  const firstComment = thread.comments[0];
  const firstBody =
    firstComment?.segments.map((segment) => segment.content).join("") ?? "";
  // Version comments previously stored their selected excerpt as a quoted prefix.
  const reference = !firstComment?.deleted_at
    ? /^“([\s\S]+?)”\n\n([\s\S]*)$/.exec(firstBody)
    : null;
  return (
    <article
      aria-label={`Comment by ${thread.created_by.display_name}`}
      className="rounded-xl border border-app-border bg-card p-2"
    >
      {reference ? (
        <div className="room-document-comment-reference mb-2">
          <Icon icon={QuoteDownIcon} size={14} />
          <span>{reference[1]}</span>
        </div>
      ) : null}
      <div className="space-y-4">
        {thread.comments.map((comment) => (
          <div className="flex gap-1" key={comment.id}>
            <ActorAvatar
              actorId={comment.author.id}
              kind={comment.author.kind}
              name={comment.author.display_name}
              size="nav"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-5 text-app-ink">
                {comment.author.display_name}
              </p>
              <time
                className="block text-xs leading-4 text-app-subtle"
                dateTime={comment.created_at}
              >
                {formatDateTime(comment.created_at, {
                  day: "numeric",
                  month: "short",
                })}
              </time>
              <div className="mt-2 min-w-0 text-sm leading-5 text-app-body">
                {comment.deleted_at ? (
                  "Comment deleted"
                ) : (
                  <MessageMarkdown
                    authorKind={comment.author.kind}
                    body={
                      comment === firstComment && reference
                        ? reference[2]!
                        : comment.segments
                            .map((segment) => segment.content)
                            .join("")
                    }
                  />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {!thread.resolved ? (
        <div className="mt-2">
          {replying ? (
            <DocumentCommentComposer
              actionLabel="Send reply"
              ariaLabel="Reply to Document comment"
              embedded
              onSubmit={async (body) => {
                await onReply(body);
                setReplying(false);
              }}
              placeholder="Add comment..."
            />
          ) : (
            <Button
              aria-label="Reply"
              onClick={() => setReplying(true)}
              size="compact"
              tone="ghost"
            >
              <Icon icon={ArrowTurnBackwardIcon} size={14} />
              Reply
            </Button>
          )}
        </div>
      ) : null}
    </article>
  );
}
