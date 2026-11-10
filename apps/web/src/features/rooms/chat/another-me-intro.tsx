import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ActorAvatar } from "@/features/rooms/members/actor-avatar";

/** How long Another Me holds its greeting before it moves to the sidebar. */
const GREETING_HOLD_MS = 2400;
const REDUCED_GREETING_HOLD_MS = 1400;
const FLIGHT_MS = 700;
const FLIGHT_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

export function anotherMeIntroStorageKey(accountId: string) {
  return `linger.another-me-intro.${accountId}`;
}

/**
 * The first visit to the Another Me Room opens on Another Me itself: its
 * figure greets the Human at the center of the screen, then flies into the
 * Another Me card at the top of the sidebar while the workspace fades in.
 * A click, Escape, or the reduced motion preference shortens it to a fade.
 */
export function AnotherMeIntro({
  agent,
  humanName,
  onDone,
}: {
  agent: { display_name: string; id: string };
  humanName: string;
  onDone: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const leavingRef = useRef(false);
  const doneRef = useRef(onDone);
  const [cheer, setCheer] = useState(0);

  useEffect(() => {
    doneRef.current = onDone;
  });

  useEffect(() => {
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    function leave() {
      if (leavingRef.current) return;
      leavingRef.current = true;
      const animations = [
        fade(textRef.current, 250, 0),
        fade(backdropRef.current, 600, 150),
        reduced
          ? fade(avatarRef.current, 300, 0)
          : flyToSidebar(avatarRef.current),
      ];
      if (animations.some((animation) => !animation)) {
        doneRef.current();
        return;
      }
      void Promise.all(animations.map((animation) => animation!.finished))
        .catch(() => undefined)
        .then(() => doneRef.current());
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") leave();
    }
    const cheerTimer = window.setTimeout(() => setCheer(1), 500);
    const leaveTimer = window.setTimeout(
      leave,
      reduced ? REDUCED_GREETING_HOLD_MS : GREETING_HOLD_MS,
    );
    const layer = backdropRef.current?.parentElement;
    layer?.addEventListener("click", leave);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(cheerTimer);
      window.clearTimeout(leaveTimer);
      layer?.removeEventListener("click", leave);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center"
      data-testid="another-me-intro"
    >
      <div className="absolute inset-0 bg-background" ref={backdropRef} />
      <div className="relative flex flex-col items-center gap-6">
        <div
          aria-hidden
          className="another-me-intro-avatar will-change-transform"
          ref={avatarRef}
        >
          <ActorAvatar
            actorId={agent.id}
            animate
            cheer={cheer}
            kind="agent"
            name={agent.display_name}
            showTitle={false}
            size="hero"
          />
        </div>
        <div
          className="another-me-intro-text text-center"
          ref={textRef}
          role="status"
        >
          <p className="text-2xl text-foreground">
            Hi{humanName ? `, ${humanName}` : ""}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {"I'm your Another Me."}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function fade(element: HTMLElement | null, duration: number, delay: number) {
  return element?.animate?.([{ opacity: 1 }, { opacity: 0 }], {
    delay,
    duration,
    easing: "ease-out",
    fill: "forwards",
  });
}

/** Moves the figure onto the sidebar card's avatar, or fades it in place. */
function flyToSidebar(element: HTMLElement | null) {
  const target = document.querySelector(".another-me-card-avatar");
  if (!element || !target) return fade(element, 300, 0);
  const from = element.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (!from.width || !to.width) return fade(element, 300, 0);
  const scale = to.width / from.width;
  const x = to.left + to.width / 2 - (from.left + from.width / 2);
  const y = to.top + to.height / 2 - (from.top + from.height / 2);
  // The real card avatar sits underneath; the copy hands off as it lands.
  return element.animate?.(
    [
      { opacity: 1, transform: "none" },
      {
        offset: 0.85,
        opacity: 1,
        transform: `translate(${x}px, ${y}px) scale(${scale})`,
      },
      { opacity: 0, transform: `translate(${x}px, ${y}px) scale(${scale})` },
    ],
    { duration: FLIGHT_MS, easing: FLIGHT_EASING, fill: "forwards" },
  );
}
