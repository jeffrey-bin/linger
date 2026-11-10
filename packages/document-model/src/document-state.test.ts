import { BlockNoteEditor } from "@blocknote/core";
import type { PartialBlock } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  inspectRoomDocument,
  inspectRoomDocumentState,
  fingerprintRoomDocumentState,
  materializeRoomDocument,
  RoomDocumentModelError,
} from "./index.js";

const materializationId = "893a6982-dcd7-4dd2-a02b-d2ca4f1d6a95";

describe("Room Document state inspection", () => {
  it("exposes one synchronous full-state fingerprint in browser and Node runtimes", () => {
    const document = new Y.Doc({ gc: true });
    document.clientID = 7;
    document.getText("content").insert(0, "shared fingerprint");
    expect(fingerprintRoomDocumentState(document)).toBe(
      "cd82ce53f21444c2a1d34be2e91618d0e3b30e18d6ed95d76fc7bfa483fe6238",
    );
  });

  it("accepts the canonical BlockNote fragment and extracts Comment thread refs", async () => {
    const document = await materializedDocument("first\nsecond");
    const text = firstText(document);
    text.format(0, text.length, {
      comment: { orphan: false, threadId: "document_thread_1" },
    });

    expect(inspectRoomDocumentState(Y.encodeStateAsUpdate(document))).toEqual({
      completeReferences: {
        documentAssetIds: [],
        documentThreadIds: ["document_thread_1"],
      },
      hasMediaBlocks: false,
    });
  });

  it("extracts sorted unique Document Asset refs from every media block", () => {
    const document = documentWithBlocks([
      {
        type: "image",
        props: { url: "document-asset:asset_z" },
      },
      {
        type: "file",
        props: { url: "document-asset:asset_a" },
      },
      {
        type: "video",
        props: { url: "document-asset:asset_z" },
      },
      {
        type: "audio",
        props: { url: "document-asset:asset_m" },
      },
    ]);

    expect(inspectRoomDocumentState(Y.encodeStateAsUpdate(document))).toEqual({
      completeReferences: {
        documentAssetIds: ["asset_a", "asset_m", "asset_z"],
        documentThreadIds: [],
      },
      hasMediaBlocks: true,
    });
  });

  it("rejects external URLs in media blocks", () => {
    const document = documentWithBlocks([
      {
        type: "image",
        props: { url: "https://files.example.test/image.png" },
      },
    ]);

    expect(() =>
      inspectRoomDocumentState(Y.encodeStateAsUpdate(document)),
    ).toThrow("Room Document Asset reference is invalid");
  });

  it("rejects more than 4096 total Asset and Comment Thread refs", () => {
    const document = documentWithBlocks([
      {
        type: "paragraph",
        content: "x".repeat(4_096),
      },
      {
        type: "image",
        props: { url: "document-asset:asset_1" },
      },
    ]);
    const text = firstText(document);
    const commentMarks: Record<string, { orphan: boolean; threadId: string }> =
      {};
    for (let index = 0; index < 4_096; index += 1) {
      commentMarks[`comment--${index.toString(36).padStart(8, "0")}`] = {
        orphan: false,
        threadId: `document_thread_${String(index).padStart(4, "0")}`,
      };
    }
    text.format(0, text.length, commentMarks);

    expect(() =>
      inspectRoomDocumentState(Y.encodeStateAsUpdate(document)),
    ).toThrow("Room Document references exceed their limit");
  });

  it("rejects duplicate Block IDs and extra Yjs roots", async () => {
    const duplicate = await materializedDocument("first\nsecond");
    const containers = blockContainers(duplicate);
    containers[1]!.setAttribute("id", containers[0]!.getAttribute("id")!);

    expect(() =>
      inspectRoomDocumentState(Y.encodeStateAsUpdate(duplicate)),
    ).toThrow(RoomDocumentModelError);

    const extraRoot = await materializedDocument("first");
    extraRoot.getMap("unexpected").set("value", true);
    expect(() =>
      inspectRoomDocumentState(Y.encodeStateAsUpdate(extraRoot)),
    ).toThrow(RoomDocumentModelError);
    expect(() => inspectRoomDocument(decoded(extraRoot))).toThrow(
      RoomDocumentModelError,
    );
  });

  it("inspects an already decoded Y.Doc without changing its state", async () => {
    const document = await materializedDocument("first\nsecond");
    const text = firstText(document);
    text.format(0, text.length, {
      comment: { orphan: false, threadId: "document_thread_1" },
    });
    // Decoded as the Runtime clones a live Document: no fragment typed yet.
    const copy = decoded(document);
    const stateVector = Y.encodeStateVector(copy);

    expect(inspectRoomDocument(copy)).toEqual({
      completeReferences: {
        documentAssetIds: [],
        documentThreadIds: ["document_thread_1"],
      },
      hasMediaBlocks: false,
    });
    expect(Y.encodeStateVector(copy)).toEqual(stateVector);
  });
});

function decoded(document: Y.Doc): Y.Doc {
  const copy = new Y.Doc({ gc: true });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  return copy;
}

function documentWithBlocks(blocks: PartialBlock[]): Y.Doc {
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
  return document;
}

async function materializedDocument(source: string): Promise<Y.Doc> {
  const state = await materializeRoomDocument({
    materializationId,
    schemaVersion: 1,
    sourceKind: "plain_text",
    sourceBytes: new TextEncoder().encode(source),
  });
  const document = new Y.Doc({ gc: true });
  Y.applyUpdate(document, state.stateBytes);
  return document;
}

function blockContainers(document: Y.Doc): Y.XmlElement[] {
  const group = document.getXmlFragment("prosemirror").toArray()[0];
  if (!(group instanceof Y.XmlElement)) {
    throw new Error("Expected BlockNote block group");
  }
  return group
    .toArray()
    .filter((node): node is Y.XmlElement => node instanceof Y.XmlElement);
}

function firstText(document: Y.Doc): Y.XmlText {
  const container = blockContainers(document)[0];
  const block = container?.toArray()[0];
  const text = block instanceof Y.XmlElement ? block.toArray()[0] : undefined;
  if (!(text instanceof Y.XmlText)) {
    throw new Error("Expected BlockNote text content");
  }
  return text;
}
