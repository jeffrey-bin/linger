import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useOptionalTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { useOptionalVoiceControl } from "@/features/rooms/voice-control/voice-control-context";
import { tryAcquireVoicePublisherLease } from "@/features/rooms/voice-control/voice-publisher-lease";
import { useVoiceMediaPolicy } from "@/features/rooms/voice-control/use-voice-media-policy";

import {
  VoiceModeController,
  type VoiceModeState,
} from "../chat/voice-mode/voice-mode-controller";
import { openVoiceMode } from "../chat/voice-mode/voice-mode-transport";

const idle: VoiceModeState = {
  status: "idle",
  text: "",
  sending: false,
  flushing: false,
};

/**
 * Soniox dictation for the Pocket Note, carried by the Another Me Direct
 * Room's chat dictation session: each finished turn goes to `onTurn`, and the
 * words still being recognized stay in `liveText`.
 */
export function usePocketDictation({
  onTurn,
  roomId,
  tenantId,
}: {
  onTurn: (text: string) => void;
  roomId?: string;
  tenantId: string;
}) {
  const runtime = useOptionalTeamHubRuntime();
  const hardware = useOptionalVoiceControl();
  const latest = useRef({ hardware, onTurn });
  useLayoutEffect(() => {
    latest.current = { hardware, onTurn };
  });
  // Dictation transcribes with Soniox.
  const supported =
    useVoiceMediaPolicy(tenantId, Boolean(roomId))?.voice_media_supported ===
    true;
  const [state, setState] = useState(idle);
  const [level, setLevel] = useState(0);
  const [stopping, setStopping] = useState(false);
  // A stopped session hands its leftover words over once; the next start gets
  // a fresh controller so they are never carried into it.
  const [sessionKey, setSessionKey] = useState(0);
  const controllerRef = useRef<VoiceModeController | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const startOnRenew = useRef(false);

  useEffect(() => {
    if (!runtime || !roomId) return;
    // Warm what the first click would otherwise wait on.
    void import("livekit-client").catch(() => undefined);
  }, [roomId, runtime]);

  // The next controller must be ready when the idle control becomes usable.
  // A passive renewal can otherwise cancel a start on the previous session.
  useLayoutEffect(() => {
    if (!runtime || !roomId) return;
    const controller = new VoiceModeController({
      open: (receive, fail, microphone) => {
        const abort = new AbortController();
        abortRef.current = abort;
        return openVoiceMode({
          client: runtime.client,
          events: runtime.voiceEvents,
          roomId,
          receive,
          fail,
          signal: abort.signal,
          level: setLevel,
          microphone,
          deviceId: latest.current.hardware?.boundDevice?.deviceId,
          adoptDevice: (deviceId) =>
            void latest.current.hardware?.adoptMicrophone?.(deviceId),
          acquireMicrophone: async () => {
            const control = latest.current.hardware;
            if (control?.acquireComposerMicrophone)
              return control.acquireComposerMicrophone({
                resumeListening: false,
              });
            const release = await tryAcquireVoicePublisherLease(tenantId);
            if (!release)
              throw new Error("The microphone is active in another tab.");
            return async () => release();
          },
        });
      },
      send: async (turn) => latest.current.onTurn(turn.text),
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setState);
    if (startOnRenew.current) {
      startOnRenew.current = false;
      void controller.start();
    }
    const depart = () => {
      abortRef.current?.abort();
      void controller.pause();
    };
    window.addEventListener("pagehide", depart);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", depart);
      depart();
      if (controllerRef.current === controller)
        controllerRef.current = undefined;
    };
  }, [roomId, runtime, sessionKey, tenantId]);

  const active =
    stopping ||
    state.status === "connecting" ||
    state.status === "listening" ||
    state.status === "closing";

  return {
    available: supported && Boolean(roomId),
    active,
    // The Voice Runtime buffers published audio (up to 20s) until its ASR
    // stream opens, so speech is safe once the microphone track is live.
    connecting: state.status === "connecting" && !state.microphoneActive,
    stopping,
    error: state.error,
    level,
    liveText: state.text,
    start() {
      setLevel(0);
      // A failed controller refuses to restart; retry on a fresh one.
      if (state.error) {
        startOnRenew.current = true;
        setSessionKey((key) => key + 1);
        return;
      }
      void controllerRef.current?.start();
    },
    /** Stops the microphone, drains trailing words, and returns what is left. */
    async stop() {
      const controller = controllerRef.current;
      if (!controller) return "";
      setStopping(true);
      abortRef.current?.abort();
      try {
        await Promise.all([
          controller.pause(),
          controller.whenDeliverySettles(),
        ]);
        return controller.getState().text;
      } finally {
        setLevel(0);
        setStopping(false);
        setState(idle);
        setSessionKey((key) => key + 1);
      }
    },
  };
}
