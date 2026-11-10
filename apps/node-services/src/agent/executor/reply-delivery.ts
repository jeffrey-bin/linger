import type { RunEvent } from "./provider.js";

/**
 * The Run's TeamHub message calls, as the Computer classifies them: a
 * `message` activity is a message write (`teamhub message send` and its
 * siblings), `message_read` any other `teamhub message` call, and a command
 * that exits non-zero finishes as failed.
 */
export class ReplyDelivery {
  readonly #started = new Map<string, "message" | "message_read">();
  #failedWrites = 0;
  #deliveredWrites = 0;
  #failedReads = 0;

  observe(event: RunEvent): void {
    if (event.type === "activity.started") {
      if (event.kind === "message" || event.kind === "message_read")
        this.#started.set(event.activityId, event.kind);
      return;
    }
    if (event.type !== "activity.finished") return;
    const kind = this.#started.get(event.activityId);
    if (!kind) return;
    this.#started.delete(event.activityId);
    if (kind === "message_read") {
      if (event.outcome === "failed") this.#failedReads += 1;
    } else if (event.outcome === "succeeded") {
      this.#deliveredWrites += 1;
    } else if (event.outcome === "failed") {
      this.#failedWrites += 1;
    }
  }

  /**
   * The Agent tried to post and no attempt reached the Room. An Agent that
   * never tried chose not to reply, which is not a delivery failure.
   */
  get replyUndelivered(): boolean {
    return this.#failedWrites > 0 && this.#deliveredWrites === 0;
  }

  get hasFailures(): boolean {
    return this.#failedWrites > 0 || this.#failedReads > 0;
  }

  counts(): {
    readonly failedMessageWrites: number;
    readonly deliveredMessageWrites: number;
    readonly failedMessageReads: number;
  } {
    return {
      failedMessageWrites: this.#failedWrites,
      deliveredMessageWrites: this.#deliveredWrites,
      failedMessageReads: this.#failedReads,
    };
  }
}
