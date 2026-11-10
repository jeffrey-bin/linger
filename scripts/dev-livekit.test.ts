import { describe, expect, it } from "vitest";

import { planDevLiveKit } from "./dev-livekit";

const liveKit = {
  LIVEKIT_URL: "ws://127.0.0.1:17880",
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "devsecret-livekit-voice-local-only-32-bytes",
};

describe("planDevLiveKit", () => {
  it("leaves LiveKit off without a voice key", () => {
    expect(planDevLiveKit({ ...liveKit, SONIOX_API_KEY: " " }).action).toBe(
      "skip",
    );
  });

  it("runs LiveKit on the LIVEKIT_URL port with the .env key pair", () => {
    const plan = planDevLiveKit({ ...liveKit, XAI_API_KEY: "xai-test" });
    expect(plan).toMatchObject({
      action: "run",
      httpPort: 17880,
      keys: "devkey: devsecret-livekit-voice-local-only-32-bytes",
      ffmpegNeeded: false,
    });
    if (plan.action !== "run") throw new Error("expected a run plan");
    expect(JSON.parse(plan.config)).toMatchObject({
      port: 17880,
      bind_addresses: ["127.0.0.1"],
      rtc: { tcp_port: 0, udp_port: 7882, node_ip: "127.0.0.1" },
    });
    expect(plan.config).not.toContain("devsecret");
  });

  it("asks for ffmpeg only when Soniox records", () => {
    const plan = planDevLiveKit({ ...liveKit, SONIOX_API_KEY: "soniox" });
    expect(plan).toMatchObject({ action: "run", ffmpegNeeded: true });
  });

  it("uses a LiveKit server on another host instead of starting one", () => {
    expect(
      planDevLiveKit({
        ...liveKit,
        LIVEKIT_URL: "wss://livekit.example.com",
        SONIOX_API_KEY: "soniox",
      }).action,
    ).toBe("skip");
  });

  it("names the missing LiveKit settings", () => {
    expect(() =>
      planDevLiveKit({
        SONIOX_API_KEY: "soniox",
        LIVEKIT_URL: liveKit.LIVEKIT_URL,
      }),
    ).toThrow(/LIVEKIT_API_KEY/);
  });
});
