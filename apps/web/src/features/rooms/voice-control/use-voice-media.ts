import type { Room } from "livekit-client";
import { useCallback } from "react";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import type { TeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { abortVoiceRequest } from "@/features/teamhub/voice-request-scope";

import { listVoiceMicrophones } from "./microphone-devices";
import { describeError, isActiveCapture } from "./voice-control-helpers";
import { deviceStorageKey, writeStorage } from "./voice-control-storage";
import type { VoiceControlState } from "./use-voice-control-state";

/** Tears down media, restores the Room's active Capture and adopts devices. */
export function useVoiceMedia(
  state: VoiceControlState,
  runtime: TeamHubRuntime,
  tenantId: string,
) {
  const {
    refs,
    requests,
    setBoundDevice,
    setCapture,
    setListenerError,
    setListenerStatus,
    setSelectedDeviceId,
  } = state;

  const cleanupMedia = useCallback(async () => {
    abortVoiceRequest(
      refs.connectionControllerRef.current,
      "Microphone connection closed",
    );
    refs.connectionControllerRef.current = undefined;
    const room = refs.roomRef.current;
    const track = refs.trackRef.current;
    refs.roomRef.current = undefined;
    refs.trackRef.current = undefined;
    track?.stop();
    await Promise.allSettled([
      room && track ? room.localParticipant.unpublishTrack(track) : undefined,
      room?.disconnect(),
    ]);
  }, [refs]);

  const failMedia = useCallback(
    (room: Room, status: "error" | "device_disconnected", error?: unknown) => {
      if (!refs.mountedRef.current || refs.roomRef.current !== room) return;
      setListenerStatus(status);
      if (error !== undefined) setListenerError(describeError(error));
      // Detach and stop the current track synchronously before allowing
      // another tab to publish. Late events from this room are now fenced.
      void cleanupMedia();
      refs.publisherLeaseRef.current?.();
      refs.publisherLeaseRef.current = undefined;
    },
    [cleanupMedia, refs, setListenerError, setListenerStatus],
  );

  const restoreActiveCapture = useCallback(
    async (roomId: string, signal?: AbortSignal) => {
      try {
        const capture = await requests.run(
          (requestSignal) =>
            teamHubData(
              runtime.client.api.GET(
                "/v0/rooms/{roomId}/active-voice-capture",
                {
                  params: { path: { roomId } },
                  signal: requestSignal,
                },
              ),
            ),
          signal,
        );
        if (capture) {
          if (refs.startPromiseRef.current && !isActiveCapture(capture)) return;
          setCapture(capture);
          return;
        }
      } catch (error) {
        if (!(error instanceof TeamHubError) || error.status !== 404)
          throw error;
      }
      if (!refs.captureRef.current || isActiveCapture(refs.captureRef.current))
        setCapture(undefined);
    },
    [refs, requests, runtime.client, setCapture],
  );

  // Every voice input opens the bound microphone, or the system default when
  // it is gone; the binding then follows the device that opened (M11-N10).
  const adoptMicrophone = useCallback(
    async (deviceId: string | undefined) => {
      const binding = refs.bindingRef.current;
      if (!deviceId || !binding || deviceId === binding.deviceId) return;
      const opened = (await listVoiceMicrophones().catch(() => [])).find(
        (device) => device.deviceId === deviceId,
      );
      if (
        !opened ||
        !refs.mountedRef.current ||
        refs.bindingRef.current !== binding
      )
        return;
      refs.bindingRef.current = opened;
      setBoundDevice(opened);
      setSelectedDeviceId(opened.deviceId);
      writeStorage(deviceStorageKey(tenantId), JSON.stringify(opened));
    },
    [refs, setBoundDevice, setSelectedDeviceId, tenantId],
  );

  return { cleanupMedia, failMedia, restoreActiveCapture, adoptMicrophone };
}
