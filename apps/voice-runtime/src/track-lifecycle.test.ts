import { EventEmitter } from "node:events";
import { ReadableStream } from "node:stream/web";
import type { JobContext } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { AudioFrame, RemoteAudioTrack, TrackSource } from "@livekit/rtc-node";
import {
  TeamHubVoiceRuntimeError,
  type TeamHubVoiceRuntimeClient,
  type VoiceObservation,
} from "@linger/wire-contracts/teamhub-internal/client";
import { VoiceTrackWorker } from "./livekit-worker.js";
import { ASREventQueue } from "./event-queue.js";

const audioInputs = vi.hoisted(
  () => new Map<object, ReadableStreamDefaultController<AudioFrame>>(),
);

vi.mock("@livekit/rtc-node", async (original) => ({
  ...(await original<typeof import("@livekit/rtc-node")>()),
  AudioStream: vi.fn(function (track: object) {
    return new ReadableStream({
      start(controller) {
        audioInputs.set(track, controller);
      },
      cancel() {
        audioInputs.delete(track);
      },
    });
  }),
}));
vi.spyOn(RemoteAudioTrack.prototype, "closeAudioStreams").mockImplementation(
  function (this: RemoteAudioTrack) {
    audioInputs.get(this)?.close();
    audioInputs.delete(this);
  },
);
vi.mock("@livekit/agents", async (original) => ({
  ...(await original<typeof import("@livekit/agents")>()),
  log: () => ({ warn: vi.fn(), error: vi.fn() }),
}));

