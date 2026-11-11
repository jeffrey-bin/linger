import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { figureKey } from "./agent-avatar";
import { AgentAvatarPortrait } from "./agent-avatar-portrait";

const animation = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const item = {
    addEventListener: vi.fn((_name: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    currentFrame: 0,
    destroy: vi.fn(),
    firstFrame: 0,
    isPaused: true,
    play: vi.fn(() => {
      item.isPaused = false;
    }),
    playSegments: vi.fn(() => {
      item.isPaused = false;
    }),
    resetSegments: vi.fn(),
    setLoop: vi.fn(),
    /** Lottie pauses on the last frame of a segment, then fires complete. */
    complete() {
      item.isPaused = true;
      item.currentFrame = 83;
      listeners.forEach((listener) => listener());
    },
  };
  return item;
});
const loadAnimation = vi.hoisted(() => vi.fn(() => animation));
vi.mock("lottie-web/build/player/lottie_light", () => ({
  default: { loadAnimation },
}));

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
  animation.isPaused = true;
  animation.currentFrame = 0;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reducedMotion })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        layers: [{ nm: "Fixed avatar frame" }, { nm: "Static background" }],
      }),
    ),
  );
});
afterEach(() => {
  // Unmount first so a test's own teardown does not count in the next one.
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function motionReady() {
  return document.querySelector('.agent-avatar-motion[data-ready="true"]');
}

it("loads a figure's motion when it moves and frees it once it rests", async () => {
  const key = figureKey("fox");
  const view = render(<AgentAvatarPortrait avatarKey={key} />);
  expect(document.querySelector(".agent-avatar-motion")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();

  view.rerender(<AgentAvatarPortrait animate avatarKey={key} />);
  await waitFor(() => expect(motionReady()).not.toBeNull());
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("agent-avatar-motion/fox.json"),
  );
  // The tile's chosen color stays visible behind the figure.
  expect(loadAnimation).toHaveBeenCalledWith(
    expect.objectContaining({
      animationData: { layers: [{ nm: "Fixed avatar frame" }] },
    }),
  );
  // Playing starts in an effect after the ready render commits.
  await waitFor(() => expect(animation.play).toHaveBeenCalledTimes(1));
  expect(animation.setLoop).not.toHaveBeenCalledWith(true);

  // Resting while the Agent still moves keeps the motion.
  act(() => animation.complete());
  expect(motionReady()).not.toBeNull();
  expect(animation.destroy).not.toHaveBeenCalled();

  // Once nothing moves it, the motion unmounts and the still portrait shows.
  view.rerender(<AgentAvatarPortrait avatarKey={key} />);
  expect(document.querySelector(".agent-avatar-motion")).toBeNull();
  expect(animation.destroy).toHaveBeenCalledTimes(1);

  // The next move loads it again and plays.
  view.rerender(<AgentAvatarPortrait animate avatarKey={key} />);
  await waitFor(() => expect(animation.play).toHaveBeenCalledTimes(2));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(animation.setLoop).not.toHaveBeenCalledWith(true);
});

it("lets a running motion finish before it unmounts", async () => {
  const key = figureKey("fox");
  const view = render(<AgentAvatarPortrait animate avatarKey={key} />);
  await waitFor(() => expect(animation.play).toHaveBeenCalledTimes(1));

  // Leaving mid-play does not cut the motion off.
  view.rerender(<AgentAvatarPortrait avatarKey={key} />);
  expect(motionReady()).not.toBeNull();
  expect(animation.destroy).not.toHaveBeenCalled();

  act(() => animation.complete());
  expect(document.querySelector(".agent-avatar-motion")).toBeNull();
  expect(animation.destroy).toHaveBeenCalledTimes(1);
});

it("keeps the motion through a held smile and its return", async () => {
  const key = figureKey("fox");
  const view = render(<AgentAvatarPortrait avatarKey={key} hold />);
  await waitFor(() => expect(animation.playSegments).toHaveBeenCalledTimes(1));

  // Reaching the smile completes the segment but the hold keeps it.
  act(() => animation.complete());
  animation.currentFrame = 40;
  expect(motionReady()).not.toBeNull();

  // Releasing plays the return; the motion unmounts once it rests.
  view.rerender(<AgentAvatarPortrait avatarKey={key} />);
  expect(animation.playSegments).toHaveBeenLastCalledWith([40, 83], true);
  expect(motionReady()).not.toBeNull();
  act(() => animation.complete());
  expect(document.querySelector(".agent-avatar-motion")).toBeNull();
  expect(animation.destroy).toHaveBeenCalledTimes(1);
});

it("stays still when the system asks for reduced motion", async () => {
  reducedMotion = true;
  render(<AgentAvatarPortrait animate avatarKey={figureKey("fox")} />);
  await act(async () => {});
  expect(document.querySelector(".agent-avatar-motion")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
