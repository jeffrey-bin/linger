import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { log } from "@livekit/agents";
import { AudioStream, type RemoteAudioTrack } from "@livekit/rtc-node";
import {
  type TeamHubVoiceRuntimeClient,
  TeamHubVoiceRuntimeError,
} from "@linger/wire-contracts/teamhub-internal/client";

// Recorded Capture media matches the archive the materializer expects:
// mono 48 kHz AAC in MPEG-TS HLS segments.
export const recordingSampleRate = 48_000;
const frameSamples = recordingSampleRate / 50;
const samplesPerMs = recordingSampleRate / 1_000;
// The recording follows wall-clock time like a room composite: an absent
// publisher becomes silence, and audio arriving far ahead of the clock is dropped.
const maximumLagMs = 200;
const maximumLeadMs = 500;
const pollIntervalMs = 500;
const uploadRetryDelaysMs = [250, 500, 1_000, 2_000, 4_000] as const;
const sealTimeoutMs = 30_000;
const maximumPendingSamples = recordingSampleRate * 5;

const prefixPattern = /^voice-staging\/[A-Za-z0-9_-]+\/epoch-[0-9]+$/;
const segmentPattern = /^epoch-[0-9]+_([0-9]{5,})\.ts$/;

export interface RecordingDirective {
  stagingPrefix: string;
  segmentSeconds: number;
}

/** Reads the epoch TeamHub asks this Room to record, if any. */
export function parseRecordingDirective(
  metadata: string | undefined,
): RecordingDirective | undefined {
  if (!metadata) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return undefined;
  }
  const recording = (parsed as { recording?: unknown })?.recording as
    | { staging_prefix?: unknown; segment_seconds?: unknown }
    | undefined;
  if (
    !recording ||
    typeof recording.staging_prefix !== "string" ||
    !prefixPattern.test(recording.staging_prefix)
  )
    return undefined;
  const seconds = Number(recording.segment_seconds);
  return {
    stagingPrefix: recording.staging_prefix,
    segmentSeconds:
      Number.isInteger(seconds) && seconds >= 1 && seconds <= 10 ? seconds : 2,
  };
}

/** Samples of silence needed to keep the recording within its wall-clock lag. */
export function silenceSamplesNeeded(written: number, elapsedMs: number) {
  const target = Math.floor(elapsedMs * samplesPerMs);
  if (target - written <= maximumLagMs * samplesPerMs) return 0;
  return target - written;
}

/** Whether a received frame still fits before the wall-clock lead limit. */
export function frameFitsClock(
  written: number,
  frame: number,
  elapsedMs: number,
) {
  return (
    written + frame <=
    Math.floor(elapsedMs * samplesPerMs) + maximumLeadMs * samplesPerMs
  );
}

/** Complete segment files from the next expected index, contiguous only. */
export function uploadableSegments(files: string[], nextIndex: number) {
  const indexed = files
    .map((name) => ({ name, match: segmentPattern.exec(name) }))
    .filter((item) => item.match)
    .map((item) => ({ name: item.name, index: Number(item.match![1]) }))
    .filter((item) => item.index >= nextIndex)
    .sort((left, right) => left.index - right.index);
  const contiguous: Array<{ name: string; index: number }> = [];
  for (const item of indexed) {
    if (item.index !== nextIndex + contiguous.length) break;
    contiguous.push(item);
  }
  return contiguous;
}

/** Archived duration named by an HLS playlist. */
export function playlistDurationMs(playlist: string) {
  let total = 0;
  for (const line of playlist.split("\n")) {
    const match = /^#EXTINF:([0-9.]+)/.exec(line.trim());
    if (match) total += Number(match[1]) * 1_000;
  }
  return Math.round(total);
}

