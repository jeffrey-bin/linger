import type {
  LocalAudioTrack,
  Room,
  RoomEvent as LiveKitRoomEvent,
} from "livekit-client";
import type { Dispatch, SetStateAction } from "react";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubVoiceConnectionCredential,
  TeamHubVoiceMediaPolicy,
  TeamHubVoiceSession,
} from "@/features/teamhub/teamhub-types";
import {
  type VoiceRequestScope,
  waitForVoiceDelay as delay,
} from "@/features/teamhub/voice-request-scope";

import type { VoiceListenerStatus } from "./voice-control-context";
import {
  describeError,
  isRetryableVoiceRequestError,
} from "./voice-control-helpers";
import {
  readVoiceListeningCapture,
  resumeVoiceListening,
} from "./voice-control-storage";
import { waitForVoiceInputReady } from "./voice-input-readiness";
import {
  openVoiceMicrophone,
  publishVoiceMicrophone,
} from "./voice-media-connection";
import { voicePollRetryDelay } from "./voice-poll-retry";
import { tryAcquireVoicePublisherLease } from "./voice-publisher-lease";
import { releaseVoiceSession } from "./voice-session-release";
import type { VoiceControlRefs, VoiceTarget } from "./use-voice-control-state";

type LiveKit = typeof import("livekit-client");

/** Everything one listener connection attempt reads, writes or calls. */
export interface VoiceListenerConnection {
  automatic: boolean;
  controller: AbortController;
  attemptGeneration: number;
  refs: VoiceControlRefs;
  requests: VoiceRequestScope;
  client: TeamHubClient;
  tenantId: string;
  setListenerError: Dispatch<SetStateAction<string | undefined>>;
  setListenerStatus: Dispatch<SetStateAction<VoiceListenerStatus>>;
  setVoiceSessionId: Dispatch<SetStateAction<string | undefined>>;
  adoptMicrophone: (deviceId: string | undefined) => Promise<void>;
  cleanupMedia: () => Promise<void>;
  ensureTarget: (activeRoomOverride?: string) => Promise<VoiceTarget>;
  failMedia: (
    room: Room,
    status: "error" | "device_disconnected",
    error?: unknown,
  ) => void;
  resolveVoiceSession: (roomId: string) => Promise<TeamHubVoiceSession>;
  restoreActiveCapture: (roomId: string, signal?: AbortSignal) => Promise<void>;
}

/**
 * Takes the publisher lease, opens the bound microphone and publishes it into
 * the target Room's VoiceSession until the Runtime reports input ready.
 */
export async function connectVoiceListener(
  connection: VoiceListenerConnection,
) {
  const { controller, refs, tenantId } = connection;
  await refs.leavePromiseRef.current;
  if (connection.attemptGeneration !== refs.voiceSessionGenerationRef.current) {
    controller.abort();
  }
  controller.signal.throwIfAborted();
  const binding = refs.bindingRef.current;
  if (!binding) throw new Error("Connect a microphone before enabling voice");
  if (!refs.pageActiveRef.current && !refs.publisherLeaseRef.current) {
    throw new Error("Hardware voice is active in another tab");
  }
  if (refs.composerLeaseRef.current)
    throw new Error("Composer is using the microphone");
  refs.manuallyDisabledRef.current = false;
  if (!connection.automatic) resumeVoiceListening(tenantId);
  connection.setListenerError(undefined);
  const cleanup = connection.cleanupMedia();
  refs.connectionControllerRef.current = controller;
  await cleanup;
  try {
    if (!refs.publisherLeaseRef.current) {
      const release = await tryAcquireVoicePublisherLease(tenantId);
      if (controller.signal.aborted || !refs.mountedRef.current) {
        release?.();
        controller.signal.throwIfAborted();
        return;
      }
      if (!release) {
        connection.setListenerStatus("standby");
        return;
      }
      refs.publisherLeaseRef.current = release;
    }
    connection.setListenerStatus("enabling");
    controller.signal.throwIfAborted();
    const livekit = await import("livekit-client");
    controller.signal.throwIfAborted();
    // Opening the microphone does not depend on the Room, VoiceSession or
    // publisher credential. Start it now so the device is ready when the
    // credential arrives instead of adding its latency afterwards.
    const microphone = openVoiceMicrophone(
      livekit,
      binding.deviceId,
      controller.signal,
    );
    // A superseded or failed connection must never leave it open.
    microphone.catch(() => undefined);
    try {
      await joinVoiceSession(connection, livekit, microphone);
    } finally {
      // Whatever ended this attempt, only the adopted track may stay open.
      void microphone.then(
        (track) => {
          if (refs.trackRef.current !== track) track.stop();
        },
        () => undefined,
      );
    }
  } catch (error) {
    if (controller.signal.aborted) throw error;
    await connection.cleanupMedia();
    refs.publisherLeaseRef.current?.();
    refs.publisherLeaseRef.current = undefined;
    if (refs.mountedRef.current) {
      connection.setListenerError(describeError(error));
      connection.setListenerStatus("error");
    }
    throw error;
  }
}

