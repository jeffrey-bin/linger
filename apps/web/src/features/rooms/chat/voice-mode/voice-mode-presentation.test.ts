import { describe, expect, it } from "vitest";
import {
  voiceModeStatusLabel,
  type VoiceModePresentation,
} from "./voice-mode-presentation";

describe("Voice Mode visible status", () => {
  it.each<[Partial<VoiceModePresentation>, string]>([
    [{ status: "connecting" }, "Connecting microphone…"],
    [{ status: "listening" }, "Listening · Sends when you finish speaking"],
    [
      { status: "listening", flushing: true },
      "Finishing this message… You can keep speaking",
    ],
    [
      { status: "listening", sending: true },
      "Sending message… You can keep speaking",
    ],
    [
      { status: "closing", sending: true },
      "Microphone off · Finishing last words…",
    ],
    [{ status: "error" }, "Voice input stopped · Exit to review your draft"],
    [
      { error: "Connection lost. Your draft is kept." },
      "Connection lost. Your draft is kept.",
    ],
    [{ entered: false, status: "paused" }, "Microphone off · Draft kept"],
  ])("describes real state %j", (state, label) => {
    expect(voiceModeStatusLabel({ entered: true, text: "", ...state })).toBe(
      label,
    );
  });
});
