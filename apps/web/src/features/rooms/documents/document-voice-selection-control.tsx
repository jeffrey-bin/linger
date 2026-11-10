import { QuoteDownIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useState, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { useOptionalVoiceMaterials } from "../chat/voice-mode/voice-materials-context";

const maximumQuoteLength = 10_000;
const controlSelector = "[data-document-voice-selection-control]";
const excludedContent = [
  "button",
  "input",
  "textarea",
  "select",
  "[role=toolbar]",
  "[role=dialog]",
  "[role=status]",
  "[role=alert]",
  "[data-readonly-comment-control]",
  "[data-version-selection-comment-control]",
  controlSelector,
].join(",");

interface SelectedQuote {
  documentId: string;
  versionId?: string;
  range: Range;
  quote: string;
}

export function DocumentVoiceSelectionControl({
  documentId,
  title,
  versionId,
  rootRef,
}: {
  documentId: string;
  title: string;
  versionId?: string;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const materials = useOptionalVoiceMaterials();
  // Document excerpts need a grant only their own Room's composer can give.
  const enabled =
    materials?.voiceModeEntered === true && materials.acceptsDocuments;
  const [selection, setSelection] = useState<SelectedQuote | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    const ownerDocument = root.ownerDocument;
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
      const quote = range ? readVisibleDocumentQuote(root, range) : undefined;
      setFailed(false);
      setSelection(
        quote && range
          ? { documentId, versionId, range: range.cloneRange(), quote }
          : null,
      );
    };
    root.addEventListener("mouseup", update);
    root.addEventListener("keyup", update);
    root.addEventListener("touchend", update);
    ownerDocument.addEventListener("selectionchange", update);
    return () => {
      root.removeEventListener("mouseup", update);
      root.removeEventListener("keyup", update);
      root.removeEventListener("touchend", update);
      ownerDocument.removeEventListener("selectionchange", update);
    };
  }, [documentId, enabled, rootRef, versionId]);

  if (
    !materials ||
    !selection ||
    selection.documentId !== documentId ||
    selection.versionId !== versionId
  )
    return null;

  const addSelection = () => {
    const root = rootRef.current;
    // Revalidate at the action boundary: the panel may have been hidden,
    // replaced, or edited since selectionchange. Never capture page-wide text.
    if (
      !root ||
      readVisibleDocumentQuote(root, selection.range) !== selection.quote
    ) {
      setSelection(null);
      return;
    }
    if (
      materials.addSelection({
        documentId,
        title,
        quote: selection.quote,
        ...(versionId ? { versionId } : {}),
      })
    ) {
      setSelection(null);
      setFailed(false);
    } else setFailed(true);
  };

  return (
    <div
      className="shrink-0 border-t border-app-border bg-app-surface px-3 py-2"
      data-document-voice-selection-control
      role="group"
      aria-label="Selected document voice context"
    >
      <blockquote className="mb-2 line-clamp-2 break-words text-xs text-app-muted">
        {selection.quote}
      </blockquote>
      <Button
        className="w-full justify-center"
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
        <p className="mt-2 text-xs text-app-danger" role="alert">
          {materials.error ||
            "This selection could not be added. Please try again."}
        </p>
      ) : null}
    </div>
  );
}

function readVisibleDocumentQuote(root: HTMLElement, range: Range) {
  return readVisibleQuote(root, range, documentBody);
}

/** The quote only when the whole selection is visible text inside one body
 * returned by `bodyOf`, never toolbars, controls or hidden content. */
export function readVisibleQuote(
  root: HTMLElement,
  range: Range,
  bodyOf: (element: Element, root: HTMLElement) => Element | undefined,
  excluded = excludedContent,
): string | undefined {
  if (
    !root.isConnected ||
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return;
  const start = elementAt(range.startContainer);
  const end = elementAt(range.endContainer);
  if (!start || !end || !isVisible(start) || !isVisible(end)) return;
  const body = bodyOf(start, root);
  if (!body || body !== bodyOf(end, root)) return;
  if (start.closest(excluded) || end.closest(excluded)) return;
  for (const node of body.querySelectorAll(
    `${excluded},[hidden],[inert],[aria-hidden=true]`,
  ))
    if (range.intersectsNode(node)) return;
  const quote = range.toString().trim();
  if (!quote || Array.from(quote).length > maximumQuoteLength) return;
  return quote;
}

function elementAt(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function documentBody(
  element: Element,
  root: HTMLElement,
): Element | undefined {
  const nativeBody = element.closest(
    '[aria-label="Room Document editor"] .bn-editor',
  );
  if (nativeBody && root.contains(nativeBody)) return nativeBody;
  const previewBody = element.closest(
    '[data-content-renderer="blocknote"] .bn-editor, [data-content-renderer="text"], .textLayer',
  );
  if (
    previewBody &&
    root.contains(previewBody) &&
    previewBody.closest(
      '[data-document-version-preview], [data-testid="artifact-reading-viewport"]',
    )
  )
    return previewBody;
  return undefined;
}

function isVisible(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (current.matches('[hidden],[inert],[aria-hidden="true"]')) return false;
    const style = view?.getComputedStyle(current);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse"
    )
      return false;
  }
  return true;
}
