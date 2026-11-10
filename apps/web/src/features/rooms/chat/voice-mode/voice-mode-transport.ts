import type { LocalAudioTrack, Room } from "livekit-client";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import {
  VoiceRequestScope,
  waitForVoiceDelay,
} from "@/features/teamhub/voice-request-scope";
import type {
  TeamHubVoiceSession,
  TeamHubVoiceTranscriptEvent,
} from "@/features/teamhub/teamhub-types";
import type {
  VoiceEventFeed,
  VoiceEventTransport,
} from "@/features/teamhub/voice-event-transport";
import type {
  VoiceModeConnection,
  VoiceModeEvent,
  VoiceModeMicrophone,
} from "./voice-mode-controller";
import {
  bounded,
  openVoiceMicrophone,
  publishVoiceMicrophone,
  setVoiceMicrophoneMuted,
} from "@/features/rooms/voice-control/voice-media-connection";
import {
  acquireVoiceMicrophone,
  closeAbandonedVoiceSession,
  closeVoiceSessionQuietly,
  observeAudioLevel,
} from "./voice-media-room";
import { asError } from "@linger/service-kit";
import { VoiceModeDisconnectedError } from "./voice-mode-errors";

export async function openVoiceMode(input: {
  client: TeamHubClient;
  /** The accepted transcript and turns arrive through the shared event feed. */
  events: VoiceEventTransport | undefined;
  roomId: string;
  acquireMicrophone: () => Promise<() => Promise<void>>;
  deviceId?: string;
  /** The microphone that actually opened, for the bound-device setting. */
  adoptDevice?: (deviceId: string | undefined) => void;
  receive: (event: VoiceModeEvent) => void;
  fail: (error: unknown) => void;
  level: (level: number) => void;
  microphone?: (microphone: VoiceModeMicrophone | undefined) => void;
  signal: AbortSignal;
}): Promise<VoiceModeConnection> {
  const requests = new VoiceRequestScope();
  const { client, signal } = input;
  signal.throwIfAborted();
  const livekitModulePromise = import("livekit-client");
  const release = await acquireVoiceMicrophone(input.acquireMicrophone, signal);
  let session: TeamHubVoiceSession | undefined;
  let room: Room | undefined;
  let track: LocalAudioTrack | undefined;
  let meter: (() => void) | undefined;
  let closed = false;
  let stopping = false;
  let closing: Promise<void> | undefined;
  let feed: VoiceEventFeed | undefined;
  let turnAcknowledgement: ReturnType<typeof acknowledgement> | undefined;
  let hasDraft = false;
  let pendingCommitId: string | undefined;
  let runtimeIdentity: string | undefined;
  let readinessFailure: Error | undefined;
  let expectedTrackSid: string | undefined;
  let inputStartedOffsetMs: number | undefined;
  const feedAbort = new AbortController();
  const cutAudio = () => {
    meter?.();
    meter = undefined;
    track?.stop();
    input.level(0);
    input.microphone?.(undefined);
  };
  const detachInput = async () => {
    cutAudio();
    // Unpublish is the media boundary; TeamHub owns the resulting drain state.
    if (room && track)
      await bounded(
        room.localParticipant.unpublishTrack(track).then(() => undefined),
        3_000,
      );
  };
  // Page departure must stop the microphone synchronously, even while a request waits.
  signal.addEventListener("abort", cutAudio, { once: true });
  try {
    signal.throwIfAborted();
    const events = input.events;
    if (!events) throw new Error("Voice transcription is unavailable.");
    const creating = teamHubData(
      client.api.POST("/v0/rooms/{roomId}/voice-sessions", {
        params: { path: { roomId: input.roomId } },
        body: { purpose: "chat_dictation" },
      }),
    );
    closeAbandonedVoiceSession(
      client,
      creating,
      () => closed || signal.aborted,
    );
    const livekit = await livekitModulePromise;
    // Start the real browser microphone while TeamHub provisions the session.
    // Its track can then publish as soon as the credential and Room are ready,
    // instead of adding getUserMedia latency after both network round trips.
    const opening = openVoiceMicrophone(livekit, input.deviceId, signal);
    void opening.then(
      (opened) => {
        if (closed || signal.aborted) opened.stop();
        else track = opened;
      },
      () => undefined,
    );
    session = await bounded(creating, 5_000, signal);
    signal.throwIfAborted();
    if (session.purpose !== "chat_dictation")
      throw new Error("The server did not confirm a chat-only voice session.");
    const sessionId = session.id;
    const media = await publishVoiceMicrophone({
      livekit,
      client,
      voiceSessionId: sessionId,
      microphone: opening,
      signal,
      observe(created, RoomEvent, credential) {
        room = created;
        created.on(RoomEvent.Disconnected, () => {
          if (!closed && !stopping)
            input.fail(
              new VoiceModeDisconnectedError(
                "Voice connection was lost. Your unsent text is kept.",
              ),
            );
        });
        created.on(RoomEvent.MediaDevicesError, (error) => {
          if (!closed && !stopping) input.fail(error);
        });
        created.on(
          RoomEvent.ParticipantAttributesChanged,
          (attributes, participant) => {
            if (!participant.isAgent) return;
            const currentAttributes = {
              ...participant.attributes,
              ...attributes,
            };
            const generation = String(credential.generation);
            const readyForCurrentTrack =
              currentAttributes["linger.voice_ready_generation"] ===
                generation &&
              (!expectedTrackSid ||
                currentAttributes["linger.voice_ready_track"] ===
                  expectedTrackSid);
            const failureForCurrentGeneration =
              Boolean(currentAttributes["linger.voice_dictation_failure"]) &&
              currentAttributes["linger.voice_dictation_failure_generation"] ===
                generation;
            // A Runtime failure can happen before it publishes readiness. Learn
            // the trusted Agent identity from the generation-scoped signal so the
            // user sees the provider error instead of waiting for a generic timeout.
            if (readyForCurrentTrack || failureForCurrentGeneration)
              runtimeIdentity = participant.identity;
            if (participant.identity !== runtimeIdentity) return;
            if (!closed && !stopping && failureForCurrentGeneration) {
              readinessFailure = new Error(
                "Voice Runtime stopped before readiness. Check the configured ASR provider and try again.",
              );
              input.fail(readinessFailure);
            }
          },
        );
        created.on(RoomEvent.ParticipantDisconnected, (participant) => {
          if (!closed && !stopping && runtimeIdentity === participant.identity)
            input.fail(
              new VoiceModeDisconnectedError(
                "Voice recognition disconnected. Your unsent text is kept.",
              ),
            );
        });
      },
      ended() {
        if (!closed && !stopping)
          input.fail(
            new VoiceModeDisconnectedError(
              "Microphone disconnected. Your unsent text is kept.",
            ),
          );
      },
    });
    const { credential, publication } = media;
    track = media.track;
    expectedTrackSid = publication.trackSid;
    input.adoptDevice?.(track.mediaStreamTrack.getSettings().deviceId);
    meter = observeAudioLevel(track.mediaStreamTrack, input.level);
    // Local capture is usable independently of the Runtime readiness handshake.
    // Expose mute now, while transcription continues connecting in the background.
    const microphone: VoiceModeMicrophone = {
      async setMuted(muted) {
        if (stopping || closed || signal.aborted || !track) return;
        await setVoiceMicrophoneMuted(track, muted);
      },
    };
    input.microphone?.(microphone);
    // Turns are acknowledged once, however often the feed delivers them.
    const seenTurns = new Set<string>();
    let feedActivity = false;
    const accept = (event: TeamHubVoiceTranscriptEvent) => {
      if (event.voice_session_id !== sessionId || event.lane !== "live") return;
      if (event.kind === "dictation_turn") {
        feedActivity = true;
        if (!seenTurns.has(event.id)) {
          seenTurns.add(event.id);
          turnAcknowledgement?.resolve();
        }
        hasDraft = false;
        input.receive({
          kind: "turn",
          id: event.id,
          text: event.text,
          endOffsetMs: event.end_offset_ms,
        });
      } else if (event.kind === "speech") {
        feedActivity = true;
        hasDraft = true;
        input.receive({
          kind: "speech",
          id: event.id,
          text: event.text,
          endOffsetMs: event.end_offset_ms,
        });
      }
    };
    // Start the transcript feed immediately after publishing. The Runtime can
    // successfully transcribe before the readiness attributes reach
    // TeamHub; blocking the feed on that projection made real
    // speech disappear behind the readiness timeout. The shared feed retries
    // failed reads itself, so a slow read no longer ends the session (M11-N3).
    feed = events.subscribe({
      voiceSessionId: sessionId,
      onTranscriptPage(page) {
        for (const event of page.items) accept(event);
        if (page.partial_transcript) {
          feedActivity = true;
          hasDraft = true;
        }
        input.receive({
          kind: "partial",
          text: page.partial_transcript ?? "",
          endOffsetMs: page.partial_end_offset_ms ?? 0,
        });
      },
      onEvents(page) {
        for (const item of page.items)
          if (item.transcript) accept(item.transcript);
      },
      onMode() {},
      onAccessLost() {
        if (!closed && !stopping)
          input.fail(
            new Error("Voice access was lost. Your unsent text is kept."),
          );
      },
    });
    const readyDeadline = Date.now() + 15_000;
    for (;;) {
      if (readinessFailure) throw readinessFailure;
      const current = await requests.run(
        (requestSignal) =>
          teamHubData(
            client.api.GET("/v0/voice-sessions/{voiceSessionId}", {
              params: { path: { voiceSessionId: sessionId } },
              signal: requestSignal,
            }),
          ),
        signal,
      );
      if (current.purpose !== "chat_dictation")
        throw new Error("Voice Mode authorization changed.");
      inputStartedOffsetMs = current.input_started_offset_ms;
      if (current.last_failure_code)
        throw new Error(
          `Voice Runtime is unavailable (${current.last_failure_code}). Check the ASR provider and try again.`,
        );
      if (current.input_ready_generation === credential.generation) {
        for (const participant of media.room.remoteParticipants.values())
          if (
            participant.isAgent &&
            participant.attributes["linger.voice_ready_generation"] ===
              String(credential.generation) &&
            participant.attributes["linger.voice_ready_track"] ===
              publication.trackSid
          )
            runtimeIdentity = participant.identity;
        // TeamHub verifies the active publisher, microphone track, generation
        // and fresh trusted-agent readiness. The Runtime may be hidden from
        // browser participants, so its local visibility cannot gate readiness.
        break;
      }
      if (feedActivity) break;
      if (Date.now() >= readyDeadline)
        throw new Error(
          "Voice Runtime did not become ready within 15 seconds. Check that the Voice Runtime and ASR provider are running, then try again.",
        );
      await waitForVoiceDelay(200, signal);
      signal.throwIfAborted();
    }
    const commit = async () => {
      pendingCommitId ??=
        globalThis.crypto?.randomUUID?.() ??
        `voice-commit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const accepted = acknowledgement(
        15_000,
        "Final voice text did not arrive. Your draft is kept; try again.",
        feedAbort.signal,
      );
      // Register before POST: a fast Runtime may publish its final before the
      // HTTP receipt arrives. The receipt alone never makes partial text final.
      turnAcknowledgement = accepted;
      try {
        await bounded(
          teamHubData(
            client.api.POST(
              "/v0/voice-sessions/{voiceSessionId}/dictation-commit",
              {
                params: { path: { voiceSessionId: sessionId } },
                body: { request_id: pendingCommitId },
              },
            ),
          ),
          5_000,
          feedAbort.signal,
        );
        await accepted.promise.catch((error: unknown) => {
          if (hasDraft || feedAbort.signal.aborted) throw error;
        });
        pendingCommitId = undefined;
      } finally {
        if (turnAcknowledgement === accepted) turnAcknowledgement = undefined;
        accepted.dispose();
      }
    };
    return {
      commit,
      setMuted: microphone.setMuted,
      close() {
        if (closing) return closing;
        stopping = true;
        closing = (async () => {
          let failure: unknown;
          const drain = new AbortController();
          const drainTimer = setTimeout(() => {
            drain.abort(
              new Error(
                "Voice shutdown could not confirm the last words. Your draft is kept.",
              ),
            );
          }, 15_000);
          const drainSignal = AbortSignal.any([feedAbort.signal, drain.signal]);
          try {
            await detachInput();
            for (;;) {
              const current = await requests.run(
                (requestSignal) =>
                  teamHubData(
                    client.api.GET("/v0/voice-sessions/{voiceSessionId}", {
                      params: { path: { voiceSessionId: sessionId } },
                      signal: requestSignal,
                    }),
                  ),
                drainSignal,
              );
              if (
                current.id !== sessionId ||
                current.purpose !== "chat_dictation" ||
                current.credential_generation !== credential.generation
              )
                throw new Error(
                  "Voice input identity changed during shutdown. Your draft is kept.",
                );
              const started = current.input_started_offset_ms;
              const ended = current.input_ended_offset_ms;
              if (
                started !== undefined &&
                ended !== undefined &&
                started >= (inputStartedOffsetMs ?? 0) &&
                ended >= started
              )
                break;
              if (current.last_failure_code || current.status === "closed")
                throw new Error(
                  "Voice shutdown could not confirm the last words. Your draft is kept.",
                );
              await waitForVoiceDelay(200, drainSignal);
              drainSignal.throwIfAborted();
            }
            // Persisted track_ended follows accepted transcript callbacks, so
            // one read of the feed after it confirms the last words and turn.
            await feed!.catchUp(drainSignal);
          } catch (error) {
            failure = error;
          } finally {
            clearTimeout(drainTimer);
            closed = true;
            feedAbort.abort();
            feed?.();
            requests.cancel();
            signal.removeEventListener("abort", cutAudio);
            await bounded(room!.disconnect(), 3_000).catch(() => undefined);
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
          if (failure) throw asError(failure);
        })();
        return closing;
      },
    };
  } catch (error) {
    closed = true;
    stopping = true;
    feedAbort.abort();
    feed?.();
    requests.cancel();
    cutAudio();
    if (room) await bounded(room.disconnect(), 3_000).catch(() => undefined);
    signal.removeEventListener("abort", cutAudio);
    try {
      if (session) await closeVoiceSessionQuietly(client, session.id);
    } finally {
      await release();
    }
    throw error;
  }
}

function acknowledgement(
  milliseconds: number,
  message: string,
  signal: AbortSignal,
) {
  let settled = false;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (error !== undefined) reject(error);
    else resolve();
  };
  const abort = () =>
    finish(
      signal.reason ?? new DOMException("Voice input closed", "AbortError"),
    );
  const timer = setTimeout(() => finish(new Error(message)), milliseconds);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  // The network operation may still be pending when the deadline/abort fires.
  // Its owner awaits this same promise afterwards; avoid an unhandled rejection.
  void promise.catch(() => undefined);
  return { promise, resolve: () => finish(), dispose: () => finish() };
}
