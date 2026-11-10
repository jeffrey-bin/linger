import {
  ArrowLeft01Icon,
  Cancel01Icon,
  Delete02Icon,
  GridViewIcon,
  Mic01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { MessageMarkdown } from "../chat/message-markdown";
import { markdownPlainText } from "@/features/teamhub/markdown-plain-text";
import { spokenSeparator } from "../chat/voice-mode/spoken-text";
import { Icon } from "@/components/ui/icon";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubPocketNote } from "@/features/teamhub/teamhub-types";

import { Button } from "@/components/ui/button";

import {
  pocketNotesQueryOptions,
  removePocketNote,
  storeTodayPocketNote,
} from "./pocket-note-queries";
import { usePocketDictation } from "./use-pocket-dictation";
import {
  PocketNoteEditor,
  type PocketNoteEditorHandle,
} from "./pocket-note-editor";

const autosaveDelayMs = 800;
const maximumNoteLength = 20000;
const panelWidth = 360;
const panelGap = 12;

type PocketNoteView =
  | { kind: "today" }
  | { kind: "all" }
  | { kind: "past"; note: TeamHubPocketNote };

/** Lets the open page finish dictation before Escape or a close acts. */
interface CloseGuard {
  /** Still recording or draining the last words. */
  dictating: () => boolean;
  /** The microphone is still open; Escape stops it before anything else. */
  listening: () => boolean;
  /** Settles the last words into the page; it may be about to close. */
  stop: () => Promise<void>;
}

