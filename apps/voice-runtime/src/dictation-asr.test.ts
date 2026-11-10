import { describe, expect, it, vi } from "vitest";
import type { ASREvent, ASRStream } from "./asr.js";
import { DictationASRStream } from "./dictation-asr.js";
import { ASREventQueue } from "./event-queue.js";

class FakeStream implements ASRStream {
  readonly queue = new ASREventQueue();
  readonly frames: number[][] = [];
  finishEvents: ASREvent[] = [];
  finishBarrier?: Promise<void>;
  finishError?: Error;
  finishCalls = 0;
  finalizeCalls = 0;
  closeCalls = 0;
  async finalize() {
    this.finalizeCalls++;
  }
  async sendPCM(frame: Int16Array) {
    this.frames.push([...frame]);
  }
  async finish() {
    this.finishCalls++;
    await this.finishBarrier;
    if (this.finishError) throw this.finishError;
    for (const event of this.finishEvents) this.queue.push(event);
    this.queue.end();
  }
  async close() {
    this.closeCalls++;
    this.queue.end();
  }
  events() {
    return this.queue.events();
  }
}

function setup(flushTimeoutMs?: number) {
  const streams: FakeStream[] = [];
  const provider = {
    open: vi.fn(async () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    }),
  };
  const events: ASREvent[] = [];
  const controller = new AbortController();
  const ready = DictationASRStream.open(
    provider,
    controller.signal,
    flushTimeoutMs,
  ).then((stream) => {
    const collected = (async () => {
      for await (const event of stream.events()) events.push(event);
    })();
    void collected.catch(() => undefined);
    return { stream, collected };
  });
  return { ready, streams, provider, events, controller };
}

const pcm = (ms: number) => new Int16Array(ms * 16);
const final = (text: string, start = 0, end = 20): ASREvent => ({
  kind: "final",
  text,
  startOffsetMs: start,
  endOffsetMs: end,
});
const utteranceEnd = (at: number): ASREvent => ({
  kind: "utterance_end",
  startOffsetMs: at,
  endOffsetMs: at,
});

