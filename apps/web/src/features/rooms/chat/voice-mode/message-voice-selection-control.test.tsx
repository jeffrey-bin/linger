import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MessageVoiceSelectionControl } from "./message-voice-selection-control";

const context = vi.hoisted(() => ({
  enabled: true,
  voiceModeEntered: true,
  error: undefined as string | undefined,
  addSelection: vi.fn(),
}));

vi.mock("./voice-materials-context", () => ({
  useOptionalVoiceMaterials: () => (context.enabled ? context : undefined),
}));

beforeEach(() => {
  // jsdom has no layout; place every selection at a fixed rectangle.
  Element.prototype.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 800,
      left: 0,
      right: 1200,
      width: 1200,
      height: 800,
    }) as DOMRect;
  Range.prototype.getBoundingClientRect = () =>
    ({
      top: 100,
      bottom: 120,
      left: 40,
      right: 200,
      width: 160,
      height: 20,
    }) as DOMRect;
  context.enabled = true;
  context.voiceModeEntered = true;
  context.error = undefined;
  context.addSelection.mockReset().mockReturnValue(true);
  window.getSelection()?.removeAllRanges();
});

const actionName = "Add to voice";

function Timeline() {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div aria-label="Room timeline" ref={setRoot}>
        <article data-message-id="message_one" data-message-author="AnotherMe">
          <span>AnotherMe</span>
          <div className="message-row-body">
            <p>
              Ship it on <button type="button">@Friday</button> after review
            </p>
          </div>
        </article>
        <article data-message-id="message_two" data-message-author="You">
          <div className="message-row-body">
            <p>Sounds good</p>
          </div>
        </article>
      </div>
      <MessageVoiceSelectionControl root={root} />
    </>
  );
}

function select(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
}

describe("Message voice material selection", () => {
  it("adds text selected inside one Message body with its author", () => {
    render(<Timeline />);
    const paragraph = screen.getByText(/Ship it on/).closest("p")!;
    select(paragraph, 0, paragraph, paragraph.childNodes.length);
    // The action floats just below the selected text, outside the layout.
    expect(
      screen.getByRole("group", { name: "Selected message voice context" }),
    ).toHaveStyle({ top: "126px", left: "40px" });
    fireEvent.click(screen.getByRole("button", { name: actionName }));
    expect(context.addSelection).toHaveBeenCalledExactlyOnceWith({
      messageId: "message_one",
      title: "AnotherMe",
      quote: "Ship it on @Friday after review",
    });
    expect(screen.queryByRole("button", { name: actionName })).toBeNull();
  });

  it("waits for the drag to end instead of following every selection change", () => {
    render(<Timeline />);
    const paragraph = screen.getByText(/Ship it on/).closest("p")!;
    const text = paragraph.firstChild!;
    fireEvent.mouseDown(paragraph);
    for (const end of [2, 4, 7]) {
      select(text, 0, text, end);
      expect(screen.queryByRole("button", { name: actionName })).toBeNull();
    }
    fireEvent.mouseUp(document);
    fireEvent.click(screen.getByRole("button", { name: actionName }));
    expect(context.addSelection).toHaveBeenCalledExactlyOnceWith({
      messageId: "message_one",
      title: "AnotherMe",
      quote: "Ship it",
    });
  });

  it("ignores selections spanning two Messages or outside a Message body", () => {
    render(<Timeline />);
    const first = screen.getByText(/Ship it on/).firstChild!;
    const second = screen.getByText("Sounds good").firstChild!;
    select(first, 0, second, 5);
    expect(screen.queryByRole("button", { name: actionName })).toBeNull();
    const author = screen.getAllByText("AnotherMe")[0]!.firstChild!;
    select(author, 0, author, 5);
    expect(screen.queryByRole("button", { name: actionName })).toBeNull();
  });

  it("stays hidden where voice materials are unavailable", () => {
    context.enabled = false;
    render(<Timeline />);
    const paragraph = screen.getByText(/Ship it on/).closest("p")!;
    select(paragraph, 0, paragraph, paragraph.childNodes.length);
    expect(screen.queryByRole("button", { name: actionName })).toBeNull();
  });

  it("stays hidden until Voice Mode is on", () => {
    context.voiceModeEntered = false;
    render(<Timeline />);
    const paragraph = screen.getByText(/Ship it on/).closest("p")!;
    select(paragraph, 0, paragraph, paragraph.childNodes.length);
    expect(screen.queryByRole("button", { name: actionName })).toBeNull();
  });
});
