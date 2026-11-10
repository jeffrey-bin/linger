import { createHash } from "node:crypto";
import WebSocket from "ws";

import {
  type ASREvent,
  type ASRProvider,
  type ASRStream,
  type ASRWord,
  speakerIdFromOneBased,
} from "./asr.js";
import { ASREventQueue } from "./event-queue.js";
import { RecoveringASRStream, type ASRRecovery } from "./recovering-asr.js";
import { VoiceFailure } from "./voice-failure.js";

// Not configurable per deployment; tests point the adapter at a local server.
const sonioxRealtimeWebSocketUrl =
  "wss://stt-rt.soniox.com/transcribe-websocket";

export interface SonioxASRConfig {
  apiKey: string;
  model: string;
  languageHints?: string[];
  webSocketUrl?: string;
  diarization?: boolean;
  dictation?: boolean;
  onRecovery?: (recovery: ASRRecovery) => void;
}

interface SonioxToken {
  text?: string;
  is_final?: boolean;
  start_ms?: number;
  end_ms?: number;
  speaker?: number | string;
}

interface SonioxMessage {
  error_code?: number | string;
  tokens?: SonioxToken[];
  finished?: boolean;
  final_audio_proc_ms?: number;
  total_audio_proc_ms?: number;
}

export class SonioxASRProvider implements ASRProvider {
  constructor(private readonly config: SonioxASRConfig) {}

  async open(signal: AbortSignal): Promise<ASRStream> {
    // Only dictation uses long-lived turn finalization and planned rotation.
    // Recording keeps its existing recovery policy and transcript semantics.
    return RecoveringASRStream.open(
      () => SonioxASRStream.connect(this.config, signal),
      this.config.onRecovery,
      this.config.dictation
        ? {
            retryAfterConfirmedMs: 10_000,
            rotateAfterMs: 295 * 60_000,
          }
        : undefined,
    );
  }
}

export function sonioxRealtimeSessionConfig(config: {
  apiKey: string;
  model: string;
  languageHints?: string[];
  diarization?: boolean;
  dictation?: boolean;
}) {
  return {
    api_key: config.apiKey,
    model: config.model,
    audio_format: "pcm_s16le",
    sample_rate: 16000,
    num_channels: 1,
    // Endpoint detection finalizes tokens early and Soniox documents that this
    // reduces speaker-diarization accuracy. Keep it only when diarization is off.
    ...(config.diarization
      ? { enable_speaker_diarization: true }
      : {
          enable_endpoint_detection: true,
          // Dictation leans on Soniox's semantic endpoint: the default latency
          // profile, a sensitivity that tolerates thinking pauses, and the
          // widest hard cap, so the model (not a timer) decides a thought ended.
          ...(config.dictation
            ? {
                endpoint_latency_adjustment_level: 0,
                endpoint_sensitivity: -0.4,
                max_endpoint_delay_ms: 3_000,
              }
            : {}),
        }),
    ...(config.languageHints?.length
      ? { language_hints: config.languageHints }
      : {}),
  };
}

/**
 * Without endpoint detection (Recording with diarization), a speaker's final
 * tokens are held to group a speaker run. A run is flushed once Soniox has
 * finalized this long past its last token (the speaker paused), or once it
 * grows this long, so committed progress keeps moving and the recovery replay
 * buffer never fills while one person talks.
 */
const speakerRunPauseMs = 1_500;
const maximumSpeakerRunMs = 20_000;

export class SonioxASRStream implements ASRStream {
  private finishing = false;
  private finished = false;
  private readonly queue = new ASREventQueue();
  private readonly finalWindows = new Map<string, string>();
  private pendingFinals: SonioxToken[] = [];
  private pendingPartialEndMs?: number;
  private finishTimer?: ReturnType<typeof setTimeout>;
  private finalizeTimer?: ReturnType<typeof setTimeout>;
  private finalizeThroughMs?: number;
  private sentSamples = 0;
  private lastFinalEndMs = 0;
  private lastAudioAtMs = Date.now();
  private responseTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer: ReturnType<typeof setInterval>;

  private constructor(
    private readonly socket: WebSocket,
    private readonly emitUtteranceEnd: boolean,
    private readonly holdsSpeakerRuns = false,
  ) {
    this.armResponseDeadline();
    this.heartbeatTimer = setInterval(() => {
      if (
        this.finished ||
        this.finishing ||
        socket.readyState !== WebSocket.OPEN
      )
        return;
      socket.ping();
      if (this.emitUtteranceEnd && Date.now() - this.lastAudioAtMs >= 5_000)
        void this.write(JSON.stringify({ type: "keepalive" })).catch((error) =>
          this.fail(error),
        );
    }, 5_000);
    socket.on("pong", () => this.armResponseDeadline());
    socket.on("message", (data, binary) => {
      if (binary) return;
      try {
        this.armResponseDeadline();
        this.acceptMessage(Buffer.from(data as Buffer));
      } catch (error) {
        this.fail(error);
      }
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      if (!this.finished)
        this.fail(
          new VoiceFailure(
            "asr_closed_without_ack",
            "Soniox ASR closed before final acknowledgement",
            { recoverable: true },
          ),
        );
      this.clearTimers();
    });
  }

