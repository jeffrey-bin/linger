import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useRef, type CSSProperties } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceModeTextareaLayout } from "./use-voice-mode-textarea-layout";

let width = 100;
let reducedMotion = false;
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
const motionListeners = new Set<() => void>();
const observers: FakeResizeObserver[] = [];

class FakeResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  resized(nextWidth: number) {
    width = nextWidth;
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this);
  }
}

function Editor({
  text,
  active = true,
  unrelated = "",
  style,
}: {
  text: string;
  active?: boolean;
  unrelated?: string;
  style?: CSSProperties;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useVoiceModeTextareaLayout({ active, text, textareaRef });
  return (
    <div data-unrelated={unrelated}>
      <textarea
        aria-label="Voice text"
        ref={textareaRef}
        value={text}
        readOnly
        style={{
          height: "18px",
          lineHeight: "18px",
          boxSizing: "border-box",
          padding: 0,
          border: 0,
          ...style,
        }}
      />
    </div>
  );
}

function flushFrames() {
  act(() => {
    const current = [...frames.entries()];
    frames.clear();
    for (const [, callback] of current) callback(16);
  });
}

beforeEach(() => {
  width = 100;
  reducedMotion = false;
  frameId = 0;
  frames.clear();
  motionListeners.clear();
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return reducedMotion;
      },
      addEventListener: (_name: string, callback: () => void) =>
        motionListeners.add(callback),
      removeEventListener: (_name: string, callback: () => void) =>
        motionListeners.delete(callback),
    })),
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => width,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return Number.parseFloat(this.style.height) || 18;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      if (!(this instanceof HTMLTextAreaElement)) return 0;
      const measuredWidth = Number.parseFloat(this.style.width) || width;
      const horizontalPadding =
        (Number.parseFloat(this.style.paddingLeft) || 0) +
        (Number.parseFloat(this.style.paddingRight) || 0);
      const verticalPadding =
        (Number.parseFloat(this.style.paddingTop) || 0) +
        (Number.parseFloat(this.style.paddingBottom) || 0);
      const columns = Math.max(
        1,
        Math.floor((measuredWidth - horizontalPadding) / 10),
      );
      return (
        this.value
          .split("\n")
          .reduce(
            (lines, part) =>
              lines + Math.max(1, Math.ceil(part.length / columns)),
            0,
          ) *
          18 +
        verticalPadding
      );
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Voice Mode textarea layout", () => {
  it.each(["border-box", "content-box"] as const)(
    "measures the padding box and preserves outer bounds for %s",
    (boxSizing) => {
      const style: CSSProperties = {
        boxSizing,
        padding: "4px 8px",
        border: "1px solid",
      };
      const view = render(<Editor text={"x".repeat(9)} style={style} />);
      const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
      const mirror = document.querySelector(
        "[data-voice-mode-measure]",
      ) as HTMLTextAreaElement;
      expect(mirror.style.width).toBe("100px");
      expect(mirror.style.paddingLeft).toBe("8px");
      expect(mirror.style.lineHeight).toBe("18px");
      // 100px clientWidth minus 16px padding wraps 9 characters onto two lines.
      expect(textarea.style.height).toBe(
        boxSizing === "border-box" ? "46px" : "36px",
      );
      view.rerender(<Editor text={"x".repeat(100)} style={style} />);
      expect(textarea.style.height).toBe(
        boxSizing === "border-box" ? "160px" : "150px",
      );
      expect(textarea.style.overflowY).toBe("auto");
    },
  );

  it("keeps a scrolled-up reader in place across repeated partial rewrites", () => {
    const view = render(<Editor text="" />);
    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    flushFrames();
    view.rerender(<Editor text={"x".repeat(180)} />);
    textarea.scrollTop = 20;
    fireEvent.scroll(textarea);
    for (const length of [170, 185, 171, 181, 190]) {
      const corrected = "y".repeat(length);
      view.rerender(<Editor text={corrected} />);
      flushFrames();
      expect(textarea).toHaveValue(corrected);
      expect(textarea.scrollTop).toBe(20);
      expect(textarea.style.height).toBe("160px");
    }
    expect(observers).toHaveLength(1);
    expect(document.querySelectorAll("[data-voice-mode-measure]")).toHaveLength(
      1,
    );
  });

  it("measures offscreen without resetting the live height and shows ASR corrections immediately", () => {
    const view = render(<Editor text="Hi" />);
    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    const mirror = document.querySelector(
      "[data-voice-mode-measure]",
    ) as HTMLTextAreaElement;
    expect(mirror).toHaveAttribute("aria-hidden", "true");
    expect(mirror.tabIndex).toBe(-1);
    expect(mirror.style.position).toBe("fixed");
    expect(textarea.style.height).toBe("18px");
    expect(textarea.style.transition).toBe("none");
    flushFrames();
    const height = vi.spyOn(textarea.style, "height", "set");
    view.rerender(<Editor text="Long phrase!" />);
    expect(textarea.value).toBe("Long phrase!");
    expect(textarea.style.height).toBe("36px");
    expect(textarea.style.transition).toBe("height 160ms ease-out");
    expect(
      height.mock.calls.every(([value]) => value !== "auto" && value !== "0px"),
    ).toBe(true);
    view.rerender(<Editor text="Ok" />);
    expect(textarea.value).toBe("Ok");
    expect(textarea.style.height).toBe("18px");
    expect(document.querySelectorAll("[data-voice-mode-measure]")).toHaveLength(
      1,
    );
  });

  it("caps at 160px and does not pull a reader back down after scrolling up", () => {
    const view = render(<Editor text="" />);
    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    flushFrames();
    view.rerender(<Editor text={"x".repeat(100)} />);
    expect(textarea.style.height).toBe("160px");
    expect(textarea.style.overflowY).toBe("auto");
    expect(textarea.scrollTop).toBe(20);
    textarea.scrollTop = 0;
    fireEvent.scroll(textarea);
    view.rerender(<Editor text={"x".repeat(130)} />);
    flushFrames();
    expect(textarea.scrollTop).toBe(0);
    textarea.scrollTop = textarea.scrollHeight - textarea.clientHeight;
    fireEvent.scroll(textarea);
    view.rerender(<Editor text={"x".repeat(140)} />);
    flushFrames();
    expect(textarea.scrollTop).toBe(
      textarea.scrollHeight - textarea.clientHeight,
    );
  });

  it("collapses a cleared turn, resets scrolling, and recalculates wrapping on width changes", () => {
    const view = render(<Editor text={"x".repeat(100)} />);
    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    flushFrames();
    textarea.scrollTop = 0;
    fireEvent.scroll(textarea);
    view.rerender(<Editor text="" />);
    expect(textarea.style.height).toBe("18px");
    expect(textarea.scrollTop).toBe(0);
    expect(textarea.style.overflowY).toBe("hidden");
    view.rerender(<Editor text={"x".repeat(12)} />);
    act(() => observers[0]!.resized(200));
    expect(textarea.style.height).toBe("18px");
    expect(textarea.style.transition).toBe("none");
    act(() => observers[0]!.resized(60));
    expect(textarea.style.height).toBe("36px");
    expect(observers).toHaveLength(1);
  });

  it("honors reduced motion, including a preference change while recording", () => {
    reducedMotion = true;
    const view = render(<Editor text="Hi" />);
    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    flushFrames();
    view.rerender(<Editor text={"x".repeat(12)} />);
    expect(textarea.style.height).toBe("36px");
    expect(textarea.style.transition).toBe("none");
    act(() => {
      reducedMotion = false;
      for (const listener of motionListeners) listener();
    });
    flushFrames();
    view.rerender(<Editor text={"x".repeat(25)} />);
    expect(textarea.style.transition).toBe("height 160ms ease-out");
  });

  it("does not recreate observers on text/rerenders and releases mirror, listeners and frames on deactivate", () => {
    const view = render(<Editor text="before" />);
    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    view.rerender(<Editor text="after" unrelated="changed" />);
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observe).toHaveBeenCalledOnce();
    expect(observers[0]!.disconnect).not.toHaveBeenCalled();
    view.rerender(<Editor text="after" active={false} />);
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-voice-mode-measure]")).toBeNull();
    expect(motionListeners.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(textarea.style.transition).toBe("");
    expect(textarea.style.height).toBe("18px");
  });

  it("cleans each StrictMode mount and never leaves a mirror after unmount", () => {
    const view = render(
      <StrictMode>
        <Editor text="test" />
      </StrictMode>,
    );
    expect(document.querySelectorAll("[data-voice-mode-measure]")).toHaveLength(
      1,
    );
    view.unmount();
    expect(document.querySelector("[data-voice-mode-measure]")).toBeNull();
    expect(frames.size).toBe(0);
    expect(
      observers.every(
        (observer) => observer.disconnect.mock.calls.length === 1,
      ),
    ).toBe(true);
  });
});
