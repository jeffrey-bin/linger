import { useEffect, useState } from "react";

import { figureKey } from "@/features/rooms/members/agent-avatar";
import { AgentAvatarPortrait } from "@/features/rooms/members/agent-avatar-portrait";

/** What Another Me says first, one nudge at a time, across a working day. */
const NUDGES = [
  { time: "9:00 AM", text: "Demo is tomorrow. I drafted the brief." },
  { time: "1:30 PM", text: "Codex reviewed the code. Two notes." },
  { time: "5:00 PM", text: "Before you go: the deck is ready." },
] as const;

const ANOTHER_ME = figureKey("deer");
// The first nudge waits for the headline and the card to settle.
const FIRST_NUDGE_MS = 3_000;
const NUDGE_EVERY_MS = 4_000;
// Long enough to start one peek-and-smile; the figure then finishes it and
// rests on its last frame.
const AWAKE_MS = 1_000;

type NudgeState = "next" | "previous" | "shown";

/**
 * The login page's picture: Another Me, a personal AI on your own computer,
 * reaching out before it is asked. It is decorative; the login shell hides it
 * from assistive technology.
 */
export function AuthIllustration() {
  // Reduced motion keeps the first nudge on screen and never starts the loop.
  const [landed, setLanded] = useState(() => (prefersReducedMotion() ? 1 : 0));
  const [awake, setAwake] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    let loop: number | undefined;
    let sleep: number | undefined;
    const land = () => {
      setLanded((count) => count + 1);
      setAwake(true);
      window.clearTimeout(sleep);
      sleep = window.setTimeout(() => setAwake(false), AWAKE_MS);
    };
    const first = window.setTimeout(() => {
      land();
      loop = window.setInterval(land, NUDGE_EVERY_MS);
    }, FIRST_NUDGE_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(loop);
      window.clearTimeout(sleep);
    };
  }, []);

  const current = landed === 0 ? null : (landed - 1) % NUDGES.length;

  return (
    <div className="auth-art">
      <div className="auth-art-nudges">
        {NUDGES.map((nudge, index) => (
          <p
            className="auth-art-nudge"
            data-state={nudgeState(index, current)}
            key={nudge.time}
          >
            <span className="auth-art-nudge-time">{nudge.time}</span>
            {nudge.text}
          </p>
        ))}
      </div>

      <div className="auth-art-mark">
        <div className="auth-art-card">
          <span className="auth-art-avatar">
            <AgentAvatarPortrait animate={awake} avatarKey={ANOTHER_ME} />
            {/* Keyed by the landing so the badge pops again for each nudge. */}
            {current === null ? null : (
              <span className="auth-art-badge town-pill-pop" key={landed}>
                1
              </span>
            )}
          </span>
        </div>
      </div>

      <div className="auth-art-copy">
        <h2 className="auth-art-title">
          <span>Your personal AI.</span>
          <span>A step ahead.</span>
        </h2>
        <p className="auth-art-lede">
          Another Me runs on your own computer, keeps track of your work, and
          reaches out before anything slips.
        </p>
        <ol className="auth-art-steps">
          <li>Your computer</li>
          <li aria-hidden="true">→</li>
          <li>Your context</li>
          <li aria-hidden="true">→</li>
          <li>Timely nudges</li>
        </ol>
      </div>
    </div>
  );
}

/**
 * The shown nudge leaves upward and the one after it waits below, so every
 * change reads as a new message arriving.
 */
function nudgeState(index: number, current: number | null): NudgeState {
  if (current === null) return "next";
  if (index === current) return "shown";
  return index === (current + 1) % NUDGES.length ? "next" : "previous";
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}
