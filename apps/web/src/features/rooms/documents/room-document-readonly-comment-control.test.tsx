import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { ReadOnlySelectionCommentControl } from "./room-document-readonly-comment-control";

describe("read-only selection Comment control", () => {
  it("shows Add comment after a native same-Block text selection", async () => {
    const onStartComment = vi.fn();
    const editorRootRef = createRef<HTMLElement>();
    const anchorRef = createRef<null>();
    render(
      <section ref={editorRootRef}>
        <div className="bn-block" data-id="block_1">
          <p>Review this sentence</p>
        </div>
        <ReadOnlySelectionCommentControl
          anchorRef={anchorRef}
          canComment
          editable={false}
          editorRootRef={editorRootRef}
          onStartComment={onStartComment}
        />
      </section>,
    );
    const text = screen.getByText("Review this sentence").firstChild!;
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 11);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(screen.getByText("Review this sentence"));

    const action = await screen.findByRole("button", {
      name: "Add comment to selected text",
    });
    expect(action).toBeVisible();
    fireEvent.click(action);
    expect(onStartComment).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(action).toHaveTextContent("");
    expect(anchorRef.current).toMatchObject({
      block_id: "block_1",
      quoted_text: "this",
    });
    expect(
      screen.getByRole("button", { name: "Add comment to selected text" })
        .parentElement,
    ).toHaveClass("fixed");
  });

  it("defers to the BlockNote formatting toolbar Comment action", async () => {
    const editorRootRef = createRef<HTMLElement>();
    const anchorRef = createRef<null>();
    render(
      <section ref={editorRootRef}>
        <div className="bn-block" data-id="block_1">
          <p>Review this sentence</p>
        </div>
        <button aria-label="Add comment" data-test="addcomment" type="button" />
        <ReadOnlySelectionCommentControl
          anchorRef={anchorRef}
          canComment
          editable={false}
          editorRootRef={editorRootRef}
          onStartComment={vi.fn()}
        />
      </section>,
    );
    const text = screen.getByText("Review this sentence").firstChild!;
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 11);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(screen.getByText("Review this sentence"));

    expect(
      await screen.findByRole("button", { name: "Add comment" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Add comment to selected text" }),
    ).not.toBeInTheDocument();
    expect(anchorRef.current).toMatchObject({ quoted_text: "this" });
  });

  it("does not offer a selection comment without Comment capability", () => {
    const editorRootRef = createRef<HTMLElement>();
    const anchorRef = createRef<null>();
    render(
      <section ref={editorRootRef}>
        <div className="bn-block" data-id="block_1">
          <p>Read-only sentence</p>
        </div>
        <ReadOnlySelectionCommentControl
          anchorRef={anchorRef}
          canComment={false}
          editable={false}
          editorRootRef={editorRootRef}
          onStartComment={vi.fn()}
        />
      </section>,
    );
    const text = screen.getByText("Read-only sentence").firstChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(screen.getByText("Read-only sentence"));

    expect(
      screen.queryByRole("button", { name: "Add comment to selected text" }),
    ).not.toBeInTheDocument();
    expect(anchorRef.current).toBeNull();
  });
});
