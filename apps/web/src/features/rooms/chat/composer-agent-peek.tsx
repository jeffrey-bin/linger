import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useAgentAvatarRecord } from "../members/actor-avatar-image";
import {
  agentAvatarAppearance,
  resolveAgentAvatarKey,
} from "../members/agent-avatar";
import { AgentAvatarPortrait } from "../members/agent-avatar-portrait";

/** Typing must run this long, with pauses no longer than the gap below. */
export const PEEK_TYPING_MS = 2500;
const PEEK_TYPING_GAP_MS = 1500;
/** The draft must be at least this long, so quick replies never summon it. */
const PEEK_MIN_LENGTH = 12;
/** A pause this long sends the watchers back down until typing resumes. */
export const PEEK_IDLE_MS = 5000;
const PEEK_BLINK_MIN_MS = 4000;
const PEEK_BLINK_SPREAD_MS = 2000;
const PEEK_NOD_MS = 320;
/** The edit right after a paste belongs to it, not to typing. */
const PASTE_EDIT_MS = 100;
/** At most this many Agents peek; the rest are counted beside them. */
const PEEK_MAX_AGENTS = 3;
const PEEK_STAGGER_MS = 150;

export interface ComposerPeekAgent {
  id: string;
  display_name: string;
}

/**
 * Decides when Agents peek over the composer. They rise once someone has
 * been writing for a while, not on the first key, so short replies stay
 * quiet. Typing drives every timer from its event handlers; nothing polls.
 */
export function useComposerPeek() {
  const [visible, setVisible] = useState(false);
  const [blink, setBlink] = useState(0);
  const state = useRef({
    dismissed: false,
    engaged: false,
    lastTypedAt: 0,
    length: 0,
    pastedAt: -Infinity,
    streakStartedAt: 0,
    visible: false,
  });
  const timers = useRef<{ blink?: number; idle?: number; show?: number }>({});

  const clear = useCallback((name: "blink" | "idle" | "show") => {
    window.clearTimeout(timers.current[name]);
    timers.current[name] = undefined;
  }, []);
  const lower = useCallback(() => {
    state.current.visible = false;
    setVisible(false);
    clear("blink");
    clear("idle");
  }, [clear]);
  const scheduleBlink = useCallback(() => {
    clear("blink");
    timers.current.blink = window.setTimeout(
      () => {
        if (!state.current.visible) return;
        setBlink((count) => count + 1);
        scheduleBlink();
      },
      PEEK_BLINK_MIN_MS + Math.random() * PEEK_BLINK_SPREAD_MS,
    );
  }, [clear]);
  const raise = useCallback(() => {
    state.current.engaged = true;
    if (!state.current.visible) {
      state.current.visible = true;
      setVisible(true);
      scheduleBlink();
    }
    clear("idle");
    timers.current.idle = window.setTimeout(lower, PEEK_IDLE_MS);
  }, [clear, lower, scheduleBlink]);
  const reset = useCallback(() => {
    clear("show");
    lower();
    Object.assign(state.current, {
      dismissed: false,
      engaged: false,
      lastTypedAt: 0,
      streakStartedAt: 0,
    });
  }, [clear, lower]);

  /** Reports the draft length after each edit or input-method update. */
  const typed = useCallback(
    (length: number) => {
      const current = state.current;
      current.length = length;
      if (length === 0) return reset();
      // Sent away by a click, they stay down until the next draft.
      if (current.dismissed) return;
      const now = performance.now();
      // A paste is not typing; it neither starts nor extends a streak.
      if (now - current.pastedAt < PASTE_EDIT_MS) return;
      if (now - current.lastTypedAt > PEEK_TYPING_GAP_MS) {
        current.streakStartedAt = now;
      }
      current.lastTypedAt = now;
      // Once summoned for this draft, typing again brings them straight back.
      if (current.engaged) return raise();
      const ready = () =>
        current.length >= PEEK_MIN_LENGTH &&
        performance.now() - current.streakStartedAt >= PEEK_TYPING_MS;
      if (ready()) return raise();
      clear("show");
      timers.current.show = window.setTimeout(
        () => {
          const idle = performance.now() - current.lastTypedAt;
          if (!current.engaged && idle <= PEEK_TYPING_GAP_MS && ready()) {
            raise();
          }
        },
        Math.max(0, current.streakStartedAt + PEEK_TYPING_MS - now),
      );
    },
    [clear, raise, reset],
  );
  const pasted = useCallback(() => {
    state.current.pastedAt = performance.now();
  }, []);
  /** On send the watchers nod once, then duck away. */
  const submitted = useCallback(() => {
    const wasVisible = state.current.visible;
    clear("show");
    clear("blink");
    clear("idle");
    Object.assign(state.current, {
      dismissed: false,
      engaged: false,
      lastTypedAt: 0,
      streakStartedAt: 0,
    });
    if (!wasVisible) return;
    setBlink((count) => count + 1);
    timers.current.idle = window.setTimeout(lower, PEEK_NOD_MS);
  }, [clear, lower]);

  /** A click on a watcher sends them all down for the rest of this draft. */
  const dismiss = useCallback(() => {
    clear("show");
    state.current.dismissed = true;
    lower();
  }, [clear, lower]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      window.clearTimeout(pending.blink);
      window.clearTimeout(pending.idle);
      window.clearTimeout(pending.show);
    };
  }, []);

  return { blink, dismiss, pasted, submitted, typed, visible };
}

