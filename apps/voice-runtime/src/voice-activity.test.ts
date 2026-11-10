import { afterEach, describe, expect, it, vi } from "vitest";
import { SileroSpeechActivityDetector } from "./voice-activity.js";

describe("Silero human-voice activity adapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("finishes lazy inference before Live readiness and resets its synthetic timeline", async () => {
    let finishWarmup!: (probability: number) => void;
    const model = {
      predict: vi
        .fn<(frame: Int16Array) => Promise<number>>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishWarmup = resolve;
            }),
        )
        .mockResolvedValue(0.9),
      reset: vi.fn(),
    };
    const detector = new SileroSpeechActivityDetector(model, 512);
    vi.spyOn(SileroSpeechActivityDetector, "open").mockResolvedValue(detector);
    SileroSpeechActivityDetector.prewarm();
    const ready = vi.fn();
    const opening = SileroSpeechActivityDetector.openPrewarmed().then(ready);
    await vi.waitFor(() => expect(model.predict).toHaveBeenCalledOnce());
    expect(model.predict.mock.calls[0]![0].every((value) => value === 0)).toBe(
      true,
    );
    expect(ready).not.toHaveBeenCalled();
    finishWarmup(0.01);
    await opening;
    expect(ready).toHaveBeenCalledWith(detector);
    expect(model.reset).toHaveBeenCalledOnce();
    expect(await detector.pushPCM(new Int16Array(512).fill(1))).toEqual([
      { throughSample: 512, speech: true },
    ]);
    detector.close();
  });

  it("fails readiness and releases the detector when native warmup fails", async () => {
    const model = { predict: vi.fn(async () => NaN), reset: vi.fn() };
    const detector = new SileroSpeechActivityDetector(model, 512);
    vi.spyOn(SileroSpeechActivityDetector, "open").mockResolvedValue(detector);
    await expect(SileroSpeechActivityDetector.openPrewarmed()).rejects.toThrow(
      "result is invalid",
    );
    expect(model.reset).toHaveBeenCalledOnce();
    await expect(detector.pushPCM(new Int16Array(512))).rejects.toThrow(
      "closed",
    );
  });
  it("uses model probabilities over exact 512-sample windows rather than PCM amplitude", async () => {
    const model = {
      predict: vi
        .fn<(frame: Int16Array) => Promise<number>>()
        .mockResolvedValue(0.01)
        .mockResolvedValueOnce(0.9)
        .mockResolvedValueOnce(0.4),
      reset: vi.fn(),
    };
    const detector = new SileroSpeechActivityDetector(model, 512);
    expect(await detector.pushPCM(new Int16Array(320))).toEqual([]);
    expect(await detector.pushPCM(new Int16Array(320))).toEqual([
      { throughSample: 512, speech: true },
    ]);
    expect(await detector.pushPCM(new Int16Array(384).fill(30_000))).toEqual([
      { throughSample: 1_024, speech: true },
    ]);
    expect(await detector.pushPCM(new Int16Array(512).fill(30_000))).toEqual([
      { throughSample: 1_536, speech: false },
    ]);
    expect(
      model.predict.mock.calls.every(([frame]) => frame.length === 512),
    ).toBe(true);
    detector.close();
    detector.close();
    expect(model.reset).toHaveBeenCalledOnce();
    await expect(detector.pushPCM(new Int16Array(320))).rejects.toThrow(
      "closed",
    );
  });

  it("fails closed when inference fails or returns a non-probability", async () => {
    const detector = new SileroSpeechActivityDetector(
      { predict: async () => NaN, reset: () => undefined },
      512,
    );
    await expect(detector.pushPCM(new Int16Array(512))).rejects.toThrow(
      "result is invalid",
    );
    const failed = new SileroSpeechActivityDetector(
      {
        predict: async () => {
          throw new Error("native unavailable");
        },
        reset: () => undefined,
      },
      512,
    );
    await expect(failed.pushPCM(new Int16Array(512))).rejects.toThrow(
      "native unavailable",
    );
  });
});
