import { describe, expect, it } from "vitest";

import { ASREventQueue } from "./event-queue.js";

describe("ASR event backpressure", () => {
  it("counts mapped words in its byte budget and releases them when consumed or replaced", async () => {
    const queue = new ASREventQueue(256, 40);
    const event = {
      kind: "partial" as const,
      startOffsetMs: 0,
      endOffsetMs: 1,
      text: "a",
      words: [{ startOffsetMs: 0, endOffsetMs: 1, textStart: 0, textEnd: 1 }],
    };
    queue.push(event);
    queue.push({ ...event, endOffsetMs: 2 });
    const iterator = queue.events()[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.endOffsetMs).toBe(2);
    queue.push({ ...event, kind: "final" });
    expect((await iterator.next()).value?.kind).toBe("final");
    queue.push({
      ...event,
      kind: "final",
      words: [...event.words, ...event.words],
    });
    await expect(iterator.next()).rejects.toThrow("ASR event backlog exceeded");
  });

  it("coalesces transient hypotheses without reordering a final", async () => {
    const queue = new ASREventQueue(4);
    for (let end = 1; end <= 10_000; end++) {
      queue.push({
        kind: "partial",
        startOffsetMs: 0,
        endOffsetMs: end,
        text: "hypothesis",
      });
    }
    queue.push({
      kind: "final",
      startOffsetMs: 0,
      endOffsetMs: 10_000,
      text: "accepted",
    });
    queue.push({
      kind: "progress",
      startOffsetMs: 0,
      endOffsetMs: 10_000,
      committedThroughMs: 10_000,
    });
    queue.end();
    const received = [];
    for await (const event of queue.events()) received.push(event);
    expect(received.map((event) => event.kind)).toEqual(["final", "progress"]);
  });

  it("fails promptly on final overflow instead of silently losing accepted speech", async () => {
    const queue = new ASREventQueue(2);
    for (let start = 0; start < 3; start++)
      queue.push({
        kind: "final",
        startOffsetMs: start,
        endOffsetMs: start + 1,
        text: "speech",
      });
    await expect(queue.events()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "ASR event backlog exceeded",
    );
  });

  it("limits payload bytes as well as event count", async () => {
    const queue = new ASREventQueue(256, 16);
    queue.push({
      kind: "partial",
      startOffsetMs: 0,
      endOffsetMs: 1,
      text: "a".repeat(17),
    });
    await expect(queue.events()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "ASR event backlog exceeded",
    );
  });
});
