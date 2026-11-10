import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * FLIP-animates the Room list rows when pinning reorders them: each row glides
 * from where it was to where it lands instead of jumping, so the eye follows a
 * pinned room to the top. Rows are keyed by their link, positions are recorded
 * every layout, and the next layout animates the delta. Honors reduced motion.
 */
export function useNavReorderFlip(
  listRef: RefObject<HTMLElement | null>,
  orderKey: string,
) {
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const rows = list.querySelectorAll<HTMLElement>(".group");
    // Record positions in the list's own content space (viewport offset minus
    // the list's, plus scroll), so a scroll between pins never leaks into the
    // measured delta.
    const listTop = list.getBoundingClientRect().top;
    const next = new Map<string, number>();
    for (const row of rows) {
      const key = row.querySelector("a[href]")?.getAttribute("href");
      if (!key) continue;
      const top = row.getBoundingClientRect().top - listTop + list.scrollTop;
      next.set(key, top);
      const previous = positions.current.get(key);
      if (previous === undefined || reduced) continue;
      const delta = previous - top;
      if (Math.abs(delta) < 1) continue;
      row.animate(
        [
          { transform: `translateY(${delta}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: 450, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      );
    }
    positions.current = next;
  }, [listRef, orderKey]);
}
