import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRoomRenderTiming } from "./room-render-timing";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("observes committed DOM, frame opportunities and transitions without logging content or unmount as stopped", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const log = vi
    .spyOn(console, "debug")
    .mockImplementation((_event, fields) => {
      expect(screen.getByTestId("content")).toHaveTextContent(
        "private last character",
      );
      expect(screen.queryByRole("status") !== null).toBe(
        fields.result === "working",
      );
    });
  function Surface({ working }: { working: boolean }) {
    useRoomRenderTiming("dock", {
      result: working ? "working" : "stopped",
      runIds: working ? ["run-1"] : [],
      runStatusIds: working ? ["run-status-1"] : [],
    });
    return (
      <div>
        <span data-testid="content">private last character</span>
        {working && <span role="status">Working</span>}
      </div>
    );
  }
  const view = render(<Surface working />);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]?.[1]).toMatchObject({
    phase: "dom_committed",
    result: "working",
    runIds: ["run-1"],
    runStatusIds: ["run-status-1"],
    observedAtUnixMs: expect.any(Number),
    observedAtMonotonicMs: expect.any(Number),
  });
  view.rerender(<Surface working />);
  expect(log).toHaveBeenCalledTimes(1);
  for (let frame = 0; frame < 2; frame++) {
    const callbacks = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of callbacks) callback(0);
    });
  }
  expect(log.mock.calls[1]?.[1]).toMatchObject({
    phase: "after_animation_frames",
    result: "working",
  });
  view.rerender(<Surface working={false} />);
  expect(log.mock.calls[2]?.[1]).toMatchObject({
    phase: "dom_committed",
    result: "stopped",
    previous: { runIds: ["run-1"], runStatusIds: ["run-status-1"] },
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain(
    "private last character",
  );
  view.unmount();
  expect(log).toHaveBeenCalledTimes(3);
  expect(frames.size).toBe(0);
});

it("does no frame work when diagnostics are off", async () => {
  const { setRoomDiagnosticsEnabledForTest } =
    await import("@/lib/room-diagnostics");
  setRoomDiagnosticsEnabledForTest(false);
  const requestFrame = vi.fn(() => 1);
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  const log = vi.spyOn(console, "debug").mockImplementation(() => {});
  function Surface() {
    useRoomRenderTiming("message", { result: "rendered", messageId: "m-1" });
    return null;
  }
  try {
    render(<Surface />);
    expect(requestFrame).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  } finally {
    setRoomDiagnosticsEnabledForTest(true);
  }
});
