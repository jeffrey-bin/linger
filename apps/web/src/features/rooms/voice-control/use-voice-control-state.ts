import type { LocalAudioTrack, Room } from "livekit-client";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";

import type { TeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubVoiceCapture,
  TeamHubVoiceSession,
} from "@/features/teamhub/teamhub-types";
import { VoiceRequestScope } from "@/features/teamhub/voice-request-scope";

import type {
  VoiceMicrophoneBinding,
  VoiceMicrophoneDevice,
} from "./microphone-devices";
import type {
  VoiceCaptureState,
  VoiceCaptureSyncStatus,
  VoiceListenerStatus,
  VoiceTranscriptItem,
  VoiceTranscriptStatus,
} from "./voice-control-context";
import { projectCapture } from "./voice-control-helpers";
import {
  readDeviceBinding,
  rememberVoiceListeningCapture,
} from "./voice-control-storage";

export interface VoiceTarget {
  agentId: string;
  agentName: string;
  roomId: string;
}

/**
 * The provider's mutable cells. They are created once per provider so every
 * sub-hook reads and fences against the same instances.
 */
export interface VoiceControlRefs {
  pageActiveRef: RefObject<boolean>;
  mountedRef: RefObject<boolean>;
  roomRef: RefObject<Room | undefined>;
  trackRef: RefObject<LocalAudioTrack | undefined>;
  connectionControllerRef: RefObject<AbortController | undefined>;
  voiceSessionRef: RefObject<TeamHubVoiceSession | undefined>;
  voiceSessionGenerationRef: RefObject<number>;
  captureRef: RefObject<TeamHubVoiceCapture | undefined>;
  sessionStartedAtRef: RefObject<number>;
  enablePromiseRef: RefObject<Promise<void> | undefined>;
  leavePromiseRef: RefObject<Promise<void> | undefined>;
  // Always the latest page-exit handler, so pagehide and unmount release the
  // current VoiceSession. A layout effect sets it before any reader runs.
  leavePageRef: RefObject<() => Promise<void>>;
  startPromiseRef: RefObject<
    Promise<TeamHubVoiceCapture | undefined> | undefined
  >;
  startControllerRef: RefObject<AbortController | undefined>;
  stopPromiseRef: RefObject<
    | { captureId: string; promise: Promise<TeamHubVoiceCapture | undefined> }
    | undefined
  >;
  publisherLeaseRef: RefObject<(() => void) | undefined>;
  capturePollGenerationRef: RefObject<number>;
  eventStreamLiveRef: RefObject<boolean>;
  // The event feed starts at its bootstrap snapshot; one Capture read after
  // it goes live catches a change committed before that snapshot.
  captureResyncRef: RefObject<boolean>;
  voiceAccessLostRef: RefObject<boolean>;
  composerLeaseRef: RefObject<boolean>;
  microphoneMutedRef: RefObject<boolean>;
  manuallyDisabledRef: RefObject<boolean>;
  targetChangeRef: RefObject<Promise<void> | undefined>;
  targetRef: RefObject<VoiceTarget | undefined>;
  bindingRef: RefObject<VoiceMicrophoneBinding | undefined>;
}

export interface VoiceControlState {
  refs: VoiceControlRefs;
  requests: VoiceRequestScope;
  pageActive: boolean;
  boundDevice: VoiceMicrophoneDevice | undefined;
  setBoundDevice: Dispatch<SetStateAction<VoiceMicrophoneDevice | undefined>>;
  captureState: VoiceCaptureState;
  captureSyncStatus: VoiceCaptureSyncStatus;
  setCaptureSyncStatus: Dispatch<SetStateAction<VoiceCaptureSyncStatus>>;
  composerMicrophoneActive: boolean;
  setComposerMicrophoneActive: Dispatch<SetStateAction<boolean>>;
  devices: VoiceMicrophoneDevice[];
  setDevices: Dispatch<SetStateAction<VoiceMicrophoneDevice[]>>;
  listenerError: string | undefined;
  setListenerError: Dispatch<SetStateAction<string | undefined>>;
  listenerStatus: VoiceListenerStatus;
  setListenerStatus: Dispatch<SetStateAction<VoiceListenerStatus>>;
  microphoneMuted: boolean;
  setMicrophoneMutedState: Dispatch<SetStateAction<boolean>>;
  selectedDeviceId: string;
  setSelectedDeviceId: Dispatch<SetStateAction<string>>;
  targetAgentName: string | undefined;
  setTargetAgentName: Dispatch<SetStateAction<string | undefined>>;
  targetRoomId: string | undefined;
  setTargetRoomId: Dispatch<SetStateAction<string | undefined>>;
  voiceSessionId: string | undefined;
  setVoiceSessionId: Dispatch<SetStateAction<string | undefined>>;
  transcriptItems: VoiceTranscriptItem[];
  setTranscriptItems: Dispatch<SetStateAction<VoiceTranscriptItem[]>>;
  partialTranscript: string | undefined;
  setPartialTranscript: Dispatch<SetStateAction<string | undefined>>;
  transcriptStatus: VoiceTranscriptStatus;
  setTranscriptStatus: Dispatch<SetStateAction<VoiceTranscriptStatus>>;
  setCapture: (
    capture: TeamHubVoiceCapture | undefined,
    state?: VoiceCaptureState,
  ) => void;
}

