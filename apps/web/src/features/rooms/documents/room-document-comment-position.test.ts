import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it } from "vitest";

import { roomDocumentCommentSchema } from "./room-document-comment-schema";
import { resolveCommentAnchorPosition } from "./room-document-comment-position";

const editor = BlockNoteEditor.create({
  schema: roomDocumentCommentSchema,
  initialContent: [
    {
      id: "block",
      type: "paragraph",
      content: [
        { type: "text", text: "first repeated then ", styles: {} },
        { type: "text", text: "repeated", styles: { bold: true } },
        { type: "text", text: " last", styles: {} },
      ],
    },
  ],
});
const doc = editor.prosemirrorState.doc;

describe("comment anchor presentation positions", () => {
  it("resolves a quote across inline styles", () => {
    const anchor = {
      block_id: "block",
      quoted_text: "then repeated",
      context_before: "",
      context_after: "",
    };
    const result = resolveCommentAnchorPosition(doc, anchor)!;
    expect(doc.textBetween(result.from, result.to)).toBe("then repeated");
  });
  it("uses context to distinguish two references in one paragraph", () => {
    const result = resolveCommentAnchorPosition(doc, {
      block_id: "block",
      quoted_text: "repeated",
      context_before: "first repeated then ",
      context_after: " last",
    })!;
    expect(doc.textBetween(0, result.from)).toBe("first repeated then ");
  });
  it("does not invent a location for missing or ambiguous quotes", () => {
    for (const quoted_text of ["missing", "repeated"]) {
      expect(
        resolveCommentAnchorPosition(doc, {
          block_id: "block",
          quoted_text,
          context_before: "",
          context_after: "",
        }),
      ).toBeUndefined();
    }
  });
});
