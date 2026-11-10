import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSmokePublisher } from "../acceptance/browser-smoke-publisher.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const selected = () =>
  new Map<string, unknown>([
    [
      "audio",
      {
        id: "audio",
        type: "outbound-rtp",
        kind: "audio",
        transportId: "transport",
        bytesSent: 64,
      },
    ],
    [
      "transport",
      { id: "transport", type: "transport", selectedCandidatePairId: "pair" },
    ],
    [
      "pair",
      {
        id: "pair",
        type: "candidate-pair",
        localCandidateId: "candidate",
        bytesSent: 64,
      },
    ],
    [
      "candidate",
      {
        id: "candidate",
        type: "local-candidate",
        candidateType: "relay",
        relayProtocol: "tls",
        address: "203.0.113.10",
        url: "turns:turn.example:443?transport=tcp",
      },
    ],
  ]);

function fixture(peer: {
  connectionState: string;
  getConfiguration(): { iceTransportPolicy: string };
  getStats(): Promise<Map<string, unknown>>;
}) {
  vi.stubEnv("VOICE_SOAK_TURN_PUBLIC_IP", "203.0.113.10");
  vi.stubGlobal("window", {
    voiceSmoke: {
      room: { state: "connected" },
      audio: { state: "running" },
      peers: [peer],
    },
  });
  const publisher = new BrowserSmokePublisher();
  Object.defineProperty(publisher, "page", {
    value: { evaluate: async (read: () => unknown) => read() },
  });
  return publisher;
}

describe("live TURN evidence", () => {
  it("waits for selected-pair statistics to return during an ICE transition", async () => {
    vi.useFakeTimers();
    const peer = {
      connectionState: "connecting",
      getConfiguration: () => ({ iceTransportPolicy: "relay" }),
      getStats: async () => selected(),
    };
    const publisher = fixture(peer);
    const result = publisher.relayEvidence().then(
      (value) => value,
      (error) => error,
    );
    peer.connectionState = "connected";
    await vi.advanceTimersByTimeAsync(200);
    expect(await result).toMatchObject({
      relay_verified: true,
      relay_protocol: "tls",
      relay_bytes_sent: 64,
    });
  });

  it("fails when selected-pair evidence stays unavailable", async () => {
    vi.useFakeTimers();
    const publisher = fixture({
      connectionState: "connected",
      getConfiguration: () => ({ iceTransportPolicy: "relay" }),
      getStats: async () => new Map(),
    });
    const result = expect(publisher.relayEvidence()).rejects.toThrow(
      "TURN selected candidate evidence is missing",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
  });

  it("immediately rejects a connection that permits direct transport", async () => {
    const publisher = fixture({
      connectionState: "connected",
      getConfiguration: () => ({ iceTransportPolicy: "all" }),
      getStats: async () => selected(),
    });
    await expect(publisher.relayEvidence()).rejects.toThrow(
      "no longer enforces TURN relay",
    );
  });

  it("rejects a selected pair that is not carrying the published audio", async () => {
    vi.useFakeTimers();
    const stats = selected();
    stats.delete("audio");
    const publisher = fixture({
      connectionState: "connected",
      getConfiguration: () => ({ iceTransportPolicy: "relay" }),
      getStats: async () => stats,
    });
    const result = expect(publisher.relayEvidence()).rejects.toThrow(
      "TURN selected candidate evidence is missing",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
  });
});
