import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

import {
  independentScrollPosition,
  scrollDocumentPaneIndependently,
} from "./room-document-scroll";

export const ANCHORED_COMMENT_GAP = 8;

export interface AnchoredCommentCard {
  /** Distance in pixels from the lane top to the anchored text, when it is known. */
  anchorTop?: number;
  height: number;
}

/**
 * Places comment cards beside the text they annotate, the way Feishu and Google
 * Docs do: every card wants its anchor's offset, overlaps resolve downwards, and
 * the focused card keeps its exact offset while its neighbours move away.
 */
export function stackAnchoredComments(
  cards: AnchoredCommentCard[],
  options: { focusIndex?: number; gap?: number } = {},
): number[] {
  const gap = options.gap ?? ANCHORED_COMMENT_GAP;
  const desired: number[] = [];
  let previous = 0;
  for (const card of cards) {
    const anchor = Math.max(card.anchorTop ?? previous, previous);
    desired.push(anchor);
    previous = anchor;
  }
  const tops = [...desired];
  for (let index = 1; index < tops.length; index += 1) {
    tops[index] = Math.max(
      tops[index]!,
      tops[index - 1]! + cards[index - 1]!.height + gap,
    );
  }
  const focus = options.focusIndex;
  if (focus !== undefined && focus >= 0 && focus < tops.length) {
    // The cards above the focused one still have to fit, so the focused card
    // cannot rise above the space they occupy. Clamping here keeps its offset
    // reachable; shifting the whole lane afterwards would move the focused card
    // off the text it was aligned to, which is what made a lower card in a
    // cluster impossible to line up.
    let minimumTop = 0;
    for (let index = 0; index < focus; index += 1) {
      minimumTop += cards[index]!.height + gap;
    }
    tops[focus] = Math.max(desired[focus]!, minimumTop);
    for (let index = focus - 1; index >= 0; index -= 1) {
      tops[index] = Math.min(
        tops[index]!,
        tops[index + 1]! - cards[index]!.height - gap,
      );
    }
    for (let index = focus + 1; index < tops.length; index += 1) {
      tops[index] = Math.max(
        tops[index]!,
        tops[index - 1]! + cards[index - 1]!.height + gap,
      );
    }
  }
  return tops;
}

/**
 * How far both panes must travel together for the focused card to be fully
 * visible. Positive scrolls down, negative up, zero when it already fits. A
 * card taller than the panel shows its top.
 */
export function focusedCardScrollDelta({
  cardHeight,
  cardTop,
  paneHeight,
  scrollTop,
}: {
  cardHeight: number;
  cardTop: number;
  paneHeight: number;
  scrollTop: number;
}): number {
  const offset = cardTop - scrollTop;
  if (offset < 0) return offset;
  if (cardHeight > paneHeight) return offset;
  const overflow = offset + cardHeight - paneHeight;
  return overflow > 0 ? overflow : 0;
}

/**
 * Keeps the rendered lane in sync with the editor. Cards opt in by carrying
 * `data-comment-card="<id>"`; `data-anchor-pos` holds the ProseMirror position
 * whose on-screen top the card should track.
 */
