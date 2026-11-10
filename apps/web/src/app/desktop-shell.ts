import { useState } from "react";

/**
 * The desktop app (its preload exposes `window.lingerDesktop`) lays the
 * window out as a fixed module rail, a collapsible list and content cards on
 * a grey frame. Browsers keep the web layout. Styles key off
 * html[data-desktop-shell], set here rather than by the preload so desktop
 * builds that predate it get the same layout.
 */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && "lingerDesktop" in window;
}

export function markDesktopShell(root: HTMLElement = document.documentElement) {
  if (isDesktopShell()) root.dataset.desktopShell = "";
}

/** Whether the Chats list beside the rail is collapsed (desktop only). */
export function useDesktopListCollapsed(tenantId: string) {
  const storageKey = `linger:desktop-list-collapsed:chats:${tenantId}`;
  const [state, setState] = useState(() => ({
    storageKey,
    collapsed: readCollapsed(storageKey),
  }));
  const collapsed =
    state.storageKey === storageKey
      ? state.collapsed
      : readCollapsed(storageKey);
  function setCollapsed(next: boolean) {
    setState({ storageKey, collapsed: next });
    try {
      if (next) localStorage.setItem(storageKey, "1");
      else localStorage.removeItem(storageKey);
    } catch {
      // Collapsing still works for this session without saved preferences.
    }
  }
  return [collapsed, setCollapsed] as const;
}

function readCollapsed(storageKey: string) {
  try {
    return localStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}