async function joinVoiceSession(
  connection: VoiceListenerConnection,
  livekit: LiveKit,
  microphone: Promise<LocalAudioTrack>,
) {
  const { client, controller, refs, tenantId } = connection;
  let policy: TeamHubVoiceMediaPolicy | undefined;
  if (connection.automatic) policy = await readVoiceMediaPolicy(connection);
  const target = await connection.ensureTarget(policy?.active_room_id);
  controller.signal.throwIfAborted();
  if (connection.automatic && readVoiceListeningCapture(tenantId)?.stopped) {
    // A newly active Capture can supersede an older Stop from another
    // page. A completed Stop must not reconnect merely to listen again.
    await connection.restoreActiveCapture(target.roomId, controller.signal);
    controller.signal.throwIfAborted();
    if (readVoiceListeningCapture(tenantId)?.stopped) {
      refs.manuallyDisabledRef.current = true;
      connection.setListenerStatus("disabled");
      refs.publisherLeaseRef.current?.();
      refs.publisherLeaseRef.current = undefined;
      return;
    }
  }
  const session = await connection.resolveVoiceSession(target.roomId);
  if (controller.signal.aborted || !refs.mountedRef.current) {
    void releaseVoiceSession(client, session, undefined).catch(() => undefined);
    controller.signal.throwIfAborted();
    return;
  }
  controller.signal.throwIfAborted();
  refs.voiceSessionGenerationRef.current += 1;
  refs.voiceSessionRef.current = session;
  connection.setVoiceSessionId(session.id);
  await connection.restoreActiveCapture(target.roomId, controller.signal);
  controller.signal.throwIfAborted();
  if (refs.captureRef.current?.status === "finalizing") return;
  const { credential, room, track } = await publishVoiceMicrophone({
    livekit,
    client,
    voiceSessionId: session.id,
    microphone,
    signal: controller.signal,
    observe(room, RoomEvent, credential) {
      observeVoiceRoom(connection, session.id, room, RoomEvent, credential);
    },
    async opened(track) {
      refs.trackRef.current = track;
      if (refs.microphoneMutedRef.current) await track.mute();
    },
    ended() {
      const room = refs.roomRef.current;
      if (refs.mountedRef.current && room)
        connection.failMedia(room, "device_disconnected");
    },
  });
  void connection.adoptMicrophone(
    track.mediaStreamTrack.getSettings().deviceId,
  );
  // The session clock starts where audio starts, which is also the
  // Start offset a Capture opened from here reports.
  refs.sessionStartedAtRef.current = performance.now();
  await waitForVoiceInputReady(
    (signal) => readVoiceSession(client, session.id, signal),
    credential.generation,
    () => refs.mountedRef.current && refs.roomRef.current === room,
  );
  controller.signal.throwIfAborted();
  if (!refs.mountedRef.current || refs.roomRef.current !== room) return;
  connection.setListenerStatus("listening");
}

// Retry only this read. The connection deadline and cleanup abort the same
// signal before credentials or a publisher are created.
async function readVoiceMediaPolicy(
  connection: VoiceListenerConnection,
): Promise<TeamHubVoiceMediaPolicy> {
  const { client, controller, tenantId } = connection;
  let failures = 0;
  for (;;) {
    controller.signal.throwIfAborted();
    try {
      return await connection.requests.run(
        (signal) =>
          teamHubData(
            client.api.GET("/v0/tenants/{tenantId}/voice-media-policy", {
              params: { path: { tenantId } },
              signal,
            }),
          ),
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted || !isRetryableVoiceRequestError(error))
        throw error;
      await delay(voicePollRetryDelay(++failures), controller.signal);
    }
  }
}

function observeVoiceRoom(
  connection: VoiceListenerConnection,
  voiceSessionId: string,
  room: Room,
  RoomEvent: typeof LiveKitRoomEvent,
  credential: TeamHubVoiceConnectionCredential,
) {
  const { refs } = connection;
  refs.roomRef.current = room;
  room.on(RoomEvent.Reconnecting, () => {
    if (refs.mountedRef.current && refs.roomRef.current === room) {
      connection.setListenerStatus("enabling");
    }
  });
  room.on(RoomEvent.Reconnected, () => {
    const isCurrent = () =>
      refs.mountedRef.current && refs.roomRef.current === room;
    if (!isCurrent()) return;
    void waitForVoiceInputReady(
      (signal) => readVoiceSession(connection.client, voiceSessionId, signal),
      credential.generation,
      isCurrent,
    ).then(
      () => {
        if (isCurrent()) connection.setListenerStatus("listening");
      },
      (error: unknown) => {
        connection.failMedia(room, "error", error);
      },
    );
  });
  room.on(RoomEvent.Disconnected, () => {
    if (
      !refs.mountedRef.current ||
      refs.manuallyDisabledRef.current ||
      refs.roomRef.current !== room
    )
      return;
    connection.failMedia(room, "device_disconnected");
  });
  room.on(RoomEvent.MediaDevicesError, (error) => {
    connection.failMedia(room, "error", error);
  });
}

function readVoiceSession(
  client: TeamHubClient,
  voiceSessionId: string,
  signal: AbortSignal,
) {
  return teamHubData(
    client.api.GET("/v0/voice-sessions/{voiceSessionId}", {
      params: { path: { voiceSessionId } },
      signal,
    }),
  );
}
