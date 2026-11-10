import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { figureKey } from "./agent-avatar";
import { AgentAvatarPortrait } from "./agent-avatar-portrait";

const animation = vi.hoisted(() => ({
  destroy: vi.fn(),
  play: vi.fn(),
  setLoop: vi.fn(),
}));
const loadAnimation = vi.hoisted(() => vi.fn(() => animation));
vi.mock("lottie-web/build/player/lottie_light", () => ({
  default: { loadAnimation },
}));

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("loads a figure's motion on its first move and keeps it for later moves", async () => {
  const key = figureKey("fox");
  const view = render(<AgentAvatarPortrait avatarKey={key} />);
  expect(document.querySelector(".agent-avatar-motion")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();

  view.rerender(<AgentAvatarPortrait animate avatarKey={key} />);
  await waitFor(() =>
    expect(
      document.querySelector('.agent-avatar-motion[data-ready="true"]'),
    ).not.toBeNull(),
  );
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

  // The motion plays once and never loops; moving again replays it at once.
  expect(animation.setLoop).not.toHaveBeenCalledWith(true);
  view.rerender(<AgentAvatarPortrait avatarKey={key} />);
  view.rerender(<AgentAvatarPortrait animate avatarKey={key} />);
  await waitFor(() => expect(animation.play).toHaveBeenCalledTimes(2));
  expect(animation.setLoop).not.toHaveBeenCalledWith(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("stays still when the system asks for reduced motion", async () => {
  reducedMotion = true;
  render(<AgentAvatarPortrait animate avatarKey={figureKey("fox")} />);
  await act(async () => {});
  expect(document.querySelector(".agent-avatar-motion")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
