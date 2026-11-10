import { useEffect, useRef, useState } from "react";
import type { AnimationItem } from "lottie-web";

/**
 * Every figure shares one 84-frame timeline: it leans in by frame 21, blinks
 * at 32 and smiles at 40, then settles back to the resting pose by the end.
 */
const SMILE_FRAME = 40;
const BLINK_FROM_FRAME = 26;
const LAST_FRAME = 83;

/** The absolute frame: `currentFrame` counts from the playing segment's start. */
function absoluteFrame(animation: AnimationItem) {
  return Math.round(animation.firstFrame + animation.currentFrame);
}

/**
 * Leans in to the smile and holds it, or settles back from it. Leaning in and
 * settling back mirror each other, so turning around midway continues from
 * the matching frame instead of jumping.
 */
function playHold(animation: AnimationItem, hold: boolean) {
  const frame = absoluteFrame(animation);
  const atRest = frame <= 0 || frame >= LAST_FRAME - 1;
  animation.setLoop(false);
  if (hold) {
    const from = atRest ? 0 : frame > SMILE_FRAME ? LAST_FRAME - frame : frame;
    if (from !== SMILE_FRAME) animation.playSegments([from, SMILE_FRAME], true);
  } else if (!atRest) {
    const from = frame < SMILE_FRAME ? LAST_FRAME - frame : frame;
    animation.playSegments([from, LAST_FRAME], true);
  }
}

function motionUrl(figure: string) {
  return `/agent-avatar-motion/${figure}.json`;
}

/**
 * The figure's Lottie motion (peek, blink and smile), drawn over its still
 * portrait. It loads the first time the figure moves and stays mounted, so
 * later moves start at once. Each time `playing` turns on, the figure plays
 * the motion once and stops on its last frame, which is the resting pose; it
 * never loops, because every SVG frame forces a style and layout pass.
 * `hold` leans in and keeps the smile until it turns off, taking precedence
 * over playing; each new `blink` blinks once while it holds.
 */
export default function AgentAvatarMotion({
  blink = 0,
  figure,
  hold = false,
  playing,
}: {
  blink?: number;
  figure: string;
  hold?: boolean;
  playing: boolean;
}) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const [animation, setAnimation] = useState<AnimationItem>();
  useEffect(() => {
    let cancelled = false;
    let item: AnimationItem | undefined;
    void Promise.all([
      import("lottie-web/build/player/lottie_light"),
      fetch(motionUrl(figure)).then((response) => {
        if (!response.ok) throw new Error(`${figure} motion unavailable`);
        return response.json() as Promise<{ layers: { nm?: string }[] }>;
      }),
    ])
      .then(([{ default: lottie }, data]) => {
        if (cancelled || !boxRef.current) return;
        item = lottie.loadAnimation({
          animationData: {
            ...data,
            // The tile behind the figure carries the Agent's chosen color.
            layers: data.layers.filter(
              (layer) => layer.nm !== "Static background",
            ),
          },
          autoplay: false,
          container: boxRef.current,
          loop: false,
          renderer: "svg",
          rendererSettings: { preserveAspectRatio: "xMidYMid slice" },
        });
        // Inline animation data renders its SVG synchronously.
        setAnimation(item);
      })
      // The still portrait stays when the motion cannot load.
      .catch(() => undefined);
    return () => {
      cancelled = true;
      item?.destroy();
      setAnimation(undefined);
    };
  }, [figure]);
  const heldRef = useRef(false);
  useEffect(() => {
    if (!animation) return;
    if (hold || heldRef.current) {
      heldRef.current = hold;
      playHold(animation, hold);
      if (hold || !playing) return;
    }
    if (playing) {
      // A hold leaves a shorter segment behind; one play runs the whole one.
      if (absoluteFrame(animation) >= LAST_FRAME - 1 || animation.firstFrame) {
        animation.resetSegments(true);
      }
      animation.setLoop(false);
      animation.play();
    }
  }, [animation, hold, playing]);
  const blinkedRef = useRef(blink);
  useEffect(() => {
    // Only a new blink value blinks; a change of hold alone does not.
    if (!animation || blink === blinkedRef.current) return;
    blinkedRef.current = blink;
    if (hold) animation.playSegments([BLINK_FROM_FRAME, SMILE_FRAME], true);
  }, [animation, blink, hold]);
  return (
    <span
      aria-hidden="true"
      className="agent-avatar-motion"
      data-ready={animation ? "true" : undefined}
      ref={boxRef}
    />
  );
}
