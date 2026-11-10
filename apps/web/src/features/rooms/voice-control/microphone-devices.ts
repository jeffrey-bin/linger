import { displayText } from "@linger/service-kit";
export interface VoiceMicrophoneDevice {
  deviceId: string;
  groupId: string;
  label: string;
}

export type VoiceMicrophoneBinding = VoiceMicrophoneDevice;

const voiceMediaAbortRetryDelaysMs = [0, 120, 240] as const;

/** The one set of audio constraints every voice input opens with. */
export const voiceMicrophoneConstraints = {
  autoGainControl: true,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
} as const;

/**
 * Opens the bound microphone, or the system default when that device is gone
 * (M11-N10). Callers then bind whichever device actually opened.
 */
export async function openBoundMicrophone<T>(
  deviceId: string | undefined,
  open: (device: { exact: string } | undefined) => Promise<T>,
) {
  if (deviceId) {
    try {
      return await open({ exact: deviceId });
    } catch (error) {
      if (!["NotFoundError", "OverconstrainedError"].includes(errorName(error)))
        throw error;
    }
  }
  return open(undefined);
}

export function isVoiceAbortError(error: unknown) {
  return errorName(error) === "AbortError";
}

export function describeVoiceMediaError(error: unknown) {
  if (errorName(error) === "NotAllowedError") {
    return "Microphone permission was denied";
  }
  if (isVoiceAbortError(error)) {
    return "Microphone connection was interrupted";
  }
  const message = errorMessage(error);
  return message || String(error);
}

export async function retryOnVoiceMediaAbort<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
) {
  let lastError: unknown;
  for (let index = 0; index < voiceMediaAbortRetryDelaysMs.length; index += 1) {
    signal?.throwIfAborted();
    const delayMs = voiceMediaAbortRetryDelaysMs[index]!;
    if (delayMs > 0) await waitForVoiceMediaDelay(delayMs);
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      signal?.throwIfAborted();
      if (
        !isVoiceAbortError(error) ||
        index === voiceMediaAbortRetryDelaysMs.length - 1
      ) {
        throw error;
      }
    }
  }
  throw lastError;
}

export async function discoverVoiceMicrophones(
  input: {
    mediaDevices?: Pick<MediaDevices, "enumerateDevices" | "getUserMedia">;
    preferredDeviceId?: string;
    timeoutMs?: number;
  } = {},
) {
  const mediaDevices = input.mediaDevices ?? navigator.mediaDevices;
  if (!mediaDevices) throw new Error("Microphone access is unavailable");
  const enumerated = await mediaDevices.enumerateDevices();
  // Without a remembered device, ask the browser which microphone it grants:
  // that is the one the person chose in its prompt or site settings.
  if (
    enumerated.some(
      (device) =>
        isLabeledAudioInput(device) &&
        device.deviceId === input.preferredDeviceId,
    )
  ) {
    return selectVoiceMicrophones(
      await listVoiceMicrophones(mediaDevices),
      input.preferredDeviceId,
    );
  }
  return requestVoiceMicrophones({
    mediaDevices,
    preferredDeviceId: input.preferredDeviceId,
    timeoutMs: input.timeoutMs,
  });
}

export async function requestVoiceMicrophones(input: {
  mediaDevices?: Pick<MediaDevices, "enumerateDevices" | "getUserMedia">;
  preferredDeviceId?: string;
  timeoutMs?: number;
}) {
  const mediaDevices = input.mediaDevices ?? navigator.mediaDevices;
  const permissionStream = await getUserMediaWithTimeout({
    constraints: { audio: true },
    getUserMedia: mediaDevices.getUserMedia.bind(mediaDevices),
    timeoutMs: input.timeoutMs,
  });
  const grantedDeviceId = permissionStream
    .getAudioTracks()[0]
    ?.getSettings().deviceId;
  for (const track of permissionStream.getTracks()) track.stop();
  return selectVoiceMicrophones(
    await listVoiceMicrophones(mediaDevices),
    input.preferredDeviceId,
    grantedDeviceId,
  );
}

export async function listVoiceMicrophones(
  mediaDevices: Pick<MediaDevices, "enumerateDevices"> = navigator.mediaDevices,
) {
  const devices = (await mediaDevices.enumerateDevices())
    .filter(
      (device): device is MediaDeviceInfo & { deviceId: string } =>
        device.kind === "audioinput" &&
        Boolean(device.deviceId) &&
        !isSystemDeviceAlias(device.deviceId),
    )
    .map((device, index) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      label: device.label || `Microphone ${index + 1}`,
    }));
  const seen = new Set<string>();
  return devices.filter((device) => {
    const identity = device.groupId
      ? `${device.groupId}\u0000${device.label}`
      : `${device.deviceId}\u0000${device.label}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function isSystemDeviceAlias(deviceId: string) {
  return deviceId === "default" || deviceId === "communications";
}

function isLabeledAudioInput(device: MediaDeviceInfo) {
  return (
    device.kind === "audioinput" &&
    Boolean(device.deviceId) &&
    !isSystemDeviceAlias(device.deviceId) &&
    device.label.trim() !== ""
  );
}

function selectVoiceMicrophones(
  devices: VoiceMicrophoneDevice[],
  preferredDeviceId?: string,
  grantedDeviceId?: string,
) {
  if (devices.length === 0) {
    throw new DOMException(
      "No audio input device is available",
      "NotFoundError",
    );
  }
  const selectedDeviceId =
    devices.find((device) => device.deviceId === preferredDeviceId)?.deviceId ??
    devices.find((device) => device.deviceId === grantedDeviceId)?.deviceId ??
    devices[0]!.deviceId;
  return { devices, selectedDeviceId };
}

function getUserMediaWithTimeout(input: {
  constraints: MediaStreamConstraints;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  timeoutMs?: number;
}) {
  return retryOnVoiceMediaAbort(() => getUserMediaAttempt(input));
}

function getUserMediaAttempt(input: {
  constraints: MediaStreamConstraints;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  timeoutMs?: number;
}) {
  const pending = input.getUserMedia(input.constraints);
  const timeoutMs = input.timeoutMs ?? 10_000;
  let expired = false;
  return new Promise<MediaStream>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      expired = true;
      reject(new Error("Microphone connection timed out"));
    }, timeoutMs);
    void pending.then(
      (stream) => {
        globalThis.clearTimeout(timeout);
        if (expired) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        resolve(stream);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeout);
        if (!expired) reject(error);
      },
    );
  });
}

function waitForVoiceMediaDelay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

function errorName(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : "";
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    error.message
  ) {
    return displayText(error.message);
  }
  return "";
}

export function matchBoundVoiceMicrophone(
  devices: VoiceMicrophoneDevice[],
  binding: VoiceMicrophoneBinding,
) {
  return (
    devices.find((device) => device.deviceId === binding.deviceId) ??
    devices.find(
      (device) =>
        Boolean(binding.groupId) && device.groupId === binding.groupId,
    ) ??
    devices.find(
      (device) => Boolean(binding.label) && device.label === binding.label,
    )
  );
}
