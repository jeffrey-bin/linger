import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  duplicateRoomDocumentState,
  inspectRoomDocumentState,
  RoomDocumentModelError,
} from "./index.js";

describe("Room Document native Duplicate", () => {
  it("deterministically remaps Document Assets and removes source Comment threads", () => {
    const source = documentWithReferences();
    const input = {
      duplicateOperationId: "duplicate_document_asset_copy",
      stateBytes: Y.encodeStateAsUpdate(source),
      assetIdMap: { asset_source: "asset_target" },
    };

    const first = duplicateRoomDocumentState(input);
    const replay = duplicateRoomDocumentState(input);

    expect(first.stateBytes).toEqual(replay.stateBytes);
    expect(first).toMatchObject({
      stateHashVersion: 1,
      completeReferences: {
        documentAssetIds: ["asset_target"],
        documentThreadIds: [],
      },
    });
    expect(inspectRoomDocumentState(first.stateBytes)).toEqual({
      completeReferences: {
        documentAssetIds: ["asset_target"],
        documentThreadIds: [],
      },
      hasMediaBlocks: true,
    });
  });

  it("fails closed when an Asset mapping is missing or source state is invalid", () => {
    const source = documentWithReferences();
    expect(() =>
      duplicateRoomDocumentState({
        duplicateOperationId: "duplicate_document_missing_asset",
        stateBytes: Y.encodeStateAsUpdate(source),
        assetIdMap: {},
      }),
    ).toThrow("Document Duplicate Asset mapping is incomplete");
    expect(() =>
      duplicateRoomDocumentState({
        duplicateOperationId: "duplicate_document_invalid_state",
        stateBytes: new Uint8Array([255]),
        assetIdMap: {},
      }),
    ).toThrow(RoomDocumentModelError);
  });
});

function documentWithReferences(): Y.Doc {
  const document = new Y.Doc({ gc: true });
  const editor = BlockNoteEditor.create({
    initialContent: [
      { type: "paragraph", content: "Referenced text" },
      { type: "image", props: { url: "document-asset:asset_source" } },
    ],
  });
  try {
    blocksToYXmlFragment(
      editor,
      editor.document,
      document.getXmlFragment("prosemirror"),
    );
  } finally {
    editor.unmount();
  }
  const blockGroup = document.getXmlFragment("prosemirror").toArray()[0];
  const paragraphContainer =
    blockGroup instanceof Y.XmlElement ? blockGroup.toArray()[0] : undefined;
  const paragraph =
    paragraphContainer instanceof Y.XmlElement
      ? paragraphContainer.toArray()[0]
      : undefined;
  const text =
    paragraph instanceof Y.XmlElement ? paragraph.toArray()[0] : undefined;
  if (!(text instanceof Y.XmlText)) {
    throw new Error("Expected BlockNote paragraph text");
  }
  text.format(0, text.length, {
    comment: { orphan: false, threadId: "thread_source" },
  });
  return document;
}
