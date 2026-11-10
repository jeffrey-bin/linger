import {
  Cancel01Icon,
  Maximize01Icon,
  Mic01Icon,
  MicOff01Icon,
  Minimize01Icon,
  RotateLeft01Icon,
  VolumeHighIcon,
  VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Icon } from "@/components/ui/icon";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useMatch, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { isRunWorking } from "@/features/teamhub/run-status";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import {
  readRoomComposerDraft,
  subscribeRoomComposerDrafts,
} from "../../room-drafts";
import { roomMessagesInfiniteQueryOptions } from "../../room-queries";
import { useRoomRunStatusCollection } from "../../runtime-status/use-room-run-statuses";
import { ActorAvatar } from "../../members/actor-avatar";
import { voiceModeStatusLabel } from "./voice-mode-presentation";
import styles from "./voice-mode.module.css";
import { registerVoiceWindow, type VoiceWindowAction } from "./voice-ui-bridge";
import { onVoicePipClosedByHuman, useVoicePip } from "./voice-pip";
import { showVoiceNotice, useVoiceNotice } from "./voice-notice";
import {
  useOptionalVoiceModeSession,
  useVoiceModeLevel,
  type VoiceModeSession,
} from "./voice-mode-session";

const windowSizes = {
  compact: { height: "min(480px,70dvh)", width: 320 },
  expanded: { height: "min(760px,86dvh)", width: 560 },
} as const;
const windowGap = 16;
const positionKey = "linger:voice-mode-window";
/** Above this level the Human is speaking, not just breathing near the mic. */
const speakingLevel = 0.08;

interface Position {
  left: number;
  top: number;
}
type WindowSize = keyof typeof windowSizes;

/**
 * Floating window for the running Voice Mode session. It follows the Human
 * across Rooms, shows this session's turns and the Room's replies, and can be
 * dragged anywhere on screen. Where the browser supports it, the window lives
 * in an always-on-top picture-in-picture window instead, so it stays over other
 * tabs and apps. Closing it, from its own button or the desktop's, ends Voice
 * Mode: the window leaves at once while the session drains its last
 * words in the background, and the Room composer shows that finishing state.
 */
export default function VoiceModeMiniWindow({
  anotherMeActorId,
  currentActorId,
}: {
  anotherMeActorId?: string;
  currentActorId?: string;
}) {
  const voice = useOptionalVoiceModeSession();
  const session = voice?.session;
  if (!voice || !session || session.closing) return null;
  return (
    <MiniWindow
      anotherMeActorId={anotherMeActorId}
      currentActorId={currentActorId}
      onExit={voice.exit}
      onMute={voice.setMuted}
      onRetry={voice.retry}
      onSoundOff={voice.setSoundOff}
      session={session}
    />
  );
}

