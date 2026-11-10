import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { ASREvent } from "./asr.js";
import { DictationASRStream } from "./dictation-asr.js";
import { SonioxASRProvider } from "./soniox.js";

const pcm = (ms: number) => new Int16Array(ms * 16);
const token = (
  text: string,
  start_ms: number,
  end_ms: number,
  is_final = true,
) => ({ text, start_ms, end_ms, is_final });
const end = { text: "<end>", is_final: true };
const fin = { text: "<fin>", is_final: true };

async function setup() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server port");
  const sockets: WebSocket[] = [];
  const controls: string[] = [];
  const frames: number[] = [];
  let audioEnds = 0;
  server.on("connection", (socket) => {
    sockets.push(socket);
    let samples = 0;
    socket.on("message", (raw, binary) => {
      if (binary) {
        samples += Buffer.from(raw as Buffer).byteLength / 2;
        frames.push(samples);
      } else if ((raw as Buffer).toString() === "") {
        audioEnds++;
        socket.send(
          JSON.stringify({
            finished: true,
            tokens: [],
            total_audio_proc_ms: samples / 16,
            final_audio_proc_ms: samples / 16,
          }),
        );
      } else {
        const message = JSON.parse((raw as Buffer).toString()) as {
          type?: string;
        };
        if (message.type) controls.push(message.type);
      }
    });
  });
  const provider = new SonioxASRProvider({
    apiKey: "test-only",
    model: "stt-rt-v5",
    dictation: true,
    webSocketUrl: `ws://127.0.0.1:${address.port}`,
  });
  const stream = await DictationASRStream.open(
    provider,
    new AbortController().signal,
  );
  const events: ASREvent[] = [];
  const collected = (async () => {
    for await (const event of stream.events()) events.push(event);
  })();
  void collected.catch(() => undefined);
  return {
    stream,
    events,
    collected,
    sockets,
    controls,
    frames,
    get audioEnds() {
      return audioEnds;
    },
    turns: () => events.filter((event) => event.kind === "turn_finalized"),
    send(tokens: unknown[], processed = 500) {
      sockets.at(-1)!.send(
        JSON.stringify({
          tokens,
          total_audio_proc_ms: processed,
          final_audio_proc_ms: processed,
        }),
      );
    },
    async close() {
      await stream.close();
      await collected.catch(() => undefined);
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("Soniox continuous dictation", () => {
  it("commits an endpoint without end-of-audio, reconnecting, or delaying the next PCM", async () => {
    const test = await setup();
    try {
      await test.stream.sendPCM(pcm(400));
      test.send([token("first", 0, 100), end], 400);
      await vi.waitFor(() => expect(test.turns()).toHaveLength(1));
      await test.stream.sendPCM(pcm(100));
      await vi.waitFor(() => expect(test.frames).toHaveLength(2));
      expect(test.audioEnds).toBe(0);
      expect(test.sockets).toHaveLength(1);
      expect(test.turns()[0]).toMatchObject({
        text: "first",
        endOffsetMs: 100,
      });
      test.send([token("next", 400, 500, false)]);
      await vi.waitFor(() =>
        expect(
          test.events.filter((event) => event.kind === "partial").at(-1)?.text,
        ).toBe("next"),
      );
    } finally {
      await test.close();
    }
  });

  it("preserves every boundary and the next partial in one provider packet", async () => {
    const test = await setup();
    try {
      await test.stream.sendPCM(pcm(500));
      test.send([
        token("One.", 0, 100),
        end,
        token("Two.", 120, 200),
        end,
        token("Third sentence", 220, 400, false),
      ]);
      await vi.waitFor(() =>
        expect(test.turns().map((event) => event.text)).toEqual([
          "One.",
          "Two.",
        ]),
      );
      expect(test.turns().map((event) => event.endOffsetMs)).toEqual([
        100, 200,
      ]);
      expect(
        test.events.filter((event) => event.kind === "partial").at(-1),
      ).toMatchObject({ text: "Third sentence", endOffsetMs: 400 });
      expect(test.audioEnds).toBe(0);
    } finally {
      await test.close();
    }
  });

  it("keeps streaming while a manual finalize acknowledgement is delayed", async () => {
    const test = await setup();
    try {
      await test.stream.sendPCM(pcm(100));
      await test.stream.commit("manual-1");
      await test.stream.commit("manual-1");
      await test.stream.commit("coalesced-click");
      await test.stream.sendPCM(pcm(100));
      await vi.waitFor(() => expect(test.frames).toHaveLength(2));
      expect(test.controls).toEqual(["finalize"]);
      expect(test.audioEnds).toBe(0);
      expect(test.turns()).toEqual([]);
      test.send(
        [
          token("before click", 0, 100),
          fin,
          token("after click", 100, 200, false),
        ],
        200,
      );
      await vi.waitFor(() => expect(test.turns()).toHaveLength(1));
      expect(test.turns()[0]).toMatchObject({
        text: "before click",
        endOffsetMs: 100,
      });
      expect(
        test.events.filter((event) => event.kind === "partial").at(-1)?.text,
      ).toBe("after click");
      test.send([token("after click", 100, 200)], 200);
      await test.stream.finish();
      await test.collected;
      expect(test.turns().map((event) => event.text)).toEqual([
        "before click",
        "after click",
      ]);
      expect(test.audioEnds).toBe(1);
      expect(test.sockets).toHaveLength(1);
    } finally {
      await test.close();
    }
  });

  it("does not duplicate a turn when automatic and manual boundaries coincide", async () => {
    const test = await setup();
    try {
      await test.stream.sendPCM(pcm(100));
      await test.stream.commit("click");
      test.send([token("one", 0, 100), end, fin], 100);
      await vi.waitFor(() => expect(test.turns()).toHaveLength(1));
      await test.stream.sendPCM(pcm(100));
      await test.stream.commit("click");
      test.send([token("two", 100, 200), end], 200);
      await vi.waitFor(() => expect(test.turns()).toHaveLength(2));
      expect(test.turns().map((event) => event.text)).toEqual(["one", "two"]);
      expect(test.controls).toEqual(["finalize"]);
      expect(test.audioEnds).toBe(0);
    } finally {
      await test.close();
    }
  });

  it("stops with the last confirmed tail exactly once without opening a successor", async () => {
    const test = await setup();
    try {
      await test.stream.sendPCM(pcm(200));
      test.send([token("first", 0, 100), end, token("tail", 100, 200)], 200);
      await vi.waitFor(() => expect(test.turns()).toHaveLength(1));
      await test.stream.finish();
      await test.stream.finish();
      await test.collected;
      expect(test.turns().map((event) => event.text)).toEqual([
        "first",
        "tail",
      ]);
      expect(test.audioEnds).toBe(1);
      expect(test.sockets).toHaveLength(1);
    } finally {
      await test.close();
    }
  });

  it("sends application keepalive only while idle and stops it on close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const test = await setup();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(test.controls).toEqual(["keepalive"]));
      await test.stream.sendPCM(pcm(20));
      await vi.advanceTimersByTimeAsync(4_000);
      await test.stream.sendPCM(pcm(20));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(test.controls).toEqual(["keepalive"]);
      await test.stream.close();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(test.controls).toEqual(["keepalive"]);
    } finally {
      await test.close();
    }
  });
});
