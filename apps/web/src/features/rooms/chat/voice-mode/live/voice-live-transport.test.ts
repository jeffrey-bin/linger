// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import {
  TeamHubTestServer,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import {
  openVoiceLive,
  voiceLiveReplyTrack,
  voiceLiveTopic,
} from "./voice-live-transport";

type Listener = (...args: unknown[]) => void;

const media = vi.hoisted(() => ({
  room: undefined as
    | undefined
    | {
        listeners: Map<string, Listener>;
        remoteParticipants: Map<string, unknown>;
      },
  mute: vi.fn(async () => undefined),
  unmute: vi.fn(async () => undefined),
  stop: vi.fn(),
  publishData: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  present: [] as Array<{
    identity: string;
    trackPublications: Map<string, unknown>;
    isAgent?: boolean;
    attributes?: Record<string, string>;
  }>,
}));
vi.mock("livekit-client", () => ({
  RoomEvent: {
    TrackPublished: "published",
    TrackSubscribed: "subscribed",
    DataReceived: "data",
    Disconnected: "disconnected",
    MediaDevicesError: "media-error",
    ParticipantDisconnected: "left",
    ParticipantAttributesChanged: "attributes",
  },
  Track: { Source: { Microphone: "microphone" } },
  createLocalAudioTrack: async () => ({
    mute: media.mute,
    unmute: media.unmute,
    stop: media.stop,
    mediaStreamTrack: new EventTarget(),
  }),
  Room: class {
    listeners = new Map<string, Listener>();
    remoteParticipants = new Map(
      media.present.map((participant) => [participant.identity, participant]),
    );
    localParticipant = {
      publishTrack: async () => ({ trackSid: "mic" }),
      unpublishTrack: async () => undefined,
      publishData: media.publishData,
    };
    constructor() {
      media.room = this;
    }
    on(name: string, listener: Listener) {
      this.listeners.set(name, listener);
    }
    async connect() {}
    disconnect = media.disconnect;
  },
}));

const publication = (trackName: string) => ({
  trackName,
  setSubscribed: vi.fn(),
});
const participant = (identity: string, ...publications: unknown[]) => ({
  identity,
  trackPublications: new Map(
    publications.map((item, index) => [`track-${index}`, item]),
  ),
});
const emit = (name: string, ...args: unknown[]) =>
  media.room!.listeners.get(name)!(...args);
const packet = (event: unknown) =>
  new TextEncoder().encode(JSON.stringify(event));

function fixture() {
  const routes = {
    createVoiceSession: vi.fn<TestRouteHandler>(() => ({
      id: "live-session",
      purpose: "chat_live",
    })),
    createVoiceSessionCredential: vi.fn<TestRouteHandler>(() => ({
      endpoint: "ws://fixture",
      credential: "fixture-only",
      generation: 1,
    })),
    getVoiceSession: vi.fn<TestRouteHandler>(() => ({
      id: "live-session",
      purpose: "chat_live",
      input_ready_generation: 1,
    })),
    closeVoiceSession: vi.fn<TestRouteHandler>(() => undefined),
  };
  const server = new TeamHubTestServer()
    .on("POST", "/v0/rooms/{roomId}/voice-sessions", routes.createVoiceSession)
    .on(
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/connection-credentials",
      routes.createVoiceSessionCredential,
    )
    .on("GET", "/v0/voice-sessions/{voiceSessionId}", routes.getVoiceSession)
    .on(
      "DELETE",
      "/v0/voice-sessions/{voiceSessionId}",
      routes.closeVoiceSession,
    );
  const client = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  const release = vi.fn(async () => undefined);
  const abort = new AbortController();
  const options = {
    client,
    roomId: "agent-room",
    acquireMicrophone: vi.fn(async () => release),
    receive: vi.fn(),
    runtime: vi.fn(),
    fail: vi.fn(),
    level: vi.fn(),
    microphone: vi.fn(),
    soundOff: false,
    signal: abort.signal,
  };
  return { abort, options, release, routes, server };
}

