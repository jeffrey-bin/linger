/* oxlint-disable react-doctor/only-export-components -- Provider and lifecycle hook share one boundary. */
import { type ReactNode, useMemo } from "react";
import { useNavigate } from "react-router";

import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import {
  VoiceControlContext,
  type VoiceControlContextValue,
} from "./voice-control-context";
import { useComposerMicrophone } from "./use-composer-microphone";
import { useVoiceCaptureCommands } from "./use-voice-capture-commands";
import { useVoiceCapturePolling } from "./use-voice-capture-polling";
import { useVoiceControlState } from "./use-voice-control-state";
import { useVoiceDeviceChange, useVoiceDevices } from "./use-voice-devices";
import { useVoiceListener } from "./use-voice-listener";
import { useVoiceMedia } from "./use-voice-media";
import { useVoiceSessionEvents } from "./use-voice-session-events";
import {
  useVoiceMountLifecycle,
  useVoiceSessionLifecycle,
} from "./use-voice-session-lifecycle";
import { useVoiceTarget, useVoiceTargetSelection } from "./use-voice-target";

export function LiveKitVoiceControlProvider({
  children,
  tenantId,
  activeRoomId,
}: {
  children: ReactNode;
  tenantId: string;
  activeRoomId?: string;
}) {
  const value = useVoiceControlProviderValue(tenantId, activeRoomId);
  return <VoiceControlContext value={value}>{children}</VoiceControlContext>;
}

// The sub-hooks are called in the order their effects must run: page
// activity, listener reconnection, Capture polling, page exit, the event
// feed, then mount and device changes.
function useVoiceControlProviderValue(
  tenantId: string,
  activeRoomId?: string,
): VoiceControlContextValue {
  const runtime = useTeamHubRuntime();
  const navigate = useNavigate();
  const state = useVoiceControlState(tenantId, runtime);
  const {
    boundDevice,
    captureState,
    captureSyncStatus,
    composerMicrophoneActive,
    devices,
    listenerError,
    listenerStatus,
    microphoneMuted,
    partialTranscript,
    selectedDeviceId,
    targetAgentName,
    targetRoomId,
    transcriptItems,
    transcriptStatus,
  } = state;
  const { ensureTarget, resolveVoiceSession } = useVoiceTarget(
    state,
    runtime,
    tenantId,
    activeRoomId,
  );
  const { cleanupMedia, failMedia, restoreActiveCapture, adoptMicrophone } =
    useVoiceMedia(state, runtime, tenantId);
  const enable = useVoiceListener({
    state,
    runtime,
    tenantId,
    adoptMicrophone,
    cleanupMedia,
    ensureTarget,
    failMedia,
    resolveVoiceSession,
    restoreActiveCapture,
  });
  useVoiceCapturePolling(state, runtime, cleanupMedia);
  const { startCapture, startNewCapture, stopCapture } =
    useVoiceCaptureCommands({
      state,
      runtime,
      tenantId,
      navigate,
      enable,
      ensureTarget,
    });
  const {
    discoverDevices,
    selectDevice,
    connectDevice,
    setMicrophoneMuted,
    disable,
  } = useVoiceDevices(state, tenantId, enable, cleanupMedia);
  const { leavePage, disconnectDevice } = useVoiceSessionLifecycle(
    state,
    runtime,
    tenantId,
    cleanupMedia,
    disable,
  );
  const selectTargetRoom = useVoiceTargetSelection(
    state,
    runtime,
    tenantId,
    disable,
  );
  useVoiceSessionEvents(state, runtime, cleanupMedia);
  const acquireComposerMicrophone = useComposerMicrophone(
    state,
    tenantId,
    enable,
    leavePage,
    cleanupMedia,
  );
  useVoiceMountLifecycle(state, cleanupMedia, ensureTarget);
  useVoiceDeviceChange(state, connectDevice, failMedia);

  const currentCapture =
    "capture" in captureState ? captureState.capture : undefined;
  const visibleTranscriptItems = useMemo(() => {
    if (captureState.status === "completed") return [];
    return transcriptItems.filter((item) =>
      currentCapture
        ? item.captureId
          ? item.captureId === currentCapture.id
          : item.createdAtMs >= Date.parse(currentCapture.created_at)
        : !item.captureId,
    );
  }, [captureState.status, currentCapture, transcriptItems]);

  return useMemo(
    () => ({
      acquireComposerMicrophone,
      adoptMicrophone,
      boundDevice,
      captureSyncStatus,
      captureState,
      composerMicrophoneActive,
      connectDevice,
      devices,
      discoverDevices,
      disconnectDevice,
      disable,
      enable,
      leavePage,
      listenerError,
      listenerStatus,
      microphoneMuted,
      partialTranscript:
        captureState.status === "completed" ? undefined : partialTranscript,
      selectedDeviceId,
      selectDevice,
      selectTargetRoom,
      setMicrophoneMuted,
      startCapture,
      startNewCapture,
      stopCapture,
      targetAgentName,
      targetRoomId,
      transcriptItems: visibleTranscriptItems,
      transcriptStatus,
    }),
    [
      acquireComposerMicrophone,
      adoptMicrophone,
      boundDevice,
      captureSyncStatus,
      captureState,
      composerMicrophoneActive,
      connectDevice,
      devices,
      discoverDevices,
      disconnectDevice,
      disable,
      enable,
      leavePage,
      listenerError,
      listenerStatus,
      microphoneMuted,
      partialTranscript,
      selectedDeviceId,
      selectDevice,
      selectTargetRoom,
      setMicrophoneMuted,
      startCapture,
      startNewCapture,
      stopCapture,
      targetAgentName,
      targetRoomId,
      visibleTranscriptItems,
      transcriptStatus,
    ],
  );
}
