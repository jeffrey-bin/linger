import type {
  LocalAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
} from "livekit-client";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubVoiceLiveClientEvent,
  TeamHubVoiceLiveRuntimeEvent,
  TeamHubVoiceSession,
} from "@/features/teamhub/teamhub-types";
import {
  VoiceRequestScope,
  waitForVoiceDelay,
} from "@/features/teamhub/voice-request-scope";
import type {
  VoiceModeConnection,
  VoiceModeEvent,
  VoiceModeMicrophone,
} from "../voice-mode-controller";
import {
  acquireVoiceMicrophone,
  bounded,
  closeAbandonedVoiceSession,
  closeVoiceSessionQuietly,
  observeAudioLevel,
  voiceMicrophoneOptions,
} from "../voice-media-room";
import { VoiceModeDisconnectedError } from "../voice-mode-errors";

export const voiceLiveTopic = "linger.voice.live";
export const voiceLiveReplyTrack = "linger-live-reply";
/** The browser's own identity; never a source of replies or events. */
const publisherPrefix = "publisher-";
/** Reply playback louder than this counts as audible. */
const audibleLevel = 0.05;

export type VoiceLiveConnection = VoiceModeConnection & {
  voiceSessionId: string;
  /** False once the session failed, is closing, or the Human left. */
  active(): boolean;
  send(event: TeamHubVoiceLiveClientEvent): void;
  /** Silences the reply speaker only; the microphone is unaffected. */
  setSoundOff(soundOff: boolean): void;
};

/**
 * Opens a live Voice Mode session: the Human's microphone goes up as today,
 * the live model's reply comes back as one audio track played in this page
 * (so the browser's echo cancellation hears it), and transcripts, subtitles
 * and tool requests arrive as reliable data packets.
 */
