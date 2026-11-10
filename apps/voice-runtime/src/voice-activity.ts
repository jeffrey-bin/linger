import { createRequire } from "node:module";

const requireNative = createRequire(import.meta.url);
let prewarmed: Promise<SpeechActivityDetector> | undefined;

export interface SpeechActivity {
  throughSample: number;
  speech: boolean;
}

// The detector receives the same mono 16 kHz samples as ASR. Its clock advances
// on audio, never on a missing/unchanged transcript or a stalled network.
export interface SpeechActivityDetector {
  pushPCM(frame: Int16Array): Promise<SpeechActivity[]>;
  close(): void;
}

interface SileroModel {
  predict(pcm: Int16Array): Promise<number>;
  reset(): void;
}

export class SileroSpeechActivityDetector implements SpeechActivityDetector {
  private readonly window: Int16Array;
  private pending = 0;
  private throughSample = 0;
  private speech = false;
  private closed = false;

  constructor(
    private readonly model: SileroModel,
    windowSamples: number,
  ) {
    if (windowSamples !== 512)
      throw new Error("Dictation VAD sample window is invalid");
    this.window = new Int16Array(windowSamples);
  }

  static async open(): Promise<SpeechActivityDetector> {
    // This is the same native Silero shipped by @livekit/agents 1.7.1. Loading
    // it directly fails closed if the platform binding/model is unavailable;
    // the SDK's convenience VAD otherwise silently falls back to zero scores.
    // The package builds its CJS exports dynamically, so Node cannot synthesize
    // ESM named exports. This is also how the pinned agents SDK loads it.
    const native = requireNative(
      "@livekit/local-inference",
    ) as typeof import("@livekit/local-inference");
    return new SileroSpeechActivityDetector(
      native.createVad(),
      native.VAD_WINDOW_SAMPLES,
    );
  }

  /**
   * Loads the model and runs its lazy first inference while the job is idle.
   * The first opener takes it; subsequent openers also warm before readiness.
   */
  static prewarm(): void {
    prewarmed ??= SileroSpeechActivityDetector.openWarmed();
    prewarmed.catch(() => undefined);
  }

  static openPrewarmed(): Promise<SpeechActivityDetector> {
    const detector = prewarmed ?? SileroSpeechActivityDetector.openWarmed();
    prewarmed = undefined;
    return detector;
  }

  private static async openWarmed(): Promise<SpeechActivityDetector> {
    const detector =
      (await SileroSpeechActivityDetector.open()) as SileroSpeechActivityDetector;
    try {
      await detector.pushPCM(new Int16Array(detector.window.length));
      detector.model.reset();
      detector.throughSample = 0;
      detector.speech = false;
      return detector;
    } catch (error) {
      detector.close();
      throw error;
    }
  }

  async pushPCM(frame: Int16Array): Promise<SpeechActivity[]> {
    if (this.closed) throw new Error("Dictation VAD is closed");
    const observations: SpeechActivity[] = [];
    let offset = 0;
    while (offset < frame.length) {
      const count = Math.min(
        frame.length - offset,
        this.window.length - this.pending,
      );
      this.window.set(frame.subarray(offset, offset + count), this.pending);
      this.pending += count;
      offset += count;
      if (this.pending < this.window.length) continue;
      const probability = await this.model.predict(this.window);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1)
        throw new Error("Dictation VAD result is invalid");
      // Hysteresis is the native SDK's Silero default, not an amplitude gate.
      this.speech = probability >= (this.speech ? 0.35 : 0.5);
      this.throughSample += this.window.length;
      observations.push({
        throughSample: this.throughSample,
        speech: this.speech,
      });
      this.pending = 0;
    }
    return observations;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.window.fill(0);
    this.model.reset();
  }
}
