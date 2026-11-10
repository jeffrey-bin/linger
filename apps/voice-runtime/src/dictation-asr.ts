import {
  offsetASREvent,
  transcriptCharacters,
  type ASREvent,
  type ASRProvider,
  type ASRStream,
} from "./asr.js";
import { ASREventQueue } from "./event-queue.js";
import { asError } from "@linger/service-kit";
import { VoiceFailure } from "./voice-failure.js";

const sampleRate = 16_000;
const maximumQueuedSamples = sampleRate * 20;
const maximumFinals = 512;
const maximumTurnCharacters = 50_000;
const maximumCommitRequests = 1_024;

interface Turn {
  stream: ASRStream;
  baseSamples: number;
  events: Promise<void>;
  finals: Map<string, ASREvent>;
  textLength: number;
  partialEndMs?: number;
  finalEndMs: number;
  finishing: boolean;
  // Connection-local boundary of the last published turn.
  committedEndMs: number;
}

export class DictationASRStream implements ASRStream {
  private readonly queue = new ASREventQueue();
  private current?: Turn;
  private operations: Promise<void> = Promise.resolve();
  private readonly commits = new Set<string>();
  private sentSamples = 0;
  private queuedSamples = 0;
  private finishing = false;
  private closed = false;
  private failure?: unknown;
  private finishTask?: Promise<void>;

  // Turns end on the provider's semantic endpoint (`utterance_end`) or on a
  // manual commit's `finalization_ack`; one provider connection serves the
  // whole session.
  private constructor(
    private readonly provider: ASRProvider,
    private readonly signal: AbortSignal,
    private readonly flushTimeoutMs: number,
  ) {}

  static async open(
    provider: ASRProvider,
    signal: AbortSignal,
    flushTimeoutMs = 12_000,
  ): Promise<DictationASRStream> {
    const stream = new DictationASRStream(provider, signal, flushTimeoutMs);
    try {
      await stream.ensureTurn();
      return stream;
    } catch (error) {
      await stream.close();
      throw error;
    }
  }

  get processedSamples() {
    return this.sentSamples;
  }

  sendPCM(frame: Int16Array): Promise<void> {
    if (this.finishing || this.closed)
      return Promise.reject(new Error("Dictation stream is closed"));
    if (this.queuedSamples + frame.length > maximumQueuedSamples) {
      return Promise.reject(
        this.fail(
          new VoiceFailure(
            "dictation_audio_backlog",
            "Dictation audio backlog exceeded",
          ),
        ),
      );
    }
    // Manual commit and audio may arrive concurrently; retain a bounded copy
    // until this operation owns the provider stream.
    const ownedFrame = frame.slice();
    this.queuedSamples += ownedFrame.length;
    return this.enqueue(async () => {
      const turn = await this.ensureTurn();
      await turn.stream.sendPCM(ownedFrame);
      this.sentSamples += ownedFrame.length;
    }).finally(() => {
      this.queuedSamples -= ownedFrame.length;
    });
  }

  commit(requestId: string): Promise<void> {
    if (this.finishing || this.closed || this.commits.has(requestId))
      return Promise.resolve();
    if (this.commits.size >= maximumCommitRequests)
      return Promise.reject(
        this.fail(
          new VoiceFailure(
            "dictation_commit_limit",
            "Dictation commit request limit exceeded",
          ),
        ),
      );
    this.commits.add(requestId);
    return this.enqueue(async () => {
      const turn = await this.ensureTurn();
      if (!turn.stream.finalize)
        throw new Error("Dictation provider cannot finalize without closing");
      // Only serialize the control write with PCM, never the acknowledgement.
      // The event reader commits <fin> while the next audio keeps flowing.
      await turn.stream.finalize();
    });
  }

  finish(): Promise<void> {
    if (this.finishTask) return this.finishTask;
    this.finishing = true;
    this.finishTask = this.enqueue(async () => {
      await this.finishTurn();
      this.queue.end();
    });
    return this.finishTask;
  }

  events(): AsyncIterable<ASREvent> {
    return this.queue.events();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.end();
    if (this.current)
      await deadline(
        this.current.stream.close(),
        1_000,
        "Dictation stream close timed out",
      ).catch(() => undefined);
    this.current = undefined;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.operations
      .then(async () => {
        this.throwIfFailed();
        await operation();
        this.throwIfFailed();
      })
      .catch((error: unknown) => {
        throw this.fail(error);
      });
    this.operations = task.catch(() => undefined);
    return task;
  }

  private async ensureTurn(): Promise<Turn> {
    if (this.current) return this.current;
    this.throwIfFailed();
    const stream = await this.openProvider();
    if (this.closed || this.failure) {
      await stream.close();
      this.throwIfFailed();
    }
    const turn: Turn = {
      stream,
      baseSamples: this.sentSamples,
      finals: new Map(),
      textLength: 0,
      finalEndMs: -1,
      finishing: false,
      committedEndMs: 0,
      events: Promise.resolve(),
    };
    this.current = turn;
    turn.events = this.forwardTurnEvents(turn).catch((error: unknown) => {
      throw this.fail(error);
    });
    // The event reader can fail before the next audio write or finish call.
    void turn.events.catch(() => undefined);
    return turn;
  }

