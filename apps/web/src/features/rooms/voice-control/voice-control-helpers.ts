import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { TeamHubTransportError } from "@/features/teamhub/teamhub-error";
import type {
  TeamHubVoiceCapture,
  TeamHubVoiceTranscriptEvent,
} from "@/features/teamhub/teamhub-types";

import { describeVoiceMediaError } from "./microphone-devices";
import type {
  VoiceCaptureState,
  VoiceTranscriptItem,
} from "./voice-control-context";

export function voiceTargetRoomPath(tenantId: string, roomId: string) {
  return `/t/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(roomId)}/chat`;
}

export function mergeVoiceTranscriptItems(
  current: VoiceTranscriptItem[],
  events: TeamHubVoiceTranscriptEvent[],
) {
  const items = new Map(current.map((item) => [item.id, item]));
  for (const event of events) {
    const item = voiceTranscriptItem(event);
    const previous = items.get(event.id);
    if (
      !previous ||
      !previous.updatedAt ||
      Date.parse(event.updated_at) >= Date.parse(previous.updatedAt)
    )
      items.set(event.id, item);
  }
  return [...items.values()]
    .sort((left, right) => left.createdAtMs - right.createdAtMs)
    .slice(-100);
}

function voiceTranscriptItem(
  event: TeamHubVoiceTranscriptEvent,
): VoiceTranscriptItem {
  return {
    captureId: event.capture_session_id,
    createdAtMs: Date.parse(event.accepted_at),
    endOffsetMs: event.end_offset_ms,
    id: event.id,
    updatedAt: event.updated_at,
    startOffsetMs: event.start_offset_ms,
    speakerLabel: speakerLabelFromId(event.speaker_id),
    text: event.text,
  };
}

function speakerLabelFromId(id: string | undefined) {
  const match = id?.match(/^spk_([1-9][0-9]*)$/);
  return match ? `Speaker ${match[1]}` : undefined;
}

export function projectCapture(
  capture: TeamHubVoiceCapture,
): VoiceCaptureState {
  switch (capture.status) {
    case "starting":
      return { capture, status: "starting" };
    case "recording":
      return { capture, status: "recording" };
    case "finalizing":
      return { capture, status: "finalizing" };
    case "recovering":
      return { capture, status: "recovering" };
    case "finalized":
      return { capture, status: "completed" };
    case "failed":
      return {
        capture,
        reason: new Error(capture.last_failure_code ?? "Voice Capture failed"),
        status: "failed",
      };
  }
}

export function isActiveCapture(capture: TeamHubVoiceCapture | undefined) {
  return (
    capture?.status === "starting" ||
    capture?.status === "recording" ||
    capture?.status === "finalizing"
  );
}

export function isRetryableVoiceRequestError(error: unknown) {
  return (
    error instanceof TeamHubTransportError ||
    (error instanceof TeamHubError &&
      (error.status === 429 || error.status >= 500))
  );
}

export function elapsedSessionMS(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error(message)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

export function describeError(error: unknown) {
  return describeVoiceMediaError(error);
}
