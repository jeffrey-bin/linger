// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  focusedCardScrollDelta,
  stackAnchoredComments,
  useAnchoredCommentLane,
} from "./room-document-comment-anchoring";
import { linkDocumentScrollPanes } from "./room-document-scroll";

describe("anchored comment lane", () => {
  it("keeps each card beside its own text when nothing overlaps", () => {
    expect(
      stackAnchoredComments(
        [
          { anchorTop: 0, height: 60 },
          { anchorTop: 200, height: 60 },
        ],
        { gap: 8 },
      ),
    ).toEqual([0, 200]);
  });

  it("pushes overlapping cards down in document order", () => {
    expect(
      stackAnchoredComments(
        [
          { anchorTop: 0, height: 60 },
          { anchorTop: 20, height: 40 },
          { anchorTop: 30, height: 40 },
        ],
        { gap: 8 },
      ),
    ).toEqual([0, 68, 116]);
  });

  it("keeps a card at the same position when its composer becomes a shorter posted card", () => {
    const before = stackAnchoredComments(
      [
        { anchorTop: 100, height: 60 },
        { anchorTop: 120, height: 160 },
        { anchorTop: 150, height: 80 },
      ],
      { focusIndex: 1 },
    );
    const after = stackAnchoredComments(
      [
        { anchorTop: 100, height: 60 },
        { anchorTop: 120, height: 80 },
        { anchorTop: 150, height: 80 },
      ],
      { focusIndex: 1 },
    );
    expect(before[1]).toBe(120);
    expect(after[1]).toBe(before[1]);
  });

  it("keeps a focused card reachable when its cluster cannot fit above it", () => {
    // Three highlights on one line: the cards are far taller than the gaps
    // between their anchors, so focusing the last one used to push the cards
    // above it to negative offsets and shift the whole lane back down.
    const cards = [
      { anchorTop: 100, height: 120 },
      { anchorTop: 110, height: 120 },
      { anchorTop: 120, height: 120 },
    ];
    const tops = stackAnchoredComments(cards, { focusIndex: 2, gap: 8 });
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(0);
    // The focused card sits exactly where the cards above it leave room, and
    // that offset does not move afterwards.
    expect(tops[2]).toBe(256);
    expect(tops).toEqual([0, 128, 256]);
    // Focusing the middle card leaves the first one flush against the top
    // rather than lifting everything away from its anchor; the card below
    // keeps the position the non-overlap pass already gave it.
    expect(stackAnchoredComments(cards, { focusIndex: 1, gap: 8 })).toEqual([
      0, 128, 356,
    ]);
  });

  it("follows the previous anchor when a thread lost its position", () => {
    expect(
      stackAnchoredComments([{ anchorTop: 120, height: 40 }, { height: 40 }], {
        gap: 8,
      }),
    ).toEqual([120, 168]);
  });
});

describe("keeping the focused card visible", () => {
  // Both panes move by this delta together, so the card stays level with its
  // text while coming into view.
  const pane = { paneHeight: 600, cardTop: 1000 };

  it("stays put when the whole card already fits", () => {
    expect(
      focusedCardScrollDelta({ ...pane, cardHeight: 200, scrollTop: 700 }),
    ).toBe(0);
  });

  it("moves down by just the hidden part of the card", () => {
    // Card occupies 300..500 of a 600 tall panel: fully visible.
    expect(
      focusedCardScrollDelta({ ...pane, cardHeight: 200, scrollTop: 700 }),
    ).toBe(0);
    // Card occupies 500..700: 100 hangs past the panel.
    expect(
      focusedCardScrollDelta({ ...pane, cardHeight: 200, scrollTop: 500 }),
    ).toBe(100);
  });

  it("moves up when the card sits above the panel", () => {
    expect(
      focusedCardScrollDelta({ ...pane, cardHeight: 200, scrollTop: 1100 }),
    ).toBe(-100);
  });

  it("shows the top of a card taller than the panel", () => {
    expect(
      focusedCardScrollDelta({ ...pane, cardHeight: 900, scrollTop: 500 }),
    ).toBe(500);
  });
});

describe("draft to posted comment positioning", () => {
  it("keeps the aligned draft position after submission clears editor selection", () => {
    const lane = document.createElement("div");
    document.body.append(lane);
    function card(id: string, pos: number, height: number) {
      const element = document.createElement("div");
      element.dataset.commentCard = id;
      element.dataset.anchorPos = String(pos);
      Object.defineProperty(element, "offsetHeight", { value: height });
      return element;
    }
    const earlier = card("earlier", 100, 60);
    const draft = card("pending", 120, 160);
    lane.append(earlier, draft);
    const laneRef = { current: lane };
    const onAnchoredChange = vi.fn();
    const resolveAnchorTop = (position: number) => position;
    const initialProps: { pendingId?: string; revision: string } = {
      pendingId: "pending",
      revision: "draft",
    };
    const view = renderHook(
      ({ pendingId, revision }: { pendingId?: string; revision: string }) =>
        useAnchoredCommentLane({
          laneRef,
          onAnchoredChange,
          resolveAnchorTop,
          pendingId,
          revision,
        }),
      { initialProps },
    );
    try {
      expect(draft.style.transform).toBe("translateY(120px)");
      expect(earlier.style.transform).toBe("translateY(52px)");
      const posted = card("posted", 120, 80);
      draft.replaceWith(posted);
      view.rerender({ pendingId: undefined, revision: "posted" });
      expect(posted.style.transform).toBe("translateY(120px)");
      expect(earlier.style.transform).toBe("translateY(52px)");
      view.rerender({ pendingId: undefined, revision: "saved" });
      expect(posted.style.transform).toBe("translateY(120px)");
    } finally {
      view.unmount();
      lane.remove();
    }
  });
});

