import { useEffect } from "react";

/** Warm optional panel code only after the usable chat has painted. */
export function usePrefetchPanelAfterPaint(
  ready: boolean,
  prefetch?: () => void,
) {
  useEffect(() => {
    if (!ready || !prefetch) return;
    let nextFrame = 0;
    let idle = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => {
        if (typeof globalThis.requestIdleCallback === "function") {
          idle = requestIdleCallback(prefetch, { timeout: 1000 });
        } else {
          timer = setTimeout(prefetch, 0);
        }
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nextFrame);
      if (idle) globalThis.cancelIdleCallback?.(idle);
      clearTimeout(timer);
    };
  }, [ready, prefetch]);
}
