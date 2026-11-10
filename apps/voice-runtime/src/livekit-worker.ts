import { createHash } from "node:crypto";

import type { JobContext } from "@livekit/agents";
import { AutoSubscribe, log } from "@livekit/agents";
import {
  AudioStream,
  type AudioFrame,
  RemoteAudioTrack,
  RoomEvent,
  TrackSource,
  type RemoteParticipant,
} from "@livekit/rtc-node";
import {
  TeamHubVoiceRuntimeClient,
  TeamHubVoiceRuntimeError,
  type VoiceObservation,
} from "@linger/wire-contracts/teamhub-internal/client";
import type { components as PublicComponents } from "@linger/wire-contracts/teamhub-public/types";

import type { ASRProvider, ASRStream } from "./asr.js";
import { DictationASRStream } from "./dictation-asr.js";
import { asError } from "@linger/service-kit";
import { VoiceFailure } from "./voice-failure.js";

const asrFlushTimeoutMs = 5_000;
const teamHubCallbackBudgetMs = 8_000;
export const teamHubCallbackRetryDelaysMs = [
  100, 250, 500, 1_000, 2_000, 4_000,
] as const;
const trackConsumerRetryDelaysMs = [
  250, 500, 1_000, 2_000, 4_000, 8_000,
] as const;
// Frames wait here while an ASR connection is (re)built; the Capture recorder
// keeps archiving meanwhile, so dropping them would open an input hole in the
// live transcript.
const maximumBufferedInputSeconds = 20;
const publisherAbsenceToleranceMs = 250;
const firstFrameWaitMs = 500;
export const dictationCommitTopic = "linger.voice.dictation.commit";
const maximumDictationCommitRequests = 1_024;

interface CurrentVoiceTrack {
  track: RemoteAudioTrack;
  controller: AbortController;
  input: TrackAudioInput;
  dictation?: DictationASRStream;
  commits: Array<{ requestId: string; throughSample: number }>;
  failure?: Error;
  started?: boolean;
  confirmedThroughMs?: number;
  retryFromMs?: number;
}

export class VoiceTrackWorker {
  private nextEpoch = 0;
  private readonly active = new Set<Promise<void>>();
  private readonly shutdownController = new AbortController();
  private sessionCreatedAtMs = 0;
  private currentTrack?: CurrentVoiceTrack;
  private trackTail: Promise<void> = Promise.resolve();
  private shutdownFailed = false;
  private lastPublisher?: { generation: number; inputEndedMs?: number };
  private dictation = false;
  private poisonedGeneration = -1;
  private readonly dictationCommitIds = new Set<string>();

  constructor(
    private readonly client: TeamHubVoiceRuntimeClient,
    private readonly asr: ASRProvider,
    private readonly onUnconfirmedShutdown: () => never = () => {
      throw new Error("Voice Runtime shutdown has unconfirmed transcript");
    },
  ) {}

