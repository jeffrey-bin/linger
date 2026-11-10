import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loopAudioFrames,
  playObservedAudio,
} from "../acceptance/observed-audio-playback.js";

afterEach(() => vi.useRealTimers());

describe("acceptance audio playback", () => {
  it("rejects cumulative slow sending even when each frame is under 250ms", async () => {
    vi.useFakeTimers();
    let framesSent = 0;
    const playback = playObservedAudio({
      frames: loopAudioFrames(new Int16Array(480), 30_000),
      captureFrame: async () => {
        framesSent++;
        await delay(20);
      },
      observe: async () => {},
      signal: new AbortController().signal,
    });
    const result = expect(playback).rejects.toThrow(
      "cumulative delay exceeded 2000ms",
    );
    await vi.advanceTimersByTimeAsync(4_100);
    await result;
    expect(framesSent).toBe(201);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("loops the source for the exact duration without padding or truncating its tail", () => {
    const pcm = Int16Array.from([11, 22, 33, 44, 55, 66, 77]);
    const frames = [...loopAudioFrames(pcm, 21)];
    expect(frames.map((frame) => frame.length)).toEqual([480, 480, 48]);
    const actual = frames.flatMap((frame) => [...frame]);
    expect(actual).toEqual(
      Array.from({ length: 1008 }, (_, i) => pcm[i % pcm.length]),
    );
  });

  it("preserves an observation failure racing with the final frame and cleanup", async () => {
    let finishFrame!: () => void;
    let rejectObservation!: (error: Error) => void;
    const playback = playObservedAudio({
      frames: [new Int16Array(480)],
      signal: new AbortController().signal,
      captureFrame: () =>
        new Promise<void>((resolve) => {
          finishFrame = resolve;
        }),
      observe: () =>
        new Promise<void>((_resolve, reject) => {
          rejectObservation = reject;
        }),
    });
    const failure = new Error("Recording stopped during soak");
    const outcome = expect(playback).rejects.toBe(failure);
    await Promise.resolve();
    finishFrame();
    rejectObservation(failure);
    await outcome;
  });

  it("keeps 10ms frames continuous during slow HTTP and cancels the final read", async () => {
    vi.useFakeTimers();
    const sentAt: number[] = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    let completed = 0;
    let aborted = 0;
    const playback = playObservedAudio({
      frames: Array.from({ length: 400 }, () => new Int16Array(480)),
      signal: new AbortController().signal,
      captureFrame: async () => {
        sentAt.push(performance.now());
        await delay(10);
      },
      observe: (signal) =>
        new Promise<void>((resolve, reject) => {
          inFlight++;
          maximumInFlight = Math.max(maximumInFlight, inFlight);
          const cancel = () => {
            clearTimeout(timer);
            inFlight--;
            aborted++;
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            inFlight--;
            completed++;
            resolve();
          }, 3_000);
          signal.addEventListener("abort", cancel, { once: true });
        }),
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await playback).toEqual({
      sent_audio_ms: 4_000,
      playback_elapsed_ms: 4_000,
      frames_sent: 400,
      max_frame_gap_ms: 10,
      max_capture_frame_ms: 10,
    });
    expect(sentAt).toHaveLength(400);
    expect(sentAt.every((time, index) => time === index * 10)).toBe(true);
    expect({ maximumInFlight, inFlight, completed, aborted }).toEqual({
      maximumInFlight: 1,
      inFlight: 0,
      completed: 1,
      aborted: 1,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["observation", "publisher", "interrupt"])(
    "stops both tasks and clears polling on %s failure",
    async (failureSource) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const failure = new Error(failureSource);
      let sent = 0;
      let observationAborted = false;
      const playback = playObservedAudio({
        frames: Array.from({ length: 400 }, () => new Int16Array(480)),
        signal: controller.signal,
        captureFrame: async () => {
          sent++;
          await delay(10);
          if (failureSource === "publisher") throw failure;
          if (failureSource === "interrupt") controller.abort(failure);
        },
        observe: async (signal) => {
          if (failureSource === "observation") {
            await delay(25);
            throw failure;
          }
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                observationAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
      });
      const result = expect(playback).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(100);
      await result;
      expect(sent).toBe(failureSource === "observation" ? 3 : 1);
      expect(observationAborted).toBe(failureSource !== "observation");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["first", "last"])(
    "rejects a stalled %s frame without waiting for another frame",
    async (stalledFrame) => {
      vi.useFakeTimers();
      let calls = 0;
      const playback = playObservedAudio({
        frames: [new Int16Array(480), new Int16Array(480)],
        signal: new AbortController().signal,
        captureFrame: () => {
          calls++;
          return delay(
            calls === (stalledFrame === "first" ? 1 : 2) ? 3_000 : 10,
          );
        },
        observe: async () => {},
      });
      const result = expect(playback).rejects.toThrow(
        "Audio publisher captureFrame exceeded 250ms",
      );
      await vi.advanceTimersByTimeAsync(3_010);
      await result;
      expect(calls).toBe(stalledFrame === "first" ? 1 : 2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["deadline", "interrupt", "observation"])(
    "releases a native callback that never completes on %s",
    async (failureSource) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const failure = new Error(failureSource);
      let observationAborted = false;
      let sent = 0;
      const playback = playObservedAudio({
        frames: [new Int16Array(480)],
        signal: controller.signal,
        captureFrame: () => {
          sent++;
          return new Promise<void>(() => {});
        },
        observe: async (signal) => {
          if (failureSource === "observation") {
            await delay(25);
            throw failure;
          }
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                observationAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
      });
      const outcome =
        failureSource === "deadline"
          ? expect(playback).rejects.toThrow(
              "Audio publisher captureFrame exceeded 250ms",
            )
          : expect(playback).rejects.toBe(failure);
      await Promise.resolve();
      if (failureSource === "interrupt") controller.abort(failure);
      await vi.advanceTimersByTimeAsync(250);
      await outcome;
      expect(sent).toBe(1);
      expect(observationAborted).toBe(failureSource !== "observation");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