/**
 * The Agents being written to peek over the composer's top edge: the first
 * addressed one sits on the right and rises first, and they leave in the
 * same order.
 */
export function ComposerAgentPeek({
  agents,
  blink,
  onDismiss,
  onReturnFocus,
  visible,
}: {
  agents: readonly ComposerPeekAgent[];
  blink: number;
  onDismiss: () => void;
  onReturnFocus?: () => void;
  visible: boolean;
}) {
  if (!agents.length || prefersReducedMotion()) return null;
  const shown = agents.slice(0, PEEK_MAX_AGENTS);
  const hidden = agents.length - shown.length;
  return (
    <div
      className="pointer-events-none absolute bottom-full right-6 flex h-11 flex-row-reverse items-end overflow-hidden"
      data-testid="composer-agent-peek"
      data-visible={visible || undefined}
    >
      {shown.map((agent, index) => (
        <PeekingAgent
          agent={agent}
          blink={blink}
          delay={index * PEEK_STAGGER_MS}
          key={agent.id}
          onDismiss={onDismiss}
          onReturnFocus={onReturnFocus}
          visible={visible}
        />
      ))}
      {hidden > 0 ? (
        <span
          className="mb-1 mr-1 rounded-full border border-app-border bg-app-surface px-1.5 text-[12px] leading-[18px] text-app-subtle transition-transform duration-300"
          style={{
            transform: visible ? "translateY(0)" : "translateY(140%)",
            transitionDelay: `${shown.length * PEEK_STAGGER_MS}ms`,
          }}
        >
          +{hidden}
        </span>
      ) : null}
    </div>
  );
}

function PeekingAgent({
  agent,
  blink,
  delay,
  onDismiss,
  onReturnFocus,
  visible,
}: {
  agent: ComposerPeekAgent;
  blink: number;
  delay: number;
  onDismiss: () => void;
  onReturnFocus?: () => void;
  visible: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(onReturnFocus);
  useLayoutEffect(() => {
    returnFocusRef.current = onReturnFocus;
  });
  useLayoutEffect(() => {
    const button = buttonRef.current;
    return () => {
      if (document.activeElement === button) returnFocusRef.current?.();
    };
  }, []);
  useEffect(() => {
    if (!visible && document.activeElement === buttonRef.current)
      onReturnFocus?.();
  }, [visible, onReturnFocus]);
  const record = useAgentAvatarRecord(agent.id);
  const avatarKey = resolveAgentAvatarKey({
    actorId: agent.id,
    name: agent.display_name,
    storedKey: record?.avatarKey,
  });
  // Each Agent blinks a beat after the one before it, never in lockstep.
  const [ownBlink, setOwnBlink] = useState(0);
  useEffect(() => {
    if (!blink) return;
    const timer = window.setTimeout(() => setOwnBlink(blink), delay * 2);
    return () => window.clearTimeout(timer);
  }, [blink, delay]);
  if (agentAvatarAppearance(avatarKey).kind === "image") return null;
  return (
    // Pointer interaction keeps focus in the draft; keyboard users can also dismiss it.
    <button
      ref={buttonRef}
      aria-hidden={!visible}
      aria-label={`Dismiss ${agent.display_name} avatar`}
      type="button"
      tabIndex={visible ? 0 : -1}
      className={`relative size-11 shrink-0 not-last:-ml-2 transition-transform duration-500 ease-[cubic-bezier(0.34,1.4,0.64,1)] ${visible ? "pointer-events-auto cursor-pointer" : ""}`}
      data-testid="composer-peeking-agent"
      onClick={onDismiss}
      onMouseDown={(event) => event.preventDefault()}
      style={{
        transform: visible ? "translateY(25%)" : "translateY(100%)",
        transitionDelay: `${delay}ms`,
      }}
    >
      {/* Only the figure peeks; its tile color stays behind the composer. */}
      <AgentAvatarPortrait
        avatarKey={avatarKey}
        blink={ownBlink}
        className="!bg-transparent"
        hold={visible}
      />
    </button>
  );
}

function prefersReducedMotion() {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}
