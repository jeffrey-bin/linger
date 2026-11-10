import { describe, expect, it } from "vitest";

import { calculateWorkerLoad, loadConfig } from "./config.js";

const base = {
  TEAMHUB_BASE_URL: "http://127.0.0.1:8080",
  LINGER_SECRET_SEED: "test-seed-0123456789abcdef0123456789",
};

describe("loadConfig", () => {
  it("requires TEAMHUB_BASE_URL instead of guessing a local TeamHub", () => {
    const without: Record<string, string | undefined> = { ...base };
    delete without.TEAMHUB_BASE_URL;
    expect(() => loadConfig(without)).toThrow("TEAMHUB_BASE_URL is required");
  });

  it("reads each provider key on its own", () => {
    expect(loadConfig(base)).toMatchObject({ sonioxApiKey: "", xaiApiKey: "" });
    expect(
      loadConfig({ ...base, SONIOX_API_KEY: " soniox ", XAI_API_KEY: "xai" }),
    ).toMatchObject({ sonioxApiKey: "soniox", xaiApiKey: "xai" });
  });

  it("configures the Grok WebSocket endpoint and audio transport", () => {
    expect(loadConfig(base)).toMatchObject({
      xaiLiveWebSocketUrl: "wss://api.x.ai/v1/realtime",
      xaiLiveAudioTransport: undefined,
    });
    expect(
      loadConfig({
        ...base,
        VOICE_RUNTIME_XAI_LIVE_WEBSOCKET_URL: " ws://gateway:8080/v1/realtime ",
        VOICE_RUNTIME_XAI_LIVE_AUDIO_TRANSPORT: " json ",
      }),
    ).toMatchObject({
      xaiLiveWebSocketUrl: "ws://gateway:8080/v1/realtime",
      xaiLiveAudioTransport: "json",
    });
    expect(
      loadConfig({
        ...base,
        VOICE_RUNTIME_XAI_LIVE_AUDIO_TRANSPORT: "binary",
      }).xaiLiveAudioTransport,
    ).toBe("binary");
    expect(() =>
      loadConfig({
        ...base,
        VOICE_RUNTIME_XAI_LIVE_AUDIO_TRANSPORT: "pcm",
      }),
    ).toThrow("VOICE_RUNTIME_XAI_LIVE_AUDIO_TRANSPORT must be binary or json");
  });

  it.each([
    "https://gateway:8080/v1/realtime",
    "ws://user:secret@gateway:8080/v1/realtime",
  ])("rejects an invalid Grok WebSocket endpoint", (url) => {
    expect(() =>
      loadConfig({
        ...base,
        VOICE_RUNTIME_XAI_LIVE_WEBSOCKET_URL: url,
      }),
    ).toThrow("VOICE_RUNTIME_XAI_LIVE_WEBSOCKET_URL is invalid");
  });

  it("defaults LiveKit to the local deployment and reads overrides", () => {
    expect(loadConfig(base)).toMatchObject({
      livekitUrl: "ws://127.0.0.1:17880",
      livekitApiKey: "devkey",
      livekitApiSecret: "devsecret-livekit-voice-local-only-32-bytes",
    });
    expect(
      loadConfig({
        ...base,
        LIVEKIT_URL: "ws://livekit:7880",
        LIVEKIT_API_KEY: "key",
        LIVEKIT_API_SECRET: "secret",
      }),
    ).toMatchObject({
      livekitUrl: "ws://livekit:7880",
      livekitApiKey: "key",
      livekitApiSecret: "secret",
    });
    expect(() =>
      loadConfig({ ...base, LIVEKIT_URL: "http://livekit:7880" }),
    ).toThrow("LIVEKIT_URL is invalid");
    expect(() =>
      loadConfig({ ...base, LIVEKIT_URL: "ws://livekit:7880/rtc" }),
    ).toThrow("LIVEKIT_URL is invalid");
  });

  it("rejects credentials embedded in endpoints", () => {
    expect(() =>
      loadConfig({
        ...base,
        TEAMHUB_BASE_URL: "http://user:secret@localhost:8080",
      }),
    ).toThrow("TEAMHUB_BASE_URL is invalid");
  });

  it("reports proportional worker load", () => {
    expect(calculateWorkerLoad(8, 16)).toBe(0.5);
    expect(calculateWorkerLoad(16, 16)).toBe(1);
  });
});
