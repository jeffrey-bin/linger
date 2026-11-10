import { describe, expect, it } from "vitest";

import { roomDocumentBlocksAreEmpty } from "./room-document-blocks";

describe("Room Document empty state", () => {
  it("treats placeholder paragraphs and headings as an empty document", () => {
    expect(
      roomDocumentBlocksAreEmpty([
        {
          children: [],
          content: [],
          type: "heading",
        },
        {
          children: [
            {
              children: [],
              content: [{ styles: {}, text: "   ", type: "text" }],
              type: "paragraph",
            },
          ],
          content: [],
          type: "paragraph",
        },
      ]),
    ).toBe(true);
  });

  it("keeps text and non-text blocks visible in read mode", () => {
    expect(
      roomDocumentBlocksAreEmpty([
        {
          children: [],
          content: [{ styles: {}, text: "Decision", type: "text" }],
          type: "paragraph",
        },
      ]),
    ).toBe(false);
    expect(
      roomDocumentBlocksAreEmpty([
        { children: [], content: undefined, type: "image" },
      ]),
    ).toBe(false);
  });
});