export function useAnchoredCommentLane({
  focusId,
  pendingId,
  laneRef,
  onAnchoredChange,
  resolveAnchorTop,
  revision,
}: {
  focusId?: string;
  pendingId?: string;
  laneRef: RefObject<HTMLDivElement | null>;
  onAnchoredChange: (anchored: boolean) => void;
  resolveAnchorTop: (position: number) => number | undefined;
  revision: string;
}) {
  const focusedCard = useRef<string | undefined>(undefined);
  const draft = useRef<
    { position?: string; existingIds: Set<string | undefined> } | undefined
  >(undefined);
  const lastAlignment = useRef("");
  // The card the reader last asked to see, at the height it was shown. Only a
  // new request, or the card itself growing, may move the Document; layout
  // passes caused by scrolling realign the comments lane alone.
  const revealedCard = useRef<string | undefined>(undefined);
  const layout = useCallback(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const release = () => {
      delete lane.dataset.anchored;
      lane.style.removeProperty("height");
      for (const card of lane.querySelectorAll<HTMLElement>(
        ":scope > [data-comment-card]",
      )) {
        card.style.removeProperty("transform");
        delete card.dataset.commentActive;
      }
      lastAlignment.current = "";
      revealedCard.current = undefined;
      onAnchoredChange(false);
    };
    const cards = Array.from(
      lane.querySelectorAll<HTMLElement>(":scope > [data-comment-card]"),
    );
    if (cards.length === 0) {
      release();
      return;
    }
    const commentsPane = lane.closest<HTMLElement>(
      "[data-document-comments-scroll]",
    );
    const layoutPane = lane.closest<HTMLElement>(
      "[data-document-scroll-layout]",
    );
    const documentPane =
      layoutPane &&
      (typeof window === "undefined" ||
        window.matchMedia("(min-width: 1024px)").matches)
        ? layoutPane
        : layoutPane?.querySelector<HTMLElement>(
            "[data-document-scroll-container]",
          );
    const scrollOffset =
      documentPane && commentsPane
        ? documentPane.scrollTop - commentsPane.scrollTop
        : 0;
    const laneTop = lane.getBoundingClientRect().top;
    const measured = cards.map((card) => {
      const raw = card.dataset.anchorPos;
      const position = raw ? Number(raw) : Number.NaN;
      const anchor = Number.isFinite(position)
        ? resolveAnchorTop(position)
        : undefined;
      return {
        anchorTop:
          anchor === undefined ? undefined : anchor - laneTop + scrollOffset,
        height: card.offsetHeight,
      };
    });
    // Without a resolvable anchor there is nothing to line the cards up with,
    // so the lane keeps its ordinary flow.
    if (measured.every((card) => card.anchorTop === undefined)) {
      release();
      return;
    }
    const pending = cards.find(
      (card) => card.dataset.commentCard === pendingId,
    );
    if (pending) {
      if (!draft.current) {
        draft.current = {
          position: pending.dataset.anchorPos,
          existingIds: new Set(cards.map((card) => card.dataset.commentCard)),
        };
      }
      draft.current.position = pending.dataset.anchorPos;
    } else if (draft.current) {
      // Hand the draft's layout priority to its newly persisted thread, even
      // when BlockNote clears the selected thread after submission.
      const previous = draft.current;
      const posted = cards.find(
        (card) =>
          !previous.existingIds.has(card.dataset.commentCard) &&
          previous.position !== undefined &&
          card.dataset.anchorPos === previous.position,
      );
      if (posted) focusedCard.current = posted.dataset.commentCard;
      draft.current = undefined;
    }
    if (focusId) focusedCard.current = focusId;
    const focusIndex = cards.findIndex(
      (card) =>
        card.dataset.commentCard ===
        (pending ? pendingId : focusedCard.current),
    );
    const tops = stackAnchoredComments(measured, { focusIndex });
    lane.dataset.anchored = "true";
    let bottom = 0;
    cards.forEach((card, index) => {
      const top = Math.round(tops[index]!);
      // Cards move whenever a neighbour's height or anchor settles, so they are
      // placed outright. Animating it reads as a card sliding down the lane.
      card.style.transform = `translateY(${top}px)`;
      card.dataset.commentActive = String(index === focusIndex);
      bottom = Math.max(bottom, top + measured[index]!.height);
    });
    const active = cards[focusIndex];
    const anchorTop = measured[focusIndex]?.anchorTop;
    const alignmentKey = active
      ? `${active.dataset.commentCard}:${active.dataset.anchorPos}:${Math.round(tops[focusIndex]!)}:${active.offsetHeight}:${lane.clientWidth}`
      : "";
    if (commentsPane && documentPane) {
      const oldScroll = commentsPane.scrollTop;
      const viewportTop = commentsPane.getBoundingClientRect().top;
      const anchorViewportTop =
        anchorTop === undefined
          ? undefined
          : anchorTop + laneTop - scrollOffset;
      const alignTo =
        anchorViewportTop === undefined
          ? undefined
          : Math.max(0, tops[focusIndex]! - (anchorViewportTop - viewportTop));
      // Enough trailing space for a focused card to align even near document
      // edges; keep the document's own scroll extent independent of the lane.
      lane.style.height = `${Math.max(bottom, documentPane.scrollHeight - (viewportTop - documentPane.getBoundingClientRect().top), (alignTo ?? 0) + commentsPane.clientHeight)}px`;
      if (oldScroll !== commentsPane.scrollTop)
        scrollDocumentPaneIndependently(commentsPane, commentsPane.scrollTop);
      // Preserve recorded native and linked scrolling. Selection changes (or
      // an explicit reselection below) invalidate the alignment separately.
      const tracked = independentScrollPosition(commentsPane);
      const alignmentHeld =
        tracked !== undefined &&
        Math.abs(commentsPane.scrollTop - tracked) <= 1;
      if (
        (alignmentKey !== lastAlignment.current || !alignmentHeld) &&
        alignTo !== undefined
      ) {
        scrollDocumentPaneIndependently(commentsPane, alignTo);
        // A card anchored near the Document edge can still sit outside the
        // panel. Moving both panes by the same amount keeps the card level
        // with its text, so the pair travels on the outer scrollbar instead of
        // the comments lane sliding away on its own. That happens once, when
        // the card is selected or reselected: while the reader scrolls, the
        // sticky lane shifts near the Document's end and realigns, and pulling
        // the Document back to a card far above threw the reader back up.
        const revealing = `${active?.dataset.commentCard}:${measured[focusIndex]?.height}`;
        const revealRequested =
          lastAlignment.current === "" || revealedCard.current !== revealing;
        revealedCard.current = revealing;
        const together = revealRequested
          ? focusedCardScrollDelta({
              cardHeight: measured[focusIndex]?.height ?? 0,
              cardTop: tops[focusIndex]!,
              paneHeight: commentsPane.clientHeight,
              scrollTop: commentsPane.scrollTop,
            })
          : 0;
        if (together !== 0) {
          scrollDocumentPaneIndependently(
            commentsPane,
            commentsPane.scrollTop + together,
          );
          scrollDocumentPaneIndependently(
            documentPane,
            documentPane.scrollTop + together,
          );
        }
      }
    } else {
      lane.style.height = `${bottom}px`;
    }
    lastAlignment.current = alignmentKey;
    onAnchoredChange(true);
  }, [focusId, pendingId, laneRef, onAnchoredChange, resolveAnchorTop]);

  useLayoutEffect(() => {
    layout();
  }, [layout, revision]);

  useEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const frame = { id: 0 };
    const schedule = () => {
      if (frame.id) return;
      frame.id = requestAnimationFrame(() => {
        frame.id = 0;
        layout();
      });
    };
    const documentLayout = lane.closest<HTMLElement>(
      "[data-document-scroll-layout]",
    );
    const reselect = (event: MouseEvent) => {
      if (event.button !== 0 || !focusId || pendingId) return;
      const target = event.target;
      const mark =
        target instanceof Element
          ? target.closest<HTMLElement>(".bn-thread-mark[data-bn-thread-id]")
          : null;
      if (
        mark?.dataset.bnThreadId !== focusId ||
        mark.dataset.orphan === "true" ||
        !mark.closest(".bn-editor") ||
        mark.closest("[data-document-comments-scroll]")
      )
        return;
      // BlockNote deliberately emits no selection change for the active mark.
      // Treat this explicit click as a new alignment request, not scroll drift.
      lastAlignment.current = "";
      schedule();
    };
    documentLayout?.addEventListener("click", reselect, true);
    // Card heights settle asynchronously where the browser reports them.
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(schedule)
        : undefined;
    observer?.observe(lane);
    for (const card of lane.querySelectorAll<HTMLElement>(
      ":scope > [data-comment-card]",
    )) {
      observer?.observe(card);
    }
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (frame.id) cancelAnimationFrame(frame.id);
      observer?.disconnect();
      documentLayout?.removeEventListener("click", reselect, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [focusId, pendingId, laneRef, layout, revision]);
}
