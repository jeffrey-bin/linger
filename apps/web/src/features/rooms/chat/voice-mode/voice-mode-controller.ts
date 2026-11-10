import { VoiceModeDisconnectedError } from "./voice-mode-errors";

export type VoiceModeEvent =
  | { kind: "partial"; text: string; endOffsetMs: number }
  | { kind: "speech" | "turn"; id: string; text: string; endOffsetMs: number };

export interface VoiceModeState {
  status: "idle" | "connecting" | "listening" | "closing" | "paused" | "error";
  /** Everything heard and not yet sent: `heardText`, then `speakingText`. */
  text: string;
  /** Finished turns still waiting to be sent. */
  heardText?: string;
  /** What the Human is saying now. */
  speakingText?: string;
  sending: boolean;
  flushing: boolean;
  microphoneActive?: boolean;
  error?: string;
  canRetry?: boolean;
}

export interface VoiceModeConnection {
  commit(): Promise<void>;
  close(): Promise<void>;
  setMuted?(muted: boolean): Promise<void>;
}

export interface VoiceModeMicrophone {
  setMuted(muted: boolean): Promise<void>;
}

/**
 * `keepsText` marks a send that first waits before the turn reaches the
 * outbox (live Voice Mode waits for its verdict), so the words stay shown.
 */
type TurnSend = (() => Promise<void>) & { keepsText?: boolean };
interface Turn {
  id: string;
  text: string;
  send?: TurnSend;
}

/**
 * A transport failure after which the session reopens at once, keeping the
 * unsent text; live Voice Mode uses it to fall back to dictation.
 */
export class VoiceModeReopen extends Error {}
const maximumQueuedTurns = 8;
const maximumTextLength = 50_000;

