import { bounded } from "@/features/rooms/voice-control/voice-media-connection";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubVoiceSession } from "@/features/teamhub/teamhub-types";

/**
 * Helpers for the Voice Mode dictation transport: the microphone lease,
 * VoiceSession cleanup and the level meter.
 */

/** Bounded lease acquisition; a lease granted after abandonment is released. */
export async function acquireVoiceMicrophone(
  acquire: () => Promise<() => Promise<void>>,
  signal: AbortSignal,
) {
  let abandoned = false;
  const acquiring = acquire();
  void acquiring.then(
    (release) => {
      if (abandoned || signal.aborted) void release().catch(() => undefined);
    },
    () => undefined,
  );
  try {
    return await bounded(acquiring, 5_000, signal);
  } catch (error) {
    abandoned = true;
    throw error;
  }
}

/** Closes a VoiceSession whose creation finishes after the caller gave up. */
export function closeAbandonedVoiceSession(
  client: TeamHubClient,
  creating: Promise<TeamHubVoiceSession>,
  abandoned: () => boolean,
) {
  void creating.then(
    (created) => {
      if (abandoned()) void closeVoiceSessionQuietly(client, created.id);
    },
    () => undefined,
  );
}

export function closeVoiceSessionQuietly(
  client: TeamHubClient,
  voiceSessionId: string,
) {
  return teamHubData(
    client.api.DELETE("/v0/voice-sessions/{voiceSessionId}", {
      params: { path: { voiceSessionId } },
      signal: AbortSignal.timeout(5_000),
      keepalive: true,
    }),
  ).catch(() => undefined);
}

export function smoothVoiceLevel(previous: number, raw: number) {
  const noiseFloor = 0.04;
  const normalized =
    raw <= noiseFloor ? 0 : Math.min(1, (raw - noiseFloor) / (1 - noiseFloor));
  const coefficient = normalized > previous ? 0.45 : 0.16;
  return previous + (normalized - previous) * coefficient;
}

/** Analyse a track already in the page; never request a second microphone. */
export function observeAudioLevel(
  track: MediaStreamTrack,
  update: (level: number) => void,
) {
  if (typeof AudioContext === "undefined") return () => undefined;
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  const source = context.createMediaStreamSource(new MediaStream([track]));
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let frame = 0;
  let smoothed = 0;
  let previous = 0;
  const sample = (time: number) => {
    if (time - previous > 50) {
      previous = time;
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(
        data.reduce((sum, value) => sum + value * value, 0) / data.length,
      );
      smoothed = smoothVoiceLevel(smoothed, Math.min(1, rms * 8));
      update(smoothed);
    }
    frame = requestAnimationFrame(sample);
  };
  void context.resume().catch(() => undefined);
  frame = requestAnimationFrame(sample);
  return () => {
    cancelAnimationFrame(frame);
    source.disconnect();
    analyser.disconnect();
    void context.close().catch(() => undefined);
  };
}

export { bounded } from "@/features/rooms/voice-control/voice-media-connection";
export function voiceMicrophoneOptions(deviceId: string | undefined) {
  return {
    deviceId,
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}