  async run(ctx: JobContext): Promise<void> {
    const roomName = ctx.job.room?.name;
    if (!roomName) throw new Error("Voice Runtime job is missing a Room name");
    const voiceSessionId = voiceSessionFromRoom(roomName);
    this.sessionCreatedAtMs = voiceSessionCreatedAtFromMetadata(
      ctx.job.metadata,
    );
    this.dictation =
      voicePurposeFromMetadata(ctx.job.metadata) === "chat_dictation";
    if (this.dictation)
      ctx.room.on(
        RoomEvent.DataReceived,
        (payload, participant, _kind, topic) => {
          const requestId = serverDictationCommitRequest(
            payload,
            participant,
            topic,
          );
          const current = this.currentTrack;
          if (
            !requestId ||
            !current ||
            current.controller.signal.aborted ||
            this.shutdownController.signal.aborted ||
            this.dictationCommitIds.has(requestId)
          )
            return;
          if (this.dictationCommitIds.size >= maximumDictationCommitRequests) {
            current.failure = new VoiceFailure(
              "dictation_commit_limit",
              "Dictation commit request limit exceeded",
            );
            current.controller.abort();
            return;
          }
          this.dictationCommitIds.add(requestId);
          // Include audio already received, even when it is waiting behind the
          // previous turn's ASR flush. A retry of this request never cuts later audio.
          current.commits.push({
            requestId,
            throughSample: current.input.receivedSamples,
          });
          void this.drainDictationCommits(current).catch(() =>
            current.controller.abort(),
          );
        },
      );
    ctx.room.on(
      RoomEvent.TrackSubscribed,
      (track, publication, participant) => {
        if (
          !(track instanceof RemoteAudioTrack) ||
          participant.identity !== `publisher-${voiceSessionId}` ||
          publication.source !== TrackSource.SOURCE_MICROPHONE ||
          this.shutdownController.signal.aborted ||
          this.currentTrack?.track === track
        )
          return;
        const generation = Number(
          participant.attributes?.["linger.voice_generation"] ?? 0,
        );
        if (this.dictation && generation <= this.poisonedGeneration) return;
        this.currentTrack?.controller.abort();
        const controller = new AbortController();
        // Subscribe to audio immediately. The consumer may still be waiting for
        // the previous track to drain or for its ASR connection; those frames
        // are retained here instead of being lost before the stream exists.
        const input = new TrackAudioInput(track);
        const current: CurrentVoiceTrack = {
          track,
          controller,
          input,
          commits: [],
        };
        this.currentTrack = current;
        const consume = () =>
          this.consume(
            ctx,
            voiceSessionId,
            this.nextEpoch++,
            track,
            input,
            participant,
            controller.signal,
            current,
          );
        const task = this.trackTail
          .then(() =>
            this.dictation
              ? consume()
              : retryVoiceTrackConsumer({
                  consume,
                  isStopped: () => controller.signal.aborted,
                  onFailure: (error, retryInMs) => {
                    log().warn(
                      {
                        errorClass:
                          error instanceof Error ? error.name : "Error",
                        failureCode: voiceTrackFailureCode(error),
                        retryInMs,
                        voiceSessionId,
                      },
                      retryInMs === 0
                        ? "Voice Runtime track flush failed"
                        : "Voice Runtime track consumer failed; retrying",
                    );
                  },
                  retryDelaysMs: trackConsumerRetryDelaysMs,
                  wait: (delayMs) =>
                    waitForAbortableDelay(delayMs, controller.signal),
                }),
          )
          .catch(async (error: unknown) => {
            this.shutdownFailed = true;
            if (this.dictation) {
              this.poisonedGeneration = Math.max(
                this.poisonedGeneration,
                generation,
              );
              controller.abort();
              await withTimeout(
                ctx.room.localParticipant?.setAttributes({
                  "linger.voice_dictation_failure": "transcript_unconfirmed",
                  "linger.voice_dictation_failure_generation":
                    String(generation),
                }) ?? Promise.resolve(),
                1_000,
                "Voice dictation failure report timed out",
              ).catch(() => undefined);
            }
            log().error(
              {
                errorClass: error instanceof Error ? error.name : "Error",
                failureCode: voiceTrackFailureCode(error),
                voiceSessionId,
              },
              "Voice Runtime track consumer failed",
            );
          })
          .finally(async () => {
            this.active.delete(task);
            await input.release();
          });
        this.active.add(task);
        this.trackTail = task;
      },
    );
    ctx.room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (this.currentTrack?.track === track) {
        this.currentTrack.controller.abort();
        this.currentTrack = undefined;
      }
    });
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    let lastPublisherAt = Date.now();
    const idleTimer = setInterval(() => {
      if (
        [...ctx.room.remoteParticipants.values()].some(
          (participant) =>
            participant.identity === `publisher-${voiceSessionId}`,
        )
      ) {
        lastPublisherAt = Date.now();
      } else if (Date.now() - lastPublisherAt >= 60_000) {
        clearInterval(idleTimer);
        ctx.shutdown("voice publisher absent");
      }
    }, 1_000);
    ctx.addShutdownCallback(async () => {
      clearInterval(idleTimer);
      this.shutdownController.abort();
      this.currentTrack?.controller.abort();
      try {
        await withTimeout(
          Promise.all(this.active),
          65_000,
          "Voice Runtime shutdown flush timed out",
        );
      } catch {
        this.shutdownFailed = true;
      }
      if (this.shutdownFailed) {
        log().error(
          { failureCode: "transcript_unconfirmed" },
          "Voice Runtime shutdown could not confirm transcript",
        );
        this.onUnconfirmedShutdown();
      }
    });
  }

  private async drainDictationCommits(current: CurrentVoiceTrack) {
    const stream = current.dictation;
    if (!stream) return;
    const pending: Promise<void>[] = [];
    while (
      current.commits[0] &&
      current.commits[0].throughSample <= stream.processedSamples
    ) {
      pending.push(stream.commit(current.commits.shift()!.requestId));
    }
    await Promise.all(pending);
  }

  private async consume(
    ctx: JobContext,
    voiceSessionId: string,
    epoch: number,
    track: RemoteAudioTrack,
    input: TrackAudioInput,
    participant: RemoteParticipant,
    inputSignal: AbortSignal,
    current: CurrentVoiceTrack,
  ) {
    const controller = new AbortController();
    let asr: ASRStream | undefined;
    let audioTask: Promise<number> | undefined;
    let eventTask: Promise<void> | undefined;
    let readinessTimer: ReturnType<typeof setInterval> | undefined;
    let readinessUpdate: Promise<void> | undefined;
    const publisherGeneration = Number(
      participant.attributes?.["linger.voice_generation"] ?? 0,
    );
    if (!Number.isSafeInteger(publisherGeneration) || publisherGeneration < 0)
      throw new Error("Voice publisher generation is invalid");
    const epochStartMs = await this.startEpoch(
      voiceSessionId,
      epoch,
      input,
      inputSignal,
      current,
      publisherGeneration,
    );
    try {
      const opened = await withTimeout<ASRStream>(
        this.dictation
          ? DictationASRStream.open(this.asr, controller.signal)
          : this.asr.open(controller.signal),
        5_000,
        "ASR connection timed out",
        "asr_connect_timeout",
      );
      asr = opened;
      if (asr instanceof DictationASRStream) current.dictation = asr;
      if (publisherGeneration > 0) {
        const renewReadiness = this.readinessRenewal(
          ctx,
          track,
          publisherGeneration,
        );
        await withTimeout(
          renewReadiness(true),
          5_000,
          "Voice input readiness timed out",
        );
        readinessTimer = setInterval(() => {
          if (controller.signal.aborted || readinessUpdate) return;
          readinessUpdate = withTimeout(
            renewReadiness(),
            1_000,
            "Voice input readiness refresh timed out",
          )
            .catch(() => {
              log().warn(
                { voiceSessionId, failureCode: "readiness_refresh_failed" },
                "Voice Runtime readiness refresh failed",
              );
            })
            .finally(() => {
              readinessUpdate = undefined;
            });
        }, 2_000);
      }
      eventTask = this.forwardEvents(
        voiceSessionId,
        epoch,
        epochStartMs,
        opened,
        controller.signal,
        current,
      );
      audioTask = forwardAudioFrames(
        input,
        opened,
        inputSignal,
        controller.signal,
        this.dictation ? () => this.drainDictationCommits(current) : undefined,
      );
      const offsetMs = await waitForAudioCompletionOrEventFailure(
        audioTask,
        eventTask,
      );
      if (current.failure) throw current.failure;
      await waitForASRFlush(
        opened,
        eventTask,
        this.dictation ? 20_000 : asrFlushTimeoutMs,
        30_000,
      );
      await this.reportTrackEnded(
        voiceSessionId,
        epoch,
        epochStartMs,
        offsetMs,
        publisherGeneration,
      );
    } catch (error) {
      // The outer retry cannot replay this attempt's unconfirmed PCM. Keep
      // that exact uncertainty separate from the physical track lifecycle.
      current.retryFromMs = current.confirmedThroughMs ?? epochStartMs;
      throw error;
    } finally {
      current.dictation = undefined;
      controller.abort();
      clearInterval(readinessTimer);
      await readinessUpdate;
      await this.releaseConsumer(
        ctx,
        publisherGeneration,
        asr,
        audioTask,
        eventTask,
      );
    }
  }

  /**
   * Anchors this consumer's media epoch on the retained audio and reports
   * the track start, a publisher absence, and an input gap it follows.
   * Returns the epoch start as a session offset.
   */
  private async startEpoch(
    voiceSessionId: string,
    epoch: number,
    input: TrackAudioInput,
    inputSignal: AbortSignal,
    current: CurrentVoiceTrack,
    publisherGeneration: number,
  ): Promise<number> {
    // A subscription usually precedes its first RTP frame by a few hundred
    // milliseconds. Wait briefly so the clocks below anchor on real audio.
    await input.waitForFirstFrame(firstFrameWaitMs, inputSignal);
    // The epoch clock starts when the oldest retained frame arrived, so audio
    // buffered while a previous consumer drained or this ASR connection opened
    // keeps its wall-clock position instead of shifting later. Drops before
    // this instant are already behind the clock; any later drop must fail the
    // consumer, so the counter is taken in the same synchronous tick.
    const now = Date.now();
    const sessionOffset = (at: number) =>
      Math.max(0, Math.round(at - this.sessionCreatedAtMs));
    const epochStartMs = sessionOffset(input.oldestRetainedAtMs() ?? now);
    const droppedSamples = input.takeDroppedSamples();
    if (droppedSamples > 0 && this.dictation)
      throw new VoiceFailure(
        "dictation_audio_backlog",
        "Dictation audio backlog exceeded",
      );
    // Absence ends when the publisher's first frame reached this runtime,
    // even if the bounded queue has since dropped it. Dropped audio is an
    // input hole for integrity recovery, never a publisher_absent gap.
    const absence =
      !current.started &&
      publisherAbsence(
        this.lastPublisher,
        publisherGeneration,
        sessionOffset(input.firstFrameAtMs() ?? now),
      );
    if (absence) {
      // A new browser publisher generation after a cleanly ended input proves
      // that no microphone was publishing in between. the recorder kept archiving
      // silence there, so TeamHub must record the interval as a capture gap.
      await this.report({
        eventId: eventId(
          voiceSessionId,
          epoch,
          "publisher_absent",
          absence.startOffsetMs,
          absence.endOffsetMs,
        ),
        voiceSessionId,
        mediaEpoch: epoch,
        lane: "live",
        kind: "publisher_absent",
        ...absence,
      });
    }
    if (!current.started)
      await this.report({
        eventId: eventId(
          voiceSessionId,
          epoch,
          "track_started",
          epochStartMs,
          epochStartMs,
        ),
        voiceSessionId,
        mediaEpoch: epoch,
        lane: "live",
        kind: "track_started",
        startOffsetMs: epochStartMs,
        endOffsetMs: epochStartMs,
      });
    current.started = true;
    this.lastPublisher = { generation: publisherGeneration };
    const uncertainFrom =
      current.retryFromMs ??
      (droppedSamples > 0
        ? sessionOffset(input.firstFrameAtMs() ?? now)
        : epochStartMs);
    if (!this.dictation && uncertainFrom < epochStartMs) {
      await this.report({
        eventId: eventId(
          voiceSessionId,
          epoch,
          "input_gap",
          uncertainFrom,
          epochStartMs,
        ),
        voiceSessionId,
        mediaEpoch: epoch,
        lane: "live",
        kind: "input_gap",
        startOffsetMs: uncertainFrom,
        endOffsetMs: epochStartMs,
      });
    }
    current.retryFromMs = undefined;
    current.confirmedThroughMs = epochStartMs;
    return epochStartMs;
  }

  /** Publishes that this runtime is ready for the publisher's generation. */
  private readinessRenewal(
    ctx: JobContext,
    track: RemoteAudioTrack,
    publisherGeneration: number,
  ): (resetDictation?: boolean) => Promise<void> {
    const local = ctx.room.localParticipant;
    if (!local) throw new Error("Voice Runtime participant is unavailable");
    if (!track.sid) throw new Error("Voice publisher track is unavailable");
    const trackSid = track.sid;
    return (resetDictation = false) =>
      local.setAttributes({
        "linger.voice_ready_generation": String(publisherGeneration),
        "linger.voice_ready_track": trackSid,
        "linger.voice_ready_at": String(Date.now()),
        "linger.voice_purpose": this.dictation
          ? "chat_dictation"
          : "hardware_control",
        ...(this.dictation && resetDictation
          ? {
              "linger.voice_dictation_failure": "",
              "linger.voice_dictation_failure_generation": "",
            }
          : {}),
      });
  }

  private async reportTrackEnded(
    voiceSessionId: string,
    epoch: number,
    epochStartMs: number,
    offsetMs: number,
    publisherGeneration: number,
  ) {
    await this.report({
      eventId: eventId(
        voiceSessionId,
        epoch,
        "track_ended",
        epochStartMs + offsetMs,
        epochStartMs + offsetMs,
      ),
      voiceSessionId,
      mediaEpoch: epoch,
      lane: "live",
      kind: "track_ended",
      startOffsetMs: epochStartMs,
      endOffsetMs: epochStartMs + offsetMs,
    });
    this.lastPublisher = {
      generation: publisherGeneration,
      inputEndedMs: epochStartMs + offsetMs,
    };
  }

  /** Withdraws readiness, closes the ASR stream and briefly drains its tasks. */
  private async releaseConsumer(
    ctx: JobContext,
    publisherGeneration: number,
    asr: ASRStream | undefined,
    audioTask: Promise<number> | undefined,
    eventTask: Promise<void> | undefined,
  ) {
    if (publisherGeneration > 0 && ctx.room.localParticipant) {
      await withTimeout(
        ctx.room.localParticipant.setAttributes({
          "linger.voice_ready_generation": "0",
          "linger.voice_ready_track": "",
          "linger.voice_ready_at": "0",
        }),
        1_000,
        "Voice input readiness reset timed out",
      ).catch(() => undefined);
    }
    await asr?.close().catch(() => undefined);
    await Promise.race([
      audioTask?.catch(() => undefined) ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    await Promise.race([
      eventTask?.catch(() => undefined) ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  private async forwardEvents(
    voiceSessionId: string,
    epoch: number,
    epochStartMs: number,
    stream: ASRStream,
    signal: AbortSignal,
    current?: CurrentVoiceTrack,
  ) {
    let reportedThroughMs = -500;
    for await (const event of stream.events()) {
      if (signal.aborted) return;
      if (event.kind === "utterance_end" || event.kind === "finalization_ack")
        throw new Error("ASR utterance endpoint escaped dictation boundary");
      if (event.kind === "progress" && event.committedThroughMs === undefined) {
        continue;
      }
      if (
        event.kind === "progress" &&
        event.committedThroughMs !== undefined &&
        event.committedThroughMs - reportedThroughMs < 500
      ) {
        continue;
      }
      if (event.kind === "progress" && event.committedThroughMs !== undefined) {
        reportedThroughMs = event.committedThroughMs;
      }
      // Provider rotations stay within this media epoch. Coverage has one
      // fixed origin per epoch; only transcript windows move with rotations.
      const startOffsetMs =
        event.kind === "progress"
          ? epochStartMs
          : epochStartMs + event.startOffsetMs;
      await this.report({
        eventId: eventId(
          voiceSessionId,
          epoch,
          event.kind,
          startOffsetMs,
          epochStartMs + event.endOffsetMs,
          event.text,
          event.committedThroughMs,
        ),
        voiceSessionId,
        mediaEpoch: epoch,
        lane: "live",
        kind: event.kind,
        startOffsetMs,
        endOffsetMs: epochStartMs + event.endOffsetMs,
        committedThroughMs:
          event.committedThroughMs === undefined
            ? undefined
            : epochStartMs + event.committedThroughMs,
        text: event.text,
        speakerId: event.speakerId,
      });
      if (current && event.committedThroughMs !== undefined)
        current.confirmedThroughMs = epochStartMs + event.committedThroughMs;
    }
  }

  private async report(input: {
    eventId: string;
    voiceSessionId: string;
    mediaEpoch: number;
    lane: "live" | "recovery";
    kind: VoiceObservation["kind"];
    startOffsetMs: number;
    endOffsetMs: number;
    committedThroughMs?: number;
    text?: string;
    speakerId?: string;
  }) {
    const observation: VoiceObservation = {
      event_id: input.eventId,
      voice_session_id: input.voiceSessionId,
      media_epoch: input.mediaEpoch,
      lane: input.lane,
      kind: input.kind,
      start_offset_ms: input.startOffsetMs,
      end_offset_ms: input.endOffsetMs,
    };
    if (input.committedThroughMs !== undefined) {
      observation.committed_through_ms = input.committedThroughMs;
    }
    if (input.text !== undefined) observation.text = input.text;
    if (input.speakerId) observation.speaker_id = input.speakerId;
    await reportVoiceObservationWithRetry(this.client, observation);
  }
}

// One subscribed track owns one input for its whole lifetime. Consumers attach
// and detach across ASR rebuilds; frames that no consumer has sent yet stay
// queued so a rebuild resumes from the exact sample where the last one stopped.
export class TrackAudioInput {
  private readonly reader: ReadableStreamDefaultReader<AudioFrame>;
  private readonly reading: Promise<void>;
  private frames: Array<{ frame: AudioFrame; arrivedAtMs: number }> = [];
  private queuedSamples = 0;
  private droppedSamples = 0;
  private receivedSampleCount = 0;
  private firstArrivalMs?: number;
  private ended = false;
  private error?: unknown;
  private waiters: Array<() => void> = [];
  private readonly maximumBufferedSamples: number;

  constructor(
    private readonly track: RemoteAudioTrack,
    sampleRate = 16_000,
  ) {
    this.maximumBufferedSamples = sampleRate * maximumBufferedInputSeconds;
    this.reader = new AudioStream(track, {
      sampleRate,
      numChannels: 1,
      frameSizeMs: 20,
    }).getReader();
    this.reading = this.read();
  }

  private async read() {
    try {
      for (;;) {
        const result = await this.reader.read();
        if (result.done) break;
        const arrivedAtMs = Date.now();
        this.firstArrivalMs ??= arrivedAtMs;
        this.frames.push({ frame: result.value, arrivedAtMs });
        this.receivedSampleCount += result.value.data.length;
        this.queuedSamples += result.value.data.length;
        // Keep only the newest bounded window; the consumer reports the loss.
        while (this.queuedSamples > this.maximumBufferedSamples) {
          const oldest = this.frames.shift()!;
          this.queuedSamples -= oldest.frame.data.length;
          this.droppedSamples += oldest.frame.data.length;
        }
        this.wake();
      }
    } catch (error) {
      this.error ??= error;
    } finally {
      this.ended = true;
      this.wake();
    }
  }

  private wake() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  get receivedSamples() {
    return this.receivedSampleCount;
  }

  // Wall-clock arrival of the first frame ever received on this track.
  firstFrameAtMs() {
    return this.firstArrivalMs;
  }

  // Wall-clock arrival of the oldest frame still waiting for a consumer.
  oldestRetainedAtMs() {
    return this.frames[0]?.arrivedAtMs;
  }

  // Resolves once any frame has arrived, the source ended, the signal aborted,
  // or the bounded wait elapsed. A silent or slow track never blocks a consumer.
  async waitForFirstFrame(timeoutMs: number, signal: AbortSignal) {
    if (this.firstArrivalMs !== undefined || this.ended || signal.aborted)
      return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.push(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  // Resolves with the next frame, or undefined once the source closed and
  // every retained frame was taken. Rejects with the source failure.
  async next(signal: AbortSignal): Promise<AudioFrame | undefined> {
    for (;;) {
      if (this.error) throw asError(this.error);
      // An aborted consumer must not take a frame it will never send.
      if (signal.aborted) return undefined;
      const queued = this.frames.shift();
      if (queued) {
        this.queuedSamples -= queued.frame.data.length;
        return queued.frame;
      }
      if (this.ended) return undefined;
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          resolve();
        };
        this.waiters.push(done);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  takeDroppedSamples() {
    const dropped = this.droppedSamples;
    this.droppedSamples = 0;
    return dropped;
  }

  // Closing the SDK source retains its queued frames; reader.cancel() discards them.
  stop() {
    this.track.closeAudioStreams();
  }

  async release() {
    await this.reader.cancel().catch(() => undefined);
    await this.reading;
    this.frames.length = 0;
    this.queuedSamples = 0;
  }
}

// A new publisher generation after a cleanly ended input proves that no
// microphone was publishing in between; a reconnect of the same generation or
// a hole inside the tolerance is not evidence of absence.
export function publisherAbsence(
  previous: { generation: number; inputEndedMs?: number } | undefined,
  generation: number,
  inputResumedMs: number,
): { startOffsetMs: number; endOffsetMs: number } | undefined {
  if (
    previous?.inputEndedMs === undefined ||
    generation <= previous.generation ||
    inputResumedMs - previous.inputEndedMs <= publisherAbsenceToleranceMs
  )
    return undefined;
  return { startOffsetMs: previous.inputEndedMs, endOffsetMs: inputResumedMs };
}

async function forwardAudioFrames(
  input: TrackAudioInput,
  asr: ASRStream,
  stopSignal: AbortSignal,
  cancelSignal: AbortSignal,
  afterFrame?: () => Promise<void>,
) {
  let processedMs = 0;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drain = new AbortController();
  const stop = () => {
    input.stop();
    drainTimer = setTimeout(() => drain.abort(), 20_000);
  };
  if (stopSignal.aborted) stop();
  else stopSignal.addEventListener("abort", stop, { once: true });
  const wake = AbortSignal.any([cancelSignal, drain.signal]);
  try {
    while (!cancelSignal.aborted) {
      const frame = await input.next(wake);
      if (drain.signal.aborted)
        throw new VoiceFailure(
          "asr_input_drain_timeout",
          "ASR buffered audio drain timed out",
        );
      if (!frame) break;
      if (input.takeDroppedSamples() > 0)
        throw new VoiceFailure(
          "asr_audio_backlog",
          "ASR audio backlog exceeded",
        );
      await withTimeout(
        asr.sendPCM(frame.data),
        20_000,
        "ASR audio consumer stalled",
        "asr_send_timeout",
      );
      processedMs += Math.round(
        (frame.samplesPerChannel / frame.sampleRate) * 1_000,
      );
      // Newer audio replaced frames this consumer never sent. The retained
      // window continues in the next epoch; the hole becomes integrity evidence.
      if (input.takeDroppedSamples() > 0)
        throw new VoiceFailure(
          "asr_audio_backlog",
          "ASR audio backlog exceeded",
        );
      await afterFrame?.();
    }
    cancelSignal.throwIfAborted();
    return processedMs;
  } finally {
    clearTimeout(drainTimer);
    stopSignal.removeEventListener("abort", stop);
  }
}

export async function waitForAudioCompletionOrEventFailure(
  audioTask: Promise<number>,
  eventTask: Promise<void>,
) {
  const outcome = await Promise.race([
    audioTask.then(
      (processedMs) => ({ kind: "audio_complete" as const, processedMs }),
      (error: unknown) => ({ error, kind: "audio_failed" as const }),
    ),
    eventTask.then(
      () => ({ kind: "events_ended" as const }),
      (error: unknown) => ({ error, kind: "events_failed" as const }),
    ),
  ]);
  if (outcome.kind === "audio_complete") return outcome.processedMs;
  if (outcome.kind === "events_ended") {
    throw new VoiceFailure(
      "asr_events_ended",
      "ASR event stream ended before audio input",
      { recoverable: true },
    );
  }
  throw outcome.error;
}

export async function retryVoiceTrackConsumer({
  consume,
  isStopped,
  onFailure,
  retryDelaysMs,
  wait,
}: {
  consume: () => Promise<void>;
  isStopped: () => boolean;
  onFailure: (error: unknown, retryInMs: number) => void;
  retryDelaysMs: readonly number[];
  wait: (delayMs: number) => Promise<void>;
}) {
  let attempt = 0;
  while (!isStopped()) {
    const startedAt = Date.now();
    try {
      await consume();
      return;
    } catch (error) {
      if (isStopped()) {
        onFailure(error, 0);
        throw error;
      }
      if (Date.now() - startedAt >= 60_000) attempt = 0;
      const retryInMs =
        retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 0;
      onFailure(error, retryInMs);
      if (isStopped()) return;
      await wait(retryInMs);
      attempt += 1;
    }
  }
}

function waitForAbortableDelay(delayMs: number, signal: AbortSignal) {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function voiceTrackFailureCode(error: unknown): string {
  if (error instanceof TeamHubVoiceRuntimeError)
    return `teamhub_http_${error.status}`;
  if (!(error instanceof Error)) return "unknown";
  if ("code" in error) {
    if (error.code === "ECONNRESET") return "network_reset";
    if (error.code === "ETIMEDOUT") return "network_timeout";
    if (error.code === "EPIPE") return "network_pipe";
  }
  return error instanceof VoiceFailure ? error.code : "unknown";
}

export const reportVoiceObservationWithRetry = async (
  client: Pick<TeamHubVoiceRuntimeClient, "reportObservation">,
  observation: VoiceObservation,
  retryDelaysMs: readonly number[] = teamHubCallbackRetryDelaysMs,
) => {
  const budget = AbortSignal.timeout(teamHubCallbackBudgetMs);
  for (let attempt = 0; ; attempt += 1) {
    try {
      budget.throwIfAborted();
      return await client.reportObservation(
        observation,
        AbortSignal.any([budget, AbortSignal.timeout(2_000)]),
      );
    } catch (error) {
      if (
        (observation.kind === "partial" || observation.kind === "progress") &&
        isTransientObservationError(error)
      ) {
        // A newer snapshot replaces this one; finals retain their retry budget.
        return;
      }
      if (
        budget.aborted ||
        attempt >= retryDelaysMs.length ||
        !isTransientObservationError(error)
      ) {
        throw error;
      }
      await waitForAbortableDelay(retryDelaysMs[attempt] ?? 0, budget);
    }
  }
};

const isTransientObservationError = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")) ||
  (error instanceof TeamHubVoiceRuntimeError &&
    (error.status === 429 || error.status >= 500));

export const waitForASRFlush = async (
  stream: Pick<ASRStream, "finish">,
  eventTask: Promise<void>,
  timeoutMs: number,
  drainTimeoutMs = timeoutMs,
) => {
  await withTimeout(
    stream.finish(),
    timeoutMs,
    "ASR finish timed out",
    "asr_finish_timeout",
  );
  await withTimeout(
    eventTask,
    drainTimeoutMs,
    "ASR final drain timed out",
    "asr_drain_timeout",
  );
};

export const withTimeout = async <T>(
  task: Promise<T>,
  timeoutMs: number,
  message: string,
  code?: string,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(code ? new VoiceFailure(code, message) : new Error(message)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const voiceSessionFromRoom = (roomName: string) => {
  if (!roomName.startsWith("voice-voice_session_")) {
    throw new Error("Voice Runtime received a non-VoiceSession Room");
  }
  return roomName.slice("voice-".length);
};

export const voiceSessionCreatedAtFromMetadata = (metadata: string) => {
  let createdAt: unknown;
  try {
    createdAt = (JSON.parse(metadata) as { voice_session_created_at?: unknown })
      .voice_session_created_at;
  } catch {
    throw new Error("Voice Runtime dispatch metadata is invalid");
  }
  const value = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Voice Runtime dispatch metadata is invalid");
  }
  return value;
};

export function voicePurposeFromMetadata(
  metadata: string,
): PublicComponents["schemas"]["VoiceSessionPurpose"] {
  let purpose: unknown;
  try {
    purpose = (JSON.parse(metadata) as { voice_purpose?: unknown })
      .voice_purpose;
  } catch {
    throw new Error("Voice Runtime dispatch metadata is invalid");
  }
  if (purpose === undefined || purpose === "hardware_control")
    return "hardware_control";
  if (purpose === "chat_dictation" || purpose === "chat_live") return purpose;
  throw new Error("Voice Runtime dispatch purpose is invalid");
}

export function serverDictationCommitRequest(
  payload: Uint8Array,
  participant: unknown,
  topic?: string,
): string | undefined {
  if (
    participant !== undefined ||
    topic !== dictationCommitTopic ||
    payload.byteLength > 512
  )
    return;
  try {
    const request: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      Object.keys(request).length !== 1
    )
      return;
    const requestId = (request as { request_id?: unknown }).request_id;
    if (
      typeof requestId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(requestId)
    )
      return requestId;
  } catch {
    /* Malformed data packets are not control authority. */
  }
}

export const eventId = (
  voiceSessionId: string,
  epoch: number,
  kind: string,
  startMs: number,
  endMs: number,
  text = "",
  committedThroughMs?: number,
) =>
  `voice_event_${createHash("sha256")
    .update(
      [
        voiceSessionId,
        String(epoch),
        kind,
        String(startMs),
        String(endMs),
        text,
        // Progress over the same words can commit further; each is its own event.
        ...(committedThroughMs === undefined
          ? []
          : [String(committedThroughMs)]),
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 32)}`;
