import type { JobContext } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";

import type { ASREvent, ASRStream } from "./asr.js";
import {
  eventId,
  publisherAbsence,
  reportVoiceObservationWithRetry,
  retryVoiceTrackConsumer,
  teamHubCallbackRetryDelaysMs,
  VoiceTrackWorker,
  waitForAudioCompletionOrEventFailure,
  waitForASRFlush,
  voiceSessionCreatedAtFromMetadata,
  voiceSessionFromRoom,
  voiceTrackFailureCode,
} from "./livekit-worker.js";
import { VoiceFailure } from "./voice-failure.js";
import { TeamHubVoiceRuntimeError } from "@linger/wire-contracts/teamhub-internal/client";

describe("VoiceTrackWorker identities", () => {
  it("reports the code carried by a typed failure", () => {
    expect(
      voiceTrackFailureCode(
        new VoiceFailure(
          "asr_final_ack_timeout",
          "Soniox ASR final acknowledgement timed out",
          { recoverable: true },
        ),
      ),
    ).toBe("asr_final_ack_timeout");
    expect(voiceTrackFailureCode(new TeamHubVoiceRuntimeError(503))).toBe(
      "teamhub_http_503",
    );
    expect(
      voiceTrackFailureCode(
        Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      ),
    ).toBe("network_reset");
  });

  it.each([
    "Soniox ASR stream is closed",
    "ASR final overlaps with an accepted final",
    "Soniox ASR rejected the stream with code 401",
    "Unexpected server response: 401",
    "provider echoed private transcript and token",
  ])("never classifies an untyped error by its message %s", (message) => {
    expect(voiceTrackFailureCode(new Error(message))).toBe("unknown");
  });

  it("reports typed timeouts from the flush helpers", async () => {
    vi.useFakeTimers();
    try {
      const flushed = waitForASRFlush(
        { finish: () => new Promise<void>(() => undefined) },
        Promise.resolve(),
        10,
      ).catch((error: unknown) => voiceTrackFailureCode(error));
      await vi.advanceTimersByTimeAsync(10);
      await expect(flushed).resolves.toBe("asr_finish_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps callback retry bounded across an ordinary TeamHub restart", () => {
    expect(
      teamHubCallbackRetryDelaysMs.reduce((sum, value) => sum + value, 0),
    ).toBe(7_850);
  });

  it("restarts consumption on the same subscribed track after an outage", async () => {
    const attempts: number[] = [];
    const failures: unknown[] = [];
    const waits: number[] = [];

    await retryVoiceTrackConsumer({
      consume: async () => {
        attempts.push(attempts.length);
        if (attempts.length < 3) throw new Error("dependency unavailable");
      },
      isStopped: () => false,
      onFailure: (error) => failures.push(error),
      retryDelaysMs: [250, 500, 1_000],
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });

    expect(attempts).toHaveLength(3);
    expect(failures).toHaveLength(2);
    expect(waits).toEqual([250, 500]);
  });

  it.each([false, true])(
    "keeps one physical track boundary across retry (lost PCM: %s)",
    async (lost) => {
      const observations: Array<{
        kind: string;
        start_offset_ms: number;
        end_offset_ms: number;
      }> = [];
      const client = {
        reportObservation: async (event: (typeof observations)[number]) => {
          observations.push(event);
          return { status: "accepted" };
        },
      };
      let attempts = 0;
      let nextFrame = 0;
      let oldest = 1000;
      const input = {
        waitForFirstFrame: async () => undefined,
        oldestRetainedAtMs: () => oldest,
        firstFrameAtMs: () => 1000,
        takeDroppedSamples: () => 0,
        next: async () =>
          nextFrame++ === 0
            ? {
                data: new Int16Array(1600),
                samplesPerChannel: 1600,
                sampleRate: 16000,
              }
            : undefined,
        stop: () => undefined,
      };
      const provider = {
        open: async () => {
          if (attempts++ === 0) throw new Error("ASR connection timed out");
          let end!: () => void;
          const done = new Promise<void>((resolve) => {
            end = resolve;
          });
          return {
            sendPCM: async () => undefined,
            finish: async () => {
              end();
            },
            close: async () => {
              end();
            },
            async *events() {
              await done;
              yield* [];
            },
          };
        },
      };
      const worker = new VoiceTrackWorker(client as never, provider);
      const controller = new AbortController();
      const current = { input, controller, track: {}, commits: [] };
      // Exercise the real consumer, including callback ordering and ASR cleanup.
      const consume = (epoch: number) =>
        (
          worker as unknown as { consume(...args: unknown[]): Promise<void> }
        ).consume(
          { room: {} },
          "voice_session_retry",
          epoch,
          {},
          input,
          { attributes: {} },
          controller.signal,
          current,
        );
      await expect(consume(0)).rejects.toThrow("ASR connection timed out");
      if (lost) oldest = 1200;
      await consume(1);
      expect(
        observations.filter((event) => event.kind === "track_started"),
      ).toHaveLength(1);
      expect(
        observations.filter((event) => event.kind === "track_ended"),
      ).toEqual([
        expect.objectContaining({
          start_offset_ms: oldest,
          end_offset_ms: oldest + 100,
        }),
      ]);
      expect(
        observations.filter((event) => event.kind === "input_gap"),
      ).toEqual(
        lost
          ? [
              expect.objectContaining({
                start_offset_ms: 1000,
                end_offset_ms: 1200,
              }),
            ]
          : [],
      );
    },
  );

  it("does not retry a failed consumer once job shutdown begins", async () => {
    let stopped = false;
    const wait = vi.fn(async () => undefined);

    await retryVoiceTrackConsumer({
      consume: async () => {
        throw new Error("dependency unavailable");
      },
      isStopped: () => stopped,
      onFailure: () => {
        stopped = true;
      },
      retryDelaysMs: [250],
      wait,
    });

    expect(wait).not.toHaveBeenCalled();
  });

  it("resets retry backoff after a healthy consumption interval", async () => {
    let now = 0;
    let attempts = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const delays: number[] = [];
    try {
      await retryVoiceTrackConsumer({
        consume: async () => {
          attempts++;
          if (attempts === 3) now += 60_000;
          if (attempts < 5) throw new Error("transient failure");
        },
        isStopped: () => false,
        onFailure: () => undefined,
        retryDelaysMs: [250, 500, 1_000, 2_000],
        wait: async (delay) => {
          delays.push(delay);
        },
      });
      expect(delays).toEqual([250, 500, 250, 500]);
    } finally {
      clock.mockRestore();
    }
  });

  it("reports a flush failure after the publisher stops instead of swallowing it", async () => {
    let stopped = false;
    const failure = new Error("ASR final drain timed out");
    const onFailure = vi.fn();
    const wait = vi.fn();
    await expect(
      retryVoiceTrackConsumer({
        consume: async () => {
          stopped = true;
          throw failure;
        },
        isStopped: () => stopped,
        onFailure,
        retryDelaysMs: [250],
        wait,
      }),
    ).rejects.toBe(failure);
    expect(onFailure).toHaveBeenCalledWith(failure, 0);
    expect(wait).not.toHaveBeenCalled();
  });

  it("fails the active consumer as soon as its event forwarder fails", async () => {
    const audioTask = new Promise<number>(() => undefined);
    const eventFailure = Promise.reject(new Error("TeamHub unavailable"));

    await expect(
      waitForAudioCompletionOrEventFailure(audioTask, eventFailure),
    ).rejects.toThrow("TeamHub unavailable");
  });

  it("returns after connecting so the SDK can own the job lifetime", async () => {
    let shutdownCallback: (() => Promise<void>) | undefined;
    const context = {
      addShutdownCallback: vi.fn((callback: () => Promise<void>) => {
        shutdownCallback = callback;
      }),
      connect: vi.fn(async () => undefined),
      job: {
        metadata: JSON.stringify({
          voice_session_created_at: "2026-09-03T12:00:00Z",
        }),
        room: { name: "voice-voice_session_123" },
      },
      room: { on: vi.fn() },
    } as unknown as JobContext;
    const worker = new VoiceTrackWorker({} as never, {} as never);

    await expect(
      Promise.race([
        worker.run(context),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("entrypoint did not return")), 20),
        ),
      ]),
    ).resolves.toBeUndefined();
    expect(context.connect).toHaveBeenCalledOnce();
    expect(shutdownCallback).toBeTypeOf("function");
    await shutdownCallback?.();
  });

  it("reports publisher absence only for a newer generation beyond the tolerance", () => {
    const ended = { generation: 1, inputEndedMs: 10_000 };
    expect(publisherAbsence(ended, 2, 10_251)).toEqual({
      startOffsetMs: 10_000,
      endOffsetMs: 10_251,
    });
    expect(publisherAbsence(ended, 2, 10_250)).toBeUndefined();
    expect(publisherAbsence(ended, 1, 20_000)).toBeUndefined();
    expect(publisherAbsence({ generation: 1 }, 2, 20_000)).toBeUndefined();
    expect(publisherAbsence(undefined, 2, 20_000)).toBeUndefined();
  });

  it("extracts only TeamHub VoiceSession rooms", () => {
    expect(voiceSessionFromRoom("voice-voice_session_123")).toBe(
      "voice_session_123",
    );
    expect(() => voiceSessionFromRoom("ordinary-room")).toThrow();
  });

  it("uses stable event IDs that include media identity", () => {
    const first = eventId("voice_session_1", 0, "final", 10, 20, "hello");
    expect(first).toBe(eventId("voice_session_1", 0, "final", 10, 20, "hello"));
    expect(first).not.toBe(
      eventId("voice_session_1", 1, "final", 10, 20, "hello"),
    );
    // Progress that commits further over the same words is a new event, not a conflict.
    expect(
      eventId("voice_session_1", 0, "progress", 10, 20, "hi", 500),
    ).not.toBe(eventId("voice_session_1", 0, "progress", 10, 20, "hi", 1000));
  });

  it("reports only committed ASR progress to TeamHub", async () => {
    const observations: Array<{
      kind: string;
      start_offset_ms: number;
      end_offset_ms: number;
      committed_through_ms?: number;
    }> = [];
    const client = {
      reportObservation: async (observation: (typeof observations)[number]) => {
        observations.push(observation);
        return { event_id: "voice-event", status: "accepted" as const };
      },
    };
    const worker = new VoiceTrackWorker(client as never, {} as never);
    const events: ASREvent[] = [
      {
        kind: "progress",
        startOffsetMs: 0,
        endOffsetMs: 640,
      },
      {
        kind: "progress",
        startOffsetMs: 0,
        endOffsetMs: 640,
        committedThroughMs: 640,
      },
      {
        kind: "final",
        startOffsetMs: 0,
        endOffsetMs: 640,
        text: "hello",
      },
      // The ASR provider rotates without changing the media epoch.
      ...[28_000, 56_000].map((startOffsetMs) => ({
        kind: "progress" as const,
        startOffsetMs,
        endOffsetMs: startOffsetMs + 3_000,
        committedThroughMs: startOffsetMs + 3_000,
      })),
    ];
    const stream = {
      async *events() {
        yield* events;
      },
    } as unknown as ASRStream;

    await (
      worker as unknown as {
        forwardEvents(
          voiceSessionId: string,
          epoch: number,
          epochStartMs: number,
          stream: ASRStream,
          signal: AbortSignal,
        ): Promise<void>;
      }
    ).forwardEvents(
      "voice_session_1",
      0,
      1_000,
      stream,
      new AbortController().signal,
    );

    expect(observations).toHaveLength(4);
    expect(observations[0]).toMatchObject({
      kind: "progress",
      start_offset_ms: 1_000,
      end_offset_ms: 1_640,
      committed_through_ms: 1_640,
    });
    expect(observations.slice(2)).toEqual([
      expect.objectContaining({
        start_offset_ms: 1_000,
        committed_through_ms: 32_000,
      }),
      expect.objectContaining({
        start_offset_ms: 1_000,
        committed_through_ms: 60_000,
      }),
    ]);
    expect(observations[1]).toMatchObject({
      kind: "final",
      start_offset_ms: 1_000,
      end_offset_ms: 1_640,
    });
  });

  it("restores the TeamHub VoiceSession epoch from dispatch metadata", () => {
    expect(
      voiceSessionCreatedAtFromMetadata(
        JSON.stringify({ voice_session_created_at: "2026-09-03T12:00:00Z" }),
      ),
    ).toBe(Date.parse("2026-09-03T12:00:00Z"));
    expect(() => voiceSessionCreatedAtFromMetadata("{}")).toThrow(
      "Voice Runtime dispatch metadata",
    );
  });

  it("bounds ASR final draining so a job can shut down", async () => {
    await expect(
      waitForASRFlush(
        { finish: async () => undefined },
        new Promise<void>(() => undefined),
        10,
      ),
    ).rejects.toThrow("ASR final drain timed out");
  });

  it("retries transient TeamHub final callback failures with the same observation", async () => {
    const observation = {
      event_id: "voice-event-1",
      voice_session_id: "voice_session_1",
      media_epoch: 0,
      lane: "live" as const,
      kind: "final" as const,
      text: "accepted final",
      start_offset_ms: 0,
      end_offset_ms: 100,
    };
    const received: (typeof observation)[] = [];
    const client = {
      reportObservation: async (value: typeof observation) => {
        received.push(value);
        if (received.length < 3) throw new TeamHubVoiceRuntimeError(500);
        return { event_id: value.event_id, status: "accepted" as const };
      },
    };

    await reportVoiceObservationWithRetry(client, observation, [0, 0]);

    expect(received).toEqual([observation, observation, observation]);
  });

  it("does not retry non-transient TeamHub callback failures", async () => {
    const client = {
      reportObservation: async () => {
        throw new TeamHubVoiceRuntimeError(400);
      },
    };
    await expect(
      reportVoiceObservationWithRetry(
        client,
        {
          event_id: "voice-event-1",
          voice_session_id: "voice_session_1",
          media_epoch: 0,
          lane: "live",
          kind: "progress",
          start_offset_ms: 0,
          end_offset_ms: 100,
        },
        [0, 0],
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