interface RecorderDependencies {
  client: TeamHubVoiceRuntimeClient;
  ffmpegPath?: string;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

class RecordingClosedError extends Error {
  constructor(readonly code: string) {
    super(`Voice recording closed: ${code}`);
    this.name = "RecordingClosedError";
  }
}

/** One recorder run of one Capture epoch. */
class EpochRecording {
  private ffmpeg?: ChildProcessWithoutNullStreams;
  private directory = "";
  private startedAtMs = 0;
  private written = 0;
  private pendingSamples = 0;
  private nextIndex = 0;
  private reportedActive = false;
  private pacer?: NodeJS.Timeout;
  private poller?: Promise<void>;
  private stopping = false;
  private failure?: string;
  private writeTail: Promise<void> = Promise.resolve();
  private reader?: ReadableStreamDefaultReader<{
    data: Int16Array;
    samplesPerChannel: number;
  }>;
  private readonly base: string;
  private readonly keyRoot: string;

  constructor(
    private readonly directive: RecordingDirective,
    private readonly deps: Required<RecorderDependencies>,
  ) {
    const slash = directive.stagingPrefix.lastIndexOf("/");
    this.keyRoot = directive.stagingPrefix.slice(0, slash);
    this.base = directive.stagingPrefix.slice(slash + 1);
  }

  get stagingPrefix() {
    return this.directive.stagingPrefix;
  }

  async start(track: RemoteAudioTrack | undefined) {
    this.directory = await mkdtemp(join(tmpdir(), "voice-recording-"));
    this.ffmpeg = spawn(
      this.deps.ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        String(recordingSampleRate),
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-f",
        "hls",
        "-hls_time",
        String(this.directive.segmentSeconds),
        "-hls_list_size",
        "0",
        "-hls_playlist_type",
        "event",
        "-hls_segment_type",
        "mpegts",
        "-hls_flags",
        "temp_file",
        "-hls_segment_filename",
        join(this.directory, `${this.base}_%05d.ts`),
        join(this.directory, `${this.base}.m3u8`),
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    ) as unknown as ChildProcessWithoutNullStreams;
    this.ffmpeg.stdin.on("error", () => undefined);
    this.ffmpeg.on("error", () => {
      this.failure ??= "recorder_encoder";
    });
    this.ffmpeg.on("exit", (code) => {
      if (code !== 0) this.failure ??= "recorder_encoder";
    });
    this.startedAtMs = this.deps.now();
    this.useTrack(track);
    this.pacer = setInterval(() => this.padSilence(), 20);
    this.poller = this.poll();
  }

  useTrack(track: RemoteAudioTrack | undefined) {
    void this.reader?.cancel().catch(() => undefined);
    this.reader = undefined;
    if (!track) return;
    const reader = new AudioStream(track, {
      sampleRate: recordingSampleRate,
      numChannels: 1,
      frameSizeMs: 20,
    }).getReader();
    this.reader = reader;
    void (async () => {
      for (;;) {
        const result = await reader.read().catch(() => undefined);
        if (!result || result.done || this.reader !== reader || this.stopping)
          return;
        const frame = result.value;
        if (
          frameFitsClock(
            this.written,
            frame.samplesPerChannel,
            this.deps.now() - this.startedAtMs,
          )
        )
          this.write(frame.data.subarray(0, frame.samplesPerChannel));
      }
    })();
  }

  private padSilence() {
    if (this.stopping) return;
    let missing = silenceSamplesNeeded(
      this.written,
      this.deps.now() - this.startedAtMs,
    );
    while (missing > 0 && !this.failure) {
      const chunk = Math.min(missing, frameSamples);
      this.write(new Int16Array(chunk));
      missing -= chunk;
    }
  }

  private write(samples: Int16Array) {
    if (this.failure || this.stopping) return;
    if (this.pendingSamples + samples.length > maximumPendingSamples) {
      this.failure = "recorder_encoder";
      return;
    }
    this.written += samples.length;
    this.pendingSamples += samples.length;
    const stdin = this.ffmpeg?.stdin;
    if (!stdin || stdin.writableEnded) {
      this.pendingSamples -= samples.length;
      this.failure = "recorder_encoder";
      return;
    }
    const bytes = Buffer.from(
      samples.buffer,
      samples.byteOffset,
      samples.byteLength,
    );
    this.writeTail = this.writeTail
      .then(
        () =>
          new Promise<void>((resolve) => {
            if (stdin.destroyed || stdin.writableEnded) {
              this.failure ??= "recorder_encoder";
              resolve();
              return;
            }
            // A failed pipe never emits drain; the write callback reports both outcomes.
            stdin.write(bytes, (error) => {
              if (error) this.failure ??= "recorder_encoder";
              resolve();
            });
          }),
      )
      .catch(() => {
        this.failure ??= "recorder_encoder";
      })
      .finally(() => {
        this.pendingSamples -= samples.length;
      });
  }

