import { lazy, Suspense, useEffect, useState } from "react";

import { agentAvatarAppearance, type AgentAvatarKey } from "./agent-avatar";

// The Lottie player loads only once a figure first moves.
const AgentAvatarMotion = lazy(() => import("./agent-avatar-motion"));

const CHEER_HOLD_MS = 1400;

/**
 * An Agent is a rounded square: an animal character, or an uploaded image, on
 * the background color chosen with it.
 */
export function AgentAvatarPortrait({
  animate = false,
  avatarKey,
  blink = 0,
  cheer = 0,
  className = "",
  hold = false,
  image,
  presentation = "avatar",
}: {
  /** Play the figure's peek-and-smile motion once each time this turns on. */
  animate?: boolean;
  avatarKey: AgentAvatarKey;
  /** Each new value blinks once while the figure holds its smile. */
  blink?: number;
  /** Each new value makes the figure lean in and smile once. */
  cheer?: number;
  className?: string;
  /** Lean in and keep smiling until this turns off. */
  hold?: boolean;
  /** Uploaded image data URL, shown when the key selects an image. */
  image?: string;
  presentation?: "avatar" | "hero";
}) {
  const appearance = agentAvatarAppearance(avatarKey);
  const uploaded = appearance.kind === "image" && image;
  const src = uploaded ? image : `/agent-avatars/${appearance.figure}.svg`;
  // Fade each portrait in as it paints so swapping the placeholder figure for
  // the uploaded image reads as one soft step, not a pop. Comparing the loaded
  // source to the current one re-arms the fade whenever the source changes.
  const [loadedSrc, setLoadedSrc] = useState<string>();
  const shown = !src || loadedSrc === src;
  const [cheering, setCheering] = useState(false);
  useEffect(() => {
    if (!cheer) return;
    setCheering(true);
    const settle = window.setTimeout(() => setCheering(false), CHEER_HOLD_MS);
    return () => window.clearTimeout(settle);
  }, [cheer]);
  const holding = hold || cheering;
  // Mount the motion on the first move and keep it, so later moves are instant.
  const [moved, setMoved] = useState(false);
  if ((animate || holding) && !moved && !uploaded && !prefersReducedMotion()) {
    setMoved(true);
  }
  return (
    <span
      className={`agent-avatar-tile ${className}`}
      data-kind={uploaded ? "image" : "figure"}
      data-presentation={presentation}
      style={{ backgroundColor: appearance.color }}
    >
      <img
        alt=""
        decoding="async"
        loading="lazy"
        draggable={false}
        onLoad={() => setLoadedSrc(src)}
        src={src}
        style={{
          opacity: shown ? 1 : 0,
          transition: "opacity 200ms ease",
        }}
      />
      {moved && appearance.kind !== "image" ? (
        <Suspense fallback={null}>
          <AgentAvatarMotion
            blink={blink}
            figure={appearance.figure}
            hold={holding}
            playing={animate}
          />
        </Suspense>
      ) : null}
    </span>
  );
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}
