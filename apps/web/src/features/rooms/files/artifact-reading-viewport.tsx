import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { ArtifactReadingPosition } from "./artifact-preview-cache";

export function ArtifactReadingViewport({
  children,
  position,
}: {
  children: ReactNode;
  position?: ArtifactReadingPosition;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || !position) return;
    const top = position.scrollTop ?? 0;
    const left = position.scrollLeft ?? 0;
    let restoring = top > 0 || left > 0;
    const observer = new MutationObserver(restore);
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(restore);
    function stopRestoring() {
      restoring = false;
      observer.disconnect();
      resize?.disconnect();
      host?.removeEventListener("load", restore, true);
    }
    function restore() {
      if (!host || !restoring) return;
      host.scrollTop = top;
      host.scrollLeft = left;
      if (host.scrollTop === top && host.scrollLeft === left) stopRestoring();
    }
    function save() {
      if (restoring) return;
      position!.scrollTop = host!.scrollTop;
      position!.scrollLeft = host!.scrollLeft;
    }
    observer.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    resize?.observe(host);
    // Resource loads can grow scrollHeight without changing the viewport's
    // size or DOM tree. Image load events require a capture listener.
    host.addEventListener("load", restore, true);
    restore();
    if (!restoring) stopRestoring();
    host.addEventListener("scroll", save);
    host.addEventListener("wheel", stopRestoring, { passive: true });
    host.addEventListener("pointerdown", stopRestoring);
    host.addEventListener("keydown", stopRestoring);
    return () => {
      stopRestoring();
      host.removeEventListener("scroll", save);
      host.removeEventListener("wheel", stopRestoring);
      host.removeEventListener("pointerdown", stopRestoring);
      host.removeEventListener("keydown", stopRestoring);
    };
  }, [position]);
  return (
    <div
      className="min-h-0 flex-1 overflow-auto bg-app-surface"
      data-testid="artifact-reading-viewport"
      data-voice-scroll="document"
      ref={ref}
    >
      {children}
    </div>
  );
}
