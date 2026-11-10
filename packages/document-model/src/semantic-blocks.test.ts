import { describe, expect, it } from "vitest";

import {
  RoomDocumentModelError,
  validateRoomDocumentSemanticBlocks,
} from "./index.js";

describe("Room Document semantic Block validation", () => {
  it("returns a deterministic immutable Block set and content hash", () => {
    const input = {
      schemaVersion: 1,
      blocks: [{ id: "stable", type: "paragraph", content: "Body" }],
    };
    const first = validateRoomDocumentSemanticBlocks(input);
    const replay = validateRoomDocumentSemanticBlocks(input);
    expect(replay).toEqual(first);
    expect(first.blocksSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.completeReferences).toEqual({
      documentAssetIds: [],
      documentThreadIds: [],
    });
    input.blocks[0]!.content = "Changed after validation";
    expect(first.blocks[0]).toMatchObject({ content: "Body" });
  });

  it("returns the complete canonical Document Asset reference set", () => {
    const result = validateRoomDocumentSemanticBlocks({
      schemaVersion: 1,
      blocks: [
        {
          id: "asset",
          type: "image",
          props: { url: "document-asset:asset_01" },
        },
      ],
    });
    expect(result.completeReferences.documentAssetIds).toEqual(["asset_01"]);
  });

  it("rejects duplicate IDs, Comment marks, and external media URLs", () => {
    for (const blocks of [
      [
        { id: "duplicate", type: "paragraph", content: "One" },
        { id: "duplicate", type: "paragraph", content: "Two" },
      ],
      [
        {
          id: "commented",
          type: "paragraph",
          content: [
            { type: "text", text: "No", styles: { comment: "thread" } },
          ],
        },
      ],
      [
        {
          id: "external",
          type: "image",
          props: { url: "https://example.test/image.png" },
        },
      ],
    ]) {
      expect(() =>
        validateRoomDocumentSemanticBlocks({ schemaVersion: 1, blocks }),
      ).toThrow(RoomDocumentModelError);
    }
  });

  it("rejects unsupported schemas and malformed Block children", () => {
    expect(() =>
      validateRoomDocumentSemanticBlocks({
        schemaVersion: 2,
        blocks: [{ id: "stable", type: "paragraph", content: "Body" }],
      }),
    ).toThrow(RoomDocumentModelError);
    expect(() =>
      validateRoomDocumentSemanticBlocks({
        schemaVersion: 1,
        blocks: [{ id: "stable", type: "paragraph", children: "invalid" }],
      }),
    ).toThrow(RoomDocumentModelError);
  });

  it.each([
    { id: "text", type: "paragraph", text: "Must not disappear" },
    { id: "props", type: "paragraph", props: { unknown: "not ignored" } },
    {
      id: "styles",
      type: "paragraph",
      content: [{ type: "text", text: "Body", styles: { unknown: true } }],
    },
    {
      id: "parent",
      type: "bulletListItem",
      content: "Parent",
      children: [{ id: "child", type: "paragraph", text: "Child" }],
    },
  ])("rejects discarded fields in $id", (block) => {
    expect(() =>
      validateRoomDocumentSemanticBlocks({ schemaVersion: 1, blocks: [block] }),
    ).toThrow(expect.objectContaining({ code: "validation_failed" }));
  });

  it("retains valid rich text, links, nested children, and empty paragraphs", () => {
    const blocks = [
      {
        id: "parent",
        type: "bulletListItem",
        content: [
          { type: "text", text: "Bold", styles: { bold: true } },
          {
            type: "link",
            href: "https://example.test/",
            content: [{ type: "text", text: "Link", styles: {} }],
          },
        ],
        children: [{ id: "child", type: "paragraph", content: "Child" }],
      },
      { id: "empty", type: "paragraph", content: "" },
    ];
    expect(
      validateRoomDocumentSemanticBlocks({ schemaVersion: 1, blocks }).blocks,
    ).toEqual(blocks);
  });
});
