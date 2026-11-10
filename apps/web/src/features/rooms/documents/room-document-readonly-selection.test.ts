// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { readOnlyDocumentCommentAnchor } from "./room-document-readonly-selection";

describe("read-only Document Comment selection", () => {
  it("captures one Block selection with deterministic Document context", () => {
    document.body.innerHTML = `<section id="editor">
      <div class="bn-block" data-id="block_1"><p>Prelude</p></div>
      <div class="bn-block" data-id="block_2"><p>Review this now</p></div>
    </section>`;
    const editor = document.querySelector<HTMLElement>("#editor")!;
    const text = editor.querySelectorAll("p")[1]!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 11);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(readOnlyDocumentCommentAnchor(selection, editor)).toEqual({
      block_id: "block_2",
      context_after: " now",
      context_before: "Prelude\nReview ",
      quoted_text: "this",
    });
  });

  it("rejects collapsed and cross-Block selections", () => {
    document.body.innerHTML = `<section id="editor">
      <div class="bn-block" data-id="block_1">First</div>
      <div class="bn-block" data-id="block_2">Second</div>
    </section>`;
    const editor = document.querySelector<HTMLElement>("#editor")!;
    const blocks = editor.querySelectorAll(".bn-block");
    const range = document.createRange();
    range.setStart(blocks[0]!.firstChild!, 1);
    range.setEnd(blocks[1]!.firstChild!, 2);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(readOnlyDocumentCommentAnchor(selection, editor)).toBeNull();

    selection.collapse(blocks[0]!.firstChild, 1);
    expect(readOnlyDocumentCommentAnchor(selection, editor)).toBeNull();
  });
});
