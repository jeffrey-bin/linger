import { EventEmitter } from "node:events";
import type { JobContext } from "@livekit/agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ASRStream } from "./asr.js";
import { ASREventQueue } from "./event-queue.js";

const rtc = vi.hoisted(() => {
  class Track {
    sid = "TR-dictation";
    closed = false;
    controller!: ReadableStreamDefaultController<unknown>;
    stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
    speech() {
      this.controller.enqueue({
        data: new Int16Array(320).fill(1),
        samplesPerChannel: 320,
        sampleRate: 16_000,
      });
    }
    closeAudioStreams() {
      if (!this.closed) {
        this.closed = true;
        this.controller.close();
      }
    }
  }
  return { Track };
});

vi.mock("@livekit/agents", () => ({
  AutoSubscribe: { AUDIO_ONLY: 1 },
  log: () => ({ warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@livekit/rtc-node", () => ({
  RemoteAudioTrack: rtc.Track,
  AudioStream: class {
    constructor(track: InstanceType<typeof rtc.Track>) {
      return track.stream;
    }
  },
  RoomEvent: {
    TrackSubscribed: "subscribed",
    TrackUnsubscribed: "unsubscribed",
    DataReceived: "data",
  },
  TrackSource: { SOURCE_MICROPHONE: 1 },
}));

import {
  VoiceTrackWorker,
  dictationCommitTopic,
  serverDictationCommitRequest,
  voicePurposeFromMetadata,
} from "./livekit-worker.js";

afterEach(() => vi.restoreAllMocks());

const payload = (requestId: string) =>
  new TextEncoder().encode(JSON.stringify({ request_id: requestId }));

class Source implements ASRStream {
  readonly queue = new ASREventQueue();
  readonly frames: Int16Array[] = [];
  readonly operations: string[] = [];
  finishCalls = 0;
  finalizeCalls = 0;
  finalizeError?: Error;
  async finalize() {
    this.finalizeCalls++;
    this.operations.push("finalize");
    if (this.finalizeError) throw this.finalizeError;
  }
  closeCalls = 0;
  async sendPCM(frame: Int16Array) {
    this.frames.push(frame.slice());
    this.operations.push("pcm");
  }
  async finish() {
    this.finishCalls++;
    this.queue.end();
  }
  async close() {
    this.closeCalls++;
    this.queue.end();
  }
  events() {
    return this.queue.events();
  }
}

async function harness(finalAck?: Promise<void>, startSpeaking = true) {
  const sources: Source[] = [];
  const provider = {
    open: vi.fn(async () => {
      const source = new Source();
      sources.push(source);
      return source;
    }),
  };
  const observations: Array<{
    kind: string;
    text?: string;
    media_epoch: number;
    start_offset_ms: number;
    end_offset_ms: number;
  }> = [];
  const client = {
    reportObservation: vi.fn(async (event) => {
      observations.push(event);
      if (event.kind === "final") await finalAck;
      return { event_id: event.event_id, status: "accepted" };
    }),
  };
  const attributes = vi.fn(async () => undefined);
  const room = Object.assign(new EventEmitter(), {
    remoteParticipants: new Map([
      ["publisher", { identity: "publisher-voice_session_test" }],
    ]),
    localParticipant: { setAttributes: attributes },
  });
  let shutdown!: () => Promise<void>;
  const failedShutdown = vi.fn();
  const ctx = {
    room,
    job: {
      room: { name: "voice-voice_session_test" },
      metadata: JSON.stringify({
        voice_session_created_at: new Date(Date.now() - 1_000).toISOString(),
        voice_purpose: "chat_dictation",
      }),
    },
    connect: vi.fn(async () => undefined),
    addShutdownCallback: (callback: () => Promise<void>) => {
      shutdown = callback;
    },
    shutdown: vi.fn(),
  } as unknown as JobContext;
  const worker = new VoiceTrackWorker(client as never, provider, () => {
    failedShutdown();
    return undefined as never;
  });
  await worker.run(ctx);
  const track = new rtc.Track();
  const participant = {
    identity: "publisher-voice_session_test",
    attributes: { "linger.voice_generation": "1" },
  };
  room.emit("subscribed", track, { source: 1 }, participant);
  if (startSpeaking) track.speech();
  await vi.waitFor(() =>
    expect(sources[0]?.frames).toHaveLength(startSpeaking ? 1 : 0),
  );
  return {
    room,
    sources,
    provider,
    observations,
    attributes,
    track,
    participant,
    failedShutdown,
    shutdown: () => shutdown(),
    stop: () => {
      track.closeAudioStreams();
      room.emit("unsubscribed", track);
    },
  };
}

describe("dictation worker boundary", () => {
  it("defaults old dispatches to hardware and opts into dictation explicitly", () => {
    expect(voicePurposeFromMetadata("{}")).toBe("hardware_control");
    expect(
      voicePurposeFromMetadata('{"voice_purpose":"hardware_control"}'),
    ).toBe("hardware_control");
    expect(voicePurposeFromMetadata('{"voice_purpose":"chat_dictation"}')).toBe(
      "chat_dictation",
    );
    expect(() =>
      voicePurposeFromMetadata('{"voice_purpose":"unknown"}'),
    ).toThrow();
  });

  it("accepts only bounded server-origin commit packets on the dedicated topic", () => {
    expect(
      serverDictationCommitRequest(
        payload("req-1"),
        undefined,
        dictationCommitTopic,
      ),
    ).toBe("req-1");
    for (const participant of [
      { identity: "publisher" },
      { identity: "other" },
      null,
    ])
      expect(
        serverDictationCommitRequest(
          payload("req-1"),
          participant,
          dictationCommitTopic,
        ),
      ).toBeUndefined();
    expect(
      serverDictationCommitRequest(payload("req-1"), undefined, "other"),
    ).toBeUndefined();
    expect(
      serverDictationCommitRequest(
        payload(""),
        undefined,
        dictationCommitTopic,
      ),
    ).toBeUndefined();
    expect(
      serverDictationCommitRequest(
        new Uint8Array(513),
        undefined,
        dictationCommitTopic,
      ),
    ).toBeUndefined();
    expect(
      serverDictationCommitRequest(
        new TextEncoder().encode('{"request_id":"req-1","text":"forged"}'),
        undefined,
        dictationCommitTopic,
      ),
    ).toBeUndefined();
  });

  it("deduplicates manual sends on one live provider connection", async () => {
    const test = await harness();
    try {
      expect(test.attributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "linger.voice_purpose": "chat_dictation",
          "linger.voice_ready_generation": "1",
        }),
      );
      const source = test.sources[0]!;
      for (const participant of [test.participant, undefined, undefined])
        test.room.emit(
          "data",
          payload("manual-1"),
          participant,
          0,
          dictationCommitTopic,
        );
      await vi.waitFor(() => expect(source.finalizeCalls).toBe(1));
      source.queue.push({
        kind: "final",
        text: "first",
        startOffsetMs: 0,
        endOffsetMs: 20,
      });
      source.queue.push({
        kind: "finalization_ack",
        startOffsetMs: 20,
        endOffsetMs: 20,
      });
      await vi.waitFor(() =>
        expect(
          test.observations.some((event) => event.kind === "turn_finalized"),
        ).toBe(true),
      );
      test.track.speech();
      await vi.waitFor(() => expect(source.frames).toHaveLength(2));
      test.room.emit(
        "data",
        payload("manual-1"),
        undefined,
        0,
        dictationCommitTopic,
      );
      await Promise.resolve();
      expect(source.finalizeCalls).toBe(1);
      test.stop();
      await test.shutdown();
      expect(test.observations.map((event) => event.kind)).toEqual([
        "track_started",
        "final",
        "turn_finalized",
        "track_ended",
      ]);
      expect(test.provider.open).toHaveBeenCalledOnce();
      expect(test.failedShutdown).not.toHaveBeenCalled();
    } finally {
      test.stop();
      await test.shutdown();
    }
  });

  it("keeps consuming PCM while non-closing finalize and TeamHub acknowledgements are pending", async () => {
    let release!: () => void;
    const ack = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = await harness(ack);
    try {
      const source = test.sources[0]!;
      test.room.emit(
        "data",
        payload("manual-continuous"),
        undefined,
        0,
        dictationCommitTopic,
      );
      await vi.waitFor(() => expect(source.finalizeCalls).toBe(1));
      test.track.speech();
      await vi.waitFor(() => expect(source.frames).toHaveLength(2));
      source.queue.push({
        kind: "final",
        text: "first",
        startOffsetMs: 0,
        endOffsetMs: 20,
      });
      source.queue.push({
        kind: "finalization_ack",
        startOffsetMs: 20,
        endOffsetMs: 20,
      });
      await vi.waitFor(() =>
        expect(test.observations.some((event) => event.kind === "final")).toBe(
          true,
        ),
      );
      expect(
        test.observations.some((event) => event.kind === "turn_finalized"),
      ).toBe(false);
      test.track.speech();
      await vi.waitFor(() => expect(source.frames).toHaveLength(3));
      expect(source.finishCalls).toBe(0);
      expect(test.provider.open).toHaveBeenCalledOnce();
      release();
      await vi.waitFor(() =>
        expect(
          test.observations.some((event) => event.kind === "turn_finalized"),
        ).toBe(true),
      );
      expect(
        test.observations.some((event) => event.kind === "finalization_ack"),
      ).toBe(false);
      expect(test.failedShutdown).not.toHaveBeenCalled();
    } finally {
      release();
      test.stop();
      await test.shutdown();
    }
  });

  it("publishes a fatal generation-scoped signal and does not retry or falsely acknowledge an unconfirmed turn", async () => {
    const test = await harness();
    try {
      test.sources[0]!.finalizeError = new Error(
        "provider disconnected before final",
      );
      test.room.emit(
        "data",
        payload("manual-failed"),
        undefined,
        0,
        dictationCommitTopic,
      );
      await vi.waitFor(() =>
        expect(test.attributes).toHaveBeenCalledWith({
          "linger.voice_dictation_failure": "transcript_unconfirmed",
          "linger.voice_dictation_failure_generation": "1",
        }),
      );
      const sameGeneration = new rtc.Track();
      test.room.emit(
        "subscribed",
        sameGeneration,
        { source: 1 },
        test.participant,
      );
      await Promise.resolve();
      expect(test.provider.open).toHaveBeenCalledOnce();
      expect(
        test.observations.some(
          (event) =>
            event.kind === "turn_finalized" || event.kind === "track_ended",
        ),
      ).toBe(false);
      sameGeneration.closeAudioStreams();
    } finally {
      test.stop();
      await test.shutdown();
    }
    expect(test.failedShutdown).toHaveBeenCalled();
  });

  it("finalizes a manual boundary only after the audio received before it", async () => {
    const test = await harness();
    try {
      const source = test.sources[0]!;
      test.room.emit(
        "data",
        payload("first"),
        undefined,
        0,
        dictationCommitTopic,
      );
      await vi.waitFor(() => expect(source.finalizeCalls).toBe(1));
      test.track.speech();
      // Flush stream-reader microtasks without relying on elapsed wall time.
      await new Promise<void>((resolve) => setImmediate(resolve));
      test.room.emit(
        "data",
        payload("second"),
        undefined,
        0,
        dictationCommitTopic,
      );
      await vi.waitFor(() => expect(source.finalizeCalls).toBe(2));
      expect(source.operations).toEqual(["pcm", "finalize", "pcm", "finalize"]);
      expect(test.provider.open).toHaveBeenCalledOnce();
    } finally {
      test.stop();
      await test.shutdown();
    }
    expect(test.failedShutdown).not.toHaveBeenCalled();
  });

  it("reports an idle input boundary without inventing text or waiting for a turn", async () => {
    const test = await harness(undefined, false);
    test.stop();
    await test.shutdown();
    expect(test.observations.map((event) => event.kind)).toEqual([
      "track_started",
      "track_ended",
    ]);
    expect(test.failedShutdown).not.toHaveBeenCalled();
  });
});
