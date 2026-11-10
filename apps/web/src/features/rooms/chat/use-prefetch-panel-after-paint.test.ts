// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePrefetchPanelAfterPaint } from "./use-prefetch-panel-after-paint";

let frames: Map<number, FrameRequestCallback>;
let idle: Map<number, () => void>;
let sequence: number;
beforeEach(() => {
  frames = new Map();
  idle = new Map();
  sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
    idle.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelIdleCallback", (id: number) => idle.delete(id));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function paintFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => callbacks.forEach((callback) => callback(0)));
}

it("waits for chat readiness, a paint opportunity and idle time", () => {
  const prefetch = vi.fn();
  const hook = renderHook(
    ({ ready }) => usePrefetchPanelAfterPaint(ready, prefetch),
    { initialProps: { ready: false } },
  );
  expect(frames.size).toBe(0);
  hook.rerender({ ready: true });
  paintFrame();
  expect(idle.size).toBe(0);
  paintFrame();
  expect(prefetch).not.toHaveBeenCalled();
  act(() => [...idle.values()].forEach((callback) => callback()));
  expect(prefetch).toHaveBeenCalledTimes(1);
});

it("cancels queued warmup when the Room leaves", () => {
  const prefetch = vi.fn();
  const hook = renderHook(() => usePrefetchPanelAfterPaint(true, prefetch));
  paintFrame();
  paintFrame();
  expect(idle.size).toBe(1);
  hook.unmount();
  expect(idle.size).toBe(0);
  expect(prefetch).not.toHaveBeenCalled();
});

it("warms after paint when idle callbacks are unavailable", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestIdleCallback", undefined);
  const prefetch = vi.fn();
  renderHook(() => usePrefetchPanelAfterPaint(true, prefetch));
  paintFrame();
  paintFrame();
  expect(prefetch).not.toHaveBeenCalled();
  act(() => {
    vi.runAllTimers();
  });
  expect(prefetch).toHaveBeenCalledTimes(1);
});
