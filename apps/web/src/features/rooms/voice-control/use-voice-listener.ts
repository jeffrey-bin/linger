import type { Room } from "livekit-client";
import { useCallback, useEffect } from "react";

import type { TeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubVoiceSession } from "@/features/teamhub/teamhub-types";

import { isVoiceAbortError } from "./microphone-devices";
import { describeError, withTimeout } from "./voice-control-helpers";
import { connectVoiceListener } from "./voice-listener-connection";
import type { VoiceControlState, VoiceTarget } from "./use-voice-control-state";

const voiceConnectTimeoutMs = 45_000;

interface VoiceListenerInput {
  state: VoiceControlState;
  runtime: TeamHubRuntime;
  tenantId: string;
  adoptMicrophone: (deviceId: string | undefined) => Promise<void>;
  cleanupMedia: () => Promise<void>;
  ensureTarget: (activeRoomOverride?: string) => Promise<VoiceTarget>;
  failMedia: (
    room: Room,
    status: "error" | "device_disconnected",
    error?: unknown,
  ) => void;
  resolveVoiceSession: (roomId: string) => Promise<TeamHubVoiceSession>;
  restoreActiveCapture: (roomId: string, signal?: AbortSignal) => Promise<void>;
}

/**
 * Connects the hardware listener and keeps it connected: automatically when a
 * bound microphone is idle, and by polling while another tab owns it.
 */
export function useVoiceListener({
  state,
  runtime,
  tenantId,
  adoptMicrophone,
  cleanupMedia,
  ensureTarget,
  failMedia,
  resolveVoiceSession,
  restoreActiveCapture,
}: VoiceListenerInput) {
  const {
    boundDevice,
    listenerStatus,
    pageActive,
    refs,
    requests,
    setListenerError,
    setListenerStatus,
    setVoiceSessionId,
  } = state;

  const enable = useCallback(
    async (automatic = false) => {
      if (refs.enablePromiseRef.current) return refs.enablePromiseRef.current;
      const controller = new AbortController();
      const pendingConnection = connectVoiceListener({
        automatic,
        controller,
        attemptGeneration: refs.voiceSessionGenerationRef.current,
        refs,
        requests,
        client: runtime.client,
        tenantId,
        setListenerError,
        setListenerStatus,
        setVoiceSessionId,
        adoptMicrophone,
        cleanupMedia,
        ensureTarget,
        failMedia,
        resolveVoiceSession,
        restoreActiveCapture,
      });
      const operation = withTimeout(
        pendingConnection,
        voiceConnectTimeoutMs,
        "Microphone connection timed out",
      ).catch(async (error: unknown) => {
        if (refs.connectionControllerRef.current === controller) {
          await cleanupMedia();
          refs.publisherLeaseRef.current?.();
          refs.publisherLeaseRef.current = undefined;
          if (refs.mountedRef.current) {
            setListenerError(describeError(error));
            setListenerStatus("error");
          }
        }
        throw error;
      });
      refs.enablePromiseRef.current = operation;
      try {
        await operation;
      } finally {
        if (refs.enablePromiseRef.current === operation)
          refs.enablePromiseRef.current = undefined;
      }
    },
    [
      adoptMicrophone,
      cleanupMedia,
      ensureTarget,
      failMedia,
      refs,
      requests,
      resolveVoiceSession,
      restoreActiveCapture,
      runtime.client,
      setListenerError,
      setListenerStatus,
      setVoiceSessionId,
      tenantId,
    ],
  );

  useEffect(() => {
    if (
      !boundDevice ||
      !pageActive ||
      refs.manuallyDisabledRef.current ||
      listenerStatus !== "disabled"
    ) {
      return;
    }
    void enable(true).catch((error: unknown) => {
      if (!refs.mountedRef.current || isVoiceAbortError(error)) return;
      setListenerError(describeError(error));
      setListenerStatus("error");
    });
  }, [
    boundDevice,
    enable,
    listenerStatus,
    pageActive,
    refs,
    setListenerError,
    setListenerStatus,
  ]);

  useEffect(() => {
    if (!boundDevice || !pageActive || listenerStatus !== "standby") return;
    // Wait locally for the owner to release its microphone; foreground
    // changes alone must never replace another tab's publisher credential.
    const timer = window.setInterval(() => {
      if (refs.manuallyDisabledRef.current) return;
      void enable(true).catch((error: unknown) => {
        if (!refs.mountedRef.current || isVoiceAbortError(error)) return;
        setListenerError(describeError(error));
        setListenerStatus("error");
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [
    boundDevice,
    enable,
    listenerStatus,
    pageActive,
    refs,
    setListenerError,
    setListenerStatus,
  ]);

  return enable;
}
