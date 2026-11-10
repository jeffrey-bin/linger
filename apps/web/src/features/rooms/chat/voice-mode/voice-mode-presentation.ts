import type { VoiceModeState } from "./voice-mode-controller";

export interface VoiceModePresentation {
  entered: boolean;
  text: string;
  status?: VoiceModeState["status"];
  sending?: boolean;
  flushing?: boolean;
  microphoneActive?: boolean;
  error?: string;
  expectedText?: string;
  sourceId?: string;
  /** The draft that preceded dictation; lets a remounted composer resume. */
  prefix?: string;
}

/** Describes actual state only; the browser does not invent a VAD countdown. */
export function voiceModeStatusLabel(state: VoiceModePresentation): string {
  if (state.error) return state.error;
  if (state.status === "closing")
    return "Microphone off · Finishing last words…";
  if (state.status === "connecting")
    return state.microphoneActive
      ? "Connecting transcription…"
      : "Connecting microphone…";
  if (state.status === "error")
    return "Voice input stopped · Exit to review your draft";
  if (!state.entered || state.status === "paused")
    return "Microphone off · Draft kept";
  if (state.flushing) return "Finishing this message… You can keep speaking";
  if (state.sending) return "Sending message… You can keep speaking";
  return "Listening · Sends when you finish speaking";
}
