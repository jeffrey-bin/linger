import { useCallback } from "react";
import type { NavigateFunction } from "react-router";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubVoiceCapture,
  TeamHubVoiceSession,
} from "@/features/teamhub/teamhub-types";
import {
  type VoiceRequestScope,
  waitForVoiceDelay as delay,
} from "@/features/teamhub/voice-request-scope";

import {
  elapsedSessionMS,
  isActiveCapture,
  isRetryableVoiceRequestError,
  voiceTargetRoomPath,
} from "./voice-control-helpers";
import { voicePollRetryDelay } from "./voice-poll-retry";
import type { VoiceControlState, VoiceTarget } from "./use-voice-control-state";

interface VoiceCaptureCommandsInput {
  state: VoiceControlState;
  runtime: TeamHubRuntime;
  tenantId: string;
  navigate: NavigateFunction;
  enable: (automatic?: boolean) => Promise<void>;
  ensureTarget: (activeRoomOverride?: string) => Promise<VoiceTarget>;
}

/** Starts, restarts and stops hardware Captures. */
export function useVoiceCaptureCommands({
  state,
  runtime,
  tenantId,
  navigate,
  enable,
  ensureTarget,
}: VoiceCaptureCommandsInput) {
  const {
    refs,
    requests,
    setCapture,
    setCaptureSyncStatus,
    setListenerError,
    setPartialTranscript,
    setTranscriptItems,
  } = state;

  const startCapture = useCallback(() => {
    if (refs.startPromiseRef.current) return refs.startPromiseRef.current;
    const controller = new AbortController();
    refs.startControllerRef.current = controller;
    const operation = (async () => {
      const target = await ensureTarget();
      // Publishing the microphone precedes Runtime subscription and ASR input.
      // Wait for the current handshake even when the local track already exists,
      // so the recorder cannot start ahead of live transcript coverage.
      if (refs.enablePromiseRef.current) {
        await refs.enablePromiseRef.current;
      } else if (!refs.roomRef.current || !refs.trackRef.current) {
        await enable();
      }
      controller.signal.throwIfAborted();
      const session = refs.voiceSessionRef.current;
      if (!session) throw new Error("VoiceSession is unavailable");
      if (refs.captureRef.current && isActiveCapture(refs.captureRef.current))
        return refs.captureRef.current;
      const generation = refs.voiceSessionGenerationRef.current;
      const previousCaptureId = refs.captureRef.current?.id;
      const isCurrent = () =>
        refs.mountedRef.current &&
        !controller.signal.aborted &&
        refs.voiceSessionRef.current?.id === session.id &&
        refs.voiceSessionGenerationRef.current === generation;
      const started = await requestVoiceCaptureStart({
        client: runtime.client,
        requests,
        signal: controller.signal,
        session,
        target,
        previousCaptureId,
        startOffsetMs: elapsedSessionMS(refs.sessionStartedAtRef.current),
        currentCapture: () => refs.captureRef.current,
        isCurrent,
        recovering: () => setCaptureSyncStatus("recovering"),
      });
      if (started.superseded) return started.capture;
      const capture = started.capture;
      if (!isCurrent() || !capture)
        throw new DOMException("Voice Start was superseded", "AbortError");
      const currentAfterResponse = refs.captureRef.current;
      if (currentAfterResponse?.id !== previousCaptureId)
        return currentAfterResponse;
      setCapture(capture);
      await navigate(voiceTargetRoomPath(tenantId, target.roomId));
      return capture;
    })();
    refs.startPromiseRef.current = operation;
    const clear = () => {
      if (refs.startPromiseRef.current === operation) {
        refs.startPromiseRef.current = undefined;
        if (
          refs.mountedRef.current &&
          !isActiveCapture(refs.captureRef.current)
        )
          setCaptureSyncStatus("idle");
      }
      if (refs.startControllerRef.current === controller)
        refs.startControllerRef.current = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }, [
    enable,
    ensureTarget,
    navigate,
    refs,
    requests,
    runtime.client,
    setCapture,
    setCaptureSyncStatus,
    tenantId,
  ]);

  const startNewCapture = useCallback(async () => {
    const previous = refs.captureRef.current;
    if (
      !previous ||
      isActiveCapture(previous) ||
      previous.status === "recovering"
    ) {
      await startCapture();
      return;
    }
    // A completed or failed Capture remains durable server history. Remove
    // only its local projection before starting so a rejected new Start shows
    // its own error instead of dropping the user back into the old failure.
    refs.capturePollGenerationRef.current += 1;
    setCapture(undefined);
    setTranscriptItems([]);
    setPartialTranscript(undefined);
    setListenerError(undefined);
    await startCapture();
  }, [
    refs,
    setCapture,
    setListenerError,
    setPartialTranscript,
    setTranscriptItems,
    startCapture,
  ]);

  const stopCapture = useCallback(() => {
    const capture = refs.captureRef.current;
    if (
      !capture ||
      !isActiveCapture(capture) ||
      capture.status === "finalizing"
    )
      return Promise.resolve(capture);
    if (refs.stopPromiseRef.current?.captureId === capture.id)
      return refs.stopPromiseRef.current.promise;
    const operation = (async () => {
      let stopped: TeamHubVoiceCapture;
      try {
        stopped = await requests.run((signal) =>
          teamHubData(
            runtime.client.api.POST(
              "/v0/voice-captures/{captureSessionId}/stop",
              {
                params: { path: { captureSessionId: capture.id } },
                signal,
              },
            ),
          ),
        );
      } catch (error) {
        if (!refs.mountedRef.current) throw error;
        const current = refs.captureRef.current;
        if (current?.id !== capture.id || !isActiveCapture(current))
          return current;
        try {
          stopped = await requests.run((signal) =>
            teamHubData(
              runtime.client.api.GET("/v0/voice-captures/{captureSessionId}", {
                params: { path: { captureSessionId: capture.id } },
                signal,
              }),
            ),
          );
        } catch {
          throw error;
        }
        if (stopped.status === "starting" || stopped.status === "recording")
          throw error;
      }
      if (
        refs.mountedRef.current &&
        refs.captureRef.current?.id === capture.id &&
        isActiveCapture(refs.captureRef.current)
      )
        setCapture(stopped);
      return refs.captureRef.current;
    })();
    refs.stopPromiseRef.current = { captureId: capture.id, promise: operation };
    const clear = () => {
      if (refs.stopPromiseRef.current?.promise === operation)
        refs.stopPromiseRef.current = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }, [refs, requests, runtime.client, setCapture]);

  return { startCapture, startNewCapture, stopCapture };
}

interface VoiceCaptureStartRequest {
  client: TeamHubClient;
  requests: VoiceRequestScope;
  signal: AbortSignal;
  session: TeamHubVoiceSession;
  target: VoiceTarget;
  previousCaptureId: string | undefined;
  startOffsetMs: number;
  currentCapture: () => TeamHubVoiceCapture | undefined;
  isCurrent: () => boolean;
  recovering: () => void;
}

/**
 * Posts Start until it is accepted or proven by a live Capture of this
 * session. `superseded` reports that another Capture replaced the previous
 * one meanwhile; the caller then adopts `capture` as it is.
 */
async function requestVoiceCaptureStart(
  request: VoiceCaptureStartRequest,
): Promise<{ capture: TeamHubVoiceCapture | undefined; superseded: boolean }> {
  const { client, previousCaptureId, session, signal, target } = request;
  let failures = 0;
  let capture: TeamHubVoiceCapture | undefined;
  while (request.isCurrent()) {
    const currentBeforeRequest = request.currentCapture();
    if (currentBeforeRequest?.id !== previousCaptureId)
      return { capture: currentBeforeRequest, superseded: true };
    try {
      capture = await request.requests.run(
        (requestSignal) =>
          teamHubData(
            client.api.POST("/v0/voice-sessions/{voiceSessionId}/captures", {
              params: { path: { voiceSessionId: session.id } },
              body: {
                room_id: target.roomId,
                start_offset_ms: request.startOffsetMs,
              },
              signal: requestSignal,
            }),
          ),
        signal,
      );
    } catch (error) {
      if (!request.isCurrent()) throw error;
      const currentAfterFailure = request.currentCapture();
      if (currentAfterFailure?.id !== previousCaptureId)
        return { capture: currentAfterFailure, superseded: true };
      // A transport timeout does not prove that Start was rejected, and a
      // 409 after a timed-out Start can be that first Start committing.
      // Read server truth first and adopt a live Capture of this session.
      request.recovering();
      try {
        capture =
          (await request.requests.run(
            (requestSignal) =>
              teamHubData(
                client.api.GET("/v0/rooms/{roomId}/active-voice-capture", {
                  params: { path: { roomId: target.roomId } },
                  signal: requestSignal,
                }),
              ),
            signal,
          )) ?? undefined;
      } catch (readError) {
        if (!request.isCurrent()) throw readError;
        if (!isRetryableVoiceRequestError(error)) throw error;
        if (
          !isRetryableVoiceRequestError(readError) &&
          !(readError instanceof TeamHubError && readError.status === 404)
        )
          throw readError;
        await delay(voicePollRetryDelay(++failures), signal);
        continue;
      }
      // The room query also returns older recordings awaiting transcript
      // recovery. Only a different, live Capture in this session proves Start.
      if (
        !capture ||
        capture.id === previousCaptureId ||
        capture.voice_session_id !== session.id ||
        capture.room_id !== target.roomId ||
        !isActiveCapture(capture)
      ) {
        capture = undefined;
        if (!isRetryableVoiceRequestError(error)) throw error;
        await delay(voicePollRetryDelay(++failures), signal);
        continue;
      }
    }
    break;
  }
  return { capture, superseded: false };
}
