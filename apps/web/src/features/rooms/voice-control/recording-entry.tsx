import {
  Loading03Icon,
  AiTranscribeAudioIcon,
} from "@hugeicons/core-free-icons";
import { use, useState } from "react";
import { Icon } from "@/components/ui/icon";

import { openRecordingWindow } from "./recording-window-store";
import {
  isTranscriptRecoveryPaused,
  useOptionalVoiceControl,
  VoiceCapabilitiesContext,
} from "./voice-control-context";

/**
 * The sidebar's Meeting tool. Every recording is kept with Another Me, so
 * its audio and transcript arrive in that chat when it finishes. Clicking it
 * opens the Recording window and starts recording when none is running.
 */
export function RecordingEntry({
  anotherMeRoomId,
}: {
  anotherMeRoomId?: string;
}) {
  const livekit = useOptionalVoiceControl();
  const voice = livekit;
  // Recording transcribes with Soniox; xAI alone does not offer it.
  const capabilities = use(VoiceCapabilitiesContext);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const status = voice?.captureState?.status;
  const recording = status === "recording" || status === "starting";
  const saving =
    status === "finalizing" ||
    (status === "recovering" &&
      !(voice && isTranscriptRecoveryPaused(voice.captureState)));
  const standby = voice?.listenerStatus === "standby";
  const label = recording
    ? "Return to recording"
    : saving
      ? "View save progress"
      : "Meetings";
  const hint =
    error ??
    (!voice || !anotherMeRoomId
      ? "Meeting is loading"
      : voice.composerMicrophoneActive
        ? "Finish voice input first"
        : standby
          ? "Recording is active in another tab"
          : label);
  function start() {
    if (!voice || !anotherMeRoomId || pending || voice.composerMicrophoneActive)
      return;
    setPending(true);
    setError(undefined);
    // Only this click may open the window that floats over other apps;
    // the browser allows it for a few seconds after, enough to load it.
    const pip = import("../chat/voice-mode/voice-pip");
    void pip.then(({ openVoicePip }) => openVoicePip("recording"));
    void (async () => {
      await livekit?.selectTargetRoom?.(anotherMeRoomId);
      openRecordingWindow({ autoStart: true });
    })()
      .catch((cause: unknown) => {
        void pip.then(({ closeVoicePip }) => closeVoicePip("recording"));
        setError(
          cause instanceof Error ? cause.message : "Unable to open recording",
        );
      })
      .finally(() => setPending(false));
  }

  if (capabilities?.voiceMedia === false) return null;

  return (
    // eslint-disable-next-line jsx-a11y/role-supports-aria-props -- aria-description is a valid ARIA global attribute missing from the rule data.
    <button
      aria-description={hint === label ? undefined : hint}
      aria-label={label}
      className="xs-nav-btn relative"
      disabled={
        pending || !voice || !anotherMeRoomId || voice.composerMicrophoneActive
      }
      onClick={start}
      title={hint}
      type="button"
    >
      {saving ? (
        <Icon icon={Loading03Icon} className="animate-spin" size={16} />
      ) : (
        <Icon icon={AiTranscribeAudioIcon} size={16} />
      )}
      {recording ? (
        <span
          aria-hidden="true"
          className="absolute top-1 right-1 size-2 rounded-full bg-app-danger ring-2 ring-app-sidebar"
        />
      ) : null}
      {error ? (
        <span className="sr-only" role="alert">
          {error}
        </span>
      ) : null}
    </button>
  );
}