function createVoiceControlRefs(
  binding: VoiceMicrophoneBinding | undefined,
  pageActive: boolean,
): VoiceControlRefs {
  return {
    pageActiveRef: { current: pageActive },
    mountedRef: { current: true },
    roomRef: { current: undefined },
    trackRef: { current: undefined },
    connectionControllerRef: { current: undefined },
    voiceSessionRef: { current: undefined },
    voiceSessionGenerationRef: { current: 0 },
    captureRef: { current: undefined },
    sessionStartedAtRef: { current: 0 },
    enablePromiseRef: { current: undefined },
    leavePromiseRef: { current: undefined },
    leavePageRef: { current: () => Promise.resolve() },
    startPromiseRef: { current: undefined },
    startControllerRef: { current: undefined },
    stopPromiseRef: { current: undefined },
    publisherLeaseRef: { current: undefined },
    capturePollGenerationRef: { current: 0 },
    eventStreamLiveRef: { current: false },
    captureResyncRef: { current: false },
    voiceAccessLostRef: { current: false },
    composerLeaseRef: { current: false },
    microphoneMutedRef: { current: false },
    manuallyDisabledRef: { current: true },
    targetChangeRef: { current: undefined },
    targetRef: { current: undefined },
    bindingRef: { current: binding },
  };
}

/** Owns the provider's React state, its refs and the page-activity feed. */
export function useVoiceControlState(
  tenantId: string,
  runtime: TeamHubRuntime,
): VoiceControlState {
  const [initial] = useState(() => {
    const binding = readDeviceBinding(tenantId);
    const pageActive = runtime.pageActivity?.isActive() ?? true;
    return {
      binding,
      pageActive,
      refs: createVoiceControlRefs(binding, pageActive),
    };
  });
  const { refs } = initial;
  const [pageActive, setPageActive] = useState(initial.pageActive);
  const [requests] = useState(() => new VoiceRequestScope());
  const [boundDevice, setBoundDevice] = useState<
    VoiceMicrophoneDevice | undefined
  >(initial.binding);
  const [captureState, setCaptureState] = useState<VoiceCaptureState>({
    status: "idle",
  });
  const [captureSyncStatus, setCaptureSyncStatus] =
    useState<VoiceCaptureSyncStatus>("idle");
  const [composerMicrophoneActive, setComposerMicrophoneActive] =
    useState(false);
  const [devices, setDevices] = useState<VoiceMicrophoneDevice[]>([]);
  const [listenerError, setListenerError] = useState<string>();
  const [listenerStatus, setListenerStatus] =
    useState<VoiceListenerStatus>("disabled");
  const [microphoneMuted, setMicrophoneMutedState] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState(
    initial.binding?.deviceId ?? "",
  );
  const [targetAgentName, setTargetAgentName] = useState<string>();
  const [targetRoomId, setTargetRoomId] = useState<string>();
  const [voiceSessionId, setVoiceSessionId] = useState<string>();
  const [transcriptItems, setTranscriptItems] = useState<VoiceTranscriptItem[]>(
    [],
  );
  const [partialTranscript, setPartialTranscript] = useState<string>();
  const [transcriptStatus, setTranscriptStatus] =
    useState<VoiceTranscriptStatus>("idle");

  const setCapture = useCallback(
    (capture: TeamHubVoiceCapture | undefined, state?: VoiceCaptureState) => {
      const previous = refs.captureRef.current;
      if (
        capture &&
        previous?.id === capture.id &&
        Date.parse(capture.updated_at) < Date.parse(previous.updated_at)
      )
        return;
      if (capture?.id !== refs.captureRef.current?.id)
        setPartialTranscript(undefined);
      if (
        capture &&
        (capture.id !== previous?.id || capture.status !== previous?.status)
      )
        rememberVoiceListeningCapture(tenantId, capture);
      refs.captureRef.current = capture;
      const nextState =
        state ?? (capture ? projectCapture(capture) : { status: "idle" });
      setCaptureState(nextState);
      setCaptureSyncStatus(
        nextState.status === "starting" ||
          nextState.status === "recording" ||
          nextState.status === "finalizing"
          ? "live"
          : "idle",
      );
    },
    [refs, tenantId],
  );

  useEffect(() => {
    const activity = runtime.pageActivity;
    if (!activity) return;
    const update = (active: boolean) => {
      refs.pageActiveRef.current = active;
      setPageActive(active);
    };
    update(activity.isActive());
    return activity.subscribe(update);
  }, [refs, runtime.pageActivity]);

  return {
    refs,
    requests,
    pageActive,
    boundDevice,
    setBoundDevice,
    captureState,
    captureSyncStatus,
    setCaptureSyncStatus,
    composerMicrophoneActive,
    setComposerMicrophoneActive,
    devices,
    setDevices,
    listenerError,
    setListenerError,
    listenerStatus,
    setListenerStatus,
    microphoneMuted,
    setMicrophoneMutedState,
    selectedDeviceId,
    setSelectedDeviceId,
    targetAgentName,
    setTargetAgentName,
    targetRoomId,
    setTargetRoomId,
    voiceSessionId,
    setVoiceSessionId,
    transcriptItems,
    setTranscriptItems,
    partialTranscript,
    setPartialTranscript,
    transcriptStatus,
    setTranscriptStatus,
    setCapture,
  };
}
