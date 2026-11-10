import { useCallback, useEffect } from "react";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { waitForVoiceDelay as delay } from "@/features/teamhub/voice-request-scope";

import { isVoiceAbortError } from "./microphone-devices";
import { describeError } from "./voice-control-helpers";
import { voicePollRetryDelay } from "./voice-poll-retry";
import type { VoiceControlState } from "./use-voice-control-state";

const capturePollIntervalMs = 500;

/**
 * Follows the current Capture: polls a live Capture while the event stream is
 * not live, stops the listener once it is stopped, and polls a finalizing
 * Capture until it settles.
 */
export function useVoiceCapturePolling(
  state: VoiceControlState,
  runtime: TeamHubRuntime,
  cleanupMedia: () => Promise<void>,
) {
  const {
    captureState,
    refs,
    requests,
    setCapture,
    setCaptureSyncStatus,
    setListenerError,
    setListenerStatus,
  } = state;

  const pollCapture = useCallback(
    async (captureId: string, generation: number, signal: AbortSignal) => {
      let consecutiveFailures = 0;
      while (
        refs.mountedRef.current &&
        !signal.aborted &&
        generation === refs.capturePollGenerationRef.current
      ) {
        if (refs.voiceAccessLostRef.current) return;
        const resync = refs.captureResyncRef.current;
        if (refs.eventStreamLiveRef.current && !resync) {
          await delay(capturePollIntervalMs, signal);
          continue;
        }
        let retryInMs = capturePollIntervalMs;
        try {
          const capture = await requests.run(
            (requestSignal) =>
              teamHubData(
                runtime.client.api.GET(
                  "/v0/voice-captures/{captureSessionId}",
                  {
                    params: { path: { captureSessionId: captureId } },
                    signal: requestSignal,
                  },
                ),
              ),
            signal,
          );
          if (
            !refs.mountedRef.current ||
            generation !== refs.capturePollGenerationRef.current ||
            refs.captureRef.current?.id !== captureId
          )
            return;
          if (!refs.eventStreamLiveRef.current || resync) setCapture(capture);
          if (resync) refs.captureResyncRef.current = false;
          consecutiveFailures = 0;
          if (capture.status === "finalized" || capture.status === "failed")
            return;
        } catch {
          if (
            signal.aborted ||
            !refs.mountedRef.current ||
            generation !== refs.capturePollGenerationRef.current
          )
            return;
          consecutiveFailures += 1;
          setCaptureSyncStatus("recovering");
          retryInMs = voicePollRetryDelay(consecutiveFailures);
        }
        await delay(retryInMs, signal);
      }
    },
    [refs, requests, runtime.client, setCapture, setCaptureSyncStatus],
  );

  const finalizingCaptureId =
    captureState.status === "finalizing" || captureState.status === "recovering"
      ? captureState.capture.id
      : undefined;
  const activeCaptureId =
    captureState.status === "starting" || captureState.status === "recording"
      ? captureState.capture.id
      : undefined;
  useEffect(() => {
    if (!activeCaptureId) return;
    let active = true;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      if (refs.voiceAccessLostRef.current) return;
      const resync = refs.captureResyncRef.current;
      if (refs.eventStreamLiveRef.current && !resync) {
        if (active)
          timer = window.setTimeout(() => {
            void poll();
          }, 1_000);
        return;
      }
      try {
        const capture = await requests.run(
          (signal) =>
            teamHubData(
              runtime.client.api.GET("/v0/voice-captures/{captureSessionId}", {
                params: { path: { captureSessionId: activeCaptureId } },
                signal,
              }),
            ),
          controller.signal,
        );
        if (resync) refs.captureResyncRef.current = false;
        if (
          active &&
          (!refs.eventStreamLiveRef.current || resync) &&
          refs.captureRef.current?.id === activeCaptureId &&
          refs.captureRef.current.status !== "finalizing"
        )
          setCapture(capture);
      } catch {
        if (active) setCaptureSyncStatus("recovering");
      }
      if (active)
        timer = window.setTimeout(() => {
          void poll();
        }, 1_000);
    };
    void poll();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    activeCaptureId,
    refs,
    requests,
    runtime.client,
    setCapture,
    setCaptureSyncStatus,
  ]);
  const stoppedCaptureId =
    "capture" in captureState &&
    captureState.status !== "starting" &&
    captureState.status !== "recording"
      ? captureState.capture?.id
      : undefined;
  useEffect(() => {
    if (!stoppedCaptureId || refs.captureRef.current?.id !== stoppedCaptureId)
      return;
    refs.manuallyDisabledRef.current = true;
    setListenerStatus("disabled");
    // This also covers a successful Stop read that is already terminal and
    // therefore never renders finalizing. Detach before releasing the lease.
    void cleanupMedia();
    refs.publisherLeaseRef.current?.();
    refs.publisherLeaseRef.current = undefined;
  }, [cleanupMedia, refs, setListenerStatus, stoppedCaptureId]);
  useEffect(() => {
    if (!finalizingCaptureId) return;
    const controller = new AbortController();
    const generation = ++refs.capturePollGenerationRef.current;
    void pollCapture(finalizingCaptureId, generation, controller.signal).catch(
      (error: unknown) => {
        if (
          !refs.mountedRef.current ||
          isVoiceAbortError(error) ||
          generation !== refs.capturePollGenerationRef.current
        )
          return;
        setCaptureSyncStatus("recovering");
        setListenerError(describeError(error));
      },
    );
    return () => {
      controller.abort();
      if (refs.capturePollGenerationRef.current === generation) {
        refs.capturePollGenerationRef.current += 1;
      }
    };
  }, [
    finalizingCaptureId,
    pollCapture,
    refs,
    setCaptureSyncStatus,
    setListenerError,
  ]);
}