  private async poll() {
    while (!this.stopping && !this.failure) {
      await this.deps.wait(pollIntervalMs);
      try {
        await this.uploadReady(false);
      } catch (error) {
        this.failure ??=
          error instanceof RecordingClosedError
            ? error.code
            : "recorder_upload";
      }
    }
  }

  /** Uploads complete segments in order, then the playlist naming them. */
  private async uploadReady(final: boolean) {
    // Snapshot before uploading: ffmpeg can advance the playlist during a put.
    const playlist = await readFile(
      join(this.directory, `${this.base}.m3u8`),
      "utf8",
    ).catch(() => undefined);
    if (!playlist) return;
    const ready = uploadableSegments(
      await readdir(this.directory),
      this.nextIndex,
    );
    for (const segment of ready) {
      await this.put(
        `${this.keyRoot}/${segment.name}`,
        await readFile(join(this.directory, segment.name)),
      );
      await rm(join(this.directory, segment.name), { force: true });
      this.nextIndex = segment.index + 1;
    }
    if (ready.length === 0 && !final) return;
    if (this.nextIndex === 0) return;
    if (final && !playlist.includes("#EXT-X-ENDLIST"))
      throw new RecordingClosedError("recorder_unsealed");
    await this.put(
      `${this.directive.stagingPrefix}.m3u8`,
      new TextEncoder().encode(playlist),
    );
    const archivedThroughMs = playlistDurationMs(playlist);
    if (!final) {
      await this.report("active", archivedThroughMs);
      this.reportedActive = true;
    }
    return archivedThroughMs;
  }

  private async put(key: string, bytes: Uint8Array) {
    await this.callTeamHub(() => this.deps.client.putMediaObject(key, bytes));
  }

  private async report(
    state: "active" | "available" | "failed",
    archivedThroughMs: number,
    failureCode?: string,
  ) {
    await this.callTeamHub(() =>
      this.deps.client.reportRecording({
        staging_prefix: this.directive.stagingPrefix,
        state,
        archived_through_ms: archivedThroughMs,
        ...(state === "failed" && !this.reportedActive
          ? {}
          : { started_at: new Date(this.startedAtMs).toISOString() }),
        ...(failureCode ? { failure_code: failureCode } : {}),
      }),
    );
  }

  private async callTeamHub(call: () => Promise<void>) {
    for (let attempt = 0; ; attempt++) {
      try {
        await call();
        return;
      } catch (error) {
        // TeamHub refuses a segment another recorder already stored, or an
        // epoch that stopped recording: this run cannot extend it.
        if (error instanceof TeamHubVoiceRuntimeError) {
          if (error.status === 409)
            throw new RecordingClosedError("recorder_conflict");
          if (error.status === 404 || error.status === 400)
            throw new RecordingClosedError("recorder_rejected");
        }
        const wait = uploadRetryDelaysMs[attempt];
        if (wait === undefined) throw error;
        await this.deps.wait(wait);
      }
    }
  }

  private async stopEncoder() {
    this.stopping = true;
    clearInterval(this.pacer);
    void this.reader?.cancel().catch(() => undefined);
    const ffmpeg = this.ffmpeg;
    // Include blocked writes in the deadline, not just ffmpeg's final flush.
    const timer = setTimeout(() => {
      this.failure ??= "recorder_encoder";
      ffmpeg?.kill("SIGKILL");
    }, sealTimeoutMs);
    if (this.failure) ffmpeg?.kill("SIGKILL");
    try {
      await this.writeTail;
      if (
        ffmpeg?.pid &&
        ffmpeg.exitCode === null &&
        ffmpeg.signalCode === null
      ) {
        await new Promise<void>((resolve) => {
          ffmpeg.once("exit", () => resolve());
          ffmpeg.stdin.end();
        });
      }
    } finally {
      clearTimeout(timer);
    }
    await this.poller;
  }

