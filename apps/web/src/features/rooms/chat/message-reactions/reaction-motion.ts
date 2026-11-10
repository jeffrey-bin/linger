/** Springy overshoot for things popping in. */
const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
/** Quick start, soft landing for things settling or leaving. */
export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

export function animationsEnabled(element: HTMLElement) {
  return (
    typeof element.animate === "function" &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Animates transform and opacity on their own curves, as the Reaction design
 * specifies: transform carries the spring or ease-out, opacity a plain ease.
 * Resolves once both have finished or been cancelled.
 */
export function animateTransform(
  element: HTMLElement,
  transform: [string, string],
  opacity: [number, number],
  timing: {
    delay?: number;
    duration: number;
    easing: "spring" | "out";
    fadeDuration: number;
  },
) {
  const fill = opacity[0] < opacity[1] ? "backwards" : "forwards";
  const animations = [
    element.animate(
      { transform },
      {
        delay: timing.delay,
        duration: timing.duration,
        easing: timing.easing === "spring" ? SPRING : EASE_OUT,
        fill,
      },
    ),
    element.animate(
      { opacity },
      {
        delay: timing.delay,
        duration: timing.fadeDuration,
        easing: "ease",
        fill,
      },
    ),
  ];
  return {
    cancel: () => animations.forEach((animation) => animation.cancel()),
    finished: Promise.allSettled(
      animations.map((animation) => animation.finished),
    ).then(() => undefined),
  };
}
