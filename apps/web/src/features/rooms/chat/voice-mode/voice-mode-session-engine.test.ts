// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { VoiceModeEvent } from "./voice-mode-controller";
import type { VoiceModeSession } from "./voice-mode-session";
import { createVoiceModeSessionEngine } from "./voice-mode-session-engine";

interface Opened {
  receive: (event: VoiceModeEvent) => void;
  fail: (error: unknown) => void;
  microphone?: (microphone: {
    setMuted: (muted: boolean) => Promise<void>;
  }) => void;
  channel?: (connection: unknown) => void;
}

const live = vi.hoisted(() => ({
  failToOpen: false,
  opened: undefined as undefined | Opened,
  connection: {
    voiceSessionId: "live-session",
    active: vi.fn(() => true),
    send: vi.fn(),
    setSoundOff: vi.fn(),
    setMuted: vi.fn(async () => undefined),
    commit: async () => undefined,
    close: vi.fn(async () => undefined),
  },
}));
vi.mock("./live/voice-live-transport", () => ({
  openVoiceLive: async (input: Opened) => {
    live.opened = input;
    if (live.failToOpen) throw new Error("LIVE_UNAVAILABLE");
    input.channel?.(live.connection);
    return live.connection;
  },
}));
const dictation = vi.hoisted(() => ({
  opened: undefined as undefined | Opened,
  open: vi.fn(),
  close: vi.fn(async () => undefined),
}));
vi.mock("./voice-mode-transport", () => ({
  openVoiceMode: async (input: Opened) => {
    dictation.opened = input;
    dictation.open();
    return {
      close: dictation.close,
      commit: async () => undefined,
      setMuted: async () => undefined,
    };
  },
}));
vi.mock("./commands/voice-turn-runner", () => ({
  handleVoiceTurn: async () => "chat",
  voiceTurnSends: (outcome: string) => outcome === "chat",
}));
const sender = vi.hoisted(() => ({
  keepUnsentVoiceText: vi.fn(),
  sendVoiceTurnToRoom: vi.fn<(input: unknown) => Promise<void>>(
    async () => undefined,
  ),
}));
vi.mock("./voice-mode-room-sender", () => sender);

const target = {
  accountId: "account-1",
  roomId: "room-voice",
  roomName: "Codex",
  tenantId: "tenant-northstar",
};
const prefix = { body: "", documentReferences: [], mentions: [] };

function start() {
  let session: VoiceModeSession | undefined;
  const engine = createVoiceModeSessionEngine({
    bindings: new Map(),
    deps: () => ({
      hardware: null,
      queryClient: undefined,
      runtime: {
        client: {},
        composition: { kind: "plain" },
      } as unknown as TeamHubRuntime,
    }),
    publish: (next) => {
      session = next;
    },
    publishLevel: vi.fn(),
  });
  engine.start(target, prefix, { dictation: true, live: true });
  return { engine, session: () => session };
}

afterEach(() => {
  vi.clearAllMocks();
  live.failToOpen = false;
  live.opened = undefined;
  dictation.opened = undefined;
  live.connection.active.mockReturnValue(true);
});

describe("Voice Mode session engine live mode", () => {
  it("falls back to dictation when the live session cannot open", async () => {
    live.failToOpen = true;
    const { engine, session } = start();
    await vi.waitFor(() => expect(dictation.open).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(session()?.state.status).toBe("listening"));
    expect(session()?.live).toBeUndefined();
    engine.dispose();
  });

  it("falls back once the live session fails, keeping unsent words and sending them once", async () => {
    const { engine, session } = start();
    await vi.waitFor(() => expect(session()?.state.status).toBe("listening"));
    expect(session()?.live).toEqual({ soundOff: false, transcript: [] });

    live.opened!.receive({
      kind: "partial",
      text: "Not done yet",
      endOffsetMs: 1,
    });
    // Heard, but the live session dies before its verdict reaches it.
    live.connection.active.mockReturnValue(false);
    live.opened!.receive({
      kind: "turn",
      id: "lt_1",
      text: "Summarize it for me",
      endOffsetMs: 2,
    });
    live.opened!.receive({ kind: "partial", text: "Going on", endOffsetMs: 3 });
    live.opened!.fail(new Error("session_failure"));

    await vi.waitFor(() => expect(dictation.open).toHaveBeenCalledOnce());
    expect(live.connection.close).toHaveBeenCalled();
    expect(session()?.live).toBeUndefined();
    await vi.waitFor(() =>
      expect(sender.sendVoiceTurnToRoom).toHaveBeenCalledOnce(),
    );
    // An ordinary Message the Agent answers: no live marker.
    expect(sender.sendVoiceTurnToRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "lt_1",
        text: "Summarize it for me",
        voiceLiveTurn: undefined,
      }),
    );
    // The words still being spoken carry over into dictation.
    await vi.waitFor(() => expect(session()?.state.text).toBe("Going on"));
    engine.dispose();
  });

  it("turns the reply sound off without muting the microphone", async () => {
    const { engine, session } = start();
    await vi.waitFor(() => expect(session()?.state.status).toBe("listening"));

    engine.setSoundOff(true);
    expect(live.connection.setSoundOff).toHaveBeenCalledWith(true);
    expect(session()).toEqual(
      expect.objectContaining({
        live: { soundOff: true, transcript: [] },
        muted: false,
      }),
    );
    expect(live.connection.setMuted).not.toHaveBeenCalled();

    await engine.setMuted(true);
    expect(live.connection.setMuted).toHaveBeenCalledWith(true);
    expect(session()?.live?.soundOff).toBe(true);
    expect(live.connection.setSoundOff).toHaveBeenCalledOnce();
    engine.dispose();
  });
});
