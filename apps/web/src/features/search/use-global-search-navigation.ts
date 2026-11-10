import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from "react";

import {
  HOVER_SETTLE_MS,
  rowScope,
  SCROLL_SETTLE_MS,
  type GlobalSearchTab,
  type SearchResult,
} from "./global-search-model";

/**
 * The active row, the Enter target, and the field's keys that move it. One
 * selection tile slides between rows instead of each row lighting up.
 */
export function useActiveRow({
  layoutKey,
  onClose,
  openResult,
  query,
  rows,
  rowsKey,
  setTab,
  tab,
}: {
  layoutKey: string;
  onClose: () => void;
  openResult: (result: SearchResult) => Promise<void>;
  query: string;
  rows: SearchResult[];
  rowsKey: string;
  setTab: Dispatch<SetStateAction<GlobalSearchTab>>;
  tab: GlobalSearchTab;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollFromKeyboard = useRef(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // The active row stays the Enter target, but its highlight only shows while
  // the person is steering: typing, arrow keys, or the pointer over the list.
  const [highlightShown, setHighlightShown] = useState(true);

  useEffect(() => {
    setActiveIndex(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [rowsKey]);

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Backspace" && query === "" && tab !== "all") {
      event.preventDefault();
      setTab("all");
      return;
    }
    if (event.key === "Tab") {
      // Tab narrows the search to the type of the highlighted row.
      event.preventDefault();
      const scope = rowScope(rows[activeIndex]);
      if (scope && scope !== tab) setTab(scope);
      return;
    }
    if (rows.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      clearTimeout(hoverTimerRef.current);
      scrollFromKeyboard.current = rows.length > 1 || !highlightShown;
      setHighlightShown(true);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % rows.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        current <= 0 ? rows.length - 1 : current - 1,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[activeIndex] ?? rows[0];
      if (row) void openResult(row);
    }
  }

  const indicatorRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const indicator = indicatorRef.current;
    if (!list || !indicator) return;
    const row = list.querySelector<HTMLElement>(
      `#global-search-result-${activeIndex}[data-row]`,
    );
    if (!row || !highlightShown) {
      indicator.style.opacity = "0";
      return;
    }
    indicator.style.opacity = "1";
    indicator.style.height = `${row.offsetHeight}px`;
    indicator.style.transform = `translateY(${row.offsetTop}px)`;
    if (scrollFromKeyboard.current) {
      row.scrollIntoView({ block: "nearest" });
      scrollFromKeyboard.current = false;
    }
  }, [activeIndex, highlightShown, rowsKey, layoutKey]);

  return {
    activeIndex,
    highlightShown,
    hoverTimerRef,
    indicatorRef,
    listRef,
    onInputKeyDown,
    scrollFromKeyboard,
    setActiveIndex,
    setHighlightShown,
  };
}

/**
 * The pointer moves the active row only once it rests on a row, and never
 * while the list is still scrolling under it.
 */
export function usePointerSteering({
  activeIndex,
  hoverTimerRef,
  scrollFromKeyboard,
  setActiveIndex,
  setHighlightShown,
}: Pick<
  ReturnType<typeof useActiveRow>,
  | "activeIndex"
  | "hoverTimerRef"
  | "scrollFromKeyboard"
  | "setActiveIndex"
  | "setHighlightShown"
>) {
  const scrolling = useRef(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(
    () => () => {
      clearTimeout(hoverTimerRef.current);
      clearTimeout(scrollTimerRef.current);
    },
    [hoverTimerRef],
  );

  function hoverRow(index: number) {
    if (scrolling.current) return;
    scrollFromKeyboard.current = false;
    clearTimeout(hoverTimerRef.current);
    if (index === activeIndex) {
      setHighlightShown(true);
      return;
    }
    hoverTimerRef.current = setTimeout(() => {
      setActiveIndex(index);
      setHighlightShown(true);
    }, HOVER_SETTLE_MS);
  }

  function onListScroll() {
    scrolling.current = true;
    clearTimeout(hoverTimerRef.current);
    clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      scrolling.current = false;
    }, SCROLL_SETTLE_MS);
  }

  function onListLeave() {
    clearTimeout(hoverTimerRef.current);
    setHighlightShown(false);
  }

  return { hoverRow, onListLeave, onListScroll };
}