  static async connect(
    config: SonioxASRConfig,
    signal: AbortSignal,
  ): Promise<SonioxASRStream> {
    const socket = new WebSocket(
      config.webSocketUrl ?? sonioxRealtimeWebSocketUrl,
      { signal, handshakeTimeout: 5_000, maxPayload: 1 << 20 },
    );
    const stream = new SonioxASRStream(
      socket,
      config.dictation === true,
      config.diarization === true,
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      // With this listener ws neither emits "error" nor aborts the request,
      // so the handshake is torn down here after the typed rejection.
      socket.once("unexpected-response", (request, response) => {
        const status = response.statusCode;
        reject(
          status !== undefined &&
            Number.isInteger(status) &&
            status >= 100 &&
            status <= 599
            ? new VoiceFailure(
                `asr_http_${status}`,
                `Soniox ASR handshake returned HTTP ${status}`,
              )
            : new Error("Soniox ASR handshake returned an invalid status"),
        );
        request.destroy();
        socket.terminate();
      });
    });
    await stream.write(
      JSON.stringify(
        sonioxRealtimeSessionConfig({
          apiKey: config.apiKey,
          model: config.model,
          languageHints: config.languageHints,
          diarization: config.diarization,
          dictation: config.dictation,
        }),
      ),
    );
    return stream;
  }

  async sendPCM(frame: Int16Array): Promise<void> {
    if (this.finished || this.finishing)
      throw new VoiceFailure(
        "asr_stream_closed",
        "Soniox ASR stream is closed",
        { recoverable: true },
      );
    if (frame.length === 0) return;
    // Record the write boundary before the provider can acknowledge it.
    this.sentSamples += frame.length;
    this.lastAudioAtMs = Date.now();
    await this.write(
      Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength),
    );
  }

  async finalize(): Promise<void> {
    if (this.finished || this.finishing)
      throw new VoiceFailure(
        "asr_stream_closed",
        "Soniox ASR stream is closed",
        { recoverable: true },
      );
    if (!this.emitUtteranceEnd)
      throw new Error("Soniox non-closing finalization requires dictation");
    if (this.finalizeThroughMs !== undefined) return;
    this.finalizeThroughMs = this.sentSamples / 16;
    this.finalizeTimer = setTimeout(
      () =>
        this.fail(
          new VoiceFailure(
            "asr_final_ack_timeout",
            "Soniox ASR finalization acknowledgement timed out",
            { recoverable: true },
          ),
        ),
      5_000,
    );
    // The PCM writer awaits only this write, never the later <fin>.
    await this.write(JSON.stringify({ type: "finalize" }));
  }

  async finish(): Promise<void> {
    if (this.finished || this.finishing) return;
    this.finishing = true;
    // Official end-of-audio is an empty text frame. `finalize` only
    // flushes tokens and keeps the session open; empty binary is ignored.
    await this.write("");
    if (!this.finished) {
      this.finishTimer = setTimeout(
        () =>
          this.fail(
            new VoiceFailure(
              "asr_final_ack_timeout",
              "Soniox ASR final acknowledgement timed out",
              { recoverable: true },
            ),
          ),
        5_000,
      );
    }
  }

  events(): AsyncIterable<ASREvent> {
    return this.queue.events();
  }

  async close(): Promise<void> {
    this.finished = true;
    this.clearTimers();
    this.socket.terminate();
    this.queue.end();
  }

  private async write(payload: string | Buffer): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSING)
      throw new VoiceFailure(
        "asr_socket_closing",
        "Soniox ASR socket is closing",
        { recoverable: true },
      );
    if (this.socket.readyState === WebSocket.CLOSED)
      throw new VoiceFailure(
        "asr_socket_closed",
        "Soniox ASR socket is closed",
        {
          recoverable: true,
        },
      );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new VoiceFailure(
          "asr_write_timeout",
          "Soniox ASR audio write timed out",
          { recoverable: true },
        );
        this.fail(error);
        reject(error);
      }, 4_000);
      this.socket.send(payload, (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private acceptMessage(raw: Buffer) {
    const payload = JSON.parse(raw.toString("utf8")) as SonioxMessage;
    if (payload.error_code !== undefined && payload.error_code !== null) {
      const message = `Soniox ASR rejected the stream with code ${payload.error_code}`;
      throw /^[0-9]{1,10}$/.test(String(payload.error_code))
        ? new VoiceFailure(`asr_provider_${payload.error_code}`, message)
        : new Error(message);
    }
    const processedMs = Math.max(
      payload.total_audio_proc_ms ?? 0,
      payload.final_audio_proc_ms ?? 0,
    );
    this.acceptTokens(payload.tokens ?? [], processedMs);
    if (this.holdsSpeakerRuns)
      this.flushSettledSpeakerRun(payload.final_audio_proc_ms ?? 0);
    if (payload.finished) this.flushUtterance("final");
    if (processedMs > 0) {
      // Provider-final tokens may still be held in our pending utterance.
      // Do not acknowledge that audio before its normalized final is queued.
      const pendingStart =
        this.pendingFinals.length > 0
          ? (this.pendingFinals[0]?.start_ms ?? 0)
          : Infinity;
      const committedThroughMs = Math.min(
        payload.final_audio_proc_ms ?? 0,
        pendingStart,
      );
      this.queue.push({
        kind: "progress",
        startOffsetMs: 0,
        endOffsetMs: processedMs,
        ...(committedThroughMs > 0 ? { committedThroughMs } : {}),
      });
    }
    if (payload.finished) {
      this.finished = true;
      this.clearTimers();
      this.queue.end();
      this.socket.close();
    }
  }

  private acceptTokens(tokens: SonioxToken[], processedMs: number) {
    const nonFinals: SonioxToken[] = [];
    for (const [index, token] of tokens.entries()) {
      if (
        (token.text === "<end>" || token.text === "<fin>") &&
        token.is_final
      ) {
        // A response may contain several endpoints and the next hypothesis.
        // Never move a boundary behind those later tokens, or use whole-packet
        // processed audio as the end of this utterance.
        const nextStartMs = tokens
          .slice(index + 1)
          .find((next) => typeof next.start_ms === "number")?.start_ms;
        this.flushUtterance(
          "final",
          this.emitUtteranceEnd ? nextStartMs : undefined,
        );
        if (this.emitUtteranceEnd) {
          const manual = token.text === "<fin>";
          const boundaryMs = manual
            ? Math.max(this.lastFinalEndMs, this.finalizeThroughMs ?? 0)
            : this.lastFinalEndMs;
          this.queue.push({
            kind: manual ? "finalization_ack" : "utterance_end",
            startOffsetMs: boundaryMs,
            endOffsetMs: boundaryMs,
          });
          if (manual) {
            clearTimeout(this.finalizeTimer);
            this.finalizeThroughMs = undefined;
          }
        }
        continue;
      }
      if (!token.text) continue;
      if (token.is_final) {
        const lastSpeaker = sonioxSpeakerIndex(
          this.pendingFinals.at(-1)?.speaker,
        );
        const nextSpeaker = sonioxSpeakerIndex(token.speaker);
        if (
          nextSpeaker !== undefined &&
          lastSpeaker !== undefined &&
          nextSpeaker !== lastSpeaker
        ) {
          this.flushUtterance("final");
        }
        this.pendingFinals.push(token);
      } else nonFinals.push(token);
    }
    if (nonFinals.length > 0 || this.pendingFinals.length > 0)
      this.emitWindow(
        "partial",
        [...this.pendingFinals, ...nonFinals],
        processedMs,
      );
  }

  /** Releases a held speaker run that paused or grew too long; see above. */
  private flushSettledSpeakerRun(finalAudioMs: number) {
    const first = this.pendingFinals[0]?.start_ms;
    const last = this.pendingFinals.at(-1)?.end_ms;
    if (typeof first !== "number" || typeof last !== "number") return;
    if (
      finalAudioMs - last >= speakerRunPauseMs ||
      last - first >= maximumSpeakerRunMs
    )
      this.flushUtterance("final");
  }

  private flushUtterance(kind: "final", nextStartMs?: number) {
    if (this.pendingFinals.length === 0) return;
    const groups = groupSonioxTokensBySpeaker(this.pendingFinals);
    this.pendingFinals = [];
    const partialEndMs = this.pendingPartialEndMs;
    // A previous wide partial may span both sides of this packet's endpoint.
    // Carry its replacement coverage to the following segment, not across it.
    const hasFollowing =
      nextStartMs !== undefined &&
      partialEndMs !== undefined &&
      partialEndMs > nextStartMs;
    this.pendingPartialEndMs = hasFollowing ? partialEndMs : undefined;
    for (const tokens of groups)
      this.emitWindow(
        kind,
        tokens,
        0,
        hasFollowing ? nextStartMs : partialEndMs,
      );
  }

  private emitWindow(
    kind: "partial" | "final",
    tokens: SonioxToken[],
    fallbackEndMs: number,
    partialEndMs?: number,
  ) {
    const text = tokens.map((token) => token.text ?? "").join("");
    const trimmed = text.trim();
    if (!trimmed) return;
    const timed = tokens.filter(
      (token) =>
        typeof token.start_ms === "number" && typeof token.end_ms === "number",
    );
    const startMs = timed[0]?.start_ms ?? 0;
    let endMs = timed.at(-1)?.end_ms ?? fallbackEndMs;
    if (endMs <= startMs) return;
    // A Soniox final flush acknowledges the pending utterance whose partials
    // were already published. Soniox may revise text and token timestamps at
    // that transition, but the normalized final must still cover the complete
    // transient window so consumers can replace it atomically.
    if (kind === "final" && partialEndMs !== undefined)
      endMs = Math.max(endMs, partialEndMs);
    if (kind === "final") {
      this.lastFinalEndMs = Math.max(this.lastFinalEndMs, endMs);
      const window = `${startMs}:${endMs}`;
      const digest = createHash("sha256").update(trimmed).digest("hex");
      if (this.finalWindows.get(window) === digest) return;
      // This is a recent replay index, not the transcript store. Older exact
      // replays retain their deterministic event ID at the TeamHub boundary.
      if (!this.finalWindows.has(window) && this.finalWindows.size >= 512)
        this.finalWindows.delete(this.finalWindows.keys().next().value!);
      this.finalWindows.set(window, digest);
    } else if (this.emitUtteranceEnd) {
      this.pendingPartialEndMs = Math.max(this.pendingPartialEndMs ?? 0, endMs);
    }
    const event: ASREvent = {
      kind,
      startOffsetMs: startMs,
      endOffsetMs: endMs,
      text: trimmed,
    };
    const speakerId = sonioxSpeakerId(tokens);
    if (speakerId) event.speakerId = speakerId;
    const words = mapSonioxWords(trimmed, endMs, tokens);
    if (words) event.words = words;
    this.queue.push(event);
  }

  private fail(error: unknown) {
    this.finished = true;
    this.clearTimers();
    this.queue.fail(error);
    this.socket.terminate();
  }

  private armResponseDeadline() {
    if (this.finished) return;
    clearTimeout(this.responseTimer);
    this.responseTimer = setTimeout(
      () =>
        this.fail(
          new VoiceFailure(
            "asr_transport_timeout",
            "Soniox ASR transport timed out",
            { recoverable: true },
          ),
        ),
      15_000,
    );
  }

  private clearTimers() {
    clearTimeout(this.responseTimer);
    clearTimeout(this.finishTimer);
    clearTimeout(this.finalizeTimer);
    clearInterval(this.heartbeatTimer);
  }
}

function mapSonioxWords(
  text: string,
  endMs: number,
  input: SonioxToken[],
): ASRWord[] | undefined {
  if (input.length === 0 || input.length > 1024 || text.length > 64 * 1024)
    return undefined;
  const words: ASRWord[] = [];
  let cursor = 0;
  let previousTime = 0;
  for (const token of input) {
    if (
      !token.text ||
      token.text === "<end>" ||
      token.text === "<fin>" ||
      /^\s+$/.test(token.text)
    )
      continue;
    if (
      typeof token.start_ms !== "number" ||
      typeof token.end_ms !== "number" ||
      !Number.isFinite(token.start_ms) ||
      !Number.isFinite(token.end_ms) ||
      token.end_ms < token.start_ms
    )
      return undefined;
    const from = Math.round(token.start_ms);
    const through = Math.min(Math.round(token.end_ms), endMs);
    if (from < previousTime || through < from) return undefined;
    const at = text.indexOf(token.text.trim(), cursor);
    if (at < 0) return undefined;
    words.push({
      startOffsetMs: from,
      endOffsetMs: through,
      textStart: at,
      textEnd: at + token.text.trim().length,
    });
    cursor = at + token.text.trim().length;
    previousTime = from;
  }
  return words.length > 0 ? words : undefined;
}

function sonioxSpeakerId(tokens: SonioxToken[]) {
  for (const token of tokens) {
    const speakerId = speakerIdFromOneBased(sonioxSpeakerIndex(token.speaker));
    if (speakerId) return speakerId;
  }
  return undefined;
}

function sonioxSpeakerIndex(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim()))
    return Number(value.trim());
  return undefined;
}

function groupSonioxTokensBySpeaker(tokens: SonioxToken[]) {
  const groups: SonioxToken[][] = [];
  let current: SonioxToken[] = [];
  let speaker: number | undefined;
  for (const token of tokens) {
    const nextSpeaker = sonioxSpeakerIndex(token.speaker);
    if (
      nextSpeaker !== undefined &&
      speaker !== undefined &&
      nextSpeaker !== speaker
    ) {
      if (current.length > 0) groups.push(current);
      current = [];
    }
    current.push(token);
    if (nextSpeaker !== undefined) speaker = nextSpeaker;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
