import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { VoiceModeEvent } from "./voice-mode-controller";
import {
  useOptionalVoiceModeSession,
  VoiceModeSessionProvider,
} from "./voice-mode-session";
import { voiceModeExitCeilingMs } from "./voice-mode-session-engine";

const transport = vi.hoisted(() => ({
  receive: undefined as undefined | ((event: VoiceModeEvent) => void),
  close: vi.fn<() => Promise<void>>(async () => undefined),
  open: vi.fn(async () => undefined),
}));
vi.mock("./voice-mode-transport", () => ({
  openVoiceMode: async (input: {
    receive: (event: VoiceModeEvent) => void;
  }) => {
    transport.receive = input.receive;
    await transport.open();
    return {
      close: transport.close,
      commit: async () => undefined,
      setMuted: async () => undefined,
    };
  },
}));
const sender = vi.hoisted(() => ({
  keepUnsentVoiceText: vi.fn(),
  sendVoiceTurnToRoom: vi.fn(async () => undefined),
}));
vi.mock("./voice-mode-room-sender", () => sender);

const target = {
  accountId: "account-1",
  roomId: "room-voice",
  roomName: "Codex",
  tenantId: "tenant-northstar",
};
const prefix = { body: "", documentReferences: [], mentions: [] };

type Api = NonNullable<ReturnType<typeof useOptionalVoiceModeSession>>;
let api: Api;
function CaptureApi() {
  const value = useOptionalVoiceModeSession()!;
  api = value;
  return null;
}

/** Stands in for the voice Room's composer while that Room is on screen. */
function VoiceRoomComposer({
  prepareSend,
}: {
  prepareSend: (text: string, id: string) => () => Promise<void>;
}) {
  const { bind } = useOptionalVoiceModeSession()!;
  useEffect(
    () => bind(target.roomId, { onChange: () => undefined, prepareSend }),
    [bind, prepareSend],
  );
  return null;
}

const runtime = createTestTeamHubRuntime();

function renderSession(children?: ReactNode) {
  return render(
    <TeamHubRuntimeProvider runtime={runtime}>
      <VoiceModeSessionProvider>
        <CaptureApi />
        {children}
      </VoiceModeSessionProvider>
    </TeamHubRuntimeProvider>,
  );
}

afterEach(async () => {
  cleanup();
  await act(async () => undefined);
  vi.clearAllMocks();
});

describe("Voice Mode session", () => {
  it("keeps one transport across Room navigation and sends there directly", async () => {
    const dispatch = vi.fn(async () => undefined);
    const prepareSend = vi.fn(() => dispatch);
    const view = renderSession(<VoiceRoomComposer prepareSend={prepareSend} />);
    act(() => api.start(target, prefix));
    await waitFor(() => expect(transport.open).toHaveBeenCalledOnce());

    act(() =>
      transport.receive?.({
        kind: "turn",
        id: "turn-1",
        text: "First",
        endOffsetMs: 100,
      }),
    );
    expect(prepareSend).toHaveBeenCalledExactlyOnceWith("First", "turn-1");

    // Navigating away unmounts the voice Room's composer, not the session.
    view.rerender(
      <TeamHubRuntimeProvider runtime={runtime}>
        <VoiceModeSessionProvider>
          <CaptureApi />
        </VoiceModeSessionProvider>
      </TeamHubRuntimeProvider>,
    );
    await act(async () => undefined);
    act(() =>
      transport.receive?.({
        kind: "turn",
        id: "turn-2",
        text: "Second",
        endOffsetMs: 200,
      }),
    );
    await waitFor(() =>
      expect(sender.sendVoiceTurnToRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: "turn-2",
          target,
          text: "Second",
        }),
      ),
    );
    expect(prepareSend).toHaveBeenCalledOnce();
    expect(transport.open).toHaveBeenCalledOnce();
    expect(transport.close).not.toHaveBeenCalled();
    expect(api.session?.target.roomId).toBe(target.roomId);
  });

  it("ends from anywhere, closing once and keeping unsent words for the Room", async () => {
    renderSession();
    act(() => api.start(target, prefix));
    await waitFor(() => expect(transport.open).toHaveBeenCalledOnce());
    act(() =>
      transport.receive?.({
        kind: "partial",
        text: "half a thought",
        endOffsetMs: 100,
      }),
    );

    act(() => api.exit());
    expect(api.session?.closing).toBe(true);
    await waitFor(() => expect(api.session).toBeUndefined());
    expect(transport.close).toHaveBeenCalledOnce();
    expect(sender.keepUnsentVoiceText).toHaveBeenCalledWith(
      target,
      prefix,
      "half a thought",
    );
  });

  it("closes the window after the exit ceiling even when shutdown hangs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      transport.close.mockImplementationOnce(
        () => new Promise(() => undefined),
      );
      renderSession();
      act(() => api.start(target, prefix));
      await vi.waitFor(() => expect(transport.open).toHaveBeenCalledOnce());
      await act(async () => undefined);
      act(() =>
        transport.receive?.({
          kind: "partial",
          text: "still unsent",
          endOffsetMs: 100,
        }),
      );

      act(() => api.exit());
      expect(api.session?.closing).toBe(true);
      await act(async () => vi.advanceTimersByTime(voiceModeExitCeilingMs - 1));
      expect(api.session?.closing).toBe(true);
      await act(async () => vi.advanceTimersByTime(1));
      expect(api.session).toBeUndefined();
      expect(sender.keepUnsentVoiceText).toHaveBeenCalledWith(
        target,
        prefix,
        "still unsent",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows only one session at a time", async () => {
    renderSession();
    act(() => api.start(target, prefix));
    act(() => api.start({ ...target, roomId: "room-other" }, prefix));
    await waitFor(() => expect(transport.open).toHaveBeenCalledOnce());
    expect(api.session?.target.roomId).toBe("room-voice");
  });
});