export default function PocketNotePanel({
  anchorRef,
  anotherMeRoomId,
  closeRef,
  onClose,
  tenantId,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  anotherMeRoomId?: string;
  /** Receives the guarded close, so the trigger closes the same way. */
  closeRef: RefObject<(() => void) | undefined>;
  onClose: () => void;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const notes = useInfiniteQuery(pocketNotesQueryOptions(client, tenantId));
  const [view, setView] = useState<PocketNoteView>({ kind: "today" });
  const panelRef = useRef<HTMLDivElement>(null);
  const position = usePanelPosition(anchorRef);
  const closeGuard = useRef<CloseGuard | undefined>(undefined);
  // Dictation in progress settles its last words into the page first.
  const close = () => {
    const guard = closeGuard.current;
    if (guard?.dictating()) void guard.stop().finally(onClose);
    else onClose();
  };
  const latestClose = useRef(close);
  useLayoutEffect(() => {
    latestClose.current = close;
    closeRef.current = close;
  });
  useLayoutEffect(
    () => () => {
      closeRef.current = undefined;
    },
    [closeRef],
  );

  useEffect(() => {
    function closeOnOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return;
      }
      latestClose.current();
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const guard = closeGuard.current;
      if (guard?.listening()) {
        void guard.stop();
        return;
      }
      latestClose.current();
      anchorRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [anchorRef, onClose]);

  const firstPage = notes.data?.pages[0];
  const items = notes.data?.pages.flatMap((page) => page.items) ?? [];
  const today = firstPage?.today;
  const todayNote = items.find((item) => item.date === today);

  return createPortal(
    <div
      aria-label="Pocket notes"
      className="app-floating-enter fixed z-[100] flex h-[440px] flex-col overflow-hidden rounded-2xl bg-popover shadow-xl"
      ref={panelRef}
      role="dialog"
      style={{ ...position, width: panelWidth }}
    >
      {!firstPage || !today ? (
        <p className="m-auto text-sm text-app-muted">
          {notes.isError ? "Couldn’t load notes" : "Loading…"}
        </p>
      ) : view.kind === "all" ? (
        <AllPocketNotes
          hasMore={notes.hasNextPage}
          items={items}
          loadingMore={notes.isFetchingNextPage}
          onClose={onClose}
          onLoadMore={() => void notes.fetchNextPage()}
          onOpen={(note) =>
            setView(
              note.date === today ? { kind: "today" } : { kind: "past", note },
            )
          }
          tenantId={tenantId}
          today={today}
        />
      ) : view.kind === "today" ? (
        <TodayPocketNote
          anotherMeRoomId={anotherMeRoomId}
          closeGuard={closeGuard}
          initialText={todayNote?.text ?? ""}
          key={today}
          onClose={close}
          onShowAll={() => setView({ kind: "all" })}
          tenantId={tenantId}
          today={today}
        />
      ) : (
        <PastPocketNote
          note={view.note}
          onBack={() => setView({ kind: "all" })}
          onClose={onClose}
        />
      )}
    </div>,
    document.body,
  );
}

function TodayPocketNote({
  anotherMeRoomId,
  closeGuard,
  initialText,
  onClose,
  onShowAll,
  tenantId,
  today,
}: {
  anotherMeRoomId?: string;
  closeGuard: RefObject<CloseGuard | undefined>;
  initialText: string;
  onClose: () => void;
  onShowAll: () => void;
  tenantId: string;
  today: string;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [text, setText] = useState(initialText);
  const textRef = useRef(initialText);
  const savedText = useRef(initialText);
  const pendingText = useRef(initialText);
  const editorRef = useRef<PocketNoteEditorHandle>(null);
  const liveRef = useRef<HTMLSpanElement>(null);
  const anchor = useRef(0);
  // Where this dictation began; later turns continue its paragraph.
  const blockStart = useRef(0);
  const [truncated, setTruncated] = useState(false);
  const save = useMutation({
    mutationFn: (value: string) =>
      teamHubData(
        client.api.PUT("/v0/tenants/{tenantId}/me/pocket-notes/today", {
          params: { path: { tenantId } },
          body: { text: value },
        }),
      ),
    onSuccess: (note) => {
      savedText.current = note.text;
      storeTodayPocketNote(queryClient, tenantId, note);
    },
  });
  const persist = useEffectEvent((value: string) => save.mutate(value));

  function update(value: string) {
    textRef.current = value;
    pendingText.current = value;
    setText(value);
  }

  /**
   * A dictation starts its own line at the anchor; later turns of the same
   * dictation continue that paragraph, so pauses do not chop it into lines.
   */
  function insertSpoken(spoken: string) {
    const words = spoken.trim();
    if (!words) return;
    const current = textRef.current;
    const at = Math.min(anchor.current, current.length);
    const before = current.slice(0, at);
    const after = current.slice(at);
    const continuing = at > blockStart.current;
    const separator = continuing
      ? spokenSeparator(before, words)
      : before && !before.endsWith("\n")
        ? "\n"
        : "";
    const piece = `${separator}${words}`;
    const tail = after && !after.startsWith("\n") ? `\n${after}` : after;
    const room = maximumNoteLength - before.length - tail.length;
    const fitted = piece.slice(0, Math.max(0, room));
    if (fitted.length < piece.length) setTruncated(true);
    anchor.current = before.length + fitted.length;
    update(before + fitted + tail);
  }

  const dictation = usePocketDictation({
    onTurn: insertSpoken,
    roomId: anotherMeRoomId,
    tenantId,
  });
  // One stop at a time: a second request while the last words drain would
  // otherwise write them twice.
  const stopping = useRef<Promise<void> | undefined>(undefined);
  function stopDictation() {
    stopping.current ??= (async () => {
      try {
        insertSpoken(await dictation.stop());
      } finally {
        stopping.current = undefined;
      }
    })();
    return stopping.current;
  }

  useLayoutEffect(() => {
    closeGuard.current = {
      dictating: () => dictation.active,
      listening: () => dictation.active && !dictation.stopping,
      stop: stopDictation,
    };
    return () => {
      closeGuard.current = undefined;
    };
  });

  useEffect(() => {
    pendingText.current = text;
    if (text === savedText.current) return;
    const timer = window.setTimeout(() => persist(text), autosaveDelayMs);
    return () => window.clearTimeout(timer);
  }, [text]);

  // Closing the notepad inside the autosave delay must not drop the last words.
  useEffect(
    () => () => {
      if (pendingText.current !== savedText.current) {
        persist(pendingText.current);
      }
    },
    [],
  );

  // Keep the words being spoken in view, and hand the caret back after them.
  const dictating = dictation.active;
  useLayoutEffect(() => {
    if (dictating) liveRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [dictating, dictation.liveText, text]);
  const wasDictating = useRef(false);
  useLayoutEffect(() => {
    if (wasDictating.current && !dictating) {
      editorRef.current?.focusAt(anchor.current);
    }
    wasDictating.current = dictating;
  }, [dictating]);

  // Stopping hands the control back at once; draining the last words carries
  // on without holding the button.
  const listening = dictating && !dictation.stopping;
  function toggleDictation() {
    if (dictation.stopping) return;
    if (listening) {
      void stopDictation();
      return;
    }
    setTruncated(false);
    anchor.current = editorRef.current?.selectionStart() ?? anchor.current;
    blockStart.current = anchor.current;
    dictation.start();
  }

  const status = dictation.error
    ? dictation.error
    : truncated
      ? "Page is full · 20,000 characters"
      : dictation.connecting
        ? "Connecting…"
        : dictation.stopping
          ? "Saving…"
          : dictating
            ? "Listening…"
            : save.isError
              ? "Couldn’t save · keep typing to retry"
              : save.isPending || text !== savedText.current
                ? "Saving…"
                : "Saved";
  // While speaking, the words still being recognized sit at the anchor.
  const at = Math.min(anchor.current, text.length);
  const before = text.slice(0, at);
  const live = dictation.liveText.trim();
  const after = text.slice(at);

  return (
    <>
      <PocketNoteHeader
        leading={
          <HeaderButton label="All notes" onClick={onShowAll}>
            <Icon icon={GridViewIcon} size={16} />
          </HeaderButton>
        }
        onClose={onClose}
        subtitle={status}
        title={`Today · ${formatPocketNoteDate(today)}`}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {dictating ? (
          // While speaking the page is a read-only view of the note with the
          // words not yet final shown in place, in gray.
          <div
            aria-label="Today’s note"
            aria-live="polite"
            className="pocket-note-paper workspace-scrollbar min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-5 pb-16 text-sm text-app-ink"
            role="textbox"
            aria-readonly="true"
          >
            {before}
            <span className="text-app-ink/40" ref={liveRef}>
              {live && before && !before.endsWith("\n") ? "\n" : ""}
              {live}
            </span>
            {after}
          </div>
        ) : (
          <PocketNoteEditor
            maxLength={maximumNoteLength}
            onChange={update}
            onFull={() => setTruncated(true)}
            ref={editorRef}
            value={text}
          />
        )}
        {dictation.available ? (
          <DictationButton
            active={listening}
            connecting={dictation.connecting}
            level={dictation.level}
            onClick={toggleDictation}
          />
        ) : null}
      </div>
    </>
  );
}

/** A quiet round control; while listening a thin meter follows the voice. */
function DictationButton({
  active,
  connecting,
  level,
  onClick,
}: {
  active: boolean;
  connecting: boolean;
  level: number;
  onClick: () => void;
}) {
  const label = active ? "Stop dictation" : "Dictate";
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-2">
      {active ? (
        <span
          aria-hidden="true"
          className={`pocket-dictation-meter ${connecting ? "pocket-dictation-meter-waiting" : ""}`}
          style={{ "--pocket-level": connecting ? 0 : level } as CSSProperties}
        >
          {meterBars.map((weight) => (
            <span key={weight} style={{ "--bar": weight } as CSSProperties} />
          ))}
        </span>
      ) : null}
      <button
        aria-label={label}
        aria-pressed={active}
        className={`pointer-events-auto relative flex size-9 items-center justify-center rounded-full shadow-md transition-[background-color,color,transform] duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus disabled:pointer-events-none disabled:opacity-50 ${active ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground"}`}
        onClick={onClick}
        title={label}
        type="button"
      >
        {active ? (
          <Icon icon={StopIcon} size={12} />
        ) : (
          <Icon icon={Mic01Icon} size={16} />
        )}
      </button>
    </div>
  );
}

const meterBars = [0.55, 0.8, 1, 0.8, 0.55];

function PastPocketNote({
  note,
  onBack,
  onClose,
}: {
  note: TeamHubPocketNote;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <PocketNoteHeader
        leading={
          <HeaderButton label="Back to all notes" onClick={onBack}>
            <Icon icon={ArrowLeft01Icon} size={16} />
          </HeaderButton>
        }
        onClose={onClose}
        subtitle="Read only"
        title={formatPocketNoteDate(note.date)}
      />
      <div className="pocket-note-paper workspace-scrollbar min-h-0 flex-1 overflow-y-auto break-words px-5 pb-5 text-sm text-app-ink">
        <MessageMarkdown authorKind="agent" body={note.text} />
      </div>
    </>
  );
}

function AllPocketNotes({
  hasMore,
  items,
  loadingMore,
  onClose,
  onLoadMore,
  onOpen,
  tenantId,
  today,
}: {
  hasMore: boolean;
  items: TeamHubPocketNote[];
  loadingMore: boolean;
  onClose: () => void;
  onLoadMore: () => void;
  onOpen: (note: TeamHubPocketNote) => void;
  tenantId: string;
  today: string;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string>();
  // A past day can be deleted to tidy up; what Memory already took in stays.
  const remove = useMutation({
    // Hides a past day's page; today's page stays editable instead.
    mutationFn: (date: string) =>
      teamHubDone(
        client.api.DELETE("/v0/tenants/{tenantId}/me/pocket-notes/{noteDate}", {
          params: { path: { tenantId, noteDate: date } },
        }),
      ),
    onSuccess: (_, date) => {
      removePocketNote(queryClient, tenantId, date);
      setConfirming(undefined);
    },
  });
  const cards = items.some((item) => item.date === today)
    ? items
    : [{ date: today, text: "", updated_at: "" }, ...items];
  return (
    <>
      <PocketNoteHeader
        onClose={onClose}
        subtitle={`${items.length}${hasMore ? "+" : ""} ${items.length === 1 && !hasMore ? "page" : "pages"}`}
        title="All notes"
      />
      <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <ul className="grid grid-cols-2 gap-2.5">
          {cards.map((note) => {
            const label =
              note.date === today ? "Today" : formatPocketNoteDate(note.date);
            return (
              <li className="group relative" key={note.date}>
                <button
                  className="flex h-[118px] w-full flex-col rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-border-hover hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
                  onClick={() => onOpen(note)}
                  type="button"
                >
                  <span className="pr-6 text-xs font-medium text-app-ink">
                    {label}
                  </span>
                  <span className="mt-1.5 line-clamp-4 whitespace-pre-wrap break-words text-xs leading-[18px] text-app-muted">
                    {markdownPlainText(note.text) || "Nothing written yet"}
                  </span>
                </button>
                {note.date === today ? null : confirming === note.date ? (
                  <div
                    aria-label={`Delete ${label}?`}
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card/95 p-3"
                    role="alertdialog"
                  >
                    <p
                      className={`text-center text-xs ${remove.isError ? "text-app-danger" : "text-app-ink"}`}
                    >
                      {remove.isError
                        ? "Couldn’t delete. Try again."
                        : "Delete this note?"}
                    </p>
                    <div className="flex gap-1.5">
                      <Button
                        onClick={() => {
                          remove.reset();
                          setConfirming(undefined);
                        }}
                        size="compact"
                        tone="ghost"
                      >
                        Cancel
                      </Button>
                      <Button
                        loading={remove.isPending}
                        onClick={() => remove.mutate(note.date)}
                        size="compact"
                        tone="danger"
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    aria-label={`Delete ${label}`}
                    className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md text-app-muted opacity-0 transition-opacity hover:bg-accent hover:text-app-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                    onClick={() => {
                      remove.reset();
                      setConfirming(note.date);
                    }}
                    title="Delete note"
                    type="button"
                  >
                    <Icon icon={Delete02Icon} size={14} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {hasMore ? (
          <button
            className="mt-3 w-full rounded-full py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
            disabled={loadingMore}
            onClick={onLoadMore}
            type="button"
          >
            {loadingMore ? "Loading…" : "Load earlier notes"}
          </button>
        ) : null}
      </div>
    </>
  );
}

function PocketNoteHeader({
  leading,
  onClose,
  subtitle,
  title,
}: {
  leading?: ReactNode;
  onClose: () => void;
  subtitle: string;
  title: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2 pt-3">
      {leading}
      <div className={`min-w-0 flex-1 ${leading ? "" : "pl-2"}`}>
        <p className="truncate text-sm font-medium leading-5 text-app-ink">
          {title}
        </p>
        <p className="truncate text-xs leading-4 text-app-muted">{subtitle}</p>
      </div>
      <HeaderButton label="Close notes" onClick={onClose}>
        <Icon icon={Cancel01Icon} size={16} />
      </HeaderButton>
    </div>
  );
}

function HeaderButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color] hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

/** Opens beside the sidebar row and stays inside the viewport. */
function usePanelPosition(
  anchorRef: RefObject<HTMLButtonElement | null>,
): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({
    left: 0,
    top: 0,
    visibility: "hidden",
  });
  useLayoutEffect(() => {
    function place() {
      // Open beside the whole navigation column, not over it.
      const anchor = (
        anchorRef.current?.closest(".app-secondary-navigation") ??
        anchorRef.current
      )?.getBoundingClientRect();
      const trigger = anchorRef.current?.getBoundingClientRect();
      if (!anchor || !trigger) return;
      const height = 440;
      const left = Math.min(
        anchor.right + panelGap,
        window.innerWidth - panelWidth - panelGap,
      );
      const top = Math.max(
        panelGap,
        Math.min(trigger.top - 24, window.innerHeight - height - panelGap),
      );
      setPosition({ left: Math.max(panelGap, left), top });
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchorRef]);
  return position;
}

const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-09-30" -> "Sep 30"; TeamHub already chose the page day. */
function formatPocketNoteDate(date: string) {
  const [, month, day] = date.split("-");
  return `${monthNames[Number(month) - 1]} ${Number(day)}`;
}