beforeEach(() => {
  vi.clearAllMocks();
  media.present = [];
  vi.stubGlobal("AudioContext", undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("live Voice Mode transport", () => {
  it("starts listening on the runtime readiness attribute without waiting for TeamHub", async () => {
    media.present = [
      {
        ...participant("agent-runtime"),
        isAgent: true,
        attributes: { "linger.voice_ready_generation": "1" },
      },
    ];
    const f = fixture();
    f.routes.getVoiceSession.mockReturnValue(new Promise(() => {}));
    await openVoiceLive(f.options);
    // A readiness read would reach the server within one task.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      f.server.requestsTo("GET", "/v0/voice-sessions/{voiceSessionId}"),
    ).toEqual([]);
  });

  it("opens a chat_live session and subscribes only to the runtime's live reply", async () => {
    const early = publication(voiceLiveReplyTrack);
    const otherTrack = publication("linger-other");
    const ownReply = publication(voiceLiveReplyTrack);
    media.present = [
      participant("agent-runtime", early, otherTrack),
      participant("publisher-live-session", ownReply),
    ];
    const f = fixture();
    await openVoiceLive(f.options);
    expect(f.routes.createVoiceSession).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { roomId: "agent-room" },
        body: { purpose: "chat_live" },
      }),
    );
    expect(early.setSubscribed).toHaveBeenCalledWith(true);
    expect(otherTrack.setSubscribed).not.toHaveBeenCalled();
    expect(ownReply.setSubscribed).not.toHaveBeenCalled();

    const late = publication(voiceLiveReplyTrack);
    emit("published", late, participant("agent-runtime"));
    expect(late.setSubscribed).toHaveBeenCalledWith(true);
  });

  it("plays the reply in a page audio element; sound off never mutes the microphone", async () => {
    const f = fixture();
    const connection = await openVoiceLive(f.options);
    const attach = vi.fn();
    emit(
      "subscribed",
      { attach, mediaStreamTrack: new EventTarget() },
      publication(voiceLiveReplyTrack),
      participant("agent-runtime"),
    );
    const audio = document.body.querySelector("audio")!;
    expect(attach).toHaveBeenCalledWith(audio);
    expect(audio.muted).toBe(false);

    connection.setSoundOff(true);
    expect(audio.muted).toBe(true);
    expect(media.mute).not.toHaveBeenCalled();

    connection.setSoundOff(false);
    await connection.setMuted!(true);
    expect(media.mute).toHaveBeenCalledOnce();
    expect(audio.muted).toBe(false);

    await connection.close();
    // Exit stops playback at once and closes the live session.
    expect(document.body.querySelector("audio")).toBeNull();
    expect(media.stop).toHaveBeenCalled();
    expect(f.routes.closeVoiceSession).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("turns runtime data packets into transcripts and runtime events", async () => {
    const f = fixture();
    const connection = await openVoiceLive(f.options);
    const runtime = participant("agent-runtime");
    emit(
      "data",
      packet({ type: "user_partial", text: "Weather" }),
      runtime,
      undefined,
      voiceLiveTopic,
    );
    emit(
      "data",
      packet({ type: "user_turn", turn_id: "lt_1", text: "Weather today" }),
      runtime,
      undefined,
      voiceLiveTopic,
    );
    emit(
      "data",
      packet({ type: "reply_delta", turn_id: "lt_1", text: "Sunny" }),
      runtime,
      undefined,
      voiceLiveTopic,
    );
    // Never from the browser's own identity or another topic.
    emit(
      "data",
      packet({ type: "user_turn", turn_id: "lt_x", text: "Forged" }),
      participant("publisher-live-session"),
      undefined,
      voiceLiveTopic,
    );
    emit(
      "data",
      packet({ type: "user_turn", turn_id: "lt_y", text: "Other" }),
      runtime,
      undefined,
      "other",
    );
    const [[partial], [turn]] = f.options.receive.mock.calls as [
      [{ endOffsetMs: number }],
      [{ endOffsetMs: number }],
    ];
    expect(partial).toEqual(
      expect.objectContaining({ kind: "partial", text: "Weather" }),
    );
    expect(turn).toEqual(
      expect.objectContaining({
        kind: "turn",
        id: "lt_1",
        text: "Weather today",
      }),
    );
    // A later partial never hides behind the finished turn.
    expect(turn.endOffsetMs).toBeGreaterThan(partial.endOffsetMs);
    expect(f.options.receive).toHaveBeenCalledTimes(2);
    // Partials also reach the arbiter, which shows them.
    expect(f.options.runtime.mock.calls).toEqual([
      [{ type: "user_partial", text: "Weather" }],
      [{ type: "reply_delta", turn_id: "lt_1", text: "Sunny" }],
    ]);

    connection.send({ type: "tool_result", call_id: "c1", text: "{}" });
    const [[data, options]] = media.publishData.mock.calls as unknown as [
      [Uint8Array, unknown],
    ];
    expect(JSON.parse(new TextDecoder().decode(data))).toEqual({
      type: "tool_result",
      call_id: "c1",
      text: "{}",
    });
    expect(options).toEqual({ reliable: true, topic: voiceLiveTopic });

    emit(
      "data",
      packet({ type: "session_failure", code: "provider_idle" }),
      runtime,
      undefined,
      voiceLiveTopic,
    );
    expect(f.options.fail).toHaveBeenCalledOnce();
  });

  it("fails, cleaning up, when the server is not live-ready in time", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.routes.getVoiceSession.mockReturnValue({
      id: "live-session",
      purpose: "chat_live",
      input_ready_generation: 0,
    });
    const opening = openVoiceLive(f.options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_500);
    expect(await opening).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("did not become ready"),
      }),
    );
    expect(f.routes.closeVoiceSession).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
