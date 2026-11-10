// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  independentScrollPosition,
  linkDocumentScrollPanes,
  scrollDocumentPaneIndependently,
  useLinkedDocumentScroll,
} from "./room-document-scroll";

function pane(max: number) {
  const element = document.createElement("div");
  let top = 0;
  Object.defineProperty(element, "scrollTop", {
    get: () => top,
    set: (next: number) => {
      top = Math.max(0, Math.min(max, next));
    },
  });
  return element;
}

function wheel(element: HTMLElement, deltaY: number) {
  element.dispatchEvent(new WheelEvent("wheel", { deltaY, cancelable: true }));
}

describe("linked document and comment scrolling", () => {
  it("links wheel movement while letting comments pass either document edge", () => {
    const documentPane = pane(100);
    const commentsPane = pane(800);
    const cleanup = linkDocumentScrollPanes(documentPane, commentsPane);
    wheel(commentsPane, 300);
    expect(documentPane.scrollTop).toBe(100);
    expect(commentsPane.scrollTop).toBe(300);
    documentPane.dispatchEvent(new Event("scroll"));
    expect(commentsPane.scrollTop).toBe(300);
    wheel(documentPane, -150);
    expect(documentPane.scrollTop).toBe(0);
    expect(commentsPane.scrollTop).toBe(150);
    wheel(documentPane, -50);
    expect(commentsPane.scrollTop).toBe(100);
    cleanup();
  });

  it("allows independent comment positioning and resumes relative document scrolling", () => {
    const documentPane = pane(500);
    const commentsPane = pane(1000);
    const cleanup = linkDocumentScrollPanes(documentPane, commentsPane);
    scrollDocumentPaneIndependently(commentsPane, 600);
    commentsPane.dispatchEvent(new Event("scroll"));
    expect(documentPane.scrollTop).toBe(0);
    commentsPane.scrollTop = 650;
    commentsPane.dispatchEvent(new Event("scroll"));
    expect(documentPane.scrollTop).toBe(0);
    documentPane.scrollTop = 50;
    documentPane.dispatchEvent(new Event("scroll"));
    expect(commentsPane.scrollTop).toBe(700);
    scrollDocumentPaneIndependently(documentPane, 200);
    documentPane.dispatchEvent(new Event("scroll"));
    expect(commentsPane.scrollTop).toBe(700);
    documentPane.scrollTop = 220;
    documentPane.dispatchEvent(new Event("scroll"));
    expect(commentsPane.scrollTop).toBe(720);
    cleanup();
    wheel(documentPane, 50);
    expect(commentsPane.scrollTop).toBe(720);
  });

  it("links wheel over a reply that cannot scroll, but lets an overflowing editor consume it", () => {
    const documentPane = pane(500);
    const commentsPane = pane(1000);
    const reply = document.createElement("textarea");
    commentsPane.append(reply);
    const cleanup = linkDocumentScrollPanes(documentPane, commentsPane);
    reply.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 80, bubbles: true, cancelable: true }),
    );
    expect(documentPane.scrollTop).toBe(80);
    expect(commentsPane.scrollTop).toBe(80);
    Object.defineProperties(reply, {
      scrollHeight: { value: 200 },
      clientHeight: { value: 40 },
    });
    reply.style.overflowY = "auto";
    reply.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 50, bubbles: true, cancelable: true }),
    );
    expect(documentPane.scrollTop).toBe(80);
    reply.scrollTop = 160;
    reply.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 50, bubbles: true, cancelable: true }),
    );
    expect(documentPane.scrollTop).toBe(130);
    expect(commentsPane.scrollTop).toBe(130);
    cleanup();
  });

  it("records a native comments scroll and keeps that offset when the document moves", () => {
    const documentPane = pane(500);
    const commentsPane = pane(1000);
    const cleanup = linkDocumentScrollPanes(documentPane, commentsPane);
    commentsPane.scrollTop = 180;
    commentsPane.dispatchEvent(new Event("scroll"));
    expect(independentScrollPosition(commentsPane)).toBe(180);
    documentPane.scrollTop = 40;
    documentPane.dispatchEvent(new Event("scroll"));
    expect(commentsPane.scrollTop).toBe(220);
    expect(independentScrollPosition(commentsPane)).toBe(220);
    cleanup();
  });

  it("preserves zoom and nested picker scrolling", () => {
    const documentPane = pane(500);
    const commentsPane = pane(1000);
    const cleanup = linkDocumentScrollPanes(documentPane, commentsPane);
    const menu = document.createElement("div");
    menu.className = "message-mention-menu";
    commentsPane.append(menu);
    const zoom = new WheelEvent("wheel", {
      deltaY: 100,
      ctrlKey: true,
      cancelable: true,
    });
    documentPane.dispatchEvent(zoom);
    menu.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
    expect(zoom.defaultPrevented).toBe(false);
    expect(documentPane.scrollTop).toBe(0);
    expect(commentsPane.scrollTop).toBe(0);
    cleanup();
  });
});

describe("responsive document scroll ownership", () => {
  it("rebinds the actual pane while preserving the same Comments node", () => {
    let desktop = true;
    const media = vi
      .spyOn(window, "matchMedia")
      .mockImplementation((query) => ({
        matches: desktop,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }));
    const outer = pane(4000);
    const inner = pane(4000);
    const comments = pane(4000);
    inner.dataset.documentScrollContainer = "true";
    comments.dataset.documentCommentsScroll = "true";
    outer.append(inner, comments);
    document.body.append(outer);
    outer.scrollTop = 1965;
    inner.scrollTop = 80;
    const added = vi.spyOn(outer, "addEventListener");
    const removed = vi.spyOn(outer, "removeEventListener");
    const layoutRef = { current: outer };
    const view = renderHook(() => useLinkedDocumentScroll(layoutRef));
    try {
      expect(comments.scrollTop).toBe(1965);
      scrollDocumentPaneIndependently(comments, 2682);
      view.rerender();
      expect(added).toHaveBeenCalledTimes(2);
      expect(removed).not.toHaveBeenCalled();
      act(() => {
        desktop = false;
        // Responsive CSS clamps the old outer pane before its scroll event.
        outer.scrollTop = 0;
        window.dispatchEvent(new Event("resize"));
      });
      expect(comments.scrollTop).toBe(2682);
      outer.dispatchEvent(new Event("scroll"));
      expect(comments.scrollTop).toBe(2682);
      expect(removed).toHaveBeenCalledTimes(2);
      inner.scrollTop = 120;
      inner.dispatchEvent(new Event("scroll"));
      expect(comments.scrollTop).toBe(2722);
      wheel(comments, 60);
      expect(inner.scrollTop).toBe(180);
      expect(outer.scrollTop).toBe(0);
      expect(comments.scrollTop).toBe(2782);
      act(() => {
        desktop = true;
        outer.scrollTop = 1965;
        window.dispatchEvent(new Event("resize"));
      });
      expect(comments.scrollTop).toBe(2782);
      inner.scrollTop = 200;
      inner.dispatchEvent(new Event("scroll"));
      expect(comments.scrollTop).toBe(2782);
      outer.scrollTop = 2015;
      outer.dispatchEvent(new Event("scroll"));
      expect(comments.scrollTop).toBe(2832);
      view.unmount();
      expect(removed).toHaveBeenCalledTimes(4);
      window.dispatchEvent(new Event("resize"));
      wheel(comments, 60);
      expect(comments.scrollTop).toBe(2832);
      expect(outer.scrollTop).toBe(2015);
    } finally {
      view.unmount();
      outer.remove();
      media.mockRestore();
      added.mockRestore();
      removed.mockRestore();
    }
  });
});
