import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  applyRoomDocumentSemanticMutation,
  readRoomDocumentBlocks,
} from "./index.js";
import type { RoomDocumentSemanticOperation } from "./semantic.js";

function state() {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create({
    initialContent: [
      { id: "first", type: "paragraph", content: "Draft report" },
      { id: "second", type: "paragraph", content: "Keep this" },
      { id: "third", type: "paragraph", content: "Last" },
    ],
  });
  blocksToYXmlFragment(
    editor,
    editor.document,
    doc.getXmlFragment("prosemirror"),
  );
  editor.unmount();
  return Y.encodeStateAsUpdate(doc);
}
function edit(action: Record<string, unknown>, stateBytes = state()) {
  return applyRoomDocumentSemanticMutation({
    mutationId: "mutation_native_edit",
    schemaVersion: "blocknote-semantic-v1",
    currentTitle: "Title",
    stateBytes,
    allowedDocumentAssetIds: [],
    operations: [
      {
        kind: "edit_document",
        parser_version: "markdown-v1",
        ...action,
      } as RoomDocumentSemanticOperation,
    ],
  });
}
describe("Native document edit actions", () => {
  it("appends a plain verification marker as a paragraph", () => {
    const result = edit({
      command: "append",
      content: "SHARE086-1793889162878:EDITED",
    });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("conflict");
    expect(readRoomDocumentBlocks(result.stateBytes).at(-1)).toMatchObject({
      type: "paragraph",
      content: [{ text: "SHARE086-1793889162878:EDITED" }],
    });
  });
  it("appends after anchored comments without moving their text or relative positions", () => {
    const original = new Y.Doc();
    Y.applyUpdate(original, state());
    const text = Array.from(
      original.getXmlFragment("prosemirror").createTreeWalker(() => true),
    ).find((node) => node instanceof Y.XmlText);
    if (!(text instanceof Y.XmlText)) throw new Error("Missing text");
    text.format(0, 5, { comment: { threadId: "thread_keep", orphan: false } });
    const position = Y.createRelativePositionFromTypeIndex(text, 2);
    const originalDelta = text.toDelta();
    const before = Y.encodeStateAsUpdate(original);
    for (const operation of [
      { kind: "set_title", title: "Renamed" },
      {
        kind: "edit_document",
        parser_version: "markdown-v1",
        command: "set_title",
        title: "Renamed",
      },
    ] satisfies RoomDocumentSemanticOperation[]) {
      const renamed = applyRoomDocumentSemanticMutation({
        mutationId: "commented-title-edit",
        schemaVersion: "blocknote-semantic-v1",
        currentTitle: "Title",
        stateBytes: before,
        allowedDocumentAssetIds: [],
        operations: [operation],
      });
      if (renamed.status !== "applied") throw new Error("Title conflict");
      expect(renamed.title).toBe("Renamed");
      expect(renamed.completeReferences.documentThreadIds).toEqual([
        "thread_keep",
      ]);
      expect(readRoomDocumentBlocks(renamed.stateBytes)).toEqual(
        readRoomDocumentBlocks(before),
      );
    }
    const result = edit(
      { command: "append", content: "SHARE086-1793889162878:EDITED" },
      before,
    );
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("conflict");
    const after = new Y.Doc();
    Y.applyUpdate(after, result.stateBytes);
    const resolved = Y.createAbsolutePositionFromRelativePosition(
      position,
      after,
    );
    expect(resolved?.index).toBe(2);
    expect(resolved?.type).toBeInstanceOf(Y.XmlText);
    if (!(resolved?.type instanceof Y.XmlText)) throw new Error("Anchor lost");
    expect(resolved.type.toDelta()).toEqual(originalDelta);
    expect(result.completeReferences.documentThreadIds).toEqual([
      "thread_keep",
    ]);
    const concurrent = new Y.Doc();
    Y.applyUpdate(concurrent, before);
    const humanText = Y.createAbsolutePositionFromRelativePosition(
      position,
      concurrent,
    )?.type;
    if (!(humanText instanceof Y.XmlText)) throw new Error("Anchor lost");
    humanText.insert(0, "Human ");
    Y.applyUpdate(concurrent, result.update);
    expect(
      humanText
        .toDelta()
        .map((part: { insert: string }) => part.insert)
        .join(""),
    ).toBe("Human Draft report");
    expect(
      Y.createAbsolutePositionFromRelativePosition(position, concurrent)?.index,
    ).toBe(8);
    expect(
      readRoomDocumentBlocks(Y.encodeStateAsUpdate(concurrent)),
    ).toHaveLength(4);
    expect(readRoomDocumentBlocks(result.stateBytes)).toHaveLength(4);
    expect(() =>
      edit(
        { command: "append", content: "SHARE086-1793889162878:EDITED" },
        result.stateBytes,
      ),
    ).toThrow(/unique/);
    expect(
      edit(
        { command: "append", content: "SHARE086-1793889162878:EDITED" },
        before,
      ),
    ).toEqual(result);
    expect(() =>
      edit(
        {
          command: "block_replace",
          block_id: "first",
          content: "Removed comment",
        },
        before,
      ),
    ).toThrow(/anchored comments/);
  });
  it.each<RoomDocumentSemanticOperation>([
    {
      kind: "append_blocks",
      blocks: [{ id: "new", type: "paragraph", content: "Tail" }],
    },
    {
      kind: "insert_blocks",
      position: "after",
      stableBlockId: "third",
      blocks: [{ id: "new", type: "paragraph", content: "Tail" }],
    },
    {
      kind: "replace_blocks",
      stableBlockIds: ["third"],
      blocks: [{ id: "new", type: "paragraph", content: "Tail" }],
    },
    {
      kind: "update_block",
      stableBlockId: "third",
      block: { id: "third", type: "paragraph", content: "Changed" },
    },
    { kind: "delete_blocks", stableBlockIds: ["third"] },
  ])(
    "rejects raw $kind rather than losing an unrelated comment",
    (operation) => {
      const original = new Y.Doc();
      Y.applyUpdate(original, state());
      const text = Array.from(
        original.getXmlFragment("prosemirror").createTreeWalker(() => true),
      ).find((node) => node instanceof Y.XmlText);
      if (!(text instanceof Y.XmlText)) throw new Error("Missing text");
      text.format(0, 5, {
        comment: { threadId: "thread_keep", orphan: false },
      });
      expect(() =>
        applyRoomDocumentSemanticMutation({
          mutationId: "raw-block-comment-guard",
          schemaVersion: "blocknote-semantic-v1",
          currentTitle: "Title",
          stateBytes: Y.encodeStateAsUpdate(original),
          allowedDocumentAssetIds: [],
          operations: [operation],
        }),
      ).toThrow(/anchored comments/);
      original.destroy();
    },
  );
  it("appends Markdown with stable generated block IDs and preserves existing blocks", () => {
    const original = state();
    const result = edit(
      { command: "append", content: "## Findings\n\nEvidence" },
      original,
    );
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("conflict");
    expect(readRoomDocumentBlocks(result.stateBytes)).toMatchObject([
      { id: "first" },
      { id: "second" },
      { id: "third" },
      { type: "heading", content: [{ text: "Findings" }] },
      { content: [{ text: "Evidence" }] },
    ]);
    expect(
      edit({ command: "append", content: "## Findings\n\nEvidence" }, original),
    ).toEqual(result);
  });
  it("replaces only one exact inline match and preserves block identity", () => {
    const result = edit({
      command: "str_replace",
      pattern: "Draft",
      content: "Final",
    });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("conflict");
    expect(readRoomDocumentBlocks(result.stateBytes)[0]).toMatchObject({
      id: "first",
      content: [{ text: "Final report" }],
    });
    expect(
      edit({ command: "str_replace", pattern: "missing", content: "x" }),
    ).toEqual({ status: "conflicted", reason: "text_not_found" });
    expect(
      edit({ command: "str_replace", pattern: "t", content: "x" }),
    ).toEqual({ status: "conflicted", reason: "ambiguous_text" });
  });
  it("resolves a closed sibling range against the frozen state", () => {
    const result = edit({
      command: "block_replace",
      start_block_id: "first",
      end_block_id: "second",
      content: "Replacement",
    });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("conflict");
    expect(readRoomDocumentBlocks(result.stateBytes)).toMatchObject([
      { content: [{ text: "Replacement" }] },
      { id: "third" },
    ]);
    expect(
      edit({
        command: "block_delete",
        start_block_id: "third",
        end_block_id: "first",
      }),
    ).toEqual({ status: "conflicted", reason: "noncontiguous_blocks" });
  });
  it("rejects invalid action combinations and local media instead of rewriting resources", () => {
    expect(() =>
      edit({ command: "append", content: "", block_id: "first" }),
    ).toThrow();
    expect(() =>
      edit({ command: "append", content: "![local](./secret.png)" }),
    ).toThrow();
    expect(() =>
      edit({ command: "str_replace", pattern: "Draft\nreport", content: "x" }),
    ).toThrow();
  });

  it("replaces an image with a newly pinned Asset and keeps its display width", () => {
    const withImage = imageState();
    const result = editWithAssets(
      { command: "image_replace", block_id: "picture", asset_id: "asset_new" },
      ["asset_old", "asset_new"],
      withImage,
    );
    if (result.status !== "applied") throw new Error("conflict");
    expect(readRoomDocumentBlocks(result.stateBytes)).toMatchObject([
      { id: "first" },
      {
        type: "image",
        props: {
          url: "document-asset:asset_new",
          caption: "Card",
          previewWidth: 320,
        },
      },
      { id: "third" },
    ]);
    expect(result.completeReferences.documentAssetIds).toEqual(["asset_new"]);
    expect(() =>
      editWithAssets(
        {
          command: "image_replace",
          block_id: "picture",
          asset_id: "asset_new",
        },
        ["asset_old"],
        imageState(),
      ),
    ).toThrow();
  });

  it("inserts an image after a block and refuses a non-image replace target", () => {
    const inserted = editWithAssets(
      {
        command: "image_insert_after",
        block_id: "first",
        asset_id: "asset_new",
        caption: "Blue card",
      },
      ["asset_new"],
    );
    if (inserted.status !== "applied") throw new Error("conflict");
    expect(readRoomDocumentBlocks(inserted.stateBytes)).toMatchObject([
      { id: "first" },
      {
        type: "image",
        props: { url: "document-asset:asset_new", caption: "Blue card" },
      },
      { id: "second" },
      { id: "third" },
    ]);
    expect(
      editWithAssets(
        { command: "image_replace", block_id: "first", asset_id: "asset_new" },
        ["asset_new"],
      ),
    ).toEqual({ status: "conflicted", reason: "invalid_structure" });
    expect(
      editWithAssets(
        {
          command: "image_insert_after",
          block_id: "gone",
          asset_id: "asset_new",
        },
        ["asset_new"],
      ),
    ).toEqual({ status: "conflicted", reason: "missing_block" });
    for (const action of [
      { command: "image_replace", block_id: "picture" },
      {
        command: "image_replace",
        block_id: "picture",
        asset_id: "asset_new",
        content: "x",
      },
      { command: "image_insert_after", asset_id: "asset_new" },
      {
        command: "image_insert_after",
        block_id: "first",
        asset_id: "asset_new",
        caption: "a\nb",
      },
    ])
      expect(() => editWithAssets(action, ["asset_new"])).toThrow();
  });

  it("inserts a file block after a block", () => {
    const inserted = editWithAssets(
      {
        command: "file_insert_after",
        block_id: "first",
        asset_id: "asset_plan",
        name: "プラン.pdf",
      },
      ["asset_plan"],
    );
    if (inserted.status !== "applied") throw new Error("conflict");
    expect(readRoomDocumentBlocks(inserted.stateBytes)).toMatchObject([
      { id: "first" },
      {
        type: "file",
        props: { url: "document-asset:asset_plan", name: "プラン.pdf" },
      },
      { id: "second" },
      { id: "third" },
    ]);
    expect(inserted.completeReferences.documentAssetIds).toEqual([
      "asset_plan",
    ]);
    expect(
      editWithAssets(
        {
          command: "file_insert_after",
          block_id: "gone",
          asset_id: "asset_plan",
        },
        ["asset_plan"],
      ),
    ).toEqual({ status: "conflicted", reason: "missing_block" });
    for (const action of [
      { command: "file_insert_after", asset_id: "asset_plan" },
      {
        command: "file_insert_after",
        block_id: "first",
        asset_id: "asset_plan",
        caption: "x",
      },
      {
        command: "file_insert_after",
        block_id: "first",
        asset_id: "asset_plan",
        name: "a\nb",
      },
    ])
      expect(() => editWithAssets(action, ["asset_plan"])).toThrow();
  });
});

function editWithAssets(
  action: Record<string, unknown>,
  allowedDocumentAssetIds: string[],
  stateBytes = state(),
) {
  return applyRoomDocumentSemanticMutation({
    mutationId: "mutation_native_image",
    schemaVersion: "blocknote-semantic-v1",
    currentTitle: "Title",
    stateBytes,
    allowedDocumentAssetIds,
    operations: [
      {
        kind: "edit_document",
        parser_version: "markdown-v1",
        ...action,
      } as RoomDocumentSemanticOperation,
    ],
  });
}

function imageState() {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create({
    initialContent: [
      { id: "first", type: "paragraph", content: "Draft report" },
      {
        id: "picture",
        type: "image",
        props: {
          url: "document-asset:asset_old",
          caption: "Card",
          previewWidth: 320,
        },
      },
      { id: "third", type: "paragraph", content: "Last" },
    ],
  });
  blocksToYXmlFragment(
    editor,
    editor.document,
    doc.getXmlFragment("prosemirror"),
  );
  editor.unmount();
  return Y.encodeStateAsUpdate(doc);
}
