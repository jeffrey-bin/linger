import { asrEventBytes, type ASREvent } from "./asr.js";
import { asError } from "@linger/service-kit";
import { VoiceFailure } from "./voice-failure.js";

export class ASREventQueue {
  private pending: ASREvent[] = [];
  private bytes = 0;
  private readonly waiters: Array<() => void> = [];
  private ended = false;
  private error?: unknown;
  private latestTextEndMs = -1;
  private latestFinalEndMs = -1;

  constructor(
    private readonly maxEvents = 256,
    private readonly maxBytes = 1 << 20,
  ) {}

  push(event: ASREvent) {
    if (this.ended) return;
    if (
      event.kind === "partial" &&
      (event.endOffsetMs < this.latestTextEndMs ||
        event.endOffsetMs <= this.latestFinalEndMs)
    )
      return;
    if (event.kind !== "progress")
      this.latestTextEndMs = Math.max(this.latestTextEndMs, event.endOffsetMs);
    if (event.kind === "final")
      this.latestFinalEndMs = Math.max(
        this.latestFinalEndMs,
        event.endOffsetMs,
      );
    // Hypotheses are replaceable; accepted finals and their progress stay ordered.
    this.pending = this.pending.filter((prior) => {
      const superseded =
        (prior.kind === "partial" &&
          event.kind !== "progress" &&
          prior.endOffsetMs <= event.endOffsetMs) ||
        (prior.kind === "progress" && event.kind === "progress");
      if (superseded) this.bytes -= asrEventBytes(prior);
      return !superseded;
    });
    const size = asrEventBytes(event);
    if (
      this.pending.length >= this.maxEvents ||
      this.bytes + size > this.maxBytes
    ) {
      this.fail(
        new VoiceFailure("asr_event_backlog", "ASR event backlog exceeded"),
      );
      return;
    }
    this.pending.push(event);
    this.bytes += size;
    this.wake();
  }

  fail(error: unknown) {
    if (this.ended) return;
    this.error = error;
    this.pending = [];
    this.bytes = 0;
    this.end();
  }

  end() {
    this.ended = true;
    this.wake();
  }

  async *events(): AsyncIterable<ASREvent> {
    while (!this.ended || this.pending.length > 0) {
      const event = this.pending.shift();
      if (event) {
        this.bytes -= asrEventBytes(event);
        yield event;
      } else {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
    if (this.error) throw asError(this.error);
  }

  private wake() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
