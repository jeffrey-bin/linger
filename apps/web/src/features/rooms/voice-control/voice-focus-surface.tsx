import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Loading03Icon,
  Mic01Icon,
  PauseIcon,
  PlayIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { useState, type PointerEvent, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import {
  isTranscriptRecoveryPaused,
  useOptionalVoiceControl,
  type VoiceCaptureState,
  type VoiceTranscriptItem,
} from "./voice-control-context";
import { VoiceRecoveryPanel } from "./voice-recovery-panel";
import { VoiceRecordingTime } from "./voice-recording-time";
import { VoiceTranscriptViewport } from "./voice-transcript-viewport";
import styles from "./voice-focus.module.css";
import {
  armSubtitle,
  armTitle,
  useMicrophonePermission,
  useSurfaceAction,
  useVoiceArming,
} from "./voice-focus-state";

export type RecordingView = "transcript" | "ask";

/** What a running recording adds beyond its transcript. */
export interface RecordingPanels {
  ask: ReactNode;
  askComposer: ReactNode;
}

/**
 * The Recording window: one row with the live duration and controls, then
 * the full-height transcript or the conversation with the recording's Agent
 * in Ask, with the Ask box always at the bottom. Minimizing leaves only
 * the row. It lives above the routes, so minimizing it or leaving the page
 * never stops the recording; only Stop does.
 */
export function VoiceFocusSurface({
  autoStart = false,
  floating = "page",
  onExit,
  onMoveStart,
  onViewChange,
  panels,
  view,
}: {
  autoStart?: boolean;
  /** A picture-in-picture window fills its own window instead of floating. */
  floating?: "page" | "pip";
  onExit: () => void;
  /** Starts moving the page window from its hover title bar. */
  onMoveStart?: (event: PointerEvent<HTMLDivElement>) => void;
  onViewChange?: (view: RecordingView | undefined) => void;
  /** Present once a recording runs; before that only the transcript shows. */
  panels?: RecordingPanels;
  /** The open view; undefined minimizes the window to its top row. */
  view?: RecordingView;
}) {
  const livekit = useOptionalVoiceControl();
  const voice = livekit;
  const { actionError, actionPending, run } = useSurfaceAction();
  const captureStatus = livekit?.captureState.status ?? "idle";
  const capture =
    livekit && "capture" in livekit.captureState
      ? livekit.captureState.capture
      : undefined;
  const {
    arm,
    autoArming,
    error: armError,
    reconnect,
    status: armStatus,
    supersede: supersedeArming,
  } = useVoiceArming({ autoStart, captureStatus, voice });
  const microphonePermission = useMicrophonePermission();
  // Pausing mutes the microphone and stops the clock; the recording itself
  // keeps running, so resuming continues the same Capture.
  const [pause, setPause] = useState<{
    captureId?: string;
    pausedAt?: number;
    pausedMs: number;
  }>({ pausedMs: 0 });
  const pauseState = pause.captureId === capture?.id ? pause : { pausedMs: 0 };
  const paused = pauseState.pausedAt !== undefined;
  const [confirmingStop, setConfirmingStop] = useState(false);
  // "Reconnecting microphone" only follows a microphone that was up during
  // this recording; connecting it right after Start is not a reconnection.
  const microphoneWasUp = useMicrophoneUpDuringRecording(
    capture?.id,
    livekit?.listenerStatus === "listening" ||
      livekit?.listenerStatus === "transcribing",
  );

  if (!voice) return null;
  const captureActive =
    captureStatus === "recording" || captureStatus === "starting";
  const finalizing = captureStatus === "finalizing";
  const idle = captureStatus === "idle" || captureStatus === "completed";
  const captureFailed = captureStatus === "failed";
  const standby = voice.listenerStatus === "standby";
  const recoveryFailed = isTranscriptRecoveryPaused(voice.captureState);
  const failedState =
    livekit?.captureState.status === "failed"
      ? livekit.captureState
      : undefined;
  const captureError = failedState
    ? captureFailureDescription(failedState.reason)
    : undefined;
  const inputInterrupted =
    captureActive &&
    ["device_disconnected", "error", "disabled"].includes(voice.listenerStatus);
  const inputReconnecting =
    Boolean(livekit) &&
    captureActive &&
    microphoneWasUp &&
    voice.listenerStatus === "enabling";
  const transcriptIncomplete =
    captureActive && capture?.last_failure_code === "transcript_incomplete";
  // Starting connects on demand, so an unbound or blocked microphone still
  // needs the affordance; a bound-but-idle listener and an imminent
  // auto-start do not offer it twice.
  const connected =
    voice.listenerStatus === "listening" ||
    voice.listenerStatus === "transcribing";
  const canStart =
    !captureActive &&
    !finalizing &&
    !standby &&
    armStatus !== "arming" &&
    !autoArming &&
    (idle ||
      captureFailed ||
      recoveryFailed ||
      connected ||
      armStatus === "blocked" ||
      !voice.boundDevice);
  const visibleItems = idle ? [] : voice.transcriptItems;
  const partial = idle || captureError ? undefined : voice.partialTranscript;
  const title = recoveryFailed
    ? "Recording saved. Transcript recovery paused"
    : inputInterrupted
      ? "Recording input was interrupted"
      : standby
        ? "Recording is continuing in another tab"
        : idle
          ? armTitle(armStatus)
          : focusTitle(captureStatus);
  const subtitle = recoveryFailed
    ? "Retry transcription or download the original recording."
    : inputInterrupted
      ? "Recorded content can still be saved."
      : idle
        ? armSubtitle(armStatus, microphonePermission)
        : focusSubtitle(captureStatus);
  const statusMessage =
    !captureError &&
    (inputReconnecting
      ? "Reconnecting microphone; audio delivery is not yet confirmed"
      : livekit?.transcriptStatus === "recovering"
        ? "Reconnecting transcript updates; saved text will sync after reconnection"
        : livekit?.captureSyncStatus === "recovering"
          ? "Reconnecting recording status; waiting for server confirmation"
          : transcriptIncomplete
            ? inputInterrupted
              ? "Some transcript segments are unconfirmed. Recovery will be attempted after stopping."
              : "Some transcript segments are unconfirmed. Recording continues; recovery will be attempted after stopping."
            : finalizing
              ? "Generating recording and transcript files"
              : undefined);
  const surfaceError =
    actionError ??
    armError ??
    captureError ??
    (autoArming || armStatus === "arming" ? undefined : voice.listenerError);
  // Stop ends the recording and releases the microphone; saving continues in
  // the background while the window shows its progress.
  const leave = async () => {
    supersedeArming();
    if (livekit?.leavePage) {
      await livekit.leavePage();
    } else if (captureActive) {
      await livekit?.stopCapture();
    }
    onExit();
  };
  const standbyOrMic = standby || voice.composerMicrophoneActive;
  // Before a recording runs, the window always shows how to start it.
  const shown: RecordingView | undefined = panels ? view : "transcript";
  const pip = floating === "pip";
  // The listening title is the quiet default; anything else is news.
  const notice = captureActive && title !== listeningTitle ? title : undefined;
  const tabs: { id: RecordingView; label: string }[] = [
    { id: "transcript", label: "Transcript" },
    { id: "ask", label: "Ask" },
  ];
  const togglePause = () =>
    run(async () => {
      if (paused) {
        await voice.setMicrophoneMuted(false);
        setPause({
          captureId: capture?.id,
          pausedMs:
            pauseState.pausedMs + Date.now() - (pauseState.pausedAt ?? 0),
        });
      } else {
        await voice.setMicrophoneMuted(true);
        setPause({
          captureId: capture?.id,
          pausedAt: Date.now(),
          pausedMs: pauseState.pausedMs,
        });
      }
    });
  // Closing a running recording asks first; it ends and saves the recording.
  const close = () => {
    if (captureActive) setConfirmingStop(true);
    else void run(leave);
  };
  // The picture-in-picture window cannot reveal a bar on hover, so it keeps
  // the bar docked on top.
  const titleBar = (
    <div
      className={`${styles.titleBar} ${pip ? styles.titleBarDocked : ""}`}
      onPointerDown={pip ? undefined : onMoveStart}
    >
      {panels ? (
        <button
          aria-label={shown ? "Minimize recording" : "Open recording"}
          className={styles.windowButton}
          onClick={() => onViewChange?.(shown ? undefined : "transcript")}
          title={shown ? "Minimize; recording continues" : "Open recording"}
          type="button"
        >
          {shown ? (
            <Icon icon={ArrowDown01Icon} />
          ) : (
            <Icon icon={ArrowUp01Icon} />
          )}
        </button>
      ) : null}
      <span className="flex-1" />
    </div>
  );
  return (
    <>
      {titleBar}
      <section
        aria-label="Hardware voice focus"
        className={
          pip
            ? "relative flex min-h-0 flex-1 flex-col bg-app-canvas text-app-ink"
            : `relative flex max-h-[min(720px,calc(100dvh-96px))] min-h-0 flex-col overflow-hidden rounded-2xl bg-app-canvas text-app-ink ${styles.window}`
        }
        data-paused={paused || undefined}
      >
        <header className="flex h-14 shrink-0 items-center gap-2 px-4">
          {captureActive ? (
            <>
              <span aria-hidden="true" className={styles.liveBars}>
                <i />
                <i />
                <i />
                <i />
              </span>
              <span
                aria-label="Recording duration"
                className={`flex shrink-0 items-center gap-2 font-mono text-sm leading-5 tracking-normal tabular-nums ${paused ? "text-app-subtle" : "text-app-ink"}`}
              >
                <span className="sr-only">
                  {paused ? "Recording paused" : "Recording"}
                </span>
                <VoiceRecordingTime
                  pausedAt={pauseState.pausedAt}
                  pausedMs={pauseState.pausedMs}
                  startedAt={capture?.created_at}
                />
              </span>
            </>
          ) : (
            <h1
              className="min-w-0 truncate text-sm leading-5 font-medium text-app-ink"
              title={title}
            >
              {title}
            </h1>
          )}
          {captureActive && !notice ? (
            <h1 className="sr-only">{title}</h1>
          ) : null}
          <span className="flex-1" />
          {captureActive ? (
            <button
              aria-label={paused ? "Resume recording" : "Pause recording"}
              aria-pressed={paused}
              className={styles.control}
              data-active={paused || undefined}
              disabled={standbyOrMic || actionPending}
              onClick={() => void togglePause()}
              title={paused ? "Resume recording" : "Pause recording"}
              type="button"
            >
              {paused ? (
                <Icon icon={PlayIcon} size={14} />
              ) : (
                <Icon icon={PauseIcon} size={14} />
              )}
              {paused ? "Resume" : "Pause"}
            </button>
          ) : null}
          <button
            aria-label={captureActive ? "Stop recording" : "Close recording"}
            className={styles.control}
            disabled={actionPending}
            onClick={close}
            title={captureActive ? "Stop recording" : "Close recording"}
            type="button"
          >
            {captureActive ? (
              <Icon icon={StopIcon} size={14} />
            ) : (
              <Icon icon={Cancel01Icon} size={14} />
            )}
            {captureActive ? "Stop" : "Close"}
          </button>
        </header>
        {confirmingStop ? (
          <div className={styles.confirmLayer}>
            <div
              aria-describedby="recording-stop-description"
              aria-labelledby="recording-stop-title"
              aria-modal="true"
              className={styles.confirm}
              role="alertdialog"
            >
              <h2 className={styles.confirmTitle} id="recording-stop-title">
                Stop recording?
              </h2>
              <p
                className={styles.confirmDescription}
                id="recording-stop-description"
              >
                The recording is saved and summarized. You can find it in
                Meetings.
              </p>
              <div className="flex flex-col gap-2">
                <button
                  className={styles.confirmStop}
                  onClick={() => {
                    // A failed stop shows its reason in the window behind.
                    setConfirmingStop(false);
                    void run(leave);
                  }}
                  type="button"
                >
                  <Icon icon={StopIcon} size={12} />
                  Stop & save
                </button>
                <button
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- the safe choice is focused on purpose because the user just asked to stop recording
                  autoFocus
                  className={styles.confirmKeep}
                  onClick={() => setConfirmingStop(false)}
                  type="button"
                >
                  Keep recording
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {shown ? (
          <>
            {panels ? (
              <div
                aria-label="Recording views"
                className="flex shrink-0 items-center gap-1 border-b border-app-border px-4 py-2"
                role="tablist"
              >
                {tabs.map((tab) => (
                  <button
                    aria-selected={shown === tab.id}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] leading-[18px] font-medium transition-colors focus:outline-none focus-visible:shadow-[0_0_0_2px_var(--app-ring)] ${
                      shown === tab.id
                        ? "bg-app-surface-soft text-app-ink"
                        : "text-app-muted hover:bg-app-surface-soft/50 hover:text-app-ink"
                    }`}
                    key={tab.id}
                    onClick={() => onViewChange?.(tab.id)}
                    role="tab"
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            ) : null}
            <VoiceFocusNotices
              gapCount={capture?.gap_count ?? 0}
              gapDurationMs={capture?.gap_duration_ms ?? 0}
              finalizing={finalizing}
              notice={notice}
              onReconnect={
                Boolean(livekit) && captureActive && inputInterrupted
                  ? () => void run(reconnect)
                  : undefined
              }
              reconnecting={actionPending}
              statusMessage={statusMessage}
              subtitle={subtitle}
              surfaceError={surfaceError}
            />
            {/* Kept mounted behind the other views so its scroll position survives. */}
            <div
              className="flex min-h-0 flex-1 flex-col"
              hidden={shown !== "transcript"}
            >
              <VoiceTranscriptViewport
                revealLatestKey={
                  captureStatus === "recovering" && capture
                    ? `${capture.id}:${recoveryFailed ? "failed" : "recovering"}`
                    : undefined
                }
                key={capture?.id ?? "idle"}
              >
                <div className="flex w-full flex-col items-center gap-4 px-5 py-3">
                  <div
                    aria-label="Voice focus transcript"
                    aria-live="polite"
                    className="w-full space-y-1"
                    role="log"
                  >
                    {visibleItems.map((item) => (
                      <VoiceFocusTranscriptRow item={item} key={item.id} />
                    ))}
                    {partial ? (
                      <div className="flex gap-2 rounded-lg px-2.5 py-1.5 text-sm leading-5 text-app-muted">
                        <Icon
                          icon={Loading03Icon}
                          className="mt-[3px] shrink-0 animate-spin text-app-muted"
                          size={14}
                        />
                        <span className="min-w-0 italic">{partial}</span>
                      </div>
                    ) : null}
                    {visibleItems.length === 0 && !partial ? (
                      <p className="py-3 text-center text-[12px] leading-[18px] text-app-muted">
                        {idle
                          ? "This recording’s transcript will appear here. View previous transcripts in the chat."
                          : captureError
                            ? "No transcript is available yet."
                            : "Listening…"}
                      </p>
                    ) : null}
                    {canStart ? (
                      <div className="flex justify-center pt-1">
                        <Button onClick={() => void arm()} tone="primary">
                          <Icon icon={Mic01Icon} size={16} />
                          {captureFailed || recoveryFailed
                            ? "Start new recording"
                            : "Start recording"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {captureStatus === "recovering" && capture ? (
                    <VoiceRecoveryPanel capture={capture} />
                  ) : null}
                </div>
              </VoiceTranscriptViewport>
            </div>
            {panels && shown === "ask" ? panels.ask : null}
            {panels?.askComposer}
          </>
        ) : null}
      </section>
    </>
  );
}

const listeningTitle = "I’m listening to the meeting...";

function VoiceFocusNotices({
  finalizing,
  gapCount,
  gapDurationMs,
  notice,
  onReconnect,
  reconnecting,
  statusMessage,
  subtitle,
  surfaceError,
}: {
  finalizing: boolean;
  gapCount: number;
  gapDurationMs: number;
  notice?: string;
  onReconnect?: () => void;
  reconnecting: boolean;
  statusMessage: string | false | undefined;
  subtitle?: string;
  surfaceError?: string;
}) {
  if (
    !notice &&
    !subtitle &&
    !statusMessage &&
    !surfaceError &&
    gapCount === 0 &&
    !onReconnect
  )
    return null;
  return (
    // A Town notice: a quiet muted panel with 12px muted text; only the
    // icons carry the warning or danger colour.
    <div className="mx-4 mt-2 flex shrink-0 flex-col gap-1 rounded-lg border border-app-border bg-app-surface-soft/40 px-3 py-2 text-[12px] leading-[18px] font-normal tracking-[0.02em] text-app-muted">
      {notice ? (
        <h1 className="text-[12px] leading-[18px] font-medium text-app-ink">
          {notice}
        </h1>
      ) : null}
      {subtitle ? <p>{subtitle}</p> : null}
      {statusMessage ? (
        <p className="flex items-start gap-1.5" role="status">
          <Icon
            icon={Loading03Icon}
            className={`mt-[3px] shrink-0 text-app-warning ${finalizing ? "animate-spin" : ""}`}
            size={12}
          />
          {statusMessage}
        </p>
      ) : null}
      {gapCount > 0 ? (
        // Audio the service never received stays visible, not hidden by the timer.
        <p className="flex items-start gap-1.5" role="status">
          <Icon
            icon={AlertCircleIcon}
            className="mt-[3px] shrink-0 text-app-warning"
            size={12}
          />
          <span>
            Input missed {gapCount === 1 ? "once" : `${gapCount} times`} (
            {Math.max(1, Math.round(gapDurationMs / 1000))}s not recorded)
          </span>
        </p>
      ) : null}
      {surfaceError ? (
        <p className="flex items-start gap-1.5 text-app-danger" role="alert">
          <Icon
            icon={AlertCircleIcon}
            className="mt-[3px] shrink-0"
            size={12}
          />
          {surfaceError}
        </p>
      ) : null}
      {onReconnect ? (
        <div>
          <Button
            disabled={reconnecting}
            onClick={onReconnect}
            size="compact"
            tone="ghost"
          >
            <Icon icon={Mic01Icon} size={14} />
            Reconnect microphone
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// Town Nature palette (700 shades keep names readable on white); Speaker N
// keeps the same color for the whole recording.
const speakerColors = [
  "text-bluebell-700",
  "text-lavender-700",
  "text-lake-700",
  "text-sun-700",
  "text-bubblegum-700",
  "text-rain-700",
  "text-acorn-700",
  "text-grass-700",
  "text-fawn-700",
  "text-lichen-700",
];

function speakerColor(label: string) {
  const index = Number(label.match(/(\d+)$/)?.[1] ?? 1);
  return speakerColors[(Math.max(index, 1) - 1) % speakerColors.length]!;
}

function VoiceFocusTranscriptRow({ item }: { item: VoiceTranscriptItem }) {
  // Town message rows: a 13px name line over 14px body text, starting
  // straight with the speaker.
  return (
    <div className="flex flex-col gap-0.5 rounded-lg px-2.5 py-1.5">
      {item.speakerLabel ? (
        <span
          className={`text-[14px] leading-[18px] font-medium ${speakerColor(item.speakerLabel)}`}
        >
          {item.speakerLabel}
        </span>
      ) : null}
      <p className="m-0 text-sm leading-5 text-app-body">{item.text}</p>
    </div>
  );
}

function focusTitle(captureStatus: VoiceCaptureState["status"]) {
  if (captureStatus === "failed") return "Recording save failed";
  if (captureStatus === "recovering")
    return "Recording saved; recovering transcript";
  if (captureStatus === "finalizing") return "Saving recording...";
  return listeningTitle;
}

function focusSubtitle(captureStatus: VoiceCaptureState["status"]) {
  if (captureStatus === "failed")
    return "Received transcript segments remain available here.";
  if (captureStatus === "recovering")
    return "The microphone can be disconnected; recovery will continue in the background.";
  if (captureStatus === "finalizing")
    return "Finishing the transcript and audio file.";
  return undefined;
}

function captureFailureDescription(reason: unknown): string {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : undefined;
  switch (message) {
    case "transcript_incomplete":
    case "transcript_integrity_lost":
      return "The transcript could not be fully confirmed, so saving is incomplete.";
    case "materialization_failed":
      return "Failed to generate the recording file.";
    case "provider_unavailable":
      return "The recording service is temporarily unavailable, so saving could not finish.";
    case "Voice Capture failed":
    case undefined:
    case "":
      return "The recording could not be saved.";
    default:
      return message;
  }
}

/** Whether the microphone has been up at some point during this recording. */
function useMicrophoneUpDuringRecording(
  recordingId: string | undefined,
  up: boolean,
) {
  const [upIn, setUpIn] = useState<string>();
  const wasUp = recordingId !== undefined && upIn === recordingId;
  if (up && recordingId !== undefined && !wasUp) setUpIn(recordingId);
  return wasUp || (up && recordingId !== undefined);
}
