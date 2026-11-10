import {
  asrEventBytes,
  offsetASREvent,
  type ASREvent,
  type ASRStream,
} from "./asr.js";
import { ASREventQueue } from "./event-queue.js";
import { asError } from "@linger/service-kit";
import { VoiceFailure } from "./voice-failure.js";

const sampleRate = 16_000;
const maximumBufferedSamples = sampleRate * 65;
const recoveryTimeoutMs = 10_000;
interface RecoveryOptions {
  // Opt-in for long-lived dictation; recording keeps one recovery.
  retryAfterConfirmedMs?: number;
  rotateAfterMs?: number;
}
interface StreamState {
  openedAtMs: number;
  endpointSamples?: number;
  stream: ASRStream;
  baseSamples: number;
  finishRequested: boolean;
}

export interface ASRRecovery {
  cause: unknown;
  replayMs: number;
  elapsedMs: number;
}

export class RecoveringASRStream implements ASRStream {
  private readonly queue = new ASREventQueue();
  private chunks: Int16Array[] = [];
  private bufferedSamples = 0;
  private totalSamples = 0;
  private committedSamples = 0;
  private readonly confirmedFinals: ASREvent[] = [];
  private confirmedBytes = 0;
  private attemptedRecovery = false;
  private resetRecoveryAfterSample?: number;
  private pendingFinalizationThroughSamples?: number;
  private rotationTimer?: ReturnType<typeof setTimeout>;
  private wantsFinish = false;
  private closed = false;
  private failure?: unknown;
  private recovery?: Promise<void>;
  private recoveringState?: StreamState;
  private state?: StreamState;

  static async open(
    factory: () => Promise<ASRStream>,
    onRecovery?: (recovery: ASRRecovery) => void,
    options: RecoveryOptions = {},
  ): Promise<RecoveringASRStream> {
    const result = new RecoveringASRStream(factory, onRecovery, options);
    result.attach(await factory(), 0);
    return result;
  }

  private constructor(
    private readonly factory: () => Promise<ASRStream>,
    private readonly onRecovery: ((recovery: ASRRecovery) => void) | undefined,
    private readonly options: RecoveryOptions,
  ) {}

  async sendPCM(frame: Int16Array): Promise<void> {
    while (this.recovery) await this.recovery;
    const state = this.state;
    if (this.closed || this.wantsFinish || !state)
      throw asError(
        this.failure ??
          new VoiceFailure("asr_stream_closed", "ASR stream is closed"),
      );
    if (frame.length === 0) return;
    if (this.bufferedSamples + frame.length > maximumBufferedSamples) {
      const error = new VoiceFailure(
        "asr_recovery_backlog",
        "ASR recovery buffer exceeded",
      );
      this.fail(error);
      throw error;
    }
    // A failed write has an unknown outcome, so retain it before sending.
    const retained = frame.slice();
    this.chunks.push(retained);
    this.totalSamples += retained.length;
    this.bufferedSamples += retained.length;
    try {
      await state.stream.sendPCM(frame);
    } catch (error) {
      await this.recover(state, error);
    }
  }

  async finalize(): Promise<void> {
    while (this.recovery) await this.recovery;
    const state = this.state;
    if (this.closed || this.wantsFinish || !state)
      throw asError(
        this.failure ??
          new VoiceFailure("asr_stream_closed", "ASR stream is closed"),
      );
    if (this.pendingFinalizationThroughSamples !== undefined) return;
    if (!state.stream.finalize)
      throw new Error("ASR stream cannot finalize without closing");
    // Keep the exact PCM cut for replay if the control write or its ACK is lost.
    this.pendingFinalizationThroughSamples = this.totalSamples;
    try {
      await state.stream.finalize();
    } catch (error) {
      await this.recover(state, error);
    }
  }

  async finish(): Promise<void> {
    if (this.wantsFinish || this.closed) return;
    this.wantsFinish = true;
    // The events iterator owns final acknowledgement and recovery completion.
    void this.finishCurrent().catch((error) => this.fail(error));
  }

