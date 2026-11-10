import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { DocumentVersionSelectionCommentControl } from "./document-version-selection-comment-control";

describe("Version Document selection Comment control", () => {
  it("offers a Comment action for selected preview text", () => {
    const rootRef = createRef<HTMLElement>();
    const onComment = vi.fn();
    render(
      <section ref={rootRef}>
        <article data-document-version-preview>
          <p>Review this sentence</p>
        </article>
        <DocumentVersionSelectionCommentControl
          enabled
          onComment={onComment}
          rootRef={rootRef}
        />
      </section>,
    );
    selectText(screen.getByText("Review this sentence"), 7, 11);

    fireEvent.mouseUp(screen.getByText("Review this sentence"));
    const action = screen.getByRole("button", {
      name: "Add comment to selected text",
    });
    expect(action).toHaveTextContent("");
    fireEvent.click(action);

    expect(onComment).toHaveBeenCalledWith("this");
  });

  it("does not offer a Comment action without Comment capability", () => {
    const rootRef = createRef<HTMLElement>();
    render(
      <section ref={rootRef}>
        <article data-document-version-preview>
          <p>Read-only sentence</p>
        </article>
        <DocumentVersionSelectionCommentControl
          enabled={false}
          onComment={vi.fn()}
          rootRef={rootRef}
        />
      </section>,
    );
    selectText(screen.getByText("Read-only sentence"), 0, 9);

    fireEvent.mouseUp(screen.getByText("Read-only sentence"));

    expect(
      screen.queryByRole("button", { name: "Add comment to selected text" }),
    ).not.toBeInTheDocument();
  });
});

function selectText(element: HTMLElement, start: number, end: number) {
  const text = element.firstChild!;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}