describe("native comments scrolling", () => {
  it.each([
    { action: "scroll only", marker: undefined, expected: 180 },
    { action: "reselect the active marker", marker: "thread", expected: 0 },
    { action: "click an unrelated marker", marker: "other", expected: 180 },
    {
      action: "click an orphan marker",
      marker: "thread",
      orphan: true,
      expected: 180,
    },
    {
      action: "right-click the active marker",
      marker: "thread",
      button: 2,
      expected: 180,
    },
    {
      action: "click a reply editor marker",
      marker: "thread",
      inComments: true,
      expected: 180,
    },
  ])(
    "preserves native scrolling until explicit reselection: $action",
    async ({ marker, expected, orphan, button = 0, inComments }) => {
      const media = vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
          ({
            matches: query === "(min-width: 1024px)",
            media: query,
            onchange: null,
            addListener: () => undefined,
            removeListener: () => undefined,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            dispatchEvent: () => false,
          }) as MediaQueryList,
      );
      const documentPane = scrollingPane(2000);
      documentPane.dataset.documentScrollLayout = "true";
      const commentsPane = scrollingPane(2000);
      commentsPane.dataset.documentCommentsScroll = "true";
      const lane = document.createElement("div");
      const card = document.createElement("div");
      card.dataset.commentCard = "thread";
      card.dataset.anchorPos = "10";
      Object.defineProperty(card, "offsetHeight", { value: 80 });
      lane.append(card);
      commentsPane.append(lane);
      documentPane.append(commentsPane);
      document.body.append(documentPane);
      const rect = (top: number): DOMRect => ({
        x: 0,
        y: top,
        top,
        left: 0,
        right: 0,
        bottom: top,
        width: 0,
        height: 0,
        toJSON() {
          return {};
        },
      });
      documentPane.getBoundingClientRect = () => rect(0);
      commentsPane.getBoundingClientRect = () => rect(0);
      // The lane moves with the comments pane. A zero jsdom rect would change
      // the anchor key and force a realignment even after the scroll is recorded.
      lane.getBoundingClientRect = () => rect(-commentsPane.scrollTop);
      const resolveAnchorTop = () => 200 - documentPane.scrollTop;
      const onAnchoredChange = vi.fn();
      const laneRef = { current: lane };
      const unlink = linkDocumentScrollPanes(documentPane, commentsPane);
      const view = renderHook(() =>
        useAnchoredCommentLane({
          focusId: "thread",
          laneRef,
          onAnchoredChange,
          resolveAnchorTop,
          revision: "open",
        }),
      );
      const frames: FrameRequestCallback[] = [];
      const request = window.requestAnimationFrame;
      const cancel = window.cancelAnimationFrame;
      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      };
      window.cancelAnimationFrame = () => undefined;
      try {
        expect(commentsPane.scrollTop).toBe(0);
        commentsPane.scrollTop = 180;
        commentsPane.dispatchEvent(new Event("scroll"));
        expect(frames).toHaveLength(1);
        await act(async () => {
          for (const frame of frames.splice(0)) frame(0);
        });
        expect(commentsPane.scrollTop).toBe(180);
        if (marker) {
          const editor = document.createElement("div");
          editor.className = "bn-editor";
          const mark = document.createElement("span");
          mark.className = "bn-thread-mark";
          mark.dataset.bnThreadId = marker;
          if (orphan) mark.dataset.orphan = "true";
          const text = document.createElement("strong");
          text.textContent = "Commented text";
          mark.append(text);
          editor.append(mark);
          (inComments ? commentsPane : documentPane).prepend(editor);
          // Clicking nested text must work even though focusId never changes.
          text.dispatchEvent(
            new MouseEvent("click", { bubbles: true, button }),
          );
          await act(async () => {
            for (const frame of frames.splice(0)) frame(0);
          });
        }
        expect(commentsPane.scrollTop).toBe(expected);
        // Realignment is one-shot: subsequent native scrolling stays independent.
        commentsPane.scrollTop = 180;
        commentsPane.dispatchEvent(new Event("scroll"));
        await act(async () => {
          for (const frame of frames.splice(0)) frame(0);
        });
        expect(commentsPane.scrollTop).toBe(180);
        view.unmount();
        documentPane
          .querySelector(".bn-thread-mark strong")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(frames).toHaveLength(0);
      } finally {
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = cancel;
        view.unmount();
        unlink();
        documentPane.remove();
        media.mockRestore();
      }
    },
  );
});

function scrollingPane(max: number) {
  const element = document.createElement("div");
  let top = 0;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (next: number) => {
      top = Math.max(0, Math.min(max, next));
    },
  });
  Object.defineProperty(element, "clientHeight", { value: 400 });
  Object.defineProperty(element, "scrollHeight", { value: max + 400 });
  return element;
}
