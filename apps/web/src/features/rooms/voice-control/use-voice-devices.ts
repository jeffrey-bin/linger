import type { Room } from "livekit-client";
import { useCallback, useEffect } from "react";

import { abortVoiceRequest } from "@/features/teamhub/voice-request-scope";

import {
  discoverVoiceMicrophones,
  isVoiceAbortError,
  listVoiceMicrophones,
  matchBoundVoiceMicrophone,
} from "./microphone-devices";
import { describeError } from "./voice-control-helpers";
import { deviceStorageKey, writeStorage } from "./voice-control-storage";
import { setVoiceMicrophoneMuted } from "./voice-media-connection";
import type { VoiceControlState } from "./use-voice-control-state";

/** Lists, binds, connects, mutes and disables the hardware microphone. */
export function useVoiceDevices(
  state: VoiceControlState,
  tenantId: string,
  enable: (automatic?: boolean) => Promise<void>,
  cleanupMedia: () => Promise<void>,
) {
  const {
    devices,
    refs,
    setBoundDevice,
    setDevices,
    setListenerStatus,
    setMicrophoneMutedState,
    setSelectedDeviceId,
  } = state;

  const discoverDevices = useCallback(async () => {
    const result = await discoverVoiceMicrophones({
      preferredDeviceId: refs.bindingRef.current?.deviceId,
    });
    setDevices(result.devices);
    setSelectedDeviceId(result.selectedDeviceId);
    // The browser's chosen microphone comes first so callers taking the first
    // device honor it.
    return [
      ...result.devices.filter(
        (device) => device.deviceId === result.selectedDeviceId,
      ),
      ...result.devices.filter(
        (device) => device.deviceId !== result.selectedDeviceId,
      ),
    ];
  }, [refs, setDevices, setSelectedDeviceId]);

  const selectDevice = useCallback(
    async (deviceId: string) => {
      const available =
        devices.length > 0 ? devices : await listVoiceMicrophones();
      const device = available.find(
        (candidate) => candidate.deviceId === deviceId,
      );
      if (!device) throw new Error("The selected microphone is unavailable");
      refs.bindingRef.current = device;
      setBoundDevice(device);
      setSelectedDeviceId(device.deviceId);
      setDevices(available);
      writeStorage(deviceStorageKey(tenantId), JSON.stringify(device));
      if (refs.trackRef.current)
        await refs.trackRef.current.setDeviceId(device.deviceId);
    },
    [devices, refs, setBoundDevice, setDevices, setSelectedDeviceId, tenantId],
  );

  const connectDevice = useCallback(
    async (deviceId: string) => {
      await selectDevice(deviceId);
      const previous = refs.enablePromiseRef.current;
      if (previous) {
        abortVoiceRequest(
          refs.connectionControllerRef.current,
          "Restarting microphone connection",
        );
        await previous.catch(() => undefined);
        if (refs.enablePromiseRef.current === previous) {
          refs.enablePromiseRef.current = undefined;
        }
      }
      await enable();
    },
    [enable, refs, selectDevice],
  );

  const setMicrophoneMuted = useCallback(
    async (muted: boolean) => {
      refs.microphoneMutedRef.current = muted;
      setMicrophoneMutedState(muted);
      const track = refs.trackRef.current;
      if (track) await setVoiceMicrophoneMuted(track, muted);
    },
    [refs, setMicrophoneMutedState],
  );

  const disable = useCallback(async () => {
    refs.manuallyDisabledRef.current = true;
    refs.capturePollGenerationRef.current += 1;
    await cleanupMedia();
    refs.publisherLeaseRef.current?.();
    refs.publisherLeaseRef.current = undefined;
    setListenerStatus("disabled");
  }, [cleanupMedia, refs, setListenerStatus]);

  return {
    discoverDevices,
    selectDevice,
    connectDevice,
    setMicrophoneMuted,
    disable,
  };
}

/**
 * Follows the bound microphone across device changes: an unplugged device
 * fails the listener and a returning one reconnects it.
 */
export function useVoiceDeviceChange(
  state: VoiceControlState,
  connectDevice: (deviceId: string) => Promise<void>,
  failMedia: (room: Room, status: "device_disconnected") => void,
) {
  const {
    listenerStatus,
    refs,
    setBoundDevice,
    setDevices,
    setListenerError,
    setListenerStatus,
  } = state;

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return;
    const changed = () => {
      const binding = refs.bindingRef.current;
      const room = refs.roomRef.current;
      void listVoiceMicrophones().then((available) => {
        if (!refs.mountedRef.current || binding !== refs.bindingRef.current)
          return;
        setDevices(available);
        if (!binding) return;
        const matched = matchBoundVoiceMicrophone(available, binding);
        if (!matched) {
          if (room) failMedia(room, "device_disconnected");
          else setListenerStatus("device_disconnected");
          return;
        }
        refs.bindingRef.current = matched;
        setBoundDevice(matched);
        // A microphone that comes back resumes the listener it interrupted,
        // and with it the Capture that was still recording.
        if (
          listenerStatus === "device_disconnected" &&
          !refs.manuallyDisabledRef.current
        ) {
          void connectDevice(matched.deviceId).catch((error: unknown) => {
            if (!refs.mountedRef.current || isVoiceAbortError(error)) return;
            setListenerError(describeError(error));
          });
        }
      });
    };
    navigator.mediaDevices.addEventListener("devicechange", changed);
    return () =>
      navigator.mediaDevices.removeEventListener("devicechange", changed);
  }, [
    connectDevice,
    failMedia,
    listenerStatus,
    refs,
    setBoundDevice,
    setDevices,
    setListenerError,
    setListenerStatus,
  ]);
}
