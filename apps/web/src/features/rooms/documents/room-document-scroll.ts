import { useEffect, type RefObject } from "react";

// Alignment and linked wheel movement must not feed back into document scrolling.
const independentPositions = new WeakMap<HTMLElement, number>();

export function scrollDocumentPaneIndependently(
  pane: HTMLElement,
  top: number,
) {
  pane.scrollTop = top;
  independentPositions.set(pane, pane.scrollTop);
}

/**
 * The offset this module last set on a pane. A pane sitting somewhere else was
 * moved by something outside the linked-scroll paths.
 */
export function independentScrollPosition(pane: HTMLElement) {
  return independentPositions.get(pane);
}

export function linkDocumentScrollPanes(
  documentPane: HTMLElement,
  commentsPane: HTMLElement,
) {
  let previousDocumentTop = documentPane.scrollTop;
  if (!independentPositions.has(commentsPane)) {
    scrollDocumentPaneIndependently(commentsPane, documentPane.scrollTop);
  }
  const fromDocument = () => {
    const baseline =
      independentPositions.get(documentPane) ?? previousDocumentTop;
    independentPositions.delete(documentPane);
    const delta = documentPane.scrollTop - baseline;
    previousDocumentTop = documentPane.scrollTop;
    if (delta)
      scrollDocumentPaneIndependently(
        commentsPane,
        commentsPane.scrollTop + delta,
      );
  };
  const wheel = (event: WheelEvent) => {
    if (
      event.ctrlKey ||
      event.shiftKey ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
    )
      return;
    const pane = event.currentTarget as HTMLElement;
    // Preserve scrolling inside editors, code blocks and mention pickers.
    for (
      let node = event.target instanceof Element ? event.target : null;
      node && node !== pane;
      node = node.parentElement
    ) {
      if (node.matches("[role=listbox], .message-mention-menu")) return;
      if (
        node.scrollHeight > node.clientHeight &&
        /auto|scroll/.test(getComputedStyle(node).overflowY) &&
        (event.deltaY < 0
          ? node.scrollTop > 0
          : node.scrollTop + node.clientHeight < node.scrollHeight)
      )
        return;
    }
    const delta =
      event.deltaY *
      (event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? pane.clientHeight
          : 1);
    event.preventDefault();
    scrollDocumentPaneIndependently(
      documentPane,
      documentPane.scrollTop + delta,
    );
    scrollDocumentPaneIndependently(
      commentsPane,
      commentsPane.scrollTop + delta,
    );
  };
  // Scrollbar and touch scrolling stay independent of the document. Record the
  // resulting position: the anchor layout treats an unrecorded comments scroll
  // as drift and snaps the lane back onto the focused card.
  const fromComments = () => {
    independentPositions.set(commentsPane, commentsPane.scrollTop);
  };
  documentPane.addEventListener("scroll", fromDocument);
  commentsPane.addEventListener("scroll", fromComments);
  documentPane.addEventListener("wheel", wheel, { passive: false });
  commentsPane.addEventListener("wheel", wheel, { passive: false });
  // Wheel scrolling links both panes, including when one has reached its own edge.
  return () => {
    documentPane.removeEventListener("scroll", fromDocument);
    commentsPane.removeEventListener("scroll", fromComments);
    documentPane.removeEventListener("wheel", wheel);
    commentsPane.removeEventListener("wheel", wheel);
    independentPositions.delete(documentPane);
    independentPositions.delete(commentsPane);
  };
}

export function useLinkedDocumentScroll(
  layoutRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    let cleanup: (() => void) | undefined;
    let linkedDocument: HTMLElement | null = null;
    let linkedComments: HTMLElement | null = null;
    const connect = () => {
      // The outer document layout owns the visible scrollbar. The content
      // pane remains the anchor surface, while the comments lane keeps a
      // hidden internal scroll position for deep comment navigation.
      const useOuterScroll =
        typeof window === "undefined" ||
        window.matchMedia("(min-width: 1024px)").matches;
      const documentPane = useOuterScroll
        ? layout
        : layout.querySelector<HTMLElement>("[data-document-scroll-container]");
      const commentsPane = layout.querySelector<HTMLElement>(
        "[data-document-comments-scroll]",
      );
      if (documentPane === linkedDocument && commentsPane === linkedComments)
        return;
      const commentsTop =
        commentsPane === linkedComments ? commentsPane?.scrollTop : undefined;
      cleanup?.();
      cleanup = undefined;
      linkedDocument = documentPane;
      linkedComments = commentsPane;
      if (documentPane && commentsPane) {
        // Switching the responsive scroll owner must not reset a reader's
        // independent Comments position to the new pane's initial offset.
        if (commentsTop !== undefined)
          scrollDocumentPaneIndependently(commentsPane, commentsTop);
        cleanup = linkDocumentScrollPanes(documentPane, commentsPane);
      }
    };
    connect();
    const observer = new MutationObserver(connect);
    observer.observe(layout, { childList: true, subtree: true });
    window.addEventListener("resize", connect);
    return () => {
      window.removeEventListener("resize", connect);
      observer.disconnect();
      cleanup?.();
    };
  }, [layoutRef]);
}
