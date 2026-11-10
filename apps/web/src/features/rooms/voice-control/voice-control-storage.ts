import type { TeamHubVoiceCapture } from "@/features/teamhub/teamhub-types";

import type { VoiceMicrophoneBinding } from "./microphone-devices";

export function deviceStorageKey(tenantId: string) {
  return `linger.voice.device.${tenantId}`;
}

export function readDeviceBinding(
  tenantId: string,
): VoiceMicrophoneBinding | undefined {
  const value = readStorage(deviceStorageKey(tenantId));
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<VoiceMicrophoneBinding>;
    if (
      typeof parsed.deviceId === "string" &&
      typeof parsed.groupId === "string" &&
      typeof parsed.label === "string"
    ) {
      return parsed as VoiceMicrophoneBinding;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A blocked preference store must not disable the microphone session.
  }
}

export function removeStorage(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // A blocked preference store must not prevent explicit disconnect.
  }
}

export function readSelectedVoiceRoom(tenantId: string) {
  try {
    return window.sessionStorage.getItem(`linger.voice.target.${tenantId}`);
  } catch {
    return null;
  }
}

export function writeSelectedVoiceRoom(tenantId: string, roomId: string) {
  try {
    window.sessionStorage.setItem(`linger.voice.target.${tenantId}`, roomId);
  } catch {
    /* Recording works even when browser preferences are unavailable. */
  }
}

interface VoiceListeningCapture {
  captureId: string;
  createdAt: string;
  stopped: boolean;
}

export function readVoiceListeningCapture(
  tenantId: string,
): VoiceListeningCapture | undefined {
  try {
    const value = JSON.parse(
      readStorage(`linger.voice.listening.${tenantId}`) ?? "null",
    );
    if (
      value &&
      typeof value.captureId === "string" &&
      typeof value.createdAt === "string" &&
      Number.isFinite(Date.parse(value.createdAt)) &&
      typeof value.stopped === "boolean"
    )
      return value;
  } catch {
    // An unavailable preference store does not prevent explicit microphone use.
  }
  return undefined;
}

export function rememberVoiceListeningCapture(
  tenantId: string,
  capture: TeamHubVoiceCapture,
) {
  const previous = readVoiceListeningCapture(tenantId);
  const value: VoiceListeningCapture = {
    captureId: capture.id,
    createdAt: capture.created_at,
    stopped: capture.status !== "starting" && capture.status !== "recording",
  };
  if (previous && previous.captureId !== capture.id) {
    const newerBy =
      Date.parse(previous.createdAt) - Date.parse(capture.created_at);
    if (newerBy > 0 || (newerBy === 0 && !previous.stopped && value.stopped))
      return;
  }
  writeStorage(`linger.voice.listening.${tenantId}`, JSON.stringify(value));
}

export function resumeVoiceListening(tenantId: string) {
  const previous = readVoiceListeningCapture(tenantId);
  if (previous?.stopped)
    writeStorage(
      `linger.voice.listening.${tenantId}`,
      JSON.stringify({ ...previous, stopped: false }),
    );
}