function MiniWindow({
  anotherMeActorId,
  currentActorId,
  onExit,
  onMute,
  onRetry,
  onSoundOff,
  session,
}: {
  anotherMeActorId?: string;
  currentActorId?: string;
  onExit: () => void;
  onMute: (muted: boolean) => Promise<void>;
  onRetry: () => void;
  onSoundOff: (soundOff: boolean) => void;
  session: VoiceModeSession;
}) {
  const { client } = useTeamHubRuntime();
  const navigate = useNavigate();
  const { roomId, roomName, tenantId } = session.target;
  const routeRoom = useMatch("/t/:tenantId/rooms/:roomId/*");
  const inVoiceRoom = routeRoom?.params.roomId === roomId;
  // The Room's own Chat keeps its caches live; elsewhere this window does,
  // which also lets live Voice Mode hear the Agent's replies.
  const messages = useInfiniteQuery({
    ...roomMessagesInfiniteQueryOptions(client, tenantId, roomId),
    refetchInterval: inVoiceRoom ? false : 3_000,
  });
  // Live Voice Mode shows its own transcript instead of who is replying.
  const runStatuses = useRoomRunStatusCollection({
    enabled: !inVoiceRoom && !session.live,
    roomId,
    tenantId,
  });
  const turns = sessionMessages(
    messages.data?.pages.flatMap((page) => page.items) ?? [],
    session.startedAt,
  );
  // A Run status carries no reply text, so the window shows which Agents are
  // still working; their words arrive as Messages.
  const replying = runStatuses.items.filter(isRunWorking);
  // Words already said come before the reply to them; words being said now
  // come after it.
  const heard = session.entered
    ? (session.state.heardText ?? session.state.text).trim()
    : "";
  const saying = session.entered
    ? (session.state.speakingText ?? "").trim()
    : "";
  const live = [heard, saying].filter(Boolean).join("\n");
  // Live Voice Mode shows the call as it was said, so a reply saved late or
  // an Agent answer arriving between turns never reorders it.
  const transcript = session.live?.transcript;
  const soundOff = session.live?.soundOff;
  const pendingMaterials = useSyncExternalStore(
    subscribeRoomComposerDrafts,
    () =>
      readRoomComposerDraft({
        accountId: session.target.accountId,
        roomId,
        tenantId,
      }).voiceMaterials?.length ?? 0,
  );
  const notice = useVoiceNotice();
  const pip = useVoicePip("voice-mode");
  // One window: the desktop's close button on the floating one ends Voice Mode too.
  const exitRef = useRef(onExit);
  useLayoutEffect(() => {
    exitRef.current = onExit;
  });
  useEffect(
    () => onVoicePipClosedByHuman("voice-mode", () => exitRef.current()),
    [],
  );

  // Every session opens compact; only the expand button enlarges it.
  const [size, setSize] = useState<WindowSize>("compact");
  const { width, height } = windowSizes[size];
  const { consumeDrag, dragHandlers, place, position } =
    useDraggablePosition(width);
  const windowControl = useRef<(action: VoiceWindowAction) => void>(() => {});
  useLayoutEffect(() => {
    windowControl.current = (action) => {
      if (action === "mute" || action === "unmute")
        void onMute(action === "mute");
      // The desktop places a picture-in-picture window; only a drag moves it.
      else if (pip)
        showVoiceNotice("Drag the floating window to move or resize it.");
      else if (action === "expand" || action === "shrink")
        setSize(action === "expand" ? "expanded" : "compact");
      else place(action === "move_left" ? "left" : "right");
    };
  });
  useEffect(
    () => registerVoiceWindow((action) => windowControl.current(action)),
    [],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const contentVersion = transcript
    ? `${transcript.length}:${transcript.at(-1)?.text.length}:${saying.length}`
    : `${turns.length}:${turns.at(-1)?.id}:${replying.length}:${live.length}`;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [contentVersion]);

  const state = session.state;
  const muted = session.muted;
  const listening = Boolean(state.microphoneActive) && !muted;
  const toggleSize = () => {
    const next: WindowSize = size === "compact" ? "expanded" : "compact";
    setSize(next);
  };
  return createPortal(
    <section
      aria-label="Voice Mode window"
      className={
        pip
          ? "flex h-dvh w-full flex-col overflow-hidden bg-app-canvas"
          : "app-floating-enter fixed z-[90] flex flex-col overflow-hidden rounded-xl bg-app-canvas shadow-xl transition-[width,max-height] duration-200 ease-out motion-reduce:transition-none"
      }
      data-pip={pip ? true : undefined}
      data-size={size}
      style={pip ? undefined : { ...position, maxHeight: height, width }}
    >
      <header
        className={`flex shrink-0 select-none items-center gap-2 border-b border-app-border px-3 py-2 ${
          pip ? "" : "cursor-grab touch-none active:cursor-grabbing"
        }`}
        {...(pip ? {} : dragHandlers)}
      >
        <VoiceAvatarBeat listening={listening}>
          <span className={styles.avatarSpin}>
            <ActorAvatar
              actorId={anotherMeActorId}
              kind="agent"
              name="Another Me"
              size="xs"
            />
          </span>
        </VoiceAvatarBeat>
        <button
          className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
          onClick={() => {
            if (!consumeDrag())
              void navigate(`/t/${tenantId}/rooms/${roomId}/chat`);
          }}
          title="Open this conversation"
          type="button"
        >
          <span className="block truncate text-[14px] font-medium leading-5 text-app-ink">
            {roomName || "Voice Mode"}
          </span>
          <span className="block truncate text-[12px] leading-4 text-app-muted">
            {voiceModeStatusLabel({ ...state, entered: session.entered })}
          </span>
        </button>
        <span
          className="flex shrink-0 items-center"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {state.canRetry ? (
            <Button
              // Names differ from the Room composer's controls so both can
              // be on screen without two identically named buttons.
              aria-label="Retry voice message from the voice window"
              disabled={state.sending}
              onClick={onRetry}
              size="compactIcon"
              tone="ghost"
            >
              <Icon icon={RotateLeft01Icon} size={16} />
            </Button>
          ) : null}
          <Button
            aria-label={muted ? "Unmute Voice Mode" : "Mute Voice Mode"}
            aria-pressed={muted}
            disabled={!state.microphoneActive}
            onClick={() => void onMute(!muted)}
            size="compactIcon"
            tone="ghost"
          >
            {muted ? (
              <Icon icon={MicOff01Icon} size={16} />
            ) : (
              <Icon icon={Mic01Icon} size={16} />
            )}
          </Button>
          {soundOff === undefined ? null : (
            <Button
              aria-label={
                soundOff
                  ? "Turn reply sound on from the voice window"
                  : "Turn reply sound off from the voice window"
              }
              aria-pressed={soundOff}
              onClick={() => onSoundOff(!soundOff)}
              size="compactIcon"
              tone="ghost"
            >
              {soundOff ? (
                <Icon icon={VolumeOffIcon} size={16} />
              ) : (
                <Icon icon={VolumeHighIcon} size={16} />
              )}
            </Button>
          )}
          {pip ? null : (
            <Button
              aria-label={
                size === "compact"
                  ? "Expand Voice Mode window"
                  : "Shrink Voice Mode window"
              }
              onClick={toggleSize}
              size="compactIcon"
              tone="ghost"
            >
              {size === "compact" ? (
                <Icon icon={Maximize01Icon} size={14} />
              ) : (
                <Icon icon={Minimize01Icon} size={14} />
              )}
            </Button>
          )}
          {/* The floating window's own close button ends Voice Mode there. */}
          {pip ? null : (
            <Button
              aria-label="End Voice Mode"
              onClick={onExit}
              size="compactIcon"
              tone="ghost"
            >
              <Icon icon={Cancel01Icon} size={16} />
            </Button>
          )}
        </span>
      </header>
      <div
        aria-label="Voice Mode conversation"
        aria-live="polite"
        className="workspace-scrollbar min-h-24 flex-1 space-y-2 overflow-y-auto px-3 py-3"
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            24;
        }}
        ref={scrollRef}
        role="log"
      >
        {(transcript ? transcript.length : turns.length || replying.length) ||
        live ? null : (
          <p className="py-4 text-center text-xs text-app-muted">
            Start speaking. Your words and replies appear here.
          </p>
        )}
        {transcript ? (
          transcript.map((line) => (
            <Bubble
              agent={line.speaker !== "you"}
              author={
                line.speaker === "you"
                  ? "You"
                  : session.target.recipient?.display_name || "Reply"
              }
              key={line.id}
              own={line.speaker === "you"}
              pending={line.pending}
              text={line.text}
            />
          ))
        ) : (
          <>
            {turns.map((message) => (
              <Bubble
                agent={message.author.kind === "agent"}
                author={message.author.display_name}
                key={message.id}
                own={
                  currentActorId
                    ? message.author.id === currentActorId
                    : message.author.kind === "human"
                }
                text={message.raw_message}
              />
            ))}
            {replying.map((run) => (
              <Bubble
                agent
                author={run.agent.display_name}
                key={run.id}
                own={false}
                pending
                text="Working…"
              />
            ))}
            {heard ? <Bubble author="You" own pending text={heard} /> : null}
          </>
        )}
        {saying ? <Bubble author="You" own pending text={saying} /> : null}
      </div>
      {notice ? (
        <p
          className="shrink-0 truncate border-t border-app-border px-3 py-1.5 text-[12px] text-app-muted"
          role="status"
        >
          {notice}
        </p>
      ) : null}
      {pendingMaterials ? (
        <p className="shrink-0 truncate border-t border-app-border px-3 py-1.5 text-[12px] text-app-muted">
          Next turn includes {pendingMaterials} selection
          {pendingMaterials === 1 ? "" : "s"}
        </p>
      ) : null}
    </section>,
    pip?.document.body ?? document.body,
  );
}

