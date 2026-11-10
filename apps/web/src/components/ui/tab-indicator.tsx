import { useLayoutEffect, useRef, useState } from "react";

/**
 * An underline that slides to the selected tab, inset like the tab's label.
 * The tab row must be positioned; no selection hides the underline.
 */
export function useTabIndicator<K>(selected: K | undefined) {
  const tabs = useRef(new Map<K, HTMLElement>());
  const [position, setPosition] = useState<{ left: number; width: number }>();
  useLayoutEffect(() => {
    const tab = selected === undefined ? undefined : tabs.current.get(selected);
    setPosition(
      tab
        ? { left: tab.offsetLeft + 12, width: tab.offsetWidth - 24 }
        : undefined,
    );
  }, [selected]);
  return {
    tabRef: (key: K) => (node: HTMLElement | null) => {
      if (node) tabs.current.set(key, node);
      else tabs.current.delete(key);
    },
    indicator: position ? (
      <span
        aria-hidden="true"
        className="workspace-tab-indicator"
        style={position}
      />
    ) : null,
  };
}
