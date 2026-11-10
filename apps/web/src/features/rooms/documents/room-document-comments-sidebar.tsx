import { CommentsExtension, type ThreadData } from "@blocknote/core/comments";
import {
  getReferenceText,
  useBlockNoteEditor,
  useExtension,
  useExtensionState,
  useThreads,
} from "@blocknote/react";
import {
  Cancel01Icon,
  MessageMultiple01Icon,
  QuoteDownIcon,
  RotateLeft01Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";

import { scrollDocumentPaneIndependently } from "./room-document-scroll";
import { resolveCommentAnchorPosition } from "./room-document-comment-position";
import { useAnchoredCommentLane } from "./room-document-comment-anchoring";
import { RoomDocumentCommentThread } from "./room-document-comment-thread";
import {
  visibleThreadComments,
  type RoomDocumentCommentAnchor,
  type TeamHubDocumentThreadStore,
} from "./room-document-comments";

const PENDING_COMMENT_CARD_ID = "pending-comment";

const CommentsOpenContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

export function RoomDocumentCommentsOpenProvider({
  children,
  onOpenChange,
  open,
}: {
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const value = useMemo(
    () => ({ open, setOpen: onOpenChange }),
    [onOpenChange, open],
  );
  return <CommentsOpenContext value={value}>{children}</CommentsOpenContext>;
}

export function RoomDocumentCommentsController({
  composer,
  pendingSelection = false,
  pendingAnchor,
  onCancelSelection,
  actorDirectory,
  error = false,
  mentionOptions,
  onOpenChange,
  onRetry,
  open: controlledOpen,
  portalTarget,
  showTrigger = true,
  threadStore,
}: {
  composer?: ReactNode;
  pendingSelection?: boolean;
  pendingAnchor?: RoomDocumentCommentAnchor | null;
  onCancelSelection?: () => void;
  actorDirectory?: TeamHubActorRef[];
  error?: boolean;
  mentionOptions: TeamHubActorRef[];
  onOpenChange?: (open: boolean) => void;
  onRetry?: () => void;
  open?: boolean;
  portalTarget?: HTMLElement | null;
  showTrigger?: boolean;
  threadStore: TeamHubDocumentThreadStore;
}) {
  const comments = useExtension(CommentsExtension);
  const threads = useThreads();
  const { selectedThreadId, pendingComment } =
    useExtensionState(CommentsExtension);
  const [internalOpen, setInternalOpen] = useState(false);
  const sharedOpen = useContext(CommentsOpenContext);
  const setSharedOpen = sharedOpen?.setOpen;
  const open = sharedOpen?.open ?? controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (!next) {
      comments.stopPendingComment();
      onCancelSelection?.();
    }
    setInternalOpen(next);
    if (sharedOpen) sharedOpen.setOpen(next);
    else onOpenChange?.(next);
  };

  useEffect(() => {
    if (!selectedThreadId && !pendingComment && !pendingSelection) return;
    // BlockNote selection is external state. Latch the drawer open so clearing the selection does not close it.
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- Preserve the drawer lifecycle when synchronizing external editor events.
    setInternalOpen(true);
    setSharedOpen?.(true);
  }, [selectedThreadId, pendingComment, pendingSelection, setSharedOpen]);

  if (threads.size === 0 && !open) return null;

  const panel = open ? (
    <aside
      aria-label="All Document comments"
      className="room-document-comments-popover"
    >
      <div className="room-document-comments-heading">
        <h3>Comments</h3>
        <Button
          aria-label="Close comments"
          onClick={() => setOpen(false)}
          size="compactIcon"
          title="Close comments"
          tone="ghost"
        >
          <Icon icon={Cancel01Icon} size={14} />
        </Button>
      </div>
      <div
        className="room-document-comments-scroll workspace-scrollbar"
        data-document-comments-scroll
      >
        {error ? (
          <div className="px-4 py-8 text-center" role="alert">
            <p className="text-sm text-app-danger">
              Comments could not be loaded.
            </p>
            {onRetry ? (
              <Button
                className="mt-3"
                onClick={onRetry}
                size="compact"
                tone="secondary"
              >
                <Icon icon={RotateLeft01Icon} size={14} />
                Retry
              </Button>
            ) : null}
          </div>
        ) : (
          <RoomDocumentCommentsList
            actorDirectory={actorDirectory}
            composer={pendingComment || pendingSelection ? composer : undefined}
            pendingAnchor={pendingAnchor}
            mentionOptions={mentionOptions}
            onSelectThread={(threadId) => {
              comments.selectThread(threadId, false);
            }}
            threadStore={threadStore}
          />
        )}
      </div>
    </aside>
  ) : null;

  return (
    <div className="room-document-comments-control">
      {showTrigger && threads.size > 0 ? (
        <button
          aria-expanded={open}
          aria-label={`Show all Document comments (${threads.size})`}
          className="room-document-comments-trigger"
          onClick={() => {
            comments.selectThread(undefined, false);
            setOpen(!open);
          }}
          type="button"
        >
          <Icon icon={MessageMultiple01Icon} />
          <span>{threads.size}</span>
        </button>
      ) : null}
      {panel && portalTarget ? createPortal(panel, portalTarget) : panel}
    </div>
  );
}

export function RoomDocumentCommentsList({
  actorDirectory,
  composer,
  pendingAnchor,
  mentionOptions,
  onSelectThread,
  resolved,
  threadStore,
}: {
  actorDirectory?: TeamHubActorRef[];
  mentionOptions: TeamHubActorRef[];
  composer?: ReactNode;
  pendingAnchor?: RoomDocumentCommentAnchor | null;
  onSelectThread: (threadId: string) => void;
  resolved?: boolean;
  threadStore: TeamHubDocumentThreadStore;
}) {
  const editor = useBlockNoteEditor();
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const { selectedThreadId, threadPositions } =
    useExtensionState(CommentsExtension);
  const threads = useThreads();
  const doc = editor.prosemirrorState?.doc;
  const positions = useMemo(() => {
    const resolved = new Map(threadPositions);
    for (const thread of threads.values()) {
      if (resolved.has(thread.id)) continue;
      const anchor = (
        thread.metadata as { anchor?: RoomDocumentCommentAnchor } | undefined
      )?.anchor;
      const position = resolveCommentAnchorPosition(doc, anchor);
      if (position) resolved.set(thread.id, position);
    }
    return resolved;
  }, [doc, threadPositions, threads]);
  const ordered = useMemo(
    () =>
      [...threads.values()]
        .filter(
          (thread) =>
            visibleThreadComments(thread).length > 0 &&
            (thread.metadata as { anchorStatus?: string } | undefined)
              ?.anchorStatus !== "orphaned" &&
            (resolved === undefined || thread.resolved === resolved),
        )
        .sort((left, right) => {
          const leftPosition = positions.get(left.id)?.from;
          const rightPosition = positions.get(right.id)?.from;
          if (leftPosition !== undefined || rightPosition !== undefined) {
            return (
              (leftPosition ?? Number.MAX_SAFE_INTEGER) -
              (rightPosition ?? Number.MAX_SAFE_INTEGER)
            );
          }
          return 0;
        }),
    [resolved, positions, threads],
  );

  const selection = editor.prosemirrorState?.selection;
  const pendingFrom = pendingAnchor
    ? (resolveCommentAnchorPosition(doc, pendingAnchor)?.from ??
      selection?.from)
    : selection?.from;
  const pendingIndex = composer
    ? ordered.findIndex(
        (thread) =>
          (positions.get(thread.id)?.from ?? Number.MAX_SAFE_INTEGER) >
          (pendingFrom ?? Number.MAX_SAFE_INTEGER),
      )
    : -1;
  const hasComposer = Boolean(composer);
  // The editor view throws while it is unmounted, and the lane is laid out
  // after mount, so every read of it stays inside this callback.
  const resolveAnchorTop = useCallback(
    (position: number) => {
      try {
        return editor.prosemirrorView?.coordsAtPos(position).top;
      } catch {
        return undefined;
      }
    },
    [editor],
  );
  const [anchoringEnabled, setAnchoringEnabled] = useState(false);
  useAnchoredCommentLane({
    focusId: selectedThreadId,
    pendingId: hasComposer ? PENDING_COMMENT_CARD_ID : undefined,
    onAnchoredChange: setAnchoringEnabled,
    laneRef: listRef,
    resolveAnchorTop,
    revision: `${ordered.map((thread) => `${thread.id}:${positions.get(thread.id)?.from ?? ""}:${positions.get(thread.id)?.to ?? ""}`).join(",")}|${pendingIndex}|${selectedThreadId ?? ""}`,
  });

  useEffect(() => {
    if (anchoringEnabled) return;
    const target = hasComposer
      ? composerRef.current
      : listRef.current?.querySelector<HTMLElement>(
          `[id="room-document-comment-thread-${CSS.escape(selectedThreadId ?? "")}"]`,
        );
    const panel = listRef.current?.closest<HTMLElement>(
      "[data-document-comments-scroll]",
    );
    if (!target || !panel) return;
    const targetRect = target.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    panel.scrollTo({
      top: panel.scrollTop + targetRect.top - panelRect.top - 64,
      behavior: "instant",
    });
  }, [
    anchoringEnabled,
    hasComposer,
    selectedThreadId,
    ordered.length,
    pendingIndex,
  ]);

  const pendingComposer = composer ? (
    <div
      className="room-document-pending-comment"
      data-anchor-pos={pendingFrom}
      data-comment-card={PENDING_COMMENT_CARD_ID}
      key="pending-comment"
      ref={composerRef}
    >
      <div
        className="room-document-comment-reference town-selection-pulse"
        title={pendingAnchor?.quoted_text}
      >
        <Icon icon={QuoteDownIcon} size={14} />
        <span>
          {pendingAnchor?.quoted_text ??
            (selection ? getReferenceText(editor, selection) : "Selected text")}
        </span>
      </div>
      {composer}
    </div>
  ) : null;

  const cards = ordered.map((thread) => {
    const position = positions.get(thread.id);
    const anchorStatus = (
      thread.metadata as { anchorStatus?: string } | undefined
    )?.anchorStatus;
    const orphaned =
      anchorStatus === "orphaned" ||
      (anchorStatus === "attached" && position === undefined);
    return (
      <RoomDocumentCommentThread
        actorDirectory={actorDirectory}
        anchorPosition={position?.from}
        key={thread.id}
        mentionOptions={mentionOptions}
        onFocus={() => {
          onSelectThread(thread.id);
          if (!position) return;
          // Bring the anchored text level with this card instead of centring it:
          // the lane keeps the card where it is, so centring left the two out of
          // step. Scrolling the Document pane independently also stops the
          // linked-scroll listener from dragging the cards along.
          const lane = listRef.current;
          const layout = lane?.closest<HTMLElement>(
            "[data-document-scroll-layout]",
          );
          if (!lane || !layout) return;
          const documentPane =
            typeof window === "undefined" ||
            window.matchMedia("(min-width: 1024px)").matches
              ? layout
              : layout.querySelector<HTMLElement>(
                  "[data-document-scroll-container]",
                );
          const card = lane.querySelector<HTMLElement>(
            `[data-comment-card="${CSS.escape(thread.id)}"]`,
          );
          let anchorTop: number | undefined;
          try {
            anchorTop = editor.prosemirrorView?.coordsAtPos(position.from).top;
          } catch {
            anchorTop = undefined;
          }
          if (!documentPane || !card || anchorTop === undefined) return;
          scrollDocumentPaneIndependently(
            documentPane,
            documentPane.scrollTop +
              anchorTop -
              card.getBoundingClientRect().top,
          );
        }}
        orphaned={orphaned}
        referenceText={
          position === undefined
            ? anchorQuote(thread)
            : getReferenceText(editor, position)
        }
        selected={thread.id === selectedThreadId}
        thread={thread}
        threadStore={threadStore}
      />
    );
  });
  if (pendingComposer) {
    cards.splice(
      pendingIndex < 0 ? cards.length : pendingIndex,
      0,
      pendingComposer,
    );
  }

  return (
    <div className="bn-threads-sidebar" ref={listRef}>
      {ordered.length === 0 && !composer ? (
        <div className="px-4 py-8 text-center">
          <p className="text-sm text-app-muted">
            {resolved ? "No resolved comments" : "No open comments"}
          </p>
          {!resolved ? (
            <p className="mx-auto mt-2 max-w-56 text-xs leading-5 text-app-subtle">
              Select text in the document, then choose Add comment.
            </p>
          ) : null}
        </div>
      ) : null}
      {cards}
    </div>
  );
}

function anchorQuote(thread: ThreadData): string {
  const anchor = (thread.metadata as { anchor?: { quoted_text?: unknown } })
    .anchor;
  return typeof anchor?.quoted_text === "string"
    ? anchor.quoted_text
    : "Deleted reference";
}