  /** Stops on TeamHub's request: seals the playlist and reports available. */
  async seal() {
    await this.stopEncoder();
    try {
      if (this.failure) throw new RecordingClosedError(this.failure);
      const archivedThroughMs = await this.uploadReady(true);
      if (archivedThroughMs === undefined)
        throw new RecordingClosedError("recorder_empty");
      await this.report("available", archivedThroughMs);
    } catch (error) {
      await this.reportFailure(error);
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  /**
   * Ends a recording this process can no longer extend, including shutdown.
   * Complete segments still upload so TeamHub can salvage the prefix.
   */
  async abandon(code: string) {
    await this.stopEncoder();
    try {
      if (!this.failure) await this.uploadReady(false).catch(() => undefined);
      await this.reportFailure(new RecordingClosedError(this.failure ?? code));
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  private async reportFailure(error: unknown) {
    const code =
      error instanceof RecordingClosedError ? error.code : "recorder_failed";
    log().warn(
      { failureCode: code, stagingPrefix: this.directive.stagingPrefix },
      "Voice recording ended without a sealed playlist",
    );
    await this.report("failed", 0, code).catch(() => undefined);
  }

  get failed() {
    return this.failure;
  }
}

/**
 * Records the Capture epoch named in the Room metadata from the current
 * publisher microphone track. Transitions run one at a time.
 */
export class CaptureRecorder {
  private readonly deps: Required<RecorderDependencies>;
  private recording?: EpochRecording;
  private track?: RemoteAudioTrack;
  private directive?: RecordingDirective;
  private transitions: Promise<void> = Promise.resolve();
  private closed = false;
  private watchdog?: NodeJS.Timeout;

  constructor(deps: RecorderDependencies) {
    this.deps = {
      ffmpegPath: "ffmpeg",
      now: Date.now,
      wait: delay,
      ...deps,
    };
    // A recording whose upload or encoder failed is abandoned promptly, so
    // TeamHub can open a recovery epoch without waiting for its stall timeout.
    this.watchdog = setInterval(() => {
      const failure = this.recording?.failed;
      if (failure) this.enqueue(() => this.abandonCurrent(failure));
    }, pollIntervalMs);
  }

  setTrack(track: RemoteAudioTrack | undefined) {
    this.track = track;
    this.enqueue(async () => this.recording?.useTrack(track));
  }

  followMetadata(metadata: string | undefined) {
    this.directive = parseRecordingDirective(metadata);
    this.enqueue(() => this.reconcile());
  }

  /** Shutdown hands the epoch over: TeamHub recovers it in a new epoch. */
  async close() {
    this.closed = true;
    clearInterval(this.watchdog);
    this.enqueue(() => this.abandonCurrent("recorder_handover"));
    await this.transitions;
  }

  private enqueue(transition: () => Promise<void>) {
    this.transitions = this.transitions.then(transition).catch((error) => {
      log().warn(
        { errorClass: error instanceof Error ? error.name : "Error" },
        "Voice recording transition failed",
      );
    });
  }

  private async reconcile() {
    if (this.closed) return;
    const wanted = this.directive?.stagingPrefix;
    if (this.recording && this.recording.stagingPrefix !== wanted) {
      const finished = this.recording;
      this.recording = undefined;
      await finished.seal();
    }
    if (!this.directive || this.recording) return;
    const recording = new EpochRecording(this.directive, this.deps);
    this.recording = recording;
    await recording.start(this.track);
  }

  private async abandonCurrent(code: string) {
    const recording = this.recording;
    if (!recording) return;
    this.recording = undefined;
    await recording.abandon(code);
  }
}
