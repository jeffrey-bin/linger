import { Comment01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useState, type MutableRefObject } from "react";

import { Button } from "@/components/ui/button";

interface VersionSelection {
  left: number;
  quotedText: string;
  top: number;
}

export function DocumentVersionSelectionCommentControl({
  enabled,
  onComment,
  rootRef,
}: {
  enabled: boolean;
  onComment: (quotedText: string) => void;
  rootRef: MutableRefObject<HTMLElement | null>;
}) {
  const [selection, setSelection] = useState<VersionSelection | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || root === null) return;
    const update = (event?: Event) => {
      if (
        event?.target instanceof Element &&
        event.target.closest("[data-version-selection-comment-control]")
      ) {
        return;
      }
      const browserSelection = window.getSelection();
      if (
        browserSelection === null ||
        browserSelection.rangeCount !== 1 ||
        browserSelection.isCollapsed
      ) {
        setSelection(null);
        return;
      }
      const range = browserSelection.getRangeAt(0);
      const selectedElement =
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      const quotedText = range.toString().trim();
      if (
        !selectedElement?.closest("[data-document-version-preview]") ||
        !root.contains(selectedElement) ||
        quotedText === "" ||
        Array.from(quotedText).length > 10_000
      ) {
        setSelection(null);
        return;
      }
      const rect =
        typeof range.getBoundingClientRect === "function"
          ? range.getBoundingClientRect()
          : selectedElement.getBoundingClientRect();
      const width = 44;
      const left = Math.min(
        Math.max(12, rect.right - width),
        Math.max(12, window.innerWidth - width - 12),
      );
      const top = rect.top >= 52 ? rect.top - 44 : rect.bottom + 8;
      setSelection({ left, quotedText, top: Math.max(12, top) });
    };
    root.addEventListener("keyup", update);
    root.addEventListener("mouseup", update);
    root.addEventListener("touchend", update);
    document.addEventListener("selectionchange", update);
    return () => {
      root.removeEventListener("keyup", update);
      root.removeEventListener("mouseup", update);
      root.removeEventListener("touchend", update);
      document.removeEventListener("selectionchange", update);
    };
  }, [enabled, rootRef]);

  if (!enabled || selection === null) return null;

  return (
    <div
      className="fixed z-50 flex items-center rounded-md bg-popover p-1 shadow-md"
      data-version-selection-comment-control
      style={{ left: selection.left, top: selection.top }}
    >
      <Button
        aria-label="Add comment to selected text"
        className="bg-app-hover text-app-ink"
        onClick={() => {
          onComment(selection.quotedText);
          setSelection(null);
        }}
        onMouseDown={(event) => event.preventDefault()}
        size="compactIcon"
        title="Add comment"
        tone="ghost"
      >
        <Icon icon={Comment01Icon} />
      </Button>
    </div>
  );
}
