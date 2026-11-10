import { BlockNoteEditor } from "@blocknote/core";
import type { PartialBlock } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  fingerprintRoomDocumentState,
  inspectRoomDocumentState,
  exportRoomDocumentRevision,
  applyRoomDocumentSemanticMutation,
  readRoomDocumentBlocks,
  RoomDocumentModelError,
} from "./index.js";

describe("Room Document semantic mutation model", () => {
  it("round-trips native HTML with stable blocks and keeps the title", async () => {
    const state = stateWithBlocks([
      { id: "first", type: "heading", content: "Original" },
      { id: "second", type: "paragraph", content: "Retained" },
    ]);
    const exported = await exportRoomDocumentRevision({
      revisionId: "revision_test",
      schemaVersion: 1,
      state: {
        stateBytes: state,
        bytesSha256: stateDigest(state),
        stateVector: Y.encodeStateVectorFromUpdate(state),
        stateHash: stateDigest(state),
        stateHashVersion: 1,
        completeReferences: inspectRoomDocumentState(state).completeReferences,
        warnings: [],
      },
      assetManifest: [],
      format: "html",
    });
    const html = new TextDecoder()
      .decode(exported.bytes)
      .replace("Original", "Edited");
    const input = {
      mutationId: "replacement-1",
      schemaVersion: "blocknote-semantic-v1" as const,
      currentTitle: "Keep title",
      stateBytes: state,
      allowedDocumentAssetIds: [],
      operations: [{ kind: "replace_body_html" as const, html }],
    };
    const result = applyRoomDocumentSemanticMutation(input);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("conflict");
    expect(result.title).toBe("Keep title");
    expect(readRoomDocumentBlocks(result.stateBytes)).toMatchObject([
      { id: "first", type: "heading", content: [{ text: "Edited" }] },
      { id: "second", content: [{ text: "Retained" }] },
    ]);
    expect(applyRoomDocumentSemanticMutation(input)).toEqual(result);
    const invalid = document.createElement("div");
    invalid.innerHTML = html;
    invalid.querySelector("[data-id=second]")!.setAttribute("data-id", "first");
    expect(() =>
      applyRoomDocumentSemanticMutation({
        ...input,
        operations: [{ kind: "replace_body_html", html: invalid.innerHTML }],
      }),
    ).toThrow();
    expect(() =>
      applyRoomDocumentSemanticMutation({
        ...input,
        operations: [{ kind: "replace_body_html", html: "<p>No IDs</p>" }],
      }),
    ).toThrow();
  });
  it("preserves image references and nested lists, rejecting unsupported HTML and comment anchors", async () => {
    const state = stateWithBlocks([
      {
        id: "image",
        type: "image",
        props: { url: "document-asset:asset_image", caption: "Chart" },
      },
      {
        id: "list",
        type: "bulletListItem",
        content: "Parent",
        children: [{ id: "child", type: "bulletListItem", content: "Child" }],
      },
    ]);
    const exported = await exportRoomDocumentRevision({
      revisionId: "revision_image",
      schemaVersion: 1,
      state: {
        stateBytes: state,
        bytesSha256: stateDigest(state),
        stateVector: Y.encodeStateVectorFromUpdate(state),
        stateHash: stateDigest(state),
        stateHashVersion: 1,
        completeReferences: inspectRoomDocumentState(state).completeReferences,
        warnings: [],
      },
      assetManifest: [
        {
          id: "asset_image",
          mediaType: "image/png",
          sizeBytes: 1,
          sha256: "a".repeat(64),
          title: "Chart",
        },
      ],
      format: "html",
    });
    const html = new TextDecoder().decode(exported.bytes);
    const input = {
      mutationId: "replace-image",
      schemaVersion: "blocknote-semantic-v1" as const,
      currentTitle: "Title",
      stateBytes: state,
      allowedDocumentAssetIds: ["asset_image"],
      operations: [
        {
          kind: "replace_body_html" as const,
          html: html.replace("Parent", "Edited parent"),
        },
      ],
    };
    const result = applyRoomDocumentSemanticMutation(input);
    if (result.status !== "applied") throw new Error("conflict");
    expect(result.completeReferences.documentAssetIds).toEqual(["asset_image"]);
    expect(readRoomDocumentBlocks(result.stateBytes)[1]).toMatchObject({
      id: "list",
      content: [{ text: "Edited parent" }],
      children: [{ id: "child", content: [{ text: "Child" }] }],
    });
    expect(() =>
      applyRoomDocumentSemanticMutation({
        ...input,
        allowedDocumentAssetIds: [],
      }),
    ).toThrow();
    expect(() =>
      applyRoomDocumentSemanticMutation({
        ...input,
        operations: [
          { kind: "replace_body_html", html: html + "<p>Untracked text</p>" },
        ],
      }),
    ).toThrow();
    expect(() =>
      applyRoomDocumentSemanticMutation({
        ...input,
        stateBytes: stateWithCommentRanges("Commented", [
          { offset: 0, length: 3, threadId: "thread_existing" },
        ]),
      }),
    ).toThrow(/comment/);
  });

  it("applies stable block operations deterministically and returns the complete result", () => {
    const state = stateWithBlocks([
      { id: "before", type: "paragraph", content: "Before" },
      { id: "target", type: "paragraph", content: "Old" },
      { id: "after", type: "paragraph", content: "After" },
    ]);
    const input: Parameters<typeof applyRoomDocumentSemanticMutation>[0] = {
      mutationId: "document_semantic_mutation_01",
      schemaVersion: "blocknote-semantic-v1" as const,
      currentTitle: "Original title",
      stateBytes: state,
      allowedDocumentAssetIds: [] as string[],
      operations: [
        { kind: "set_title" as const, title: "Agent title" },
        {
          kind: "insert_blocks" as const,
          position: "after" as const,
          stableBlockId: "before",
          blocks: [{ id: "inserted", type: "paragraph", content: "Inserted" }],
        },
        {
          kind: "update_block" as const,
          stableBlockId: "target",
          block: {
            id: "target",
            type: "heading",
            props: { level: 2 as const },
            content: "Updated",
          },
        },
        { kind: "delete_blocks" as const, stableBlockIds: ["after"] },
      ],
    };

    const first = applyRoomDocumentSemanticMutation(input);
    const replayed = applyRoomDocumentSemanticMutation(input);
    expect(first).toEqual(replayed);
    expect(first.status).toBe("applied");
    if (first.status !== "applied")
      throw new Error("expected applied mutation");
    expect(first.title).toBe("Agent title");
    expect(first.updateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.stateBytesSha256).toBe(first.stateHash);
    expect(first.completeReferences).toEqual({
      documentAssetIds: [],
      documentThreadIds: [],
    });

    const applied = new Y.Doc({ gc: true });
    Y.applyUpdate(applied, state);
    Y.applyUpdate(applied, first.update);
    expect(
      readRoomDocumentBlocks(Y.encodeStateAsUpdate(applied)),
    ).toMatchObject([
      { id: "before", content: [{ text: "Before" }] },
      { id: "inserted", content: [{ text: "Inserted" }] },
      { id: "target", type: "heading", content: [{ text: "Updated" }] },
    ]);
    expect(Y.encodeStateVector(applied)).toEqual(first.endStateVector);
  });

  it("conflicts on missing or structurally ambiguous stable block targets", () => {
    const state = stateWithBlocks([
      { id: "one", type: "paragraph", content: "One" },
      { id: "two", type: "paragraph", content: "Two" },
      { id: "three", type: "paragraph", content: "Three" },
    ]);
    const base = {
      mutationId: "document_semantic_mutation_conflict",
      schemaVersion: "blocknote-semantic-v1" as const,
      currentTitle: "Title",
      stateBytes: state,
      allowedDocumentAssetIds: [] as string[],
    };
    expect(
      applyRoomDocumentSemanticMutation({
        ...base,
        operations: [
          {
            kind: "update_block",
            stableBlockId: "missing",
            block: { id: "missing", type: "paragraph", content: "No" },
          },
        ],
      }),
    ).toEqual({ status: "conflicted", reason: "missing_block" });
    expect(
      applyRoomDocumentSemanticMutation({
        ...base,
        operations: [
          {
            kind: "replace_blocks",
            stableBlockIds: ["one", "three"],
            blocks: [{ id: "replacement", type: "paragraph", content: "No" }],
          },
        ],
      }),
    ).toEqual({ status: "conflicted", reason: "noncontiguous_blocks" });
  });

  it("does not rewrite BlockNote state for a title-only mutation", () => {
    const state = stateWithBlocks([
      { id: "one", type: "paragraph", content: "Body" },
    ]);
    const result = applyRoomDocumentSemanticMutation({
      mutationId: "document_semantic_mutation_title",
      schemaVersion: "blocknote-semantic-v1",
      currentTitle: "Before",
      stateBytes: state,
      allowedDocumentAssetIds: [],
      operations: [{ kind: "set_title", title: "After" }],
    });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("expected title mutation");
    expect(result.title).toBe("After");
    expect(result.update).toHaveLength(0);
    expect(result.stateBytes).toEqual(state);
  });

  it("replaces exactly one attached Comment selection and preserves its mark", () => {
    const state = stateWithCommentRanges("Before old after", [
      { offset: 7, length: 3, threadId: "thread_1" },
    ]);
    const result = applyRoomDocumentSemanticMutation({
      mutationId: "document_comment_replacement_1",
      schemaVersion: "blocknote-semantic-v1",
      currentTitle: "Title",
      stateBytes: state,
      allowedDocumentAssetIds: [],
      operations: [
        {
          kind: "replace_comment_text",
          threadId: "thread_1",
          replacement: "precise text",
        },
      ],
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") {
      throw new Error("expected applied Comment replacement");
    }
    expect(result.completeReferences.documentThreadIds).toEqual(["thread_1"]);
    const applied = new Y.Doc({ gc: true });
    Y.applyUpdate(applied, result.stateBytes);
    const text = firstXmlText(applied.getXmlFragment("prosemirror"));
    const delta = text.toDelta() as Array<{
      insert: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(delta.map(({ insert }) => insert).join("")).toBe(
      "Before precise text after",
    );
    expect(delta).toContainEqual({
      insert: "precise text",
      attributes: {
        comment: { orphan: false, threadId: "thread_1" },
      },
    });
  });

  it("conflicts when a Comment selection is missing or ambiguous", () => {
    const base = {
      mutationId: "document_comment_replacement_conflict",
      schemaVersion: "blocknote-semantic-v1" as const,
      currentTitle: "Title",
      allowedDocumentAssetIds: [] as string[],
      operations: [
        {
          kind: "replace_comment_text" as const,
          threadId: "thread_1",
          replacement: "replacement",
        },
      ],
    };
    expect(
      applyRoomDocumentSemanticMutation({
        ...base,
        stateBytes: stateWithBlocks([
          { id: "one", type: "paragraph", content: "No selection" },
        ]),
      }),
    ).toEqual({ status: "conflicted", reason: "missing_comment_selection" });
    expect(
      applyRoomDocumentSemanticMutation({
        ...base,
        stateBytes: stateWithCommentRanges("one gap two", [
          { offset: 0, length: 3, threadId: "thread_1" },
          { offset: 8, length: 3, threadId: "thread_1" },
        ]),
      }),
    ).toEqual({
      status: "conflicted",
      reason: "ambiguous_comment_selection",
    });
  });

  it("rejects unpinned Asset references and oversized operation lists", () => {
    const state = stateWithBlocks([
      { id: "one", type: "paragraph", content: "One" },
    ]);
    expect(() =>
      applyRoomDocumentSemanticMutation({
        mutationId: "document_semantic_mutation_asset",
        schemaVersion: "blocknote-semantic-v1",
        currentTitle: "Title",
        stateBytes: state,
        allowedDocumentAssetIds: [],
        operations: [
          {
            kind: "insert_blocks",
            position: "after",
            stableBlockId: "one",
            blocks: [
              {
                id: "asset",
                type: "image",
                props: { url: "document-asset:not_pinned" },
              },
            ],
          },
        ],
      }),
    ).toThrow(RoomDocumentModelError);
    expect(() =>
      applyRoomDocumentSemanticMutation({
        mutationId: "document_semantic_mutation_limit",
        schemaVersion: "blocknote-semantic-v1",
        currentTitle: "Title",
        stateBytes: state,
        allowedDocumentAssetIds: [],
        operations: Array.from({ length: 65 }, () => ({
          kind: "set_title" as const,
          title: "Title",
        })),
      }),
    ).toThrow(RoomDocumentModelError);
  });
});

function stateWithBlocks(blocks: PartialBlock[]): Uint8Array {
  const document = new Y.Doc({ gc: true });
  const editor = BlockNoteEditor.create({ initialContent: blocks });
  try {
    blocksToYXmlFragment(
      editor,
      editor.document,
      document.getXmlFragment("prosemirror"),
    );
  } finally {
    editor.unmount();
  }
  return Y.encodeStateAsUpdate(document);
}

function stateWithCommentRanges(
  content: string,
  ranges: readonly {
    offset: number;
    length: number;
    threadId: string;
  }[],
): Uint8Array {
  const state = stateWithBlocks([
    { id: "commented", type: "paragraph", content },
  ]);
  const document = new Y.Doc({ gc: true });
  Y.applyUpdate(document, state);
  const text = firstXmlText(document.getXmlFragment("prosemirror"));
  for (const range of ranges) {
    text.format(range.offset, range.length, {
      comment: { orphan: false, threadId: range.threadId },
    });
  }
  return Y.encodeStateAsUpdate(document);
}

function firstXmlText(root: Y.XmlFragment | Y.XmlElement): Y.XmlText {
  const pending = [...root.toArray()];
  while (pending.length > 0) {
    const node = pending.shift();
    if (node instanceof Y.XmlText) return node;
    if (node instanceof Y.XmlElement) pending.push(...node.toArray());
  }
  throw new Error("Expected BlockNote paragraph text");
}

function stateDigest(bytes: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return fingerprintRoomDocumentState(doc);
}