function Bubble({
  agent = false,
  author,
  own,
  pending = false,
  text,
}: {
  agent?: boolean;
  author: string;
  own: boolean;
  pending?: boolean;
  text: string;
}) {
  return (
    <div className={`flex flex-col ${own ? "items-end" : "items-start"}`}>
      {own ? null : (
        <span className="mb-0.5 px-1 text-[12px] text-app-muted">{author}</span>
      )}
      <p
        className={`max-w-[85%] whitespace-pre-wrap break-words text-[14px] leading-5 ${
          own
            ? "rounded-2xl bg-primary px-3 py-1.5 text-primary-foreground"
            : agent
              ? "px-1 text-foreground"
              : "rounded-2xl bg-muted px-3 py-1.5 text-foreground"
        } ${pending ? "opacity-70" : ""}`}
      >
        {text}
      </p>
    </div>
  );
}

/** Conversation Messages sent since this session started, oldest first. */
export function sessionMessages(
  messages: readonly TeamHubMessage[],
  startedAt: string,
) {
  const since = Date.parse(startedAt);
  return messages
    .filter(
      (message) =>
        message.message_kind === "conversation" &&
        Date.parse(message.created_at) >= since &&
        message.raw_message.trim(),
    )
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

/** Header drag, clamped to the viewport and remembered per browser. */
function useDraggablePosition(width: number) {
  const [position, setPosition] = useState<Position>(() =>
    clampPosition(readPosition() ?? defaultPosition(width), width),
  );
  const latest = useRef(position);
  useLayoutEffect(() => {
    latest.current = position;
  });
  // Growing the window or shrinking the viewport keeps it fully on screen.
  useEffect(() => {
    const keepVisible = () =>
      setPosition((current) => clampPosition(current, width));
    keepVisible();
    window.addEventListener("resize", keepVisible);
    return () => window.removeEventListener("resize", keepVisible);
  }, [width]);
  // Window listeners follow the pointer even when it leaves the header, and a
  // small threshold keeps a plain click on the title a click.
  const dragged = useRef(false);
  const dragHandlers = {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0) return;
      const start = { x: event.clientX, y: event.clientY };
      const offset = {
        dx: event.clientX - latest.current.left,
        dy: event.clientY - latest.current.top,
      };
      dragged.current = false;
      const move = (next: PointerEvent) => {
        if (
          !dragged.current &&
          Math.hypot(next.clientX - start.x, next.clientY - start.y) < 4
        )
          return;
        dragged.current = true;
        next.preventDefault();
        setPosition(
          clampPosition(
            { left: next.clientX - offset.dx, top: next.clientY - offset.dy },
            width,
          ),
        );
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        if (dragged.current) writePosition(latest.current);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
  };
  /** True right after a drag, so the title does not also navigate. */
  const consumeDrag = () => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  };
  /** Moves the window to one side at its current height, as a drag would. */
  const place = (side: "left" | "right") => {
    const next = clampPosition(
      {
        left: side === "left" ? windowGap : window.innerWidth,
        top: latest.current.top,
      },
      width,
    );
    setPosition(next);
    writePosition(next);
  };
  return { consumeDrag, dragHandlers, place, position };
}

