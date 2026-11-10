import { describe, expect, it, vi } from "vitest";

import type { ASREvent, ASRStream } from "./asr.js";
import { ASREventQueue } from "./event-queue.js";
import { RecoveringASRStream } from "./recovering-asr.js";
import { VoiceFailure } from "./voice-failure.js";

const recoverable = (code: string, message: string) =>
  new VoiceFailure(code, message, { recoverable: true });

const transportFailure = () =>
  recoverable("asr_write_timeout", "Soniox ASR audio write timed out");

describe("ASR transport recovery", () => {
  it("keeps the coverage origin stable after replaying a confirmed prefix", async () => {
    let connections = 0;
    const stream = await RecoveringASRStream.open(async () => {
      const attempt = connections++;
      const queue = new ASREventQueue();
      let samples = 0;
      return {
        events: () => queue.events(),
        async sendPCM(frame) {
          samples += frame.length;
          if (attempt === 0 && samples > 1600) throw transportFailure();
          queue.push({
            kind: "progress",
            startOffsetMs: 0,
            endOffsetMs: samples / 16,
            committedThroughMs: samples / 16,
          });
        },
        async finish() {
          queue.end();
        },
        async close() {
          queue.end();
        },
      };
    });
    const seen: ASREvent[] = [];
    const events = (async () => {
      for await (const event of stream.events()) seen.push(event);
    })();
    try {
      await stream.sendPCM(new Int16Array(1600));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      await stream.sendPCM(new Int16Array(1600));
      await stream.finish();
      await events;
      expect(seen).toEqual([
        {
          kind: "progress",
          startOffsetMs: 0,
          endOffsetMs: 100,
          committedThroughMs: 100,
        },
        {
          kind: "progress",
          startOffsetMs: 0,
          endOffsetMs: 200,
          committedThroughMs: 200,
        },
      ]);
      expect(connections).toBe(2);
    } finally {
      await stream.close();
      await events.catch(() => undefined);
    }
  });

  it("fails explicitly when replay conflicts with a final already accepted", async () => {
    let connections = 0;
    const stream = await RecoveringASRStream.open(async () => {
      const attempt = connections++;
      const queue = new ASREventQueue();
      return {
        events: () => queue.events(),
        async sendPCM() {
          queue.push(
            attempt === 0
              ? final(40, 80, "accepted later sentence")
              : final(0, 100, "changed combined sentence"),
          );
        },
        async finish() {
          if (attempt === 0) queue.fail(transportFailure());
          else queue.end();
        },
        async close() {
          queue.end();
        },
      };
    });
    const received: ASREvent[] = [];
    const outcome = (async () => {
      for await (const event of stream.events()) received.push(event);
    })();
    const failed = expect(outcome).rejects.toThrow(
      "ASR final overlaps with an accepted final",
    );
    try {
      await stream.sendPCM(new Int16Array(1600));
      await vi.waitFor(() => expect(received).toHaveLength(1));
      await stream.finish();
      await failed;
      expect(received.map((event) => event.text)).toEqual([
        "accepted later sentence",
      ]);
      expect(connections).toBe(2);
    } finally {
      await stream.close();
    }
  });

  it("does not retry provider rejection, an overloaded consumer, or untyped errors", async () => {
    for (const failure of [
      new VoiceFailure(
        "asr_provider_401",
        "Soniox ASR rejected the stream with code 401",
      ),
      new VoiceFailure("asr_event_backlog", "ASR event backlog exceeded"),
      // Recovery follows the typed failure, never matching message text.
      new Error("Soniox ASR stream is closed"),
    ]) {
      const { message } = failure;
      const queue = new ASREventQueue();
      const factory = vi.fn(
        async (): Promise<ASRStream> => ({
          events: () => queue.events(),
          async sendPCM() {
            queue.fail(failure);
            throw failure;
          },
          async finish() {
            queue.end();
          },
          async close() {
            queue.end();
          },
        }),
      );
      const stream = await RecoveringASRStream.open(factory);
      const failed = expect(collect(stream)).rejects.toThrow(message);
      try {
        await expect(stream.sendPCM(new Int16Array(320))).rejects.toThrow(
          message,
        );
        await failed;
        expect(factory).toHaveBeenCalledOnce();
      } finally {
        await stream.close();
      }
    }
  });

  it("bounds retained PCM even when no final utterance is committed", async () => {
    const queue = new ASREventQueue();
    const stream = await RecoveringASRStream.open(async () => ({
      events: () => queue.events(),
      async sendPCM() {},
      async finish() {
        queue.end();
      },
      async close() {
        queue.end();
      },
    }));
    const failed = expect(collect(stream)).rejects.toThrow(
      "recovery buffer exceeded",
    );
    try {
      await expect(
        stream.sendPCM(new Int16Array(16_000 * 65 + 1)),
      ).rejects.toThrow("recovery buffer exceeded");
      await failed;
    } finally {
      await stream.close();
    }
  });

  it("releases finalized audio through explicit committed progress without treating interim progress as durable", async () => {
    const queue = new ASREventQueue();
    let samples = 0;
    const stream = await RecoveringASRStream.open(async () => ({
      events: () => queue.events(),
      async sendPCM(frame) {
        samples += frame.length;
        const endMs = samples / 16;
        queue.push({
          kind: "progress",
          startOffsetMs: 0,
          endOffsetMs: endMs,
          ...(samples % 16_000 === 0 ? { committedThroughMs: endMs } : {}),
        });
      },
      async finish() {
        queue.end();
      },
      async close() {
        queue.end();
      },
    }));
    const events = collect(stream);
    try {
      for (let second = 0; second < 130; second += 1) {
        for (let frame = 0; frame < 50; frame += 1)
          await stream.sendPCM(new Int16Array(320));
      }
      await stream.finish();
      const received = await events;
      expect(
        received.filter((event) => event.kind === "progress").length,
      ).toBeGreaterThan(0);
      expect(received.at(-1)?.committedThroughMs).toBe(130_000);
    } finally {
      await stream.close();
    }
  });

  it("closes a late replacement after its recovery deadline expires", async () => {
    vi.useFakeTimers();
    const queue = new ASREventQueue();
    let release!: (stream: ASRStream) => void;
    const replacement = new Promise<ASRStream>((resolve) => {
      release = resolve;
    });
    const lateClose = vi.fn(async () => undefined);
    let connections = 0;
    const stream = await RecoveringASRStream.open(async () => {
      if (connections++ > 0) return replacement;
      return {
        events: () => queue.events(),
        async sendPCM() {
          const error = transportFailure();
          queue.fail(error);
          throw error;
        },
        async finish() {
          queue.end();
        },
        async close() {
          queue.end();
        },
      };
    });
    const failedEvents = expect(collect(stream)).rejects.toThrow(
      "recovery timed out",
    );
    const failedSend = expect(
      stream.sendPCM(new Int16Array(320)),
    ).rejects.toThrow("recovery timed out");
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await failedEvents;
      await failedSend;
      release({
        events: () => queue.events(),
        async sendPCM() {},
        async finish() {},
        close: lateClose,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(lateClose).toHaveBeenCalledOnce();
      expect(connections).toBe(2);
    } finally {
      await stream.close();
      vi.useRealTimers();
    }
  });

  it.each([
    [
      "asr_closed_without_ack",
      "Soniox ASR closed before final acknowledgement",
    ],
    ["asr_transport_timeout", "Soniox ASR transport timed out"],
    ["asr_write_timeout", "Soniox ASR audio write timed out"],
    ["asr_socket_closing", "Soniox ASR socket is closing"],
    ["asr_socket_closed", "Soniox ASR socket is closed"],
  ])("replays unconfirmed PCM once after %s", async (code, failureMessage) => {
    let connections = 0;
    const resent: number[] = [];
    const recovered = vi.fn();
    const stream = await RecoveringASRStream.open(async () => {
      const attempt = connections++;
      const queue = new ASREventQueue();
      let samples = 0;
      return {
        events: () => queue.events(),
        async sendPCM(frame) {
          samples += frame.length;
          if (attempt === 0) {
            if (samples === 1600) queue.push(final(0, 100, "first"));
            if (samples === 4800) {
              const error = recoverable(code, failureMessage);
              queue.fail(error);
              throw error;
            }
          } else resent.push(...frame);
        },
        async finish() {
          queue.push(final(0, samples / 16, "tail"));
          queue.end();
        },
        async close() {
          queue.end();
        },
      };
    }, recovered);
    const events = collect(stream);
    try {
      for (let index = 1; index <= 4; index++)
        await stream.sendPCM(new Int16Array(1600).fill(index));
      await stream.finish();
      expect(await events).toEqual([
        final(0, 100, "first"),
        final(100, 400, "tail"),
      ]);
      expect(resent).toEqual(
        [2, 3, 4].flatMap((value) => Array<number>(1600).fill(value)),
      );
      expect(recovered).toHaveBeenCalledOnce();
      expect(connections).toBe(2);
    } finally {
      await stream.close();
      await events.catch(() => undefined);
    }
  });

  it("retranscribes the final tail when the final acknowledgement is lost", async () => {
    let connections = 0;
    let resentSamples = 0;
    const stream = await RecoveringASRStream.open(async () => {
      const attempt = connections++;
      const queue = new ASREventQueue();
      let samples = 0;
      return {
        events: () => queue.events(),
        async sendPCM(frame) {
          samples += frame.length;
          if (attempt === 0) queue.push(final(0, 80, "confirmed"));
          else resentSamples += frame.length;
        },
        async finish() {
          if (attempt === 0)
            queue.fail(
              recoverable(
                "asr_final_ack_timeout",
                "Soniox ASR final acknowledgement timed out",
              ),
            );
          else {
            queue.push(final(0, samples / 16, "last"));
            queue.end();
          }
        },
        async close() {
          queue.end();
        },
      };
    });
    const events = collect(stream);
    try {
      await stream.sendPCM(new Int16Array(1600));
      await stream.finish();
      expect(await events).toEqual([
        final(0, 80, "confirmed"),
        final(80, 100, "last"),
      ]);
      expect(connections).toBe(2);
      expect(resentSamples).toBe(320);
    } finally {
      await stream.close();
      await events.catch(() => undefined);
    }
  });

  it("fails after its one transport recovery attempt also fails", async () => {
    const factory = vi.fn(async (): Promise<ASRStream> => {
      const queue = new ASREventQueue();
      return {
        events: () => queue.events(),
        async sendPCM() {
          const error = transportFailure();
          queue.fail(error);
          throw error;
        },
        async finish() {},
        async close() {
          queue.end();
        },
      };
    });
    const stream = await RecoveringASRStream.open(factory);
    const failed = expect(collect(stream)).rejects.toThrow("write timed out");
    try {
      await expect(stream.sendPCM(new Int16Array(1600))).rejects.toThrow(
        "write timed out",
      );
      await failed;
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      await stream.close();
    }
  });

  it.each([
    ["asr_write_timeout", "Soniox ASR audio write timed out"],
    ["asr_transport_timeout", "Soniox ASR transport timed out"],
  ])(
    "serializes %s with the next submitted PCM frame",
    async (code, message) => {
      let firstQueue!: ASREventQueue;
      let attempts = 0;
      let resentSamples = 0;
      const stream = await RecoveringASRStream.open(async () => {
        const attempt = attempts++;
        const queue = new ASREventQueue();
        if (attempt === 0) firstQueue = queue;
        return {
          events: () => queue.events(),
          async sendPCM(frame) {
            if (attempt > 0) resentSamples += frame.length;
          },
          async finish() {
            queue.end();
          },
          async close() {
            queue.end();
          },
        };
      });
      const events = collect(stream);
      try {
        firstQueue.fail(recoverable(code, message));
        await Promise.resolve();
        await stream.sendPCM(new Int16Array(1600));
        await stream.finish();
        await events;
        expect(attempts).toBe(2);
        expect(resentSamples).toBe(1600);
      } finally {
        await stream.close();
        await events.catch(() => undefined);
      }
    },
  );
});

function final(
  startOffsetMs: number,
  endOffsetMs: number,
  text: string,
): ASREvent {
  return { kind: "final", startOffsetMs, endOffsetMs, text };
}

async function collect(stream: ASRStream) {
  const events: ASREvent[] = [];
  for await (const event of stream.events()) events.push(event);
  return events;
}
