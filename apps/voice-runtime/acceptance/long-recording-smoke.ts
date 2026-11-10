import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { verifyCaptureArtifacts } from "./verify-capture.js";
import { BrowserSmokePublisher } from "./browser-smoke-publisher.js";
import { waitForVoiceInputReady } from "./voice-input-readiness.js";
import {
  loopAudioFrames,
  playObservedAudio,
} from "./observed-audio-playback.js";
import { waitForSoakGate } from "./soak-coordination.js";

import {
  AudioFrame,
  AudioSource,
  ContinualGatheringPolicy,
  IceTransportType,
  LocalAudioTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import type { components } from "@linger/wire-contracts/teamhub-public/types";

type VoiceCapture = components["schemas"]["VoiceCapture"];
type VoiceSession = components["schemas"]["VoiceSession"];
type VoiceTranscriptEvent = components["schemas"]["VoiceTranscriptEvent"];
type VoiceTranscriptEventPage =
  components["schemas"]["VoiceTranscriptEventPage"];

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const integer = (name: string, fallback: number, minimum: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
};

const baseUrl = new URL(
  process.env.VOICE_SOAK_TEAMHUB_URL?.trim() || "http://127.0.0.1:8081",
);
const roomId = required("VOICE_SOAK_ROOM_ID");
const pcmFile = required("VOICE_SOAK_PCM_FILE");
const username = process.env.VOICE_SOAK_USERNAME?.trim() || "alice@example.com";
const password = required("VOICE_SOAK_PASSWORD");
const durationMs = integer("VOICE_SOAK_DURATION_MS", 0, 30_000);
const dispatchWaitMs = integer("VOICE_SOAK_DISPATCH_WAIT_MS", 0, 0);
const progressStallMs = integer("VOICE_SOAK_PROGRESS_STALL_MS", 60_000, 10_000);
const maxFinalizeMs = integer("VOICE_SOAK_MAX_FINALIZE_MS", 60_000, 1_000);
const minFinalEvents = integer("VOICE_SOAK_MIN_FINAL_EVENTS", 1, 0);
const maxGapCount = integer("VOICE_SOAK_MAX_GAP_COUNT", 0, 0);
const requireRelay = process.env.VOICE_SOAK_REQUIRE_RELAY === "1";
const browserPublisher =
  process.env.VOICE_SOAK_DRIVER === "browser"
    ? new BrowserSmokePublisher()
    : undefined;
let relayEvidence:
  | { relay_verified: true; relay_protocol: string; relay_address: string }
  | undefined;

const login = await fetch(new URL("/v0/auth/login", baseUrl), {
  body: JSON.stringify({ identifier: username, password }),
  headers: { "content-type": "application/json" },
  method: "POST",
  signal: AbortSignal.timeout(10_000),
});
const cookie = login.headers.getSetCookie()[0]?.split(";", 1)[0];
if (!login.ok || !cookie) throw new Error(`login failed: ${login.status}`);

let requestSequence = 0;
const request = async <T>(
  path: string,
  options: {
    body?: unknown;
    idempotent?: boolean;
    method?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
) => {
  const headers: Record<string, string> = { cookie };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.idempotent) {
    headers["idempotency-key"] =
      `voice-soak-${randomUUID()}-${requestSequence++}`;
  }
  const response = await fetch(new URL(path, baseUrl), {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method || "GET",
    signal: AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 10_000),
      ...(options.signal ? [options.signal] : []),
    ]),
  });
  if (!response.ok) {
    throw Object.assign(
      new Error(
        `${options.method || "GET"} ${path} failed: ${response.status}`,
      ),
      { status: response.status },
    );
  }
  return (await response.json()) as T;
};
const maybeRequest = async <T>(path: string) => {
  const response = await fetch(new URL(path, baseUrl), {
    headers: { cookie },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
  return (await response.json()) as T;
};

const activeCapture = await maybeRequest<VoiceCapture | null>(
  `/v0/rooms/${encodeURIComponent(roomId)}/active-voice-capture`,
);
if (activeCapture) {
  throw new Error(
    `Room already has active Capture ${activeCapture.id} (${activeCapture.status})`,
  );
}
const activeSession = await maybeRequest<VoiceSession>(
  `/v0/rooms/${encodeURIComponent(roomId)}/voice-sessions`,
);
if (activeSession) {
  if (process.env.VOICE_SOAK_FAIL_IF_ACTIVE_SESSION === "1") {
    throw new Error("Benchmark Room already has an active VoiceSession");
  }
  await request<VoiceSession>(
    `/v0/voice-sessions/${encodeURIComponent(activeSession.id)}`,
    { body: {}, idempotent: true, method: "DELETE" },
  );
}

const bytes = await readFile(pcmFile);
if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
  throw new Error("VOICE_SOAK_PCM_FILE must contain non-empty s16le PCM");
}
const pcm = new Int16Array(
  bytes.buffer,
  bytes.byteOffset,
  bytes.byteLength / Int16Array.BYTES_PER_ELEMENT,
);
const session = await request<VoiceSession>(
  `/v0/rooms/${encodeURIComponent(roomId)}/voice-sessions`,
  {
    body: { purpose: "hardware_control" },
    idempotent: true,
    method: "POST",
  },
);
const credential = await request<
  components["schemas"]["VoiceConnectionCredential"]
>(
  `/v0/voice-sessions/${encodeURIComponent(session.id)}/connection-credentials`,
  { body: {}, method: "POST" },
);

const room = new Room();
const source = new AudioSource(48_000, 1);
const track = LocalAudioTrack.createAudioTrack("voice-soak", source);
let capture: VoiceCapture | undefined;
let stopped = false;
let sessionClosed = false;
const playbackController = new AbortController();
let stage = "connect";
process.once("SIGTERM", () => {
  playbackController.abort(
    new Error("Voice soak was interrupted before completion"),
  );
  void source.close().catch(() => undefined);
});

try {
  if (browserPublisher) {
    await browserPublisher.connect(
      process.env.VOICE_SOAK_LIVEKIT_ENDPOINT || credential.endpoint,
      credential.credential,
      pcm,
    );
    if (requireRelay) relayEvidence = await browserPublisher.relayEvidence();
  } else {
    await room.connect(
      process.env.VOICE_SOAK_LIVEKIT_ENDPOINT || credential.endpoint,
      credential.credential,
      {
        autoSubscribe: false,
        dynacast: false,
        rtcConfig: requireRelay
          ? {
              iceTransportType: IceTransportType.TRANSPORT_RELAY,
              continualGatheringPolicy:
                ContinualGatheringPolicy.GATHER_CONTINUALLY,
              iceServers: [],
            }
          : undefined,
      },
    );
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    const publisher = room.localParticipant;
    if (!publisher) throw new Error("LiveKit publisher is unavailable");
    await publisher.publishTrack(track, publishOptions);
  }
  stage = "dispatch";
  await delay(dispatchWaitMs);
  await waitForVoiceInputReady(
    (signal) =>
      request<VoiceSession>(
        `/v0/voice-sessions/${encodeURIComponent(session.id)}`,
        { signal },
      ),
    credential.generation,
  );

  stage = "capture-start";
  const captureRequestedAt = Date.now();
  capture = await request<VoiceCapture>(
    `/v0/voice-sessions/${encodeURIComponent(session.id)}/captures`,
    {
      body: { room_id: roomId, start_offset_ms: 0 },
      idempotent: true,
      method: "POST",
      timeoutMs: 30_000,
    },
  );
  if (capture.status !== "recording") {
    throw new Error(`Capture started with ${capture.status}`);
  }
  const captureStartLatencyMs = Date.now() - captureRequestedAt;

  const events = new Map<string, VoiceTranscriptEvent>();
  const signatures = new Map<string, string>();
  let cursor: { id: string; updatedAt: string } | undefined;
  let archivedThroughMs = capture.archived_through_ms ?? 0;
  let transcriptThroughMs = 0;
  let lastTranscriptProgressAt = Date.now();
  let lastObservationAt = 0;
  let lastHeartbeatAt = 0;
  await waitForSoakGate("start", playbackController.signal);
  const startedAt = Date.now();
  lastTranscriptProgressAt = startedAt;
  await browserPublisher?.start();
  stage = "recording";

  const observe = async (signal: AbortSignal) => {
    if (Date.now() - lastObservationAt < 2_000) return;
    lastObservationAt = Date.now();
    const current = await request<VoiceCapture>(
      `/v0/voice-captures/${encodeURIComponent(capture!.id)}`,
      { signal },
    );
    if (current.transcript_recovery_status)
      throw new Error(
        "Archive recovery cannot satisfy real-time soak acceptance",
      );
    if (current.status !== "recording") {
      throw new Error(`Capture changed to ${current.status} during soak`);
    }
    if ((current.archived_through_ms ?? 0) > archivedThroughMs) {
      archivedThroughMs = current.archived_through_ms ?? archivedThroughMs;
    }

    const query = new URLSearchParams();
    if (cursor) {
      query.set("after_updated_at", cursor.updatedAt);
      query.set("after_id", cursor.id);
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const page = await request<VoiceTranscriptEventPage>(
      `/v0/voice-sessions/${encodeURIComponent(session.id)}/transcript-events${suffix}`,
      { signal },
    );
    for (const event of page.items) {
      events.set(event.id, event);
      const signature = transcriptSignature(event);
      const prior = signatures.get(signature);
      if (prior && prior !== event.id) {
        throw new Error("duplicate final transcript observation detected");
      }
      signatures.set(signature, event.id);
      if (event.end_offset_ms > transcriptThroughMs) {
        transcriptThroughMs = event.end_offset_ms;
        lastTranscriptProgressAt = Date.now();
      }
    }
    const last = page.items.at(-1);
    if (last) cursor = { id: last.id, updatedAt: last.updated_at };
    if ((page.partial_end_offset_ms ?? 0) > transcriptThroughMs) {
      transcriptThroughMs = page.partial_end_offset_ms ?? transcriptThroughMs;
      lastTranscriptProgressAt = Date.now();
    }
    const now = Date.now();
    if (now - lastHeartbeatAt >= 30_000) {
      if (requireRelay) {
        if (browserPublisher) {
          relayEvidence = await browserPublisher.relayEvidence();
        } else {
          const stats = (await room.getRtcStats()).publisherStats;
          const selected = stats.flatMap((item) =>
            item.stats.case === "transport" &&
            item.stats.value.transport?.selectedCandidatePairId
              ? [item.stats.value.transport.selectedCandidatePairId]
              : [],
          );
          if (selected.length === 0)
            throw new Error("TURN selected candidate evidence is missing");
          for (const id of selected) {
            const pair = stats.find(
              (item) =>
                item.stats.case === "candidatePair" &&
                item.stats.value.rtc?.id === id,
            )?.stats;
            if (pair?.case !== "candidatePair")
              throw new Error("TURN selected pair is missing");
            const local = stats.find(
              (item) =>
                item.stats.case === "localCandidate" &&
                item.stats.value.rtc?.id ===
                  pair.value.candidatePair?.localCandidateId,
            )?.stats;
            if (local?.case !== "localCandidate" || !local.value.candidate)
              throw new Error("TURN selected local candidate is missing");
            const data = local.value.candidate.toJson() as {
              candidateType?: string;
              relayProtocol?: string;
              address?: string;
            };
            if (
              data.candidateType !== "RELAY" ||
              data.relayProtocol !== "TRANSPORT_TLS" ||
              (process.env.VOICE_SOAK_TURN_PUBLIC_IP &&
                data.address !== process.env.VOICE_SOAK_TURN_PUBLIC_IP)
            )
              throw new Error("TURN path is not the required public TLS relay");
            relayEvidence = {
              relay_verified: true,
              relay_protocol: data.relayProtocol,
              relay_address: data.address || "",
            };
          }
        }
      }
      lastHeartbeatAt = now;
      console.log(
        JSON.stringify({
          status: "recording",
          capture_session_id: capture!.id,
          voice_session_id: session.id,
          elapsed_ms: now - startedAt,
          final_event_count: events.size,
          transcript_through_ms: transcriptThroughMs,
          transcript_idle_ms: now - lastTranscriptProgressAt,
          gap_count: current.gap_count,
          gap_duration_ms: current.gap_duration_ms,
          rss_bytes: process.memoryUsage().rss,
          driver: browserPublisher ? "browser" : "native",
          capture_start_latency_ms: captureStartLatencyMs,
          ...relayEvidence,
        }),
      );
    }
    if (
      minFinalEvents > 0 &&
      now - lastTranscriptProgressAt > progressStallMs
    ) {
      throw new Error(
        `transcript progress stalled for more than ${progressStallMs}ms`,
      );
    }
  };

  let sentSamples = 0;
  let playbackTiming: Awaited<ReturnType<typeof playObservedAudio>> | undefined;
  if (browserPublisher) {
    while (Date.now() - startedAt < durationMs) {
      playbackController.signal.throwIfAborted();
      await delay(Math.min(2_000, durationMs - (Date.now() - startedAt)));
      await observe(playbackController.signal);
    }
    sentSamples = await browserPublisher.stop();
  } else {
    playbackTiming = await playObservedAudio({
      frames: loopAudioFrames(pcm, durationMs),
      captureFrame: async (samples) => {
        const frame = AudioFrame.create(48_000, 1, samples.length);
        frame.data.set(samples);
        await source.captureFrame(frame);
        sentSamples += samples.length;
      },
      observe,
      signal: playbackController.signal,
    });
    // captureFrame acknowledges queueing, not delivery of the final samples.
    // Drain the native queue before Stop can seal the recording.
    await drainAudioSource(source, playbackController.signal);
  }
  if (
    sentSamples < durationMs * 48 ||
    Date.now() - startedAt < durationMs - 2_000
  )
    throw new Error("Requested audio duration was not sent in real time");
  await waitForSoakGate("stop", playbackController.signal);

  const stopStartedAt = Date.now();
  stage = "capture-stop";
  capture = await request<VoiceCapture>(
    `/v0/voice-captures/${encodeURIComponent(capture.id)}/stop`,
    { idempotent: true, method: "POST" },
  );
  stopped = true;
  console.log(
    JSON.stringify({
      status: "finalizing",
      capture_session_id: capture.id,
      voice_session_id: session.id,
      duration_ms: durationMs,
      recording_started_at: new Date(startedAt).toISOString(),
      recording_stopped_at: new Date(stopStartedAt).toISOString(),
      sent_samples: sentSamples,
      ...playbackTiming,
      expected_speech_marker_count: Math.floor(sentSamples / pcm.length),
      final_event_count: events.size,
      ...relayEvidence,
    }),
  );
  await browserPublisher?.close();
  await room.disconnect();
  await track.close();
  capture = await waitForTerminalCapture(capture.id, maxFinalizeMs);
  archivedThroughMs = capture.archived_through_ms ?? archivedThroughMs;
  const finalizeLatencyMs = Date.now() - stopStartedAt;
  if (finalizeLatencyMs > maxFinalizeMs) {
    throw new Error(
      `Capture finalization exceeded ${maxFinalizeMs}ms (${finalizeLatencyMs}ms)`,
    );
  }
  if (capture.status !== "finalized") {
    throw new Error(`Capture ended with ${capture.status}`);
  }
  if (capture.transcript_recovery_status)
    throw new Error(
      "Archive recovery cannot satisfy real-time soak acceptance",
    );
  if (events.size < minFinalEvents) {
    throw new Error(
      `final transcript event count ${events.size} is below ${minFinalEvents}`,
    );
  }
  if ((capture.gap_count ?? 0) > maxGapCount) {
    throw new Error(
      `Capture gap count ${capture.gap_count ?? 0} exceeds ${maxGapCount} (${capture.gap_duration_ms ?? 0}ms)`,
    );
  }
  await request<VoiceSession>(
    `/v0/voice-sessions/${encodeURIComponent(session.id)}`,
    { body: {}, idempotent: true, method: "DELETE" },
  );
  sessionClosed = true;

  stage = "artifact-verification";
  const artifacts = await verifyCaptureArtifacts({
    capture,
    baseUrl,
    cookie,
    runtimeRoot: fileURLToPath(
      new URL("../../../.linger-runtime/voice-acceptance", import.meta.url),
    ),
    requireSpeech: minFinalEvents > 0,
    requireTask: false,
    // Capture.created_at precedes provider activation; the Stop request offset is
    // compatibility-only. Validate the acknowledged interval as a lower bound
    // and let authoritative archived media define the final duration.
    expectedDurationMs: undefined,
    minimumDurationMs: durationMs - capture.gap_duration_ms,
    expectedSpeech: process.env.VOICE_SOAK_MARKER
      ? {
          marker: process.env.VOICE_SOAK_MARKER,
          repetitions: Math.floor(sentSamples / pcm.length),
        }
      : undefined,
  });
  console.log(
    JSON.stringify({
      archived_through_ms: archivedThroughMs,
      ...artifacts,
      ...relayEvidence,
      capture_session_id: capture.id,
      duration_ms: durationMs,
      recording_started_at: new Date(startedAt).toISOString(),
      recording_stopped_at: new Date(stopStartedAt).toISOString(),
      final_event_count: events.size,
      finalize_latency_ms: finalizeLatencyMs,
      capture_start_latency_ms: captureStartLatencyMs,
      gap_count: capture.gap_count ?? 0,
      gap_duration_ms: capture.gap_duration_ms ?? 0,
      status: capture.status,
      driver: browserPublisher ? "browser" : "native",
      ...playbackTiming,
      voice_session_id: session.id,
    }),
  );
} catch (error) {
  const detail = (error instanceof Error ? error.message : "unknown error")
    .replaceAll(credential.credential, "[redacted]")
    .replaceAll(cookie, "[redacted]")
    .replaceAll(password, "[redacted]")
    .replace(/(?:https?|wss?):\/\/\S+/g, "[endpoint]")
    .split("\n", 1)[0]!
    .slice(0, 300);
  console.log(JSON.stringify({ status: "diagnostic", stage, detail }));
  throw error;
} finally {
  if (!capture)
    capture =
      (await maybeRequest<VoiceCapture | null>(
        `/v0/rooms/${encodeURIComponent(roomId)}/active-voice-capture`,
      ).catch(() => undefined)) ?? undefined;
  if (capture && !stopped) {
    await request<VoiceCapture>(
      `/v0/voice-captures/${encodeURIComponent(capture.id)}/stop`,
      { idempotent: true, method: "POST" },
    ).catch(() => undefined);
  }
  await room.disconnect().catch(() => undefined);
  await browserPublisher?.close().catch(() => undefined);
  await track.close().catch(() => undefined);
  await source.close().catch(() => undefined);
  if (capture && !stopped)
    await waitForTerminalCapture(capture.id, maxFinalizeMs).catch(
      () => undefined,
    );
  if (!sessionClosed)
    await request<VoiceSession>(
      `/v0/voice-sessions/${encodeURIComponent(session.id)}`,
      { body: {}, idempotent: true, method: "DELETE" },
    ).catch(() => undefined);
}
process.exit(0);

async function waitForTerminalCapture(captureId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await request<VoiceCapture>(
      `/v0/voice-captures/${encodeURIComponent(captureId)}`,
    );
    if (current.status === "finalized" || current.status === "failed") {
      return current;
    }
    await delay(500);
  }
  throw new Error(`Capture did not finalize within ${timeoutMs}ms`);
}

function transcriptSignature(event: VoiceTranscriptEvent) {
  return createHash("sha256")
    .update(
      [
        String(event.media_epoch),
        event.lane,
        String(event.start_offset_ms),
        String(event.end_offset_ms),
        event.text,
      ].join("\0"),
    )
    .digest("hex");
}

function delay(duration: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, duration));
}

async function drainAudioSource(source: AudioSource, parent: AbortSignal) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(5_000)]);
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    await Promise.race([
      source.waitForPlayout(),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
