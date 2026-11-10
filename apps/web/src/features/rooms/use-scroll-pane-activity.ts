import { useEffect } from "react";

/** How long after the last scroll the pill stays before fading out. */
const SCROLL_IDLE_MS = 900;

/**
 * Marks the workspace scroll panes while they are scrolling, and the Room list
 * header once its list has moved off the top, so the floating scrollbar pill
 * and the header hairline can fade in and out. One capturing document listener
 * covers every pane, so individual panes need no wiring.
 */
export function useScrollPaneActivity() {
  useEffect(() => {
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const isPane =
        target.classList.contains("room-timeline") ||
        target.classList.contains("room-secondary-navigation-list");
      if (!isPane) return;
      if (target.classList.contains("room-secondary-navigation-list")) {
        target
          .closest(".app-secondary-navigation")
          ?.setAttribute("data-scrolled", String(target.scrollTop > 0));
      }
      target.setAttribute("data-scrolling", "true");
      clearTimeout(timers.get(target));
      timers.set(
        target,
        setTimeout(
          () => target.removeAttribute("data-scrolling"),
          SCROLL_IDLE_MS,
        ),
      );
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, []);
}
