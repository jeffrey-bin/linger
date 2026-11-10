import { QuoteDownIcon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { readVisibleQuote } from "../../documents/document-voice-selection-control";
import { useOptionalVoiceMaterials } from "./voice-materials-context";

const controlSelector = "[data-message-voice-selection-control]";
// Mentions and Document links are part of a Message body and may be quoted.
const excludedContent = [
  "input",
  "textarea",
  "select",
  "[role=toolbar]",
  "[role=dialog]",
  controlSelector,
].join(",");

type Placement = { top: number; left: number } | null;

interface SelectedMessageQuote {
  messageId: string;
  author: string;
  range: Range;
  quote: string;
}

/** Offers a text selection inside one Room Message as voice material. */
export function MessageVoiceSelectionControl({
  root,
}: {
  root: HTMLElement | null;
}) {
  const materials = useOptionalVoiceMaterials();
  const enabled = materials?.voiceModeEntered === true;
  const [selection, setSelection] = useState<SelectedMessageQuote | null>(null);
  const [failed, setFailed] = useState(false);
  const [placement, setPlacement] = useState<Placement>(null);
  const selectedKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled || !root) return;
    const ownerDocument = root.ownerDocument;
    // A drag fires selectionchange continuously; reading it mid-drag would
    // re-render on every pointer move. Settle the selection on release.
    let dragging = false;
    const update = (event?: Event) => {
      if (
        event?.target instanceof Element &&
        event.target.closest(controlSelector)
      )
        return;
      const browserSelection = ownerDocument.getSelection();
      const range =
        browserSelection?.rangeCount === 1 && !browserSelection.isCollapsed
          ? browserSelection.getRangeAt(0)
          : undefined;
      const quote = range ? readMessageQuote(root, range) : undefined;
      const message = range ? messageOf(range.startContainer, root) : undefined;
      const key = quote && message ? `${message.id}\u0000${quote}` : undefined;
      // An unchanged selection keeps its state and does not re-render.
      if (key === selectedKey.current) return;
      selectedKey.current = key;
      setFailed(false);
      setSelection(
        quote && range && message
          ? {
              messageId: message.id,
              author: message.author,
              range: range.cloneRange(),
              quote,
            }
          : null,
      );
    };
    const press = () => {
      dragging = true;
    };
    const release = (event: Event) => {
      if (!dragging) return;
      dragging = false;
      update(event);
    };
    const change = (event: Event) => {
      if (!dragging) update(event);
    };
    root.addEventListener("mousedown", press);
    root.addEventListener("touchstart", press);
    root.addEventListener("keyup", update);
    // Release may happen outside the timeline when a drag leaves it.
    ownerDocument.addEventListener("mouseup", release);
    ownerDocument.addEventListener("touchend", release);
    ownerDocument.addEventListener("selectionchange", change);
    return () => {
      root.removeEventListener("mousedown", press);
      root.removeEventListener("touchstart", press);
      root.removeEventListener("keyup", update);
      ownerDocument.removeEventListener("mouseup", release);
      ownerDocument.removeEventListener("touchend", release);
      ownerDocument.removeEventListener("selectionchange", change);
    };
  }, [enabled, root]);

  // Follow the selected text while the timeline scrolls or the window resizes.
  useEffect(() => {
    if (!selection || !root) {
      setPlacement(null);
      return;
    }
    const view = root.ownerDocument.defaultView;
    const place = () => setPlacement(placementFor(selection.range, root));
    place();
    root.addEventListener("scroll", place, { passive: true });
    view?.addEventListener("resize", place);
    return () => {
      root.removeEventListener("scroll", place);
      view?.removeEventListener("resize", place);
    };
  }, [root, selection]);

  if (!materials || !selection || !root || !placement) return null;

  const addSelection = () => {
    // Revalidate at the action boundary: the Message may have been replaced,
    // hidden or scrolled out of the timeline since selectionchange.
    if (readMessageQuote(root, selection.range) !== selection.quote) {
      selectedKey.current = undefined;
      setSelection(null);
      return;
    }
    if (
      materials.addSelection({
        messageId: selection.messageId,
        title: selection.author,
        quote: selection.quote,
      })
    ) {
      selectedKey.current = undefined;
      setSelection(null);
      setFailed(false);
    } else setFailed(true);
  };

  // A fixed, portaled button just below the selection: it never resizes the
  // timeline (which would re-pin it and move text under the pointer).
  return createPortal(
    <div
      className="fixed z-50 flex flex-col items-start gap-1"
      data-message-voice-selection-control
      role="group"
      aria-label="Selected message voice context"
      style={{ top: placement.top, left: placement.left }}
    >
      <Button
        className="shadow-md"
        onClick={addSelection}
        onMouseDown={(event) => event.preventDefault()}
        size="compact"
        tone="secondary"
        type="button"
      >
        <Icon icon={QuoteDownIcon} size={14} />
        Add to voice
      </Button>
      {failed ? (
        <p
          className="max-w-64 rounded bg-app-surface px-2 py-1 text-xs text-app-danger shadow"
          role="alert"
        >
          {materials.error ||
            "This selection could not be added. Please try again."}
        </p>
      ) : null}
    </div>,
    root.ownerDocument.body,
  );
}

const buttonGapPx = 6;
const viewportMarginPx = 8;
const buttonWidthPx = 132;
const buttonHeightPx = 32;

/** Below the selection's last line, kept on screen; null once scrolled away. */
function placementFor(range: Range, root: HTMLElement): Placement {
  const rect = range.getBoundingClientRect();
  const bounds = root.getBoundingClientRect();
  if (rect.bottom < bounds.top || rect.top > bounds.bottom) return null;
  const view = root.ownerDocument.defaultView;
  const width = view?.innerWidth ?? Infinity;
  const height = view?.innerHeight ?? Infinity;
  return {
    top: Math.min(
      rect.bottom + buttonGapPx,
      height - buttonHeightPx - viewportMarginPx,
    ),
    left: Math.max(
      viewportMarginPx,
      Math.min(rect.left, width - buttonWidthPx - viewportMarginPx),
    ),
  };
}

function readMessageQuote(root: HTMLElement, range: Range) {
  return readVisibleQuote(root, range, messageBody, excludedContent);
}

function messageBody(element: Element, root: HTMLElement) {
  const body = element.closest("article[data-message-id] .message-row-body");
  return body && root.contains(body) ? body : undefined;
}

function messageOf(node: Node, root: HTMLElement) {
  const element = node instanceof Element ? node : node.parentElement;
  const article = element?.closest<HTMLElement>("article[data-message-id]");
  const id = article?.dataset.messageId;
  if (!article || !id || !root.contains(article)) return undefined;
  return { id, author: article.dataset.messageAuthor?.trim() || "a member" };
}
