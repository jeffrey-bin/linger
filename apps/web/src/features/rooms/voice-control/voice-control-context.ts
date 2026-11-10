import { createContext, useContext } from "react";

import type { TeamHubVoiceCapture } from "@/features/teamhub/teamhub-types";

import type { VoiceMicrophoneDevice } from "./microphone-devices";

export type VoiceListenerStatus =
  | "disabled"
  | "device_disconnected"
  | "enabling"
  | "listening"
  | "standby"
  | "transcribing"
  | "composer_recording"
  | "error";
export type VoiceTranscriptStatus = "idle" | "live" | "recovering";
export type VoiceCaptureSyncStatus = "idle" | "live" | "recovering";

export type VoiceCaptureState =
  | { status: "idle" }
  | {
      capture: TeamHubVoiceCapture;
      status: "starting" | "recording" | "finalizing" | "recovering";
    }
  | { capture: TeamHubVoiceCapture; status: "completed" }
  | { capture?: TeamHubVoiceCapture; reason: unknown; status: "failed" };

/**
 * Saving stopped on a transcript recovery that needs the user's Retry. The
 * recording is safe and no longer occupies the microphone, so it neither shows
 * as saving nor blocks the next recording.
 */
export function isTranscriptRecoveryPaused(state: VoiceCaptureState) {
  return (
    state.status === "recovering" &&
    state.capture.transcript_recovery_status === "failed"
  );
}

export interface VoiceTranscriptItem {
  updatedAt?: string;
  captureId?: string;
  createdAtMs: number;
  endOffsetMs?: number;
  id: string;
  startOffsetMs?: number;
  speakerLabel?: string;
  text: string;
}

export interface VoiceControlContextValue {
  acquireComposerMicrophone(options?: {
    resumeListening?: boolean;
  }): Promise<() => Promise<void>>;
  /** Binds the microphone a voice input actually opened. */
  adoptMicrophone?(deviceId: string | undefined): Promise<void>;
  boundDevice?: VoiceMicrophoneDevice;
  captureSyncStatus: VoiceCaptureSyncStatus;
  captureState: VoiceCaptureState;
  composerMicrophoneActive: boolean;
  connectDevice(deviceId: string): Promise<void>;
  devices: VoiceMicrophoneDevice[];
  discoverDevices(): Promise<VoiceMicrophoneDevice[]>;
  disconnectDevice(): Promise<void>;
  disable(): Promise<void>;
  enable(): Promise<void>;
  leavePage?(): Promise<void>;
  listenerError?: string;
  listenerStatus: VoiceListenerStatus;
  microphoneMuted: boolean;
  partialTranscript?: string;
  selectedDeviceId: string;
  setMicrophoneMuted(muted: boolean): Promise<void>;
  selectDevice(deviceId: string): Promise<void>;
  selectTargetRoom?(roomId: string): Promise<void>;
  startCapture(): Promise<unknown>;
  startNewCapture(): Promise<void>;
  stopCapture(): Promise<unknown>;
  targetAgentName?: string;
  targetRoomId?: string;
  transcriptItems: VoiceTranscriptItem[];
  transcriptStatus: VoiceTranscriptStatus;
}

// What the deployment offers. Undefined while the workspace reads its voice
// policy or loads the LiveKit engine; outside a workspace everything is offered.
export interface VoiceCapabilities {
  voiceMedia: boolean;
}
export const VoiceCapabilitiesContext = createContext<
  VoiceCapabilities | undefined
>({ voiceMedia: true });

export const VoiceControlContext =
  createContext<VoiceControlContextValue | null>(null);

export function useVoiceControl() {
  const value = useContext(VoiceControlContext);
  if (!value) throw new Error("Voice Control Provider is unavailable");
  return value;
}

export function useOptionalVoiceControl() {
  return useContext(VoiceControlContext);
}