describe("Voice publisher track lifecycle", () => {
  it("keeps the subscribed track and delivers the next sentence after an uncertain handoff", async () => {
    const room = Object.assign(new EventEmitter(), {
      remoteParticipants: new Map(),
    });
    const queues: ASREventQueue[] = [];
    const receivedFrames: number[][] = [];
    const accepted: VoiceObservation[] = [];
    let shutdown!: () => Promise<void>;
    const worker = new VoiceTrackWorker(
      {
        reportObservation: async (event: VoiceObservation) => {
          accepted.push(event);
          return { event_id: event.event_id, status: "accepted" };
        },
      } as TeamHubVoiceRuntimeClient,
      {
        open: async () => {
          const index = queues.length;
          const queue = new ASREventQueue();
          queues.push(queue);
          receivedFrames.push([]);
          return {
            async sendPCM(frame: Int16Array) {
              receivedFrames[index]!.push(frame[0]!);
              queue.push({
                kind: "final",
                startOffsetMs: 0,
                endOffsetMs: 20,
                text:
                  index === 0
                    ? "confirmed before conflict"
                    : "sentence after recovery",
              });
            },
            events: () => queue.events(),
            async finish() {
              queue.end();
            },
            async close() {
              queue.end();
            },
          };
        },
      },
    );
    await worker.run({
      room,
      job: {
        room: { name: "voice-voice_session_overlap" },
        metadata: JSON.stringify({
          voice_session_created_at: new Date(Date.now() - 1000).toISOString(),
        }),
      },
      connect: async () => undefined,
      addShutdownCallback: (callback: () => Promise<void>) => {
        shutdown = callback;
      },
    } as unknown as JobContext);
    const track = Object.create(RemoteAudioTrack.prototype) as RemoteAudioTrack;
    try {
      room.emit(
        "trackSubscribed",
        track,
        { source: TrackSource.SOURCE_MICROPHONE },
        { identity: "publisher-voice_session_overlap" },
      );
      await vi.waitFor(() => expect(audioInputs.has(track)).toBe(true));
      const first = AudioFrame.create(16_000, 1, 320);
      first.data.fill(1);
      audioInputs.get(track)!.enqueue(first);
      await vi.waitFor(() =>
        expect(
          accepted.some((event) => event.text === "confirmed before conflict"),
        ).toBe(true),
      );
      queues[0]!.fail(
        new Error("ASR handoff transcript overlap is unconfirmed"),
      );
      await vi.waitFor(() => expect(queues).toHaveLength(2));
      const next = AudioFrame.create(16_000, 1, 320);
      next.data.fill(2);
      audioInputs.get(track)!.enqueue(next);
      await vi.waitFor(() =>
        expect(
          accepted.some((event) => event.text === "sentence after recovery"),
        ).toBe(true),
      );
      expect(receivedFrames).toEqual([[1], [2]]);
      expect(
        accepted
          .filter((event) => event.kind === "track_started")
          .map((event) => event.media_epoch),
      ).toEqual([0]);
      expect(
        accepted.some(
          (event) => event.kind === "track_ended" && event.media_epoch === 0,
        ),
      ).toBe(false);
      expect(
        accepted
          .filter((event) => event.kind === "final")
          .map((event) => event.text),
      ).toEqual(["confirmed before conflict", "sentence after recovery"]);
    } finally {
      await shutdown();
      audioInputs.delete(track);
    }
    expect(accepted.at(-1)?.kind).toBe("track_ended");
    expect(accepted.at(-1)?.media_epoch).toBe(1);
  });

  it.each(["normal", "slow", "overflow"])(
    "drains received frames with bounded backlog and shutdown (%s)",
    async (scenario) => {
      const slow = scenario === "slow";
      if (slow) vi.useFakeTimers();
      const room = Object.assign(new EventEmitter(), {
        remoteParticipants: new Map(),
      });
      const queue = new ASREventQueue();
      const accepted: VoiceObservation[] = [];
      let releaseWrite!: () => void;
      const pendingWrite = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const received: number[] = [];
      let shutdown!: () => Promise<void>;
      const worker = new VoiceTrackWorker(
        {
          reportObservation: async (event: VoiceObservation) => {
            if (
              slow &&
              (event.kind === "final" || event.kind === "track_ended")
            )
              await new Promise((resolve) => setTimeout(resolve, 7_000));
            accepted.push(event);
            return { event_id: event.event_id, status: "accepted" };
          },
        } as TeamHubVoiceRuntimeClient,
        {
          open: async () => ({
            async sendPCM(frame) {
              received.push(frame[0]!);
              if (received.length === 1) await pendingWrite;
            },
            events: () => queue.events(),
            async finish() {
              const finish = () => {
                queue.push({
                  kind: "final",
                  startOffsetMs: 0,
                  endOffsetMs: 40,
                  text: "retained tail",
                });
                queue.end();
              };
              if (slow) setTimeout(finish, 14_000);
              else finish();
            },
            async close() {
              queue.end();
            },
          }),
        },
      );
      await worker.run({
        room,
        job: {
          room: { name: "voice-voice_session_buffered" },
          metadata: JSON.stringify({
            voice_session_created_at: new Date(Date.now() - 1000).toISOString(),
          }),
        },
        connect: async () => undefined,
        addShutdownCallback: (callback: () => Promise<void>) => {
          shutdown = callback;
        },
      } as unknown as JobContext);
      const track = Object.create(
        RemoteAudioTrack.prototype,
      ) as RemoteAudioTrack;
      room.emit(
        "trackSubscribed",
        track,
        { source: TrackSource.SOURCE_MICROPHONE },
        { identity: "publisher-voice_session_buffered" },
      );
      try {
        await vi.waitFor(() => expect(audioInputs.has(track)).toBe(true));
        for (const value of [1, 2]) {
          const frame = AudioFrame.create(16_000, 1, 320);
          frame.data.fill(value);
          audioInputs.get(track)!.enqueue(frame);
        }
        await vi.waitFor(() => expect(received).toEqual([1]));
        if (scenario === "overflow") {
          // The input keeps only the newest 20 seconds and stays subscribed;
          // the stalled consumer reports the loss once its write returns.
          for (let index = 0; index < 1001; index++)
            audioInputs.get(track)!.enqueue(AudioFrame.create(16_000, 1, 320));
          await vi.waitFor(() =>
            expect(audioInputs.get(track)!.desiredSize).toBe(1),
          );
          expect(audioInputs.has(track)).toBe(true);
        }
        const done =
          scenario === "overflow"
            ? expect(shutdown()).rejects.toThrow("unconfirmed transcript")
            : expect(shutdown()).resolves.toBeUndefined();
        if (slow) {
          setTimeout(releaseWrite, 14_000);
          await vi.advanceTimersByTimeAsync(45_000);
        } else releaseWrite();
        await done;
        expect(received).toEqual(scenario === "overflow" ? [1] : [1, 2]);
        expect(accepted.at(-1)?.kind).toBe(
          scenario === "overflow" ? "track_started" : "track_ended",
        );
        await vi.waitFor(() => expect(audioInputs.has(track)).toBe(false));
      } finally {
        releaseWrite();
        queue.end();
        audioInputs.delete(track);
        if (slow) vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "drains final retries or rejects an unconfirmed shutdown (failed=%s)",
    async (failFinish) => {
      vi.useFakeTimers();
      const room = Object.assign(new EventEmitter(), {
        remoteParticipants: new Map(),
        localParticipant: { setAttributes: vi.fn(async () => undefined) },
      });
      const queue = new ASREventQueue();
      const accepted: VoiceObservation[] = [];
      let finalCalls = 0;
      const unconfirmed = new Error("unconfirmed shutdown");
      const onUnconfirmedShutdown = vi.fn((): never => {
        throw unconfirmed;
      });
      let shutdown!: () => Promise<void>;
      const open = vi.fn(async () => ({
        sendPCM: async () => undefined,
        events: () => queue.events(),
        finish: async () => {
          if (failFinish) throw new Error("ASR finish timed out");
          queue.push({
            kind: "final",
            startOffsetMs: 0,
            endOffsetMs: 20,
            text: "retained final",
          });
          queue.end();
        },
        close: async () => queue.end(),
      }));
      const worker = new VoiceTrackWorker(
        {
          reportObservation: async (event: VoiceObservation) => {
            if (event.kind === "final") {
              await new Promise((resolve) => setTimeout(resolve, 1_900));
              if (++finalCalls < 3) throw new TeamHubVoiceRuntimeError(503);
            }
            accepted.push(event);
            return { event_id: event.event_id, status: "accepted" };
          },
        } as TeamHubVoiceRuntimeClient,
        { open },
        onUnconfirmedShutdown,
      );
      try {
        await worker.run({
          room,
          job: {
            room: { name: "voice-voice_session_drain" },
            metadata: JSON.stringify({
              voice_session_created_at: new Date(
                Date.now() - 1000,
              ).toISOString(),
            }),
          },
          connect: async () => undefined,
          addShutdownCallback: (callback: () => Promise<void>) => {
            shutdown = callback;
          },
        } as unknown as JobContext);
        room.emit(
          "trackSubscribed",
          Object.defineProperty(
            Object.create(RemoteAudioTrack.prototype),
            "sid",
            {
              value: "current-microphone-track",
            },
          ),
          { source: TrackSource.SOURCE_MICROPHONE },
          {
            identity: "publisher-voice_session_drain",
            attributes: { "linger.voice_generation": "7" },
          },
        );
        // No frame arrives on this track; the consumer waits at most 500ms
        // for one before anchoring its clock and opening the ASR stream.
        await vi.advanceTimersByTimeAsync(501);
        expect(open).toHaveBeenCalledOnce();
        expect(room.localParticipant.setAttributes).toHaveBeenCalledWith({
          "linger.voice_purpose": "hardware_control",
          "linger.voice_ready_generation": "7",
          "linger.voice_ready_track": "current-microphone-track",
          "linger.voice_ready_at": expect.any(String),
        });
        expect(
          room.localParticipant.setAttributes.mock.invocationCallOrder[0],
        ).toBeGreaterThan(open.mock.invocationCallOrder[0]!);
        const result = shutdown().then(
          () => undefined,
          (error) => error,
        );
        await vi.advanceTimersByTimeAsync(7_000);
        expect(room.localParticipant.setAttributes).toHaveBeenLastCalledWith({
          "linger.voice_ready_generation": "0",
          "linger.voice_ready_track": "",
          "linger.voice_ready_at": "0",
        });
        if (failFinish) {
          expect(await result).toBe(unconfirmed);
          expect(onUnconfirmedShutdown).toHaveBeenCalledOnce();
          expect(accepted.map((event) => event.kind)).toEqual([
            "track_started",
          ]);
        } else {
          expect(await result).toBeUndefined();
          expect(finalCalls).toBe(3);
          expect(onUnconfirmedShutdown).not.toHaveBeenCalled();
          expect(accepted.map((event) => event.kind)).toEqual([
            "track_started",
            "final",
            "track_ended",
          ]);
        }
      } finally {
        queue.end();
        vi.useRealTimers();
      }
    },
  );

  it("keeps the ASR stream and delivers finals when a replaceable callback times out", async () => {
    const room = Object.assign(new EventEmitter(), {
      remoteParticipants: new Map(),
    });
    const queue = new ASREventQueue();
    const accepted: VoiceObservation[] = [];
    let shutdown!: () => Promise<void>;
    const open = vi.fn(async () => ({
      sendPCM: async () => undefined,
      events: () => queue.events(),
      finish: async () => queue.end(),
      close: async () => queue.end(),
    }));
    const worker = new VoiceTrackWorker(
      {
        reportObservation: async (event: VoiceObservation) => {
          if (event.kind === "partial" || event.kind === "progress")
            throw new DOMException("callback timed out", "TimeoutError");
          accepted.push(event);
          return { event_id: event.event_id, status: "accepted" };
        },
      } as TeamHubVoiceRuntimeClient,
      { open },
    );
    await worker.run({
      room,
      job: {
        room: { name: "voice-voice_session_snapshot" },
        metadata: JSON.stringify({
          voice_session_created_at: new Date(Date.now() - 1000).toISOString(),
        }),
      },
      connect: async () => undefined,
      addShutdownCallback: (callback: () => Promise<void>) => {
        shutdown = callback;
      },
    } as unknown as JobContext);
    try {
      room.emit(
        "trackSubscribed",
        Object.create(RemoteAudioTrack.prototype),
        { source: TrackSource.SOURCE_MICROPHONE },
        { identity: "publisher-voice_session_snapshot" },
      );
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      queue.push({
        kind: "partial",
        startOffsetMs: 0,
        endOffsetMs: 20,
        text: "hypothesis",
      });
      queue.push({
        kind: "progress",
        startOffsetMs: 0,
        endOffsetMs: 20,
        committedThroughMs: 20,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      queue.push({
        kind: "final",
        startOffsetMs: 0,
        endOffsetMs: 40,
        text: "retained final",
      });
      await vi.waitFor(() =>
        expect(accepted.some((event) => event.kind === "final")).toBe(true),
      );
      expect(open).toHaveBeenCalledOnce();
    } finally {
      await shutdown();
    }
  });

  it("releases idle room jobs without terminating a present publisher", async () => {
    vi.useFakeTimers();
    const room = Object.assign(new EventEmitter(), {
      remoteParticipants: new Map<string, { identity: string }>(),
    });
    const terminate = vi.fn();
    let shutdown!: () => Promise<void>;
    const worker = new VoiceTrackWorker({} as TeamHubVoiceRuntimeClient, {
      open: vi.fn(),
    });
    try {
      await worker.run({
        room,
        job: {
          room: { name: "voice-voice_session_idle" },
          metadata: JSON.stringify({
            voice_session_created_at: new Date().toISOString(),
          }),
        },
        connect: async () => undefined,
        shutdown: terminate,
        addShutdownCallback: (callback: () => Promise<void>) => {
          shutdown = callback;
        },
      } as unknown as JobContext);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(terminate).not.toHaveBeenCalled();
      room.remoteParticipants.set("participant-sid", {
        identity: "publisher-voice_session_idle",
      });
      await vi.advanceTimersByTimeAsync(90_000);
      expect(terminate).not.toHaveBeenCalled();
      room.remoteParticipants.clear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(terminate).toHaveBeenCalledOnce();
      await shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters other participants and sources, deduplicates subscriptions, and drains once on replacement", async () => {
    const room = Object.assign(new EventEmitter(), {
      remoteParticipants: new Map(),
    });
    let shutdown!: () => Promise<void>;
    const observations: VoiceObservation[] = [];
    const closed: number[] = [];
    let opened = 0;
    const worker = new VoiceTrackWorker(
      {
        reportObservation: async (event: VoiceObservation) => {
          observations.push(event);
          return { event_id: event.event_id, status: "accepted" };
        },
      } as TeamHubVoiceRuntimeClient,
      {
        open: async () => {
          const id = ++opened;
          const queue = new ASREventQueue();
          return {
            sendPCM: async () => undefined,
            events: () => queue.events(),
            finish: async () => {
              queue.push({
                kind: "final",
                startOffsetMs: 0,
                endOffsetMs: 20,
                text: "final",
              });
              queue.end();
            },
            close: async () => {
              closed.push(id);
              queue.end();
            },
          };
        },
      },
    );
    await worker.run({
      room,
      job: {
        room: { name: "voice-voice_session_1" },
        metadata: JSON.stringify({
          voice_session_created_at: new Date(Date.now() - 1000).toISOString(),
        }),
      },
      connect: async () => undefined,
      addShutdownCallback: (callback: () => Promise<void>) => {
        shutdown = callback;
      },
    } as unknown as JobContext);
    const first = Object.create(RemoteAudioTrack.prototype) as RemoteAudioTrack;
    const second = Object.create(
      RemoteAudioTrack.prototype,
    ) as RemoteAudioTrack;
    const publisher = { identity: "publisher-voice_session_1" };
    room.emit(
      "trackSubscribed",
      first,
      { source: TrackSource.SOURCE_MICROPHONE },
      { identity: "other" },
    );
    room.emit(
      "trackSubscribed",
      first,
      { source: TrackSource.SOURCE_SCREENSHARE_AUDIO },
      publisher,
    );
    await Promise.resolve();
    expect(opened).toBe(0);
    room.emit(
      "trackSubscribed",
      first,
      { source: TrackSource.SOURCE_MICROPHONE },
      publisher,
    );
    room.emit(
      "trackSubscribed",
      first,
      { source: TrackSource.SOURCE_MICROPHONE },
      publisher,
    );
    await vi.waitFor(() => expect(opened).toBe(1));
    room.emit(
      "trackSubscribed",
      second,
      { source: TrackSource.SOURCE_MICROPHONE },
      publisher,
    );
    room.emit("trackUnsubscribed", first);
    await vi.waitFor(() => expect(opened).toBe(2));
    expect(closed).toEqual([1]);
    await shutdown();
    expect(closed).toEqual([1, 2]);
    expect(observations.map((event) => event.kind)).toEqual([
      "track_started",
      "final",
      "track_ended",
      "track_started",
      "final",
      "track_ended",
    ]);
  });
});

describe("Voice publisher input retention and absence evidence", () => {
  const publisher = (identity: string, generation?: string) => ({
    identity,
    attributes: generation
      ? { "linger.voice_generation": generation }
      : undefined,
  });
  const microphoneTrack = (sid: string) =>
    Object.defineProperty(Object.create(RemoteAudioTrack.prototype), "sid", {
      value: sid,
    }) as RemoteAudioTrack;
  const startWorker = async (
    worker: VoiceTrackWorker,
    room: EventEmitter,
    session: string,
  ) => {
    let shutdown!: () => Promise<void>;
    const createdAtMs = Date.now() - 1000;
    await worker.run({
      room,
      job: {
        room: { name: `voice-${session}` },
        metadata: JSON.stringify({
          voice_session_created_at: new Date(createdAtMs).toISOString(),
        }),
      },
      connect: async () => undefined,
      addShutdownCallback: (callback: () => Promise<void>) => {
        shutdown = callback;
      },
    } as unknown as JobContext);
    return { shutdown, createdAtMs };
  };
  const frame = (value: number) => {
    const result = AudioFrame.create(16_000, 1, 320);
    result.data.fill(value);
    return result;
  };

  it("keeps audio that arrives while the ASR connection opens and across a consumer rebuild", async () => {
    const room = Object.assign(new EventEmitter(), {
      remoteParticipants: new Map(),
    });
    const queues: ASREventQueue[] = [];
    const received: number[][] = [];
    const accepted: VoiceObservation[] = [];
    let releaseOpen!: () => void;
    const slowOpen = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const worker = new VoiceTrackWorker(
      {
        reportObservation: async (event: VoiceObservation) => {
          accepted.push(event);
          return { event_id: event.event_id, status: "accepted" };
        },
      } as TeamHubVoiceRuntimeClient,
      {
        open: async () => {
          const index = queues.length;
          if (index === 0) await slowOpen;
          const queue = new ASREventQueue();
          queues.push(queue);
          received.push([]);
          return {
            async sendPCM(frame: Int16Array) {
              received[index]!.push(frame[0]!);
            },
            events: () => queue.events(),
            async finish() {
              queue.end();
            },
            async close() {
              queue.end();
            },
          };
        },
      },
    );
    const { shutdown, createdAtMs } = await startWorker(
      worker,
      room,
      "voice_session_retain",
    );
    const track = microphoneTrack("retained-track");
    try {
      room.emit(
        "trackSubscribed",
        track,
        { source: TrackSource.SOURCE_MICROPHONE },
        publisher("publisher-voice_session_retain"),
      );
      await vi.waitFor(() => expect(audioInputs.has(track)).toBe(true));
      await vi.waitFor(() =>
        expect(accepted.some((event) => event.kind === "track_started")).toBe(
          true,
        ),
      );
      // The recorder is already archiving these frames while the ASR socket opens.
      audioInputs.get(track)!.enqueue(frame(1));
      audioInputs.get(track)!.enqueue(frame(2));
      releaseOpen();
      await vi.waitFor(() => expect(received[0]).toEqual([1, 2]));
      // The event pump fails; input keeps arriving before the delayed reopen.
      queues[0]!.fail(new Error("Soniox ASR transport timed out"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const retainedAtMs = Date.now();
      audioInputs.get(track)!.enqueue(frame(3));
      audioInputs.get(track)!.enqueue(frame(4));
      await vi.waitFor(() => expect(queues).toHaveLength(2));
      const reopenedAtMs = Date.now();
      await vi.waitFor(() => expect(received[1]).toEqual([3, 4]));
      expect(received[0]).toEqual([1, 2]);
      const started = accepted.filter(
        (event) => event.kind === "track_started",
      );
      expect(started.map((event) => event.media_epoch)).toEqual([0]);
      const gap = accepted.find((event) => event.kind === "input_gap");
      expect(gap).toBeDefined();
      // The rebuilt epoch's clock starts when its oldest retained frame
      // arrived, not when the 250ms backoff let the consumer reopen.
      expect(gap!.end_offset_ms).toBeGreaterThanOrEqual(
        retainedAtMs - createdAtMs - 50,
      );
      expect(gap!.end_offset_ms).toBeLessThan(reopenedAtMs - createdAtMs - 100);
      expect(
        accepted.some(
          (event) => event.kind === "track_ended" && event.media_epoch === 0,
        ),
      ).toBe(false);
      expect(accepted.some((event) => event.kind === "publisher_absent")).toBe(
        false,
      );
    } finally {
      await shutdown();
      audioInputs.delete(track);
    }
    expect(accepted.at(-1)).toMatchObject({
      kind: "track_ended",
      media_epoch: 1,
    });
  });

  it("reports publisher absence only when a new publisher generation follows a cleanly ended input", async () => {
    const room = Object.assign(new EventEmitter(), {
      remoteParticipants: new Map(),
      localParticipant: { setAttributes: vi.fn(async () => undefined) },
    });
    const accepted: VoiceObservation[] = [];
    const worker = new VoiceTrackWorker(
      {
        reportObservation: async (event: VoiceObservation) => {
          accepted.push(event);
          return { event_id: event.event_id, status: "accepted" };
        },
      } as TeamHubVoiceRuntimeClient,
      {
        open: async () => {
          const queue = new ASREventQueue();
          return {
            sendPCM: async () => undefined,
            events: () => queue.events(),
            async finish() {
              queue.end();
            },
            async close() {
              queue.end();
            },
          };
        },
      },
    );
    const { shutdown } = await startWorker(
      worker,
      room,
      "voice_session_absent",
    );
    const identity = "publisher-voice_session_absent";
    const tracks = [
      microphoneTrack("browser-1"),
      microphoneTrack("browser-2"),
      microphoneTrack("browser-2-republished"),
    ];
    const kinds = (kind: VoiceObservation["kind"]) =>
      accepted.filter((event) => event.kind === kind);
    try {
      for (const [index, generation] of ["1", "2", "2"].entries()) {
        room.emit(
          "trackSubscribed",
          tracks[index],
          { source: TrackSource.SOURCE_MICROPHONE },
          publisher(identity, generation),
        );
        await vi.waitFor(() =>
          expect(kinds("track_started")).toHaveLength(index + 1),
        );
        await vi.waitFor(() =>
          expect(audioInputs.has(tracks[index]!)).toBe(true),
        );
        audioInputs.get(tracks[index]!)!.enqueue(frame(index + 1));
        if (index === 2) break;
        // The browser disappears: LiveKit unsubscribes its microphone track.
        room.emit("trackUnsubscribed", tracks[index]);
        await vi.waitFor(() =>
          expect(kinds("track_ended")).toHaveLength(index + 1),
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const absent = kinds("publisher_absent");
      expect(absent).toHaveLength(1);
      const ended = kinds("track_ended")[0]!;
      const restarted = kinds("track_started")[1]!;
      expect(absent[0]).toMatchObject({
        media_epoch: 1,
        lane: "live",
        start_offset_ms: ended.end_offset_ms,
        end_offset_ms: restarted.start_offset_ms,
      });
      expect(
        absent[0]!.end_offset_ms - absent[0]!.start_offset_ms,
      ).toBeGreaterThan(250);
      expect(accepted.indexOf(absent[0]!)).toBeLessThan(
        accepted.indexOf(restarted),
      );
      // The same generation returning is a reconnect, not proof of absence.
      expect(kinds("track_started")).toHaveLength(3);
    } finally {
      await shutdown();
      for (const track of tracks) audioInputs.delete(track);
    }
  });
});