function defaultPosition(width: number): Position {
  return { left: window.innerWidth - width - windowGap, top: 72 };
}

export function clampPosition(
  { left, top }: Position,
  width: number = windowSizes.compact.width,
): Position {
  const maxLeft = Math.max(windowGap, window.innerWidth - width - windowGap);
  const maxTop = Math.max(windowGap, window.innerHeight - 120);
  return {
    left: Math.min(Math.max(windowGap, left), maxLeft),
    top: Math.min(Math.max(windowGap, top), maxTop),
  };
}

function readPosition(): Position | undefined {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(positionKey) ?? "null",
    );
    if (
      value &&
      typeof value === "object" &&
      typeof (value as Position).left === "number" &&
      typeof (value as Position).top === "number"
    )
      return value as Position;
  } catch {
    // A private window or blocked storage keeps the default corner.
  }
  return undefined;
}

function writePosition(position: Position) {
  try {
    window.localStorage.setItem(positionKey, JSON.stringify(position));
  } catch {
    // Remembering the spot is a convenience only.
  }
}

/** Only this beat follows the microphone level, so the window stays still. */
function VoiceAvatarBeat({
  children,
  listening,
}: {
  children: ReactNode;
  listening: boolean;
}) {
  const level = useVoiceModeLevel();
  return (
    <span
      aria-hidden="true"
      className={styles.avatarBeat}
      data-listening={listening || undefined}
      data-speaking={(listening && level > speakingLevel) || undefined}
      data-voice-avatar
      style={{ "--voice-level": listening ? level : 0 } as CSSProperties}
    >
      {children}
    </span>
  );
}
