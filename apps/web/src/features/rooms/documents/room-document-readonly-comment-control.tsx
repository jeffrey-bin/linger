import { Comment01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useState, type MutableRefObject } from "react";

import { Button } from "@/components/ui/button";

import { type RoomDocumentCommentAnchor } from "./room-document-comments";
import { readOnlyDocumentCommentAnchor } from "./room-document-readonly-selection";

export function ReadOnlySelectionCommentControl({
  anchorRef,
  canComment,
  editable,
  editorRootRef,
  onStartComment,
}: {
  anchorRef: MutableRefObject<RoomDocumentCommentAnchor | null>;
  canComment: boolean;
  editable: boolean;
  editorRootRef: MutableRefObject<HTMLElement | null>;
  onStartComment: () => void;
}) {
  const [anchor, setAnchor] = useState<RoomDocumentCommentAnchor | null>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  useEffect(() => {
    const root = editorRootRef.current;
    if (editable || !canComment || root === null) {
      anchorRef.current = null;
      return;
    }
    let pendingFrame: number | undefined;
    const updateFromSelection = (event?: Event) => {
      if (
        event?.target instanceof Element &&
        event.target.closest("[data-readonly-comment-control]")
      ) {
        return;
      }
      const selection = window.getSelection();
      const next = readOnlyDocumentCommentAnchor(selection, root);
      anchorRef.current = next;
      if (next === null || selection === null) {
        if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
        setAnchor(null);
        setPosition(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const rect =
        typeof range.getBoundingClientRect === "function"
          ? range.getBoundingClientRect()
          : root.getBoundingClientRect();
      const controlWidth = 44;
      const left = Math.min(
        Math.max(12, rect.right - controlWidth),
        Math.max(12, window.innerWidth - controlWidth - 12),
      );
      const top = rect.top >= 52 ? rect.top - 44 : rect.bottom + 8;
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = undefined;
        if (root.querySelector('[data-test="addcomment"]')) {
          setAnchor(null);
          setPosition(null);
          return;
        }
        setAnchor(next);
        setPosition({ left, top: Math.max(12, top) });
      });
    };
    root.addEventListener("keyup", updateFromSelection);
    root.addEventListener("mouseup", updateFromSelection);
    root.addEventListener("touchend", updateFromSelection);
    document.addEventListener("selectionchange", updateFromSelection);
    return () => {
      root.removeEventListener("keyup", updateFromSelection);
      root.removeEventListener("mouseup", updateFromSelection);
      root.removeEventListener("touchend", updateFromSelection);
      document.removeEventListener("selectionchange", updateFromSelection);
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
    };
  }, [anchorRef, canComment, editable, editorRootRef]);

  if (editable || !canComment || anchor === null || position === null) {
    return null;
  }
  return (
    <div
      className="fixed z-50 rounded-md bg-popover p-1 shadow-md"
      data-readonly-comment-control
      style={position}
    >
      <Button
        aria-label="Add comment to selected text"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onStartComment}
        className="bg-app-hover text-app-ink"
        size="compactIcon"
        title="Add comment"
        tone="ghost"
        type="button"
      >
        <Icon icon={Comment01Icon} />
      </Button>
    </div>
  );
}
