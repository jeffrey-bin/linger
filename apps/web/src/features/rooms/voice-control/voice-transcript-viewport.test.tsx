import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceTranscriptViewport } from "./voice-transcript-viewport";

afterEach(() => {
  vi.unstubAllGlobals();
});

function observeResizes() {
  const observers: Observer[] = [];
  class Observer implements ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    constructor(private callback: ResizeObserverCallback) {
      observers.push(this);
    }
    resize() {
      act(() => this.callback([], this));
    }
  }
  vi.stubGlobal("ResizeObserver", Observer);
  return observers;
}

describe("VoiceTranscriptViewport", () => {
  it("reveals recovery once even while reading history, then preserves subsequent user scrolling", () => {
    const observers = observeResizes();
    const view = render(
      <VoiceTranscriptViewport>First sentence</VoiceTranscriptViewport>,
    );
    const viewport = screen.getByLabelText("Transcript scroll area");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    fireEvent.wheel(viewport, { deltaY: -100 });
    viewport.scrollTop = 100;
    view.rerender(
      <VoiceTranscriptViewport revealLatestKey="capture:recovering">
        Recording saved
      </VoiceTranscriptViewport>,
    );
    expect(viewport.scrollTop).toBe(1000);
    expect(
      screen.queryByRole("button", { name: "Follow latest transcript" }),
    ).toBeNull();
    fireEvent.wheel(viewport, { deltaY: -100 });
    viewport.scrollTop = 100;
    view.rerender(
      <VoiceTranscriptViewport revealLatestKey="capture:recovering">
        Backfill progress updated
      </VoiceTranscriptViewport>,
    );
    observers[0]!.resize();
    expect(viewport.scrollTop).toBe(100);
    view.rerender(
      <VoiceTranscriptViewport revealLatestKey="capture:failed">
        Backfill failed
      </VoiceTranscriptViewport>,
    );
    expect(viewport.scrollTop).toBe(1000);
    expect(observers).toHaveLength(1);
  });

  it("keeps history at the top when native scrolling precedes the passive wheel callback", () => {
    const observers = observeResizes();
    const view = render(
      <VoiceTranscriptViewport>First sentence</VoiceTranscriptViewport>,
    );
    const viewport = screen.getByLabelText("Transcript scroll area");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 223 },
    });
    observers[0]!.resize();
    // Chrome can reach the top before delivering a passive wheel callback.
    viewport.scrollTop = 0;
    fireEvent.wheel(viewport, { deltaY: -600 });
    fireEvent.scroll(viewport);
    observers[0]!.resize();
    view.rerender(
      <VoiceTranscriptViewport>Next sentence</VoiceTranscriptViewport>,
    );
    expect(viewport.scrollTop).toBe(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Follow latest transcript" }),
    );
    expect(viewport.scrollTop).toBe(400);
  });

  it("owns one resize subscription through text updates and cleans up when Capture changes", () => {
    const observers = observeResizes();
    const view = render(
      <VoiceTranscriptViewport key="first">
        First sentence
      </VoiceTranscriptViewport>,
    );
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observe).toHaveBeenCalledTimes(2);
    view.rerender(
      <VoiceTranscriptViewport key="first">
        Next sentence
      </VoiceTranscriptViewport>,
    );
    expect(observers).toHaveLength(1);
    expect(observers[0]!.disconnect).not.toHaveBeenCalled();
    view.rerender(
      <VoiceTranscriptViewport key="next">
        New recording
      </VoiceTranscriptViewport>,
    );
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(observers).toHaveLength(2);
    view.unmount();
    expect(observers[1]!.disconnect).toHaveBeenCalledOnce();
  });

  it.each(["keyboard", "pointer", "touch"])(
    "only pauses for %s history reading and resumes explicitly",
    (input) => {
      const observers = observeResizes();
      const view = render(
        <VoiceTranscriptViewport>First sentence</VoiceTranscriptViewport>,
      );
      const viewport = screen.getByLabelText("Transcript scroll area");
      Object.defineProperties(viewport, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 200 },
      });
      // A programmatic/browser scroll alone does not change the user's intent.
      viewport.scrollTop = 600;
      fireEvent.scroll(viewport);
      expect(viewport.scrollTop).toBe(1000);
      expect(
        screen.queryByRole("button", { name: "Follow latest transcript" }),
      ).toBeNull();
      if (input === "keyboard") fireEvent.keyDown(viewport, { key: "PageUp" });
      else {
        fireEvent.pointerDown(viewport);
        if (input === "touch") {
          const cancelled = new Event("pointercancel", { bubbles: true });
          Object.defineProperty(cancelled, "pointerType", { value: "touch" });
          fireEvent(viewport, cancelled);
        }
      }
      viewport.scrollTop = 760;
      fireEvent.scroll(viewport);
      fireEvent.pointerUp(window);
      observers[0]!.resize();
      view.rerender(
        <VoiceTranscriptViewport>New sentence</VoiceTranscriptViewport>,
      );
      expect(viewport.scrollTop).toBe(760);
      fireEvent.click(
        screen.getByRole("button", { name: "Follow latest transcript" }),
      );
      expect(viewport.scrollTop).toBe(1000);
      viewport.scrollTop = 700;
      observers[0]!.resize();
      expect(viewport.scrollTop).toBe(1000);
    },
  );
});
