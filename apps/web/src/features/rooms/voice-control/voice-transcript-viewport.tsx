import { ArrowDown02Icon } from "@hugeicons/core-free-icons";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";

/** Layout/scroll anchoring must not be mistaken for a request to read history. */
export function VoiceTranscriptViewport({
  children,
  revealLatestKey,
}: {
  children: ReactNode;
  revealLatestKey?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);

  useLayoutEffect(() => {
    if (!revealLatestKey) return;
    followingRef.current = true;
    setFollowing(true);
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [revealLatestKey]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followingRef.current)
      viewport.scrollTop = viewport.scrollHeight;
  }, [children]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let pointerDown = false;
    const pin = () => {
      if (followingRef.current) viewport.scrollTop = viewport.scrollHeight;
    };
    const pause = () => {
      // Native scrolling may reach the top before a passive wheel callback.
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      followingRef.current = false;
      setFollowing(false);
    };
    const onScroll = () => {
      if (pointerDown || !followingRef.current) {
        const nearBottom =
          viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
          2;
        followingRef.current = nearBottom;
        setFollowing(nearBottom);
      }
      pin();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) pause();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      )
        pause();
    };
    const onPointerDown = () => {
      pointerDown = true;
    };
    const onPointerUp = () => {
      pointerDown = false;
    };
    const onPointerCancel = (event: PointerEvent) => {
      // Native touch scrolling cancels Pointer Events before it emits scroll.
      // Keep that gesture active until touchend so it is not treated as layout.
      if (event.pointerType !== "touch") pointerDown = false;
    };
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(pin)
        : undefined;
    observer?.observe(viewport);
    observer?.observe(content);
    viewport.addEventListener("scroll", onScroll);
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("keydown", onKeyDown);
    viewport.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("touchend", onPointerUp);
    window.addEventListener("touchcancel", onPointerUp);
    pin();
    return () => {
      observer?.disconnect();
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("keydown", onKeyDown);
      viewport.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("touchend", onPointerUp);
      window.removeEventListener("touchcancel", onPointerUp);
    };
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        aria-label="Transcript scroll area"
        className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto"
        ref={viewportRef}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard-focusable scroll region so keyboard users can scroll it
        tabIndex={0}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {!following ? (
        <Button
          className="absolute bottom-2 left-1/2 -translate-x-1/2 shadow-sm"
          size="compact"
          onClick={() => {
            followingRef.current = true;
            setFollowing(true);
            const viewport = viewportRef.current;
            if (viewport) viewport.scrollTop = viewport.scrollHeight;
          }}
        >
          <Icon icon={ArrowDown02Icon} size={14} />
          Follow latest transcript
        </Button>
      ) : null}
    </div>
  );
}
