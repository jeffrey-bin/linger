import { act, renderHook } from "@testing-library/react";
import { useLayoutEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import type { VoiceModeEvent } from "../chat/voice-mode/voice-mode-controller";
import { usePocketDictation } from "./use-pocket-dictation";

const transport = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../chat/voice-mode/voice-mode-transport", () => ({
  openVoiceMode: transport.open,
}));
vi.mock("livekit-client", () => ({}));

describe("Pocket Note dictation session lifecycle", () => {
  const connections: {
    close: ReturnType<typeof vi.fn>;
    receive: (event: VoiceModeEvent) => void;
  }[] = [];
  const runtime = createTestTeamHubRuntime();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TeamHubRuntimeProvider runtime={runtime}>
      {children}
    </TeamHubRuntimeProvider>
  );

  beforeEach(() => {
    connections.length = 0;
    transport.open.mockReset().mockImplementation(async ({ receive }) => {
      const connection = { close: vi.fn(async () => undefined), receive };
      connections.push(connection);
      return { ...connection, commit: async () => undefined };
    });
  });

  it("accepts the next start as soon as the stopped session becomes inactive", async () => {
    let resume = false;
    const onTurn = vi.fn();
    const { result } = renderHook(
      () => {
        const dictation = usePocketDictation({
          roomId: "room-1",
          tenantId: "tenant-1",
          onTurn,
        });
        // Start at the first commit that exposes the idle control, before
        // passive effects run; no wall-clock delay decides this ordering.
        useLayoutEffect(() => {
          if (resume && !dictation.active) {
            resume = false;
            dictation.start();
          }
        }, [dictation.active, dictation]);
        return dictation;
      },
      { wrapper },
    );

    await act(async () => result.current.start());
    expect(result.current.active).toBe(true);
    await act(async () =>
      connections[0]!.receive({
        kind: "speech",
        id: "first",
        text: "Buy milk",
        endOffsetMs: 900,
      }),
    );
    resume = true;
    let leftover = "";
    await act(async () => {
      leftover = await result.current.stop();
    });

    expect(leftover).toBe("Buy milk");
    expect(transport.open).toHaveBeenCalledTimes(2);
    expect(connections[0]!.close).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(true);
    expect(result.current.liveText).toBe("");
    await act(async () =>
      connections[1]!.receive({
        kind: "turn",
        id: "second",
        text: "and eggs",
        endOffsetMs: 900,
      }),
    );
    expect(onTurn).toHaveBeenCalledExactlyOnceWith("and eggs");
  });

  it("retains the session on callback rerenders and closes it once when the Room changes", async () => {
    const firstOnTurn = vi.fn();
    const nextOnTurn = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ roomId, onTurn }) =>
        usePocketDictation({ roomId, onTurn, tenantId: "tenant-1" }),
      { wrapper, initialProps: { roomId: "room-1", onTurn: firstOnTurn } },
    );
    await act(async () => result.current.start());
    rerender({ roomId: "room-1", onTurn: nextOnTurn });
    expect(transport.open).toHaveBeenCalledTimes(1);
    expect(connections[0]!.close).not.toHaveBeenCalled();
    await act(async () =>
      connections[0]!.receive({
        kind: "turn",
        id: "first",
        text: "Buy milk",
        endOffsetMs: 900,
      }),
    );
    expect(firstOnTurn).not.toHaveBeenCalled();
    expect(nextOnTurn).toHaveBeenCalledExactlyOnceWith("Buy milk");

    await act(async () => rerender({ roomId: "room-2", onTurn: nextOnTurn }));
    expect(connections[0]!.close).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(false);
    await act(async () => result.current.start());
    expect(transport.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ roomId: "room-2" }),
    );
    await act(async () => unmount());
    expect(connections[0]!.close).toHaveBeenCalledTimes(1);
    expect(connections[1]!.close).toHaveBeenCalledTimes(1);
  });
});
