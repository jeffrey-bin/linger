import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import {
  TeamHubTestServer,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import {
  openVoiceMicrophone,
  publishVoiceMicrophone,
} from "./voice-media-connection";

const credential = () => ({
  endpoint: "ws://fixture",
  credential: "fixture-only",
  generation: 1,
  expires_at: "2026-10-28T00:00:00Z",
});

function credentialClient(answer: TestRouteHandler) {
  const server = new TeamHubTestServer().on(
    "POST",
    "/v0/voice-sessions/{voiceSessionId}/connection-credentials",
    answer,
  );
  return createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
}

interface Track {
  mediaStreamTrack: EventTarget & { getSettings(): { deviceId: string } };
  stop: ReturnType<typeof vi.fn>;
}

function track(deviceId = "usb"): Track {
  return {
    mediaStreamTrack: Object.assign(new EventTarget(), {
      getSettings: () => ({ deviceId }),
    }),
    stop: vi.fn(),
  };
}

function livekit(options: {
  createLocalAudioTrack?: (constraints: unknown) => Promise<Track>;
  connect?: () => Promise<void>;
  publish?: () => Promise<{ trackSid: string }>;
}) {
  const rooms: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  const module = {
    RoomEvent: { Disconnected: "disconnected" },
    Track: { Source: { Microphone: "microphone" } },
    createLocalAudioTrack: vi.fn(
      options.createLocalAudioTrack ?? (async () => track()),
    ),
    Room: class {
      localParticipant = {
        publishTrack: vi.fn(
          options.publish ?? (async () => ({ trackSid: "track-1" })),
        ),
      };
      connect = vi.fn(options.connect ?? (async () => undefined));
      disconnect = vi.fn(async () => undefined);
      constructor() {
        rooms.push(this);
      }
    },
  };
  return {
    module: module as unknown as typeof import("livekit-client"),
    createLocalAudioTrack: module.createLocalAudioTrack,
    rooms,
  };
}

const never = <T>() => new Promise<T>(() => undefined);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("shared voice microphone connection", () => {
  it("opens the exact bound microphone and the system default once it is gone", async () => {
    const media = livekit({
      createLocalAudioTrack: async (constraints) => {
        if ((constraints as { deviceId?: { exact?: string } }).deviceId?.exact)
          throw new DOMException("gone", "OverconstrainedError");
        return track("default-mic");
      },
    });

    const opened = await openVoiceMicrophone(
      media.module,
      "usb",
      new AbortController().signal,
    );

    expect(
      media.createLocalAudioTrack.mock.calls.map(([options]) => options),
    ).toEqual([
      expect.objectContaining({
        channelCount: 1,
        echoCancellation: true,
        deviceId: { exact: "usb" },
      }),
      expect.objectContaining({ deviceId: undefined }),
    ]);
    expect(opened.mediaStreamTrack.getSettings().deviceId).toBe("default-mic");
  });

  it("retries a transient microphone abort", async () => {
    let failures = 1;
    const media = livekit({
      createLocalAudioTrack: async () => {
        if (failures-- > 0)
          throw new DOMException("signal is aborted", "AbortError");
        return track();
      },
    });

    const opening = openVoiceMicrophone(
      media.module,
      undefined,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(120);

    await expect(opening).resolves.toBeDefined();
    expect(media.createLocalAudioTrack).toHaveBeenCalledTimes(2);
  });

  it("stops a microphone that opens after the attempt was abandoned", async () => {
    let open!: (opened: Track) => void;
    const media = livekit({
      createLocalAudioTrack: () =>
        new Promise((resolve) => {
          open = resolve;
        }),
    });
    const abort = new AbortController();
    const opening = openVoiceMicrophone(media.module, undefined, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await expect(opening).rejects.toBeDefined();
    const late = track();
    open(late);
    await vi.advanceTimersByTimeAsync(0);

    expect(late.stop).toHaveBeenCalledOnce();
  });

  it("gives the microphone 30 seconds to open", async () => {
    const media = livekit({ createLocalAudioTrack: never });
    const opening = openVoiceMicrophone(
      media.module,
      undefined,
      new AbortController().signal,
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(29_999);
    await vi.advanceTimersByTimeAsync(1);

    expect(await opening).toEqual(new Error("Voice request timed out."));
  });

  it.each([
    ["credential", 5_000],
    ["connect", 15_000],
    ["publish", 10_000],
  ] as const)(
    "bounds the %s step at %i ms and cleans up the attempt",
    async (step, limit) => {
      const media = livekit({
        connect: step === "connect" ? never : undefined,
        publish: step === "publish" ? never : undefined,
      });
      const microphone = track();
      const publishing = publishVoiceMicrophone({
        livekit: media.module,
        client: credentialClient(step === "credential" ? never : credential),
        voiceSessionId: "voice-1",
        microphone: Promise.resolve(microphone) as never,
        signal: new AbortController().signal,
        observe: vi.fn(),
        ended: vi.fn(),
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(limit - 1);
      expect(microphone.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(await publishing).toEqual(new Error("Voice request timed out."));
      expect(microphone.stop).toHaveBeenCalledOnce();
      for (const room of media.rooms)
        expect(room.disconnect).toHaveBeenCalledOnce();
    },
  );

  it("connects while the microphone opens and hands back the published track", async () => {
    const media = livekit({});
    const microphone = track();
    let open!: (opened: Track) => void;
    const opening = new Promise<Track>((resolve) => {
      open = resolve;
    });
    const observe = vi.fn();
    const opened = vi.fn();
    const ended = vi.fn();
    const publishing = publishVoiceMicrophone({
      livekit: media.module,
      client: credentialClient(credential),
      voiceSessionId: "voice-1",
      microphone: opening as never,
      signal: new AbortController().signal,
      observe,
      opened,
      ended,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(observe).toHaveBeenCalledBefore(media.rooms[0]!.connect);
    expect(opened).not.toHaveBeenCalled();
    open(microphone);

    const connection = await publishing;
    expect(opened).toHaveBeenCalledWith(microphone);
    expect(connection.publication.trackSid).toBe("track-1");
    expect(microphone.stop).not.toHaveBeenCalled();
    microphone.mediaStreamTrack.dispatchEvent(new Event("ended"));
    expect(ended).toHaveBeenCalledOnce();
  });
});
