import {
  type CSSProperties,
  type HTMLAttributes,
  useEffect,
  useRef,
  useState,
} from "react";

import { isDesktopShell } from "@/app/desktop-shell";

const SECONDARY_NAVIGATION_DEFAULT_WIDTH = 240;

/** Workspace and Wiki draw their secondary navigation at one shared width. */
export function useSecondaryNavigationWidth(tenantId: string) {
  return useSidebarWidth(
    `linger:chat-navigation-width:${tenantId}`,
    SECONDARY_NAVIGATION_DEFAULT_WIDTH,
  );
}

/**
 * The Room list is Town's 400px threads sidebar: the list plus its 20px of
 * margins, so it opens at 380px and resizes the column between 280 and 480.
 */
export function useRoomListWidth(tenantId: string) {
  // The desktop app keeps its narrower Chat list, one width with Workspace.
  const desktop = isDesktopShell();
  return useSidebarWidth(
    `linger:${desktop ? "chat-navigation" : "room-list"}-width:${tenantId}`,
    desktop ? SECONDARY_NAVIGATION_DEFAULT_WIDTH : 380,
    desktop ? {} : { min: 260, max: 460 },
  );
}

// Mounted instances sharing a key hear each saved width, so a navigation that
// stays mounted beside another page's resize does not keep a stale width.
const savedWidthListeners = new Map<string, Set<(width: number) => void>>();

export function useSidebarWidth(
  storageKey: string,
  defaultWidth: number,
  {
    min = 200,
    max = 360,
    edge = "right",
  }: { min?: number; max?: number; edge?: "left" | "right" } = {},
) {
  const direction = edge === "right" ? 1 : -1;
  const [preference, setPreference] = useState(() => ({
    storageKey,
    width: readWidth(storageKey, defaultWidth, min, max),
  }));
  const width =
    preference.storageKey === storageKey
      ? preference.width
      : readWidth(storageKey, defaultWidth, min, max);
  useEffect(() => {
    const listeners = savedWidthListeners.get(storageKey) ?? new Set();
    savedWidthListeners.set(storageKey, listeners);
    const listener = (saved: number) =>
      setPreference({ storageKey, width: saved });
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) savedWidthListeners.delete(storageKey);
    };
  }, [storageKey]);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);
  // The element carrying --sidebar-width. A drag writes the variable here
  // directly and commits React state on release, so a pointer move does not
  // re-render the whole navigation it sizes.
  const styleRef = useRef<HTMLElement | null>(null);

  function updateWidth(next: number) {
    const clamped = clampWidth(next, min, max);
    setPreference({ storageKey, width: clamped });
    try {
      localStorage.setItem(storageKey, String(clamped));
    } catch {
      // Resizing remains available when local preferences cannot be saved.
    }
    savedWidthListeners.get(storageKey)?.forEach((listener) => {
      listener(clamped);
    });
  }

  function finishResize() {
    if (!drag.current) return;
    updateWidth(drag.current.width);
    drag.current = null;
  }

  const handleProps: HTMLAttributes<HTMLDivElement> = {
    "aria-orientation": "vertical",
    "aria-valuemin": min,
    "aria-valuemax": max,
    "aria-valuenow": width,
    className: `sidebar-resize-handle sidebar-resize-handle-${edge}`,
    onDoubleClick: () => updateWidth(defaultWidth),
    onKeyDown: (event) => {
      const step = event.shiftKey ? 32 : 8;
      const next =
        event.key === "ArrowLeft"
          ? width - step * direction
          : event.key === "ArrowRight"
            ? width + step * direction
            : event.key === "Home"
              ? min
              : event.key === "End"
                ? max
                : undefined;
      if (next === undefined) return;
      event.preventDefault();
      updateWidth(next);
    },
    onPointerDown: (event) => {
      if (event.button !== 0 || drag.current) return;
      // Keep focus where it was: a programmatic focus here inherits the last
      // keyboard modality and draws the focus line after a mouse drag.
      event.preventDefault();
      drag.current = {
        pointerId: event.pointerId,
        startWidth: width,
        startX: event.clientX,
        width,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      active.width = clampWidth(
        active.startWidth + (event.clientX - active.startX) * direction,
        min,
        max,
      );
      styleRef.current?.style.setProperty(
        "--sidebar-width",
        `${active.width}px`,
      );
      event.currentTarget.setAttribute("aria-valuenow", String(active.width));
    },
    onPointerUp: (event) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      finishResize();
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    onLostPointerCapture: finishResize,
    onPointerCancel: finishResize,
    role: "separator",
    tabIndex: 0,
    title: "Drag to resize; double-click to reset",
  };

  return {
    handleProps,
    styleRef,
    style: { "--sidebar-width": `${width}px` } as CSSProperties,
  };
}

function clampWidth(width: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(width)));
}

function readWidth(
  key: string,
  defaultWidth: number,
  min: number,
  max: number,
) {
  try {
    const raw = localStorage.getItem(key);
    const value = raw ? Number(raw) : defaultWidth;
    return Number.isFinite(value) && value > 0
      ? clampWidth(value, min, max)
      : defaultWidth;
  } catch {
    return defaultWidth;
  }
}
