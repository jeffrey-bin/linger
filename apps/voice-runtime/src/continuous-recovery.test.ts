import { afterEach, describe, expect, it, vi } from "vitest";
import type { ASREvent, ASRStream } from "./asr.js";
import { ASREventQueue } from "./event-queue.js";
import { RecoveringASRStream } from "./recovering-asr.js";
import { VoiceFailure } from "./voice-failure.js";

const pcm = (ms: number) => new Int16Array(ms * 16);
const failure = () =>
  new VoiceFailure(
    "asr_closed_without_ack",
    "Soniox ASR closed before final acknowledgement",
    { recoverable: true },
  );
const progress = (ms: number): ASREvent => ({
  kind: "progress",
  startOffsetMs: 0,
  endOffsetMs: ms,
  committedThroughMs: ms,
});

function factory() {
  const streams: Array<
    ASRStream & {
      queue: ASREventQueue;
      writes: string[];
      samples: number;
    }
  > = [];
  const open = vi.fn(async () => {
    const queue = new ASREventQueue();
    const source = {
      queue,
      writes: [] as string[],
      samples: 0,
      async sendPCM(frame: Int16Array) {
        source.samples += frame.length;
        source.writes.push(`pcm:${frame.length}`);
      },
      async finalize() {
        source.writes.push(`finalize:${source.samples}`);
      },
      async finish() {
        queue.end();
      },
      async close() {
        queue.end();
      },
      events: () => queue.events(),
    };
    streams.push(source);
    return source;
  });
  return { streams, open };
}
function collect(stream: ASRStream) {
  const events: ASREvent[] = [];
  const done = (async () => {
    for await (const event of stream.events()) events.push(event);
  })();
  void done.catch(() => undefined);
  return { events, done };
}
afterEach(() => vi.useRealTimers());

describe("continuous dictation recovery", () => {
  it("replays an unacknowledged finalize at its original audio cut, before later PCM", async () => {
    const test = factory();
    const recovered = vi.fn();
    const stream = await RecoveringASRStream.open(test.open, recovered);
    const seen = collect(stream);
    try {
      await stream.sendPCM(pcm(100));
      await stream.finalize();
      await stream.sendPCM(pcm(100));
      test.streams[0]!.queue.fail(failure());
      await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce());
      expect(test.streams[1]!.writes).toEqual([
        "pcm:1600",
        "finalize:1600",
        "pcm:1600",
      ]);
      test.streams[1]!.queue.push({
        kind: "finalization_ack",
        startOffsetMs: 100,
        endOffsetMs: 100,
      });
      await vi.waitFor(() => expect(seen.events).toHaveLength(1));
      await stream.sendPCM(pcm(100));
      await stream.finalize();
      expect(test.streams[1]!.writes.at(-1)).toBe("finalize:4800");
    } finally {
      await stream.close();
      await seen.done;
    }
  });

  it("does not move an already confirmed manual cut into later replayed speech", async () => {
    const test = factory();
    const recovered = vi.fn();
    const stream = await RecoveringASRStream.open(test.open, recovered);
    const seen = collect(stream);
    try {
      await stream.sendPCM(pcm(100));
      test.streams[0]!.queue.push(progress(100));
      await vi.waitFor(() => expect(seen.events).toHaveLength(1));
      await stream.finalize();
      await stream.sendPCM(pcm(100));
      test.streams[0]!.queue.fail(failure());
      await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce());
      expect(test.streams[1]!.writes).toEqual(["pcm:1600"]);
      expect(seen.events.at(-1)).toMatchObject({
        kind: "finalization_ack",
        endOffsetMs: 100,
      });
    } finally {
      await stream.close();
      await seen.done;
    }
  });

  it("allows another transport recovery only after new confirmed audio makes progress", async () => {
    const test = factory();
    const recovered = vi.fn();
    const stream = await RecoveringASRStream.open(test.open, recovered, {
      retryAfterConfirmedMs: 100,
    });
    const seen = collect(stream);
    try {
      await stream.sendPCM(pcm(100));
      test.streams[0]!.queue.fail(failure());
      await vi.waitFor(() => expect(recovered).toHaveBeenCalledTimes(1));
      await stream.sendPCM(pcm(100));
      test.streams[1]!.queue.push(progress(200));
      await vi.waitFor(() => expect(seen.events).toHaveLength(1));
      test.streams[1]!.queue.fail(failure());
      await vi.waitFor(() => expect(recovered).toHaveBeenCalledTimes(2));
      expect(test.open).toHaveBeenCalledTimes(3);
    } finally {
      await stream.close();
      await seen.done;
    }
  });

  it("does not renew the recovery budget for replayed audio alone", async () => {
    const test = factory();
    const recovered = vi.fn();
    const stream = await RecoveringASRStream.open(test.open, recovered, {
      retryAfterConfirmedMs: 100,
    });
    const seen = collect(stream);
    try {
      await stream.sendPCM(pcm(100));
      test.streams[0]!.queue.fail(failure());
      await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce());
      test.streams[1]!.queue.push(progress(100));
      await vi.waitFor(() => expect(seen.events).toHaveLength(1));
      const rejected = expect(seen.done).rejects.toThrow(
        "closed before final acknowledgement",
      );
      test.streams[1]!.queue.fail(failure());
      await rejected;
      expect(test.open).toHaveBeenCalledTimes(2);
    } finally {
      await stream.close();
      await seen.done.catch(() => undefined);
    }
  });

  it.each([false, true])(
    "rotates at a safe endpoint or a hard deadline (hard: %s)",
    async (hard) => {
      vi.useFakeTimers();
      const test = factory();
      const recovered = vi.fn();
      const stream = await RecoveringASRStream.open(test.open, recovered, {
        rotateAfterMs: 1_000,
      });
      const seen = collect(stream);
      try {
        await stream.sendPCM(pcm(100));
        test.streams[0]!.queue.push(progress(100));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(test.open).toHaveBeenCalledOnce();
        if (hard) await vi.advanceTimersByTimeAsync(60_000);
        else {
          test.streams[0]!.queue.push({
            kind: "utterance_end",
            startOffsetMs: 100,
            endOffsetMs: 100,
          });
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(recovered).toHaveBeenCalledOnce();
        expect(test.open).toHaveBeenCalledTimes(2);
        await stream.sendPCM(pcm(100));
        test.streams[1]!.queue.push({
          kind: "final",
          text: "next",
          startOffsetMs: 0,
          endOffsetMs: 100,
        });
        await stream.finish();
        await seen.done;
        expect(seen.events.at(-1)).toMatchObject({
          kind: "final",
          startOffsetMs: 100,
          endOffsetMs: 200,
        });
      } finally {
        await stream.close();
        await seen.done;
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
