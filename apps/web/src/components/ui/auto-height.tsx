import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

/**
 * Eases its height to its content's whenever the content grows or shrinks,
 * and to zero when closed. It clips only while it moves, so popovers and
 * focus rings inside stay visible at rest.
 */
export function AutoHeight({
  appear = false,
  children,
  className,
  open = true,
}: {
  /** Grow from nothing when it first mounts, instead of starting full. */
  appear?: boolean;
  children: ReactNode;
  className?: string;
  open?: boolean;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(
    appear ? 0 : undefined,
  );
  const [moving, setMoving] = useState(appear);
  // Growing from nothing, it also fades in, so the content never just cuts in.
  const [grown, setGrown] = useState(!appear);

  useLayoutEffect(() => {
    const element = inner.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    // The last measured height, so a change is detected outside the updater.
    let measured: number | undefined = appear ? 0 : undefined;
    const measure = () => {
      const next = element.offsetHeight;
      if (measured !== undefined && measured !== next) setMoving(true);
      measured = next;
      setHeight(next);
    };
    // Starting from zero, grow on the next frame so the change animates.
    let frame = 0;
    if (appear)
      frame = requestAnimationFrame(() => {
        measure();
        setGrown(true);
      });
    else measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [appear]);

  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setMoving(true);
  }, [open]);

  return (
    <div
      aria-hidden={open ? undefined : true}
      className={cn(
        "transition-[height,opacity] duration-(--chat-resize-duration) ease-(--app-out-quint) motion-reduce:transition-none",
        (moving || !open) && "overflow-hidden",
        className,
      )}
      inert={open ? undefined : true}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget) setMoving(false);
      }}
      style={{ height: open ? height : 0, opacity: open && grown ? 1 : 0 }}
    >
      <div ref={inner}>{children}</div>
    </div>
  );
}
