import { useCallback, useEffect, useRef, useState } from "react";

import {
  isTranscriptRecoveryPaused,
  type VoiceCaptureState,
  type VoiceControlContextValue,
} from "./voice-control-context";
import { matchBoundVoiceMicrophone } from "./microphone-devices";

export type ArmStatus = "pending" | "arming" | "armed" | "blocked";
type VoiceValue = VoiceControlContextValue;

// Entering the surface is the intent to record: ask the browser for the
// microphone straight away and start the recording once it is granted.
export function useVoiceArming(input: {
  autoStart: boolean;
  captureStatus: VoiceCaptureState["status"];
  voice: VoiceValue | null;
}) {
  const { autoStart, captureStatus, voice } = input;
  const [status, setStatus] = useState<ArmStatus>("pending");
  const [error, setError] = useState<string>();
  const generationRef = useRef(0);

  const arm = useCallback(async () => {
    if (!voice) return;
    const generation = ++generationRef.current;
    setStatus("arming");
    setError(undefined);
    // Asking the browser is what raises the native permission prompt; a
    // remembered device skips it until the stored binding stops working.
    let asked = false;
    const askBrowser = async () => {
      asked = true;
      const available = await voice.discoverDevices();
      const device =
        (voice.boundDevice
          ? matchBoundVoiceMicrophone(available, voice.boundDevice)
          : undefined) ?? available[0];
      if (!device)
        throw new DOMException("No microphone is available", "NotFoundError");
      await voice.selectDevice(device.deviceId);
    };
    try {
      const begin = () =>
        captureStatus === "idle"
          ? voice.startCapture()
          : voice.startNewCapture();
      if (!voice.boundDevice) await askBrowser();
      try {
        await begin();
      } catch (cause) {
        // Only a microphone failure justifies a second browser prompt; a
        // rejected Start must keep its own reason.
        if (asked || !isMicrophoneFailure(cause)) throw cause;
        await askBrowser();
        await begin();
      }
      if (generationRef.current === generation) setStatus("armed");
    } catch (cause) {
      if (generationRef.current !== generation) return;
      setStatus("blocked");
      setError(describeArmFailure(cause));
    }
  }, [captureStatus, voice]);

  // A terminal recording leaves its Capture on screen; entering again means a
  // new recording, so it arms exactly like an idle Room does. A failed Capture
  // remains durable server history but must not trap the next recording
  // intent, and neither does one whose transcript recovery waits for Retry.
  const armable =
    Boolean(voice) &&
    (captureStatus === "idle" ||
      captureStatus === "completed" ||
      captureStatus === "failed" ||
      (voice ? isTranscriptRecoveryPaused(voice.captureState) : false)) &&
    voice?.listenerStatus !== "standby" &&
    !voice?.composerMicrophoneActive;
  const autoArming = autoStart && armable && status === "pending";
  useEffect(() => {
    if (!autoArming) return;
    void arm();
  }, [arm, autoArming]);

  const supersede = useCallback(() => {
    generationRef.current += 1;
  }, []);

  // The listener stays paused after its microphone disappears, so resuming is
  // an explicit choice: reconnect the remembered device, else the first one.
  const reconnect = useCallback(async () => {
    if (!voice) return;
    const bound = voice.boundDevice;
    if (bound) {
      await voice.connectDevice(bound.deviceId);
      return;
    }
    const [device] = await voice.discoverDevices();
    if (!device)
      throw new DOMException("No microphone is available", "NotFoundError");
    await voice.connectDevice(device.deviceId);
  }, [voice]);

  return { arm, autoArming, error, reconnect, status, supersede };
}

// One action at a time from the surface's buttons; the failure of the last one
// is shown until the next attempt clears it.
export function useSurfaceAction() {
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const run = useCallback(
    async (operation: () => Promise<unknown>, allowWhilePending = false) => {
      if (actionPending && !allowWhilePending) return;
      setActionError(undefined);
      setActionPending(true);
      try {
        await operation();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setActionPending(false);
      }
    },
    [actionPending],
  );
  return { actionError, actionPending, run };
}

export type MicrophonePermission = "unknown" | "granted" | "prompt" | "denied";

// Follows the browser's microphone permission and returns the unsubscribe.
// The abort signal owns the change listener, so unsubscribing before or after
// the query resolves leaves nothing subscribed.
function watchMicrophonePermission(
  onChange: (permission: MicrophonePermission) => void,
) {
  const permissions =
    typeof navigator === "undefined" ? undefined : navigator.permissions;
  if (!permissions?.query) return () => undefined;
  const controller = new AbortController();
  permissions
    .query({ name: "microphone" })
    .then((status) => {
      if (controller.signal.aborted) return;
      onChange(status.state);
      status.addEventListener("change", () => onChange(status.state), {
        signal: controller.signal,
      });
    })
    .catch(() => undefined);
  return () => controller.abort();
}

// The browser's microphone permission, "unknown" until the query resolves or
// where the Permissions API cannot answer for the microphone.
export function useMicrophonePermission() {
  const [permission, setPermission] = useState<MicrophonePermission>("unknown");
  useEffect(() => watchMicrophonePermission(setPermission), []);
  return permission;
}

export function armTitle(status: ArmStatus) {
  if (status === "arming") return "Starting recording…";
  if (status === "blocked") return "Recording did not start";
  return "Ready to start recording";
}

export function armSubtitle(
  status: ArmStatus,
  permission: MicrophonePermission = "unknown",
) {
  // Arming also covers starting the Capture and connecting a remembered
  // device; only ask for access when the browser has not granted it yet.
  if (status === "arming")
    return permission === "prompt" || permission === "denied"
      ? "Allow microphone access in the browser to begin."
      : "Connecting the microphone…";
  if (status === "blocked")
    return "Check the error below, then start recording again.";
  return "Start recording to capture this meeting.";
}

function isMicrophoneFailure(error: unknown) {
  return (
    error instanceof DOMException ||
    (error instanceof Error &&
      [
        "Connect a microphone before enabling voice",
        "Microphone connection timed out",
      ].includes(error.message))
  );
}

function describeArmFailure(error: unknown): string {
  const name = error instanceof DOMException ? error.name : undefined;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was blocked. Allow it in the browser, then start recording again.";
    case "NotFoundError":
      return "No microphone is available. Connect one, then start recording again.";
    case "NotReadableError":
      return "The microphone is in use by another application.";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
