/// <reference lib="dom" />
// Functions here run inside the browser page through Playwright.

import { chromium, type Browser, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { lookup } from "node:dns/promises";
import { dirname, resolve } from "node:path";
import type * as LiveKit from "livekit-client";

interface BrowserState {
  LivekitClient: typeof LiveKit;
  voiceSmoke: {
    peers: RTCPeerConnection[];
    iceErrors: { code: number; text: string; url: string }[];
    candidates: {
      side: string;
      type: string | null;
      address: string | null;
      protocol: string | null;
    }[];
    room?: LiveKit.Room;
    audio?: AudioContext;
    source?: AudioBufferSourceNode;
    startedAt?: number;
  };
}

export class BrowserSmokePublisher {
  private browser?: Browser;
  private page?: Page;

  async connect(endpoint: string, credential: string, pcm: Int16Array) {
    this.browser = await chromium.launch({
      headless: true,
      executablePath: process.env.VOICE_SOAK_CHROMIUM_EXECUTABLE || undefined,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ],
    });
    this.page = await this.browser.newPage({ permissions: ["microphone"] });
    const origin = new URL(endpoint);
    origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
    await this.page.goto(origin.origin, { waitUntil: "domcontentloaded" });
    await this.page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    });
    const sdk =
      process.env.VOICE_SOAK_BROWSER_SDK ||
      resolve(
        dirname(createRequire(import.meta.url).resolve("livekit-client")),
        "livekit-client.umd.js",
      );
    await this.page.addScriptTag({ path: sdk });
    await this.page
      .evaluate(
        async ({ endpoint, credential, samples, requireRelay }) => {
          const state = window as unknown as BrowserState;
          const original = window.RTCPeerConnection;
          state.voiceSmoke = { peers: [], iceErrors: [], candidates: [] };
          window.RTCPeerConnection = class extends original {
            constructor(config?: RTCConfiguration) {
              super(config);
              state.voiceSmoke.peers.push(this);
              this.addEventListener("icecandidate", (event) => {
                if (
                  event.candidate &&
                  state.voiceSmoke.candidates.length < 40
                ) {
                  const { type, address, protocol } = event.candidate;
                  state.voiceSmoke.candidates.push({
                    side: "local",
                    type,
                    address,
                    protocol,
                  });
                }
              });
              this.addEventListener("icecandidateerror", (event) => {
                const error = event;
                if (state.voiceSmoke.iceErrors.length < 10)
                  state.voiceSmoke.iceErrors.push({
                    code: error.errorCode,
                    text: error.errorText,
                    url: error.url,
                  });
              });
            }
            override addIceCandidate(candidate?: RTCIceCandidateInit | null) {
              if (
                candidate?.candidate &&
                state.voiceSmoke.candidates.length < 40
              ) {
                const { type, address, protocol } = new RTCIceCandidate(
                  candidate,
                );
                state.voiceSmoke.candidates.push({
                  side: "remote",
                  type,
                  address,
                  protocol,
                });
              }
              return super.addIceCandidate(candidate);
            }
          };
          const room = new state.LivekitClient.Room({
            adaptiveStream: false,
            dynacast: false,
          });
          state.voiceSmoke.room = room;
          await room.connect(endpoint, credential, {
            autoSubscribe: false,
            rtcConfig: requireRelay
              ? { iceTransportPolicy: "relay" }
              : undefined,
          });
          const audio = new AudioContext({ sampleRate: 48_000 });
          state.voiceSmoke.audio = audio;
          await audio.resume();
          const source = audio.createBufferSource();
          const buffer = audio.createBuffer(1, samples.length, 48_000);
          buffer.copyToChannel(
            Float32Array.from(samples, (value) => value / 32768),
            0,
          );
          source.buffer = buffer;
          source.loop = true;
          state.voiceSmoke.source = source;
          const output = audio.createMediaStreamDestination();
          source.connect(output);
          const track = output.stream.getAudioTracks()[0]!;
          await room.localParticipant.publishTrack(track, {
            source: state.LivekitClient.Track.Source.Microphone,
            name: "voice-soak-browser",
            dtx: false,
            red: true,
          });
        },
        {
          endpoint,
          credential,
          samples: Array.from(pcm),
          requireRelay: process.env.VOICE_SOAK_REQUIRE_RELAY === "1",
        },
      )
      .catch(async (error: unknown) => {
        const ice = await this.page!.evaluate(async () => {
          const { voiceSmoke } = window as unknown as BrowserState;
          return {
            errors: voiceSmoke.iceErrors,
            candidates: voiceSmoke.candidates,
            peers: await Promise.all(
              voiceSmoke.peers.map(async (peer) => ({
                state: peer.connectionState,
                policy: peer.getConfiguration().iceTransportPolicy,
                servers: peer
                  .getConfiguration()
                  .iceServers?.map((server) => server.urls),
                candidates: [...(await peer.getStats()).values()]
                  .filter((item) => item.type === "local-candidate")
                  .map((item) => ({
                    kind: item.candidateType,
                    relay: item.relayProtocol,
                  })),
              })),
            ),
          };
        }).catch(() => undefined);
        console.log(JSON.stringify({ status: "diagnostic", ice }));
        throw error;
      });
  }

  async start() {
    await this.page!.evaluate(() => {
      const { voiceSmoke } = window as unknown as BrowserState;
      voiceSmoke.startedAt = voiceSmoke.audio!.currentTime;
      voiceSmoke.source!.start();
    });
  }

  async stop() {
    return this.page!.evaluate(() => {
      const { voiceSmoke } = window as unknown as BrowserState;
      const samples = Math.floor(
        (voiceSmoke.audio!.currentTime - voiceSmoke.startedAt!) * 48_000,
      );
      voiceSmoke.source!.stop();
      return samples;
    });
  }

  async relayEvidence() {
    const started = Date.now();
    const deadline = started + 5_000;
    let samples = 1;
    const read = () =>
      this.page!.evaluate(async () => {
        const { voiceSmoke } = window as unknown as BrowserState;
        if (voiceSmoke.room!.state === "disconnected")
          throw new Error("Browser publisher disconnected during soak");
        if (voiceSmoke.audio!.state !== "running")
          throw new Error("Browser audio context is not running");
        const evidence: {
          candidateType: string;
          relayProtocol: string;
          address: string;
          url: string;
          bytesSent: number;
        }[] = [];
        for (const peer of voiceSmoke.peers) {
          if (peer.connectionState !== "connected") continue;
          if (peer.getConfiguration().iceTransportPolicy !== "relay")
            throw new Error("Browser publisher no longer enforces TURN relay");
          const stats = [...(await peer.getStats()).values()];
          for (const transport of stats.filter(
            (item) =>
              item.type === "transport" &&
              stats.some(
                (rtp) =>
                  rtp.type === "outbound-rtp" &&
                  (rtp.kind === "audio" || rtp.mediaType === "audio") &&
                  rtp.transportId === item.id &&
                  rtp.bytesSent > 0,
              ),
          )) {
            const pair = stats.find(
              (item) => item.id === transport.selectedCandidatePairId,
            );
            if (!pair || pair.bytesSent <= 0) continue;
            const candidate = stats.find(
              (item) => item.id === pair.localCandidateId,
            );
            if (!candidate)
              throw new Error("Browser selected candidate is missing");
            evidence.push({
              candidateType: candidate.candidateType,
              relayProtocol: candidate.relayProtocol,
              address: candidate.address,
              url: candidate.url,
              bytesSent: pair.bytesSent,
            });
          }
        }
        return {
          pairs: evidence,
          room_state: voiceSmoke.room!.state,
          connections: voiceSmoke.peers.map((peer) => ({
            connection: peer.connectionState,
            ice: peer.iceConnectionState,
            signaling: peer.signalingState,
          })),
        };
      });
    let snapshot = await read();
    while (snapshot.pairs.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(200, deadline - Date.now())),
      );
      snapshot = await read();
      samples += 1;
    }
    const pairs = snapshot.pairs;
    if (pairs.length === 0)
      throw new Error(
        `TURN selected candidate evidence is missing: ${JSON.stringify(snapshot)}`,
      );
    for (const pair of pairs) {
      if (
        !["relay", "prflx"].includes(pair.candidateType) ||
        pair.relayProtocol !== "tls" ||
        !pair.url
      )
        throw new Error(
          `TURN path is not the required public TLS relay: ${JSON.stringify(pair)}`,
        );
      // A relay talking to a colocated SFU can expose its private address as prflx.
      const turn = new URL(pair.url);
      if (turn.protocol !== "turns:")
        throw new Error("Selected relay is not TURN/TLS");
      const server = new URL(`https://${turn.pathname}`);
      const addresses = await lookup(server.hostname, { all: true });
      if (
        !process.env.VOICE_SOAK_TURN_PUBLIC_IP ||
        !addresses.some(
          (item) => item.address === process.env.VOICE_SOAK_TURN_PUBLIC_IP,
        )
      )
        throw new Error(
          "Selected TURN server does not resolve to the required public IP",
        );
    }
    return {
      relay_verified: true as const,
      relay_protocol: pairs[0]!.relayProtocol,
      relay_address: process.env.VOICE_SOAK_TURN_PUBLIC_IP!,
      relay_candidate_type: pairs[0]!.candidateType,
      relay_peer_address: pairs[0]!.address,
      relay_url: pairs[0]!.url,
      relay_bytes_sent: pairs.reduce(
        (total, pair) => total + pair.bytesSent,
        0,
      ),
      relay_evidence_wait_ms: Date.now() - started,
      relay_evidence_samples: samples,
    };
  }

  async close() {
    await this.page
      ?.evaluate(async () => {
        const { voiceSmoke } = window as unknown as BrowserState;
        await voiceSmoke?.room?.disconnect();
        await voiceSmoke?.audio?.close();
      })
      .catch(() => undefined);
    await this.browser?.close();
  }
}
