import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AuthIllustration } from "./auth-illustration";

// The portrait's Lottie has its own tests; here only whether the picture asks
// Another Me to move matters.
vi.mock("@/features/rooms/members/agent-avatar-portrait", () => ({
  AgentAvatarPortrait: ({ animate = false }: { animate?: boolean }) => (
    <span data-animate={String(animate)} data-testid="another-me" />
  ),
}));

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
  vi.useFakeTimers();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reducedMotion })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function shownNudge() {
  return (
    document.querySelector('.auth-art-nudge[data-state="shown"]')
      ?.textContent ?? null
  );
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

it("lands a nudge every four seconds and wakes Another Me for each one", () => {
  render(<AuthIllustration />);
  expect(shownNudge()).toBeNull();
  expect(document.querySelector(".auth-art-badge")).toBeNull();

  advance(3_000);
  expect(shownNudge()).toContain("I drafted the brief");
  expect(document.querySelector(".auth-art-badge")).not.toBeNull();
  expect(screen.getByTestId("another-me")).toHaveAttribute(
    "data-animate",
    "true",
  );
  advance(1_000);
  expect(screen.getByTestId("another-me")).toHaveAttribute(
    "data-animate",
    "false",
  );

  advance(3_000);
  expect(shownNudge()).toContain("Codex reviewed the code");
  advance(4_000);
  expect(shownNudge()).toContain("the deck is ready");
  // After the last nudge the day starts over.
  advance(4_000);
  expect(shownNudge()).toContain("I drafted the brief");
});

it("keeps one loop across unrelated rerenders and clears it on unmount", () => {
  const setIntervalSpy = vi.spyOn(window, "setInterval");
  const clearIntervalSpy = vi.spyOn(window, "clearInterval");
  const view = render(<AuthIllustration />);
  advance(3_000);
  view.rerender(<AuthIllustration />);
  advance(4_000);
  expect(shownNudge()).toContain("Codex reviewed the code");
  expect(setIntervalSpy).toHaveBeenCalledTimes(1);

  view.unmount();
  expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  expect(clearIntervalSpy).toHaveBeenCalledWith(
    setIntervalSpy.mock.results[0]?.value,
  );
});

it("holds the first nudge still when the system asks for reduced motion", () => {
  reducedMotion = true;
  const setIntervalSpy = vi.spyOn(window, "setInterval");
  render(<AuthIllustration />);
  expect(shownNudge()).toContain("I drafted the brief");

  advance(10_000);
  expect(shownNudge()).toContain("I drafted the brief");
  expect(setIntervalSpy).not.toHaveBeenCalled();
  expect(screen.getByTestId("another-me")).toHaveAttribute(
    "data-animate",
    "false",
  );
});
