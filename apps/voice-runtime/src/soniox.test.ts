import { once } from "node:events";
import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";

import type { ASREvent } from "./asr.js";
import {
  SonioxASRProvider,
  SonioxASRStream,
  sonioxRealtimeSessionConfig,
} from "./soniox.js";
import { voiceTrackFailureCode } from "./livekit-worker.js";
import { VoiceFailure } from "./voice-failure.js";

async function listen(server: WebSocketServer) {
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing listener");
  return address.port;
}

describe("Soniox streaming", () => {
  it.each([false, true])(
    "delivers 2000 finals with bounded replay indexes (injected outage: %s)",
    async (outage) => {
      const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      const port = await listen(server);
      let connections = 0;
      let count = 0;
      server.on("connection", (socket) => {
        connections++;
        const base = count * 100;
        socket.on("message", (raw, binary) => {
          if (!binary) {
            if ((raw as Buffer).toString() === "")
              socket.send(JSON.stringify({ finished: true }));
            return;
          }
          if (outage && connections === 1 && count === 1000) {
            socket.terminate();
            return;
          }
          const start = count++ * 100 - base;
          const message = {
            final_audio_proc_ms: start + 100,
            total_audio_proc_ms: start + 100,
            tokens: [
              {
                text: `sentence ${count}`,
                is_final: true,
                start_ms: start,
                end_ms: start + 100,
              },
              { text: "<end>", is_final: true },
            ],
          };
          socket.send(JSON.stringify(message));
          // Exercise repeated delivery before and after the old 512-entry limit.
          socket.send(JSON.stringify(message));
        });
      });
      const stream = await new SonioxASRProvider({
        apiKey: "test",
        model: "stt-rt-v5",
        webSocketUrl: `ws://127.0.0.1:${port}`,
      }).open(new AbortController().signal);
      const finals: ASREvent[] = [];
      let acknowledge!: () => void;
      const events = (async () => {
        for await (const event of stream.events()) {
          if (event.kind === "final") {
            finals.push(event);
            acknowledge();
          }
        }
      })();
      try {
        for (let i = 0; i < 2000; i++) {
          const accepted = new Promise<void>((resolve) => {
            acknowledge = resolve;
          });
          await stream.sendPCM(new Int16Array(1600));
          await accepted;
        }
        await stream.finish();
        await events;
        expect(connections).toBe(outage ? 2 : 1);
        expect(finals).toHaveLength(2000);
        expect(finals.map((event) => event.text)).toEqual(
          Array.from({ length: 2000 }, (_, i) => `sentence ${i + 1}`),
        );
        expect(finals.at(-1)?.endOffsetMs).toBe(200_000);
      } finally {
        await stream.close();
        await events.catch(() => undefined);
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    20_000,
  );

  it("keeps the API key in the first JSON config and omits language hints by default", () => {
    const config = sonioxRealtimeSessionConfig({
      apiKey: "soniox-secret",
      model: "stt-rt-v5",
    });
    expect(config).toMatchObject({
      api_key: "soniox-secret",
      model: "stt-rt-v5",
      audio_format: "pcm_s16le",
      sample_rate: 16000,
      num_channels: 1,
      enable_endpoint_detection: true,
    });
    expect(config).not.toHaveProperty("language_hints");
    expect(config).not.toHaveProperty("enable_speaker_diarization");
    expect(config).not.toHaveProperty("endpoint_latency_adjustment_level");
    expect(config).not.toHaveProperty("endpoint_sensitivity");
    expect(config).not.toHaveProperty("max_endpoint_delay_ms");
    expect(
      sonioxRealtimeSessionConfig({
        apiKey: "soniox-secret",
        model: "stt-rt-v5",
        dictation: true,
      }),
    ).toMatchObject({
      enable_endpoint_detection: true,
      endpoint_latency_adjustment_level: 0,
      endpoint_sensitivity: -0.4,
      max_endpoint_delay_ms: 3_000,
    });
    expect(
      sonioxRealtimeSessionConfig({
        apiKey: "soniox-secret",
        model: "stt-rt-v5",
        diarization: true,
      }),
    ).toEqual(
      expect.objectContaining({
        enable_speaker_diarization: true,
      }),
    );
    expect(
      sonioxRealtimeSessionConfig({
        apiKey: "soniox-secret",
        model: "stt-rt-v5",
        diarization: true,
      }),
    ).not.toHaveProperty("enable_endpoint_detection");
    expect(
      sonioxRealtimeSessionConfig({
        apiKey: "soniox-secret",
        model: "stt-rt-v5",
        languageHints: ["zh", "en"],
      }).language_hints,
    ).toEqual(["zh", "en"]);
  });

  it("sends session config then PCM and finalizes on endpoint", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const port = await listen(server);
    const configs: object[] = [];
    const audio: Buffer[] = [];
    let ended = false;
    server.on("connection", (socket) => {
      socket.on("message", (raw, isBinary) => {
        if (isBinary) {
          audio.push(Buffer.from(raw as Buffer));
          return;
        }
        const text = (raw as Buffer).toString();
        if (text === "") {
          ended = true;
          socket.send(
            JSON.stringify({
              final_audio_proc_ms: 720,
              total_audio_proc_ms: 720,
              tokens: [
                {
                  text: "Hello",
                  is_final: true,
                  start_ms: 80,
                  end_ms: 320,
                  speaker: "1",
                },
                {
                  text: " world",
                  is_final: true,
                  start_ms: 320,
                  end_ms: 720,
                  speaker: "1",
                },
                { text: "<end>", is_final: true },
              ],
              finished: true,
            }),
          );
          socket.close();
          return;
        }
        configs.push(JSON.parse(text));
      });
    });
    const provider = new SonioxASRProvider({
      apiKey: "soniox-secret",
      model: "stt-rt-v5",
      languageHints: ["zh"],
      webSocketUrl: `ws://127.0.0.1:${port}`,
      dictation: true,
    });
    const stream = await provider.open(new AbortController().signal);
    const seen: ASREvent[] = [];
    const events = (async () => {
      for await (const event of stream.events()) seen.push(event);
    })();
    const frame = new Int16Array(160).fill(7);
    try {
      await stream.sendPCM(frame);
      await Promise.all([stream.finish(), stream.finish()]);
      await events;
      expect(configs).toEqual([
        sonioxRealtimeSessionConfig({
          apiKey: "soniox-secret",
          model: "stt-rt-v5",
          languageHints: ["zh"],
          dictation: true,
        }),
      ]);
      expect(ended).toBe(true);
      expect(Buffer.concat(audio)).toEqual(Buffer.from(frame.buffer));
      const final = seen.find((event) => event.kind === "final");
      expect(final).toMatchObject({
        startOffsetMs: 80,
        endOffsetMs: 720,
        text: "Hello world",
        speakerId: "spk_1",
      });
      expect(final?.words).toEqual([
        { startOffsetMs: 80, endOffsetMs: 320, textStart: 0, textEnd: 5 },
        { startOffsetMs: 320, endOffsetMs: 720, textStart: 6, textEnd: 11 },
      ]);
      expect(
        seen.find((event) => event.kind === "utterance_end"),
      ).toMatchObject({
        kind: "utterance_end",
        startOffsetMs: 720,
        endOffsetMs: 720,
      });
    } finally {
      await stream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function diarizedRun(messages: object[]) {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const port = await listen(server);
    let next = 0;
    server.on("connection", (socket) => {
      socket.on("message", (_raw, isBinary) => {
        if (!isBinary || next >= messages.length) return;
        socket.send(JSON.stringify(messages[next++]));
      });
    });
    const stream = await new SonioxASRProvider({
      apiKey: "test",
      model: "stt-rt-v5",
      webSocketUrl: `ws://127.0.0.1:${port}`,
      diarization: true,
    }).open(new AbortController().signal);
    const events: ASREvent[] = [];
    const reading = (async () => {
      for await (const event of stream.events()) events.push(event);
    })().catch(() => undefined);
    try {
      for (let i = 0; i < messages.length; i++) {
        await stream.sendPCM(new Int16Array(160));
        await vi.waitFor(() => expect(next).toBe(i + 1));
      }
      await vi.waitFor(() =>
        expect(
          events.filter((event) => event.kind === "progress"),
        ).toHaveLength(messages.length),
      );
      return events;
    } finally {
      await stream.close();
      await reading;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("releases a diarized speaker run once the speaker pauses", async () => {
    const token = (text: string, start: number, end: number) => ({
      text,
      is_final: true,
      start_ms: start,
      end_ms: end,
      speaker: "1",
    });
    const events = await diarizedRun([
      {
        final_audio_proc_ms: 1_000,
        total_audio_proc_ms: 1_000,
        tokens: [token("Let us look", 0, 1_000)],
      },
      {
        final_audio_proc_ms: 2_000,
        total_audio_proc_ms: 2_000,
        tokens: [token(" at item one", 1_000, 2_000)],
      },
      // No new words, but Soniox finalized 1.5 s past the last one.
      { final_audio_proc_ms: 3_600, total_audio_proc_ms: 3_600, tokens: [] },
    ]);
    const finals = events.filter((event) => event.kind === "final");
    expect(finals).toEqual([
      expect.objectContaining({
        text: "Let us look at item one",
        speakerId: "spk_1",
        startOffsetMs: 0,
        endOffsetMs: 2_000,
      }),
    ]);
    // Held words no longer pin the replay buffer behind the run.
    const progress = events.filter((event) => event.kind === "progress");
    expect(progress.at(-1)?.committedThroughMs).toBe(3_600);
    expect(progress[1]?.committedThroughMs).toBeUndefined();
  });

  it("releases a long diarized speaker run before the replay buffer fills", async () => {
    const messages = Array.from({ length: 21 }, (_, second) => ({
      final_audio_proc_ms: (second + 1) * 1_000,
      total_audio_proc_ms: (second + 1) * 1_000,
      tokens: [
        {
          text: ` word${second}`,
          is_final: true,
          start_ms: second * 1_000,
          end_ms: (second + 1) * 1_000,
          speaker: "2",
        },
      ],
    }));
    const events = await diarizedRun(messages);
    const finals = events.filter((event) => event.kind === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      speakerId: "spk_2",
      startOffsetMs: 0,
      endOffsetMs: 20_000,
    });
  });

  it("renders non-final tokens as partials until endpoint", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const port = await listen(server);
    server.on("connection", (socket) => {
      socket.on("message", (raw, isBinary) => {
        if (!isBinary) return;
        socket.send(
          JSON.stringify({
            total_audio_proc_ms: 640,
            final_audio_proc_ms: 0,
            tokens: [
              { text: "Hel", is_final: false, start_ms: 0, end_ms: 320 },
              { text: "lo", is_final: false, start_ms: 320, end_ms: 640 },
            ],
          }),
        );
      });
    });
    const provider = new SonioxASRProvider({
      apiKey: "test",
      model: "stt-rt-v5",
      webSocketUrl: `ws://127.0.0.1:${port}`,
    });
    const stream = await provider.open(new AbortController().signal);
    const iterator = stream.events()[Symbol.asyncIterator]();
    try {
      await stream.sendPCM(new Int16Array(160));
      const partial = await iterator.next();
      const progress = await iterator.next();
      expect(progress.value).toMatchObject({
        kind: "progress",
        endOffsetMs: 640,
      });
      expect(progress.value.committedThroughMs).toBeUndefined();
      expect(partial.value).toMatchObject({
        kind: "partial",
        startOffsetMs: 0,
        endOffsetMs: 640,
        text: "Hello",
      });
    } finally {
      await stream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps a revised dictation final monotonic with its pending utterance", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const port = await listen(server);
    server.on("connection", (socket) => {
      socket.on("message", (raw, isBinary) => {
        if (isBinary) {
          socket.send(
            JSON.stringify({
              total_audio_proc_ms: 1_200,
              tokens: [
                {
                  text: "first turn",
                  is_final: false,
                  start_ms: 100,
                  end_ms: 960,
                },
              ],
            }),
          );
        } else if ((raw as Buffer).toString() === "") {
          socket.send(
            JSON.stringify({
              final_audio_proc_ms: 1_200,
              total_audio_proc_ms: 1_200,
              tokens: [
                {
                  text: "first turn?",
                  is_final: true,
                  start_ms: 120,
                  end_ms: 720,
                },
                { text: "<end>", is_final: true },
              ],
              finished: true,
            }),
          );
        }
      });
    });
    const provider = new SonioxASRProvider({
      apiKey: "test",
      model: "stt-rt-v5",
      webSocketUrl: `ws://127.0.0.1:${port}`,
      dictation: true,
    });
    const stream = await provider.open(new AbortController().signal);
    const seen: ASREvent[] = [];
    const events = (async () => {
      for await (const event of stream.events()) seen.push(event);
    })();
    try {
      await stream.sendPCM(new Int16Array(160));
      await vi.waitFor(() =>
        expect(seen).toContainEqual(
          expect.objectContaining({
            kind: "partial",
            startOffsetMs: 100,
            endOffsetMs: 960,
            text: "first turn",
          }),
        ),
      );
      await stream.finish();
      await events;
      expect(seen).toContainEqual(
        expect.objectContaining({
          kind: "final",
          startOffsetMs: 120,
          endOffsetMs: 960,
          text: "first turn?",
        }),
      );
      expect(
        seen.find((event) => event.kind === "utterance_end"),
      ).toMatchObject({
        kind: "utterance_end",
        startOffsetMs: 960,
        endOffsetMs: 960,
      });
    } finally {
      await stream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps partial and final speech boundaries separate from processed audio progress", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const port = await listen(server);
    let frames = 0;
    server.on("connection", (socket) => {
      socket.on("message", (raw, isBinary) => {
        if (isBinary) {
          frames += 1;
          socket.send(
            JSON.stringify({
              total_audio_proc_ms: frames === 1 ? 1_600 : 2_400,
              final_audio_proc_ms: frames === 1 ? 0 : 720,
              tokens: [
                {
                  text: "Hello",
                  is_final: frames > 1,
                  start_ms: 80,
                  end_ms: 320,
                },
                {
                  text: " world",
                  is_final: frames > 1,
                  start_ms: 320,
                  end_ms: 720,
                },
              ],
            }),
          );
        } else if ((raw as Buffer).toString() === "") {
          socket.send(
            JSON.stringify({
              total_audio_proc_ms: 3_200,
              final_audio_proc_ms: 3_200,
              tokens: [{ text: "<end>", is_final: true }],
              finished: true,
            }),
          );
        }
      });
    });
    const provider = new SonioxASRProvider({
      apiKey: "test",
      model: "stt-rt-v5",
      webSocketUrl: `ws://127.0.0.1:${port}`,
    });
    const stream = await provider.open(new AbortController().signal);
    const iterator = stream.events()[Symbol.asyncIterator]();
    try {
      for (const processedMs of [1_600, 2_400]) {
        await stream.sendPCM(new Int16Array(160));
        expect((await iterator.next()).value).toMatchObject({
          kind: "partial",
          startOffsetMs: 80,
          endOffsetMs: 720,
          text: "Hello world",
        });
        expect((await iterator.next()).value).toMatchObject({
          kind: "progress",
          endOffsetMs: processedMs,
        });
      }
      await stream.finish();
      expect((await iterator.next()).value).toMatchObject({
        kind: "final",
        startOffsetMs: 80,
        endOffsetMs: 720,
        text: "Hello world",
      });
      expect((await iterator.next()).value).toMatchObject({
        kind: "progress",
        endOffsetMs: 3_200,
        committedThroughMs: 3_200,
      });
      expect((await iterator.next()).done).toBe(true);
    } finally {
      await stream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails the stream when Soniox rejects it without echoing provider text", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const port = await listen(server);
    server.on("connection", (socket) =>
      socket.on("message", () =>
        socket.send(
          JSON.stringify({
            error_code: 401,
            error_message: "private transcript",
          }),
        ),
      ),
    );
    const recovered = vi.fn();
    const provider = new SonioxASRProvider({
      apiKey: "test",
      model: "not-a-model",
      webSocketUrl: `ws://127.0.0.1:${port}`,
      onRecovery: recovered,
    });
    const stream = await provider.open(new AbortController().signal);
    const iterator = stream.events()[Symbol.asyncIterator]();
    const result = await iterator.next().then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      expect(result).toBeInstanceOf(VoiceFailure);
      expect(result).toMatchObject({
        code: "asr_provider_401",
        recoverable: false,
        message: "Soniox ASR rejected the stream with code 401",
      });
      expect(String(result)).not.toContain("private transcript");
      expect(recovered).not.toHaveBeenCalled();
    } finally {
      await stream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    [503, "asr_provider_503"],
    ["503x", "unknown"],
    [-1, "unknown"],
  ])("maps Soniox error_code %s to %s", async (errorCode, expected) => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const port = await listen(server);
    server.on("connection", (socket) =>
      socket.on("message", () =>
        socket.send(JSON.stringify({ error_code: errorCode })),
      ),
    );
    const stream = await SonioxASRStream.connect(
      {
        apiKey: "test",
        model: "stt-rt-v5",
        webSocketUrl: `ws://127.0.0.1:${port}`,
      },
      new AbortController().signal,
    );
    const iterator = stream.events()[Symbol.asyncIterator]();
    try {
      const result = await iterator.next().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(voiceTrackFailureCode(result)).toBe(expected);
    } finally {
      await stream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports an unexpected handshake status as a typed failure", async () => {
    const server = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      verifyClient: (_info, done) => done(false, 401),
    });
    const port = await listen(server);
    try {
      const result = await SonioxASRStream.connect(
        {
          apiKey: "test",
          model: "stt-rt-v5",
          webSocketUrl: `ws://127.0.0.1:${port}`,
        },
        new AbortController().signal,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(VoiceFailure);
      expect(voiceTrackFailureCode(result)).toBe("asr_http_401");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects writes on a closing or closed socket with recoverable failures", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const port = await listen(server);
    const stream = await SonioxASRStream.connect(
      {
        apiKey: "test",
        model: "stt-rt-v5",
        webSocketUrl: `ws://127.0.0.1:${port}`,
      },
      new AbortController().signal,
    );
    const internals = stream as unknown as {
      socket: {
        close(): void;
        once(event: "close", listener: () => void): void;
      };
      write(payload: string): Promise<void>;
    };
    const failed = (async () => {
      for await (const _ of stream.events());
    })().catch(() => undefined);
    try {
      const closed = once(internals.socket as never, "close");
      internals.socket.close();
      await expect(internals.write("")).rejects.toMatchObject({
        code: "asr_socket_closing",
        recoverable: true,
      });
      await closed;
      await expect(internals.write("")).rejects.toMatchObject({
        code: "asr_socket_closed",
        recoverable: true,
      });
    } finally {
      await stream.close();
      await failed;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("replays the tail when the socket closes without a finished acknowledgement", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const port = await listen(server);
    let connections = 0;
    let replayedSamples = 0;
    server.on("connection", (socket) => {
      const attempt = connections++;
      socket.on("message", (raw, binary) => {
        if (binary) {
          if (attempt > 0)
            replayedSamples += Buffer.from(raw as Buffer).length / 2;
          return;
        }
        if ((raw as Buffer).toString() !== "") return;
        if (attempt === 0) {
          socket.close();
          return;
        }
        socket.send(
          JSON.stringify({
            finished: true,
            final_audio_proc_ms: 100,
            total_audio_proc_ms: 100,
            tokens: [
              {
                text: "complete tail",
                is_final: true,
                start_ms: 0,
                end_ms: 100,
              },
            ],
          }),
        );
      });
    });
    const stream = await new SonioxASRProvider({
      apiKey: "test",
      model: "stt-rt-v5",
      webSocketUrl: `ws://127.0.0.1:${port}`,
    }).open(new AbortController().signal);
    const seen: ASREvent[] = [];
    const events = (async () => {
      for await (const event of stream.events()) seen.push(event);
    })();
    try {
      await stream.sendPCM(new Int16Array(1600));
      await stream.finish();
      await events;
      expect(connections).toBe(2);
      expect(replayedSamples).toBe(1600);
      expect(seen.filter((event) => event.kind === "final")).toEqual([
        expect.objectContaining({
          text: "complete tail",
          startOffsetMs: 0,
          endOffsetMs: 100,
        }),
      ]);
    } finally {
      await stream.close();
      await events.catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