  private async forwardTurnEvents(turn: Turn) {
    for await (const event of turn.stream.events()) {
      this.throwIfFailed();
      if (event.kind === "turn_finalized")
        throw new Error("Dictation provider returned a nested turn");
      if (event.kind === "utterance_end" || event.kind === "finalization_ack") {
        this.publishTurn(turn, event.endOffsetMs);
        continue;
      }
      // Recovery can replay a confirmed endpoint. It must not cut or repeat
      // text from a later turn on this same logical connection.
      if (
        (event.kind === "partial" || event.kind === "final") &&
        event.endOffsetMs <= turn.committedEndMs
      )
        continue;
      if (event.kind === "partial") {
        if (meaningful(event.text ?? "") && event.endOffsetMs > turn.finalEndMs)
          turn.partialEndMs = event.endOffsetMs;
      } else if (event.kind === "final") {
        turn.finalEndMs = Math.max(turn.finalEndMs, event.endOffsetMs);
        if (
          turn.partialEndMs !== undefined &&
          event.endOffsetMs >= turn.partialEndMs
        )
          turn.partialEndMs = undefined;
        if (meaningful(event.text ?? "")) {
          const key = `${event.startOffsetMs}:${event.endOffsetMs}`;
          const prior = turn.finals.get(key);
          if (prior) {
            if (meaningful(prior.text ?? "") === meaningful(event.text ?? ""))
              continue;
            // A provider may revise a window it already finalized. Commit the
            // revision with the turn instead of abandoning the whole session,
            // without reporting a second overlapping sentence.
            turn.textLength +=
              (event.text?.trim().length ?? 0) -
              (prior.text?.trim().length ?? 0);
            turn.finals.set(key, event);
            continue;
          }
          const nextLength =
            turn.textLength +
            (event.text?.trim().length ?? 0) +
            (turn.finals.size ? 1 : 0);
          if (
            turn.finals.size >= maximumFinals ||
            nextLength > maximumTurnCharacters
          )
            throw new VoiceFailure(
              "dictation_turn_limit",
              "Dictation turn transcript limit exceeded",
            );
          turn.finals.set(key, event);
          turn.textLength = nextLength;
        }
      }
      const normalized = offsetASREvent(event, milliseconds(turn.baseSamples));
      delete normalized.speakerId;
      this.queue.push(normalized);
    }
    if (!turn.finishing && !this.closed)
      throw new VoiceFailure(
        "asr_events_ended",
        "ASR event stream ended before audio input",
        { recoverable: true },
      );
  }

  private async finishTurn() {
    const turn = this.current;
    if (!turn) return;
    turn.finishing = true;
    await deadline(
      Promise.all([turn.stream.finish(), turn.events]),
      this.flushTimeoutMs,
      "Dictation final drain timed out",
      "dictation_unconfirmed",
    );
    if (turn.partialEndMs !== undefined)
      throw new VoiceFailure(
        "dictation_unconfirmed",
        "Dictation transcript remains unconfirmed",
      );
    await deadline(
      turn.stream.close(),
      1_000,
      "Dictation stream close timed out",
    );
    this.publishTurn(
      turn,
      Math.max(
        milliseconds(this.sentSamples - turn.baseSamples),
        turn.finalEndMs,
      ),
    );
    this.current = undefined;
  }

  private publishTurn(turn: Turn, endOffsetMs: number) {
    if (endOffsetMs <= turn.committedEndMs) return;
    if (
      [...turn.finals.values()].some((event) => event.endOffsetMs > endOffsetMs)
    )
      throw new VoiceFailure(
        "dictation_unconfirmed",
        "Dictation final exceeds endpoint",
      );
    const text = [...turn.finals.values()]
      .sort(
        (a, b) =>
          a.startOffsetMs - b.startOffsetMs || a.endOffsetMs - b.endOffsetMs,
      )
      .map((event) => event.text?.trim() ?? "")
      .join("\n");
    if (meaningful(text)) {
      // Ordered behind this turn's finals and before the next turn's partials.
      // TeamHub callbacks keep that order; no provider drain is needed here.
      this.queue.push({
        kind: "turn_finalized",
        text,
        startOffsetMs: milliseconds(turn.baseSamples) + turn.committedEndMs,
        endOffsetMs: milliseconds(turn.baseSamples) + endOffsetMs,
      });
    }
    turn.committedEndMs = endOffsetMs;
    turn.finals.clear();
    turn.textLength = 0;
  }

  private throwIfFailed() {
    if (this.failure) throw asError(this.failure);
    if (this.closed) throw new Error("Dictation stream is closed");
    this.signal.throwIfAborted();
  }

  private fail(error: unknown) {
    this.failure ??= error;
    this.queue.fail(this.failure);
    return this.failure;
  }

  private openProvider(): Promise<ASRStream> {
    const opening = this.provider.open(this.signal);
    return deadline(
      opening,
      5_000,
      "ASR connection timed out",
      "asr_connect_timeout",
    ).catch((error: unknown) => {
      // A provider may ignore cancellation while opening its socket. Close
      // a late result rather than leaving an unowned ASR connection behind.
      void opening.then((late) => late.close()).catch(() => undefined);
      throw error;
    });
  }
}

function meaningful(text: string) {
  return transcriptCharacters(text)
    .map(({ value }) => value)
    .join("");
}

function milliseconds(samples: number) {
  return Math.round(samples / 16);
}

async function deadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  code?: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(code ? new VoiceFailure(code, message) : new Error(message)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
