import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  clampPanelSidebarWidth,
  PANEL_SIDEBAR_DEFAULT_WIDTH,
  panelSidebarMaxWidth,
  PANEL_SIDEBAR_MIN_WIDTH,
  writePanelSidebarWidth,
} from "./panel-width";

export function PanelResizeHandle({
  accountId,
  onDraggingChange,
  onWidthChange,
  width,
}: {
  accountId: string;
  onDraggingChange?: (dragging: boolean) => void;
  onWidthChange: (width: number) => void;
  width: number;
}) {
  const dragRef = useRef<{ originX: number; originWidth: number } | null>(null);
  const widthRef = useRef(width);
  const onWidthChangeRef = useRef(onWidthChange);
  const onDraggingChangeRef = useRef(onDraggingChange);
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => {
    widthRef.current = width;
  }, [width]);
  useLayoutEffect(() => {
    onWidthChangeRef.current = onWidthChange;
    onDraggingChangeRef.current = onDraggingChange;
  }, [onDraggingChange, onWidthChange]);

  useEffect(() => {
    if (!dragging) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      // Handle sits on the left edge; dragging left widens the sidebar.
      const next = clampPanelSidebarWidth(
        drag.originWidth + (drag.originX - event.clientX),
      );
      widthRef.current = next;
      onWidthChangeRef.current(next);
    }

    function finishResize() {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragging(false);
      onDraggingChangeRef.current?.(false);
      writePanelSidebarWidth(widthRef.current, accountId);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    window.addEventListener("lostpointercapture", finishResize);
    window.addEventListener("blur", finishResize);
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      window.removeEventListener("lostpointercapture", finishResize);
      window.removeEventListener("blur", finishResize);
    };
  }, [accountId, dragging]);

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- pointer dragging for the resize separator; keyboard input is handled by onKeyDown
    <div
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemax={panelSidebarMaxWidth()}
      aria-valuemin={PANEL_SIDEBAR_MIN_WIDTH}
      aria-valuenow={width}
      className="group absolute inset-y-0 left-0 z-20 w-3 -translate-x-1/2 cursor-col-resize touch-none"
      onDoubleClick={() => {
        const next = writePanelSidebarWidth(
          PANEL_SIDEBAR_DEFAULT_WIDTH,
          accountId,
        );
        widthRef.current = next;
        onWidthChange(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          const next = writePanelSidebarWidth(
            width + (event.shiftKey ? 32 : 8),
            accountId,
          );
          widthRef.current = next;
          onWidthChange(next);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          const next = writePanelSidebarWidth(
            width - (event.shiftKey ? 32 : 8),
            accountId,
          );
          widthRef.current = next;
          onWidthChange(next);
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        dragRef.current = { originWidth: width, originX: event.clientX };
        setDragging(true);
        onDraggingChangeRef.current?.(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      role="separator"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard-operable resize separator
      tabIndex={0}
      title="Drag to resize"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-focus-visible:bg-app-border-strong"
      />
    </div>
  );
}
