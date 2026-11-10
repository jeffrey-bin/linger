import { useCallback, useEffect, useLayoutEffect } from "react";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { describeError, isActiveCapture } from "./voice-control-helpers";
import {
  deviceStorageKey,
  rememberVoiceListeningCapture,
  removeStorage,
} from "./voice-control-storage";
import { releaseVoiceSession } from "./voice-session-release";
import type { VoiceControlState, VoiceTarget } from "./use-voice-control-state";

/**
 * Releases the VoiceSession when the page goes away and disconnects the bound
 * microphone on request.
 */
export function useVoiceSessionLifecycle(
  state: VoiceControlState,
  runtime: TeamHubRuntime,
  tenantId: string,
  cleanupMedia: () => Promise<void>,
  disable: () => Promise<void>,
) {
  const {
    refs,
    requests,
    setBoundDevice,
    setCapture,
    setListenerError,
    setListenerStatus,
    setPartialTranscript,
    setSelectedDeviceId,
    setTranscriptItems,
    setVoiceSessionId,
  } = state;

  const leavePage = useCallback(() => {
    refs.manuallyDisabledRef.current = true;
    if (refs.leavePromiseRef.current) return refs.leavePromiseRef.current;
    const session = refs.voiceSessionRef.current;
    if (
      !session &&
      !refs.roomRef.current &&
      !refs.enablePromiseRef.current &&
      !refs.startPromiseRef.current
    ) {
      if (refs.mountedRef.current) setListenerStatus("disabled");
      return Promise.resolve();
    }
    const capture = refs.captureRef.current;
    refs.startControllerRef.current?.abort();
    requests.cancel();
    refs.voiceSessionGenerationRef.current += 1;
    refs.capturePollGenerationRef.current += 1;
    refs.voiceSessionRef.current = undefined;
    const mediaCleanup = cleanupMedia();
    refs.publisherLeaseRef.current?.();
    refs.publisherLeaseRef.current = undefined;
    if (refs.mountedRef.current) {
      setVoiceSessionId(undefined);
      setListenerStatus("disabled");
      setPartialTranscript(undefined);
      if (
        capture &&
        (capture.status === "starting" || capture.status === "recording")
      ) {
        rememberVoiceListeningCapture(tenantId, {
          ...capture,
          status: "finalizing",
        });
        setCapture(capture, { status: "finalizing", capture });
      }
    }
    const operation = session
      ? releaseVoiceSession(runtime.client, session, capture, (stopped) => {
          if (
            refs.mountedRef.current &&
            !refs.voiceSessionRef.current &&
            refs.captureRef.current?.id === stopped.id
          )
            setCapture(stopped);
        })
      : Promise.resolve();
    refs.leavePromiseRef.current = operation;
    const clear = () => {
      if (refs.leavePromiseRef.current === operation)
        refs.leavePromiseRef.current = undefined;
    };
    void operation.then(clear, clear);
    void mediaCleanup.catch(() => undefined);
    return operation;
  }, [
    cleanupMedia,
    refs,
    requests,
    runtime.client,
    setCapture,
    setListenerStatus,
    setPartialTranscript,
    setVoiceSessionId,
    tenantId,
  ]);
  useLayoutEffect(() => {
    refs.leavePageRef.current = leavePage;
  }, [leavePage, refs]);

  useEffect(() => {
    const leave = () => {
      void refs.leavePageRef.current().catch(() => undefined);
    };
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [refs]);

  const disconnectDevice = useCallback(async () => {
    if (refs.captureRef.current && isActiveCapture(refs.captureRef.current)) {
      throw new Error("Stop the recording before disconnecting the microphone");
    }
    const session = refs.voiceSessionRef.current;
    refs.startControllerRef.current?.abort();
    refs.voiceSessionGenerationRef.current += 1;
    refs.voiceSessionRef.current = undefined;
    setVoiceSessionId(undefined);
    setCapture(undefined);
    setTranscriptItems([]);
    setPartialTranscript(undefined);
    setListenerError(undefined);
    await disable();
    if (session) {
      await teamHubData(
        runtime.client.api.DELETE("/v0/voice-sessions/{voiceSessionId}", {
          params: { path: { voiceSessionId: session.id } },
        }),
      );
    }
    refs.bindingRef.current = undefined;
    setBoundDevice(undefined);
    setSelectedDeviceId("");
    removeStorage(deviceStorageKey(tenantId));
  }, [
    disable,
    refs,
    runtime.client,
    setBoundDevice,
    setCapture,
    setListenerError,
    setPartialTranscript,
    setSelectedDeviceId,
    setTranscriptItems,
    setVoiceSessionId,
    tenantId,
  ]);

  return { leavePage, disconnectDevice };
}

/**
 * Resolves the target on mount and, on unmount, leaves the page and releases
 * every request, the media and the publisher lease.
 */
export function useVoiceMountLifecycle(
  state: VoiceControlState,
  cleanupMedia: () => Promise<void>,
  ensureTarget: () => Promise<VoiceTarget>,
) {
  const { refs, requests, setListenerError } = state;

  useEffect(() => {
    refs.mountedRef.current = true;
    void ensureTarget().catch((error: unknown) => {
      if (refs.mountedRef.current) setListenerError(describeError(error));
    });
    return () => {
      refs.mountedRef.current = false;
      void refs.leavePageRef.current().catch(() => undefined);
      refs.startControllerRef.current?.abort();
      requests.cancel();
      refs.manuallyDisabledRef.current = true;
      refs.capturePollGenerationRef.current += 1;
      void cleanupMedia().finally(() => {
        refs.publisherLeaseRef.current?.();
        refs.publisherLeaseRef.current = undefined;
      });
    };
  }, [cleanupMedia, ensureTarget, refs, requests, setListenerError]);
}
