import type { JobContext } from "@livekit/agents";
import { AutoSubscribe, defineAgent, log } from "@livekit/agents";
import { RemoteAudioTrack, RoomEvent, TrackSource } from "@livekit/rtc-node";
import { TeamHubVoiceRuntimeClient } from "@linger/wire-contracts/teamhub-internal/client";

import { CaptureRecorder } from "./capture-recorder.js";
import { loadConfig } from "./config.js";
import { voiceSessionFromRoom } from "./livekit-worker.js";

// Matches the ASR worker: a Room whose publisher stays away this long is done.
const publisherAbsentShutdownMs = 60_000;

/**
 * The recorder job of one VoiceSession Room. It runs in its own worker
 * process, so Capture recording never competes with ASR for a job
 * event loop, and either can fail or restart while the other keeps going.
 */
export async function runCaptureRecorder(
  ctx: JobContext,
  client: TeamHubVoiceRuntimeClient,
) {
  const roomName = ctx.job.room?.name;
  if (!roomName) throw new Error("Voice recorder job is missing a Room name");
  const publisher = `publisher-${voiceSessionFromRoom(roomName)}`;
  const recorder = new CaptureRecorder({ client });
  let track: RemoteAudioTrack | undefined;
  ctx.room.on(RoomEvent.RoomMetadataChanged, (metadata) =>
    recorder.followMetadata(metadata),
  );
  ctx.room.on(
    RoomEvent.TrackSubscribed,
    (subscribed, publication, participant) => {
      if (
        !(subscribed instanceof RemoteAudioTrack) ||
        participant.identity !== publisher ||
        publication.source !== TrackSource.SOURCE_MICROPHONE
      )
        return;
      track = subscribed;
      recorder.setTrack(subscribed);
    },
  );
  ctx.room.on(RoomEvent.TrackUnsubscribed, (unsubscribed) => {
    if (unsubscribed !== track) return;
    track = undefined;
    recorder.setTrack(undefined);
  });
  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
  recorder.followMetadata(ctx.room.metadata);
  let lastPublisherAt = Date.now();
  const idleTimer = setInterval(() => {
    if (
      [...ctx.room.remoteParticipants.values()].some(
        (participant) => participant.identity === publisher,
      )
    ) {
      lastPublisherAt = Date.now();
    } else if (Date.now() - lastPublisherAt >= publisherAbsentShutdownMs) {
      clearInterval(idleTimer);
      ctx.shutdown("voice publisher absent");
    }
  }, 1_000);
  ctx.addShutdownCallback(async () => {
    clearInterval(idleTimer);
    await recorder.close();
  });
}

export default defineAgent({
  entry: async (ctx) => {
    const config = loadConfig();
    const client = new TeamHubVoiceRuntimeClient(config.teamhubBaseUrl, () =>
      Promise.resolve(config.teamhubToken),
    );
    try {
      await runCaptureRecorder(ctx, client);
    } catch (error) {
      log().error(
        { errorClass: error instanceof Error ? error.name : "Error" },
        "Voice recorder job failed",
      );
      throw error;
    }
  },
});
