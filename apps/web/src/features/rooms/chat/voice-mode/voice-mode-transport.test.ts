import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import {
  TeamHubTestServer,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import type {
  TeamHubVoiceSession,
  TeamHubVoiceTranscriptEvent,
  TeamHubVoiceTranscriptEventPage,
} from "@/features/teamhub/teamhub-types";
import type {
  VoiceEventSubscription,
  VoiceEventTransport,
} from "@/features/teamhub/voice-event-transport";
import { openVoiceMode } from "./voice-mode-transport";
import { smoothVoiceLevel } from "./voice-media-room";

const media = vi.hoisted(() => ({
  createTrack: vi.fn(async (_options: { deviceId?: { exact: string } }) => ({
    mute: media.mute,
    unmute: media.unmute,
    stop: media.stop,
    mediaStreamTrack: Object.assign(new EventTarget(), {
      getSettings: () => ({ deviceId: "default-mic" }),
    }),
  })),
  mute: vi.fn(async () => undefined),
  unmute: vi.fn(async () => undefined),
  stop: vi.fn(),
  publish: vi.fn(async () => ({ trackSid: "fixture-track" })),
  disconnect: vi.fn(async () => undefined),
  unpublish: vi.fn(),
  autoDrain: true,
  failBeforeReady: false,
  hiddenRuntime: false,
  attributes: undefined as undefined | ((...args: unknown[]) => void),
}));
vi.mock("livekit-client", () => ({
  RoomEvent: {
    Disconnected: "disconnected",
    MediaDevicesError: "media-error",
    ParticipantAttributesChanged: "attributes",
    ParticipantDisconnected: "left",
  },
  Track: { Source: { Microphone: "microphone" } },
  createLocalAudioTrack: media.createTrack,
  Room: class {
    private listeners = new Map<string, (...args: unknown[]) => void>();
    private runtime = {
      identity: "trusted-runtime",
      isAgent: true,
      attributes: {
        "linger.voice_ready_generation": "2",
        "linger.voice_ready_track": "fixture-track",
      },
    };
    remoteParticipants = new Map(
      media.hiddenRuntime ? [] : [["trusted-runtime", this.runtime]],
    );
    localParticipant = {
      publishTrack: media.publish,
      unpublishTrack: async () => {
        await media.unpublish();
      },
    };
    on(name: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(name, listener);
      if (name === "attributes") media.attributes = listener;
    }
    async connect() {
      if (media.failBeforeReady)
        this.listeners.get("attributes")?.(
          {
            "linger.voice_dictation_failure": "transcript_unconfirmed",
            "linger.voice_dictation_failure_generation": "2",
          },
          this.runtime,
        );
    }
    disconnect = media.disconnect;
  },
}));

function fixture() {
  const session = {
    id: "chat-session",
    purpose: "chat_dictation",
    input_ready_generation: 2,
  };
  const routes = {
    createVoiceSession: vi.fn<TestRouteHandler>(() => session),
    createVoiceSessionCredential: vi.fn<TestRouteHandler>(() => ({
      endpoint: "ws://fixture",
      credential: "fixture-only",
      generation: 2,
    })),
    getVoiceSession: vi.fn<TestRouteHandler>(
      (): Partial<TeamHubVoiceSession> => ({
        ...session,
        purpose: "chat_dictation",
        credential_generation: 2,
        input_started_offset_ms: 10,
        ...(media.autoDrain && media.unpublish.mock.calls.length
          ? { input_ended_offset_ms: 100 }
          : {}),
      }),
    ),
    commitVoiceDictationTurn: vi.fn<TestRouteHandler>(() => ({
      status: "accepted",
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
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/dictation-commit",
      routes.commitVoiceDictationTurn,
    )
    .on(
      "DELETE",
      "/v0/voice-sessions/{voiceSessionId}",
      routes.closeVoiceSession,
    );
  const client = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  const transcript = vi.fn<() => Promise<TeamHubVoiceTranscriptEventPage>>(
    async () => ({ items: [] }),
  );
  const release = vi.fn(async () => undefined);
  const acquireMicrophone = vi.fn(async () => release);
  const abort = new AbortController();
  const feed = feedOn(transcript);
  const options = {
    client,
    events: feed.transport,
    roomId: "agent-room",
    acquireMicrophone,
    signal: abort.signal,
    receive: vi.fn(),
    fail: vi.fn(),
    level: vi.fn(),
    microphone: vi.fn(),
  };
  return {
    routes,
    transcript,
    release,
    acquireMicrophone,
    abort,
    options,
    feed,
  };
}

// The shared event feed, faked by reading the transcript mock every 100 ms;
// a catch-up reads it once more.
function feedOn(read: () => Promise<TeamHubVoiceTranscriptEventPage>) {
  const subscriptions: VoiceEventSubscription[] = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  const catchUp = vi.fn();
  const transport: VoiceEventTransport = {
    subscribe(input) {
      subscriptions.push(input);
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deliver = async () => {
        const page = await read();
        if (!stopped) input.onTranscriptPage(page);
      };
      const poll = () => {
        const next = () => {
          if (!stopped) timer = setTimeout(poll, 100);
        };
        void deliver().then(next, next);
      };
      poll();
      const stop = vi.fn(() => {
        stopped = true;
        clearTimeout(timer);
      });
      stops.push(stop);
      return Object.assign(stop, {
        catchUp: async (signal: AbortSignal) => {
          catchUp(signal);
          await deliver();
        },
      });
    },
  };
  return { transport, subscriptions, stops, catchUp };
}

function dictationTurn(id: string): TeamHubVoiceTranscriptEvent {
  return {
    id,
    event_id: id,
    voice_session_id: "chat-session",
    media_epoch: 0,
    lane: "live",
    kind: "dictation_turn",
    text: `Turn ${id}`,
    start_offset_ms: 0,
    end_offset_ms: 100,
    accepted_at: "2026-09-20T00:00:00Z",
    updated_at: "2026-09-20T00:00:00Z",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  media.autoDrain = true;
  media.failBeforeReady = false;
  media.hiddenRuntime = false;
  vi.stubGlobal("AudioContext", undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Voice Mode transport boundaries", () => {
  it("accepts TeamHub readiness for a hidden Runtime without any speech", async () => {
    media.hiddenRuntime = true;
    const f = fixture();
    const opening = openVoiceMode(f.options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    const connection = await opening;
    expect(connection).not.toBeInstanceOf(Error);
    expect(f.routes.getVoiceSession).toHaveBeenCalledOnce();
    expect(f.options.receive).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "speech" }),
    );
    await (connection as Awaited<ReturnType<typeof openVoiceMode>>).close();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each([0, 1])(
    "does not accept a hidden Runtime with unready or stale generation %s",
    async (generation) => {
      media.hiddenRuntime = true;
      const f = fixture();
      f.routes.getVoiceSession.mockReturnValue({
        id: "chat-session",
        purpose: "chat_dictation",
        input_ready_generation: generation,
      });
      const opening = openVoiceMode(f.options).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await opening).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("did not become ready"),
        }),
      );
      expect(f.routes.closeVoiceSession).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it.each(["ready", "timeout", "cancel"] as const)(
    "exposes the microphone before silent Runtime readiness and clears it on %s",
    async (outcome) => {
      const f = fixture();
      f.routes.getVoiceSession.mockReturnValue({
        id: "chat-session",
        purpose: "chat_dictation",
        input_ready_generation: 0,
      });
      let settled = false;
      const opening = openVoiceMode(f.options).then(
        (connection) => {
          settled = true;
          return connection;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      expect(f.options.microphone).toHaveBeenCalledOnce();
      expect(media.publish).toHaveBeenCalledOnce();
      const microphone = f.options.microphone.mock.calls[0]![0];
      await microphone.setMuted(true);
      expect(media.mute).toHaveBeenCalledOnce();
      await microphone.setMuted(false);
      expect(media.unmute).toHaveBeenCalledOnce();
      if (outcome === "ready") {
        f.routes.getVoiceSession.mockReturnValue({
          id: "chat-session",
          purpose: "chat_dictation",
          credential_generation: 2,
          input_ready_generation: 2,
          input_started_offset_ms: 10,
          input_ended_offset_ms: 100,
        });
        await vi.advanceTimersByTimeAsync(200);
        const connection = (await opening) as Awaited<
          ReturnType<typeof openVoiceMode>
        >;
        await connection.close();
      } else {
        if (outcome === "cancel") f.abort.abort();
        else await vi.advanceTimersByTimeAsync(15_000);
        expect(await opening).toBeInstanceOf(Error);
      }
      expect(f.options.microphone).toHaveBeenLastCalledWith(undefined);
      expect(media.stop).toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
      await microphone.setMuted(true);
      expect(media.mute).toHaveBeenCalledOnce();
    },
  );
  it("smooths voice level changes with a noise floor and slower release", () => {
    expect(smoothVoiceLevel(0, 0.01)).toBe(0);
    const rising = smoothVoiceLevel(0, 0.8);
    const falling = smoothVoiceLevel(rising, 0);
    expect(rising).toBeGreaterThan(0);
    expect(falling).toBeGreaterThan(0);
    expect(falling).toBeLessThan(rising);
  });

  it("mutes and unmutes the published microphone track", async () => {
    const f = fixture();
    const connection = await openVoiceMode(f.options);
    await connection.setMuted?.(true);
    await connection.setMuted?.(false);
    expect(media.mute).toHaveBeenCalledOnce();
    expect(media.unmute).toHaveBeenCalledOnce();
    await connection.close();
  });

  it("opens the bound microphone, then the system default once it is gone, and binds it", async () => {
    const f = fixture();
    const adoptDevice = vi.fn();
    media.createTrack.mockRejectedValueOnce(
      new DOMException("gone", "OverconstrainedError"),
    );
    const connection = await openVoiceMode({
      ...f.options,
      deviceId: "usb",
      adoptDevice,
    });

    expect(media.createTrack.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ deviceId: { exact: "usb" } }),
      expect.objectContaining({ deviceId: undefined }),
    ]);
    expect(adoptDevice).toHaveBeenCalledExactlyOnceWith("default-mic");
    await connection.close();
  });

  it("retries a transient microphone abort before publishing", async () => {
    const f = fixture();
    media.createTrack.mockRejectedValueOnce(
      new DOMException("signal is aborted without reason", "AbortError"),
    );
    const opening = openVoiceMode(f.options);
    await vi.advanceTimersByTimeAsync(120);
    const connection = await opening;

    expect(media.createTrack).toHaveBeenCalledTimes(2);
    expect(media.publish).toHaveBeenCalledOnce();
    await connection.close();
  });

  it("starts the browser microphone while the VoiceSession is provisioning", async () => {
    const f = fixture();
    let finishSession!: (session: {
      id: string;
      purpose: string;
      input_ready_generation: number;
    }) => void;
    f.routes.createVoiceSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSession = resolve;
        }),
    );
    const opening = openVoiceMode(f.options);
    await vi.advanceTimersByTimeAsync(0);
    expect(media.createTrack).toHaveBeenCalledOnce();
    finishSession({
      id: "chat-session",
      purpose: "chat_dictation",
      input_ready_generation: 2,
    });
    const connection = await opening;
    await connection.close();
  });

  it("surfaces a generation-scoped Runtime failure before readiness instead of waiting for the timeout", async () => {
    const f = fixture();
    media.failBeforeReady = true;
    f.routes.getVoiceSession.mockReturnValue({
      id: "chat-session",
      purpose: "chat_dictation",
      input_ready_generation: 0,
    });
    await expect(openVoiceMode(f.options)).rejects.toThrow(
      "Voice Runtime stopped before readiness",
    );
    expect(f.routes.closeVoiceSession).toHaveBeenCalledOnce();
  });
  it("starts the transcript feed when Runtime speech arrives before readiness projection", async () => {
    const f = fixture();
    f.routes.getVoiceSession.mockReturnValue({
      id: "chat-session",
      purpose: "chat_dictation",
      input_ready_generation: 0,
    });
    f.transcript.mockResolvedValue({
      items: [
        {
          id: "early-speech",
          event_id: "early-speech",
          voice_session_id: "chat-session",
          media_epoch: 0,
          lane: "live",
          kind: "speech",
          text: "The Runtime already recognized this",
          start_offset_ms: 0,
          end_offset_ms: 500,
          accepted_at: "2026-09-21T00:00:00Z",
          updated_at: "2026-09-21T00:00:00Z",
        },
      ],
    });
    const opening = openVoiceMode(f.options);
    await vi.advanceTimersByTimeAsync(300);
    const connection = await opening;
    expect(f.options.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "speech",
        text: "The Runtime already recognized this",
      }),
    );
    f.routes.getVoiceSession.mockReturnValue({
      id: "chat-session",
      purpose: "chat_dictation",
      credential_generation: 2,
      input_started_offset_ms: 0,
      input_ended_offset_ms: 500,
    });
    await connection.close();
  });
  it("uses a schema-valid UUID for commit request_id instead of an HTTP key prefix", async () => {
    const f = fixture();
    const connection = await openVoiceMode(f.options);
    const committing = connection.commit().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.routes.commitVoiceDictationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { voiceSessionId: "chat-session" },
        body: {
          request_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
        },
      }),
    );
    await connection.close();
    await committing;
  });
  it("reads the shared feed, survives failed reads and stops the feed on close", async () => {
    const f = fixture();
    f.transcript.mockRejectedValueOnce(new Error("Voice request timed out"));
    const connection = await openVoiceMode(f.options);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.feed.subscriptions).toHaveLength(1);
    expect(f.feed.subscriptions[0]!.voiceSessionId).toBe("chat-session");
    expect(f.options.fail).not.toHaveBeenCalled();
    await connection.close();
    expect(f.feed.stops[0]).toHaveBeenCalled();
    const reads = f.transcript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.transcript).toHaveBeenCalledTimes(reads);
  });
  it("confirms the last turn with a feed catch-up once input has ended", async () => {
    const f = fixture();
    const connection = await openVoiceMode(f.options);
    await vi.advanceTimersByTimeAsync(0);
    f.transcript.mockResolvedValue({
      items: [dictationTurn("last-turn")],
    });
    await connection.close();
    expect(f.feed.catchUp).toHaveBeenCalledOnce();
    expect(f.options.receive).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "turn", id: "last-turn" }),
    );
  });
  it("acknowledges a commit once, however often its turn is delivered", async () => {
    const f = fixture();
    const connection = await openVoiceMode(f.options);
    await vi.advanceTimersByTimeAsync(0);
    f.transcript.mockResolvedValue({
      items: [dictationTurn("old-turn")],
    });
    await vi.advanceTimersByTimeAsync(100);
    const committing = connection.commit().then(
      () => "accepted",
      (error: unknown) => error,
    );
    // The same turn delivered again must not acknowledge the new commit.
    await vi.advanceTimersByTimeAsync(1_000);
    let settled = false;
    void committing.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    f.transcript.mockResolvedValue({
      items: [dictationTurn("old-turn"), dictationTurn("new-turn")],
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(await committing).toBe("accepted");
    await connection.close();
  });
  it("fails the session when the feed loses access", async () => {
    const f = fixture();
    const connection = await openVoiceMode(f.options);
    f.feed.subscriptions[0]!.onAccessLost();
    expect(f.options.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("access was lost"),
      }),
    );
    await connection.close();
  });

  it("does not lose a turn ACK that arrives before its commit HTTP receipt", async () => {
    const f = fixture();
    const connection = await openVoiceMode(f.options);
    await vi.advanceTimersByTimeAsync(0);
    let finishReceipt!: (receipt: { status: string }) => void;
    f.routes.commitVoiceDictationTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReceipt = resolve;
        }),
    );
    f.transcript.mockResolvedValueOnce({
      items: [
        {
          id: "committed-turn",
          event_id: "committed-turn",
          voice_session_id: "chat-session",
          media_epoch: 0,
          lane: "live",
          kind: "dictation_turn",
          text: "Confirmed speech",
          start_offset_ms: 0,
          end_offset_ms: 100,
          accepted_at: "2026-09-20T00:00:00Z",
          updated_at: "2026-09-20T00:00:00Z",
        },
      ],
    });
    const committing = connection.commit();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.options.receive).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "turn", id: "committed-turn" }),
    );
    finishReceipt({ status: "accepted" });
    await committing;
    await connection.close();
    expect(f.options.fail).not.toHaveBeenCalled();
  });
  it.each(["timeout", "cancel"] as const)(
    "releases a late microphone lease after %s without opening a session",
    async (reason) => {
      const f = fixture();
      let finish!: (release: typeof f.release) => void;
      f.acquireMicrophone.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const result = openVoiceMode(f.options).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      if (reason === "cancel") f.abort.abort();
      else await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toBeInstanceOf(Error);
      finish(f.release);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.routes.createVoiceSession).not.toHaveBeenCalled();
    },
  );
  it("waits for the latest persisted input boundary without a LiveKit ACK", async () => {
    const f = fixture();
    const connection = await openVoiceMode(f.options);
    media.autoDrain = false;
    const closing = connection.close();
    f.routes.getVoiceSession.mockReturnValue({
      id: "chat-session",
      purpose: "chat_dictation",
      credential_generation: 2,
      input_started_offset_ms: 110,
      input_ended_offset_ms: 100,
      input_ready_generation: 0,
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(f.routes.closeVoiceSession).not.toHaveBeenCalled();
    f.routes.getVoiceSession.mockReturnValue({
      id: "chat-session",
      purpose: "chat_dictation",
      credential_generation: 2,
      input_started_offset_ms: 110,
      input_ended_offset_ms: 110,
    });
    await vi.advanceTimersByTimeAsync(200);
    await closing;
    expect(f.routes.closeVoiceSession).toHaveBeenCalledOnce();
  });
  it("stops the microphone immediately but waits for unpublish and shares one close", async () => {
    const f = fixture();
    const connection = await openVoiceMode(f.options);
    let unpublished!: () => void;
    media.unpublish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          unpublished = resolve;
        }),
    );
    const reads = f.routes.getVoiceSession.mock.calls.length;
    const closing = connection.close();
    expect(connection.close()).toBe(closing);
    expect(media.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.routes.getVoiceSession).toHaveBeenCalledTimes(reads);
    expect(f.routes.closeVoiceSession).not.toHaveBeenCalled();
    unpublished();
    await closing;
    expect(media.unpublish).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("does not accept a different publisher generation as a completed drain", async () => {
    const f = fixture();
    const connection = await openVoiceMode(f.options);
    f.routes.getVoiceSession.mockReturnValue({
      id: "chat-session",
      purpose: "chat_dictation",
      credential_generation: 3,
      input_started_offset_ms: 10,
      input_ended_offset_ms: 100,
    });
    await expect(connection.close()).rejects.toThrow("identity changed");
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("bounds an unconfirmed drain and still releases resources", async () => {
    const f = fixture();
    const connection = await openVoiceMode(f.options);
    media.autoDrain = false;
    const closing = connection.close().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await closing).toBeInstanceOf(Error);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.routes.closeVoiceSession).toHaveBeenCalledOnce();
  });
  it("rejects a server which ignores chat purpose and closes only the returned session", async () => {
    const f = fixture();
    f.routes.createVoiceSession.mockReturnValue({
      id: "wrong-session",
      purpose: "hardware_control",
      input_ready_generation: 2,
    });
    await expect(openVoiceMode(f.options)).rejects.toThrow("chat-only");
    expect(media.publish).not.toHaveBeenCalled();
    expect(f.routes.closeVoiceSession).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { voiceSessionId: "wrong-session" },
        request: expect.objectContaining({ keepalive: true }),
      }),
    );
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("stops the physical input before bounded flush and always closes the session", async () => {
    const f = fixture();
    const connection = await openVoiceMode(f.options);
    expect(f.routes.createVoiceSession).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { roomId: "agent-room" },
        body: { purpose: "chat_dictation" },
      }),
    );
    const closing = connection.close();
    expect(media.stop).toHaveBeenCalledOnce();
    expect(media.unpublish).toHaveBeenCalledOnce();
    expect(f.routes.commitVoiceDictationTurn).not.toHaveBeenCalled();
    expect(f.routes.closeVoiceSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    await closing;
    expect(media.publish).toHaveBeenCalledOnce();
    expect(media.disconnect).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.routes.closeVoiceSession).toHaveBeenCalledOnce();
    await connection.close();
    expect(media.stop).toHaveBeenCalledOnce();
  });
  it("holds the microphone lease until the VoiceSession close settles", async () => {
    const f = fixture();
    let settleClose!: () => void;
    f.routes.closeVoiceSession.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          settleClose = () => resolve(undefined);
        }),
    );
    const connection = await openVoiceMode(f.options);

    const closing = connection.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(f.routes.closeVoiceSession).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
    settleClose();
    await closing;
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("cleans a late-created session when its request times out", async () => {
    const f = fixture();
    let finish!: (value: {
      id: string;
      purpose: string;
      input_ready_generation: number;
    }) => void;
    f.routes.createVoiceSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = openVoiceMode(f.options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBeInstanceOf(Error);
    finish({
      id: "late-session",
      purpose: "chat_dictation",
      input_ready_generation: 2,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.routes.closeVoiceSession).toHaveBeenCalledWith(
      expect.objectContaining({ params: { voiceSessionId: "late-session" } }),
    );
    expect(f.release).toHaveBeenCalledOnce();
    expect(media.publish).not.toHaveBeenCalled();
  });
});