/** Owns text/turn delivery only. The Runtime, not a browser timer, ends a turn. */
export class VoiceModeController {
  private state: VoiceModeState = {
    status: "idle",
    text: "",
    sending: false,
    flushing: false,
  };
  private connection?: VoiceModeConnection;
  private microphone?: VoiceModeMicrophone;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private automatic = false;
  private generation = 0;
  private finalizedThrough = -1;
  private readonly speech = new Map<
    string,
    { text: string; endOffsetMs: number }
  >();
  private partial = { text: "", endOffsetMs: -1 };
  private carriedText = "";
  private inFlightId?: string;
  private deliveryCompletion: Promise<void> = Promise.resolve();
  private deliveryFailed = false;
  private readonly seen = new Set<string>();
  private readonly queue: Turn[] = [];
  private readonly listeners = new Set<(state: VoiceModeState) => void>();
  private muted = false;
  private recoveryAttempts = 0;
  private recoveryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly options: {
      open: (
        receive: (event: VoiceModeEvent) => void,
        fail: (error: unknown) => void,
        microphone: (microphone: VoiceModeMicrophone | undefined) => void,
      ) => Promise<VoiceModeConnection>;
      send: (turn: Turn) => Promise<void>;
      prepareSend?: (turn: Turn) => TurnSend;
    },
  ) {}

  getState() {
    return this.state;
  }
  whenDeliverySettles() {
    return this.deliveryCompletion;
  }
  subscribe(listener: (state: VoiceModeState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.closing) return this.closing.then(() => this.start());
    if (this.state.error) return Promise.resolve();
    if (this.state.status === "listening") return Promise.resolve();
    const generation = ++this.generation;
    this.automatic = true;
    this.finalizedThrough = -1;
    this.carriedText = [
      this.carriedText,
      ...[...this.speech.values()].map((part) => part.text),
      this.partial.text,
    ]
      .filter(Boolean)
      .join("\n");
    this.speech.clear();
    this.partial = { text: "", endOffsetMs: -1 };
    this.microphone = undefined;
    this.publish({
      status: "connecting",
      microphoneActive: false,
      error: undefined,
    });
    const operation = (async () => {
      try {
        await this.closing;
        if (!this.automatic || generation !== this.generation) return;
        const connection = await this.options.open(
          (event) => {
            if (generation === this.generation) this.receive(event);
          },
          (error) => {
            if (generation === this.generation) this.fail(error);
          },
          (microphone) => {
            if (generation !== this.generation) return;
            if (microphone && !this.automatic) return;
            this.microphone = microphone;
            this.publish({ microphoneActive: Boolean(microphone) });
            if (microphone && this.muted)
              void microphone.setMuted(true).catch((error: unknown) => {
                if (generation === this.generation) this.fail(error);
              });
          },
        );
        this.connection = connection;
        if (!this.automatic || generation !== this.generation) {
          await connection.close();
          if (this.connection === connection) this.connection = undefined;
          return;
        }
        if (this.muted) await connection.setMuted?.(true);
        this.recoveryAttempts = 0;
        this.publish({ status: "listening" });
        void this.deliver();
      } catch (error) {
        this.fail(error);
      }
    })();
    this.opening = operation;
    void operation.finally(() => {
      if (this.opening === operation) this.opening = undefined;
    });
    return operation;
  }

  async commit() {
    if (this.state.status === "paused" && this.queue.length)
      return this.deliver(true);
    if (!this.connection || this.state.flushing || !this.automatic) return;
    this.publish({ flushing: true });
    try {
      await this.connection.commit();
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ flushing: false });
    }
  }

  /** Disable automatic sends synchronously before waiting for trailing finals. */
  pause(): Promise<void> {
    this.automatic = false;
    this.recoveryAttempts = 0;
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    if (this.closing) return this.closing;
    this.microphone = undefined;
    this.publish({ status: "closing", microphoneActive: false });
    const operation = (async () => {
      try {
        // The transport cuts the physical track before its bounded final drain.
        await this.connection?.close();
        await this.opening;
        this.publish({ status: "paused", flushing: false });
      } catch (error) {
        this.publish({
          status: "error",
          error: describe(error),
          flushing: false,
        });
      } finally {
        this.connection = undefined;
      }
    })();
    this.closing = operation;
    void operation.finally(() => {
      if (this.closing === operation) this.closing = undefined;
    });
    return operation;
  }

  async retry() {
    if (!this.state.canRetry) return;
    this.publish({ error: undefined });
    await this.deliver(true);
  }

  async setMuted(muted: boolean) {
    this.muted = muted;
    await (this.microphone ?? this.connection)?.setMuted?.(muted);
  }

  private receive(event: VoiceModeEvent) {
    if (event.kind === "partial") {
      if (
        event.endOffsetMs > this.finalizedThrough &&
        event.endOffsetMs >= this.partial.endOffsetMs
      )
        this.partial = { text: event.text, endOffsetMs: event.endOffsetMs };
    } else {
      if (this.seen.has(event.id)) return;
      // IDs are bounded by the lifetime of this explicitly opened session.
      if (this.seen.size >= 4_000) {
        this.fail(
          new Error(
            "Voice Mode reached its session limit. Exit and start again.",
          ),
        );
        return;
      }
      this.seen.add(event.id);
      if (event.kind === "speech") {
        if (event.endOffsetMs > this.finalizedThrough)
          this.speech.set(event.id, event);
        if (this.partial.endOffsetMs <= event.endOffsetMs)
          this.partial = { text: "", endOffsetMs: event.endOffsetMs };
      } else {
        this.finalizedThrough = Math.max(
          this.finalizedThrough,
          event.endOffsetMs,
        );
        for (const [id, value] of this.speech)
          if (value.endOffsetMs <= event.endOffsetMs) this.speech.delete(id);
        if (this.partial.endOffsetMs <= event.endOffsetMs)
          this.partial = { text: "", endOffsetMs: event.endOffsetMs };
        if (event.text.trim()) {
          const turn: Turn = {
            id: event.id,
            text: [this.carriedText, event.text.trim()]
              .filter(Boolean)
              .join("\n"),
          };
          // Freeze explicit reference context at acceptance, not when a slow
          // previous message finally releases the sending queue.
          if (this.options.prepareSend)
            turn.send = this.options.prepareSend(turn);
          this.queue.push(turn);
          this.carriedText = "";
        }
      }
    }
    this.publish({});
    if (
      this.queue.length >= maximumQueuedTurns ||
      this.state.text.length > maximumTextLength
    ) {
      this.fail(
        new Error(
          "Voice input is ahead of message delivery. Your draft is kept; retry or exit to review it.",
        ),
      );
      return;
    }
    // Transcript events may arrive while the transport is still completing its
    // readiness handshake. Keep them in the queue, but wait for the connection
    // before attempting to send the turn.
    if (this.connection && this.automatic && !this.state.error)
      void this.deliver();
  }

  private async deliver(manualRetry = false) {
    if (this.state.sending || (!this.automatic && !manualRetry)) return;
    let done!: () => void;
    this.deliveryCompletion = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.publish({ sending: true });
    try {
      await this.deliverHead(manualRetry, maximumQueuedTurns);
    } catch (error) {
      this.deliveryFailed = true;
      this.fail(error);
    } finally {
      this.inFlightId = undefined;
      this.publish({ sending: false });
      done();
    }
    if (this.automatic && !this.state.error && this.queue.length)
      void this.deliver();
  }

  private async deliverHead(
    manualRetry: boolean,
    remaining: number,
  ): Promise<void> {
    if (
      remaining === 0 ||
      !this.queue.length ||
      (!this.automatic && !manualRetry)
    )
      return;
    // A later turn cannot overtake an unresolved Chat/outbox command. Limit
    // each pump to the queue budget so continuous input cannot grow a chain.
    const turn = this.queue[0]!;
    this.inFlightId = turn.id;
    this.publish({});
    await (turn.send ? turn.send() : this.options.send(turn));
    this.queue.shift();
    this.inFlightId = undefined;
    this.publish({});
    return this.deliverHead(manualRetry, remaining - 1);
  }

  private fail(error: unknown) {
    const connection = this.connection;
    this.connection = undefined;
    this.microphone = undefined;
    if (
      this.automatic &&
      !this.closing &&
      isRecoverableVoiceError(error) &&
      this.recoveryAttempts < 3
    ) {
      this.recoveryAttempts += 1;
      const operation =
        connection?.close().catch(() => undefined) ?? Promise.resolve();
      this.closing = operation;
      this.publish({
        status: "connecting",
        microphoneActive: false,
        error: undefined,
      });
      void operation.then(() => {
        if (this.closing === operation) this.closing = undefined;
        if (!this.automatic) return;
        this.recoveryTimer = setTimeout(() => {
          this.recoveryTimer = undefined;
          void this.start();
        }, 100);
      });
      return;
    }
    this.automatic = false;
    this.publish({
      status: "error",
      microphoneActive: false,
      error: describe(error),
    });
    if (connection && !this.closing) {
      const operation = connection.close().catch(() => undefined);
      this.closing = operation;
      void operation.finally(() => {
        if (this.closing === operation) this.closing = undefined;
      });
    }
  }

  private publish(update: Partial<VoiceModeState>) {
    const queuedText: string[] = [];
    for (const turn of this.queue)
      if (turn.id !== this.inFlightId || turn.send?.keepsText)
        queuedText.push(turn.text);
    // Submitted text is retained by the ordinary durable outbox, not also
    // copied into an editable draft while its result is still unknown.
    const heardText = queuedText.filter(Boolean).join("\n");
    const speakingText = [
      this.carriedText,
      ...[...this.speech.values()].map((part) => part.text),
      this.partial.text,
    ]
      .filter(Boolean)
      .join("\n");
    this.state = {
      ...this.state,
      ...update,
      text: [heardText, speakingText].filter(Boolean).join("\n"),
      heardText,
      speakingText,
      canRetry:
        this.deliveryFailed &&
        Boolean(update.error ?? this.state.error) &&
        this.queue.length > 0,
    };
    for (const listener of this.listeners) listener(this.state);
  }
}

function isRecoverableVoiceError(error: unknown) {
  return (
    error instanceof VoiceModeReopen ||
    error instanceof VoiceModeDisconnectedError
  );
}

function describe(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Voice Mode could not continue. Your text has been kept.";
}