export async function openVoiceLive(input: {
  client: TeamHubClient;
  roomId: string;
  acquireMicrophone: () => Promise<() => Promise<void>>;
  deviceId?: string;
  /** Transcripts, in the dictation event shape the controller queues. */
  receive: (event: VoiceModeEvent) => void;
  /** Every other runtime event: replies and tool requests. */
  runtime: (event: TeamHubVoiceLiveRuntimeEvent) => void;
  fail: (error: unknown) => void;
  level: (level: number) => void;
  microphone?: (microphone: VoiceModeMicrophone | undefined) => void;
  /** The data channel is usable, before runtime readiness completes. */
  channel?: (connection: VoiceLiveConnection) => void;
  /** The reply playback became audible after silence. */
  audible?: () => void;
  /** Runs after capture and playback stop, before the session closes. */
  beforeClose?: () => Promise<void>;
  soundOff: boolean;
  signal: AbortSignal;
}): Promise<VoiceLiveConnection> {
  const requests = new VoiceRequestScope();
  const { client, signal } = input;
  signal.throwIfAborted();
  const livekitModulePromise = import("livekit-client");
  const release = await acquireVoiceMicrophone(input.acquireMicrophone, signal);
  let session: TeamHubVoiceSession | undefined;
  let creating: Promise<TeamHubVoiceSession> | undefined;
  let room: Room | undefined;
  let track: LocalAudioTrack | undefined;
  let meter: (() => void) | undefined;
  let replyMeter: (() => void) | undefined;
  let audio: HTMLAudioElement | undefined;
  let soundOff = input.soundOff;
  let closed = false;
  let stopping = false;
  let closing: Promise<void> | undefined;
  let activity = false;
  let turns = 0;
  let runtimeIdentity: string | undefined;
  const live = () => !closed && !stopping && !signal.aborted;
  const failed = (error: unknown) => {
    if (live()) input.fail(error);
  };
  // Leaving stops what the Human hears and says at once.
  const stopMedia = () => {
    meter?.();
    meter = undefined;
    track?.stop();
    input.level(0);
    input.microphone?.(undefined);
    replyMeter?.();
    replyMeter = undefined;
    if (audio) {
      audio.srcObject = null;
      audio.remove();
      audio = undefined;
    }
  };
  signal.addEventListener("abort", stopMedia, { once: true });
  const fromRuntime = (participant: RemoteParticipant | undefined) =>
    participant !== undefined &&
    !participant.identity.startsWith(publisherPrefix);
  const receiveData = (
    payload: Uint8Array,
    participant?: RemoteParticipant,
    _kind?: unknown,
    topic?: string,
  ) => {
    if (topic !== voiceLiveTopic || !fromRuntime(participant) || !live())
      return;
    let event: TeamHubVoiceLiveRuntimeEvent;
    try {
      event = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (typeof event?.type !== "string") return;
    activity = true;
    runtimeIdentity = participant!.identity;
    // Offsets only order partials against turns for the controller.
    if (event.type === "user_partial") {
      input.receive({
        kind: "partial",
        text: event.text ?? "",
        endOffsetMs: turns * 2 + 1,
      });
      input.runtime(event);
    } else if (event.type === "user_turn") {
      if (!event.turn_id) return;
      turns += 1;
      input.receive({
        kind: "turn",
        id: event.turn_id,
        text: event.text ?? "",
        endOffsetMs: turns * 2,
      });
    } else if (event.type === "session_failure")
      failed(new Error(`Live voice stopped (${event.code ?? "unknown"}).`));
    else input.runtime(event);
  };
  const play = (remote: RemoteTrack) => {
    if (!live()) return;
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.hidden = true;
      document.body.append(audio);
    }
    audio.muted = soundOff;
    remote.attach(audio);
    replyMeter?.();
    let audible = false;
    replyMeter = observeAudioLevel(remote.mediaStreamTrack, (level) => {
      const now = level > audibleLevel;
      if (now && !audible) input.audible?.();
      audible = now;
    });
  };
  try {
    creating = teamHubData(
      client.api.POST("/v0/rooms/{roomId}/voice-sessions", {
        params: { path: { roomId: input.roomId } },
        body: { purpose: "chat_live" },
      }),
    );
    closeAbandonedVoiceSession(client, creating, () => !live());
    const { Room, RoomEvent, Track, createLocalAudioTrack } =
      await livekitModulePromise;
    const creatingTrack = createLocalAudioTrack(
      voiceMicrophoneOptions(input.deviceId),
    );
    void creatingTrack.then(
      (created) => {
        if (closed || signal.aborted) created.stop();
        else track = created;
      },
      () => undefined,
    );
    session = await bounded(creating, 10_000, signal);
    if (session.purpose !== "chat_live")
      throw new Error("The server did not confirm a live voice session.");
    const sessionId = session.id;
    const credential = await bounded(
      teamHubData(
        client.api.POST(
          "/v0/voice-sessions/{voiceSessionId}/connection-credentials",
          { params: { path: { voiceSessionId: sessionId } } },
        ),
      ),
      5_000,
      signal,
    );
    signal.throwIfAborted();
    const media = new Room({
      adaptiveStream: false,
      disconnectOnPageLeave: true,
      dynacast: false,
    });
    room = media;
    // Only the live reply is ever subscribed; nothing else is heard.
    const subscribe = (
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (
        publication.trackName === voiceLiveReplyTrack &&
        fromRuntime(participant)
      )
        publication.setSubscribed(true);
    };
    media.on(RoomEvent.TrackPublished, subscribe);
    media.on(RoomEvent.TrackSubscribed, (remote, publication, participant) => {
      if (
        publication.trackName === voiceLiveReplyTrack &&
        fromRuntime(participant)
      ) {
        runtimeIdentity = participant.identity;
        play(remote);
      }
    });
    media.on(RoomEvent.DataReceived, receiveData);
    media.on(RoomEvent.Disconnected, () =>
      failed(new VoiceModeDisconnectedError("Live voice connection was lost.")),
    );
    media.on(RoomEvent.MediaDevicesError, failed);
    media.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.identity === runtimeIdentity)
        failed(new Error("Live voice runtime disconnected."));
    });
    const [, createdTrack] = await Promise.all([
      bounded(
        media.connect(credential.endpoint, credential.credential, {
          autoSubscribe: false,
        }),
        15_000,
        signal,
      ),
      bounded(creatingTrack, 30_000, signal),
    ]);
    track = createdTrack;
    signal.throwIfAborted();
    for (const participant of media.remoteParticipants.values())
      for (const publication of participant.trackPublications.values())
        subscribe(publication, participant);
    track.mediaStreamTrack.addEventListener("ended", () =>
      failed(new VoiceModeDisconnectedError("Microphone disconnected.")),
    );
    await bounded(
      media.localParticipant.publishTrack(track, {
        source: Track.Source.Microphone,
        dtx: false,
        red: true,
      }),
      10_000,
      signal,
    );
    signal.throwIfAborted();
    meter = observeAudioLevel(track.mediaStreamTrack, input.level);
    const microphone: VoiceModeMicrophone = {
      async setMuted(muted) {
        if (!live() || !track) return;
        if (muted) await track.mute();
        else await track.unmute();
      },
    };
    input.microphone?.(microphone);
    const encoder = new TextEncoder();
    const connection: VoiceLiveConnection = {
      voiceSessionId: sessionId,
      active: live,
      send(event) {
        if (!live()) return;
        void media.localParticipant
          .publishData(encoder.encode(JSON.stringify(event)), {
            reliable: true,
            topic: voiceLiveTopic,
          })
          .catch(() => undefined);
      },
      setSoundOff(next) {
        soundOff = next;
        if (audio) audio.muted = next;
      },
      // The live model ends turns itself; there is nothing to flush.
      async commit() {},
      setMuted: microphone.setMuted,
      close() {
        if (closing) return closing;
        stopping = true;
        stopMedia();
        closing = (async () => {
          try {
            if (track)
              await bounded(
                media.localParticipant
                  .unpublishTrack(track)
                  .then(() => undefined),
                3_000,
              ).catch(() => undefined);
            await input.beforeClose?.();
          } finally {
            closed = true;
            requests.cancel();
            signal.removeEventListener("abort", stopMedia);
            await bounded(media.disconnect(), 3_000).catch(() => undefined);
            try {
              await teamHubData(
                client.api.DELETE("/v0/voice-sessions/{voiceSessionId}", {
                  params: { path: { voiceSessionId: sessionId } },
                  signal: AbortSignal.timeout(5_000),
                  keepalive: true,
                }),
              );
            } finally {
              await bounded(release(), 3_000).catch(() => undefined);
            }
          }
        })();
        return closing;
      },
    };
    input.channel?.(connection);
    const readyDeadline = Date.now() + 15_000;
    // The live Runtime is a visible Agent participant, so its readiness
    // attribute ends the wait without another TeamHub poll. Readiness only
    // starts listening; it never authorizes anything.
    const generation = String(credential.generation);
    const runtimeReady = () =>
      [...media.remoteParticipants.values()].some(
        (participant) =>
          participant.isAgent &&
          participant.attributes["linger.voice_ready_generation"] ===
            generation,
      );
    let wakeReady: (() => void) | undefined;
    media.on(RoomEvent.ParticipantAttributesChanged, () => {
      if (runtimeReady()) wakeReady?.();
    });
    for (;;) {
      if (activity || runtimeReady()) break;
      const ready = new Promise<undefined>((resolve) => {
        wakeReady = () => resolve(undefined);
      });
      const current = await Promise.race([
        requests.run(
          (requestSignal) =>
            teamHubData(
              client.api.GET("/v0/voice-sessions/{voiceSessionId}", {
                params: { path: { voiceSessionId: sessionId } },
                signal: requestSignal,
              }),
            ),
          signal,
        ),
        ready,
      ]);
      if (!current) break;
      if (current.purpose !== "chat_live")
        throw new Error("Voice Mode authorization changed.");
      if (current.last_failure_code)
        throw new Error(
          `Live voice is unavailable (${current.last_failure_code}).`,
        );
      // An event from the runtime proves it is listening, like readiness.
      if (current.input_ready_generation === credential.generation || activity)
        break;
      if (Date.now() >= readyDeadline)
        throw new Error("Live voice did not become ready within 15 seconds.");
      await waitForVoiceDelay(200, signal);
      signal.throwIfAborted();
    }
    return connection;
  } catch (error) {
    closed = true;
    stopping = true;
    requests.cancel();
    stopMedia();
    if (room) await bounded(room.disconnect(), 3_000).catch(() => undefined);
    signal.removeEventListener("abort", stopMedia);
    try {
      // A live session that is still being created must be closed before the
      // caller falls back, because a Human may own only one active session.
      session ??= await bounded(
        creating ?? Promise.reject(new Error("Live session was not created")),
        10_000,
      ).catch(() => undefined);
      if (session) await closeVoiceSessionQuietly(client, session.id);
    } finally {
      await release();
    }
    throw error;
  }
}
