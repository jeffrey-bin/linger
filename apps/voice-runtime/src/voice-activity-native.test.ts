import { describe, expect, it } from "vitest";
import { SileroSpeechActivityDetector } from "./voice-activity.js";

describe("production Silero native binding", () => {
  it("loads the packaged model and classifies one silent 16 kHz window without a network service", async () => {
    const detector = await SileroSpeechActivityDetector.open();
    try {
      expect(await detector.pushPCM(new Int16Array(512))).toEqual([
        { throughSample: 512, speech: false },
      ]);
    } finally {
      detector.close();
    }
  });
});
