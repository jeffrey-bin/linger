import { useCallback, useEffect, useRef, useState } from "react";

import type { TeamHubMessageReactionId } from "@/features/teamhub/teamhub-types";

import { animationsEnabled } from "./reaction-motion";

/**
 * The Reactions an Agent smiles at, with what floats up behind it: hearts for
 * a heart, sparkles for the rest. The Reaction's own glyph never floats.
 */
const CHEER_PARTICLES: Readonly<Record<string, string>> = {
  heart: "💗",
  "+1": "✨",
  smile: "✨",
  tada: "✨",
};

/** Repeated Reactions on one Message within this window cheer only once. */
const CHEER_COOLDOWN_MS = 3000;
const BURST_SIZE = 5;

export interface ReactionCheer {
  /** Increments once per cheer; 0 means none yet. */
  count: number;
  particle: string;
}

/**
 * Tracks the cheers of one Agent Message: adding one of the cheering
 * Reactions makes its author smile, removing a Reaction never does.
 */
export function useReactionCheer() {
  const [cheer, setCheer] = useState<ReactionCheer>({
    count: 0,
    particle: "",
  });
  const lastCheerAt = useRef(-Infinity);
  const cheerOnAdd = useCallback((reactionId: TeamHubMessageReactionId) => {
    const particle = CHEER_PARTICLES[reactionId];
    const now = performance.now();
    if (!particle || now - lastCheerAt.current < CHEER_COOLDOWN_MS) return;
    lastCheerAt.current = now;
    setCheer((current) => ({ count: current.count + 1, particle }));
  }, []);
  return { cheer, cheerOnAdd };
}

/**
 * A few hearts or sparkles float up from behind the avatar one after another,
 * each drifting its own way, and fade out.
 */
export function ReactionCheerBurst({ cheer }: { cheer: ReactionCheer }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!cheer.count || !container || !animationsEnabled(container)) return;
    const pieces = Array.from({ length: BURST_SIZE }, (_, index) => {
      const piece = document.createElement("span");
      piece.textContent = cheer.particle;
      // Invisible on its own, so no piece shows before or after its flight.
      piece.className =
        "pointer-events-none absolute left-1/2 top-0 text-[14px] leading-none opacity-0";
      container.append(piece);
      // Each drifts its own random way while it rises and grows.
      const drift = Math.random() * 40 - 20;
      const animation = piece.animate(
        [
          { opacity: 0, transform: "translate(-50%, 0) scale(0.6)" },
          { offset: 0.12, opacity: 1 },
          {
            opacity: 0,
            transform: `translate(calc(-50% + ${drift}px), -46px) scale(1.15)`,
          },
        ],
        {
          delay: index * 120,
          duration: 1300,
          easing: "ease-out",
          fill: "both",
        },
      );
      animation.finished.then(
        () => piece.remove(),
        () => undefined,
      );
      return { animation, piece };
    });
    return () =>
      pieces.forEach(({ animation, piece }) => {
        animation.cancel();
        piece.remove();
      });
  }, [cheer]);
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[1]"
      ref={containerRef}
    />
  );
}
