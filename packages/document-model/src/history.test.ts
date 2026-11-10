import { BlockNoteEditor } from "@blocknote/core";
import type { PartialBlock } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  readRoomDocumentBlocks,
  restoreRoomDocumentRevision,
  RoomDocumentModelError,
} from "./index.js";

describe("Room Document History restore model", () => {
  it("computes one deterministic replacement update against the exact current state", () => {
    const current = stateWithBlocks([
      { id: "old", type: "paragraph", content: "Old retained line" },
      { id: "new", type: "paragraph", content: "Later content to remove" },
    ]);
    const target = stateWithBlocks([
      {
        id: "old",
        type: "heading",
        props: { level: 2 },
        content: "Restored line",
      },
      {
        id: "asset",
        type: "image",
        props: { url: "document-asset:asset_history" },
      },
    ]);

    const first = restoreRoomDocumentRevision({
      restoreOperationId: "document_history_restore_01",
      currentStateBytes: current,
      targetStateBytes: target,
    });
    const replayed = restoreRoomDocumentRevision({
      restoreOperationId: "document_history_restore_01",
      currentStateBytes: current,
      targetStateBytes: target,
    });
    expect(first.update).toEqual(replayed.update);
    expect(first.stateHash).toEqual(replayed.stateHash);
    expect(first.updateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.completeReferences).toEqual({
      documentAssetIds: ["asset_history"],
      documentThreadIds: [],
    });

    const restored = new Y.Doc({ gc: true });
    Y.applyUpdate(restored, current);
    Y.applyUpdate(restored, first.update);
    expect(
      readRoomDocumentBlocks(Y.encodeStateAsUpdate(restored)),
    ).toMatchObject([
      { id: "old", type: "heading", content: [{ text: "Restored line" }] },
      { id: "asset", type: "image" },
    ]);
    expect(Y.encodeStateVector(restored)).toEqual(first.endStateVector);
  });

  it("fails closed for damaged current or target state", () => {
    const valid = stateWithBlocks([
      { id: "one", type: "paragraph", content: "One" },
    ]);
    expect(() =>
      restoreRoomDocumentRevision({
        restoreOperationId: "document_history_restore_02",
        currentStateBytes: new Uint8Array([255]),
        targetStateBytes: valid,
      }),
    ).toThrow(RoomDocumentModelError);
    expect(() =>
      restoreRoomDocumentRevision({
        restoreOperationId: "document_history_restore_03",
        currentStateBytes: valid,
        targetStateBytes: new Uint8Array([255]),
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