  events(): AsyncIterable<ASREvent> {
    return this.queue.events();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.rotationTimer);
    this.queue.end();
    await this.state?.stream.close().catch(() => undefined);
    await this.recoveringState?.stream.close().catch(() => undefined);
    this.chunks = [];
    this.bufferedSamples = 0;
    this.confirmedFinals.length = 0;
    this.confirmedBytes = 0;
  }

  private attach(stream: ASRStream, baseSamples: number): StreamState {
    const state = {
      openedAtMs: Date.now(),
      stream,
      baseSamples,
      finishRequested: false,
    };
    this.state = state;
    clearTimeout(this.rotationTimer);
    if (this.options.rotateAfterMs !== undefined) {
      // Prefer the next utterance boundary, but never wait indefinitely for it.
      this.rotationTimer = setTimeout(() => {
        if (this.state === state && !this.closed && !this.wantsFinish)
          void this.recover(
            state,
            new Error("ASR scheduled session rotation"),
            true,
          ).catch((error) => this.fail(error));
      }, this.options.rotateAfterMs + 60_000);
      this.rotationTimer.unref?.();
    }
    void this.pump(state).catch((error) => this.fail(error));
    return state;
  }

  private fail(error: unknown) {
    this.failure ??= error;
    this.queue.fail(error);
    void this.close();
  }

  private async finishCurrent() {
    while (this.recovery) await this.recovery;
    const state = this.state;
    if (this.closed || !state || state.finishRequested) return;
    state.finishRequested = true;
    try {
      await state.stream.finish();
    } catch (error) {
      await this.recover(state, error);
    }
  }

  private async pump(state: StreamState) {
    try {
      for await (const event of state.stream.events()) {
        if (this.closed || this.state !== state) return;
        const baseMs = (state.baseSamples / sampleRate) * 1000;
        const projected = offsetASREvent(event, baseMs);
        // Replayed PCM continues this logical stream's verified prefix. A
        // provider reconnection changes token offsets, not the coverage origin.
        if (projected.kind === "progress") projected.startOffsetMs = 0;
        if (
          event.kind === "progress" &&
          projected.committedThroughMs !== undefined
        ) {
          const next = Math.min(
            this.totalSamples,
            Math.floor((projected.committedThroughMs * sampleRate) / 1000),
          );
          if (next > this.committedSamples) this.commitThrough(next);
        }
        if (event.kind === "final") {
          // A replacement only receives audio after its replay base. Never
          // republish a delayed final wholly behind that confirmed boundary.
          if (projected.endOffsetMs <= (state.baseSamples / sampleRate) * 1000)
            continue;
          const prior = this.confirmedFinals.find(
            (final) =>
              final.startOffsetMs === projected.startOffsetMs &&
              final.endOffsetMs === projected.endOffsetMs,
          );
          if (prior && prior.text === projected.text) continue;
          if (
            prior ||
            this.confirmedFinals.some(
              (final) =>
                final.startOffsetMs < projected.endOffsetMs &&
                final.endOffsetMs > projected.startOffsetMs,
            )
          )
            throw new VoiceFailure(
              "asr_final_conflict",
              "ASR final overlaps with an accepted final",
            );
          const bytes = asrEventBytes(projected);
          // Retain recent confirmed windows for revision/conflict checks, but
          // reclaim confirmed metadata when the bounded index fills up. Finals
          // overlapping replayable PCM must never be evicted to make room.
          while (
            (this.confirmedFinals.length >= 512 ||
              this.confirmedBytes + bytes > 1 << 20) &&
            this.confirmedFinals[0] &&
            this.confirmedFinals[0].endOffsetMs <=
              (this.committedSamples / sampleRate) * 1000
          ) {
            this.confirmedBytes -= asrEventBytes(this.confirmedFinals.shift()!);
          }
          if (
            this.confirmedFinals.length >= 512 ||
            this.confirmedBytes + bytes > 1 << 20
          )
            throw new VoiceFailure(
              "asr_final_history_limit",
              "ASR final history limit exceeded",
            );
          this.confirmedBytes += bytes;
          this.confirmedFinals.push(projected);
          this.confirmedFinals.sort(
            (a, b) => a.startOffsetMs - b.startOffsetMs,
          );
          // A later definite utterance does not confirm earlier audio. Retain
          // any hole for replay; exact replayed finals are de-duplicated above.
          let next = this.committedSamples;
          for (const final of this.confirmedFinals) {
            if (Math.floor((final.startOffsetMs * sampleRate) / 1000) > next)
              break;
            next = Math.max(
              next,
              Math.min(
                this.totalSamples,
                Math.floor((final.endOffsetMs * sampleRate) / 1000),
              ),
            );
          }
          if (next > this.committedSamples) this.commitThrough(next);
        }
        if (event.kind === "finalization_ack") {
          const boundary = this.pendingFinalizationThroughSamples;
          if (boundary !== undefined && projected.endOffsetMs * 16 >= boundary)
            this.pendingFinalizationThroughSamples = undefined;
        }
        this.queue.push(projected);
        if (event.kind === "utterance_end" || event.kind === "finalization_ack")
          state.endpointSamples = Math.floor(
            (projected.endOffsetMs * sampleRate) / 1000,
          );
        if (
          state.endpointSamples !== undefined &&
          this.committedSamples >= state.endpointSamples &&
          !this.wantsFinish &&
          this.pendingFinalizationThroughSamples === undefined &&
          this.options.rotateAfterMs !== undefined &&
          Date.now() - state.openedAtMs >= this.options.rotateAfterMs
        )
          await this.recover(
            state,
            new Error("ASR scheduled session rotation"),
            true,
          );
      }
      if (this.closed || this.state !== state) return;
      if (this.wantsFinish) this.queue.end();
      else
        throw new VoiceFailure(
          "asr_events_ended",
          "ASR event stream ended before audio input",
          { recoverable: true },
        );
    } catch (error) {
      if (!this.closed && this.state === state)
        await this.recover(state, error);
    }
  }

  private commitThrough(next: number) {
    let drop = next - this.committedSamples;
    let count = 0;
    while (drop > 0 && count < this.chunks.length) {
      const first = this.chunks[count]!;
      const taken = Math.min(drop, first.length);
      if (taken === first.length) count += 1;
      else this.chunks[count] = first.subarray(taken);
      drop -= taken;
      this.bufferedSamples -= taken;
    }
    this.chunks.splice(0, count);
    this.committedSamples = next;
    if (
      this.resetRecoveryAfterSample !== undefined &&
      next >= this.resetRecoveryAfterSample
    ) {
      this.attemptedRecovery = false;
      this.resetRecoveryAfterSample = undefined;
    }
    // Keep a recent confirmed history as well as every window overlapping
    // replayable PCM. This preserves revision checks during an active replay.
    while (
      this.confirmedFinals[0] &&
      this.confirmedFinals[0].endOffsetMs <=
        ((next - maximumBufferedSamples) / sampleRate) * 1000
    ) {
      this.confirmedBytes -= asrEventBytes(this.confirmedFinals.shift()!);
    }
  }

  private recover(
    state: StreamState,
    cause: unknown,
    planned = false,
  ): Promise<void> {
    if (this.closed) return Promise.reject(this.failure ?? cause);
    if (this.recovery) {
      if (state === this.recoveringState) return this.recovery;
      this.fail(cause);
      return Promise.reject(cause);
    }
    if (state !== this.state) return Promise.resolve();
    if (!planned && (this.attemptedRecovery || !isRecoverableFailure(cause))) {
      this.fail(cause);
      return Promise.reject(cause);
    }
    if (!planned) {
      this.attemptedRecovery = true;
      if (this.options.retryAfterConfirmedMs !== undefined)
        this.resetRecoveryAfterSample =
          this.totalSamples +
          Math.ceil((this.options.retryAfterConfirmedMs * sampleRate) / 1000);
    }
    clearTimeout(this.rotationTimer);
    this.recoveringState = state;
    this.state = undefined;
    const startedAt = Date.now();
    const task = Promise.resolve().then(async () => {
      await state.stream.close();
      if (this.closed) throw cause;
      const base = this.committedSamples;
      const replay = new Int16Array(this.bufferedSamples);
      let offset = 0;
      for (const chunk of this.chunks) {
        replay.set(chunk, offset);
        offset += chunk.length;
      }
      const stream = await this.factory();
      if (this.closed) {
        await stream.close();
        throw cause;
      }
      const next = this.attach(stream, base);
      const cut = this.pendingFinalizationThroughSamples;
      if (cut !== undefined && cut <= base) {
        // Confirmed progress already covers the requested cut; only its ACK
        // was lost. Replaying later audio must not move this earlier boundary.
        this.pendingFinalizationThroughSamples = undefined;
        this.queue.push({
          kind: "finalization_ack",
          startOffsetMs: cut / 16,
          endOffsetMs: cut / 16,
        });
      }
      for (let start = 0; start < replay.length; ) {
        if (this.closed || this.state !== next) throw cause;
        const end = Math.min(
          start + 1600,
          replay.length,
          cut !== undefined && cut > base + start ? cut - base : Infinity,
        );
        await stream.sendPCM(replay.subarray(start, end));
        start = end;
        if (cut !== undefined && base + start === cut) {
          if (!stream.finalize)
            throw new Error("ASR stream cannot replay finalization");
          await stream.finalize();
        }
      }
      this.onRecovery?.({
        cause,
        replayMs: (replay.length / sampleRate) * 1000,
        elapsedMs: Date.now() - startedAt,
      });
      if (this.wantsFinish) {
        next.finishRequested = true;
        await stream.finish();
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guarded = Promise.race([
      task,
      new Promise<void>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new VoiceFailure(
                "asr_recovery_timeout",
                "ASR recovery timed out",
              ),
            ),
          recoveryTimeoutMs,
        );
      }),
    ])
      .catch((error: unknown) => {
        this.fail(error);
        throw error;
      })
      .finally(() => {
        clearTimeout(timer);
        this.recovery = undefined;
        this.recoveringState = undefined;
      });
    this.recovery = guarded;
    return guarded;
  }
}

function isRecoverableFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (
    "code" in error &&
    ["ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(String(error.code))
  )
    return true;
  return error instanceof VoiceFailure && error.recoverable;
}
