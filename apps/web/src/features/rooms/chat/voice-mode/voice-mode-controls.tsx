import {
  AudioWave01Icon,
  Cancel01Icon,
  Mic01Icon,
  MicOff01Icon,
  RotateLeft01Icon,
  VolumeHighIcon,
  VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { useEffect, type CSSProperties } from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import type {
  TeamHubActorRef,
  TeamHubVoiceMediaPolicy,
} from "@/features/teamhub/teamhub-types";
import type { VoiceTurnPrefix } from "./voice-mode-room-sender";
import {
  useOptionalVoiceModeSession,
  type VoiceModeModes,
  useVoiceModeLevel,
} from "./voice-mode-session";
import styles from "./voice-mode.module.css";
import { voiceModeStatusLabel } from "./voice-mode-presentation";
import { openVoicePip } from "./voice-pip";

export type { VoiceModePresentation } from "./voice-mode-presentation";

export interface VoiceModeTarget {
  roomId: string;
  tenantId: string;
  recipient?: TeamHubActorRef;
  /** Draft scope owner, so unsent words return to this Room's draft. */
  accountId?: string;
  /** Shown on the floating voice window while the Human is elsewhere. */
  roomName?: string;
}

const waveformDotCount = 160;
const noVoiceModes: VoiceModeModes = { dictation: false, live: false };

/**
 * The Room composer's view of the app-level Voice Mode session: it starts the
 * session for this Room and shows its live controls, but the session itself
 * outlives the composer when the Human navigates to another Room.
 */
export function VoiceModeControls(props: {
  target: VoiceModeTarget;
  disabled: boolean;
  empty: boolean;
  prefix: VoiceTurnPrefix;
  /** The deployment's voice support, read once by the composer. */
  policy: TeamHubVoiceMediaPolicy | undefined;
}) {
  const voice = useOptionalVoiceModeSession();
  const { roomId, tenantId } = props.target;
  // xAI makes Voice Mode a Live conversation; with Soniox alone it dictates.
  const policy = props.policy;
  const modes: VoiceModeModes = policy
    ? {
        dictation: policy.voice_media_supported === true,
        live: policy.live_supported === true,
      }
    : noVoiceModes;
  const supported = modes.dictation || modes.live;
  // Once Voice Mode is offered, its code loads in the background.
  const prepare = voice?.prepare;
  useEffect(() => {
    if (supported) prepare?.();
  }, [prepare, supported]);

  const session = voice?.session;
  const here = session?.target.roomId === roomId ? session : undefined;
  const elsewhere = session && !here ? session : undefined;
  const entered = Boolean(here?.entered);
  const closing = Boolean(here?.closing);
  const enter = () => {
    if (!voice || !supported || props.disabled || session) return;
    // Only this click may open the floating window that stays over other
    // tabs and apps, so it opens now while the session starts.
    void openVoicePip("voice-mode");
    voice.start(
      {
        accountId: props.target.accountId ?? "",
        recipient: props.target.recipient,
        roomId,
        roomName: props.target.roomName ?? "",
        tenantId,
      },
      props.prefix,
      modes,
    );
  };
  if (!entered && !closing && (!props.empty || !supported)) return null;
  if (!entered)
    return (
      <Button
        aria-label={closing ? "Finishing Voice Mode" : "Start Voice Mode"}
        title={
          closing
            ? "Finishing last words and releasing the microphone"
            : elsewhere
              ? `Voice Mode is on in ${elsewhere.target.roomName || "another Room"}`
              : modes.live
                ? "Voice Mode: a live conversation with Grok"
                : "Voice Mode: sends when you finish speaking"
        }
        className="message-composer-send"
        disabled={closing || props.disabled || !supported || Boolean(elsewhere)}
        onClick={enter}
        size="compactIcon"
        tone="primary"
      >
        <Icon icon={AudioWave01Icon} size={16} />
      </Button>
    );
  const state = here!.state;
  const muted = here!.muted;
  const soundOff = here!.live?.soundOff;
  const active = Boolean(state.microphoneActive) && !muted;
  // A finished turn is still settling into a message: the bar dims and
  // three dots wait beside it, while the microphone keeps listening.
  const settling = state.sending || state.flushing;
  return (
    <div
      className={styles.panel}
      aria-label="Voice Mode controls"
      data-settling={settling || undefined}
      role="group"
    >
      <span className={styles.lead}>
        <Icon icon={AudioWave01Icon} size={14} />
        <span className={styles.label}>Voice input</span>
      </span>
      <LiveVoiceWaveform active={active} />
      {settling ? (
        <span aria-hidden="true" className={styles.settlingDots}>
          <i />
          <i />
          <i />
        </span>
      ) : null}
      <span className="sr-only" role="status">
        {voiceModeStatusLabel({ ...state, entered })}
      </span>
      {state.canRetry ? (
        <Button
          aria-label="Retry voice message"
          title="Retry the same voice message"
          size="compactIcon"
          tone="ghost"
          disabled={state.sending}
          onClick={() => voice?.retry()}
        >
          <Icon icon={RotateLeft01Icon} size={16} />
        </Button>
      ) : null}
      <Button
        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={muted}
        className={styles.mute}
        disabled={!state.microphoneActive || state.status === "closing"}
        onClick={() => void voice?.setMuted(!muted)}
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
          aria-label={soundOff ? "Turn reply sound on" : "Turn reply sound off"}
          aria-pressed={soundOff}
          className={styles.sound}
          onClick={() => voice?.setSoundOff(!soundOff)}
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
      <Button
        aria-label="Exit Voice Mode"
        className={styles.exit}
        disabled={state.status === "closing"}
        onClick={() => voice?.exit()}
        size="compactIcon"
        tone="ghost"
      >
        <Icon icon={Cancel01Icon} size={16} />
      </Button>
    </div>
  );
}

/**
 * A fine waveform across the whole bar. The voice level lifts all of it at
 * once (square-rooted so quiet speech still shows), each line is a little
 * taller toward the centre, and a staggered CSS ripple keeps it flowing.
 */
function LiveVoiceWaveform({ active }: { active: boolean }) {
  return <VoiceWaveform active={active} level={useVoiceModeLevel()} />;
}

export function VoiceWaveform({
  active,
  level,
}: {
  active: boolean;
  level: number;
}) {
  const amplitude = active ? Math.sqrt(Math.min(1, Math.max(0, level))) : 0;
  return (
    <span
      className={styles.wave}
      aria-hidden="true"
      style={{ "--voice-level": amplitude } as CSSProperties}
    >
      {Array.from({ length: waveformDotCount }, (_, bar) => {
        const center = (waveformDotCount - 1) / 2;
        const distance = Math.abs(bar - center) / center;
        const envelope = 0.45 + 0.55 * (1 - distance * distance);
        return (
          <i
            key={bar}
            style={
              {
                "--voice-weight": envelope,
                "--voice-delay": `${-(bar % 32) * 0.035}s`,
              } as CSSProperties
            }
          />
        );
      })}
    </span>
  );
}
