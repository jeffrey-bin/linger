// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeVoicePip,
  onVoicePipClosedByHuman,
  openVoicePip,
  resetVoicePipForTest,
} from "./voice-pip";

/** A stand-in for the browser's picture-in-picture window. */
function installFakeVoicePip() {
  const frame = window.document.createElement("iframe");
  window.document.body.append(frame);
  const document = frame.contentDocument!;
  const listeners: (() => void)[] = [];
  const pipWindow = {
    document,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "pagehide") listeners.push(listener);
    },
    // A closed window is gone; the next request opens a fresh one.
    close: vi.fn(() => listeners.splice(0).forEach((listener) => listener())),
  };
  const requestWindow = vi.fn(async () => pipWindow as unknown as Window);
  Object.defineProperty(window, "documentPictureInPicture", {
    configurable: true,
    value: { requestWindow },
  });
  return { document, frame, pipWindow, requestWindow };
}

function removeFakeVoicePip() {
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
  Reflect.deleteProperty(window, "documentPictureInPicture");
  resetVoicePipForTest();
}

afterEach(() => {
  removeFakeVoicePip();
  document.head.querySelectorAll("[data-test-style]").forEach((node) => {
    node.remove();
  });
  document.documentElement.removeAttribute("data-theme");
});

describe("Voice Mode picture-in-picture window", () => {
  it("is unavailable where the browser lacks it", async () => {
    await expect(openVoicePip("voice-mode")).resolves.toBeUndefined();
  });

  it("carries the page's styles and theme, including later ones", async () => {
    const early = document.createElement("style");
    early.dataset.testStyle = "";
    early.textContent = ".early {}";
    document.head.append(early);
    document.documentElement.setAttribute("data-theme", "dark");
    const fake = installFakeVoicePip();

    await openVoicePip("voice-mode");
    expect(fake.document.documentElement.dataset.theme).toBe("dark");
    expect(fake.document.head.textContent).toContain(".early {}");

    const late = document.createElement("style");
    late.dataset.testStyle = "";
    late.textContent = ".late {}";
    document.head.append(late);
    await vi.waitFor(() =>
      expect(fake.document.head.textContent).toContain(".late {}"),
    );
  });

  it("opens one window and tells a desktop close apart from the page closing it", async () => {
    const fake = installFakeVoicePip();
    const first = await openVoicePip("voice-mode");
    await expect(openVoicePip("voice-mode")).resolves.toBe(first);
    expect(fake.requestWindow).toHaveBeenCalledOnce();
    const closedByHuman = vi.fn();
    const stop = onVoicePipClosedByHuman("voice-mode", closedByHuman);
    closeVoicePip("voice-mode");
    expect(fake.pipWindow.close).toHaveBeenCalledOnce();
    expect(closedByHuman).not.toHaveBeenCalled();

    await openVoicePip("voice-mode");
    fake.pipWindow.close();
    expect(closedByHuman).toHaveBeenCalledOnce();
    stop();
  });

  it("gives the window to one owner at a time", async () => {
    const fake = installFakeVoicePip();
    const voiceModeClosed = vi.fn();
    const stop = onVoicePipClosedByHuman("voice-mode", voiceModeClosed);
    await openVoicePip("voice-mode");
    // Recording takes the tab's one window; Voice Mode's closes, not by the Human.
    await openVoicePip("recording");
    expect(fake.pipWindow.close).toHaveBeenCalledOnce();
    expect(voiceModeClosed).not.toHaveBeenCalled();
    // Closing someone else's window does nothing.
    closeVoicePip("voice-mode");
    expect(fake.pipWindow.close).toHaveBeenCalledOnce();
    stop();
  });
});
