import type { QueryClient } from "@tanstack/react-query";

import type { TeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { useOptionalVoiceControl } from "@/features/rooms/voice-control/voice-control-context";
import { tryAcquireVoicePublisherLease } from "@/features/rooms/voice-control/voice-publisher-lease";
import {
  VoiceModeController,
  VoiceModeReopen,
  type VoiceModeState,
} from "./voice-mode-controller";
import type { VoiceModePresentation } from "./voice-mode-presentation";
import {
  keepUnsentVoiceText,
  sendVoiceTurnToRoom,
  type VoiceTurnPrefix,
} from "./voice-mode-room-sender";
import type {
  VoiceModeLivePresentation,
  VoiceModeModes,
  VoiceModeRoomBinding,
  VoiceModeSession,
  VoiceModeSessionTarget,
  VoiceModeTurnSend,
} from "./voice-mode-session";
import { openVoiceMode } from "./voice-mode-transport";
import { readVoicePage, voicePageState } from "./live/voice-page-reader";
import {
  createVoiceLiveArbiter,
  type VoiceLiveArbiter,
  type VoiceLiveLine,
} from "./live/voice-live-arbiter";
import {
  openVoiceLive,
  type VoiceLiveConnection,
} from "./live/voice-live-transport";
import { closeVoicePip } from "./voice-pip";
import { roomMessageSender } from "../room-message-sender";

interface LiveView {
  connection?: VoiceLiveConnection;
  transcript?: readonly VoiceLiveLine[];
}

/**
 * Runs one Voice Mode session's controller and transport. Loaded on the first
 * start so the app shell's initial bundle carries only the session context.
 * Live mode is tried first when allowed; any live failure stops playback,
 * closes the live session and reopens as dictation with the unsent text.
 * Returns the cleanup that pauses the session and drains trailing text.
 */
export function runVoiceModeSession({
  abortRef,
  binding,
  entered,
  exitByVoice,
  hardware,
  modes,
  onLevel,
  onLive,
  onState,
  prefix,
  present,
  queryClient,
  runtime,
  setController,
  soundOff,
  target,
}: {
  abortRef: { current: AbortController | undefined };
  binding: (roomId: string) => VoiceModeRoomBinding | undefined;
  entered: () => boolean;
  /** Ends Voice Mode after the spoken exit turn has settled. */
  exitByVoice: () => void;
  hardware: () => ReturnType<typeof useOptionalVoiceControl>;
  modes: VoiceModeModes;
  onLevel: (level: number) => void;
  /** The live connection and its transcript, or undefined for dictation. */
  onLive: (live: LiveView | undefined) => void;
  onState: (state: VoiceModeState) => void;
  prefix: VoiceTurnPrefix;
  present: (state: VoiceModeState) => VoiceModePresentation;
  queryClient: QueryClient | undefined;
  runtime: TeamHubRuntime;
  setController: (controller: VoiceModeController | undefined) => void;
  soundOff: () => boolean;
  target: VoiceModeSessionTarget;
}) {
  const { roomId, tenantId } = target;
  // A turn is frozen when it is accepted: the Room composer prepares it when
  // mounted, otherwise the direct sender does. Before it is sent, the turn is
  // matched once against the Voice Mode commands available now; a command
  // decides whether the turn is still sent as a Message.
  const commandContext = {
    client: runtime.client,
    exitVoiceMode: () => setTimeout(exitByVoice),
    queryClient,
    roomId,
    tenantId,
  };
  const prepareMessage = (text: string, eventId: string): VoiceModeTurnSend => {
    const prepared = binding(roomId)?.prepareSend(text, eventId);
    if (prepared) return prepared;
    // Like the composer's, the first send fixes the turn's one key.
    let first: { voiceLiveTurn?: Parameters<VoiceModeTurnSend>[0] } | undefined;
    return (voiceLiveTurn) => {
      first ??= { voiceLiveTurn };
      return sendVoiceTurnToRoom({
        composition: roomMessageSender(runtime.client),
        eventId,
        prefix,
        queryClient,
        target,
        text,
        voiceLiveTurn: first.voiceLiveTurn,
      });
    };
  };
  let mode: "live" | "dictation" = modes.live ? "live" : "dictation";
  let arbiter: VoiceLiveArbiter | undefined;
  let connection: VoiceLiveConnection | undefined;
  const prepare = (text: string, eventId: string) => {
    if (arbiter) return arbiter.prepareTurn(eventId, text);
    const send = prepareMessage(text, eventId);
    return () => send();
  };
  /** Turns already heard keep their arbiter; new turns are dictation. */
  const fallBack = () => {
    mode = "dictation";
    arbiter?.dispose();
    arbiter = undefined;
    connection = undefined;
    onLive(undefined);
  };
  const acquireMicrophone = async () => {
    const control = hardware();
    if (control?.acquireComposerMicrophone)
      return control.acquireComposerMicrophone({
        resumeListening: false,
      });
    const release = await tryAcquireVoicePublisherLease(tenantId);
    if (!release) throw new Error("The microphone is active in another tab.");
    return async () => release();
  };
  const openLive = (
    receive: Parameters<typeof openVoiceMode>[0]["receive"],
    fail: (error: unknown) => void,
    microphone: Parameters<typeof openVoiceMode>[0]["microphone"],
    signal: AbortSignal,
  ) => {
    let transcript: readonly VoiceLiveLine[] = [];
    const live = createVoiceLiveArbiter({
      voiceSessionId: () => connection?.voiceSessionId,
      active: () => connection?.active() ?? false,
      send: (event) => connection?.send(event),
      context: commandContext,
      prepare: prepareMessage,
      page: { state: voicePageState, read: readVoicePage },
      onTranscript: (next) => {
        transcript = next;
        if (arbiter === live) onLive({ connection, transcript });
      },
    });
    arbiter = live;
    onLive({});
    return openVoiceLive({
      client: runtime.client,
      roomId,
      acquireMicrophone,
      deviceId: hardware()?.boundDevice?.deviceId,
      receive,
      runtime: live.receive,
      fail: (error) => {
        if (arbiter !== live) return;
        fallBack();
        fail(
          new VoiceModeReopen(
            `Live voice stopped; continuing as dictation. ${error instanceof Error ? error.message : ""}`.trim(),
          ),
        );
      },
      level: onLevel,
      microphone,
      channel: (opened) => {
        if (arbiter !== live) return;
        connection = opened;
        onLive({ connection, transcript });
      },
      audible: live.audible,
      beforeClose: live.settle,
      soundOff: soundOff(),
      signal,
    });
  };
  const controller = new VoiceModeController({
    open: async (receive, fail, microphone) => {
      const abort = new AbortController();
      abortRef.current = abort;
      if (mode === "live")
        try {
          return await openLive(receive, fail, microphone, abort.signal);
        } catch (error) {
          if (abort.signal.aborted) throw error;
          // Not available or not ready: continue as dictation at once.
          fallBack();
          if (!modes.dictation) throw error;
        }
      return openVoiceMode({
        client: runtime.client,
        events: runtime.voiceEvents,
        roomId,
        // The entry button is enabled only after this same policy has been
        // loaded, so the transport need not spend another startup RTT on it.

        receive,
        fail,
        signal: abort.signal,
        level: onLevel,
        microphone,
        deviceId: hardware()?.boundDevice?.deviceId,
        acquireMicrophone,
      });
    },
    send: (turn) => prepare(turn.text, turn.id)(),
    prepareSend: (turn) => prepare(turn.text, turn.id),
  });
  setController(controller);
  const unsubscribe = controller.subscribe((next) => {
    onState(next);
    if (entered()) binding(roomId)?.onChange(present(next));
  });
  const depart = () => {
    void controller.pause();
    abortRef.current?.abort();
  };
  window.addEventListener("pagehide", depart);
  void controller.start();
  return () => {
    unsubscribe();
    window.removeEventListener("pagehide", depart);
    abortRef.current?.abort();
    void Promise.all([controller.pause(), controller.whenDeliverySettles()]);
    arbiter?.dispose();
    setController(undefined);
  };
}

/**
 * Drains an exiting session, then hands its final words back: to the Room
 * composer when it is mounted, otherwise to that Room's draft.
 */
export async function finishVoiceModeSession({
  before,
  binding,
  controller,
  drained,
  prefix,
  present,
  target,
}: {
  before: VoiceModeState;
  binding: () => VoiceModeRoomBinding | undefined;
  controller: VoiceModeController | undefined;
  /** Pause and delivery drain, started synchronously when the Human exits. */
  drained: Promise<unknown>;
  prefix: VoiceTurnPrefix;
  present: (
    state: VoiceModeState,
    extra: Partial<VoiceModePresentation>,
  ) => VoiceModePresentation;
  target: VoiceModeSessionTarget;
}) {
  await drained;
  const finalState = controller?.getState() ?? before;
  const composer = binding();
  if (composer)
    composer.onChange(
      present(finalState, {
        entered: false,
        expectedText: before.text,
        status: "paused",
      }),
    );
  else if (finalState.text.trim())
    keepUnsentVoiceText(target, prefix, finalState.text);
}

/** The longest an exit may hold the window before it closes regardless. */
export const voiceModeExitCeilingMs = 30_000;

const idleState: VoiceModeState = {
  status: "idle",
  text: "",
  sending: false,
  flushing: false,
};

interface Run {
  prefix: VoiceTurnPrefix;
  sourceId: string;
  startedAt: string;
  target: VoiceModeSessionTarget;
}

/**
 * Owns the one Voice Mode session for the app shell: its run, controller and
 * transport, and the snapshot the provider renders. Room composers come and
 * go through `bindings`; the session never depends on which one is mounted.
 */
export function createVoiceModeSessionEngine({
  bindings,
  deps,
  publish,
  publishLevel,
}: {
  bindings: Map<string, VoiceModeRoomBinding>;
  deps: () => {
    hardware: ReturnType<typeof useOptionalVoiceControl>;
    queryClient: QueryClient | undefined;
    runtime: TeamHubRuntime | null;
  };
  publish: (session: VoiceModeSession | undefined) => void;
  /** The microphone level arrives about every 50 ms; it skips the session. */
  publishLevel: (level: number) => void;
}) {
  let run: Run | undefined;
  let state = idleState;
  let muted = false;
  let soundOff = false;
  let live: LiveView | undefined;
  let entered = false;
  let closing = false;
  let controller: VoiceModeController | undefined;
  let stop: (() => void) | undefined;
  const abortRef: { current: AbortController | undefined } = {
    current: undefined,
  };
  const snapshot = () =>
    publish(
      run && {
        closing,
        entered,
        live: live && liveView(),
        muted,
        prefix: run.prefix,
        sourceId: run.sourceId,
        startedAt: run.startedAt,
        state,
        target: run.target,
      },
    );
  const liveView = (): VoiceModeLivePresentation => ({
    soundOff,
    transcript: live?.transcript ?? [],
  });
  const present = (
    current: Run,
    next: VoiceModeState,
    extra: Partial<VoiceModePresentation> = {},
  ): VoiceModePresentation => ({
    entered: true,
    text: next.text,
    error: next.error,
    status: next.status,
    microphoneActive: next.microphoneActive,
    sending: next.sending,
    flushing: next.flushing,
    sourceId: current.sourceId,
    prefix: current.prefix.body,
    ...extra,
  });

  const engine = {
    start(
      target: VoiceModeSessionTarget,
      prefix: VoiceTurnPrefix,
      modes: VoiceModeModes = { dictation: true, live: false },
    ) {
      const { hardware, queryClient, runtime } = deps();
      if (run || !runtime) return;
      const current: Run = {
        prefix,
        // Plain-http origins have no crypto.randomUUID.
        sourceId:
          globalThis.crypto?.randomUUID?.() ??
          `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        startedAt: new Date().toISOString(),
        target,
      };
      run = current;
      entered = true;
      muted = false;
      soundOff = false;
      live = undefined;
      state = { ...idleState, status: "connecting" };
      snapshot();
      bindings.get(target.roomId)?.onChange(present(current, state));
      stop = runVoiceModeSession({
        abortRef,
        binding: (roomId) => bindings.get(roomId),
        entered: () => entered,
        exitByVoice: () => engine.exit(),
        hardware: () => deps().hardware ?? hardware,
        modes,
        onLevel: publishLevel,
        onLive: (next) => {
          live = next;
          snapshot();
        },
        onState: (next) => {
          state = next;
          snapshot();
        },
        prefix,
        present: (next) => present(current, next),
        queryClient,
        runtime,
        setController: (next) => {
          controller = next;
        },
        soundOff: () => soundOff,
        target,
      });
    },
    exit() {
      const current = run;
      if (!current || !entered) return;
      entered = false;
      closing = true;
      const before = controller?.getState() ?? idleState;
      const exiting = controller;
      snapshot();
      closeVoicePip("voice-mode");
      bindings
        .get(current.target.roomId)
        ?.onChange(
          present(current, before, { entered: false, status: "closing" }),
        );
      // Stop the physical microphone at once; keep the session until trailing
      // text has drained and the shared microphone lease is released.
      abortRef.current?.abort();
      // The window always closes: past the ceiling a stuck send or shutdown
      // stops holding it, and unsent words still return to the draft.
      const drained = Promise.race([
        Promise.all([exiting?.pause(), exiting?.whenDeliverySettles()]),
        new Promise<void>((resolve) =>
          setTimeout(resolve, voiceModeExitCeilingMs),
        ),
      ]);
      void finishVoiceModeSession({
        before,
        binding: () => bindings.get(current.target.roomId),
        controller: exiting,
        drained,
        prefix: current.prefix,
        present: (next, extra) => present(current, next, extra),
        target: current.target,
      })
        .catch(() => undefined)
        .then(() => {
          stop?.();
          stop = undefined;
          run = undefined;
          closing = false;
          state = idleState;
          live = undefined;
          publishLevel(0);
          snapshot();
        });
    },
    /** A composer that mounts mid-session resumes the live presentation. */
    resume(roomId: string, binding: VoiceModeRoomBinding) {
      if (run?.target.roomId === roomId && entered)
        binding.onChange(present(run, controller?.getState() ?? state));
    },
    retry() {
      void controller?.retry();
    },
    async setMuted(next: boolean) {
      muted = next;
      snapshot();
      try {
        await controller?.setMuted(next);
      } catch {
        muted = !next;
        snapshot();
      }
    },
    /** Silences the live reply only; the microphone keeps listening. */
    setSoundOff(next: boolean) {
      soundOff = next;
      live?.connection?.setSoundOff(next);
      snapshot();
    },
    dispose() {
      closeVoicePip("voice-mode");
      stop?.();
      stop = undefined;
      run = undefined;
    },
  };
  return engine;
}

export type VoiceModeSessionEngine = ReturnType<
  typeof createVoiceModeSessionEngine
>;