describe("continuous dictation turns", () => {
  it("uses a provider semantic endpoint without rotating the connection", async () => {
    const test = setup();
    const { stream, collected } = await test.ready;
    await stream.sendPCM(pcm(20));
    await stream.sendPCM(pcm(5_000));
    expect(test.streams[0]!.finishCalls).toBe(0);
    test.streams[0]!.queue.push(final("semantic turn", 0, 20));
    test.streams[0]!.queue.push(utteranceEnd(5_020));
    await vi.waitFor(() =>
      expect(test.events.some((event) => event.kind === "turn_finalized")).toBe(
        true,
      ),
    );
    expect(test.streams[0]!.finishCalls).toBe(0);
    await stream.finish();
    await collected;
    expect(
      test.events.filter((event) => event.kind === "turn_finalized"),
    ).toEqual([
      {
        kind: "turn_finalized",
        text: "semantic turn",
        startOffsetMs: 0,
        endOffsetMs: 5_020,
      },
    ]);
    expect(test.provider.open).toHaveBeenCalledOnce();
    await stream.close();
  });

  it("never finishes on idle silence and never emits empty or punctuation-only turns", async () => {
    const test = setup();
    const { stream, collected } = await test.ready;
    await stream.sendPCM(pcm(10_000));
    expect(test.streams[0]!.finishCalls).toBe(0);
    test.streams[0]!.queue.push(final("… ，。！", 0, 20));
    test.streams[0]!.queue.push(utteranceEnd(10_000));
    await stream.finish();
    await collected;
    expect(test.events.some((event) => event.kind === "turn_finalized")).toBe(
      false,
    );
    expect(test.streams[0]!.finishCalls).toBe(1);
    expect(test.provider.open).toHaveBeenCalledOnce();
    await stream.close();
  });

  it("joins only confirmed finals, not partial revisions, and deduplicates final replay", async () => {
    const test = setup();
    const { stream, collected } = await test.ready;
    await stream.sendPCM(pcm(100));
    test.streams[0]!.queue.push({ ...final("hel", 0, 50), kind: "partial" });
    test.streams[0]!.queue.push({ ...final("hello", 0, 60), kind: "partial" });
    test.streams[0]!.finishEvents = [
      final("hello", 0, 60),
      final("hello", 0, 60),
      final("world", 60, 100),
    ];
    await stream.finish();
    await collected;
    expect(
      test.events
        .filter((event) => event.kind === "final")
        .map((event) => event.text),
    ).toEqual(["hello", "world"]);
    expect(test.events.at(-1)?.text).toBe("hello\nworld");
    await stream.close();
  });

  it("deduplicates a manual commit without closing the connection", async () => {
    const test = setup();
    const { stream, collected } = await test.ready;
    await stream.sendPCM(pcm(20));
    await stream.commit("request-1");
    await stream.sendPCM(pcm(20));
    await stream.commit("request-1");
    expect(test.streams[0]!.finalizeCalls).toBe(1);
    expect(test.streams[0]!.finishCalls).toBe(0);
    await stream.finish();
    await stream.finish();
    await collected;
    expect(test.streams[0]!.finishCalls).toBe(1);
    expect(test.provider.open).toHaveBeenCalledOnce();
    await expect(stream.sendPCM(pcm(20))).rejects.toThrow("closed");
    await stream.close();
  });

  it.each(["finish-error", "unconfirmed-partial"])(
    "poisons the stream instead of sending an incomplete turn: %s",
    async (scenario) => {
      const test = setup();
      const { stream, collected } = await test.ready;
      await stream.sendPCM(pcm(100));
      const source = test.streams[0]!;
      if (scenario === "finish-error")
        source.finishError = new Error("network interrupted");
      if (scenario === "unconfirmed-partial")
        source.queue.push({ ...final("unfinished", 0, 100), kind: "partial" });
      await expect(stream.finish()).rejects.toBeInstanceOf(Error);
      await expect(collected).rejects.toBeInstanceOf(Error);
      expect(test.events.some((event) => event.kind === "turn_finalized")).toBe(
        false,
      );
      expect(test.provider.open).toHaveBeenCalledOnce();
      await stream.close();
    },
  );

  it("commits a provider revision of a finalized window instead of failing", async () => {
    const test = setup();
    const { stream, collected } = await test.ready;
    await stream.sendPCM(pcm(20));
    test.streams[0]!.finishEvents = [final("first"), final("changed")];
    await stream.finish();
    await collected;
    expect(
      test.events.filter((event) => event.kind === "final").map((e) => e.text),
    ).toEqual(["first"]);
    expect(test.events.at(-1)).toMatchObject({
      kind: "turn_finalized",
      text: "changed",
    });
  });

  it("ignores a replayed boundary without dropping a later repetition of the same words", async () => {
    const test = setup();
    const { stream, collected } = await test.ready;
    await stream.sendPCM(pcm(40));
    const source = test.streams[0]!;
    source.queue.push(final("same", 0, 20));
    source.queue.push(utteranceEnd(20));
    await vi.waitFor(() =>
      expect(
        test.events.filter((event) => event.kind === "turn_finalized"),
      ).toHaveLength(1),
    );
    source.queue.push(final("same", 0, 20));
    source.queue.push(utteranceEnd(20));
    source.queue.push(final("same", 20, 40));
    source.queue.push(utteranceEnd(40));
    await stream.finish();
    await collected;
    expect(
      test.events.filter((event) => event.kind === "turn_finalized"),
    ).toEqual([
      {
        kind: "turn_finalized",
        text: "same",
        startOffsetMs: 0,
        endOffsetMs: 20,
      },
      {
        kind: "turn_finalized",
        text: "same",
        startOffsetMs: 20,
        endOffsetMs: 40,
      },
    ]);
    expect(test.provider.open).toHaveBeenCalledOnce();
    await stream.close();
  });

  it("bounds the final drain and does not reconnect after timeout", async () => {
    vi.useFakeTimers();
    try {
      const test = setup(100);
      const { stream, collected } = await test.ready;
      await stream.sendPCM(pcm(20));
      test.streams[0]!.finishBarrier = new Promise<void>(() => undefined);
      const finished = expect(stream.finish()).rejects.toThrow(
        "Dictation final drain timed out",
      );
      await vi.advanceTimersByTimeAsync(100);
      await finished;
      await expect(collected).rejects.toThrow(
        "Dictation final drain timed out",
      );
      expect(test.events.some((event) => event.kind === "turn_finalized")).toBe(
        false,
      );
      expect(test.provider.open).toHaveBeenCalledOnce();
      await stream.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
