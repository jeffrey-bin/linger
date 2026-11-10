import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PocketNoteEditor,
  type PocketNoteEditorHandle,
} from "./pocket-note-editor";

describe("PocketNoteEditor", () => {
  beforeEach(() => {
    // JSDOM has no text-range layout; browser coverage exercises caret scrolling.
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
  });
  it("renders headings and maps dictation offsets to the saved Markdown", () => {
    const ref = createRef<PocketNoteEditorHandle>();
    const onChange = vi.fn();
    const value = "# Plan\n\nHi\n## Next";
    render(
      <PocketNoteEditor
        ref={ref}
        value={value}
        maxLength={20000}
        onChange={onChange}
        onFull={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Plan" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Next" }),
    ).toBeInTheDocument();
    expect(ref.current?.selectionStart()).toBe(value.length);
    for (const offset of [2, 4, 7, 9, 14, value.length]) {
      act(() => ref.current?.focusAt(offset));
      expect(ref.current?.selectionStart()).toBe(offset);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("pastes Markdown without losing blank lines or other literal syntax", () => {
    const onChange = vi.fn();
    render(
      <PocketNoteEditor
        ref={createRef()}
        value=""
        maxLength={20000}
        onChange={onChange}
        onFull={vi.fn()}
      />,
    );
    const text = "# Plan\n\n- **milk**\n";
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        getData: (type: string) =>
          type === "text/plain" ? text : "<p>Different clipboard HTML</p>",
      },
    });
    expect(
      screen.getByRole("heading", { level: 1, name: "Plan" }),
    ).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(text);
  });

  it("rejects an oversized edit while preserving the current note", () => {
    const onChange = vi.fn();
    const onFull = vi.fn();
    render(
      <PocketNoteEditor
        ref={createRef()}
        value="# Plan"
        maxLength={6}
        onChange={onChange}
        onFull={onFull}
      />,
    );
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "more" : ""),
      },
    });
    expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(onFull).toHaveBeenCalledOnce();
  });
});
